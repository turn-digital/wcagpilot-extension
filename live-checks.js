// live-checks.js — real, live-render accessibility checks the Docker collector
// could NOT do for login/VPN pages.
//
// The collector (and the /w/reflow, /w/keyboard-focus workers on a gated page)
// fall back to a STATIC guess from the captured HTML, because a true measurement
// needs a real browser rendering the page — which ZenRows can't reach behind a
// login. The extension IS that browser, on the authenticated page, so it can
// measure for real:
//
//   - Keyboard/focus (#8): focus each focusable element and read getComputedStyle
//     for a real focus indicator (outline / box-shadow / border / bg change).
//     Resolves EXTERNAL CSS, which the static HTML scan cannot.
//   - Reflow (#6, SC 1.4.10): zoom the tab to 400% (≈ the 320px CSS reflow target)
//     via chrome.tabs.setZoom and measure real horizontal overflow.
//   - Zoom (#6, SC 1.4.4): same at 200%.
//
// No chrome.debugger — chrome.tabs.setZoom needs no extra permission and shows no
// "being debugged" banner. Zoom is always restored in a finally.
//
// runLiveChecks(page) mutates page.checks in place (overrides the static verdicts
// for the keyboard + resize checks) so the downloaded report shows real results.

// ── Keyboard focus check via SCREENSHOT PIXEL DIFF ──
//
// Computed-style heuristics are unreliable: real sites show a focus ring that
// getComputedStyle does not expose (e.g. outline-style:none yet a visible ring,
// or a ring only painted under :focus-visible). The faithful test is what a user
// sees — so we screenshot the element region unfocused, focus it (forcing
// :focus-visible), screenshot again, and diff the pixels. A meaningful change =
// a visible focus indicator.
//
// In-page helpers persist the focusable list on window.__a11yF so the extension
// can re-focus a specific element by index across executeScript calls.

function _kbCollect() {
  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return !(s.visibility === "hidden" || s.display === "none" || parseFloat(s.opacity) === 0);
  }
  const sel = 'a[href],button,input,select,textarea,[tabindex],[contenteditable="true"],summary,area[href],audio[controls],video[controls]';
  const nodes = Array.prototype.slice.call(document.querySelectorAll(sel)).filter((el) => {
    if (el.disabled) return false;
    if (el.tagName === "INPUT" && el.type === "hidden") return false;
    const ti = el.getAttribute("tabindex");
    if (ti !== null && parseInt(ti, 10) < 0) return false;
    return isVisible(el);
  });
  window.__a11yF = nodes;
  return {
    total: nodes.length,
    items: nodes.map((el, i) => ({
      i,
      tag: el.tagName.toLowerCase() + (el.type ? "[type=" + el.type + "]" : ""),
      text: (el.textContent || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim().slice(0, 60),
    })),
  };
}

// Scroll the first target into view, blur everything, and measure the rects of
// the requested indices (post-scroll). The extension then screenshots this
// unfocused baseline.
function _kbPrepareBatch(indices, scrollTo) {
  const F = window.__a11yF || [];
  if (scrollTo != null && F[scrollTo]) {
    try { F[scrollTo].scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); }
    catch (e) { F[scrollTo].scrollIntoView(true); }
  }
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  const vw = innerWidth, vh = innerHeight, dpr = window.devicePixelRatio || 1;
  const rects = indices.map((i) => {
    const el = F[i];
    if (!el) return { i, missing: true };
    const r = el.getBoundingClientRect();
    const ix0 = Math.max(0, r.left), iy0 = Math.max(0, r.top);
    const ix1 = Math.min(vw, r.right), iy1 = Math.min(vh, r.bottom);
    const inter = Math.max(0, ix1 - ix0) * Math.max(0, iy1 - iy0);
    const area = Math.max(1, r.width * r.height);
    // Occlusion: is this element actually the top-painted thing at its centre?
    // Duplicate mobile/desktop nav copies are "visible" per CSS but sit behind
    // another element — testing them screenshots the wrong pixels (false fail).
    let occluded = false;
    const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2));
    const cy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
    if (inter > 0) {
      const top = document.elementFromPoint(cx, cy);
      if (top && top !== el && !el.contains(top) && !top.contains(el)) occluded = true;
    }
    return { i, rect: { x: r.left, y: r.top, w: r.width, h: r.height }, visFrac: inter / area, occluded };
  });
  return { dpr, vw, vh, rects };
}

