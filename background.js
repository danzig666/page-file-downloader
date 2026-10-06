import {
  APP_STATE_KEY, DEFAULT_SETTINGS, EXTENSION_CATEGORIES, GEOMETRY_KEY, MESSAGE, QUEUE_KEY,
  RESTRICTED_SCHEMES, SETTINGS_KEY, WINDOW_KEY
} from "./shared/constants.js";
import {
  buildDownloadPath, categoryFor, chooseFilename, hashString, inferExtension, inferFilename, normalizeUrl,
  sanitizeFilename
} from "./shared/file-utils.js";
import { validateSettings } from "./shared/settings.js";

let initialized = false;
let initializing = null;
let appWindowId = null;
let geometryTimer = null;
let pumping = false;
let state = {
  targetTab: null,
  scan: { status: "idle", scanId: null, error: "", stale: false, candidateLimitReached: false, scannedAt: null },
  items: [],
  selectedIds: [],
  lastUpdated: Date.now()
};
let queue = [];
let settings = { ...DEFAULT_SETTINGS };
const metadataCache = new Map();

// Several events can wake the worker at once; they must share one initialization,
// otherwise a late-finishing run overwrites state that an earlier handler changed.
function initialize() {
  if (initialized) return Promise.resolve();
  initializing ??= loadInitialState().catch((error) => {
    initializing = null;
    throw error;
  });
  return initializing;
}

async function loadInitialState() {
  const [sessionData, localData] = await Promise.all([
    chrome.storage.session.get([APP_STATE_KEY, QUEUE_KEY, WINDOW_KEY]),
    chrome.storage.local.get([SETTINGS_KEY])
  ]);
  settings = validateSettings(localData[SETTINGS_KEY]);
  applyPanelBehavior();
  const saved = sessionData[APP_STATE_KEY];
  if (saved && settings.rememberScan) state = sanitizeRestoredState(saved);
  if (!settings.rememberTarget) state.targetTab = null;
  else if (saved && !state.targetTab) state.targetTab = sanitizeRestoredState(saved).targetTab;
  if (Array.isArray(sessionData[QUEUE_KEY])) queue = sessionData[QUEUE_KEY].map(sanitizeQueueItem).filter(Boolean);
  appWindowId = Number.isInteger(sessionData[WINDOW_KEY]) ? sessionData[WINDOW_KEY] : null;
  for (const item of queue) {
    if (["starting", "in_progress"].includes(item.status) && !Number.isInteger(item.downloadId)) {
      item.status = "waiting";
    }
  }
  initialized = true;
  await reconcileDownloads();
  void pumpQueue();
}

function sanitizeRestoredState(input) {
  return {
    targetTab: input?.targetTab && Number.isInteger(input.targetTab.id) ? input.targetTab : null,
    scan: { status: "idle", scanId: null, error: "", stale: Boolean(input?.scan?.stale),
      candidateLimitReached: Boolean(input?.scan?.candidateLimitReached), scannedAt: input?.scan?.scannedAt || null },
    items: Array.isArray(input?.items) ? input.items.slice(0, 20000).map((item) => ({
      ...item, pageFilename: item.pageFilename || item.filename, linkText: item.linkText || ""
    })) : [],
    selectedIds: Array.isArray(input?.selectedIds) ? input.selectedIds.filter((id) => typeof id === "string").slice(0, 20000) : [],
    lastUpdated: Date.now()
  };
}

function sanitizeQueueItem(item) {
  if (!item || typeof item !== "object" || typeof item.id !== "string") return null;
  return {
    ...item,
    status: ["waiting", "starting", "in_progress", "completed", "failed", "skipped", "cancelled"].includes(item.status)
      ? item.status : "failed",
    error: typeof item.error === "string" ? item.error.slice(0, 500) : ""
  };
}

