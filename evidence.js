// evidence.js — element-level screenshots for audit findings.
//
// After the orchestrator returns the 13-check result for the active tab, this
// module captures a small cropped screenshot of each contrast-failing element and
// each flagged image, so the offline HTML report shows *where* the problem is —
// not just a selector.
//
// How it works (all local, no ZenRows / server fetch):
//   - Contrast findings: axe already ran in-page (capture.axe). We rebuild the
//     flat contrast element list (mirrors the collector's assemble.buildContrastData)
//     and use each node's CSS selector to locate the element.
//   - Alt-text findings: the worker's LLM check returns flaggedImages[].src; we
//     match those back to live <img> elements on the page.
//   - For each target we scrollIntoView -> chrome.tabs.captureVisibleTab -> crop
//     the viewport PNG to the element's rect (scaled by devicePixelRatio) with an
//     OffscreenCanvas. Targets already on screen share one capture (batching keeps
//     us well under captureVisibleTab's rate limit).
//
// Exposes (classic script, shared global scope):
//   buildEvidenceAudit(capture, workerResult, onProgress?) -> audit object for renderReportHtml()

// ── contrast list from axe (mirrors vpn-audit-collector/src/assemble.buildContrastData) ──
// Adds a private `_query` selector used only to locate the element for the shot.
function _buildContrastDataFromAxe(axe) {
  const elements = [];
  const violations = (axe && axe.violations) || [];
  for (const v of violations) {
    if (v.id !== "color-contrast") continue;
    for (const node of v.nodes || []) {
      const cc = (node.any || []).find((c) => c.id === "color-contrast") || (node.any || [])[0];
      const data = (cc && cc.data) || {};
      const parts = [];
      if (data.contrastRatio != null) {
        parts.push(
          "Contrast " + Number(data.contrastRatio).toFixed(2) + ":1" +
          (data.expectedContrastRatio ? " (needs " + data.expectedContrastRatio + ")" : "")
        );
      }
      if (data.fgColor && data.bgColor) parts.push("text " + data.fgColor + " on " + data.bgColor);
      if (data.fontSize) {
        parts.push(data.fontSize + (data.fontWeight && data.fontWeight !== "normal" ? " " + data.fontWeight : ""));
      }
      const summary = parts.join(" · ") || (cc && cc.message) || node.failureSummary || "Insufficient contrast";
      const targetArr = Array.isArray(node.target) ? node.target : [node.target];
      const clean = targetArr.filter(Boolean).map(String);
      elements.push({
        summary,
        selector: clean.join(" "),
        html: node.html || "",
        // Deepest selector segment — the one that resolves in this document
        // (multi-segment targets only occur across iframe/shadow boundaries).
        _query: clean.length ? clean[clean.length - 1] : "",
      });
    }
  }
  return { totalIssues: elements.length, elements };
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

// Capture crops for a list of targets ({key, selector?|imgSrc?}). Returns { key: dataUrl }.
async function captureEvidenceCrops(targets, tabId, windowId) {
  const crops = {};
  if (!targets || !targets.length || !tabId) return crops;

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
      shot = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
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
  return crops;
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

/**
 * Enrich the worker audit with local contrast detail + element screenshots and
 * return an audit object ready for renderReportHtml().
 * @param {object} capture       from captureTabAudit() (has .axe, .url, .capturedAt)
 * @param {object} workerResult  { page } from assemblePageAuditLocal()
 * @param {number} tabId
 * @param {number} windowId
 * @param {(n:number)=>void} [onProgress]  called with the number of screenshots to take
 */
async function buildEvidenceAudit(capture, workerResult, tabId, windowId, onProgress) {
  const page = workerResult && workerResult.page;
  if (!page || !Array.isArray(page.checks)) return _wrapAudit(capture, page);

  // 1. Contrast detail is computed here (the orchestrator returns status only).
  const contrastData = _buildContrastDataFromAxe(capture.axe || {});
  const contrastCheck = page.checks.find((c) => c.id === "contrast");
  if (contrastCheck && contrastData.totalIssues > 0) {
    contrastCheck.contrastData = { totalIssues: contrastData.totalIssues, elements: contrastData.elements };
  }

  // 2. Gather screenshot targets.
  const targets = [];
  contrastData.elements.forEach((el, i) => {
    if (el._query) targets.push({ key: "c" + i, selector: el._query, _ref: el });
  });
  const altCheck = page.checks.find((c) => c.id === "alt-text" || c.id === "alt-text-v2");
  const flagged = (altCheck && altCheck.altTextData && altCheck.altTextData.flaggedImages) || [];
  flagged.forEach((img, i) => {
    if (img && img.src) targets.push({ key: "a" + i, imgSrc: img.src, _ref: img });
  });

  if (onProgress) onProgress(targets.length);

  // 3. Capture and attach.
  if (targets.length) {
    const crops = await captureEvidenceCrops(targets, tabId, windowId);
    targets.forEach((t) => { if (crops[t.key]) t._ref.image = crops[t.key]; });
  }

  // 4. Strip internal fields before rendering.
  contrastData.elements.forEach((el) => { delete el._query; });

  return _wrapAudit(capture, page);
}
