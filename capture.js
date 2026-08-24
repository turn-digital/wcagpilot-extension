// capture.js — In-page capture for full single-page audits.
//
// Runs from the popup (the action click is a user gesture, which grants
// `activeTab`). Produces the inputs the server-side orchestrator needs to audit
// a page that lives behind a login wall / VPN / pre-launch, where ZenRows
// cannot reach it:
//
//   { url, title, lang, html, screenshot, capturedAt }
//
// - html       : the live, rendered, post-JS, authenticated DOM (outerHTML)
// - screenshot : visible viewport (PNG data URL), optional
//
// Contrast is scanned separately (computed-style + pixel-sampling) in
// evidence.js — this capture no longer runs axe-core.
//
// No ZenRows / server-side fetch is involved — everything comes from the tab the
// user is looking at.

function _isUnsupportedUrl(url) {
  return (
    !url ||
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("view-source:") ||
    url.startsWith("file://")
  );
}

// Injected into the page's isolated world. Must be fully self-contained — it is
// serialized and executed in the target tab, so it cannot reference anything in
// this file's scope.
async function _capturePageInPage() {
  function serializeDom() {
    const dt = document.doctype;
    let doctype = "";
    if (dt) {
      doctype =
        "<!DOCTYPE " +
        dt.name +
        (dt.publicId ? ' PUBLIC "' + dt.publicId + '"' : "") +
        (!dt.publicId && dt.systemId ? " SYSTEM" : "") +
        (dt.systemId ? ' "' + dt.systemId + '"' : "") +
        ">";
    }
    return doctype + "\n" + document.documentElement.outerHTML;
  }

  return {
    url: location.href,
    title: document.title || "",
    lang: document.documentElement.getAttribute("lang") || "",
    html: serializeDom(),
  };
}

/**
 * Capture everything needed to audit a specific tab's page.
 * @param {number} tabId
 * @param {number} windowId
 * @returns {Promise<{url:string,title:string,lang:string,html:string,screenshot:(string|null),capturedAt:string}>}
 */
async function captureTabAudit(tabId, windowId) {
  if (!tabId) throw new Error("No target tab");
  const tab = await chrome.tabs.get(tabId);
  if (_isUnsupportedUrl(tab.url)) {
    throw new Error("Cannot audit browser internal pages");
  }

  // Serialize the live DOM.
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: _capturePageInPage,
  });
  if (!injection?.result) {
    throw new Error("Failed to capture page");
  }
  const capture = injection.result;

  // 3. Visible-viewport screenshot (from the extension context). Non-fatal.
  let screenshot = null;
  try {
    screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "png",
    });
  } catch (e) {
    screenshot = null;
  }

  return {
    ...capture,
    screenshot,
    capturedAt: new Date().toISOString(),
  };
}
