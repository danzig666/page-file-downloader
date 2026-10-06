import { MESSAGE, PAGE_SIZE } from "./shared/constants.js";
import { filterItems, sortItems } from "./shared/filter-utils.js";
import { sendMessage } from "./shared/messaging.js";
import { loadSettings, saveSettings } from "./shared/settings.js";
import { escapeHtml, formatBytes, renderQueueSummary, selectedSize, statusLabel } from "./shared/ui-components.js";

const elements = {};
let appState = { targetTab: null, scan: {}, items: [], selectedIds: [], queue: [], settings: {} };
let tabs = [];
let visibleItems = [];
let renderLimit = PAGE_SIZE;
let sortDirection = "asc";
let filterTimer = null;
let selectionTimer = null;
let selectionDirty = false;
let initialized = false;

const ids = [
  "sidebarToggle", "filterSidebar", "collapseSidebarButton", "targetHost", "tabSelect", "refreshTabsButton",
  "currentTabButton", "focusTabButton", "scanButton", "activityButton", "activityText", "sidePanelButton",
  "settingsButton", "notice", "searchInput", "modeSelect", "matchTargetSelect", "caseSensitiveInput",
  "extensionInput", "minSizeInput", "maxSizeInput", "sizeStateSelect", "downloadableSelect",
  "minOccurrencesInput", "categoryFilters", "sourceFilters", "filterError", "resetFiltersButton",
  "savePresetButton", "presetSelect", "summaryHeading", "summaryText", "scanStats", "selectVisibleButton",
  "selectAllButton", "invertVisibleButton", "deselectVisibleButton", "sortSelect", "sortDirectionButton",
  "emptyState", "tableWrap", "resultBody", "headerCheckbox", "loadMoreButton", "visibleCount", "totalCount",
  "selectedCount", "selectedSize", "selectionNote", "downloadProgress", "progressText", "deselectAllButton",
  "downloadButton", "resultArea", "detailDrawer", "detailTitle", "detailContent", "closeDetailButton",
  "queueDrawer", "queueContent", "closeQueueButton", "retryAllButton", "cancelQueuedButton",
  "clearCompletedButton", "scrim", "liveRegion", "toolbarDownloadButton", "filenameSourceSelect"
];

function cacheElements() {
  for (const id of ids) elements[id] = document.getElementById(id);
}

// Pins the table header just below the sticky selection toolbar, whose height
// changes when it wraps onto several lines.
function trackToolbarHeight() {
  const toolbar = document.querySelector(".selection-toolbar");
  if (!toolbar) return;
  const update = () => {
    const offset = (parseFloat(getComputedStyle(toolbar).top) || 0) + toolbar.offsetHeight;
    document.documentElement.style.setProperty("--sticky-header-top", `${Math.max(0, offset)}px`);
  };
  new ResizeObserver(update).observe(toolbar);
  update();
}

function filtersFromUi() {
  return {
    query: elements.searchInput.value,
    mode: elements.modeSelect.value,
    matchTarget: elements.matchTargetSelect.value,
    caseSensitive: elements.caseSensitiveInput.checked,
    extensions: elements.extensionInput.value,
    categories: [...elements.categoryFilters.querySelectorAll("input:checked")].map((input) => input.value),
    sources: [...elements.sourceFilters.querySelectorAll("input:checked")].map((input) => input.value),
    minSizeMb: elements.minSizeInput.value,
    maxSizeMb: elements.maxSizeInput.value,
    sizeState: elements.sizeStateSelect.value,
    downloadable: elements.downloadableSelect.value,
    minOccurrences: elements.minOccurrencesInput.value,
    hostname: elements.searchInput.dataset.hostname || ""
  };
}

