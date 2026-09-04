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
  // Tag each candidate with its index so the real-Tab walk can record WHICH
  // candidates it actually lands on (activeElement carries the attribute). We
  // then diff reached-vs-collected to find interactive elements keyboard Tab
  // never reaches (SC 2.1.1). Removed again after the walk.
  nodes.forEach((el, i) => { try { el.setAttribute("data-a11y-kbf", String(i)); } catch (e) {} });
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

// ── in-page: live forms/labels scan (native + ARIA widget controls) ──
//
// The static /w/forms worker regex-scans the captured HTML for NATIVE controls
// only (<input>/<select>/<textarea>). Modern SPA sites (e.g. the E-veselība
// booking page) build their fields from ARIA widgets — a <button> that opens a
// date dialog, role="combobox" dropdowns, role="checkbox" toggles — so the worker
// reports "no form elements detected" even though the page is full of controls
// (the keyboard walk sees them because they're focusable). The extension IS the
// live DOM, so it can resolve each control's accessible name deterministically —
// including ARIA widgets — and give a real Name/Role/Value (WCAG 4.1.2 / 3.3.2)
// verdict where the worker is blind. This is a STRUCTURAL check (is the control
// named, and how); it does not attempt the worker's AI "is the name good" nuance.
function _scanFormsInPage() {
  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return !(s.visibility === "hidden" || s.display === "none" || parseFloat(s.opacity) === 0);
  }
  function isDisabled(el) {
    return el.disabled === true || el.getAttribute("aria-disabled") === "true";
  }
  function inAriaHidden(el) {
    for (let n = el; n; n = n.parentElement) {
      if (n.getAttribute && n.getAttribute("aria-hidden") === "true") return true;
    }
    return false;
  }
  function clean(t) { return (t || "").replace(/\s+/g, " ").trim(); }

  // Resolve the accessible name + the method used, per the ARIA name algorithm
  // (simplified, in priority order).
  function resolveName(el, isNative) {
    // 1. aria-labelledby → referenced elements' text
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const txt = clean(lb.split(/\s+/).map((id) => {
        const ref = document.getElementById(id);
        return ref ? ref.textContent : "";
      }).join(" "));
      if (txt) return { text: txt, method: "aria_labelledby", quality: "pass" };
    }
    // 2. aria-label
    const al = clean(el.getAttribute("aria-label"));
    if (al) return { text: al, method: "aria_label", quality: "pass" };
    // 3. native <label> (for= or wrapping)
    if (isNative) {
      if (el.id) {
        const forLabel = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
        if (forLabel) { const t = clean(forLabel.textContent); if (t) return { text: t, method: "label_for", quality: "pass" }; }
      }
      const wrap = el.closest("label");
      if (wrap) { const t = clean(wrap.textContent); if (t) return { text: t, method: "label_wrap", quality: "pass" }; }
    }
    // 4. title
    const title = clean(el.getAttribute("title"));
    if (title) return { text: title, method: "title_only", quality: "warning" };
    // 5. placeholder (native text-like inputs only)
    const ph = clean(el.getAttribute("placeholder"));
    if (ph) return { text: ph, method: "placeholder_only", quality: "warning" };
    // 6. element's own text (custom widgets like <div role="checkbox">Label</div>).
    //    Skip native inputs (their textContent is empty/irrelevant).
    if (!isNative) {
      const own = clean(el.textContent);
      if (own && own.length <= 120) return { text: own, method: "element_text", quality: "pass" };
    }
    return { text: "", method: "none", quality: "fail" };
  }

  const NATIVE_SEL = 'input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]),select,textarea';
  const ARIA_SEL = '[role="combobox"],[role="checkbox"],[role="radio"],[role="switch"],[role="textbox"],[role="searchbox"],[role="spinbutton"],[role="slider"],[role="listbox"],[contenteditable="true"]';

  const seen = new Set();
  const controls = [];
  function collect(el, isNative) {
    if (seen.has(el)) return;
    if (!isVisible(el) || isDisabled(el) || inAriaHidden(el)) return;
    seen.add(el);
    let type;
    if (isNative) {
      type = el.tagName.toLowerCase() === "input" ? (el.getAttribute("type") || "text") : el.tagName.toLowerCase();
    } else {
      type = el.getAttribute("role") || (el.isContentEditable ? "textbox" : "widget");
    }
    const name = resolveName(el, isNative);
    const required = el.required === true || el.getAttribute("aria-required") === "true";
    controls.push({
      el,
      type,
      name: el.getAttribute("name") || "",
      id: el.id || "",
      isNative,
      labelText: name.text,
      labelMethod: name.method,
      labelQuality: name.quality,
      required,
      outerHTML: (el.outerHTML || "").slice(0, 300),
    });
    if (controls.length >= 250) throw { _cap: true };
  }

  try {
    Array.prototype.forEach.call(document.querySelectorAll(NATIVE_SEL), (el) => collect(el, true));
    Array.prototype.forEach.call(document.querySelectorAll(ARIA_SEL), (el) => {
      if (seen.has(el)) return;
      // A combobox pattern is often a wrapper around a real <input> — count the
      // inner native control, not the wrapper, to avoid double-listing.
      if (el.querySelector(NATIVE_SEL)) return;
      collect(el, false);
    });
  } catch (e) { if (!e || !e._cap) throw e; }

  const fields = controls.map((c) => {
    let labelIssue;
    if (c.labelQuality === "fail") {
      labelIssue = "No accessible name — a screen reader announces this control with no label (WCAG 4.1.2 / 3.3.2).";
    } else if (c.labelMethod === "placeholder_only") {
      labelIssue = "Labeled only by placeholder text, which disappears once the user types. Add a persistent <label> or aria-label.";
    } else if (c.labelMethod === "title_only") {
      labelIssue = "Labeled only via the title attribute (weakly exposed, no visible label). Add a visible <label> or aria-label.";
    }
    return {
      type: c.type,
      name: c.name,
      id: c.id,
      labelText: c.labelText,
      labelMethod: c.labelMethod,
      labelQuality: c.labelQuality,
      labelIssue,
      requiredMatch: c.required ? "programmatic_only" : "neither",
      outcome: c.isNative ? undefined : "custom widget (role=" + c.type + ")",
      evidenceHtml: c.outerHTML,
    };
  });

  const failCount = fields.filter((f) => f.labelQuality === "fail").length;
  const warningCount = fields.filter((f) => f.labelQuality === "warning").length;
  const passCount = fields.filter((f) => f.labelQuality === "pass").length;
  const labelFindings = fields
    .filter((f) => f.labelIssue)
    .map((f) => ({
      field: f.name || f.id || f.type,
      issue: f.labelIssue,
      recommendation: f.labelQuality === "fail"
        ? "Associate a visible <label> (or aria-label / aria-labelledby) so the control has an accessible name."
        : "Replace the placeholder/title-only label with a persistent, visible label.",
    }));

  const bodyText = (document.body && document.body.innerText) || "";
  const hasRequiredLegend = /[*∗]\s*[-–—:=]?\s*(required|mandatory|oblig[āa]t|j[āa]aizpilda)/i.test(bodyText) ||
    /(required|oblig[āa]t)\w*\s*(fields?|lauk)/i.test(bodyText);
  const requiredCount = fields.filter((f) => f.requiredMatch !== "neither").length;
  const requiredFindings = [];
  let requiredScore = "not_applicable";
  if (requiredCount > 0) {
    requiredScore = "pass";
    if (!hasRequiredLegend && requiredCount >= 2) {
      requiredScore = "warning";
      requiredFindings.push({
        field: "(form)",
        issue: requiredCount + " required fields, but no visible “required” legend/key was found on the page.",
        recommendation: "Mark required fields clearly (e.g. an asterisk with a “* = required” key) so the requirement is visible, not just programmatic.",
      });
    }
  }

  const labelScore = failCount > 0 ? "fail" : warningCount > 0 ? "warning" : fields.length > 0 ? "pass" : "not_applicable";
  const formCount = document.querySelectorAll("form").length;

  return {
    hasForms: fields.length > 0,
    formCount,
    fieldCount: fields.length,
    fields,
    labels: { score: labelScore, passCount, warningCount, failCount, findings: labelFindings },
    requiredFields: { score: requiredScore, passCount: requiredCount, warningCount: requiredFindings.length, failCount: 0, findings: requiredFindings, hasRequiredLegend },
  };
}

