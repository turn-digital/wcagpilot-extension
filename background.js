// background.js — minimal service worker. On toolbar-icon click, open the audit
// runner in a normal extension window, passing the audited tab's id/window.
//
// Why a window (not a toolbar popup): the keyboard test attaches chrome.debugger,
// which shows a "debugging" banner that steals focus. A toolbar popup closes on
// focus loss — aborting the whole audit. A window keeps running.

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  const url = chrome.runtime.getURL(`runner.html?tab=${tab.id}&win=${tab.windowId}`);
  try {
    await chrome.windows.create({ url, type: "popup", width: 460, height: 600, focused: true });
  } catch (e) {
    // As a fallback, open it as a tab.
    chrome.tabs.create({ url });
  }
});
