// capture.js — In-page capture for full single-page audits.
//
// Runs from the popup (the action click is a user gesture, which grants
// `activeTab`). Produces the inputs the server-side orchestrator needs to audit
// a page that lives behind a login wall / VPN / pre-launch, where ZenRows
// cannot reach it:
//
//   { url, title, lang, html, axe, screenshot, capturedAt }
//
// - html       : the live, rendered, post-JS, authenticated DOM (outerHTML)
// - axe        : axe-core run in-page (violations + pass/incomplete ids)
// - screenshot : visible viewport (PNG data URL), optional
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

  let axe = null;
  try {
    if (window.axe && typeof window.axe.run === "function") {
      const r = await window.axe.run(document, {
        resultTypes: ["violations", "passes", "incomplete"],
      });
      // Keep full violations (we need node details); reduce passes/incomplete to
      // ids to keep the payload small.
      axe = {
        violations: r.violations,
        passes: (r.passes || []).map((p) => ({ id: p.id })),
        incomplete: (r.incomplete || []).map((p) => ({ id: p.id })),
        engineVersion: (r.testEngine && r.testEngine.version) || null,
      };
    } else {
      axe = { error: "axe-core not loaded" };
    }
  } catch (e) {
    axe = { error: e && e.message ? e.message : String(e) };
  }

  return {
    url: location.href,
    title: document.title || "",
    lang: document.documentElement.getAttribute("lang") || "",
    html: serializeDom(),
    axe: axe,
  };
}

/**
 * Capture everything needed to audit a specific tab's page.
 * @param {number} tabId
 * @param {number} windowId
 * @returns {Promise<{url:string,title:string,lang:string,html:string,axe:object,screenshot:(string|null),capturedAt:string}>}
 */
async function captureTabAudit(tabId, windowId) {
  if (!tabId) throw new Error("No target tab");
  const tab = await chrome.tabs.get(tabId);
  if (_isUnsupportedUrl(tab.url)) {
    throw new Error("Cannot audit browser internal pages");
  }

  // 1. Load axe-core into the page's isolated world (persists for the next
  //    executeScript call in the same frame).
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["vendor/axe.min.js"],
  });

  // 2. Serialize the live DOM + run axe in the page.
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
