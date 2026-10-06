import { DEFAULT_SETTINGS } from "./shared/constants.js";
import { loadSettings, saveSettings, validateSettings } from "./shared/settings.js";

const form = document.getElementById("settingsForm");
const status = document.getElementById("status");

function setForm(settings) {
  for (const [key, value] of Object.entries(settings)) {
    const input = form.elements.namedItem(key);
    if (!input) continue;
    if (input.type === "checkbox") input.checked = value;
    else if (Array.isArray(value)) input.value = value.join(", ");
    else input.value = value;
  }
  form.elements.dataLimitMb.value = Math.round(settings.dataLimitBytes / 1024 / 1024);
}

function getForm() {
  const data = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const input = form.elements.namedItem(key);
    if (!input) continue;
    if (input.type === "checkbox") data[key] = input.checked;
    else if (["defaultCategories", "customExtensions"].includes(key)) {
      data[key] = input.value.split(/[,;]/).map((value) => value.trim().toLowerCase()).filter(Boolean);
    } else if (input.type === "number") data[key] = Number(input.value);
    else data[key] = input.value;
  }
  data.dataLimitBytes = Number(form.elements.dataLimitMb.value) * 1024 * 1024;
  return validateSettings(data);
}

function announce(message) {
  status.textContent = message;
  setTimeout(() => { if (status.textContent === message) status.textContent = ""; }, 5000);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const settings = await saveSettings(getForm());
  setForm(settings);
  announce("Settings saved.");
});

document.getElementById("resetButton").addEventListener("click", async () => {
  const settings = await saveSettings(DEFAULT_SETTINGS);
  setForm(settings);
  announce("Defaults restored.");
});

document.getElementById("exportButton").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(getForm(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "page-file-downloader-settings.json";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

document.getElementById("importInput").addEventListener("change", async (event) => {
  try {
    const file = event.target.files?.[0];
    if (!file || file.size > 1_000_000) throw new Error("Choose a settings JSON file smaller than 1 MB.");
    const parsed = JSON.parse(await file.text());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The imported JSON must contain an object.");
    const settings = await saveSettings(parsed);
    setForm(settings);
    announce("Settings imported and validated.");
  } catch (error) {
    console.error(error);
    announce(`Import failed: ${error.message}`);
  } finally {
    event.target.value = "";
  }
});

setForm(await loadSettings());
