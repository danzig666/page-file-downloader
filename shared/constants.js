export const MESSAGE = Object.freeze({
  GET_APP_STATE: "GET_APP_STATE",
  GET_TABS: "GET_TABS",
  GET_CURRENT_BROWSER_TAB: "GET_CURRENT_BROWSER_TAB",
  SET_TARGET_TAB: "SET_TARGET_TAB",
  SCAN_TARGET_TAB: "SCAN_TARGET_TAB",
  UPDATE_SELECTION: "UPDATE_SELECTION",
  START_BULK_DOWNLOAD: "START_BULK_DOWNLOAD",
  RETRY_DOWNLOAD: "RETRY_DOWNLOAD",
  RETRY_ALL_FAILED: "RETRY_ALL_FAILED",
  CANCEL_QUEUED: "CANCEL_QUEUED",
  CLEAR_COMPLETED: "CLEAR_COMPLETED",
  FOCUS_TARGET_TAB: "FOCUS_TARGET_TAB",
  APP_STATE_UPDATED: "APP_STATE_UPDATED",
  SCAN_PAGE: "PFD_SCAN_PAGE",
  START_WATCH: "PFD_START_WATCH",
  STOP_WATCH: "PFD_STOP_WATCH"
});

export const EXTENSION_CATEGORIES = Object.freeze({
  pdf: "document", doc: "document", docx: "document", odt: "document", rtf: "document",
  xls: "spreadsheet", xlsx: "spreadsheet", ods: "spreadsheet", csv: "spreadsheet",
  ppt: "presentation", pptx: "presentation", odp: "presentation",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  svg: "image", avif: "image", bmp: "image", ico: "image", tif: "image", tiff: "image",
  zip: "archive", rar: "archive", "7z": "archive", tar: "archive", gz: "archive", bz2: "archive",
  mp3: "audio", wav: "audio", ogg: "audio", m4a: "audio", flac: "audio", aac: "audio",
  mp4: "video", webm: "video", mov: "video", avi: "video", mkv: "video", m4v: "video",
  txt: "text", json: "data", xml: "data", yaml: "data", yml: "data",
  epub: "ebook", mobi: "ebook", apk: "package", dmg: "package", exe: "package", iso: "package"
});

export const MIME_EXTENSIONS = Object.freeze({
  "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
  "image/webp": "webp", "image/svg+xml": "svg", "image/avif": "avif",
  "application/zip": "zip", "application/x-rar-compressed": "rar",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/csv": "csv", "text/plain": "txt", "application/json": "json",
  "application/xml": "xml", "text/xml": "xml", "audio/mpeg": "mp3", "video/mp4": "mp4"
});

export const DEFAULT_SETTINGS = Object.freeze({
  defaultInterface: "window",
  rememberWindowGeometry: true,
  autoScan: true,
  defaultCategories: [],
  customExtensions: [],
  defaultFilterMode: "plain",
  caseSensitive: false,
  matchTarget: "filename",
  ignoreFragments: true,
  ignoreTrackingParameters: true,
  inspectMetadata: false,
  metadataConcurrency: 3,
  downloadConcurrency: 4,
  downloadFolder: "Page File Downloader/{hostname}/{date}/",
  filenameSource: "page",
  askWhereToSave: false,
  scanSelectionOnly: true,
  watchPage: false,
  maxCandidates: 10000,
  maxDisplayedResults: 5000,
  dataLimitBytes: 3 * 1024 * 1024,
  rememberTarget: true,
  rememberScan: true
});

export const RESTRICTED_SCHEMES = /^(chrome|edge|about|devtools|chrome-extension):/i;
export const TRACKING_PARAMETERS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"
]);
export const APP_STATE_KEY = "pfdAppState";
export const QUEUE_KEY = "pfdQueue";
export const SETTINGS_KEY = "pfdSettings";
export const WINDOW_KEY = "pfdAppWindow";
export const GEOMETRY_KEY = "pfdWindowGeometry";
export const PAGE_SIZE = 200;
