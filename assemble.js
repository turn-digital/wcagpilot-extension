// assemble.js — build the 13-check AuditPageResult IN THE EXTENSION, calling the
// public /w/* modular workers directly with NO auth.
//
// This is the browser port of vpn-audit-collector/src/assemble.js (itself a port
// of wcagpilot-worker-main/src/services/audit-orchestrator.ts). It lets the
// extension audit a page without any login: like the Docker collector, it hits
// the OPEN /w/* workers and merges their output itself, instead of the auth-gated
// /main/audit/page. KEEP IN SYNC with the collector's assemble.js.
//
// Keyboard (#8) and reflow/zoom (#6) are always skipped here — the extension
// measures them live on the real page (live-checks.js) and overrides them.
//
// Exposes one global: assemblePageAuditLocal(capture) -> AuditPageResult

const assemblePageAuditLocal = (function () {
  const BASE = () => CONFIG.WORKER_URL.replace(/\/+$/, "");

  async function post(path, body) {
    const res = await fetch(`${BASE()}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path} failed (${res.status})`);
    return res.json();
  }

  async function callHeadings(url, html) {
    const r = await post("/w/headings", { url, html });
    return {
      passed: r.compliant ?? true,
      hasWarnings: r.has_warnings ?? false,
      description: r.summary || "",
      checks: r.checks || [],
      currentOutline: r.current_outline || [],
      suggestedOutline: r.suggested_outline || [],
    };
  }
  async function callTitles(url, html, title) {
    const data = await post("/w/titles", { pages: [{ url, html, title }] });
    return { results: data.results || [] };
  }
  async function callAltTexts(url, html) {
    const data = await post("/w/alt-texts", { pages: [{ url, html }] });
    const results = (data.pages || []).map((p) => ({
      url: p.url,
      total_images: p.total_images,
      good_count: p.pass_count,
      bad_count: p.fail_count,
      warning_count: p.warning_count,
      images: p.images,
    }));
    return { results };
  }
  async function callSkipLinks(url, html) {
    const data = await post("/w/skip-links", { pages: [{ url, html }] });
    return { results: data.results || [] };
  }
  async function callMedia(url, html) {
    const data = await post("/w/media", { pages: [{ url, html }] });
    return { pages: data.pages || [] };
  }
  async function callForms(url, html) {
    const data = await post("/w/forms", { pages: [{ url, html }] });
    return { pages: data.pages || [] };
  }

  function extractLanguage(html) {
    const match = html.match(/<html[^>]*lang=["']([^"']+)["']/i);
    return match ? match[1] : null;
  }

  function checkBasicStructure(html) {
    const hasMain = /<main[\s>]/i.test(html) || /role\s*=\s*["']main["']/i.test(html);
    const hasHeader = /<header[\s>]/i.test(html) || /role\s*=\s*["']banner["']/i.test(html);
    const hasNav = /<nav[\s>]/i.test(html) || /role\s*=\s*["']navigation["']/i.test(html);
    const hasFooter = /<footer[\s>]/i.test(html) || /role\s*=\s*["']contentinfo["']/i.test(html);
    const hasHeading = /<h[1-6][\s>]/i.test(html);
    const landmarks = [hasHeader, hasNav, hasFooter].filter(Boolean).length;
    if (hasMain && hasHeading && landmarks >= 1) {
      const present = ["<main>", hasHeader && "<header>", hasNav && "<nav>", hasFooter && "<footer>"]
        .filter(Boolean).join(", ");
      return { status: "pass", description: `Page uses semantic landmarks (${present}) and headings.` };
    }
    if (hasMain || hasHeading || landmarks >= 1) {
      const missing = [];
      if (!hasMain) missing.push("a <main> landmark");
      if (!hasHeading) missing.push("headings");
      if (landmarks === 0) missing.push("header/nav/footer landmarks");
      return {
        status: "warning",
        description: `Some structure present, but missing ${missing.join(" and ")}. Adding semantic landmarks helps assistive-tech users navigate (WCAG 1.3.1, best practice).`,
      };
    }
    return {
      status: "fail",
      description: "No semantic structure: no <main>/<header>/<nav>/<footer> landmarks and no headings. Content is not programmatically structured (WCAG 1.3.1).",
    };
  }

  function checkMovingContent(html) {
    if (/<(marquee|blink)[\s>]/i.test(html)) {
      return {
        status: "fail",
        description: "Deprecated auto-moving content (<marquee>/<blink>) found — it moves continuously with no pause/stop mechanism (WCAG 2.2.2).",
      };
    }
    const signals = [];
    if (/<(video|audio)\b[^>]*\bautoplay\b/i.test(html)) signals.push("auto-playing video/audio");
    if (/\b(carousel|slider|swiper|slick|owl-carousel|ticker)\b/i.test(html)) signals.push("a carousel/slider");
    if (/<img\b[^>]*\.gif["']/i.test(html)) signals.push("animated GIF(s)");
    if (signals.length > 0) {
      return {
        status: "warning",
        description: `Potential auto-moving content detected (${signals.join(", ")}). If it moves/blinks for more than 5 seconds and starts automatically, it must be pausable/stoppable (WCAG 2.2.2) — verify a pause control exists or that it auto-stops.`,
      };
    }
    return { status: "pass", description: "No auto-playing, moving, or blinking content detected." };
  }

  async function assemble(input) {
    const { url, html } = input;
    const pageTitle = input.title || "";

    // Fan out to the 6 content workers (fail soft to empty). Keyboard/reflow are
    // done live by the extension, so they are not called here.
    const [headings, titlesResult, altTextsResult, skipLinksResult, mediaResult, formsResult] =
      await Promise.all([
        callHeadings(url, html).catch(() => ({
          passed: false, hasWarnings: false, description: "Failed to analyze headings",
          checks: [], currentOutline: [], suggestedOutline: [],
        })),
        callTitles(url, html, pageTitle).catch(() => ({ results: [] })),
        callAltTexts(url, html).catch(() => ({ results: [] })),
        callSkipLinks(url, html).catch(() => ({ results: [] })),
        callMedia(url, html).catch(() => ({ pages: [] })),
        callForms(url, html).catch(() => ({ pages: [] })),
      ]);

    const titleResult = titlesResult.results.find((r) => r.url === url) || titlesResult.results[0];
    const altResult = altTextsResult.results.find((r) => r.url === url) || altTextsResult.results[0];
    const skipResult = skipLinksResult.results.find((r) => r.url === url) || skipLinksResult.results[0];
    const mediaPageResult = mediaResult.pages.find((r) => r.url === url) || mediaResult.pages[0];
    const formsPageResult = formsResult.pages.find((r) => r.url === url) || formsResult.pages[0];
    const language = input.lang || extractLanguage(html);

    const structureCheck = checkBasicStructure(html);
    const motionCheck = checkMovingContent(html);

    const checks = [
      {
        id: "page-title", num: 1, name: "Page Title",
        status: titleResult ? (titleResult.is_good ? "pass" : "fail") : "warning",
        description: titleResult?.reason || `Title: "${pageTitle}"`,
        wcagRefs: ["WCAG 2.4.2"],
      },
      {
        id: "language", num: 2, name: "Language of Page",
        status: language ? "pass" : "fail",
        description: language ? `Page language is set to "${language}"` : "No language attribute found on <html> element",
        wcagRefs: ["WCAG 3.1.1"],
      },
      {
        id: "headings", num: 3, name: "Headings",
        status: headings.passed ? (headings.hasWarnings ? "warning" : "pass") : "fail",
        description: headings.description,
        wcagRefs: ["WCAG 2.4.6", "WCAG 1.3.1"],
        headingsData: {
          checks: headings.checks,
          currentOutline: headings.currentOutline,
          suggestedOutline: headings.suggestedOutline,
        },
      },
      {
        id: "alt-text", num: 4, name: "Image Alternative Text",
        status: altResult ? (altResult.bad_count === 0 ? "pass" : "fail") : "na",
        description: altResult
          ? altResult.bad_count === 0 && altResult.warning_count === 0
            ? `${altResult.total_images} images found, no issues`
            : altResult.bad_count > 0 && altResult.warning_count > 0
              ? `${altResult.total_images} images found, ${altResult.bad_count} failed, ${altResult.warning_count} ${altResult.warning_count === 1 ? "warning" : "warnings"}`
              : altResult.bad_count > 0
                ? `${altResult.total_images} images found, ${altResult.bad_count} failed`
                : `${altResult.total_images} images found, ${altResult.warning_count} ${altResult.warning_count === 1 ? "warning" : "warnings"}`
          : "No images found",
        wcagRefs: ["WCAG 1.1.1"],
        altTextData: altResult
          ? {
              totalImages: altResult.total_images,
              goodCount: altResult.good_count,
              badCount: altResult.bad_count,
              warningCount: altResult.warning_count,
              flaggedImages: altResult.images.filter((img) => img.status !== "pass"),
            }
          : undefined,
      },
      {
        // #5 contrast — scanned live by evidence.js (computed-style WCAG sweep +
        // pixel-sampling for text over images); emitted as "na" placeholder here.
        id: "contrast", num: 5, name: "Color Contrast",
        status: "na",
        description: "Measured live by the extension.",
        wcagRefs: ["WCAG 1.4.3"],
      },
      {
        // #6 resize — measured live by live-checks.js; emitted as "na" placeholder.
        id: "resize", num: 6, name: "Text Resize & Reflow",
        status: "na",
        description: "Measured live by the extension.",
        wcagRefs: ["WCAG 1.4.4", "WCAG 1.4.10"],
      },
      {
        id: "skip-link", num: 7, name: "Skip Link",
        status: skipResult ? (skipResult.score === "pass" ? "pass" : skipResult.score === "partial" ? "warning" : "fail") : "fail",
        description: skipResult
          ? (skipResult.has_skip_link
              ? (skipResult.issues.length > 0 ? skipResult.issues.join("; ") : "Skip link found and working")
              : "No skip link found")
          : "Could not check skip link",
        wcagRefs: ["WCAG 2.4.1"],
      },
      {
        // #8 keyboard — measured live by live-checks.js; emitted as "na" placeholder.
        id: "keyboard", num: 8, name: "Keyboard Navigation & Focus",
        status: "na",
        description: "Measured live by the extension.",
        wcagRefs: ["WCAG 2.1.1", "WCAG 2.4.7"],
      },
      {
        id: "forms", num: 9, name: "Forms & Labels",
        status: formsPageResult
          ? (formsPageResult.labels.score === "fail" || formsPageResult.required_fields.score === "fail"
              ? "fail"
              : formsPageResult.labels.score === "warning" || formsPageResult.required_fields.score === "warning"
                ? "warning"
                : formsPageResult.labels.score === "not_applicable" ? "na" : "pass")
          : "na",
        description: formsPageResult
          ? !formsPageResult.has_forms
            ? "No form elements detected"
            : `${formsPageResult.field_count} form fields: ${formsPageResult.labels.pass_count} pass, ${formsPageResult.labels.fail_count} fail, ${formsPageResult.labels.warning_count} warnings`
          : "Automated forms check unavailable",
        wcagRefs: ["WCAG 1.3.1", "WCAG 3.3.2"],
        formsData: formsPageResult
          ? {
              hasForms: formsPageResult.has_forms,
              formCount: formsPageResult.form_count,
              fieldCount: formsPageResult.field_count,
              fields: formsPageResult.fields.map((f) => ({
                type: f.type, name: f.name, id: f.id,
                labelText: f.label_text, labelMethod: f.label_method,
                labelQuality: f.label_quality, labelIssue: f.label_issue || undefined,
                requiredMatch: f.required_match, requiredIssue: f.required_issue || undefined,
              })),
              labels: {
                score: formsPageResult.labels.score,
                passCount: formsPageResult.labels.pass_count,
                warningCount: formsPageResult.labels.warning_count,
                failCount: formsPageResult.labels.fail_count,
                findings: formsPageResult.labels.findings,
              },
              requiredFields: {
                score: formsPageResult.required_fields.score,
                passCount: formsPageResult.required_fields.pass_count,
                warningCount: formsPageResult.required_fields.warning_count,
                failCount: formsPageResult.required_fields.fail_count,
                findings: formsPageResult.required_fields.findings,
                hasRequiredLegend: formsPageResult.required_fields.has_required_legend,
              },
            }
          : undefined,
      },
      {
        id: "moving", num: 10, name: "Moving, Blinking Content",
        status: motionCheck.status, description: motionCheck.description,
        wcagRefs: ["WCAG 2.2.2"],
      },
      {
        id: "captions", num: 11, name: "Video Captions",
        status: mediaPageResult
          ? (mediaPageResult.captions.score === "not_applicable" ? "na"
              : mediaPageResult.captions.score === "fail" ? "fail"
                : mediaPageResult.captions.score === "warning" ? "warning" : "pass")
          : "na",
        description: mediaPageResult ? mediaPageResult.captions.reason : "Automated captions check unavailable",
        wcagRefs: ["WCAG 1.2.2"],
        mediaData: mediaPageResult
          ? {
              hasMedia: mediaPageResult.has_media,
              mediaCount: mediaPageResult.media_count,
              mediaItems: mediaPageResult.media_items.map((m) => ({
                type: m.type, src: m.src, platform: m.platform,
                has_captions: m.has_captions,
                has_audio_description: m.has_audio_description,
                has_transcript_link: m.has_transcript_link,
                transcript_link_text: m.transcript_link_text || undefined,
              })),
              captions: mediaPageResult.captions,
              transcripts: mediaPageResult.transcripts,
              audioDescription: mediaPageResult.audio_description,
            }
          : undefined,
      },
      {
        id: "transcripts", num: 12, name: "Audio Transcripts",
        status: mediaPageResult
          ? (mediaPageResult.transcripts.score === "not_applicable" ? "na"
              : mediaPageResult.transcripts.score === "fail" ? "fail"
                : mediaPageResult.transcripts.score === "warning" ? "warning" : "pass")
          : "na",
        description: mediaPageResult ? mediaPageResult.transcripts.reason : "Automated transcripts check unavailable",
        wcagRefs: ["WCAG 1.2.1"],
      },
      {
        id: "structure", num: 13, name: "Basic Structure",
        status: structureCheck.status, description: structureCheck.description,
        wcagRefs: ["WCAG 1.3.1"],
      },
    ];

    const failedChecks = checks.filter((c) => c.status === "fail").length;
    return { url, title: titleResult?.title || pageTitle, passed: failedChecks === 0, issueCount: failedChecks, checks };
  }

  // Public: take a capture from captureTabAudit() -> AuditPageResult.
  return async function assemblePageAuditLocal(capture) {
    return assemble({
      url: capture.url,
      html: capture.html,
      title: capture.title,
      lang: capture.lang,
    });
  };
})();