function applyFilterObject(filters = {}) {
  elements.searchInput.value = filters.query || "";
  elements.modeSelect.value = filters.mode || appState.settings.defaultFilterMode || "plain";
  elements.matchTargetSelect.value = filters.matchTarget || appState.settings.matchTarget || "filename";
  elements.caseSensitiveInput.checked = Boolean(filters.caseSensitive ?? appState.settings.caseSensitive);
  elements.extensionInput.value = filters.extensions || "";
  elements.minSizeInput.value = filters.minSizeMb || "";
  elements.maxSizeInput.value = filters.maxSizeMb || "";
  elements.sizeStateSelect.value = filters.sizeState || "any";
  elements.downloadableSelect.value = filters.downloadable || "any";
  elements.minOccurrencesInput.value = filters.minOccurrences || "1";
  elements.searchInput.dataset.hostname = filters.hostname || "";
  for (const input of elements.categoryFilters.querySelectorAll("input")) input.checked = (filters.categories || []).includes(input.value);
  for (const input of elements.sourceFilters.querySelectorAll("input")) input.checked = (filters.sources || []).includes(input.value);
}

function render() {
  const selected = new Set(appState.selectedIds);
  const filtered = filterItems(appState.items, filtersFromUi());
  elements.filterError.textContent = filtered.error;
  visibleItems = sortItems(filtered.items, elements.sortSelect.value, sortDirection);
  const rendered = visibleItems.slice(0, renderLimit);
  renderHeader();
  renderSummary();
  renderTable(rendered, selected, filtered.error);
  renderBottomBar(selected);
  renderQueue();
  updateDocumentTitle();
}

function renderHeader() {
  const target = appState.targetTab;
  elements.targetHost.textContent = target?.hostname || "No target page";
  if (target?.id) elements.tabSelect.value = String(target.id);
  elements.scanButton.textContent = appState.scan.status === "scanning" ? "Scanning…" : appState.items.length ? "Rescan" : "Scan page";
  elements.scanButton.disabled = appState.scan.status === "scanning" || !target;
  elements.focusTabButton.disabled = !target;
  if (document.activeElement !== elements.filenameSourceSelect) {
    elements.filenameSourceSelect.value = appState.settings.filenameSource || "page";
  }
  const queueSummary = renderQueueSummary(appState.queue);
  elements.activityText.textContent = queueSummary.label;
  const dot = elements.activityButton.querySelector(".status-dot");
  dot.className = `status-dot${queueSummary.active ? " active" : queueSummary.failed ? " failed" : ""}`;
}

function renderSummary() {
  const { targetTab: target, scan } = appState;
  if (!target) {
    elements.summaryHeading.textContent = "Choose a page to scan";
    elements.summaryText.textContent = scan.error || "Select an open browser tab, then scan its currently loaded content.";
  } else if (scan.status === "scanning") {
    elements.summaryHeading.textContent = "Scanning page…";
    elements.summaryText.textContent = target.title;
  } else if (scan.status === "error") {
    elements.summaryHeading.textContent = "Scan could not be completed";
    elements.summaryText.textContent = scan.error;
  } else if (appState.items.length) {
    elements.summaryHeading.textContent = scan.stale ? "Results may be stale" : `${appState.items.length.toLocaleString()} unique files found`;
    elements.summaryText.textContent = scan.error || `${target.title} — scans only content currently loaded in the page.`;
  } else if (scan.status === "complete") {
    elements.summaryHeading.textContent = "No downloadable files found";
    elements.summaryText.textContent = "Try loading more page content or choose another tab.";
  } else {
    elements.summaryHeading.textContent = "Ready to scan";
    elements.summaryText.textContent = target.title;
  }
  const date = scan.scannedAt ? new Date(scan.scannedAt).toLocaleTimeString() : "";
  elements.scanStats.textContent = [
    date && `Scanned ${date}`, scan.selectionOnly && "Selection only", scan.candidateLimitReached && "Candidate limit reached"
  ].filter(Boolean).join(" · ");
  const message = scan.error || [
    scan.selectionOnly && scan.status === "complete" && "Only the selected part of the page was scanned. Clear the page selection and rescan to scan the whole page.",
    scan.candidateLimitReached && "The candidate limit was reached; results may be incomplete."
  ].filter(Boolean).join(" ");
  elements.notice.hidden = !message;
  elements.notice.textContent = message;
  elements.notice.classList.toggle("error", scan.status === "error");
}