async function persistState() {
  state.lastUpdated = Date.now();
  try {
    await chrome.storage.session.set({ [APP_STATE_KEY]: state, [QUEUE_KEY]: queue });
  } catch (error) {
    // Session storage is quota-limited; failing to persist must not break the live session.
    console.warn("Page File Downloader could not persist its state", error);
  }
}

function applyPanelBehavior() {
  // sidePanel.open() needs a user gesture, which is lost after the awaits in the
  // action handler, so in side-panel mode Chrome opens the panel itself.
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: settings.defaultInterface === "sidepanel" })
    .catch((error) => console.warn("Unable to set side panel behavior", error));
}

function applyFilenameSource() {
  for (const item of state.items) item.filename = chooseFilename(item, settings.filenameSource);
}

async function broadcastState() {
  await persistState();
  chrome.runtime.sendMessage({ type: MESSAGE.APP_STATE_UPDATED, state: publicState() }).catch(() => {});
}

function publicState() {
  return { ...state, queue, settings };
}

function restrictedUrl(url = "") {
  return RESTRICTED_SCHEMES.test(url) || /^https:\/\/chromewebstore\.google\.com\//i.test(url);
}

function tabModel(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: String(tab.title || "Untitled tab").slice(0, 500),
    url: String(tab.url || ""),
    hostname: (() => { try { return new URL(tab.url).hostname; } catch { return ""; } })(),
    favIconUrl: /^https?:|^data:/i.test(tab.favIconUrl || "") ? tab.favIconUrl : "",
    active: Boolean(tab.active),
    supported: !restrictedUrl(tab.url || "") && /^(https?|file):/i.test(tab.url || "")
  };
}

async function getSuitableTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => tab.id && !String(tab.url).startsWith(chrome.runtime.getURL("")))
    .map(tabModel)
    .sort((a, b) => Number(b.active) - Number(a.active) || a.windowId - b.windowId || a.title.localeCompare(b.title));
}

async function currentNormalTab() {
  const lastFocused = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  if (!lastFocused?.id) return null;
  const [tab] = await chrome.tabs.query({ active: true, windowId: lastFocused.id });
  return tab ? tabModel(tab) : null;
}

async function setTargetTab(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("Invalid target tab.");
  const tab = await chrome.tabs.get(tabId);
  const target = tabModel(tab);
  if (!target.supported) throw new Error("Chrome does not allow extensions to scan this page.");
  state.targetTab = target;
  state.scan.stale = state.items.length > 0;
  await broadcastState();
  return target;
}

function isRecognizable(candidate, extension) {
  if (candidate.explicitDownload) return true;
  if (extension && (EXTENSION_CATEGORIES[extension] || settings.customExtensions.includes(extension))) return true;
  return /^(image|video|audio|source|track|embed|object|background-image|metadata)/.test(candidate.sourceType);
}

function approximateDataSize(url) {
  const comma = url.indexOf(",");
  if (comma < 0) return 0;
  const payload = url.slice(comma + 1);
  if (/;base64/i.test(url.slice(0, comma))) return Math.floor(payload.length * 0.75);
  // A malformed %-escape must not abort the whole scan.
  try { return decodeURIComponent(payload).length; } catch { return payload.length; }
}

