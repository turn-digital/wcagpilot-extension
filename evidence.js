// evidence.js — element-level screenshots for audit findings.
//
// After the orchestrator returns the 13-check result for the active tab, this
// module captures a small cropped screenshot of each contrast-failing element and
// each flagged image, so the offline HTML report shows *where* the problem is —
// not just a selector.
//
// How it works (all local, no ZenRows / server fetch):
//   - Contrast findings: we scan the live page ourselves (computed-style WCAG
//     sweep, `_scanContrastInPage`) — this replaces axe. Solid-background failures
//     are computed directly; text sitting on a background image/gradient is
//     resolved by sampling the real pixels of its screenshot (`_sampleBgFromCrop`),
//     which is the only way to catch text-over-image (axe punts on it).
//   - Alt-text findings: the worker's LLM check returns flaggedImages[].src; we
//     match those back to live <img> elements on the page.
//   - For each target we scrollIntoView -> chrome.tabs.captureVisibleTab -> crop
//     the viewport PNG to the element's rect (scaled by devicePixelRatio) with an
//     OffscreenCanvas. Targets already on screen share one capture (batching keeps
//     us well under captureVisibleTab's rate limit).
//
// Exposes (classic script, shared global scope):
//   buildEvidenceAudit(capture, workerResult, onProgress?) -> audit object for renderReportHtml()

// ── in-page contrast scanner (computed-style WCAG sweep — replaces axe) ──
// Serialized into the tab, so it must be fully self-contained. Walks every
// visible text-bearing element, resolves the effective background by compositing
// ancestor background-colors over white, and computes the WCAG contrast ratio.
// Returns only the FAILING elements: solid-background failures directly, plus
// every text-over-image/gradient element (bgMode:"image") — those get a real
// ratio later from pixel-sampling their screenshot.
function _scanContrastInPage() {
  function lin(c) { c = c / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function lum(r, g, b) { return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); }
  function ratio(fg, bg) {
    var l1 = lum(fg[0], fg[1], fg[2]), l2 = lum(bg[0], bg[1], bg[2]);
    var hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }
  function parseColor(s) {
    if (!s) return null;
    var m = s.match(/rgba?\(([^)]+)\)/i);
    if (!m) return null;
    var p = m[1].split(",").map(function (x) { return parseFloat(x); });
    return [p[0] || 0, p[1] || 0, p[2] || 0, p.length > 3 ? (isNaN(p[3]) ? 1 : p[3]) : 1];
  }
  function over(src, dst) { // composite rgba src over opaque rgb dst -> rgb
    var a = src[3];
    return [src[0] * a + dst[0] * (1 - a), src[1] * a + dst[1] * (1 - a), src[2] * a + dst[2] * (1 - a)];
  }
  function toHex(rgb) {
    return "#" + rgb.map(function (v) {
      var h = Math.max(0, Math.min(255, Math.round(v))).toString(16);
      return h.length === 1 ? "0" + h : h;
    }).join("");
  }
  function effectiveBg(el) {
    var layers = [], hasImage = false, node = el;
    while (node && node.nodeType === 1) {
      var cs = getComputedStyle(node);
      if (cs.backgroundImage && cs.backgroundImage !== "none") hasImage = true;
      var bc = parseColor(cs.backgroundColor);
      if (bc && bc[3] > 0) { layers.push(bc); if (bc[3] >= 1) break; }
      node = node.parentElement;
    }
    var base = [255, 255, 255];
    for (var i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return { rgb: base, hasImage: hasImage };
  }
  function cssPath(el) {
    if (el.id) return "#" + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
    var parts = [], node = el, hops = 0;
    while (node && node.nodeType === 1 && hops < 6) {
      var idx = 1, sib = node;
      while ((sib = sib.previousElementSibling)) { if (sib.tagName === node.tagName) idx++; }
      parts.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + idx + ")");
      node = node.parentElement; hops++;
    }
    return parts.join(" > ");
  }

  var out = [];
  var all = document.body ? document.body.querySelectorAll("*") : [];
  for (var i = 0; i < all.length && out.length < 250; i++) {
    var el = all[i];
    var tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "svg") continue;
    if (el.disabled) continue;
    var hasText = false, txt = "";
    for (var c = 0; c < el.childNodes.length; c++) {
      var n = el.childNodes[c];
      if (n.nodeType === 3 && n.textContent.trim().length) { hasText = true; txt += n.textContent; }
    }
    if (!hasText) continue;
    var cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) continue;
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    var fg4 = parseColor(cs.color) || [0, 0, 0, 1];
    var bgInfo = effectiveBg(el);
    var fg = over(fg4, bgInfo.rgb);
    var size = parseFloat(cs.fontSize) || 16;
    var weight = parseInt(cs.fontWeight, 10) || 400;
    var large = size >= 24 || (size >= 18.66 && weight >= 700);
    var required = large ? 3.0 : 4.5;
    var cr = bgInfo.hasImage ? null : ratio(fg, bgInfo.rgb);
    // Solid bg: keep only failures. Image/gradient bg: always keep for sampling.
    if (!bgInfo.hasImage && cr >= required) continue;
    out.push({
      selector: cssPath(el),
      html: (el.outerHTML || "").slice(0, 300),
      text: txt.trim().slice(0, 80),
      fg: fg.map(Math.round),
      fgHex: toHex(fg),
      bg: bgInfo.hasImage ? null : bgInfo.rgb.map(Math.round),
      bgHex: bgInfo.hasImage ? null : toHex(bgInfo.rgb),
      ratio: cr == null ? null : Math.round(cr * 100) / 100,
      bgMode: bgInfo.hasImage ? "image" : "solid",
      fontSize: Math.round(size),
      weight: weight,
      large: large,
      required: required,
    });
  }
  return out;
}