// Drive the live forms scan from the extension context.
async function _runFormsLive(tabId) {
  try {
    const [inj] = await chrome.scripting.executeScript({ target: { tabId }, func: _scanFormsInPage });
    return (inj && inj.result) || null;
  } catch (e) {
    return null;
  }
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

function _applyLiveChecks(page, kb, rz, formsLive) {
  const kbCheck = _findCheck(page, "keyboard", 8);
  if (kbCheck && kb && kb.sampled > 0) {
    const reliable = kb.method === "debugger"; // real keyboard Tab
    const frac = kb.sampled > 0 ? kb.withoutVisibleFocus / kb.sampled : 0;
    // `wrapped` = the real-Tab walk looped back to its first element, so it
    // visited the page's whole keyboard tab order. `trueTotal` is retained ONLY
    // to gate the report section (keyboardFocusData.totalFocusables > 0) — we no
    // longer surface any element counts to the user. `lowCoverage` is still
    // computed to decide status: a walk that STALLED (sampled far below its
    // intended cap) can't be trusted as a clean "pass" and downgrades to
    // "manual" — but we describe that qualitatively, never as "N of M".
    const wrapped = !!kb.wrapped;
    const trueTotal = wrapped ? kb.sampled : (kb.totalFocusables || kb.sampled);
    const intended = kb.cap || Math.min(kb.totalFocusables || 40, 40);
    const coverage = wrapped ? 1 : (intended > 0 ? kb.sampled / intended : 1);
    const lowCoverage = coverage < 0.8;
    // Product decision: the keyboard finding shows the PROBLEMATIC elements, not
    // counts. The summary is therefore qualitative — it never reports how many
    // elements were tested or reached (no "40 of 63").
    const unreachable = Array.isArray(kb.unreachable) ? kb.unreachable : [];
    const hasUnreachable = unreachable.length > 0;
    const ringPart = reliable
      ? (kb.withoutVisibleFocus === 0
          ? (lowCoverage && !hasUnreachable
              ? "Every element reached by real keyboard Tab showed a visible focus indicator, but some could not be reached automatically — verify the rest by pressing Tab."
              : "Every element reached by real keyboard Tab showed a visible focus indicator.")
          : "Some elements showed no visible focus indicator when reached by real keyboard Tab (WCAG 2.4.7). They are listed below.")
      : (kb.withoutVisibleFocus === 0
          ? "No missing focus indicators were detected, but this run used a screenshot fallback rather than a real keyboard walk — verify by pressing Tab."
          : "Some elements appeared to show no focus change when focused (WCAG 2.4.7); verify by pressing Tab. They are listed below.");
    const unreachablePart = hasUnreachable
      ? " Some interactive elements were never reached during a full keyboard Tab pass, so keyboard-only users may be unable to operate them (WCAG 2.1.1). They are listed below."
      : "";
    const summary = ringPart + unreachablePart;
    kbCheck.keyboardFocusData = {
      totalFocusables: trueTotal,
      withVisibleFocus: kb.withVisibleFocus,
      withoutVisibleFocus: kb.withoutVisibleFocus,
      summary,
      elements: kb.elements,
      unreachable,
    };
    // Real keyboard Tab is reliable, so a missing ring is a genuine WCAG 2.4.7
    // fail (one is a warning to tolerate the odd measurement glitch). The
    // programmatic fallback can miss default rings, so it stays conservative
    // (manual unless focus is systemically removed). Either way, a clean result
    // only counts as "pass" when coverage was high enough to trust it. An
    // unreachable interactive element (SC 2.1.1) is a genuine finding but the
    // detection is heuristic (occlusion-filtered, wrap-gated), so it lands as a
    // WARNING rather than flipping the whole page to fail on a possible phantom.
    kbCheck.status = reliable
      ? (kb.withoutVisibleFocus >= 2 ? "fail"
          : kb.withoutVisibleFocus === 1 ? "warning"
          : hasUnreachable ? "warning"
          : lowCoverage ? "manual" : "pass")
      : (kb.withoutVisibleFocus === 0 ? (hasUnreachable ? "warning" : lowCoverage ? "manual" : "pass")
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

  // Forms (#9): the static /w/forms worker only sees NATIVE controls. When it
  // found none but the live DOM has real controls (ARIA widgets on an SPA), take
  // over with the live structural scan. When the worker DID find native forms,
  // keep its result — it carries the richer AI label-quality judgment, so we must
  // not clobber it (no regression on native-form pages).
  const formsCheck = _findCheck(page, "forms", 9);
  if (formsCheck && formsLive && formsLive.hasForms) {
    const workerHadForms = formsCheck.formsData && formsCheck.formsData.hasForms;
    if (!workerHadForms) {
      formsCheck.formsData = formsLive;
      formsCheck.status = formsLive.labels.score === "fail" ? "fail"
        : (formsLive.labels.score === "warning" || formsLive.requiredFields.score === "warning") ? "warning"
        : "pass";
      formsCheck.description =
        `${formsLive.fieldCount} form control${formsLive.fieldCount === 1 ? "" : "s"} detected via live scan (native + ARIA widgets): ` +
        `${formsLive.labels.passCount} labeled, ${formsLive.labels.warningCount} weak label, ${formsLive.labels.failCount} unlabeled.`;
    }
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
    kbf: (el.getAttribute && el.getAttribute("data-a11y-kbf")) || null,
  };
}

// In-page: scroll a collected candidate (by its __a11yF index) into view and
// report its rect + occlusion, so the extension can screenshot an interactive
// element the keyboard walk never reached (SC 2.1.1 evidence).
function _kbLocate(idx) {
  const F = window.__a11yF || [];
  const el = F[idx];
  if (!el) return null;
  try { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); }
  catch (e) { try { el.scrollIntoView(true); } catch (_) {} }
  const r = el.getBoundingClientRect();
  const vw = innerWidth, vh = innerHeight, dpr = window.devicePixelRatio || 1;
  const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2));
  const cy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
  let occluded = false;
  const top = document.elementFromPoint(cx, cy);
  if (top && top !== el && !el.contains(top) && !top.contains(el)) occluded = true;
  const onscreen = r.width >= 1 && r.height >= 1 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  return {
    tag: el.tagName.toLowerCase() + (el.type ? "[type=" + el.type + "]" : ""),
    text: (el.textContent || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim().slice(0, 60),
    r: { x: r.left, y: r.top, w: r.width, h: r.height },
    dpr, vw, vh, occluded, onscreen,
    html: (el.outerHTML || "").slice(0, 300),
  };
}

// In-page: filter the "never reached by Tab" candidate indices down to genuine
// problems. A native radio group is a SINGLE Tab stop by design — Tab lands on
// the checked (or first) radio and Arrow keys move within the group, so the
// other radios being Tab-skipped is correct, NOT a 2.1.1 failure. Drop radios
// whose same-name group is already keyboard-operable (a member was reached, or
// one is checked). (Roving-tabindex widgets — tabs/toolbars/menus — are already
// excluded upstream because their inactive items carry tabindex="-1".)
function _kbClassifyUnreachable(missIdx, reachedIdx) {
  const F = window.__a11yF || [];
  const reached = new Set((reachedIdx || []).map(String));
  const okRadioNames = new Set();
  for (let i = 0; i < F.length; i++) {
    const el = F[i];
    if (el && el.tagName === "INPUT" && el.type === "radio" && el.name && (reached.has(String(i)) || el.checked)) {
      okRadioNames.add(el.name);
    }
  }
  const keep = [];
  for (const idx of (missIdx || [])) {
    const el = F[idx];
    if (!el) continue;
    if (el.tagName === "INPUT" && el.type === "radio" && el.name && okRadioNames.has(el.name)) continue;
    keep.push(idx);
  }
  return keep;
}

// In-page: catch form controls that are SHOWN to the user (a visible <label>)
// but can NEVER receive keyboard focus — e.g. a custom checkbox whose real
// <input> is display:none/visibility:hidden while a styled span + label text is
// painted. These never enter the focusable candidate set, so the reached-vs-
// collected diff can't see them; this finds them directly by attempting focus.
// Tagged with data-a11y-unf(-lab) so the extension can screenshot the LABEL
// (the control's own box is hidden). Cleaned up in the finally block.
function _kbScanUnfocusable() {
  function visible(el) {
    let r; try { r = el.getBoundingClientRect(); } catch (e) { return false; }
    if (!r || r.width < 1 || r.height < 1) return false;
    let n = el, d = 0;
    while (n && n.nodeType === 1 && d < 40) {
      let cs; try { cs = getComputedStyle(n); } catch (e) {}
      if (cs && (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || parseFloat(cs.opacity) === 0)) return false;
      n = n.parentElement; d++;
    }
    return true;
  }
  function labelFor(el) {
    if (el.id) {
      try {
        const sel = 'label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]';
        const l = document.querySelector(sel);
        if (l) return l;
      } catch (e) {}
    }
    let n = el.parentElement, d = 0;
    while (n && d < 5) { if (n.tagName === "LABEL") return n; n = n.parentElement; d++; }
    return null;
  }
  function canFocus(el) {
    const prev = document.activeElement;
    try { el.focus({ preventScroll: true }); } catch (e) {}
    const ok = document.activeElement === el;
    try { if (el.blur) el.blur(); } catch (e) {}
    try { if (prev && prev.focus && prev !== document.body) prev.focus({ preventScroll: true }); } catch (e) {}
    return ok;
  }
  const controls = Array.prototype.slice.call(document.querySelectorAll("input:not([type=hidden]), select, textarea"));
  const out = [];
  let n = 0;
  for (const el of controls) {
    if (el.disabled) continue;
    if (canFocus(el)) continue;              // focusable (incl. accessible opacity:0) → fine
    const lab = labelFor(el);
    if (!lab || !visible(lab)) continue;      // no visible label → just hidden markup, not a shown control
    el.setAttribute("data-a11y-unf", String(n));
    lab.setAttribute("data-a11y-unf-lab", String(n));
    const type = el.getAttribute("type");
    out.push({
      i: n,
      tag: el.tagName.toLowerCase() + (type ? "[type=" + type + "]" : ""),
      text: (lab.textContent || "").trim().slice(0, 60),
      html: (el.outerHTML || "").slice(0, 300),
    });
    n++;
    if (n >= 15) break;
  }
  return out;
}

// In-page: scroll the visible label of an unfocusable control into view and
// report its rect so the extension can screenshot it.
function _kbLocateUnf(i) {
  const lab = document.querySelector('[data-a11y-unf-lab="' + i + '"]');
  if (!lab) return null;
  try { lab.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); }
  catch (e) { try { lab.scrollIntoView(true); } catch (_) {} }
  const r = lab.getBoundingClientRect();
  const vw = innerWidth, vh = innerHeight, dpr = window.devicePixelRatio || 1;
  const onscreen = r.width >= 1 && r.height >= 1 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  return { r: { x: r.left, y: r.top, w: r.width, h: r.height }, dpr, vw, vh, onscreen };
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

    const CAP = Math.min(total || 40, 40); // screenshot budget for the ring check
    const HARD = 150; // absolute walk bound; the walk keeps Tabbing past CAP (no
                      // screenshots) to map the FULL tab order for reachability
    const steps = [];
    const seen = new Set();
    const reachedAll = new Set(); // data-a11y-kbf of EVERY element Tab lands on (full order)
    let wrapped = false;   // walk looped back to its first element (whole order seen)
    let ranOffEnd = false; // focus left the page (Tabbed off the end → whole order seen)

    // PASS 1 — pure real-Tab walk. Tolerate a few transient focus gaps (focus
    // momentarily on <body> or an iframe boundary) by tabbing past them instead
    // of hard-stopping the walk — a single gap was quitting the walk at ~3.
    // Screenshots are taken only for the first CAP elements (the ring check
    // samples up to 40); the walk then KEEPS GOING with no screenshots purely to
    // record the full tab order, so unreachable-element detection works on pages
    // with far more than 40 focusables.
    await _cdpTab(tabId);
    await _sleep(110);
    let misses = 0;
    for (let k = 0; k < HARD; k++) {
      const [inj] = await chrome.scripting.executeScript({ target: { tabId }, func: _kbActiveInfo });
      const info = inj && inj.result;
      if (!info) {
        if (++misses > 4) { ranOffEnd = true; break; } // focus truly left the page (end of tab order)
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
      if (seen.has(key)) { wrapped = true; break; } // wrapped around to the start
      seen.add(key);
      if (info.kbf != null) reachedAll.add(info.kbf);
      if (steps.length < CAP) {
        steps.push({ info, frame: await _cdpShot(tabId) });
        if (onProgress) onProgress(steps.length, CAP);
      }
      await _cdpTab(tabId);
      await _sleep(steps.length >= CAP ? 45 : 95); // no paint needed once we stop screenshotting
    }

    // PASS 2 — baselines (same scroll, nothing focused).
    await chrome.scripting.executeScript({ target: { tabId }, func: () => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } });
    const elements = [];
    for (const s of steps) {
      await chrome.scripting.executeScript({ target: { tabId }, func: (sy) => window.scrollTo(0, sy), args: [s.info.sy] });
      await _sleep(60);
      const base = await _cdpShot(tabId);
      let has = false;
      let shot = null;
      try {
        const bf = await _loadBitmap(base), ff = await _loadBitmap(s.frame);
        has = _focusRegionChanged(bf, ff, s.info.r, s.info.dpr, s.info.vw, s.info.vh);
        // Only the PROBLEMATIC elements (no visible focus ring) get a cropped
        // shot — high-signal evidence of the exact control that failed, without
        // bloating the report with a thumbnail for every element tested. Crop the
        // FOCUSED frame (shows the control in its focused state) before closing it.
        if (!has) {
          try { shot = await _cropBitmap(ff, s.info.r, s.info.dpr, s.info.vw, s.info.vh); } catch (_) {}
        }
        if (bf.close) bf.close(); if (ff.close) ff.close();
      } catch (e) {}
      elements.push({
        selector: s.info.tag, tag: s.info.tag, text: s.info.text,
        hasVisibleFocus: has,
        focusIndicator: has ? "visible on Tab" : "none",
        issue: has ? null : "No visible focus indicator when reached by keyboard Tab (WCAG 2.4.7).",
        image: shot,
      });
    }

    // UNREACHABLE-ELEMENT detection (SC 2.1.1). Diff the candidates collected up
    // front (window.__a11yF, tagged with data-a11y-kbf) against `reachedAll` —
    // every element the FULL walk landed on (not just the 40 screenshotted). Only
    // trustworthy when the walk saw the WHOLE tab order: it wrapped, OR it Tabbed
    // off the end of the page. If it hit the HARD bound without either (a huge
    // page), we can't tell "unreachable" from "past where we stopped", so we skip.
    // Occluded / off-screen candidates are dropped as likely hidden duplicate nav
    // — we would rather miss one than raise a false alarm.
    const fullOrderVisited = wrapped || ranOffEnd;
    const unreachable = [];
    if (fullOrderVisited && total > 0) {
      let missIdx = [];
      for (let i = 0; i < total; i++) if (!reachedAll.has(String(i))) missIdx.push(i);
      // Drop candidates that are legitimately Tab-skipped (non-representative
      // radios in an operable group) before we spend screenshots on them.
      if (missIdx.length) {
        try {
          const [inj] = await chrome.scripting.executeScript({ target: { tabId }, func: _kbClassifyUnreachable, args: [missIdx, Array.from(reachedAll)] });
          if (inj && Array.isArray(inj.result)) missIdx = inj.result;
        } catch (e) {}
      }
      const UNREACHED_CAP = 15; // bound the extra scroll+capture work
      for (const idx of missIdx.slice(0, UNREACHED_CAP)) {
        let loc = null;
        try { const [inj] = await chrome.scripting.executeScript({ target: { tabId }, func: _kbLocate, args: [idx] }); loc = inj && inj.result; }
        catch (e) {}
        if (!loc || loc.occluded || !loc.onscreen) continue;
        await _sleep(60);
        let img = null;
        try {
          const shotUrl = await _cdpShot(tabId);
          const bmp = await _loadBitmap(shotUrl);
          img = await _cropBitmap(bmp, loc.r, loc.dpr, loc.vw, loc.vh);
          if (bmp.close) bmp.close();
        } catch (e) {}
        unreachable.push({
          tag: loc.tag, text: loc.text, evidenceHtml: loc.html, image: img,
          issue: 'This interactive element is visible and enabled but keyboard Tab never lands on it, so keyboard-only users cannot operate it (WCAG 2.1.1). Verify it is in the tab order (avoid tabindex="-1" on real controls).',
        });
      }
    }

    // Independent of tab-order coverage: catch shown-but-unfocusable form
    // controls (custom checkbox whose real <input> is display:none, etc.). This
    // is a direct focus test, so it works even if the walk hit its bound.
    try {
      const [scanInj] = await chrome.scripting.executeScript({ target: { tabId }, func: _kbScanUnfocusable });
      const unf = (scanInj && scanInj.result) || [];
      for (const u of unf) {
        if (unreachable.length >= 20) break;
        let loc = null;
        try { const [li] = await chrome.scripting.executeScript({ target: { tabId }, func: _kbLocateUnf, args: [u.i] }); loc = li && li.result; }
        catch (e) {}
        if (!loc || !loc.onscreen) continue;
        await _sleep(60);
        let img = null;
        try {
          const shotUrl = await _cdpShot(tabId);
          const bmp = await _loadBitmap(shotUrl);
          img = await _cropBitmap(bmp, loc.r, loc.dpr, loc.vw, loc.vh);
          if (bmp.close) bmp.close();
        } catch (e) {}
        unreachable.push({
          tag: u.tag, text: u.text, evidenceHtml: u.html, image: img,
          issue: "This form control is shown on the page (it has a visible label) but keyboard focus can never land on it, so keyboard-only users cannot operate it (WCAG 2.1.1). The real control is likely hidden with display:none / visibility:hidden while a styled element is shown — hide it with clip/opacity instead so it stays focusable, or make the visible element the real control.",
        });
      }
    } catch (e) {}

    const withVisible = elements.filter((e) => e.hasVisibleFocus).length;
    return {
      method: "debugger",
      totalFocusables: total || elements.length,
      sampled: elements.length,
      cap: CAP, // the walk only ever samples up to CAP (=min(total,40)) elements
      wrapped, // true = the walk looped back to the start → visited the whole tab order
      skipped: Math.max(0, (total || 0) - elements.length),
      withVisibleFocus: withVisible,
      withoutVisibleFocus: elements.length - withVisible,
      elements,
      unreachable,
    };
  } finally {
    try { await chrome.scripting.executeScript({ target: { tabId }, func: () => { ["data-a11y-kbf", "data-a11y-unf", "data-a11y-unf-lab"].forEach(function (a) { var ns = document.querySelectorAll("[" + a + "]"); for (var i = 0; i < ns.length; i++) ns[i].removeAttribute(a); }); } }); } catch (e) {}
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

  if (onProgress) onProgress("forms");
  let formsLive = null;
  try { formsLive = await _runFormsLive(tabId); } catch (e) { /* non-fatal */ }

  _applyLiveChecks(page, kb, rz, formsLive);
}
