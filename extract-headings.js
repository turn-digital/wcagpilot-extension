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

  // Virsrakstu koks — tīra pašreizējā struktūra no DOM
  var headings = document.querySelectorAll("h1, h2, h3, h4, h5, h6");
  var headingOutline = [];
  for (var hi = 0; hi < headings.length; hi++) {
    var h = headings[hi];
    var level = parseInt(h.tagName[1]);
    var hText = h.textContent.replace(/\s+/g, " ").trim();
    if (hText) {
      var indent = "  ".repeat(level - 1);
      var hidden = !isVis(h) ? " [slepts]" : "";
      headingOutline.push(indent + "H" + level + ": " + hText + hidden);
    }
  }

  return {
    url: window.location.href,
    title: document.title,
    headingCount: headings.length,
    headingOutline: headingOutline,
    markdown: lines.join("\n\n"),
  };
})();
