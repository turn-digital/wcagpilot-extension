// render-report.js — browser port of vpn-audit-collector/src/renderReport.js.
//
// Renders an audit (from buildEvidenceAudit) as a standalone HTML file identical
// to the web app's audit report, with element screenshots inlined for contrast
// and alt-text findings. Differences from the Node original:
//   - CSS is fetched from the packaged extension (vendor/styles/*), not read via fs.
//   - No ESM export — exposes renderReportHtml() + downloadReportHtml() globally.
//   - Contrast/alt items render an evidence <img> when a crop was captured.
//
// KEEP IN SYNC with renderReport.js / the web components if their markup changes.

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// Escape an HTML snippet for display, first stripping the instrumentation
// attributes the keyboard walk injects onto elements (data-a11y-kbf / -unf /
// -unf-lab). Those are captured into outerHTML before the page is cleaned up,
// so they'd otherwise leak into the evidence snippets shown to the user.
const escSnippet = (s) =>
  esc(String(s == null ? "" : s).replace(/\s*data-a11y-(?:kbf|unf-lab|unf)="[^"]*"/g, ""));

const HEADING_CHECK_NAMES = {
  presence: "Heading presence", h1_first: "H1 heading", hierarchy: "Hierarchy order",
  empty_headings: "Empty headings", visual_headings: "Visual headings",
  content_match: "Content match", logical_structure: "Logical structure",
};
const LABEL_METHOD_NAMES = {
  label_for: "label[for]", label_wrap: "wrapping <label>", aria_label: "aria-label",
  aria_labelledby: "aria-labelledby", placeholder_only: "placeholder only",
  title_only: "title only", element_text: "element text", none: "no label",
};
const REQUIRED_MATCH_NAMES = {
  both: "required (visual + programmatic)", visual_only: "required: visual only",
  programmatic_only: "required: programmatic only", neither: "",
};
const ALT_TEXT_IDS = ["alt-text", "alt-text-v2"];

const CHEVRON = `<svg class="criterion-toggle" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`;
const chevron = (cls) => CHEVRON.replace("criterion-toggle", cls);

// Evidence screenshot markup (only when a crop was captured).
const shot = (dataUrl, cls) =>
  dataUrl ? `<img class="evidence-shot${cls ? " " + cls : ""}" src="${esc(dataUrl)}" alt="" loading="lazy">` : "";

function statusText(s) {
  return s === "pass" ? "Passed" : s === "fail" ? "Failed" : s === "warning" ? "Warning" : s === "manual" ? "Manual" : "N/A";
}

const sevRank = (s) => (s === "fail" || s === "bad" ? 0 : s === "warning" ? 1 : 2);
const bySeverity = (arr) => arr.slice().sort((a, b) => sevRank(a.status) - sevRank(b.status));

// Derive a human-readable name for an image so the report says WHICH image is
// wrong instead of dumping a URL tail. Image CDNs/optimizers wrap the real file
// in a query param (Next.js `/_next/image?url=...&w=640&q=75`, Vercel, Cloudflare
// `/cdn-cgi/image/...`), so the naive URL tail is just optimizer noise like
// "...LDVC_Pilnais_Balts.0p5h1ifv7fmgp.png&w=640&q=75". Unwrap it, then take the
// decoded basename.
// Unwrap an image-optimizer URL to the REAL underlying image, and resolve it to
// an absolute URL so the report link actually works. Optimizers wrap the real
// file in a query param (Next.js `/_next/image?url=...&w=640&q=75`, Vercel,
// Cloudflare `/cdn-cgi/image/...`) and the wrapper path is often relative — so
// the raw src is both ugly ("...LDVC_Pilnais_Balts...png&w=640&q=75") and dead as
// a link. Returns the decoded, page-absolute underlying URL where possible.
function realImageUrl(src, pageUrl) {
  if (!src) return "";
  let u = src;
  try {
    const wrapped = /[?&]url=([^&]+)/.exec(src);
    if (wrapped && /(_next\/image|\/cdn-cgi\/image|_vercel\/image|\/image[/?])/i.test(src)) {
      u = decodeURIComponent(wrapped[1]);
    }
    if (/^data:/i.test(u)) return u;
    // Resolve relative → absolute against the page URL so the link works. Only
    // for real URL/path strings — the worker's SVG descriptors ("Inline SVG #1
    // (near: …)") contain spaces and must NOT be coerced into a fake link.
    if (pageUrl && !/^https?:\/\//i.test(u) && !/\s/.test(u)) {
      try { u = new URL(u, pageUrl).href; } catch (e) {}
    }
  } catch (e) { return src; }
  return u;
}

// Derive a human-readable name for an image so the report says WHICH image is
// wrong instead of dumping a URL tail.
function imageName(src) {
  if (!src) return "";
  try {
    let u = realImageUrl(src, null); // unwrap only; no origin needed for the name
    if (/^data:/i.test(u)) return "(inline data image)";
    // Non-URL descriptors (e.g. the worker's "Inline SVG #1 (near: …)") — show as-is.
    if (!/^https?:\/\//i.test(u) && !u.startsWith("/")) return src;
    u = u.split("#")[0].split("?")[0];
    let base = u.substring(u.lastIndexOf("/") + 1);
    try { base = decodeURIComponent(base); } catch (e) {}
    return base || u || src;
  } catch (e) {
    return src;
  }
}

function altSrc(src, pageUrl) {
  const real = realImageUrl(src, pageUrl) || src;
  const display = real.length > 60 ? "..." + real.slice(-57) : real;
  if (/^https?:\/\//i.test(real)) {
    return `<a class="alt-text-src" href="${esc(real)}" target="_blank" rel="noopener noreferrer" title="${esc(real)}">${esc(display)}</a>`;
  }
  return `<code class="alt-text-src" title="${esc(real)}">${esc(display)}</code>`;
}

function altVal(alt) {
  return alt ? `"${esc(alt)}"` : "<em>(empty)</em>";
}

function filterChips(items, activeKey, group) {
  activeKey = activeKey || "all";
  group = group || "alt-text";
  return `<div class="${group}-filter" role="tablist">` +
    items.map((c) =>
      `<button type="button" class="${group}-filter-chip ${c.key === activeKey ? "is-active" : ""}" data-filter="${esc(c.key)}" aria-selected="${c.key === activeKey}"${c.n === 0 && c.key !== "all" ? " disabled" : ""}>${esc(c.label)} (${esc(c.n)})</button>`
    ).join("") + `</div>`;
}

function headingCheckItem(hc) {
  const icon = hc.status === "pass" ? "✓" : hc.status === "fail" ? "✗" : "⚠";
  const name = HEADING_CHECK_NAMES[hc.id] || hc.id;
  const findings = hc.findings || [];
  if (findings.length === 0) {
    return `<div class="heading-check-item ${esc(hc.status)}"><span class="heading-check-icon">${icon}</span><span class="heading-check-name">${esc(name)}</span></div>`;
  }
  const failCount = findings.filter((f) => f.status === "fail").length;
  const warningCount = findings.filter((f) => f.status === "warning").length;
  const parts = [`${findings.length} ${findings.length === 1 ? "finding" : "findings"}`];
  if (failCount > 0) parts.push(`${failCount} failed`);
  if (warningCount > 0) parts.push(`${warningCount} ${warningCount === 1 ? "warning" : "warnings"}`);
  const findingRows = bySeverity(findings).map((f) =>
    `<div class="heading-finding heading-finding--${esc(f.status)}" data-status="${esc(f.status)}">` +
      `<div class="heading-finding-header">` +
        `<span class="heading-finding-icon heading-finding-icon--${esc(f.status)}" aria-hidden="true">${f.status === "fail" ? "✗" : "⚠"}</span>` +
        `<span class="heading-finding-badge heading-finding-badge--${esc(f.status)}">${f.status === "fail" ? "Failed" : "Warning"}</span>` +
        `<span class="heading-finding-element">${esc(f.element)}</span>` +
      `</div>` +
      `<div class="heading-finding-details"><p><strong>Current:</strong> ${esc(f.current)}</p><p><strong>Expected:</strong> ${esc(f.expected)}</p></div>` +
    `</div>`
  ).join("");
  const chips = (failCount > 0 && warningCount > 0)
    ? filterChips([{ label: "All", n: findings.length, key: "all" }, { label: "Failed", n: failCount, key: "failed" }, { label: "Warnings", n: warningCount, key: "warnings" }], "all", "heading")
    : "";
  return `<details class="heading-check-item ${esc(hc.status)} has-findings" open>` +
    `<summary class="heading-check-summary"><span class="heading-check-icon">${icon}</span><span class="heading-check-name">${esc(name)}</span><span class="heading-check-desc">${esc(parts.join(", "))}</span>${chevron("heading-check-toggle")}</summary>` +
    `<div class="heading-check-body">${chips}<div class="heading-check-findings">${findingRows}</div></div>` +
  `</details>`;
}

function scoreBadge(kind, label, score) {
  const cls = score.score === "not_applicable" ? "na" : score.score;
  const text = score.score === "not_applicable" ? "N/A" : score.score === "pass" ? "Pass" : score.score === "warning" ? "Warning" : "Fail";
  if (kind === "media") {
    return `<div class="media-score-badge media-score-badge--${esc(cls)}"><span class="media-score-label">${esc(label)}</span><span class="media-score-value">${esc(text)}</span><span class="media-score-reason">${esc(score.reason)}</span></div>`;
  }
  return `<div class="forms-score-badge forms-score-badge--${esc(cls)}"><span class="forms-score-label">${esc(label)}</span><span class="forms-score-value">${esc(text)}</span><span class="forms-score-counts">${esc(score.passCount)} pass · ${esc(score.warningCount)} warn · ${esc(score.failCount)} fail</span></div>`;
}

function formFieldRow(field) {
  const q = field.labelQuality;
  const qClass = q === "not_applicable" ? "na" : q;
  const qText = q === "pass" ? "Pass" : q === "warning" ? "Warning" : q === "fail" ? "Fail" : "N/A";
  const identity = field.name || field.id || `(${field.type})`;
  const requiredText = REQUIRED_MATCH_NAMES[field.requiredMatch] || "";
  return `<div class="forms-field forms-field--${esc(qClass)}">` +
    `<div class="forms-field-header"><span class="forms-score-badge forms-score-badge--${esc(qClass)} forms-field-quality">${esc(qText)}</span>` +
      `<code class="forms-field-id">${esc(field.type)}${identity !== `(${field.type})` ? ` · ${esc(identity)}` : ""}</code>` +
      (field.outcome ? `<span class="forms-field-outcome">${esc(field.outcome)}</span>` : "") +
    `</div>` +
    `<div class="forms-field-body">` +
      `<p class="forms-field-line"><strong>Label:</strong> ${field.labelText ? `“${esc(field.labelText)}”` : "<em>(none)</em>"} <span class="forms-field-method">via ${esc(LABEL_METHOD_NAMES[field.labelMethod] || field.labelMethod)}</span></p>` +
      (requiredText ? `<p class="forms-field-line"><strong>Required:</strong> ${esc(requiredText)}</p>` : "") +
      (field.labelIssue ? `<p class="forms-field-line forms-field-issue"><strong>Issue:</strong> ${esc(field.labelIssue)}</p>` : "") +
      (field.requiredIssue ? `<p class="forms-field-line forms-field-issue"><strong>Required issue:</strong> ${esc(field.requiredIssue)}</p>` : "") +
      (field.suggestedLabel && field.suggestedLabel !== field.labelText ? `<p class="forms-field-line forms-field-suggestion"><strong>Suggested label:</strong> “${esc(field.suggestedLabel)}”</p>` : "") +
      (field.evidenceHtml ? `<p class="forms-field-line"><strong>Where:</strong></p><pre class="forms-field-html">${escSnippet(field.evidenceHtml)}</pre>` : "") +
      shot(field.image) +
    `</div>` +
  `</div>`;
}

function formsIssues(label, findings) {
  if (!findings || !findings.length) return "";
  return `<div class="forms-issues"><p class="headings-section-label">${esc(label)}</p>` +
    findings.map((f) =>
      `<div class="forms-finding"><div class="forms-finding-header"><code class="forms-finding-field">${esc(f.field)}</code></div>` +
      `<p class="forms-finding-issue"><strong>Issue:</strong> ${esc(f.issue)}</p>` +
      `<p class="forms-finding-rec"><strong>Recommendation:</strong> ${esc(f.recommendation)}</p></div>`
    ).join("") + `</div>`;
}

function checkBodies(check, pageUrl) {
  const d = check;
  const has = {
    headings: d.id === "headings" && d.headingsData && (d.headingsData.checks.length > 0 || d.headingsData.currentOutline.length > 0),
    alt: ALT_TEXT_IDS.includes(d.id) && d.altTextData && (d.altTextData.badCount > 0 || d.altTextData.warningCount > 0),
    media: d.mediaData && d.mediaData.hasMedia,
    forms: d.formsData && d.formsData.hasForms,
    focus: d.keyboardFocusData && d.keyboardFocusData.totalFocusables > 0,
    reflow: d.reflowData && (d.reflowData.reflow || d.reflowData.zoom),
    contrast: d.id === "contrast" && d.contrastData && d.contrastData.elements && d.contrastData.elements.length > 0,
  };
  const out = [];

  if (has.alt) {
    const at = d.altTextData;
    const items = bySeverity(at.flaggedImages).map((img) => {
      const isFail = img.status === "fail";
      return `<div class="alt-text-item alt-text-item--${esc(img.status)}" data-status="${esc(img.status)}">` +
        `<div class="alt-text-item-header"><span class="alt-text-icon alt-text-icon--${esc(img.status)}" aria-hidden="true">${isFail ? "✗" : "⚠"}</span>` +
        `<span class="alt-text-badge alt-text-badge--${esc(img.status)}">${isFail ? "Failed" : "Warning"}</span>` +
        `<span class="alt-text-name" title="${esc(img.src)}">${esc(imageName(img.src))}</span></div>` +
        `<div class="alt-text-srcline">${altSrc(img.src, pageUrl)}</div>` +
        `<div class="alt-text-details"><p><strong>Alt:</strong> ${altVal(img.alt)}</p><p><strong>${isFail ? "Issue" : "Suggestion"}:</strong> ${esc(img.reason)}</p>` +
        (img.evidenceHtml ? `<p><strong>Where:</strong></p><pre class="alt-text-html">${escSnippet(img.evidenceHtml)}</pre>` : "") +
        `${shot(img.image, "alt-text-shot")}</div></div>`;
    }).join("");
    const altActive = at.badCount > 0 ? "failed" : "warnings";
    out.push(`<div class="criterion-body">${filterChips([{ label: "All", n: at.flaggedImages.length, key: "all" }, { label: "Failed", n: at.badCount, key: "failed" }, { label: "Warnings", n: at.warningCount, key: "warnings" }], altActive)}<div class="alt-text-issues">${items}</div></div>`);
  }

  if (has.headings) {
    const hd = d.headingsData;
    let body = `<div class="headings-checks"><p class="headings-section-label">Checks</p><div class="headings-checks-list">${hd.checks.map(headingCheckItem).join("")}</div></div>`;
    if (hd.currentOutline.length > 0 || hd.suggestedOutline.length > 0) {
      const col = (title, arr) => arr.length ? `<div class="headings-outline"><p class="headings-outline-title">${title}</p><pre class="headings-outline-tree">${esc(arr.join("\n"))}</pre></div>` : "";
      body += `<div class="headings-structure"><p class="headings-section-label">Structure Comparison</p><div class="headings-structure-grid">${col("Current Structure", hd.currentOutline)}${col("Suggested Structure", hd.suggestedOutline)}</div></div>`;
    }
    out.push(`<div class="criterion-body">${body}</div>`);
  }

  if (has.media) {
    const md = d.mediaData;
    const scores = scoreBadge("media", "Captions", md.captions) + scoreBadge("media", "Transcripts", md.transcripts) + scoreBadge("media", "Audio Description", md.audioDescription);
    const itemsHtml = md.mediaItems.length ? `<div class="media-items">${md.mediaItems.map((item) =>
      `<div class="media-item"><div class="media-item-header"><span class="media-item-type">${esc(item.type)}</span><span class="media-item-platform">${esc(item.platform)}</span></div>` +
      `<code class="media-item-src">${esc(item.src.length > 80 ? "..." + item.src.slice(-77) : item.src)}</code>` +
      `<div class="media-item-details"><span class="${item.has_captions === true ? "pass" : item.has_captions === "platform_may_provide" ? "warning" : "fail"}">Captions: ${item.has_captions === true ? "Yes" : item.has_captions === "platform_may_provide" ? "Platform may provide" : "No"}</span>` +
      `<span class="${item.has_transcript_link ? "pass" : "warning"}">Transcript: ${item.has_transcript_link ? "Link found" : "Not detected"}</span></div></div>`
    ).join("")}</div>` : "";
    out.push(`<div class="criterion-body"><div class="media-summary"><p class="headings-section-label">Media Found: ${esc(md.mediaCount)}</p><div class="media-scores">${scores}</div></div>${itemsHtml}</div>`);
  }

  if (has.forms) {
    const fd = d.formsData;
    const scores = scoreBadge("forms", "Labels", fd.labels) + scoreBadge("forms", "Required Fields", fd.requiredFields) + (fd.grouping ? scoreBadge("forms", "Grouping", fd.grouping) : "");
    const fieldsHtml = fd.fields.length ? `<div class="forms-fields"><p class="headings-section-label">Fields (${fd.fields.length})</p><div class="forms-fields-list">${fd.fields.map(formFieldRow).join("")}</div></div>` : "";
    // AB-15: the "* = required" legend note is only meaningful when the form
    // actually has required fields. On a form with no required fields the check
    // is not_applicable, so "Required-field legend: not found" is noise — omit it.
    const legendNote = fd.requiredFields.score === "not_applicable"
      ? ""
      : `<p class="forms-legend-note">Required-field legend (e.g. “* = required”): <strong>${fd.requiredFields.hasRequiredLegend ? "present" : "not found"}</strong></p>`;
    out.push(`<div class="criterion-body">` +
      `<div class="forms-summary"><p class="headings-section-label">Forms: ${esc(fd.formCount)} · Fields: ${esc(fd.fieldCount)}</p><div class="forms-scores">${scores}</div>` +
      `${legendNote}</div>` +
      fieldsHtml +
      formsIssues("Label Issues", fd.labels.findings) +
      formsIssues("Required Field Issues", fd.requiredFields.findings) +
      (fd.grouping ? formsIssues("Grouping Issues (radio/checkbox groups)", fd.grouping.findings) : "") +
    `</div>`);
  }

  if (has.focus) {
    const kd = d.keyboardFocusData;
    const bad = kd.elements.filter((el) => !el.hasVisibleFocus);
    const focusItem = (el) =>
      `<div class="focus-item"><div class="focus-item-header"><code class="focus-item-selector">${esc(el.tag)}</code><span class="focus-item-text">${esc((el.text || "").length > 40 ? el.text.slice(0, 37) + "..." : (el.text || ""))}</span></div>${el.issue ? `<p class="focus-item-issue">${esc(el.issue)}</p>` : ""}${el.evidenceHtml ? `<pre class="alt-text-html">${escSnippet(el.evidenceHtml)}</pre>` : ""}${shot(el.image, "focus-shot")}</div>`;
    const badHtml = bad.length ? `<div class="focus-issues"><p class="headings-section-label">Elements Without Visible Focus</p>${bad.map(focusItem).join("")}</div>` : "";
    const unreach = Array.isArray(kd.unreachable) ? kd.unreachable : [];
    const unreachHtml = unreach.length ? `<div class="focus-issues"><p class="headings-section-label">Interactive Elements Not Reachable by Keyboard</p>${unreach.map(focusItem).join("")}</div>` : "";
    // Show only the qualitative summary + the problematic elements (no visible
    // focus ring, and interactive elements Tab never reaches) — no element counts.
    out.push(`<div class="criterion-body"><div class="focus-summary"><p class="focus-summary-text">${esc(kd.summary)}</p></div>${badHtml}${unreachHtml}</div>`);
  }

  if (has.reflow) {
    const rd = d.reflowData;
    let body = "";
    if (rd.reflow) {
      // Only list overflowing elements when reflow did NOT pass. On a pass the
      // amounts are sub-threshold rounding noise (e.g. 2px) and contradict the
      // "no horizontal scrolling" reason shown alongside them.
      const overflow = rd.reflow.score !== "pass" && rd.reflow.overflowElements && rd.reflow.overflowElements.length ? `<div class="reflow-overflow"><p class="reflow-overflow-label">Overflowing elements:</p><ul class="reflow-overflow-list">${rd.reflow.overflowElements.map((el) => `<li><code>${esc(el.tag)}</code> overflows by ${esc(el.overflow)}px</li>`).join("")}</ul></div>` : "";
      body += `<div class="reflow-section"><div class="reflow-header"><p class="headings-section-label">Reflow at 320px</p><span class="reflow-score reflow-score--${esc(rd.reflow.score)}">${statusText(rd.reflow.score).replace("Passed", "Pass").replace("Failed", "Fail")}</span></div><p class="reflow-reason">${esc(rd.reflow.reason)}</p>${rd.reflow.hasHorizontalScroll ? `<p class="reflow-warning">Horizontal scrolling detected</p>` : ""}${overflow}</div>`;
    }
    if (rd.zoom) {
      const findings = rd.zoom.findings && rd.zoom.findings.length ? `<ul class="zoom-findings">${rd.zoom.findings.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : "";
      body += `<div class="zoom-section"><div class="zoom-header"><p class="headings-section-label">200% Zoom</p><span class="reflow-score reflow-score--${esc(rd.zoom.score)}">${statusText(rd.zoom.score).replace("Passed", "Pass").replace("Failed", "Fail")}</span></div><p class="zoom-summary">${esc(rd.zoom.summary)}</p>${findings}</div>`;
    }
    out.push(`<div class="criterion-body">${body}</div>`);
  }

  if (has.contrast) {
    const cd = d.contrastData;
    const sw = (hex) => hex
      ? `<span title="${esc(hex)}" style="display:inline-block;width:14px;height:14px;border:1px solid #999;border-radius:3px;vertical-align:middle;background:${esc(hex)}"></span>`
      : "";
    const count = cd.elements.length;
    const header = `${esc(count)} contrast ${count === 1 ? "finding" : "findings"}`;
    const rows = cd.elements.map((el) => {
      const bgLabel = el.overImage
        ? `image${el.bgHex ? ` (sampled ${esc(el.bgHex)})` : ""}`
        : `background ${esc(el.bgHex || "")}`;
      const colors = (el.fgHex || el.bgHex)
        ? `<p class="contrast-item-colors">${sw(el.fgHex)} text ${esc(el.fgHex || "")} on ${sw(el.bgHex)} ${bgLabel}</p>`
        : "";
      return `<li class="contrast-item"><p class="contrast-item-summary">${esc(el.summary)}</p>${colors}<code class="contrast-item-selector">${esc(el.selector)}</code>${shot(el.image)}<pre class="contrast-item-html">${escSnippet(el.html)}</pre></li>`;
    }).join("");
    out.push(`<div class="criterion-body"><div class="contrast-section"><p class="headings-section-label">${header}</p><ul class="contrast-list">${rows}</ul></div></div>`);
  }

  return out.join("");
}

function criterionCard(check, pageUrl) {
  const header =
    `<span class="criterion-num">${esc(check.num)}.</span>` +
    `<div class="criterion-info"><div class="criterion-name">${esc(check.name)}</div>${check.description ? `<p class="criterion-summary">${esc(check.description)}</p>` : ""}</div>` +
    `<span class="criterion-status ${esc(check.status)}">${esc(statusText(check.status))}</span>`;
  const bodies = checkBodies(check, pageUrl);
  if (!bodies) {
    return `<div class="criterion criterion-static"><div class="criterion-header">${header}</div></div>`;
  }
  return `<details class="criterion" open><summary class="criterion-header">${header}${CHEVRON}</summary>${bodies}</details>`;
}

function formatDisplayUrl(url) {
  try { const p = new URL(url); return p.hostname + p.pathname; } catch (e) { return url; }
}

function pageResult(page, index) {
  const badgeClass = page.passed ? "pass" : "fail";
  const badgeText = page.passed ? "Passed" : `${page.issueCount} issue${page.issueCount !== 1 ? "s" : ""}`;
  return `<details class="page-result" open>` +
    `<summary class="page-result-header"><span class="page-result-num">${index + 1}</span>` +
    `<div class="page-result-info"><h3 class="page-result-name">${esc(page.title || page.url)}</h3>` +
    `<a href="${esc(page.url)}" target="_blank" rel="noopener noreferrer" class="page-result-sub-url">${esc(formatDisplayUrl(page.url))}</a></div>` +
    `<span class="page-result-badge ${badgeClass}">${esc(badgeText)}</span>${chevron("page-result-chevron")}</summary>` +
    `<div class="page-result-body">${(page.checks || []).map((c) => criterionCard(c, page.url)).join("")}</div>` +
  `</details>`;
}

async function _readStyle(file) {
  try {
    const res = await fetch(chrome.runtime.getURL("vendor/styles/" + file));
    return await res.text();
  } catch (e) { return ""; }
}

/**
 * Render an audit (from buildEvidenceAudit) as a standalone HTML document string.
 * @param {object} audit
 * @returns {Promise<string>}
 */
async function renderReportHtml(audit) {
  const pages = audit.pages || audit.results || [];
  const isCompliant = audit.complianceStatus === "compliant";
  let domain = audit.domain;
  if (!domain) { try { domain = new URL(audit.url).hostname; } catch (e) { domain = ""; } }
  const method = audit.methodName || "WCAG Easy Check";
  let dateStr = "";
  try { if (audit.completedAt) dateStr = new Date(audit.completedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); } catch (e) {}
  const favicon = domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32` : "";

  const base = await _readStyle("base.css");
  const audit_ = await _readStyle("audit.css");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Accessibility audit — ${esc(domain)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>${base}</style>
<style>${audit_}</style>
<style>
  /* standalone tweaks: no site nav, so unstick the header and set the page bg */
  body { background:#fafafa; }
  .result-context { position:static; top:auto; }
  .report-generated { color:#8b949e; font-size:12px; text-align:center; margin:40px 0 0; }
  .methodology-note { background:#f6f8fa; border:1px solid #eaeef2; border-left:3px solid #4a5568; border-radius:8px; padding:14px 16px; margin:20px 0 0; font-size:13px; line-height:1.5; color:#4a5568; }
  .methodology-note a { color:#0969da; }
  /* element screenshots captured by the extension */
  .evidence-shot { display:block; max-width:100%; height:auto; margin:8px 0 4px; border:1px solid #d0d7de; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,.08); }
  .evidence-shot.alt-text-shot { max-width:240px; }
  .evidence-shot.focus-shot { max-width:320px; }
  .forms-field-html, .alt-text-html { white-space:pre-wrap; word-break:break-word; background:#f6f8fa; border:1px solid #eaeef2; border-radius:6px; padding:8px 10px; margin:4px 0 8px; font-size:12px; overflow-x:auto; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
</style>
</head>
<body>
  <div class="result-context">
    <div class="container">
      <div class="result-header">
        <div class="result-header-left">
          ${favicon ? `<span class="site-favicon" aria-hidden="true"><img src="${esc(favicon)}" alt="" width="32" height="32"></span>` : ""}
          <div class="result-header-info">
            <div class="result-header-titlebar">
              <h1 class="result-header-title">${esc(method)}</h1>
              <span class="compliance-status ${isCompliant ? "pass" : "fail"}">${isCompliant ? "Compliant" : "Not compliant"}</span>
            </div>
            <p class="result-header-meta">
              ${dateStr ? `<span>${esc(dateStr)}</span><span class="result-header-meta-sep" aria-hidden="true">·</span>` : ""}
              <span>${esc(audit.pagesCount == null ? pages.length : audit.pagesCount)} page tested</span>
              <span class="result-header-meta-sep" aria-hidden="true">·</span>
              <span>${esc(domain)}</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>

  <main class="result-main">
    <div class="container">
      <p class="methodology-note">This audit follows the W3C Web Accessibility Initiative methodology <a href="https://www.w3.org/WAI/test-evaluate/easy-checks/" target="_blank" rel="noopener noreferrer">Easy Checks — A First Review of Web Accessibility (Draft Update)</a>, evaluated against WCAG 2.1 Level AA. Easy Checks is a first review: it finds common, high-impact barriers quickly, and passing it does not by itself establish full WCAG conformance. The Draft Update is W3C work in progress — where it differs from the published Easy Checks, this audit follows the draft.</p>
      <p class="result-section-label">Page tested</p>
      <div class="results-pages">
        ${pages.map(pageResult).join("")}
      </div>
      <p class="report-generated">Generated by the WCAGpilot extension · offline report · same 13-check pipeline as a normal audit, with element screenshots.</p>
    </div>
  </main>
  <script>
  (function () {
    function apply(group) {
      var active = group.querySelector(".is-active");
      var f = active ? active.getAttribute("data-filter") : "all";
      var body = group.parentElement;
      body.querySelectorAll("[data-status]").forEach(function (it) {
        var s = it.getAttribute("data-status");
        var show = f === "all" || (f === "failed" && (s === "fail" || s === "bad")) || (f === "warnings" && s === "warning");
        it.style.display = show ? "" : "none";
      });
    }
    document.querySelectorAll(".alt-text-filter, .heading-filter").forEach(function (group) {
      group.addEventListener("click", function (e) {
        var chip = e.target.closest("[data-filter]");
        if (!chip || chip.disabled) return;
        group.querySelectorAll("[data-filter]").forEach(function (c) {
          c.classList.remove("is-active");
          c.setAttribute("aria-selected", "false");
        });
        chip.classList.add("is-active");
        chip.setAttribute("aria-selected", "true");
        apply(group);
      });
      apply(group);
    });
  })();
  </script>
</body>
</html>`;
}

// Turn a page URL into a filename suffix from its path (domain excluded), e.g.
// https://old.rigassatiksme.lv/lv/contacts/form -> "contacts-form". Drops a
// leading 2-letter locale segment (/lv/, /en/, …); homepage -> "".
function _pagePathSlug(url) {
  let path = "";
  try { path = new URL(url).pathname; } catch (e) { return ""; }
  let parts = path.split("/").filter(Boolean);
  if (parts.length && /^[a-z]{2}$/i.test(parts[0])) parts = parts.slice(1);
  const slug = parts.join("-").replace(/[^a-z0-9-]+/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return slug ? slug.slice(0, 60) : "";
}

/**
 * Build the report HTML and trigger a download of a self-contained .html file.
 * @param {object} audit
 * @returns {Promise<string>} the download filename
 */
async function downloadReportHtml(audit) {
  const html = await renderReportHtml(audit);
  const domain = (audit.domain || "audit").replace(/[^a-z0-9.-]+/gi, "-");
  let stamp = "";
  try { stamp = new Date().toISOString().slice(0, 10); } catch (e) {}
  const slug = _pagePathSlug(audit.url);
  const filename = `a11y-audit-${domain}${stamp ? "-" + stamp : ""}${slug}.html`;
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  await new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: true }, (id) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(id);
    });
  });
  // Revoke after a delay so the download has time to read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return filename;
}