function renderTable(items, selected, filterError) {
  const hasScan = appState.scan.status === "complete" || appState.items.length > 0;
  const showTable = items.length > 0 && !filterError;
  elements.tableWrap.hidden = !showTable;
  elements.emptyState.hidden = showTable;
  if (!showTable) {
    const title = elements.emptyState.querySelector("h2");
    const text = elements.emptyState.querySelector("p");
    if (filterError) {
      title.textContent = "Fix the filter expression";
      text.textContent = filterError;
    } else if (hasScan && appState.items.length && !visibleItems.length) {
      title.textContent = "No files match these filters";
      text.textContent = "Reset or adjust the filters. Hidden selections remain selected.";
    } else if (hasScan) {
      title.textContent = "No downloadable files found";
      text.textContent = "Only currently loaded page content can be scanned.";
    } else {
      title.textContent = "No scan results yet";
      text.textContent = "Scan a regular webpage to find linked and embedded files.";
    }
    elements.resultBody.textContent = "";
  } else {
    elements.resultBody.innerHTML = items.map((item) => rowHtml(item, selected.has(item.id))).join("");
  }
  elements.loadMoreButton.hidden = visibleItems.length <= renderLimit;
  const remaining = Math.max(0, visibleItems.length - renderLimit);
  elements.loadMoreButton.textContent = remaining
    ? `Show ${Math.min(PAGE_SIZE, remaining).toLocaleString()} more (${Math.min(renderLimit, visibleItems.length).toLocaleString()} of ${visibleItems.length.toLocaleString()} shown)`
    : "All results shown";
  // Unsupported items can never be selected, so they must not keep the header box unchecked.
  const selectable = visibleItems.filter((item) => item.downloadable);
  const visibleSelected = selectable.filter((item) => selected.has(item.id)).length;
  elements.headerCheckbox.checked = selectable.length > 0 && visibleSelected === selectable.length;
  elements.headerCheckbox.indeterminate = visibleSelected > 0 && visibleSelected < selectable.length;
  elements.headerCheckbox.disabled = !selectable.length;
}

function filenameTooltip(item) {
  const pageName = item.pageFilename || item.filename;
  return [item.filename, pageName !== item.filename && `Page filename: ${pageName}`, item.linkText && `Link text: ${item.linkText}`]
    .filter(Boolean).join("\n");
}

function rowHtml(item, isSelected) {
  let hostname = "embedded";
  try { hostname = new URL(item.url).hostname || hostname; } catch { /* data URL */ }
  const queued = [...appState.queue].reverse().find((entry) => entry.itemId === item.id);
  const state = queued ? statusLabel(queued.status) : item.downloadable ? "Ready" : "Unsupported";
  return `<tr data-id="${escapeHtml(item.id)}">
    <td><input class="row-check" type="checkbox" ${isSelected ? "checked" : ""} ${item.downloadable ? "" : "disabled"} aria-label="Select ${escapeHtml(item.filename)}"></td>
    <td><span class="badge" title="${escapeHtml(item.extension || item.category)}">${escapeHtml(item.extension || item.category)}</span></td>
    <td><div class="filename" title="${escapeHtml(filenameTooltip(item))}">${escapeHtml(item.filename)}</div><div class="subtle" title="${escapeHtml(item.url)}">${escapeHtml(item.url.startsWith("data:") ? "Embedded data resource" : item.url)}</div></td>
    <td>${escapeHtml(item.extension || "—")}</td><td>${escapeHtml(item.category)}</td>
    <td>${escapeHtml(formatBytes(item.sizeKnown ? item.sizeBytes : NaN))}</td>
    <td class="subtle" title="${escapeHtml(item.sourceType)}">${escapeHtml(item.sourceType)}</td>
    <td class="subtle" title="${escapeHtml(hostname)}">${escapeHtml(hostname)}</td>
    <td>${item.occurrenceCount}</td>
    <td><span class="status ${item.downloadable ? "" : "unsupported"}">${escapeHtml(state)}</span></td>
    <td><div class="row-actions">
      <button data-action="download" title="Download now" aria-label="Download ${escapeHtml(item.filename)}" ${item.downloadable ? "" : "disabled"}>⇩</button>
      <button data-action="detail" title="Show source details" aria-label="Show details for ${escapeHtml(item.filename)}">ⓘ</button>
      <button data-action="copy" title="Copy URL" aria-label="Copy URL">⧉</button>
    </div></td>
  </tr>`;
}