// ── contrast math + pixel sampling (extension context) ──
function _lin255(c) { c = c / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function _lumRgb(r, g, b) { return 0.2126 * _lin255(r) + 0.7152 * _lin255(g) + 0.0722 * _lin255(b); }
function _ratioRgb(fg, bg) {
  const l1 = _lumRgb(fg[0], fg[1], fg[2]), l2 = _lumRgb(bg[0], bg[1], bg[2]);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}
function _rgbHex(rgb) {
  return "#" + rgb.map((v) => {
    const h = Math.max(0, Math.min(255, Math.round(v))).toString(16);
    return h.length === 1 ? "0" + h : h;
  }).join("");
}

// For text over an image/gradient: read the element's screenshot crop, drop
// glyph-colored pixels (near the known foreground), and take the median-luminance
// remaining pixel as the effective background. Returns an [r,g,b] or null.
async function _sampleBgFromCrop(dataUrl, fg) {
  try {
    const bmp = await _loadBitmap(dataUrl);
    const w = bmp.width, h = bmp.height;
    if (!w || !h) { if (bmp.close) bmp.close(); return null; }
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    if (bmp.close) bmp.close();
    const bg = [];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 200) continue; // skip transparent
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (Math.abs(r - fg[0]) + Math.abs(g - fg[1]) + Math.abs(b - fg[2]) < 100) continue; // glyph pixel
      bg.push([r, g, b]);
    }
    if (bg.length < 12) return null;
    bg.sort((a, b2) => _lumRgb(a[0], a[1], a[2]) - _lumRgb(b2[0], b2[1], b2[2]));
    return bg[Math.floor(bg.length / 2)];
  } catch (e) { return null; }
}

// One-line human summary for a contrast finding (grouped).
function _contrastSummary(g) {
  const parts = [];
  if (g.ratio != null) parts.push("Contrast " + g.ratio.toFixed(2) + ":1 (needs " + g.required + ":1)");
  else parts.push("Text over image — contrast not auto-measured (needs " + g.required + ":1)");
  parts.push(g.fontSize + "px" + (g.weight >= 700 ? " bold" : "") + (g.large ? " · large text" : ""));
  if (g.count > 1) parts.push(g.count + " elements");
  return parts.join(" · ");
}

