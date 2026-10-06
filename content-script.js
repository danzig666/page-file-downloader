(() => {
  // The script is injected on every scan. After an extension reload the old copy's
  // listener is dead but any "already installed" flag would survive, so each
  // injection tears down the previous instance and installs itself fresh.
  try { globalThis.__pageFileDownloaderCleanup?.(); } catch { /* previous context invalidated */ }

  const URL_ATTRIBUTES = [
    "href", "src", "data", "data-src", "data-href", "data-url", "data-download",
    "data-file", "data-original", "data-lazy-src"
  ];
  const WATCHED_ATTRIBUTES = [...URL_ATTRIBUTES, "srcset", "data-srcset", "style", "download"];
  const SOURCE_BY_TAG = {
    A: "anchor", IMG: "image", SOURCE: "source", VIDEO: "video", AUDIO: "audio",
    TRACK: "track", EMBED: "embed", OBJECT: "object", IFRAME: "iframe", META: "metadata"
  };
  const DIRECT_URL = /(?:\bhttps?:\/\/|(?<![\w/.:-])\/)[^\s<>"')\]]+\.(?:pdf|png|jpe?g|gif|webp|svg|avif|zip|rar|7z|docx?|xlsx?|csv|pptx?|txt|json|xml|mp3|mp4)(?:[?#][^\s<>"')\]]*)?/gi;

  function safeUrl(value) {
    if (typeof value !== "string" || !value.trim() || value.trim().startsWith("#")) return null;
    if (/^(javascript|mailto|tel|sms):/i.test(value.trim())) return null;
    try {
      const url = new URL(value.trim(), document.baseURI);
      return /^(https?|file|data|blob):$/.test(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }

  function clean(text) {
    return String(text || "").replace(/\s+/g, " ").trim().slice(0, 300);
  }

  function labelFor(element) {
    if (!element) return "";
    return clean(element.getAttribute("aria-label") || element.getAttribute("title") ||
      element.textContent || element.getAttribute("alt"));
  }

  // The human-readable text of a link (or the alt text of an image), used for
  // the optional "name files after link text" mode.
  function linkTextFor(element) {
    if (!element) return "";
    if (element.tagName === "A") {
      return clean(element.innerText || element.textContent) || clean(element.getAttribute("aria-label")) ||
        clean(element.getAttribute("title")) || clean(element.querySelector("img[alt]")?.getAttribute("alt"));
    }
    if (element.tagName === "IMG") return clean(element.getAttribute("alt") || element.getAttribute("title"));
    return clean(element.getAttribute("aria-label") || element.getAttribute("title"));
  }

  function add(candidates, rawUrl, sourceType, element, extra = {}) {
    const url = safeUrl(rawUrl);
    if (!url) return;
    const label = labelFor(element);
    candidates.push({
      url,
      sourceType,
      sourceLabel: label,
      linkText: linkTextFor(element),
      downloadName: extra.downloadName || "",
      mimeType: extra.mimeType || element?.getAttribute?.("type") || "",
      sourceElement: element ? `<${element.tagName.toLowerCase()}>` : "page text",
      location: extra.location || `${sourceType}: ${label || url.slice(0, 120)}`,
      explicitDownload: Boolean(extra.explicitDownload)
    });
  }

  function parseSrcset(candidates, value, sourceType, element) {
    for (const entry of String(value || "").split(",")) {
      const candidate = entry.trim().split(/\s+/, 1)[0];
      if (candidate) add(candidates, candidate, sourceType, element);
    }
  }

  function walkJson(value, candidates, count = { value: 0 }) {
    if (count.value > 2000) return;
    if (typeof value === "string") {
      count.value += 1;
      if (/^(?:https?:|\/)/i.test(value) || /\.[a-z0-9]{2,8}(?:[?#]|$)/i.test(value)) {
        add(candidates, value, "structured-data", null, { location: "JSON/JSON-LD value" });
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value.slice(0, 1000)) walkJson(entry, candidates, count);
    } else if (value && typeof value === "object") {
      for (const entry of Object.values(value).slice(0, 1000)) walkJson(entry, candidates, count);
    }
  }

  // Returns the non-empty ranges of the page selection, or null when nothing is selected.
  function selectedRanges() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const ranges = [];
    for (let i = 0; i < selection.rangeCount; i += 1) {
      const range = selection.getRangeAt(i);
      if (!range.collapsed) ranges.push(range);
    }
    return ranges.length ? ranges : null;
  }

  // An element counts as selected when it lies inside a selected range. Elements
  // that merely enclose the selection are excluded (otherwise <body> styles and the
  // like would match), except links, so selecting part of a link's text picks it up.
  function inSelection(element, ranges) {
    return ranges.some((range) => {
      if (!range.intersectsNode(element)) return false;
      const enclosesSelection = element.contains(range.commonAncestorContainer);
      return !enclosesSelection || element.tagName === "A";
    });
  }

  async function scanPage(options = {}) {
    const candidates = [];
    const maxCandidates = Math.min(50000, Math.max(100, Number(options.maxCandidates) || 10000));
    const ranges = options.selectionOnly === false ? null : selectedRanges();
    let elements = [...document.querySelectorAll(
      "a[href], [download], img, source, video, audio, track, embed, object, iframe, meta, [style], " +
      "[data-src], [data-href], [data-url], [data-download], [data-file], [data-original], [data-lazy-src], [data-srcset]"
    )];
    if (ranges) elements = elements.filter((element) => inSelection(element, ranges));

    for (let index = 0; index < elements.length && candidates.length < maxCandidates; index += 1) {
      const element = elements[index];
      const sourceType = SOURCE_BY_TAG[element.tagName] || "data-attribute";
      for (const attribute of URL_ATTRIBUTES) {
        if (!element.hasAttribute(attribute)) continue;
        add(candidates, element.getAttribute(attribute), sourceType, element, {
          downloadName: element.tagName === "A" ? element.getAttribute("download") || "" : "",
          explicitDownload: element.hasAttribute("download"),
          location: `${element.tagName.toLowerCase()}[${attribute}]`
        });
      }
      for (const attribute of ["srcset", "data-srcset"]) {
        if (element.hasAttribute(attribute)) parseSrcset(candidates, element.getAttribute(attribute), `${sourceType}-srcset`, element);
      }
      const style = element.getAttribute("style") || "";
      for (const match of style.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
        add(candidates, match[2], "background-image", element);
      }
      if (element.tagName === "META") {
        const key = `${element.getAttribute("property") || ""} ${element.getAttribute("name") || ""}`;
        if (/(image|video|audio|download|document|file)/i.test(key)) add(candidates, element.content, "metadata", element);
      }
      if (index > 0 && index % 500 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }

    if (!ranges) {
      for (const script of [...document.querySelectorAll('script[type="application/ld+json"], script[type="application/json"]')].slice(0, 50)) {
        if (candidates.length >= maxCandidates) break;
        try { walkJson(JSON.parse(script.textContent.slice(0, 2_000_000)), candidates); } catch { /* malformed page JSON */ }
      }
    }

    const text = (ranges ? ranges.map((range) => range.toString()).join("\n") : document.body?.innerText || "").slice(0, 500_000);
    for (const match of text.matchAll(DIRECT_URL)) {
      if (candidates.length >= maxCandidates) break;
      add(candidates, match[0], "visible-text", null, { location: ranges ? "Selected page text" : "Visible page text" });
    }

    return {
      pageUrl: location.href,
      pageTitle: document.title,
      baseUrl: document.baseURI,
      candidates: candidates.slice(0, maxCandidates),
      candidateLimitReached: candidates.length >= maxCandidates,
      selectionOnly: Boolean(ranges),
      scannedAt: Date.now()
    };
  }

  let observer = null;
  let watchTimer = null;
  const listener = (message, _sender, sendResponse) => {
    if (message?.type === "PFD_SCAN_PAGE") {
      scanPage(message.options).then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }
    if (message?.type === "PFD_START_WATCH") {
      observer?.disconnect();
      observer = new MutationObserver(() => {
        clearTimeout(watchTimer);
        watchTimer = setTimeout(() => chrome.runtime.sendMessage({ type: "PAGE_CONTENT_CHANGED" }).catch(() => {}), 1200);
      });
      observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: WATCHED_ATTRIBUTES
      });
      sendResponse({ ok: true });
    }
    if (message?.type === "PFD_STOP_WATCH") {
      observer?.disconnect();
      observer = null;
      clearTimeout(watchTimer);
      sendResponse({ ok: true });
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(listener);
  globalThis.__pageFileDownloaderCleanup = () => {
    observer?.disconnect();
    clearTimeout(watchTimer);
    chrome.runtime.onMessage.removeListener(listener);
  };
})();
