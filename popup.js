// popup.js — UI stāvokļi, notikumu apstrāde, orķestrācija
// Visas API/auth funkcijas ir api.js (ielādēts pirms šī faila)

// ============================================================
// Server-driven UI — labels, HTML templates, and config loaded from worker
// ============================================================
let UI = {
  labels: {
    // Algorithmic checks (1-4)
    check_presence: "Virsrakstu esamība",
    check_h1_first: "H1 virsraksts",
    check_hierarchy: "Hierarhijas secība",
    check_empty_headings: "Tukši virsraksti",
    // LLM checks (5-7) - IDs from Gemini
    check_visual_headings: "Vizuālie virsraksti",
    check_content_match: "Satura atbilstība",
    check_logical_structure: "Loģiskā struktūra",
    // Legacy IDs
    check_semantic_quality: "Semantiskā kvalitāte",
    check_visual_match: "Vizuālā atbilstība",
    check_language_quality: "Valodas kvalitāte",
    badge_pass: "✅ Atbilst WCAG",
    badge_fail: "❌ Neatbilst WCAG",
    btn_check: "Pārbaudīt šo lapu",
    btn_history: "Vēsture",
    btn_dashboard: "Atvērt paneli",
    btn_recheck: "Pārbaudīt vēlreiz",
    btn_copy: "Kopēt rezultātu",
    btn_copied: "Nokopēts!",
    loading_extract: "Nolasa virsrakstus...",
    loading_analyze: "Analizē virsrakstus ar AI...",
    no_headings: "Šajā lapā nav neviena virsraksta (h1–h6).",
    history_empty: "Nav pārbaužu.",
  },
  dashboard_url: "https://wcagpilot-web.pages.dev/app",
  // HTML template for profile section (loaded from server)
  profile_html: null,
};

async function loadUIFromServer() {
  try {
    const response = await fetch(CONFIG.WORKER_URL + "/api/ui");
    if (response.ok) {
      const data = await response.json();

      // Inject CSS
      if (data.css) {
        const style = document.createElement("style");
        style.id = "server-styles";
        style.textContent = data.css;
        document.head.appendChild(style);
      }

      // Update labels
      if (data.labels) {
        UI.labels = { ...UI.labels, ...data.labels };
      }

      // Update dashboard URL
      if (data.dashboard_url) {
        UI.dashboard_url = data.dashboard_url;
      }

      // Store profile HTML template
      if (data.profile_html) {
        UI.profile_html = data.profile_html;
      }

      // Update button texts with server labels
      $("check-btn").textContent = UI.labels.btn_check;
      $("history-btn").textContent = UI.labels.btn_history;
      $("dashboard-btn").textContent = UI.labels.btn_dashboard;
      $("recheck-btn").textContent = UI.labels.btn_recheck;
      $("copy-btn").textContent = UI.labels.btn_copy;

      console.log("[A11y] UI loaded from server, version:", data.version);
    }
  } catch (err) {
    console.warn("[A11y] Failed to load UI from server, using defaults:", err.message);
  }
}

// ============================================================
// DOM references
// ============================================================
const $ = (id) => document.getElementById(id);

const sections = {
  login: $("login-section"),
  profile: $("profile-section"),
  loading: $("loading-section"),
  result: $("result-section"),
  history: $("history-section"),
  limit: $("limit-section"),
  error: $("error-section"),
};

// ============================================================
// UI state management
// ============================================================
let previousSection = "profile";

function showSection(name) {
  Object.values(sections).forEach((s) => s.classList.add("hidden"));
  sections[name].classList.remove("hidden");
}