// ── in-page: scroll to the first target, measure all targets' viewport rects ──
// Serialized into the tab. Returns { dpr, vw, vh, items:[{key, missing?|rect,visFrac,isTarget}] }.
function _measureTargetsInPage(items) {
  const dpr = window.devicePixelRatio || 1;
  const vw = window.innerWidth, vh = window.innerHeight;
  const norm = (s) => { try { return new URL(s, location.href).href; } catch (e) { return s || ""; } };

  function resolve(it) {
    if (it.selector) {
      try { return document.querySelector(it.selector); } catch (e) { return null; }
    }
    if (it.imgSrc) {
      const want = norm(it.imgSrc);
      const imgs = Array.prototype.slice.call(document.images);
      return (
        imgs.find((im) => norm(im.currentSrc || im.src) === want) ||
        imgs.find((im) => { const a = im.getAttribute("src"); return a && want.endsWith(a); }) ||
        null
      );
    }
    return null;
  }

  // Bring the first resolvable, not-yet-captured target into view so at least one
  // finding is shootable this round. behavior:instant defeats scroll-behavior:smooth.
  let targetKey = null;
  for (const it of items) {
    const el = resolve(it);
    if (el) {
      try { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); }
      catch (e) { el.scrollIntoView(true); }
      targetKey = it.key;
      break;
    }
  }

  const out = [];
  for (const it of items) {
    const el = resolve(it);
    if (!el) { out.push({ key: it.key, missing: true }); continue; }
    const r = el.getBoundingClientRect();
    const ix0 = Math.max(0, r.left), iy0 = Math.max(0, r.top);
    const ix1 = Math.min(vw, r.right), iy1 = Math.min(vh, r.bottom);
    const interArea = Math.max(0, ix1 - ix0) * Math.max(0, iy1 - iy0);
    const area = Math.max(1, r.width * r.height);
    out.push({
      key: it.key,
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      visFrac: interArea / area,
      isTarget: it.key === targetKey,
    });
  }
  return { dpr, vw, vh, items: out };
}

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function _loadBitmap(dataUrl) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  return await createImageBitmap(blob);
}

function _blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

// Crop the viewport bitmap to an element rect (+ a little context), scaled by DPR.
async function _cropBitmap(bitmap, rect, dpr, vw, vh) {
  const PAD = 6; // px of surrounding context
  const x0 = Math.max(0, Math.min(vw, rect.x) - PAD);
  const y0 = Math.max(0, Math.min(vh, rect.y) - PAD);
  const x1 = Math.min(vw, rect.x + rect.w + PAD);
  const y1 = Math.min(vh, rect.y + rect.h + PAD);
  const sx = Math.round(x0 * dpr), sy = Math.round(y0 * dpr);
  const sw = Math.round((x1 - x0) * dpr), sh = Math.round((y1 - y0) * dpr);
  if (sw < 1 || sh < 1) return null;
  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.82 });
  return await _blobToDataUrl(blob);
}

// Grab the visible viewport. Prefers CDP Page.captureScreenshot (focus-independent
// — works even when the audited window is backgrounded), falling back to
// captureVisibleTab if the debugger isn't attached.
async function _viewportShot(tabId, windowId, cdpAttached) {
  if (cdpAttached) {
    const r = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", { format: "png" });
    return "data:image/png;base64," + r.data;
  }
  return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
}

