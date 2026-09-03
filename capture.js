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
// Wait for the page to settle before we snapshot the DOM. On SPAs (Next.js,
// React), the server HTML is an empty shell and the real content — including the
// section titles the headings/alt-text workers analyse — renders asynchronously
// after hydration + data fetch. Snapshotting too early captured a half-rendered
// DOM, which is why two audits of the same page seconds apart disagreed (one saw
// the section headings, one didn't). We wait for `load`, then for the DOM to go
// quiet (no mutations for `quietMs`), capped at `maxMs`, then a paint frame.
// Runs in the page's isolated world; must be self-contained.
async function _waitForSettleInPage(quietMs, maxMs) {
  quietMs = quietMs || 600;
  maxMs = maxMs || 4000;

  // 1) Reach document 'complete' (usually already true — the user was viewing it).
  await new Promise((res) => {
    if (document.readyState === "complete") return res();
    let done = false;
    const finish = () => { if (!done) { done = true; res(); } };
    window.addEventListener("load", finish, { once: true });
    setTimeout(finish, maxMs);
  });

  // 2) Wait for the DOM to stop mutating (SPA hydration/data render finished),
  //    or give up after maxMs so a page that never goes quiet can't hang capture.
  await new Promise((res) => {
    let done = false;
    let quietTimer = null;
    const finish = () => {
      if (done) return;
      done = true;
      try { obs.disconnect(); } catch (e) {}
      clearTimeout(quietTimer);
      clearTimeout(hardCap);
      res();
    };
    const bump = () => { clearTimeout(quietTimer); quietTimer = setTimeout(finish, quietMs); };
    let obs;
    try {
      obs = new MutationObserver(bump);
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    } catch (e) { return res(); }
    const hardCap = setTimeout(finish, maxMs);
    bump();
  });

  // 3) Let the final render paint.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return true;
}

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

  // Let the page settle first so SPAs finish rendering their content before we
  // snapshot the DOM (prevents half-rendered captures → inconsistent audits).
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: _waitForSettleInPage,
      args: [600, 4000],
    });
  } catch (e) { /* non-fatal — capture whatever is there */ }

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
