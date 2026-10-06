import { DEFAULT_SETTINGS, SETTINGS_KEY } from "./constants.js";

const interfaceValues = new Set(["window", "sidepanel"]);
const modeValues = new Set(["plain", "wildcard", "regex"]);

export function validateSettings(input = {}) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const output = { ...DEFAULT_SETTINGS };
  const bools = [
    "rememberWindowGeometry", "autoScan", "caseSensitive", "ignoreFragments",
    "ignoreTrackingParameters", "inspectMetadata", "askWhereToSave", "watchPage",
    "rememberTarget", "rememberScan", "scanSelectionOnly"
  ];
  for (const key of bools) if (typeof source[key] === "boolean") output[key] = source[key];
  if (interfaceValues.has(source.defaultInterface)) output.defaultInterface = source.defaultInterface;
  if (modeValues.has(source.defaultFilterMode)) output.defaultFilterMode = source.defaultFilterMode;
  if (["filename", "url"].includes(source.matchTarget)) output.matchTarget = source.matchTarget;
  if (["page", "linkText"].includes(source.filenameSource)) output.filenameSource = source.filenameSource;
  const ranges = {
    metadataConcurrency: [1, 10], downloadConcurrency: [1, 12],
    maxCandidates: [100, 50000], maxDisplayedResults: [100, 20000],
    dataLimitBytes: [1024, 3 * 1024 * 1024]
  };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const value = Number(source[key]);
    if (Number.isFinite(value)) output[key] = Math.round(Math.min(max, Math.max(min, value)));
  }
  if (typeof source.downloadFolder === "string" && source.downloadFolder.length <= 300) {
    output.downloadFolder = source.downloadFolder.replace(/[\u0000-\u001f]/g, "");
  }
  for (const key of ["defaultCategories", "customExtensions"]) {
    if (Array.isArray(source[key])) {
      output[key] = source[key].filter((v) => typeof v === "string" && /^[a-z0-9_-]{1,24}$/i.test(v)).slice(0, 100);
    }
  }
  return output;
}

export async function loadSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return validateSettings(data[SETTINGS_KEY]);
}

export async function saveSettings(input) {
  const settings = validateSettings(input);
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}