// Capture crops for a list of targets ({key, selector?|imgSrc?}). Returns { key: dataUrl }.
async function captureEvidenceCrops(targets, tabId, windowId) {
  const crops = {};
  if (!targets || !targets.length || !tabId) return crops;

  // Attach the debugger so screenshots come from CDP (focus-independent). If the
  // debugger can't attach (DevTools open, denied), fall back to captureVisibleTab.
  let cdpAttached = false;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    cdpAttached = true;
    await chrome.debugger.sendCommand({ tabId }, "Page.enable").catch(() => {});
  } catch (e) {}
  try {

  let remaining = targets.slice();
  let rounds = 0;
  while (remaining.length && rounds < 80) {
    rounds++;
    const items = remaining.map((t) => ({ key: t.key, selector: t.selector, imgSrc: t.imgSrc }));

    let measure = null;
    try {
      const [inj] = await chrome.scripting.executeScript({
        target: { tabId },
        func: _measureTargetsInPage,
        args: [items],
      });
      measure = inj && inj.result;
    } catch (e) { break; }
    if (!measure) break;

    // Drop targets that no longer exist on the page.
    const missing = new Set(measure.items.filter((m) => m.missing).map((m) => m.key));
    remaining = remaining.filter((t) => !missing.has(t.key));
    if (!remaining.length) break;

    // Let the scroll + paint settle, then grab ONE viewport screenshot.
    await _sleep(350);
    let shot;
    try {
      shot = await _viewportShot(tabId, windowId, cdpAttached);
    } catch (e) {
      if (String((e && e.message) || e).indexOf("MAX_CAPTURE") !== -1) { await _sleep(1100); continue; }
      break;
    }
    let bitmap;
    try { bitmap = await _loadBitmap(shot); } catch (e) { break; }

    // Crop every target that is >=50% visible, plus the scroll target (clamped).
    const captured = [];
    for (const m of measure.items) {
      if (m.missing) continue;
      if (!(m.visFrac >= 0.5 || m.isTarget)) continue;
      try {
        const crop = await _cropBitmap(bitmap, m.rect, measure.dpr, measure.vw, measure.vh);
        if (crop) crops[m.key] = crop;
      } catch (e) { /* non-fatal: skip this crop */ }
      captured.push(m.key); // mark done regardless, to guarantee forward progress
    }
    if (bitmap.close) bitmap.close();

    const done = new Set(captured);
    const before = remaining.length;
    remaining = remaining.filter((t) => !done.has(t.key));
    if (remaining.length === before) break; // nothing captured this round — stop
  }

  } finally {
    if (cdpAttached) { try { await chrome.debugger.detach({ tabId }); } catch (e) {} }
  }
  return crops;
}

// ── Direct image-asset fallback ──────────────────────────────────────────────
// The screenshot path only captures images that are a visible, on-screen <img>.
// Many flagged images can't be shot that way: hidden theme-variant logos
// (display:none), lazy/off-screen images, or cross-origin widget images. For
// those we fetch the image resource by URL *in the page context* (so same-origin
// requests just work) and embed the raw asset. This is independent of layout,
// scroll and visibility, so it recovers most of the misses.
//
// Runs in the page: takes [{key, src}], returns { key: dataUrl }. Cross-origin
// fetches still obey CORS and fail gracefully (skipped, not fatal).
async function _fetchImageAssetsInPage(items) {
  async function one(src) {
    try {
      const res = await fetch(src, { cache: "force-cache" });
      if (!res.ok) return null;
      const blob = await res.blob();
      // Skip oversized assets and obvious non-images (e.g. an HTML error page).
      if (!blob || blob.size > 2000000) return null;
      if (blob.type && !/^image\//.test(blob.type)) return null;
      return await new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => resolve(null);
        fr.readAsDataURL(blob);
      });
    } catch (e) { return null; }
  }
  const out = {};
  await Promise.all(items.map(async (it) => { const d = await one(it.src); if (d) out[it.key] = d; }));
  return out;
}

// Fetch raw assets for targets that have a src. Returns { key: dataUrl }.
async function fetchImageAssets(targets, tabId) {
  const items = targets.filter((t) => t.imgSrc).map((t) => ({ key: t.key, src: t.imgSrc }));
  if (!items.length || !tabId) return {};
  try {
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId },
      func: _fetchImageAssetsInPage,
      args: [items],
    });
    return (inj && inj.result) || {};
  } catch (e) { return {}; }
}