function showProfile(user, limits) {
  // Use server-driven HTML if available
  if (UI.profile_html) {
    const used = limits?.used || 0;
    const total = limits?.limit || 20;
    const percent = Math.round((used / total) * 100);
    const progressColor = used >= total ? "#ea4335" : "#1a73e8";

    let html = UI.profile_html
      .replace("{{name}}", escapeHtml(user.name || user.email))
      .replace("{{email}}", escapeHtml(user.email))
      .replace("{{picture}}", user.picture || "")
      .replace("{{picture_style}}", user.picture ? "" : "display:none")
      .replace("{{used}}", String(used))
      .replace("{{limit}}", String(total))
      .replace("{{percent}}", String(percent))
      .replace("{{progress_color}}", progressColor);

    sections.profile.innerHTML = html;
    // Re-attach event listeners after HTML replacement
    attachProfileListeners();
  } else {
    // Fallback: manually update elements
    $("profile-name").textContent = user.name || user.email;
    $("profile-email").textContent = user.email;
    $("profile-picture").src = user.picture || "";
    $("profile-picture").style.display = user.picture ? "" : "none";
    if (limits) updateLimits(limits);
  }

  previousSection = "profile";
  showSection("profile");
}

async function openDashboardWithToken() {
  const data = await chrome.storage.local.get(["auth"]);
  let url = UI.dashboard_url;

  // Append token to URL so dashboard can pick it up
  if (data.auth?.token) {
    const separator = url.includes("?") ? "&" : "?";
    url = url + separator + "ext_token=" + encodeURIComponent(data.auth.token);
  }

  chrome.tabs.create({ url });
}

function attachProfileListeners() {
  const logoutBtn = $("logout-btn");
  const checkBtn = $("check-btn");
  const historyBtn = $("history-btn");
  const dashboardBtn = $("dashboard-btn");

  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await chrome.storage.local.remove(["auth"]);
      showSection("login");
    });
  }
  if (checkBtn) {
    checkBtn.addEventListener("click", handleCheck);
  }
  if (historyBtn) {
    historyBtn.addEventListener("click", handleHistory);
  }
  if (dashboardBtn) {
    dashboardBtn.addEventListener("click", openDashboardWithToken);
  }
}

function updateLimits(limits) {
  const used = limits.used || 0;
  const total = limits.limit || 20;
  $("limits-text").textContent = "Pārbaudes: " + used + "/" + total + " izmantotas";
  $("limits-progress").style.width = ((used / total) * 100) + "%";

  if (used >= total) {
    $("limits-progress").style.background = "#ea4335";
  } else {
    $("limits-progress").style.background = "#1a73e8";
  }
}

function showResult(data) {
  // Use server-driven HTML if available
  if (data.result_html) {
    sections.result.innerHTML = data.result_html;
    // Re-attach event listeners after HTML replacement
    attachResultListeners();
  } else {
    // Fallback: build HTML client-side
    const compliant = Array.isArray(data.checks) && data.checks.every((c) => c.status === "pass");

    // Compliance badge
    const badge = $("compliance-badge");
    if (compliant) {
      badge.textContent = UI.labels.badge_pass;
      badge.className = "compliance-badge badge-pass";
    } else {
      badge.textContent = UI.labels.badge_fail;
      badge.className = "compliance-badge badge-fail";
    }

    // Checks list
    const checksList = $("checks-list");
    checksList.innerHTML = "";
    if (data.checks && data.checks.length > 0) {
      data.checks.forEach((check) => {
        const div = document.createElement("div");
        div.className = "check-item check-" + check.status;
        const icon = check.status === "pass" ? "✅" : "❌";
        const label = checkLabel(check.id);

        let html = '<div class="check-header">' + icon + " " + escapeHtml(label) + "</div>";
        if (check.findings && check.findings.length > 0) {
          html += '<div class="check-findings">';
          check.findings.forEach((f) => {
            html += '<div class="finding-item">';
            html += '<div class="finding-element">' + escapeHtml(f.element) + "</div>";
            html += '<div class="finding-current">' + escapeHtml(f.current) + "</div>";
            html += '<div class="finding-expected">' + escapeHtml(f.expected) + "</div>";
            html += "</div>";
          });
          html += "</div>";
        }
        div.innerHTML = html;
        checksList.appendChild(div);
      });
    }

    // Outline comparison
    const outlineSection = $("outline-comparison");
    if (data.suggested_outline && data.suggested_outline.length > 0) {
      $("current-outline").textContent = (data.current_outline || []).join("\n");
      $("suggested-outline").textContent = data.suggested_outline.join("\n");
      outlineSection.classList.remove("hidden");
    } else {
      outlineSection.classList.add("hidden");
    }

    $("result-summary").textContent = data.summary || "";
  }

  if (data.limits) updateLimitsFromData(data.limits);
  previousSection = "result";
  showSection("result");
}