function buildItems(result, tabId) {
  const deduped = new Map();
  let discoveryIndex = 0;
  for (const candidate of result.candidates.slice(0, settings.maxCandidates)) {
    if (!candidate || typeof candidate.url !== "string") continue;
    if (candidate.url.length > 5_000_000 && !candidate.url.startsWith("data:")) continue;
    const normalizedUrl = normalizeUrl(candidate.url, settings);
    if (!normalizedUrl) continue;
    const mimeType = String(candidate.mimeType || "").slice(0, 200);
    const extension = inferExtension(candidate.url, mimeType, candidate.downloadName);
    if (!isRecognizable(candidate, extension)) continue;
    const existing = deduped.get(normalizedUrl);
    const linkText = String(candidate.linkText || "").slice(0, 300);
    if (existing) {
      existing.occurrenceCount += 1;
      if (!existing.linkText && linkText) {
        existing.linkText = linkText;
        existing.filename = chooseFilename(existing, settings.filenameSource);
      }
      if (existing.locations.length < 30) existing.locations.push(String(candidate.location || candidate.sourceType).slice(0, 500));
      continue;
    }
    discoveryIndex += 1;
    const isData = normalizedUrl.startsWith("data:");
    const isBlob = normalizedUrl.startsWith("blob:");
    const sizeBytes = isData ? approximateDataSize(normalizedUrl) : null;
    const tooLargeData = isData && sizeBytes > settings.dataLimitBytes;
    const pageFilename = inferFilename(candidate.url, candidate.downloadName, mimeType, discoveryIndex);
    const id = `file-${hashString(normalizedUrl)}`;
    let hostname = "";
    try { hostname = new URL(result.pageUrl).hostname; } catch { /* empty */ }
    deduped.set(normalizedUrl, {
      id, tabId, pageUrl: result.pageUrl, pageTitle: result.pageTitle, pageHostname: hostname,
      // Oversized data URLs are listed but not kept in full: session storage is quota-limited.
      url: tooLargeData ? normalizedUrl.slice(0, normalizedUrl.indexOf(",") + 1) : candidate.url,
      normalizedUrl: isData ? `data:${hashString(normalizedUrl)}` : normalizedUrl,
      pageFilename, linkText, filename: "", extension,
      mimeType, category: categoryFor(extension, mimeType),
      sizeBytes, sizeKnown: Number.isFinite(sizeBytes),
      sourceType: String(candidate.sourceType || "unknown").slice(0, 80),
      sourceLabel: String(candidate.sourceLabel || "").slice(0, 300),
      sourceElement: String(candidate.sourceElement || "").slice(0, 100),
      occurrenceCount: 1, downloadable: !isBlob && !tooLargeData,
      warning: isBlob ? "Blob URLs are tied to the page and cannot be safely queued after the page closes."
        : tooLargeData ? "This embedded data URL exceeds the configured size limit." : null,
      discoveryIndex, locations: [String(candidate.location || candidate.sourceType).slice(0, 500)]
    });
    const item = deduped.get(normalizedUrl);
    item.filename = chooseFilename(item, settings.filenameSource);
  }
  return [...deduped.values()].slice(0, settings.maxDisplayedResults);
}

async function scanTarget(tabId = state.targetTab?.id) {
  if (!Number.isInteger(tabId)) throw new Error("Choose a webpage to scan first.");
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error("The target tab has been closed.");
  if (restrictedUrl(tab.url) || !/^(https?|file):/i.test(tab.url || "")) {
    throw new Error("Chrome does not allow extensions to scan this page.");
  }
  const scanId = crypto.randomUUID();
  state.scan = {
    status: "scanning", scanId, error: "", stale: false, candidateLimitReached: false, selectionOnly: false, scannedAt: null
  };
  await broadcastState();
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
    const response = await chrome.tabs.sendMessage(tabId, {
      type: MESSAGE.SCAN_PAGE,
      options: { maxCandidates: settings.maxCandidates, selectionOnly: settings.scanSelectionOnly }
    });
    if (state.scan.scanId !== scanId) return;
    if (!response?.ok) throw new Error(response?.error || "The page scanner did not respond.");
    const selected = new Set(state.selectedIds);
    state.items = buildItems(response.result, tabId);
    state.selectedIds = state.items.filter((item) => selected.has(item.id)).map((item) => item.id);
    state.targetTab = tabModel(await chrome.tabs.get(tabId));
    state.scan = {
      status: "complete", scanId, error: "", stale: false,
      candidateLimitReached: Boolean(response.result.candidateLimitReached),
      selectionOnly: Boolean(response.result.selectionOnly), scannedAt: Date.now()
    };
    chrome.tabs.sendMessage(tabId, { type: settings.watchPage ? MESSAGE.START_WATCH : MESSAGE.STOP_WATCH }).catch(() => {});
    await broadcastState();
    if (settings.inspectMetadata) void inspectMetadataForScan(scanId);
  } catch (error) {
    if (state.scan.scanId !== scanId) return;
    console.error("Page File Downloader scan failed", error);
    state.scan = {
      status: "error", scanId, error: explainScanError(error), stale: Boolean(state.items.length),
      candidateLimitReached: false, selectionOnly: false, scannedAt: null
    };
    await broadcastState();
    throw new Error(state.scan.error);
  }
}