function renderBottomBar(selected) {
  const selectedItems = appState.items.filter((item) => selected.has(item.id));
  const visibleSelected = visibleItems.filter((item) => selected.has(item.id)).length;
  const hidden = selected.size - visibleSelected;
  elements.visibleCount.textContent = `${visibleItems.length.toLocaleString()} visible`;
  elements.totalCount.textContent = `${appState.items.length.toLocaleString()} total`;
  elements.selectedCount.textContent = `${selected.size.toLocaleString()} selected`;
  elements.selectedSize.textContent = `${formatBytes(selectedSize(appState.items, selected))} known`;
  elements.selectionNote.textContent = selected.size ? `${selected.size} selected — ${visibleSelected} visible${hidden ? `, ${hidden} hidden by filters` : ""}` : "";
  elements.downloadButton.disabled = !selectedItems.some((item) => item.downloadable);
  elements.toolbarDownloadButton.disabled = elements.downloadButton.disabled;
  const actionLabel = selected.size
    ? `Download all selected (${selected.size.toLocaleString()})`
    : "Download all selected";
  elements.downloadButton.textContent = actionLabel;
  elements.toolbarDownloadButton.textContent = actionLabel;
  const active = appState.queue.filter((item) => ["starting", "in_progress"].includes(item.status));
  const totals = active.reduce((acc, item) => ({ received: acc.received + (item.bytesReceived || 0), total: acc.total + (item.totalBytes || 0) }), { received: 0, total: 0 });
  elements.downloadProgress.max = totals.total || 1;
  elements.downloadProgress.value = totals.received;
  elements.progressText.textContent = active.length ? `${active.length} active · ${formatBytes(totals.received)} received` : "No active downloads";
}

function renderQueue() {
  const items = [...appState.queue].reverse();
  elements.queueContent.innerHTML = items.length ? items.map((item) => `<article class="queue-item">
    <header><strong>${escapeHtml(item.filename)}</strong><span>${escapeHtml(statusLabel(item.status))}</span></header>
    <p>${escapeHtml(item.path)}</p>
    ${item.totalBytes ? `<progress max="${item.totalBytes}" value="${item.bytesReceived || 0}"></progress>` : ""}
    ${item.error ? `<p class="error-text">${escapeHtml(item.error)}</p>` : ""}
    ${item.status === "failed" ? `<button class="secondary retry-one" data-queue-id="${escapeHtml(item.id)}" type="button">Retry</button>` : ""}
  </article>`).join("") : "<p>No download activity yet.</p>";
  elements.retryAllButton.disabled = !appState.queue.some((item) => item.status === "failed");
  elements.cancelQueuedButton.disabled = !appState.queue.some((item) => item.status === "waiting");
  elements.clearCompletedButton.disabled = !appState.queue.some((item) => ["completed", "cancelled", "skipped"].includes(item.status));
}

function updateDocumentTitle() {
  document.title = `Page File Downloader${appState.targetTab?.hostname ? ` — ${appState.targetTab.hostname}` : ""}`;
}