function attachResultListeners() {
  const recheckBtn = $("recheck-btn");
  const copyBtn = $("copy-btn");

  if (recheckBtn) {
    recheckBtn.addEventListener("click", handleCheck);
  }
  if (copyBtn) {
    copyBtn.addEventListener("click", copyResult);
  }
}

function updateLimitsFromData(limits) {
  // Update limits progress bar if it exists (for profile section)
  const limitsText = $("limits-text");
  const limitsProgress = $("limits-progress");
  if (limitsText && limitsProgress) {
    const used = limits.used || 0;
    const total = limits.limit || 20;
    limitsText.textContent = "Pārbaudes: " + used + "/" + total + " izmantotas";
    limitsProgress.style.width = ((used / total) * 100) + "%";
    limitsProgress.style.background = used >= total ? "#ea4335" : "#1a73e8";
  }
}

function checkLabel(id) {
  const key = "check_" + id;
  return UI.labels[key] || id;
}

function showError(message) {
  $("error-message").textContent = message;
  showSection("error");
}

function showLimitReached(limits) {
  const resetDate = limits.resets_at
    ? new Date(limits.resets_at).toLocaleDateString("lv")
    : "nākamā mēneša sākumā";
  $("limit-info").textContent =
    "Izmantoti " + limits.used + "/" + limits.limit + ". Limits atjaunojas: " + resetDate + ".";
  showSection("limit");
}

