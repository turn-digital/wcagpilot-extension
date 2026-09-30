// runner.js — audit controller, hosted in a normal extension WINDOW (not the
// toolbar popup). A window doesn't auto-close on focus loss, so the audit
// survives the chrome.debugger banner that pops up during the keyboard test
// (which would close a toolbar popup and abort everything).
//
// The target tab/window are passed in the URL by background.js. The whole
// pipeline targets that explicit tab (never "the active tab", which here would
// be this runner window).

const params = new URLSearchParams(location.search);
const TAB_ID = parseInt(params.get("tab"), 10);
const WIN_ID = parseInt(params.get("win"), 10);

const $ = (id) => document.getElementById(id);
const els = {
  targetUrl: $("target-url"),
  btn: $("audit-btn"),
  status: $("status"),
  result: $("result"),
  resultSub: $("result-sub"),
  again: $("again-btn"),
  warning: $("run-warning"),
};

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function setRunning(text) {
  els.btn.classList.add("hidden");
  els.result.classList.add("hidden");
  els.warning.classList.remove("hidden");
  els.status.classList.remove("hidden");
  els.status.innerHTML = `<span class="spinner"></span>${escapeHtml(text)}`;
}
function setError(message) {
  els.btn.classList.remove("hidden");
  els.warning.classList.add("hidden");
  els.status.classList.remove("hidden");
  els.status.innerHTML = `<span class="err">Audit failed:</span> ${escapeHtml(message)}`;
}
function setDone(filename) {
  els.btn.classList.add("hidden");
  els.warning.classList.add("hidden");
  els.status.classList.add("hidden");
  els.resultSub.textContent = filename;
  els.result.classList.remove("hidden");
}

// Bring the audited page's window to the foreground. Screenshots
// (captureVisibleTab) only reflect the live scroll, and real keyboard Tab only
// advances focus, when that window actually has system focus. This runner window
// keeps running in the background regardless (it's a window, not a popup).
async function focusTarget() {
  try {
    await chrome.windows.update(WIN_ID, { focused: true });
    await new Promise((r) => setTimeout(r, 200));
  } catch (e) {}
}

let busy = false;
async function runAudit() {
  if (busy) return;
  busy = true;
  try {
    await focusTarget();
    setRunning("Capturing page…");
    const capture = await captureTabAudit(TAB_ID, WIN_ID);
    if (els.targetUrl) els.targetUrl.textContent = capture.url || "";

    setRunning("Running accessibility checks…");
    const page = await assemblePageAuditLocal(capture);

    await focusTarget();
    const audit = await buildEvidenceAudit(capture, { page }, TAB_ID, WIN_ID, (n) => {
      setRunning(n > 0 ? `Capturing ${n} screenshot${n === 1 ? "" : "s"}…` : "Building report…");
    });

    await focusTarget();
    await runLiveChecks(audit.pages[0], TAB_ID, WIN_ID, (stage) => {
      if (stage.indexOf("keyboard") === 0) {
        const c = stage.split(":")[1];
        setRunning(c ? `Testing keyboard focus (${c})…` : "Testing keyboard focus…");
      } else {
        setRunning("Testing reflow & 200% zoom…");
      }
    });

    // buildEvidenceAudit froze audit.complianceStatus BEFORE the live checks
    // (keyboard/contrast/reflow) ran, so a live failure never flipped the top
    // badge. Re-derive it from the now-updated page rollup.
    audit.complianceStatus = audit.pages[0] && audit.pages[0].passed ? "compliant" : "not_compliant";

    setRunning("Building report…");
    const filename = await downloadReportHtml(audit);
    setDone(filename);
  } catch (err) {
    setError((err && err.message) || String(err));
  } finally {
    busy = false;
    // Bring this runner window back to the front to show the result.
    try { const w = await chrome.windows.getCurrent(); await chrome.windows.update(w.id, { focused: true }); } catch (e) {}
  }
}

els.btn.addEventListener("click", runAudit);
els.again.addEventListener("click", runAudit);

// Auto-run once the window opens (the icon click was the "audit" gesture). No
// Start button: a manual click grabs focus to the runner window, which then
// fights focusTarget() for the page — auto-start lets the target come forward
// cleanly and reach more elements in the keyboard walk.
if (TAB_ID) runAudit();
else setError("No target tab — open a page and click the WCAGpilot icon.");
