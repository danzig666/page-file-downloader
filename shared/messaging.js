export async function sendMessage(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response) throw new Error("The background service did not respond.");
  if (!response.ok) throw new Error(response.error || "The request failed.");
  return response.data;
}

export function onRuntimeMessage(handler) {
  const listener = (message, sender, sendResponse) => {
    Promise.resolve(handler(message, sender)).then((data) => sendResponse({ ok: true, data }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