function dispositionFilename(value = "") {
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value);
  if (encoded) {
    try { return sanitizeFilename(decodeURIComponent(encoded[1].replace(/^"|"$/g, ""))); } catch { /* plain fallback */ }
  }
  const plain = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(value);
  return plain ? sanitizeFilename((plain[1] || plain[2]).trim()) : "";
}

async function getMetadata(item) {
  if (metadataCache.has(item.normalizedUrl)) return metadataCache.get(item.normalizedUrl);
  const promise = (async () => {
    if (!/^https?:/i.test(item.url)) return null;
    const response = await fetch(item.url, { method: "HEAD", credentials: "include", cache: "no-store", redirect: "follow" });
    if (!response.ok) return null;
    const length = Number(response.headers.get("content-length"));
    return {
      sizeBytes: Number.isFinite(length) && length >= 0 ? length : null,
      mimeType: String(response.headers.get("content-type") || "").split(";", 1)[0].slice(0, 200),
      filename: dispositionFilename(response.headers.get("content-disposition") || "")
    };
  })().catch((error) => {
    console.debug("Metadata unavailable", item.url, error);
    return null;
  });
  metadataCache.set(item.normalizedUrl, promise);
  return promise;
}

async function inspectMetadataForScan(scanId) {
  const candidates = state.items.filter((item) => /^https?:/i.test(item.url)).slice(0, 500);
  let cursor = 0;
  let updates = 0;
  const workers = Array.from({ length: Math.min(settings.metadataConcurrency, candidates.length) }, async () => {
    while (cursor < candidates.length && state.scan.scanId === scanId) {
      const item = candidates[cursor++];
      const metadata = await getMetadata(item);
      if (!metadata || state.scan.scanId !== scanId) continue;
      if (metadata.sizeBytes !== null) {
        item.sizeBytes = metadata.sizeBytes;
        item.sizeKnown = true;
      }
      if (metadata.mimeType) item.mimeType = metadata.mimeType;
      if (metadata.filename) {
        item.pageFilename = metadata.filename;
        item.extension = inferExtension(item.url, item.mimeType, item.pageFilename);
        item.category = categoryFor(item.extension, item.mimeType);
        item.filename = chooseFilename(item, settings.filenameSource);
      } else if (!item.extension && item.mimeType) {
        item.extension = inferExtension(item.url, item.mimeType);
        item.category = categoryFor(item.extension, item.mimeType);
        item.filename = chooseFilename(item, settings.filenameSource);
      }
      updates += 1;
      if (updates % 25 === 0) await broadcastState();
    }
  });
  await Promise.all(workers);
  if (updates && state.scan.scanId === scanId) await broadcastState();
}

function explainScanError(error) {
  const message = String(error?.message || error);
  if (/Cannot access|permission|host permission|not allowed/i.test(message)) {
    return "Chrome denied access to this page. Make the tab active and click the extension icon, or grant this site permission when prompted.";
  }
  if (/closed|No tab with id/i.test(message)) return "The target tab has been closed.";
  return `The page could not be scanned: ${message.slice(0, 300)}`;
}