function scheduleFilter() {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => { renderLimit = PAGE_SIZE; render(); }, 180);
}

function scheduleSelectionSync() {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    const selectedIds = [...appState.selectedIds];
    sendMessage(MESSAGE.UPDATE_SELECTION, { selectedIds }).then((savedIds) => {
      appState.selectedIds = savedIds;
      selectionDirty = false;
      render();
    }).catch((error) => {
      selectionDirty = false;
      showError(error);
    });
  }, 100);
}

function setSelection(ids) {
  appState.selectedIds = [...new Set(ids)];
  selectionDirty = true;
  render();
  scheduleSelectionSync();
}

async function refreshTabs() {
  tabs = await sendMessage(MESSAGE.GET_TABS);
  const current = elements.tabSelect.value;
  elements.tabSelect.innerHTML = `<option value="">Choose a tab…</option>${tabs.map((tab) =>
    `<option value="${tab.id}" ${tab.supported ? "" : "disabled"}>${escapeHtml(tab.title)} — ${escapeHtml(tab.hostname || "restricted page")} [window ${tab.windowId}]</option>`
  ).join("")}`;
  elements.tabSelect.value = appState.targetTab?.id ? String(appState.targetTab.id) : current;
}

async function requestAccessForTab(tab) {
  if (!tab?.supported) return false;
  if (/^file:/i.test(tab.url)) return chrome.permissions.request({ origins: ["file:///*"] });
  if (!/^https?:/i.test(tab.url)) return true;
  const origin = `${new URL(tab.url).origin}/*`;
  return chrome.permissions.request({ origins: [origin] });
}

async function chooseTab(tabId, requestPermission = true) {
  const tab = tabs.find((entry) => entry.id === Number(tabId));
  if (!tab) return;
  if (!tab.supported) throw new Error("Chrome does not allow extensions to scan this page.");
  if (requestPermission) {
    const granted = await requestAccessForTab(tab);
    if (!granted) throw new Error("Site access was not granted. You can still switch to the page and click the extension icon.");
  }
  await sendMessage(MESSAGE.SET_TARGET_TAB, { tabId: tab.id });
}

async function scan() {
  if (!appState.targetTab) throw new Error("Choose a browser tab first.");
  elements.liveRegion.textContent = "Scanning the target page.";
  await sendMessage(MESSAGE.SCAN_TARGET_TAB, { tabId: appState.targetTab.id });
}

function showError(error) {
  console.error(error);
  elements.notice.hidden = false;
  elements.notice.classList.add("error");
  elements.notice.textContent = error.message || String(error);
  elements.liveRegion.textContent = elements.notice.textContent;
}

function showDrawer(drawer) {
  for (const candidate of [elements.detailDrawer, elements.queueDrawer]) {
    const open = candidate === drawer;
    candidate.classList.toggle("open", open);
    candidate.setAttribute("aria-hidden", String(!open));
  }
  elements.scrim.hidden = false;
}

function closeDrawers() {
  for (const drawer of [elements.detailDrawer, elements.queueDrawer]) {
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
  }
  elements.scrim.hidden = true;
}