// Focus one element by index, forcing the :focus-visible state so the ring paints.
function _kbFocus(i) {
  const F = window.__a11yF || [];
  const el = F[i];
  if (!el) return false;
  if (document.activeElement && document.activeElement !== el && document.activeElement.blur) document.activeElement.blur();
  try { el.focus({ preventScroll: true, focusVisible: true }); }
  catch (e) { try { el.focus({ preventScroll: true }); } catch (_) {} }
  return true;
}

// Crop the same padded element region out of two viewport bitmaps and count
// pixels that changed — the focus ring lives in the border band, so a padded
// crop captures it. Returns true if the region changed enough to be a visible
// focus indicator.
function _focusRegionChanged(baseBmp, focBmp, rect, dpr, vw, vh) {
  const PAD = 8; // px — focus rings sit just outside the element (outline-offset)
  const x0 = Math.max(0, Math.min(vw, rect.x) - PAD);
  const y0 = Math.max(0, Math.min(vh, rect.y) - PAD);
  const x1 = Math.min(vw, rect.x + rect.w + PAD);
  const y1 = Math.min(vh, rect.y + rect.h + PAD);
  const sx = Math.round(x0 * dpr), sy = Math.round(y0 * dpr);
  const sw = Math.round((x1 - x0) * dpr), sh = Math.round((y1 - y0) * dpr);
  if (sw < 2 || sh < 2) return false;

  const grab = (bmp) => {
    const c = new OffscreenCanvas(sw, sh);
    const ctx = c.getContext("2d");
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
    return ctx.getImageData(0, 0, sw, sh).data;
  };
  const a = grab(baseBmp), b = grab(focBmp);
  let changed = 0;
  const total = sw * sh;
  for (let p = 0; p < a.length; p += 4) {
    const d = Math.max(Math.abs(a[p] - b[p]), Math.abs(a[p + 1] - b[p + 1]), Math.abs(a[p + 2] - b[p + 2]));
    if (d > 24) changed++;
  }
  // Validated on real pages: an element with NO focus style changes ~0% of the
  // region, a visible ring changes ~0.8–14%. 0.3% cleanly separates them with a
  // wide margin (DPR-independent, so it holds at any device pixel ratio).
  return changed / total > 0.003;
}