// ============================================================
// History rendering
// ============================================================
function renderHistory(data) {
  const list = $("history-list");
  list.innerHTML = "";

  if (!data.checks || data.checks.length === 0) {
    list.innerHTML = '<p style="color:#5f6368;font-size:13px">' + UI.labels.history_empty + '</p>';
    return;
  }

  data.checks.forEach((check) => {
    const div = document.createElement("div");
    div.className = "history-item";
    div.innerHTML =
      '<div class="history-item-url">' + escapeHtml(check.url) + "</div>" +
      '<div class="history-item-meta">' +
      "<span>" + "★".repeat(check.score || 0) + " (" + (check.issues_count || 0) + " problēmas)</span>" +
      "<span>" + new Date(check.created_at).toLocaleDateString("lv") + "</span>" +
      "</div>";
    list.appendChild(div);
  });

  showSection("history");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
// Copy result to clipboard
// ============================================================
let lastResult = null;

function copyResult() {
  if (!lastResult) return;
  const lines = [
    lastResult.compliant ? "WCAG: Atbilst" : "WCAG: Neatbilst",
    "",
  ];
  (lastResult.checks || []).forEach((check) => {
    const icon = check.status === "pass" ? "✅" : "❌";
    lines.push(icon + " " + checkLabel(check.id));
    check.findings.forEach((f) => {
      lines.push("  - " + f.current);
    });
  });
  lines.push("", lastResult.summary || "");

  navigator.clipboard.writeText(lines.join("\n")).then(() => {
    $("copy-btn").textContent = UI.labels.btn_copied;
    setTimeout(() => { $("copy-btn").textContent = UI.labels.btn_copy; }, 1500);
  });
}

// ============================================================
// Event handler functions (named for reuse after HTML replacement)
// ============================================================
async function handleCheck() {
  try {
    showSection("loading");
    $("loading-text").textContent = UI.labels.loading_extract;

    const headings = await extractFromActiveTab();

    if (headings.headingCount === 0) {
      showError(UI.labels.no_headings);
      return;
    }

    // Paralēli palaižam axe-core skenēšanu (fons, netiek rādīta lietotājam)
    // Nepārtrauc analīzi ja axe nestrādā — tā ir tikai papildus informācija
    $("loading-text").textContent = UI.labels.loading_analyze;

    // Sākam axe skenēšanu fonā
    const axePromise = runAxeScan().catch((err) => {
      console.warn("[A11y] Axe scan failed:", err.message);
      return { error: err.message };
    });

    // Gaidām axe rezultātu ar timeout (max 10 sekundes)
    const axeWithTimeout = Promise.race([
      axePromise,
      new Promise((resolve) => setTimeout(() => resolve({ error: "timeout" }), 10000)),
    ]);

    // Paralēli sūtam uz serveri headings + gaidām axe
    const [axeResults] = await Promise.all([axeWithTimeout]);

    // Pievieno axe rezultātus pieprasījumam
    const checkData = {
      ...headings,
      axeResults: axeResults,
    };

    const result = await checkPage(checkData);

    if (result.error?.code === "LIMIT_EXCEEDED") {
      showLimitReached(result.error.details);
      return;
    }

    lastResult = result;
    showResult(result);
  } catch (err) {
    if (err.message.includes("limit") || err.message.includes("429")) {
      try {
        const limits = await getLimits();
        showLimitReached(limits);
      } catch (_) {
        showError(err.message);
      }
    } else {
      showError(err.message);
    }
  }
}

async function handleHistory() {
  try {
    showSection("loading");
    $("loading-text").textContent = "Ielādē vēsturi...";
    const data = await getHistory();
    renderHistory(data);
  } catch (err) {
    showError(err.message);
  }
}

// ============================================================
// Event listeners (initial setup for static HTML elements)
// ============================================================
// ============================================================
// Login buttons
// ============================================================

// Email login - opens the app login page
$("email-login-btn").addEventListener("click", () => {
  chrome.tabs.create({ url: UI.dashboard_url });
});

$("google-btn").addEventListener("click", async () => {
  $("google-btn").disabled = true;
  try {
    // Send to background script (survives popup close)
    const response = await chrome.runtime.sendMessage({ action: "login", provider: "google" });
    if (response.success) {
      showProfile(response.data.user, response.data.limits);
    } else {
      showError(response.error);
    }
  } catch (err) {
    showError(err.message);
  } finally {
    $("google-btn").disabled = false;
  }
});

// Initial listeners for static HTML (will be re-attached when server HTML replaces content)
$("check-btn")?.addEventListener("click", handleCheck);
$("history-btn")?.addEventListener("click", handleHistory);
$("dashboard-btn")?.addEventListener("click", openDashboardWithToken);
$("logout-btn")?.addEventListener("click", async () => {
  await chrome.storage.local.remove(["auth"]);
  showSection("login");
});
$("recheck-btn")?.addEventListener("click", handleCheck);
$("copy-btn")?.addEventListener("click", copyResult);

$("history-back-btn").addEventListener("click", () => {
  showSection("profile");
});

$("limit-back-btn").addEventListener("click", () => {
  showSection("profile");
});

$("error-back-btn").addEventListener("click", () => {
  showSection(previousSection);
});

// ============================================================
// Startup — load UI from server, check existing session
// ============================================================
(async () => {
  // Load UI (CSS + labels) from server
  await loadUIFromServer();

  const data = await chrome.storage.local.get(["auth"]);
  console.log("[A11y] Startup - auth data:", data.auth ? "exists" : "missing");

  if (data.auth?.token) {
    try {
      const result = await verifyToken();
      console.log("[A11y] Token verified successfully");
      showProfile(result.user, result.limits);
    } catch (err) {
      console.error("[A11y] Token verification failed:", err.message);
      // Only clear auth if it's a 401 (invalid token), not network errors
      if (err.message.includes("401") || err.message.includes("Session expired")) {
        await chrome.storage.local.remove(["auth"]);
        showSection("login");
      } else {
        // Network error - show profile with cached data, don't force re-login
        console.log("[A11y] Network error, using cached auth");
        showProfile(data.auth.user, null);
      }
    }
  } else {
    showSection("login");
  }
})();
