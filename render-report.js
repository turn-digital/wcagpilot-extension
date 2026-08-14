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

const HEADING_CHECK_NAMES = {
  presence: "Heading presence", h1_first: "H1 heading", hierarchy: "Hierarchy order",
  empty_headings: "Empty headings", visual_headings: "Visual headings",
  content_match: "Content match", logical_structure: "Logical structure",
};
const LABEL_METHOD_NAMES = {
  label_for: "label[for]", label_wrap: "wrapping <label>", aria_label: "aria-label",
  aria_labelledby: "aria-labelledby", placeholder_only: "placeholder only",
  title_only: "title only", none: "no label",
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

function altSrc(src) {
  const display = src.length > 60 ? "..." + src.slice(-57) : src;
  if (/^https?:\/\//i.test(src)) {
    return `<a class="alt-text-src" href="${esc(src)}" target="_blank" rel="noopener noreferrer" title="${esc(src)}">${esc(display)}</a>`;
  }
  return `<code class="alt-text-src">${esc(display)}</code>`;
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

function checkBodies(check) {
  const d = check;
  const has = {
    headings: d.id === "headings" && d.headingsData && (d.headingsData.checks.length > 0 || d.headingsData.currentOutline.length > 0),
    alt: ALT_TEXT_IDS.includes(d.id) && d.altTextData && (d.altTextData.badCount > 0 || d.altTextData.warningCount > 0),
    media: d.mediaData && d.mediaData.hasMedia,
    forms: d.formsData && d.formsData.hasForms,
    focus: d.keyboardFocusData && d.keyboardFocusData.totalFocusables > 0,
    reflow: d.reflowData && (d.reflowData.reflow || d.reflowData.zoom),
    contrast: d.id === "contrast" && d.contrastData && d.contrastData.totalIssues > 0,
  };
  const out = [];

  if (has.alt) {
    const at = d.altTextData;
    const items = bySeverity(at.flaggedImages).map((img) => {
      const isFail = img.status === "fail";
      return `<div class="alt-text-item alt-text-item--${esc(img.status)}" data-status="${esc(img.status)}">` +
        `<div class="alt-text-item-header"><span class="alt-text-icon alt-text-icon--${esc(img.status)}" aria-hidden="true">${isFail ? "✗" : "⚠"}</span>` +
        `<span class="alt-text-badge alt-text-badge--${esc(img.status)}">${isFail ? "Failed" : "Warning"}</span>${altSrc(img.src)}</div>` +
        `<div class="alt-text-details"><p><strong>Alt:</strong> ${altVal(img.alt)}</p><p><strong>${isFail ? "Issue" : "Suggestion"}:</strong> ${esc(img.reason)}</p>${shot(img.image, "alt-text-shot")}</div></div>`;
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
    out.push(`<div class="criterion-body">` +
      `<div class="forms-summary"><p class="headings-section-label">Forms: ${esc(fd.formCount)} · Fields: ${esc(fd.fieldCount)}</p><div class="forms-scores">${scores}</div>` +
      `<p class="forms-legend-note">Required-field legend (e.g. “* = required”): <strong>${fd.requiredFields.hasRequiredLegend ? "present" : "not found"}</strong></p></div>` +
      fieldsHtml +
      formsIssues("Label Issues", fd.labels.findings) +
      formsIssues("Required Field Issues", fd.requiredFields.findings) +
      (fd.grouping ? formsIssues("Grouping Issues (radio/checkbox groups)", fd.grouping.findings) : "") +
    `</div>`);
  }

  if (has.focus) {
    const kd = d.keyboardFocusData;
    const bad = kd.elements.filter((el) => !el.hasVisibleFocus);
    const badHtml = bad.length ? `<div class="focus-issues"><p class="headings-section-label">Elements Without Visible Focus</p>${bad.map((el) =>
      `<div class="focus-item"><div class="focus-item-header"><code class="focus-item-selector">${esc(el.tag)}</code><span class="focus-item-text">${esc(el.text.length > 40 ? el.text.slice(0, 37) + "..." : el.text)}</span></div>${el.issue ? `<p class="focus-item-issue">${esc(el.issue)}</p>` : ""}</div>`
    ).join("")}</div>` : "";
    out.push(`<div class="criterion-body"><div class="focus-summary"><p class="headings-section-label">Focusable Elements: ${esc(kd.totalFocusables)}</p><div class="focus-stats"><span class="focus-stat pass">${esc(kd.withVisibleFocus)} with visible focus</span><span class="focus-stat fail">${esc(kd.withoutVisibleFocus)} without visible focus</span></div><p class="focus-summary-text">${esc(kd.summary)}</p></div>${badHtml}</div>`);
  }

  if (has.reflow) {
    const rd = d.reflowData;
    let body = "";
    if (rd.reflow) {
      const overflow = rd.reflow.overflowElements && rd.reflow.overflowElements.length ? `<div class="reflow-overflow"><p class="reflow-overflow-label">Overflowing elements:</p><ul class="reflow-overflow-list">${rd.reflow.overflowElements.map((el) => `<li><code>${esc(el.tag)}</code> overflows by ${esc(el.overflow)}px</li>`).join("")}</ul></div>` : "";
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
    out.push(`<div class="criterion-body"><div class="contrast-section"><p class="headings-section-label">${esc(cd.totalIssues)} ${cd.totalIssues === 1 ? "element" : "elements"} with insufficient contrast</p><ul class="contrast-list">${cd.elements.map((el) => `<li class="contrast-item"><p class="contrast-item-summary">${esc(el.summary)}</p><code class="contrast-item-selector">${esc(el.selector)}</code>${shot(el.image)}<pre class="contrast-item-html">${esc(el.html)}</pre></li>`).join("")}</ul></div></div>`);
  }

  return out.join("");
}

function criterionCard(check) {
  const header =
    `<span class="criterion-num">${esc(check.num)}.</span>` +
    `<div class="criterion-info"><div class="criterion-name">${esc(check.name)}</div>${check.description ? `<p class="criterion-summary">${esc(check.description)}</p>` : ""}</div>` +
    `<span class="criterion-status ${esc(check.status)}">${esc(statusText(check.status))}</span>`;
  const bodies = checkBodies(check);
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
    `<div class="page-result-body">${(page.checks || []).map(criterionCard).join("")}</div>` +
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
  /* element screenshots captured by the extension */
  .evidence-shot { display:block; max-width:100%; height:auto; margin:8px 0 4px; border:1px solid #d0d7de; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,.08); }
  .evidence-shot.alt-text-shot { max-width:240px; }
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
  const filename = `a11y-audit-${domain}${stamp ? "-" + stamp : ""}.html`;
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