function showDetails(item) {
  elements.detailTitle.textContent = item.filename;
  const displayUrl = item.url.startsWith("data:") ? `${item.url.slice(0, item.url.indexOf(",") + 1)}… (${formatBytes(item.sizeBytes)})` : item.url;
  elements.detailContent.innerHTML = `<dl class="detail-list">
    <dt>Save as</dt><dd>${escapeHtml(item.filename)}</dd>
    <dt>Page filename</dt><dd>${escapeHtml(item.pageFilename || item.filename)}</dd>
    <dt>Link text</dt><dd>${escapeHtml(item.linkText || "None")}</dd>
    <dt>Full URL</dt><dd>${escapeHtml(displayUrl)}</dd>
    <dt>Normalized URL</dt><dd>${escapeHtml(item.normalizedUrl.startsWith("data:") ? "Embedded data resource" : item.normalizedUrl)}</dd>
    <dt>Source element</dt><dd>${escapeHtml(item.sourceElement)}</dd>
    <dt>Source type</dt><dd>${escapeHtml(item.sourceType)}</dd>
    <dt>Source label</dt><dd>${escapeHtml(item.sourceLabel || "None")}</dd>
    <dt>MIME type</dt><dd>${escapeHtml(item.mimeType || "Unknown")}</dd>
    <dt>Size</dt><dd>${escapeHtml(formatBytes(item.sizeKnown ? item.sizeBytes : NaN))}</dd>
    <dt>Occurrences</dt><dd>${item.occurrenceCount}</dd>
    <dt>Warning</dt><dd>${escapeHtml(item.warning || "None")}</dd>
    <dt>Locations</dt><dd><ul class="locations">${item.locations.map((location) => `<li>${escapeHtml(location)}</li>`).join("")}</ul></dd>
  </dl>
  <div class="drawer-toolbar">
    <button id="detailDownload" class="primary" type="button" ${item.downloadable ? "" : "disabled"}>Download now</button>
    <button id="detailOpen" class="secondary" type="button" ${/^https?:/i.test(item.url) ? "" : "disabled"}>Open URL</button>
    <button id="detailCopyName" class="secondary" type="button">Copy filename</button>
    <button id="detailFilterExt" class="secondary" type="button" ${item.extension ? "" : "disabled"}>Filter extension</button>
  </div>`;
  elements.detailContent.querySelector("#detailDownload")?.addEventListener("click", () => downloadItems([item.id]));
  elements.detailContent.querySelector("#detailOpen")?.addEventListener("click", () => chrome.tabs.create({ url: item.url }));
  elements.detailContent.querySelector("#detailCopyName")?.addEventListener("click", () => navigator.clipboard.writeText(item.filename));
  elements.detailContent.querySelector("#detailFilterExt")?.addEventListener("click", () => {
    elements.extensionInput.value = item.extension; closeDrawers(); scheduleFilter();
  });
  showDrawer(elements.detailDrawer);
}

async function downloadItems(itemIds) {
  const result = await sendMessage(MESSAGE.START_BULK_DOWNLOAD, { itemIds });
  elements.liveRegion.textContent = `${result.added} files added to the download queue.`;
  showDrawer(elements.queueDrawer);
}

async function loadPresets() {
  const { pfdFilterPresets = {} } = await chrome.storage.local.get("pfdFilterPresets");
  elements.presetSelect.innerHTML = `<option value="">Load preset…</option>${Object.keys(pfdFilterPresets).sort().map((name) =>
    `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")}`;
}