async function openOrFocusApplicationWindow(sourceTab) {
  await initialize();
  if (sourceTab?.id && !String(sourceTab.url).startsWith(chrome.runtime.getURL("")) && !restrictedUrl(sourceTab.url || "")) {
    if (state.targetTab?.id && state.targetTab.id !== sourceTab.id && state.items.length) {
      state.scan.stale = true;
      state.scan.error = "The target tab changed. Existing results remain available until you rescan.";
    }
    state.targetTab = tabModel(sourceTab);
    await persistState();
  }
  if (appWindowId !== null) {
    const existing = await chrome.windows.get(appWindowId).catch(() => null);
    if (existing) {
      await chrome.windows.update(appWindowId, { focused: true, state: existing.state === "minimized" ? "normal" : existing.state });
      await broadcastState();
      return existing;
    }
    appWindowId = null;
  }
  const createOptions = {
    url: chrome.runtime.getURL("app.html"), type: "popup", width: 1100, height: 760, focused: true
  };
  let savedGeometry = null;
  if (settings.rememberWindowGeometry) {
    const saved = (await chrome.storage.local.get(GEOMETRY_KEY))[GEOMETRY_KEY];
    savedGeometry = saved;
    if (saved && Number(saved.width) >= 760 && Number(saved.height) >= 540) {
      createOptions.width = Math.min(3000, Number(saved.width));
      createOptions.height = Math.min(2000, Number(saved.height));
      if (Number.isFinite(saved.left) && Number.isFinite(saved.top) && saved.left > -createOptions.width + 100 && saved.top > -50) {
        createOptions.left = saved.left;
        createOptions.top = saved.top;
      }
    }
  }
  try {
    const created = await chrome.windows.create(createOptions);
    appWindowId = created.id;
    await chrome.storage.session.set({ [WINDOW_KEY]: appWindowId });
    if (savedGeometry?.state === "maximized") {
      await chrome.windows.update(appWindowId, { state: "maximized" }).catch(() => {});
    }
  } catch (error) {
    console.error("Application window creation failed", error);
    throw error;
  }
}

async function reconcileDownloads() {
  for (const item of queue) {
    if (!Number.isInteger(item.downloadId) || !["starting", "in_progress"].includes(item.status)) continue;
    const [download] = await chrome.downloads.search({ id: item.downloadId }).catch(() => []);
    if (!download) {
      item.status = "failed";
      item.error = "Download state was not available after the background worker restarted.";
    } else if (download.state === "complete") item.status = "completed";
    else if (download.state === "interrupted") {
      item.status = "failed";
      item.error = download.error || "Download interrupted.";
    } else item.status = "in_progress";
  }
  await persistState();
}

async function enqueueItem(item) {
  if (!item?.downloadable) return false;
  const active = queue.find((entry) => entry.itemId === item.id && ["waiting", "starting", "in_progress"].includes(entry.status));
  if (active) return false;
  queue.push({
    id: crypto.randomUUID(), itemId: item.id, url: item.url, filename: item.filename,
    path: buildDownloadPath(item, settings), status: "waiting", error: "", downloadId: null,
    createdAt: Date.now(), updatedAt: Date.now(), bytesReceived: 0, totalBytes: item.sizeKnown ? item.sizeBytes : 0
  });
  return true;
}

async function pumpQueue() {
  if (pumping) return;
  pumping = true;
  try {
    while (true) {
      const activeCount = queue.filter((item) => ["starting", "in_progress"].includes(item.status)).length;
      if (activeCount >= settings.downloadConcurrency) break;
      const next = queue.find((item) => item.status === "waiting");
      if (!next) break;
      next.status = "starting";
      next.updatedAt = Date.now();
      await broadcastState();
      try {
        next.downloadId = await chrome.downloads.download({
          url: next.url,
          filename: next.path,
          saveAs: settings.askWhereToSave,
          conflictAction: "uniquify"
        });
        next.status = "in_progress";
      } catch (error) {
        next.status = "failed";
        next.error = String(error.message || error).slice(0, 500);
        console.error("Download failed to start", error);
      }
      next.updatedAt = Date.now();
      await broadcastState();
    }
  } finally {
    pumping = false;
  }
}