// Drive the pixel-diff keyboard check from the extension (needs captureVisibleTab).
async function _runKeyboardPixel(tabId, windowId, onProgress) {
  const [c] = await chrome.scripting.executeScript({ target: { tabId }, func: _kbCollect });
  const meta = c && c.result;
  if (!meta || !meta.items.length) {
    return { totalFocusables: (meta && meta.total) || 0, sampled: 0, withVisibleFocus: 0, withoutVisibleFocus: 0, elements: [] };
  }

  const MAX = 24; // cap tested elements to bound capture time
  const pool = meta.items.slice(0, MAX);
  const byIndex = new Map(pool.map((it) => [it.i, it]));
  const verdict = new Map(); // i -> hasVisibleFocus (bool)
  let remaining = pool.map((it) => it.i);
  let rounds = 0;

  while (remaining.length && rounds < 60) {
    rounds++;
    const [prep] = await chrome.scripting.executeScript({ target: { tabId }, func: _kbPrepareBatch, args: [remaining, remaining[0]] });
    const m = prep && prep.result;
    if (!m) break;

    const missing = m.rects.filter((r) => r.missing).map((r) => r.i);
    const batch = m.rects.filter((r) => !r.missing && r.visFrac >= 0.5 && !r.occluded);
    // Off-screen (<50% visible after scroll) or occluded (hidden duplicate) —
    // skip rather than flag, to avoid false failures on the wrong pixels.
    const skipped = m.rects.filter((r) => !r.missing && (r.visFrac < 0.5 || r.occluded)).map((r) => r.i);

    if (!batch.length) {
      const done0 = new Set([...missing, ...skipped]);
      const before0 = remaining.length;
      remaining = remaining.filter((i) => !done0.has(i));
      if (remaining.length === before0) break;
      continue;
    }

    await _sleep(300);
    let baseShot;
    try { baseShot = await chrome.tabs.captureVisibleTab(windowId, { format: "png" }); }
    catch (e) { if (String((e && e.message) || e).indexOf("MAX_CAPTURE") !== -1) { await _sleep(1100); continue; } break; }
    let baseBmp;
    try { baseBmp = await _loadBitmap(baseShot); } catch (e) { break; }

    for (const r of batch) {
      await chrome.scripting.executeScript({ target: { tabId }, func: _kbFocus, args: [r.i] });
      await _sleep(120);
      let focShot;
      try { focShot = await chrome.tabs.captureVisibleTab(windowId, { format: "png" }); }
      catch (e) {
        if (String((e && e.message) || e).indexOf("MAX_CAPTURE") !== -1) {
          await _sleep(1100);
          try { focShot = await chrome.tabs.captureVisibleTab(windowId, { format: "png" }); } catch (_) { continue; }
        } else { continue; }
      }
      let focBmp;
      try { focBmp = await _loadBitmap(focShot); } catch (e) { continue; }
      try { verdict.set(r.i, _focusRegionChanged(baseBmp, focBmp, r.rect, m.dpr, m.vw, m.vh)); }
      catch (e) { /* skip */ }
      if (focBmp.close) focBmp.close();
      if (onProgress) onProgress(verdict.size, pool.length);
    }
    if (baseBmp.close) baseBmp.close();

    const done = new Set([...batch.map((r) => r.i), ...missing, ...skipped]);
    const before = remaining.length;
    remaining = remaining.filter((i) => !done.has(i));
    if (remaining.length === before) break;
  }

  const tested = pool.filter((it) => verdict.has(it.i));
  const withVisible = tested.filter((it) => verdict.get(it.i) === true).length;
  return {
    totalFocusables: meta.total,
    sampled: tested.length,
    skipped: pool.length - tested.length,
    withVisibleFocus: withVisible,
    withoutVisibleFocus: tested.length - withVisible,
    elements: tested.map((it) => {
      const has = verdict.get(it.i) === true;
      return {
        selector: it.tag, tag: it.tag, text: it.text,
        hasVisibleFocus: has,
        focusIndicator: has ? "visible on focus" : "none",
        issue: has ? null : "No focus change detected in the automated screenshot test. Elements relying on the browser's default focus ring can show this — verify by pressing Tab (WCAG 2.4.7).",
      };
    }),
  };
}

// ── in-page: measure horizontal overflow at the current (zoomed) layout ──
function _overflowMeasureInPage() {
  const de = document.documentElement;
  const clientWidth = de.clientWidth;
  const scrollWidth = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0);
  const overflowAmount = Math.max(0, scrollWidth - clientWidth);
  const hasHorizontalScroll = overflowAmount > 2;

  const over = [];
  const all = document.body ? Array.prototype.slice.call(document.body.querySelectorAll("*")) : [];
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    if (r.right > clientWidth + 2) {
      over.push({
        selector: el.tagName.toLowerCase() + (el.id ? "#" + el.id : el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/)[0] : ""),
        tag: el.tagName.toLowerCase(),
        overflow: Math.round(r.right - clientWidth),
      });
    }
    if (over.length >= 300) break;
  }
  over.sort((a, b) => b.overflow - a.overflow);
  return { clientWidth, scrollWidth, overflowAmount, hasHorizontalScroll, overflowElements: over.slice(0, 8) };
}

async function _measureAtZoom(tabId, factor) {
  await chrome.tabs.setZoom(tabId, factor);
  await _sleep(500); // let layout reflow at the new zoom
  const [inj] = await chrome.scripting.executeScript({ target: { tabId }, func: _overflowMeasureInPage });
  return inj && inj.result;
}