function bindEvents() {
  elements.scanButton.addEventListener("click", () => scan().catch(showError));
  elements.refreshTabsButton.addEventListener("click", () => refreshTabs().catch(showError));
  elements.tabSelect.addEventListener("change", () => chooseTab(elements.tabSelect.value).catch(showError));
  elements.currentTabButton.addEventListener("click", async () => {
    try {
      const tab = await sendMessage(MESSAGE.GET_CURRENT_BROWSER_TAB);
      if (!tab) throw new Error("No active tab was found in a normal browser window.");
      if (!tabs.some((entry) => entry.id === tab.id)) tabs.push(tab);
      await chooseTab(tab.id);
      await refreshTabs();
    } catch (error) { showError(error); }
  });
  elements.focusTabButton.addEventListener("click", () => sendMessage(MESSAGE.FOCUS_TARGET_TAB).catch(showError));
  elements.sidePanelButton.addEventListener("click", () => {
    if (!chrome.sidePanel?.open) {
      showError(new Error("The side panel is unavailable in this version of Chrome."));
      return;
    }
    if (!appState.targetTab?.id) {
      showError(new Error("Choose a target tab before opening the side panel."));
      return;
    }
    chrome.sidePanel.open({ tabId: appState.targetTab.id }).catch(showError);
  });
  elements.settingsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
  elements.sidebarToggle.addEventListener("click", () => elements.filterSidebar.classList.toggle("open"));
  elements.collapseSidebarButton.addEventListener("click", () => elements.filterSidebar.classList.toggle("collapsed"));
  for (const input of document.querySelectorAll(".filter-sidebar input, .filter-sidebar select")) {
    input.addEventListener(input.type === "checkbox" ? "change" : "input", scheduleFilter);
  }
  elements.resetFiltersButton.addEventListener("click", () => { applyFilterObject({}); scheduleFilter(); });
  elements.sortSelect.addEventListener("change", () => { renderLimit = PAGE_SIZE; render(); });
  elements.filenameSourceSelect.addEventListener("change", async () => {
    try {
      // The background recomputes every item's filename when the setting changes.
      await saveSettings({ ...await loadSettings(), filenameSource: elements.filenameSourceSelect.value });
    } catch (error) { showError(error); }
  });
  elements.sortDirectionButton.addEventListener("click", () => {
    sortDirection = sortDirection === "asc" ? "desc" : "asc";
    elements.sortDirectionButton.textContent = sortDirection === "asc" ? "↑" : "↓";
    render();
  });
  elements.loadMoreButton.addEventListener("click", () => {
    const firstNewIndex = renderLimit;
    renderLimit += PAGE_SIZE;
    render();
    const firstNewRow = elements.resultBody.querySelectorAll("tr")[firstNewIndex];
    if (firstNewRow) {
      firstNewRow.tabIndex = -1;
      firstNewRow.scrollIntoView({ block: "start", behavior: "smooth" });
      firstNewRow.focus({ preventScroll: true });
      elements.liveRegion.textContent = `${Math.min(renderLimit, visibleItems.length)} of ${visibleItems.length} results are now shown.`;
    }
  });
  elements.selectVisibleButton.addEventListener("click", () => setSelection([...appState.selectedIds, ...visibleItems.filter((item) => item.downloadable).map((item) => item.id)]));
  elements.selectAllButton.addEventListener("click", () => setSelection(appState.items.filter((item) => item.downloadable).map((item) => item.id)));
  elements.invertVisibleButton.addEventListener("click", () => {
    const selected = new Set(appState.selectedIds);
    for (const item of visibleItems) item.downloadable && (selected.has(item.id) ? selected.delete(item.id) : selected.add(item.id));
    setSelection([...selected]);
  });
  elements.deselectVisibleButton.addEventListener("click", () => {
    const visible = new Set(visibleItems.map((item) => item.id));
    setSelection(appState.selectedIds.filter((id) => !visible.has(id)));
  });
  elements.deselectAllButton.addEventListener("click", () => setSelection([]));
  elements.headerCheckbox.addEventListener("change", () => elements.headerCheckbox.checked
    ? elements.selectVisibleButton.click() : elements.deselectVisibleButton.click());
  elements.resultBody.addEventListener("change", (event) => {
    if (!event.target.classList.contains("row-check")) return;
    const id = event.target.closest("tr").dataset.id;
    const selected = new Set(appState.selectedIds);
    event.target.checked ? selected.add(id) : selected.delete(id);
    setSelection([...selected]);
  });
  elements.resultBody.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const item = appState.items.find((candidate) => candidate.id === button.closest("tr").dataset.id);
    if (!item) return;
    if (button.dataset.action === "detail") showDetails(item);
    if (button.dataset.action === "download") downloadItems([item.id]).catch(showError);
    if (button.dataset.action === "copy") {
      await navigator.clipboard.writeText(item.url);
      elements.liveRegion.textContent = "URL copied.";
    }
  });
  elements.downloadButton.addEventListener("click", () => downloadItems(appState.selectedIds).catch(showError));
  elements.toolbarDownloadButton.addEventListener("click", () => downloadItems(appState.selectedIds).catch(showError));
  elements.activityButton.addEventListener("click", () => showDrawer(elements.queueDrawer));
  elements.closeDetailButton.addEventListener("click", closeDrawers);
  elements.closeQueueButton.addEventListener("click", closeDrawers);
  elements.scrim.addEventListener("click", closeDrawers);
  elements.retryAllButton.addEventListener("click", () => sendMessage(MESSAGE.RETRY_ALL_FAILED).catch(showError));
  elements.cancelQueuedButton.addEventListener("click", () => sendMessage(MESSAGE.CANCEL_QUEUED).catch(showError));
  elements.clearCompletedButton.addEventListener("click", () => sendMessage(MESSAGE.CLEAR_COMPLETED).catch(showError));
  elements.queueContent.addEventListener("click", (event) => {
    const button = event.target.closest(".retry-one");
    if (button) sendMessage(MESSAGE.RETRY_DOWNLOAD, { queueId: button.dataset.queueId }).catch(showError);
  });
  elements.savePresetButton.addEventListener("click", async () => {
    const name = prompt("Name this filter preset:");
    if (!name?.trim()) return;
    const key = name.trim().slice(0, 60);
    const { pfdFilterPresets = {} } = await chrome.storage.local.get("pfdFilterPresets");
    pfdFilterPresets[key] = filtersFromUi();
    await chrome.storage.local.set({ pfdFilterPresets });
    await loadPresets();
    elements.presetSelect.value = key;
  });
  elements.presetSelect.addEventListener("change", async () => {
    if (!elements.presetSelect.value) return;
    const { pfdFilterPresets = {} } = await chrome.storage.local.get("pfdFilterPresets");
    applyFilterObject(pfdFilterPresets[elements.presetSelect.value]);
    scheduleFilter();
  });
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === MESSAGE.APP_STATE_UPDATED && message.state) {
      const pendingSelection = selectionDirty ? appState.selectedIds : null;
      appState = message.state;
      if (pendingSelection) appState.selectedIds = pendingSelection;
      render();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "/" && !/^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) {
      event.preventDefault(); elements.searchInput.focus();
    }
    if (event.key === "Escape") closeDrawers();
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault(); if (!elements.downloadButton.disabled) elements.downloadButton.click();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && elements.resultArea.contains(document.activeElement)) {
      event.preventDefault(); elements.selectVisibleButton.click();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r" && elements.resultArea.contains(document.activeElement)) {
      event.preventDefault(); elements.scanButton.click();
    }
  });
}

