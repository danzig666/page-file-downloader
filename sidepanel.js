async function loadSharedApplication() {
  const response = await fetch(chrome.runtime.getURL("app.html"));
  if (!response.ok) throw new Error("The shared application layout could not be loaded.");
  const source = await response.text();
  const parsed = new DOMParser().parseFromString(source, "text/html");
  for (const script of parsed.querySelectorAll("script")) script.remove();
  document.body.replaceChildren(...[...parsed.body.childNodes].map((node) => document.importNode(node, true)));
  await import("./app.js");
}

loadSharedApplication().catch((error) => {
  console.error(error);
  document.body.textContent = `Page File Downloader could not start: ${error.message}`;
});
