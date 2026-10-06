import { EXTENSION_CATEGORIES, MIME_EXTENSIONS, TRACKING_PARAMETERS } from "./constants.js";

export function hashString(value) {
  let h1 = 0xdeadbeef ^ value.length;
  let h2 = 0x41c6ce57 ^ value.length;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(36)}${(h1 >>> 0).toString(36)}`;
}

export function normalizeUrl(raw, settings = {}) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const value = raw.trim();
  if (/^(javascript|mailto|tel|sms|intent):/i.test(value) || value.startsWith("#")) return null;
  if (/^(data|blob):/i.test(value)) return value;
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) && url.protocol !== "file:") return null;
    if (settings.ignoreFragments !== false) url.hash = "";
    if (settings.ignoreTrackingParameters !== false) {
      for (const key of [...url.searchParams.keys()]) {
        if (TRACKING_PARAMETERS.has(key.toLowerCase())) url.searchParams.delete(key);
      }
    }
    return url.href;
  } catch {
    return null;
  }
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function extensionFromName(name = "") {
  const clean = name.split(/[?#]/, 1)[0];
  const match = /\.([a-z0-9]{1,12})$/i.exec(clean);
  return match ? match[1].toLowerCase() : "";
}

export function inferExtension(url, mimeType = "", explicitName = "") {
  const named = extensionFromName(explicitName);
  if (named) return named;
  if (MIME_EXTENSIONS[mimeType?.split(";")[0]?.toLowerCase()]) {
    return MIME_EXTENSIONS[mimeType.split(";")[0].toLowerCase()];
  }
  if (url.startsWith("data:")) {
    const header = url.slice(5, Math.max(5, url.indexOf(",")));
    return MIME_EXTENSIONS[header.split(";", 1)[0].toLowerCase()] || "";
  }
  try {
    const parsed = new URL(url);
    const pathExt = extensionFromName(safeDecode(parsed.pathname));
    if (pathExt) return pathExt;
    for (const key of ["filename", "file", "name", "download", "attachment", "format", "type", "export"]) {
      const value = (parsed.searchParams.get(key) || "").toLowerCase();
      const ext = extensionFromName(value) || (EXTENSION_CATEGORIES[value] ? value : "");
      if (ext) return ext;
    }
  } catch {
    return "";
  }
  return "";
}

export function inferFilename(url, explicitName = "", mimeType = "", index = 1) {
  if (explicitName?.trim()) return sanitizeFilename(explicitName.trim());
  const ext = inferExtension(url, mimeType);
  if (url.startsWith("data:")) return `embedded-file-${String(index).padStart(3, "0")}${ext ? `.${ext}` : ""}`;
  if (url.startsWith("blob:")) return `page-blob-${String(index).padStart(3, "0")}${ext ? `.${ext}` : ""}`;
  try {
    const parsed = new URL(url);
    for (const key of ["filename", "file", "name", "download", "attachment"]) {
      const value = parsed.searchParams.get(key);
      if (value && (value.includes(".") || key === "filename")) return sanitizeFilename(value);
    }
    const last = safeDecode(parsed.pathname.split("/").filter(Boolean).pop() || "");
    if (last && last.includes(".")) return sanitizeFilename(last);
  } catch { /* use fallback */ }
  return `download-${String(index).padStart(3, "0")}${ext ? `.${ext}` : ""}`;
}

export function categoryFor(extension = "", mimeType = "") {
  if (EXTENSION_CATEGORIES[extension]) return EXTENSION_CATEGORIES[extension];
  const major = mimeType?.split("/", 1)[0];
  return ["image", "audio", "video", "text"].includes(major) ? major : "other";
}

// Chrome's downloads API rejects names containing control/format characters or
// <>:"/\|?*, names that start or end with whitespace, "." or "~", and reserved
// Windows device names, so all of those are normalized here.
const TRIM_ENDS = /^[\s.~]+|[\s.~]+$/gu;

export function sanitizeFilename(input, fallback = "download") {
  let value = String(input || "").normalize("NFKC");
  value = value.replace(/[\p{Cc}\p{Cf}<>:"/\\|?*]/gu, "_").replace(/\s+/gu, " ").replace(/\.{2,}/g, "_");
  value = value.replace(TRIM_ENDS, "");
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$|clock\$)(?:\.|$)/i;
  if (!value || reserved.test(value)) value = `_${value || fallback}`;
  if (value.length > 180) {
    const ext = extensionFromName(value);
    let stem = "";
    // Cut by whole code points so a surrogate pair is never split.
    for (const char of value.slice(0, value.length - (ext ? ext.length + 1 : 0))) {
      if (stem.length + char.length > 175 - ext.length) break;
      stem += char;
    }
    value = `${stem.replace(TRIM_ENDS, "") || fallback}${ext ? `.${ext}` : ""}`;
  }
  return value || fallback;
}

// Builds "<link text>.<ext>", taking ext from the page-supplied filename (or the
// inferred type). Returns "" when the item has no usable link text.
export function linkTextFilename(linkText, pageFilename, extension = "") {
  const text = String(linkText || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const ext = extensionFromName(pageFilename) || String(extension || "").toLowerCase();
  const stem = ext && text.toLowerCase().endsWith(`.${ext}`) ? text.slice(0, -(ext.length + 1)) : text;
  const safeStem = sanitizeFilename(stem, "");
  if (!safeStem) return "";
  return sanitizeFilename(ext ? `${safeStem}.${ext}` : safeStem);
}

export function chooseFilename(item, filenameSource = "page") {
  const pageName = item.pageFilename || item.filename || "download";
  if (filenameSource !== "linkText") return pageName;
  return linkTextFilename(item.linkText, pageName, item.extension) || pageName;
}

export function sanitizePathSegment(value, fallback = "page") {
  return sanitizeFilename(String(value || "").replace(/[\\/]+/g, "_"), fallback);
}

export function buildDownloadPath(item, settings) {
  const date = new Date().toISOString().slice(0, 10);
  let hostname = "page";
  try { hostname = new URL(item.pageUrl || item.url).hostname || "page"; } catch { /* fallback */ }
  const values = {
    hostname: sanitizePathSegment(hostname, "page"),
    pageTitle: sanitizePathSegment(item.pageTitle, "page"),
    date
  };
  let template = String(settings.downloadFolder || "");
  template = template.replace(/\{(hostname|pageTitle|date)\}/g, (_, key) => values[key]);
  template = template.replace(/\{[^}]+\}/g, "").replace(/\\/g, "/");
  const parts = template.split("/").filter(Boolean).map((part) => sanitizePathSegment(part, "folder")).slice(0, 12);
  return [...parts, sanitizeFilename(item.filename)].join("/");
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** exponent)).toFixed(exponent ? 1 : 0)} ${units[exponent]}`;
}