// In side-panel mode Chrome opens the panel straight from the toolbar click, so the
// panel itself adopts the active tab of its window as the target.
async function followActiveTabInSidePanel() {
  if (!location.pathname.endsWith("/sidepanel.html")) return false;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || tab.id === appState.targetTab?.id) return false;
  try {
    await sendMessage(MESSAGE.SET_TARGET_TAB, { tabId: tab.id });
    appState = await sendMessage(MESSAGE.GET_APP_STATE);
    return true;
  } catch {
    return false; // Unsupported page: keep the previous target.
  }
}

export async function initApp() {
  if (initialized) return;
  initialized = true;
  cacheElements();
  trackToolbarHeight();
  bindEvents();
  try {
    appState = await sendMessage(MESSAGE.GET_APP_STATE);
    applyFilterObject({
      mode: appState.settings.defaultFilterMode,
      matchTarget: appState.settings.matchTarget,
      caseSensitive: appState.settings.caseSensitive,
      categories: appState.settings.defaultCategories
    });
    const retargeted = await followActiveTabInSidePanel();
    await Promise.all([refreshTabs(), loadPresets()]);
    render();
    const neverScanned = !appState.items.length && appState.scan.status === "idle";
    if (appState.settings.autoScan && appState.targetTab && (retargeted || neverScanned)) {
      scan().catch(showError);
    }
  } catch (error) {
    showError(error);
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initApp, { once: true });
else void initApp();