// Reflow (400% ≈ 320px CSS width) + Zoom (200%) via real page zoom. Restores zoom.
async function runReflowZoom(tabId) {
  let original = 1;
  try { original = await chrome.tabs.getZoom(tabId); } catch (e) {}
  let reflow = null, zoom = null;
  try {
    const m4 = await _measureAtZoom(tabId, 4.0);
    if (m4) {
      reflow = {
        score: m4.hasHorizontalScroll ? "fail" : "pass",
        viewportWidth: Math.round(m4.clientWidth),
        hasHorizontalScroll: m4.hasHorizontalScroll,
        overflowElements: m4.overflowElements,
        reason: m4.hasHorizontalScroll
          ? `Horizontal scrolling at 400% zoom (≈320px reflow target) — content overflows by ${m4.overflowAmount}px.`
          : "Content reflows to a single column at 400% zoom (≈320px) with no horizontal scrolling.",
      };
    }
    const m2 = await _measureAtZoom(tabId, 2.0);
    if (m2) {
      zoom = {
        score: m2.hasHorizontalScroll ? "warning" : "pass",
        textReadable: true,
        contentLoss: m2.hasHorizontalScroll,
        overlapIssues: false,
        findings: m2.hasHorizontalScroll
          ? [`Horizontal scrolling at 200% zoom — content overflows by ${m2.overflowAmount}px.`]
          : [],
        summary: m2.hasHorizontalScroll
          ? "Some content requires horizontal scrolling at 200% zoom."
          : "Content remains usable at 200% zoom with no horizontal scrolling.",
      };
    }
  } finally {
    try { await chrome.tabs.setZoom(tabId, original || 1); } catch (e) {}
  }
  return { reflow, zoom };
}

function _findCheck(page, id, num) {
  return page.checks.find((c) => c.id === id) || page.checks.find((c) => c.num === num);
}

function _applyLiveChecks(page, kb, rz) {
  const kbCheck = _findCheck(page, "keyboard", 8);
  if (kbCheck && kb && kb.sampled > 0) {
    const reliable = kb.method === "debugger"; // real keyboard Tab
    const frac = kb.sampled > 0 ? kb.withoutVisibleFocus / kb.sampled : 0;
    // Coverage = did the walk sample as much as it INTENDED to? The walk caps at
    // `cap` (=min(total,40)) by design, so measure against that, not the raw
    // total — otherwise a healthy walk that simply hit the 40-cap on a big page
    // (e.g. 40 of 65) would look "incomplete". A genuine STALL (focus lost, walk
    // quit after 1 of 30) samples far below the cap → that's the case we catch.
    // When the walk stalled, the unreached elements are UNVERIFIED, so an
    // otherwise-clean result can't be a "pass" — downgrade to "manual". A ring
    // actually found missing is a real finding and still scores warning/fail.
    const intended = kb.cap || Math.min(kb.totalFocusables || 40, 40);
    const coverage = intended > 0 ? kb.sampled / intended : 1;
    const lowCoverage = coverage < 0.8;
    const coverageNote = lowCoverage
      ? ` Only ${kb.sampled} of ${kb.totalFocusables} focusable elements were reached, so this result is inconclusive — verify the rest by pressing Tab.`
      : "";
    const summary = (reliable
      ? `Tested ${kb.sampled} of ${kb.totalFocusables} focusable element${kb.totalFocusables === 1 ? "" : "s"} by ` +
        `real keyboard Tab; ${kb.withVisibleFocus} showed a visible focus ring, ${kb.withoutVisibleFocus} did not` +
        (kb.skipped ? ` (${kb.skipped} not reached)` : "") + "."
      : `Tested ${kb.sampled} of ${kb.totalFocusables} focusable element${kb.totalFocusables === 1 ? "" : "s"} by ` +
        `screenshot; ${kb.withoutVisibleFocus} showed no focus change (verify by Tab — programmatic focus ` +
        `can miss the browser default ring)` + (kb.skipped ? `; ${kb.skipped} skipped` : "") + ".") + coverageNote;
    kbCheck.keyboardFocusData = {
      totalFocusables: kb.totalFocusables,
      withVisibleFocus: kb.withVisibleFocus,
      withoutVisibleFocus: kb.withoutVisibleFocus,
      summary,
      elements: kb.elements,
    };
    // Real keyboard Tab is reliable, so a missing ring is a genuine WCAG 2.4.7
    // fail (one is a warning to tolerate the odd measurement glitch). The
    // programmatic fallback can miss default rings, so it stays conservative
    // (manual unless focus is systemically removed). Either way, a clean result
    // only counts as "pass" when coverage was high enough to trust it.
    kbCheck.status = reliable
      ? (kb.withoutVisibleFocus >= 2 ? "fail"
          : kb.withoutVisibleFocus === 1 ? "warning"
          : lowCoverage ? "manual" : "pass")
      : (kb.withoutVisibleFocus === 0 ? (lowCoverage ? "manual" : "pass")
          : frac >= 0.5 ? "fail" : "manual");
    kbCheck.description = kbCheck.keyboardFocusData.summary;
  }

  const rzCheck = _findCheck(page, "resize", 6);
  if (rzCheck && rz && (rz.reflow || rz.zoom)) {
    rzCheck.reflowData = { reflow: rz.reflow, zoom: rz.zoom };
    const scores = [rz.reflow && rz.reflow.score, rz.zoom && rz.zoom.score];
    rzCheck.status = scores.indexOf("fail") !== -1 ? "fail" : scores.indexOf("warning") !== -1 ? "warning" : "pass";
    rzCheck.description =
      `Reflow: ${rz.reflow ? rz.reflow.reason : "n/a"} Zoom: ${rz.zoom ? rz.zoom.summary : "n/a"}`;
  }

  // Recompute page rollups after overriding statuses.
  const failed = page.checks.filter((c) => c.status === "fail").length;
  page.passed = failed === 0;
  page.issueCount = failed;
}

