// extract-headings.js — injicē aktīvajā lapā ar chrome.scripting.executeScript()
// Eksportē visu redzamo lapas saturu kā Markdown ar fonta anotācijām un tagiem.
// IIFE — pēdējā izteiksmes vērtība atgriežas kā rezultāts popup.js
(() => {
  var BLOCK_TAGS = {
    P:1,DIV:1,H1:1,H2:1,H3:1,H4:1,H5:1,H6:1,LI:1,OL:1,UL:1,
    TABLE:1,THEAD:1,TBODY:1,TFOOT:1,TR:1,TD:1,TH:1,BLOCKQUOTE:1,PRE:1,
    FIGURE:1,FIGCAPTION:1,SECTION:1,ARTICLE:1,NAV:1,HEADER:1,FOOTER:1,
    MAIN:1,ASIDE:1,DETAILS:1,SUMMARY:1,DT:1,DD:1,FORM:1,FIELDSET:1,
    ADDRESS:1,HR:1,LABEL:1,BUTTON:1
  };
  var SKIP_TAGS = {SCRIPT:1,STYLE:1,NOSCRIPT:1,SVG:1,TEMPLATE:1,IFRAME:1,CANVAS:1};

  function isVis(el) {
    try {
      var s = window.getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") return false;
      if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;

      // Detect sr-only / visually-hidden patterns (screen-reader only)
      if (s.position === "absolute") {
        // clip: rect(0,0,0,0) or rect(1px,1px,1px,1px) pattern
        var clip = s.clip;
        if (clip && (clip.indexOf("rect(0") !== -1 || clip.indexOf("rect(1px") !== -1)) {
          return false;
        }
        // clip-path: inset(50%) or inset(100%) pattern
        var clipPath = s.clipPath;
        if (clipPath && (clipPath.indexOf("inset(50%)") !== -1 || clipPath.indexOf("inset(100%)") !== -1)) {
          return false;
        }
        // Off-screen positioning (left: -9999px, top: -9999px, etc.)
        var left = parseInt(s.left, 10);
        var top = parseInt(s.top, 10);
        if (!isNaN(left) && left < -9000) return false;
        if (!isNaN(top) && top < -9000) return false;
      }
    } catch(e) { return false; }
    return true;
  }

  function hasBlockChild(el) {
    for (var i = 0; i < el.children.length; i++) {
      if (el.children[i].tagName in BLOCK_TAGS) return true;
    }
    return false;
  }

  function getFontInfo(el, includeTag) {
    var s = window.getComputedStyle(el);
    var size = Math.round(parseFloat(s.fontSize));
    var weight = parseInt(s.fontWeight) || 400;
    var info = size + "px";
    if (weight >= 700) info += " bold";
    if (includeTag) info += ", " + el.tagName.toLowerCase();
    return info;
  }

  function inlineToMd(node) {
    var parts = [];
    for (var i = 0; i < node.childNodes.length; i++) {
      var ch = node.childNodes[i];
      if (ch.nodeType === 3) {
        parts.push(ch.textContent);
      } else if (ch.nodeType === 1) {
        var t = ch.tagName;
        if (t in SKIP_TAGS) continue;
        if (t === "BR") { parts.push("\n"); continue; }
        if (t === "A") {
          var lt = (ch.textContent || "").replace(/\s+/g, " ").trim();
          var hr = ch.getAttribute("href") || "";
          if (lt && hr && hr !== "#" && hr.indexOf("javascript:") !== 0) {
            parts.push("[" + lt + "](" + hr + ")");
          } else if (lt) {
            parts.push(lt);
          }
          continue;
        }
        if (t === "IMG") {
          var alt = ch.getAttribute("alt") || "";
          if (alt) parts.push("![" + alt + "]");
          continue;
        }
        if (t === "STRONG" || t === "B") {
          var bt = (ch.textContent || "").replace(/\s+/g, " ").trim();
          if (bt) parts.push("**" + bt + "**");
          continue;
        }
        if (t === "EM" || t === "I") {
          var et = (ch.textContent || "").replace(/\s+/g, " ").trim();
          if (et) parts.push("*" + et + "*");
          continue;
        }
        if (t === "CODE") {
          parts.push("`" + (ch.textContent || "") + "`");
          continue;
        }
        if (!(t in BLOCK_TAGS)) {
          parts.push(inlineToMd(ch));
        }
      }
    }
    return parts.join("");
  }

  var output = [];

  function extractLeaf(el) {
    var text = inlineToMd(el).replace(/[ \t]+/g, " ").trim();

    var tag = el.tagName;
    var isHeading = /^H[1-6]$/.test(tag);

    // Virsrakstiem ar bloka bērniem inlineToMd var atgriezt tukšu — izmanto textContent
    if (!text && isHeading) {
      text = (el.textContent || "").replace(/\s+/g, " ").trim();
    }
    if (!text) return;
    var fi = getFontInfo(el, !isHeading);
    var md = "";

    if (isHeading) {
      md = "#".repeat(parseInt(tag[1])) + " " + text;
    } else if (tag === "LI") {
      var par = el.parentElement;
      if (par && par.tagName === "OL") {
        var lis = par.querySelectorAll(":scope > li");
        var idx = Array.prototype.indexOf.call(lis, el) + 1;
        md = idx + ". " + text;
      } else {
        md = "- " + text;
      }
    } else if (tag === "BLOCKQUOTE") {
      md = "> " + text;
    } else if (tag === "PRE") {
      md = "```\n" + el.textContent.trim() + "\n```";
    } else if (tag === "DT") {
      md = "**" + text + "**";
    } else if (tag === "TH") {
      md = "| **" + text + "** ";
    } else if (tag === "TD") {
      md = "| " + text + " ";
    } else if (tag === "FIGCAPTION") {
      md = "*" + text + "*";
    } else if (tag === "SUMMARY") {
      md = "\u25b8 " + text;
    } else if (tag === "HR") {
      md = "---";
      fi = null;
    } else {
      md = text;
    }

    if (!isHeading) {
      var parentLink = el.closest("a[href]");
      if (parentLink) {
        var href = parentLink.getAttribute("href") || "";
        if (href && href !== "#" && href.indexOf("javascript:") !== 0) {
          if (md.indexOf("](") === -1) {
            md = "[" + md + "](" + href + ")";
          }
        }
      }
    }

    output.push({md: md, fontInfo: fi});
  }

  function walk(el) {
    if (el.nodeType !== 1) return;
    if (el.tagName in SKIP_TAGS) return;
    if (!isVis(el)) return;

    var tag = el.tagName;

    // Virsraksti vienmēr ir "lapas" — pat ja satur bloka bērnus (piem. <h1><p>...</p></h1>)
    if (/^H[1-6]$/.test(tag)) {
      extractLeaf(el);
      return;
    }

    if (tag in BLOCK_TAGS && !hasBlockChild(el)) {
      extractLeaf(el);
      return;
    }

    var inlineParts = [];

    for (var i = 0; i < el.childNodes.length; i++) {
      var ch = el.childNodes[i];
      if (ch.nodeType === 3) {
        var txt = ch.textContent;
        if (txt.trim()) inlineParts.push(txt);
      } else if (ch.nodeType === 1) {
        if (ch.tagName in SKIP_TAGS) continue;
        if (ch.tagName in BLOCK_TAGS) {
          if (inlineParts.length > 0) {
            var merged = inlineParts.join("").replace(/\s+/g, " ").trim();
            if (merged) {
              output.push({md: merged, fontInfo: getFontInfo(el, true)});
            }
            inlineParts = [];
          }
          walk(ch);
        } else {
          if ((ch.textContent || "").trim()) {
            if (ch.tagName === "A") {
              var lt = (ch.textContent || "").replace(/\s+/g, " ").trim();
              var hr = ch.getAttribute("href") || "";
              if (lt && hr && hr !== "#" && hr.indexOf("javascript:") !== 0) {
                inlineParts.push("[" + lt + "](" + hr + ")");
              } else if (lt) {
                inlineParts.push(lt);
              }
            } else {
              inlineParts.push(inlineToMd(ch));
            }
          }
        }
      }
    }

    if (inlineParts.length > 0) {
      var merged = inlineParts.join("").replace(/\s+/g, " ").trim();
      if (merged) {
        output.push({md: merged, fontInfo: getFontInfo(el, true)});
      }
    }
  }

  walk(document.body);

  // Formatējam ar fonta anotācijām
  var lines = [];
  for (var i = 0; i < output.length; i++) {
    var item = output[i];
    if (item.fontInfo) {
      lines.push(item.md + " `[" + item.fontInfo + "]`");
    } else {
      lines.push(item.md);
    }
  }

  // Check if element is in accessibility tree
  function isInA11yTree(el) {
    // Check aria-hidden, inert, closed details/dialog on element or ancestors
    var current = el;
    while (current && current !== document.body) {
      if (current.getAttribute("aria-hidden") === "true") return false;
      if (current.hasAttribute("inert")) return false;
      // Closed <details> hides children except <summary>
      if (current.tagName === "DETAILS" && !current.open && el.tagName !== "SUMMARY") return false;
      // Closed <dialog> hides all children
      if (current.tagName === "DIALOG" && !current.open) return false;
      current = current.parentElement;
    }
    // Check if role removes semantics
    var role = el.getAttribute("role");
    if (role === "presentation" || role === "none") return false;
    // Check display:none / visibility:hidden / content-visibility:hidden (not in a11y tree)
    try {
      var s = window.getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") return false;
      if (s.contentVisibility === "hidden") return false;
    } catch(e) { return false; }
    return true;
  }

  // Virsrakstu koks — tīra pašreizējā struktūra no DOM
  // Include both native headings (h1-h6) AND ARIA headings (role="heading")
  var nativeHeadings = document.querySelectorAll("h1, h2, h3, h4, h5, h6");
  var ariaHeadings = document.querySelectorAll('[role="heading"][aria-level]');

  // Combine and deduplicate (native heading might also have role="heading")
  var allHeadings = [];
  var seen = new Set();

  for (var i = 0; i < nativeHeadings.length; i++) {
    allHeadings.push({ el: nativeHeadings[i], level: parseInt(nativeHeadings[i].tagName[1]), isAria: false });
    seen.add(nativeHeadings[i]);
  }
  for (var i = 0; i < ariaHeadings.length; i++) {
    if (!seen.has(ariaHeadings[i])) {
      var ariaLevel = parseInt(ariaHeadings[i].getAttribute("aria-level")) || 2;
      allHeadings.push({ el: ariaHeadings[i], level: ariaLevel, isAria: true });
    }
  }

  // Sort by document order
  allHeadings.sort(function(a, b) {
    var pos = a.el.compareDocumentPosition(b.el);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  var headingOutline = [];
  for (var hi = 0; hi < allHeadings.length; hi++) {
    var item = allHeadings[hi];
    var h = item.el;
    var level = item.level;
    var hText = h.textContent.replace(/\s+/g, " ").trim();
    if (hText) {
      var indent = "  ".repeat(level - 1);
      var visuallyHidden = !isVis(h);
      var inA11yTree = isInA11yTree(h);
      var tags = [];
      if (visuallyHidden) tags.push("slepts");
      if (!inA11yTree) tags.push("nav-a11y");
      if (item.isAria) tags.push("aria");
      var tagStr = tags.length > 0 ? " [" + tags.join(", ") + "]" : "";
      headingOutline.push(indent + "H" + level + ": " + hText + tagStr);
    }
  }

  var headings = nativeHeadings; // Keep for headingCount compatibility

  // === NEW: Detect heading-related ARIA issues ===
  var headingIssues = [];

  // 1. role="heading" without aria-level
  var badAriaHeadings = document.querySelectorAll('[role="heading"]:not([aria-level])');
  for (var i = 0; i < badAriaHeadings.length; i++) {
    var el = badAriaHeadings[i];
    var text = el.textContent.replace(/\s+/g, " ").trim().substring(0, 50);
    headingIssues.push({
      type: "aria_heading_no_level",
      element: text || "(empty)",
      message: "role=\"heading\" without aria-level"
    });
  }

  // 2. Conflicting aria-level on native heading (e.g., <h2 aria-level="4">)
  for (var i = 0; i < nativeHeadings.length; i++) {
    var el = nativeHeadings[i];
    var ariaLevel = el.getAttribute("aria-level");
    if (ariaLevel) {
      var nativeLevel = parseInt(el.tagName[1]);
      var declaredLevel = parseInt(ariaLevel);
      if (nativeLevel !== declaredLevel) {
        var text = el.textContent.replace(/\s+/g, " ").trim().substring(0, 50);
        headingIssues.push({
          type: "conflicting_aria_level",
          element: text || "(empty)",
          message: "<" + el.tagName.toLowerCase() + "> with aria-level=\"" + ariaLevel + "\" (conflicts)"
        });
      }
    }
  }

  // 3. role="presentation" or role="none" on native heading
  for (var i = 0; i < nativeHeadings.length; i++) {
    var el = nativeHeadings[i];
    var role = el.getAttribute("role");
    if (role === "presentation" || role === "none") {
      var text = el.textContent.replace(/\s+/g, " ").trim().substring(0, 50);
      headingIssues.push({
        type: "heading_role_removed",
        element: text || "(empty)",
        message: "<" + el.tagName.toLowerCase() + "> with role=\"" + role + "\" (semantics removed)"
      });
    }
  }

  // 4. aria-hidden="true" on visible heading
  for (var i = 0; i < nativeHeadings.length; i++) {
    var el = nativeHeadings[i];
    if (el.getAttribute("aria-hidden") === "true" && isVis(el)) {
      var text = el.textContent.replace(/\s+/g, " ").trim().substring(0, 50);
      headingIssues.push({
        type: "visible_aria_hidden",
        element: text || "(empty)",
        message: "Visible heading with aria-hidden=\"true\""
      });
    }
  }

  // 5. Interactive element with role="heading"
  var interactiveHeadings = document.querySelectorAll('button[role="heading"], a[role="heading"], input[role="heading"], select[role="heading"]');
  for (var i = 0; i < interactiveHeadings.length; i++) {
    var el = interactiveHeadings[i];
    var text = el.textContent.replace(/\s+/g, " ").trim().substring(0, 50);
    headingIssues.push({
      type: "interactive_heading",
      element: text || "(empty)",
      message: "<" + el.tagName.toLowerCase() + "> with role=\"heading\" (interactive element)"
    });
  }

  return {
    url: window.location.href,
    title: document.title,
    headingCount: headings.length,
    headingOutline: headingOutline,
    headingIssues: headingIssues,
    markdown: lines.join("\n\n"),
  };
})();