// Fires only in window mode; in side-panel mode Chrome opens the panel directly
// (see applyPanelBehavior) and the panel retargets itself to the active tab.
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await openOrFocusApplicationWindow(tab);
    // Scan failures are already recorded in state and shown by the app.
    if (settings.autoScan && tab?.id && tabModel(tab).supported) scanTarget(tab.id).catch(() => {});
  } catch (error) {
    console.error("Unable to open Page File Downloader", error);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "pfd-open-window", title: "Open Page File Downloader", contexts: ["action", "page"] });
    chrome.contextMenus.create({ id: "pfd-open-sidepanel", title: "Open in side panel", contexts: ["action", "page"] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "pfd-open-window") openOrFocusApplicationWindow(tab).catch(console.error);
  if (info.menuItemId === "pfd-open-sidepanel" && tab?.id) {
    // Must be called before any await so the user gesture is still valid.
    // The panel then targets the active tab of its window itself.
    chrome.sidePanel.open({ tabId: tab.id }).catch(console.error);
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId !== appWindowId) return;
  appWindowId = null;
  chrome.storage.session.remove(WINDOW_KEY).catch(() => {});
});

chrome.windows.onBoundsChanged.addListener((window) => {
  if (window.id !== appWindowId || !settings.rememberWindowGeometry || window.state === "minimized") return;
  clearTimeout(geometryTimer);
  geometryTimer = setTimeout(() => {
    chrome.storage.local.set({
      [GEOMETRY_KEY]: { width: window.width, height: window.height, left: window.left, top: window.top, state: window.state }
    }).catch(console.error);
  }, 500);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.targetTab?.id !== tabId) return;
  state.targetTab = null;
  state.scan.stale = Boolean(state.items.length);
  state.scan.error = "The target tab was closed. Choose another tab to continue.";
  void broadcastState();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (state.targetTab?.id !== tabId) return;
  if (changeInfo.url && changeInfo.url !== state.targetTab.url) {
    state.targetTab = tabModel(tab);
    state.scan.stale = Boolean(state.items.length);
    state.scan.error = "The target page navigated. Existing results may be stale; rescan when ready.";
    void broadcastState();
  } else if (changeInfo.title) {
    state.targetTab.title = String(changeInfo.title).slice(0, 500);
    void broadcastState();
  }
});

// When any other installed extension listens to onDeterminingFilename, Chrome
// drops the filename passed to downloads.download() and uses that extension's
// suggestion (usually the server's name). Suggesting our own path here keeps the
// chosen name. Every download must get a suggest() call, or it stalls.
chrome.downloads.onDeterminingFilename.addListener((download, suggest) => {
  initialize().then(() => {
    const entry = queue.find((item) => item.downloadId === download.id) ||
      queue.find((item) => item.status === "starting" && item.url === download.url);
    if (entry?.path) suggest({ filename: entry.path, conflictAction: "uniquify" });
    else suggest();
  }).catch(() => suggest());
  return true;
});