// Wrap the worker's page result into the audit shape renderReportHtml() expects.
function _wrapAudit(capture, page) {
  let domain = "";
  try { domain = new URL((page && page.url) || capture.url).hostname; } catch (e) {}
  return {
    url: (page && page.url) || capture.url,
    domain,
    methodName: "Extension audit (in-page capture)",
    complianceStatus: page && page.passed ? "compliant" : "not_compliant",
    pagesCount: 1,
    pages: page ? [page] : [],
    completedAt: capture.capturedAt || null,
  };
}

// ── in-page: locate flagged form fields by name/id and return outerHTML + rect ──
function _locateFormFieldsInPage(items) {
  function vis(el) {
    var cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    var r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }
  function cssPath(el) {
    if (el.id) return "#" + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
    var parts = [], node = el, hops = 0;
    while (node && node.nodeType === 1 && hops < 6) {
      var idx = 1, sib = node;
      while ((sib = sib.previousElementSibling)) { if (sib.tagName === node.tagName) idx++; }
      parts.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + idx + ")");
      node = node.parentElement; hops++;
    }
    return parts.join(" > ");
  }
  return items.map(function (it) {
    var el = null;
    if (it.id) { try { el = document.getElementById(it.id); } catch (e) {} }
    if (!el && it.name) { try { el = document.querySelector('[name="' + it.name.replace(/"/g, '\\"') + '"]'); } catch (e) {} }
    if (!el) return { key: it.key, html: "", visible: false, selector: "" };
    return { key: it.key, html: (el.outerHTML || "").slice(0, 400), visible: vis(el), selector: cssPath(el) };
  });
}

/**
 * Enrich the worker audit with local contrast detail + element screenshots and
 * return an audit object ready for renderReportHtml().
 * @param {object} capture       from captureTabAudit() (has .url, .capturedAt)
 * @param {object} workerResult  { page } from assemblePageAuditLocal()
 * @param {number} tabId
 * @param {number} windowId
 * @param {(n:number)=>void} [onProgress]  called with the number of screenshots to take
 */
async function buildEvidenceAudit(capture, workerResult, tabId, windowId, onProgress) {
  const page = workerResult && workerResult.page;
  if (!page || !Array.isArray(page.checks)) return _wrapAudit(capture, page);

  // 1. Contrast: scan the live page ourselves (replaces axe). Failing solid-bg
  //    elements resolve immediately; text-over-image elements are finalized after
  //    their screenshots are captured (step 3b, pixel-sampling).
  let contrastEls = [], contrastScanOk = true;
  try {
    const [inj] = await chrome.scripting.executeScript({ target: { tabId }, func: _scanContrastInPage });
    contrastEls = (inj && inj.result) || [];
  } catch (e) { contrastScanOk = false; }
  const contrastCheck = page.checks.find((c) => c.id === "contrast");

  // Group identical solid failures (same fg/bg/size class) so the report stays
  // readable; image-bg elements stay individual (each samples its own bg).
  const cGroups = [];
  const cIndex = {};
  contrastEls.forEach((el) => {
    if (el.bgMode === "image") { cGroups.push(Object.assign({}, el, { count: 1, _image: true })); return; }
    const key = el.fgHex + "|" + el.bgHex + "|" + (el.large ? "L" : "S");
    if (cIndex[key] != null) { cGroups[cIndex[key]].count++; return; }
    cIndex[key] = cGroups.length;
    cGroups.push(Object.assign({}, el, { count: 1 }));
  });

  // 2. Gather screenshot targets (one per contrast group).
  const targets = [];
  cGroups.forEach((g, i) => {
    g._key = "c" + i;
    targets.push({ key: g._key, selector: g.selector, _ref: g });
  });
  const altCheck = page.checks.find((c) => c.id === "alt-text" || c.id === "alt-text-v2");
  const flagged = (altCheck && altCheck.altTextData && altCheck.altTextData.flaggedImages) || [];
  flagged.forEach((img, i) => {
    if (img && img.src) targets.push({ key: "a" + i, imgSrc: img.src, _ref: img });
  });

  // 2b. Forms: locate each flagged field (fail/warning) in-page → outerHTML
  //     snippet always + a screenshot when the field is actually visible.
  const formsCheck = page.checks.find((c) => c.id === "forms");
  const formFields = (formsCheck && formsCheck.formsData && Array.isArray(formsCheck.formsData.fields))
    ? formsCheck.formsData.fields.filter((f) => f.labelQuality === "fail" || f.labelQuality === "warning")
    : [];
  if (formFields.length) {
    const items = formFields.map((f, i) => ({ key: "f" + i, name: f.name || "", id: f.id || "", type: f.type || "" }));
    let located = [];
    try {
      const [inj] = await chrome.scripting.executeScript({ target: { tabId }, func: _locateFormFieldsInPage, args: [items] });
      located = (inj && inj.result) || [];
    } catch (e) {}
    located.forEach((loc, i) => {
      const f = formFields[i];
      if (!f || !loc) return;
      if (loc.html) f.evidenceHtml = loc.html;
      if (loc.visible && loc.selector) targets.push({ key: loc.key, selector: loc.selector, _ref: f });
    });
  }

  if (onProgress) onProgress(targets.length);

  // 3. Capture and attach.
  if (targets.length) {
    const crops = await captureEvidenceCrops(targets, tabId, windowId);
    targets.forEach((t) => { if (crops[t.key]) t._ref.image = crops[t.key]; });

    // Fallback: any flagged image that didn't get an in-page screenshot (hidden
    // variant logos, off-screen/lazy, occluded) — fetch the raw asset by URL and
    // embed it, so the report shows the actual image even when it can't be shot.
    const need = targets.filter((t) => t.imgSrc && !t._ref.image);
    if (need.length) {
      const assets = await fetchImageAssets(need, tabId);
      need.forEach((t) => { if (assets[t.key]) t._ref.image = assets[t.key]; });
    }
  }

  // 3b. Finalize contrast: pixel-sample text-over-image groups from their crops,
  //     then roll up the check status and build the report detail.
  for (const g of cGroups) {
    if (!g._image || !g.image) continue;
    const sampled = await _sampleBgFromCrop(g.image, g.fg);
    if (sampled) { g.bg = sampled; g.bgHex = _rgbHex(sampled); g.ratio = Math.round(_ratioRgb(g.fg, sampled) * 100) / 100; }
  }

  if (contrastCheck) {
    const hardFails = cGroups.filter((g) => g.ratio != null && g.ratio < g.required);
    const unknowns = cGroups.filter((g) => g._image && g.ratio == null); // over image, unsampleable
    const reported = hardFails.concat(unknowns);
    const issueCount = hardFails.reduce((s, g) => s + g.count, 0);

    if (hardFails.length) {
      contrastCheck.status = "fail";
      contrastCheck.description = issueCount + (issueCount === 1 ? " element" : " elements") + " with insufficient contrast";
    } else if (unknowns.length) {
      contrastCheck.status = "manual";
      contrastCheck.description = "Text over an image/gradient couldn't be measured automatically — verify its contrast manually.";
    } else if (contrastScanOk) {
      contrastCheck.status = "pass";
      contrastCheck.description = "All text has sufficient contrast (WCAG AA).";
    } else {
      contrastCheck.status = "manual";
      contrastCheck.description = "Contrast could not be scanned on this page.";
    }

    if (reported.length) {
      contrastCheck.contrastData = {
        totalIssues: issueCount,
        elements: reported.map((g) => ({
          summary: _contrastSummary(g),
          selector: g.selector,
          html: g.html,
          image: g.image || undefined,
          fgHex: g.fgHex,
          bgHex: g.bgHex || undefined,
          ratio: g.ratio,
          required: g.required,
          large: g.large,
          count: g.count,
          overImage: g.bgMode === "image",
        })),
      };
    }
  }

  return _wrapAudit(capture, page);
}