// ── Keyboard focus via REAL keyboard Tab (chrome.debugger) ──
//
// Programmatic focus (even focus({focusVisible:true})) does NOT paint the
// browser's default focus ring — only a real hardware Tab does. Verified on live
// sites: real Tab shows a ring on every nav link; programmatic focus shows 0%.
// So the accurate check drives real Tab keydown events via the DevTools protocol
// (Input.dispatchKeyEvent = trusted input) and diffs focused vs blurred pixels at
// the same scroll position. Needs the "debugger" permission (shows a banner).

async function _cdp(tabId, method, params) {
  return await chrome.debugger.sendCommand({ tabId }, method, params || {});
}
async function _cdpShot(tabId) {
  const r = await _cdp(tabId, "Page.captureScreenshot", { format: "png" });
  return "data:image/png;base64," + r.data;
}
async function _cdpTab(tabId, shift) {
  const base = { windowsVirtualKeyCode: 9, code: "Tab", key: "Tab", modifiers: shift ? 8 : 0 };
  await _cdp(tabId, "Input.dispatchKeyEvent", { ...base, type: "rawKeyDown" });
  await _cdp(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

// In-page: read the active element's identity, viewport rect and scroll position.
function _kbActiveInfo() {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  const r = el.getBoundingClientRect();
  const text = ((el.textContent || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "") + "").trim().slice(0, 60);
  return {
    tag: el.tagName.toLowerCase() + (el.type ? "[type=" + el.type + "]" : ""),
    text,
    r: { x: r.left, y: r.top, w: r.width, h: r.height },
    sy: Math.round(window.scrollY || window.pageYOffset || 0),
    dpr: window.devicePixelRatio || 1, vw: innerWidth, vh: innerHeight,
  };
}

// Two-pass so the real-Tab modality is never interrupted:
//   Pass 1 — an uninterrupted real Tab walk; capture each focused frame + scroll.
//   Pass 2 — re-scroll to each position with nothing focused for the baseline.
// (Blurring/refocusing mid-walk breaks Chrome's keyboard heuristic and drops the
// ring on later elements — verified — so we keep the walk pure.)
async function _runKeyboardDebugger(tabId, onProgress) {
  let total = 0;
  try { const [c] = await chrome.scripting.executeScript({ target: { tabId }, func: _kbCollect }); total = (c && c.result && c.result.total) || 0; } catch (e) {}

  await chrome.debugger.attach({ tabId }, "1.3"); // throws if DevTools already attached
  try {
    await _cdp(tabId, "Page.enable").catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId }, func: () => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); window.scrollTo(0, 0); } });
    await _sleep(150);

    const CAP = Math.min(total || 40, 40);
    const steps = [];
    const seen = new Set();

    // PASS 1 — pure real-Tab walk. Tolerate a few transient focus gaps (focus
    // momentarily on <body> or an iframe boundary) by tabbing past them instead
    // of hard-stopping the walk — a single gap was quitting the walk at ~3.
    await _cdpTab(tabId);
    await _sleep(110);
    let misses = 0;
    for (let k = 0; k < CAP + 6; k++) {
      const [inj] = await chrome.scripting.executeScript({ target: { tabId }, func: _kbActiveInfo });
      const info = inj && inj.result;
      if (!info) {
        if (++misses > 4) break; // focus truly left the page (e.g. address bar)
        await _cdpTab(tabId);
        await _sleep(95);
        continue;
      }
      misses = 0;
      // Key includes VERTICAL position (r.y): two same-type controls with the
      // same value text in the same x-column (e.g. two `input[type=checkbox]`
      // valued "on") otherwise produce identical keys → the 2nd was mistaken for
      // a wrap-around and killed the walk at step 1 (contacts/form). x + y +
      // scrollY = a unique on-page position; a true wrap still re-lands on the
      // first element at its original x/y/scroll, so real wraps are still caught.
      const key = info.tag + "|" + info.text + "|" + Math.round(info.r.x) + "," + Math.round(info.r.y) + "," + info.sy;
      if (seen.has(key)) break; // wrapped around to the start
      seen.add(key);
      steps.push({ info, frame: await _cdpShot(tabId) });
      if (onProgress) onProgress(steps.length, CAP);
      if (steps.length >= CAP) break;
      await _cdpTab(tabId);
      await _sleep(95);
    }

    // PASS 2 — baselines (same scroll, nothing focused).
    await chrome.scripting.executeScript({ target: { tabId }, func: () => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } });
    const elements = [];
    for (const s of steps) {
      await chrome.scripting.executeScript({ target: { tabId }, func: (sy) => window.scrollTo(0, sy), args: [s.info.sy] });
      await _sleep(60);
      const base = await _cdpShot(tabId);
      let has = false;
      try {
        const bf = await _loadBitmap(base), ff = await _loadBitmap(s.frame);
        has = _focusRegionChanged(bf, ff, s.info.r, s.info.dpr, s.info.vw, s.info.vh);
        if (bf.close) bf.close(); if (ff.close) ff.close();
      } catch (e) {}
      elements.push({
        selector: s.info.tag, tag: s.info.tag, text: s.info.text,
        hasVisibleFocus: has,
        focusIndicator: has ? "visible on Tab" : "none",
        issue: has ? null : "No visible focus indicator when reached by keyboard Tab (WCAG 2.4.7).",
      });
    }

    const withVisible = elements.filter((e) => e.hasVisibleFocus).length;
    return {
      method: "debugger",
      totalFocusables: total || elements.length,
      sampled: elements.length,
      cap: CAP, // the walk only ever samples up to CAP (=min(total,40)) elements
      skipped: Math.max(0, (total || 0) - elements.length),
      withVisibleFocus: withVisible,
      withoutVisibleFocus: elements.length - withVisible,
      elements,
    };
  } finally {
    try { await chrome.debugger.detach({ tabId }); } catch (e) {}
  }
}

/**
 * Run the real keyboard + reflow/zoom checks against a specific tab and merge the
 * results into page.checks (overriding the static worker verdicts).
 * @param {object} page  audit.pages[0] from buildEvidenceAudit
 * @param {number} tabId
 * @param {number} windowId
 * @param {(stage:string)=>void} [onProgress]
 */
async function runLiveChecks(page, tabId, windowId, onProgress) {
  if (!page || !Array.isArray(page.checks) || !tabId) return;

  if (onProgress) onProgress("keyboard");
  let kb = null;
  const kbProgress = (done, total) => { if (onProgress) onProgress("keyboard:" + done + "/" + total); };
  try {
    // Accurate: real keyboard Tab via chrome.debugger.
    kb = await _runKeyboardDebugger(tabId, kbProgress);
  } catch (e) {
    // Debugger unavailable (DevTools open, denied, etc.) — fall back to the
    // programmatic pixel-diff (misses default rings; scored conservatively).
    try { kb = await _runKeyboardPixel(tabId, windowId, kbProgress); } catch (_) {}
  }

  if (onProgress) onProgress("zoom");
  let rz = null;
  try { rz = await runReflowZoom(tabId); } catch (e) { /* non-fatal */ }

  _applyLiveChecks(page, kb, rz);
}