chrome.downloads.onChanged.addListener((delta) => {
  void initialize().then(async () => {
    const item = queue.find((entry) => entry.downloadId === delta.id);
    if (!item) return;
    if (delta.bytesReceived) item.bytesReceived = delta.bytesReceived.current;
    if (delta.totalBytes) item.totalBytes = delta.totalBytes.current;
    if (delta.state?.current === "complete") item.status = "completed";
    if (delta.state?.current === "interrupted") {
      item.status = "failed";
      item.error = delta.error?.current || "Download interrupted.";
    }
    item.updatedAt = Date.now();
    await broadcastState();
    void pumpQueue();
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleMessage(message, sender).then((data) => sendResponse({ ok: true, data }))
    .catch((error) => {
      console.error("Message handling failed", message?.type, error);
      sendResponse({ ok: false, error: String(error.message || error).slice(0, 500) });
    });
  return true;
});

async function handleMessage(message, sender) {
  await initialize();
  if (!message || typeof message.type !== "string" || message.type.length > 80) throw new Error("Invalid message.");
  if (message.type === "PAGE_CONTENT_CHANGED" && sender.tab?.id === state.targetTab?.id) {
    state.scan.stale = true;
    state.scan.error = "The page content changed. Rescan to include newly loaded files.";
    await broadcastState();
    return true;
  }
  const senderUrl = String(sender.url || sender.documentUrl || "");
  if (sender.tab && !senderUrl.startsWith(chrome.runtime.getURL(""))) {
    throw new Error("This message is allowed only from an extension page.");
  }
  switch (message.type) {
    case MESSAGE.GET_APP_STATE:
      return publicState();
    case MESSAGE.GET_TABS:
      return getSuitableTabs();
    case MESSAGE.GET_CURRENT_BROWSER_TAB:
      return currentNormalTab();
    case MESSAGE.SET_TARGET_TAB:
      return setTargetTab(Number(message.tabId));
    case MESSAGE.SCAN_TARGET_TAB:
      await scanTarget(Number.isInteger(message.tabId) ? message.tabId : state.targetTab?.id);
      return publicState();
    case MESSAGE.UPDATE_SELECTION: {
      const ids = Array.isArray(message.selectedIds) ? message.selectedIds : [];
      if (ids.length > 20000 || ids.some((id) => typeof id !== "string" || id.length > 100)) throw new Error("Invalid selection.");
      const valid = new Set(state.items.map((item) => item.id));
      state.selectedIds = [...new Set(ids.filter((id) => valid.has(id)))];
      await broadcastState();
      return state.selectedIds;
    }
    case MESSAGE.START_BULK_DOWNLOAD: {
      const requested = Array.isArray(message.itemIds) ? message.itemIds : state.selectedIds;
      if (requested.length > 20000) throw new Error("Too many download items.");
      const requestedSet = new Set(requested);
      let added = 0;
      for (const item of state.items) if (requestedSet.has(item.id) && await enqueueItem(item)) added += 1;
      await broadcastState();
      void pumpQueue();
      return { added, queue };
    }
    case MESSAGE.RETRY_DOWNLOAD: {
      const item = queue.find((entry) => entry.id === message.queueId);
      if (!item || item.status !== "failed") throw new Error("Failed queue item not found.");
      item.status = "waiting"; item.error = ""; item.downloadId = null; item.updatedAt = Date.now();
      await broadcastState(); void pumpQueue(); return queue;
    }
    case MESSAGE.RETRY_ALL_FAILED:
      for (const item of queue.filter((entry) => entry.status === "failed")) {
        item.status = "waiting"; item.error = ""; item.downloadId = null; item.updatedAt = Date.now();
      }
      await broadcastState(); void pumpQueue(); return queue;
    case MESSAGE.CANCEL_QUEUED:
      for (const item of queue.filter((entry) => entry.status === "waiting")) item.status = "cancelled";
      await broadcastState(); return queue;
    case MESSAGE.CLEAR_COMPLETED:
      queue = queue.filter((item) => !["completed", "cancelled", "skipped"].includes(item.status));
      await broadcastState(); return queue;
    case MESSAGE.FOCUS_TARGET_TAB:
      if (!state.targetTab?.id) throw new Error("No target tab is selected.");
      await chrome.windows.update(state.targetTab.windowId, { focused: true });
      await chrome.tabs.update(state.targetTab.id, { active: true });
      return true;
    default:
      throw new Error("Unsupported message type.");
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[SETTINGS_KEY]) return;
  void initialize().then(() => {
    settings = validateSettings(changes[SETTINGS_KEY].newValue);
    applyPanelBehavior();
    applyFilenameSource();
    void broadcastState();
    void pumpQueue();
  });
});

void initialize();
