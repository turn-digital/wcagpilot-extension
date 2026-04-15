// popup.js — WCAGpilot Extension UI
// All API/auth functions are in api.js (loaded before this file)
// i18n.js provides I18N object for translations

// ============================================================
// Translation helper - shorthand for I18N.t()
// ============================================================
const t = (key, params) => I18N.t(key, params);

// ============================================================
// UI configuration
// ============================================================
let UI = {
  dashboard_url: "https://wcagpilot.com/app",
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

      // Update dashboard URL
      if (data.dashboard_url) {
        UI.dashboard_url = data.dashboard_url;
      }
    }
  } catch (err) {
    // Failed to load UI from server, using defaults
  }
}

// ============================================================
// Refresh dynamic UI elements after language change
// ============================================================
function refreshDynamicUI() {
  // Refresh plan label in profile
  if (currentUser) {
    const plan = currentUser.plan || "free";
    const planEl = $("profile-plan");
    if (planEl) {
      planEl.textContent = plan === "pro" ? t('ui.plan_pro') : t('ui.plan_free');
    }
  }

  // Refresh limits text if visible
  if (currentLimits) {
    updateLimits(currentLimits);
  }
}

// ============================================================
// Language picker setup
// ============================================================
function setupLanguagePickers() {
  const selects = document.querySelectorAll('.lang-select');
  selects.forEach(select => {
    // Clear and populate
    select.innerHTML = '';
    I18N.available.forEach(lang => {
      const option = document.createElement('option');
      option.value = lang.code;
      option.textContent = `${lang.flag} ${lang.name}`;
      if (lang.code === I18N.lang) {
        option.selected = true;
      }
      select.appendChild(option);
    });

    // Handle change
    select.addEventListener('change', async (e) => {
      await I18N.setLanguage(e.target.value);
      // Update all selects to match
      document.querySelectorAll('.lang-select').forEach(s => {
        s.value = I18N.lang;
      });
      // Refresh dynamic UI elements (plan label, etc.)
      refreshDynamicUI();
    });
  });
}

// ============================================================
// DOM references
// ============================================================
const $ = (id) => document.getElementById(id);

const sections = {
  login: $("login-section"),
  onboard: $("onboard-section"),
  home: $("home-section"),
  loading: $("loading-section"),
  result: $("result-section"),
  history: $("history-section"),
  profile: $("profile-section"),
  limit: $("limit-section"),
  error: $("error-section"),
};

// ============================================================
// State
// ============================================================
let currentUser = null;
let currentLimits = null;
let lastResult = null;
let currentUrl = "";

// ============================================================
// UI state management
// ============================================================
function showSection(name) {
  Object.values(sections).forEach((s) => {
    if (s) s.classList.add("hidden");
  });
  if (sections[name]) {
    sections[name].classList.remove("hidden");
  } else {
    // Section not found - fallback to login section
    if (sections.login) sections.login.classList.remove("hidden");
  }
}

// ============================================================
// Onboarding
// ============================================================
let onboardSlide = 1;
const ONBOARD_TOTAL = 3;
const ONBOARD_SEEN_KEY = "wcagpilot_onboard_seen";

function initOnboarding() {
  const nextBtn = $("onboard-next-btn");
  const skipBtn = $("onboard-skip-btn");

  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      if (onboardSlide < ONBOARD_TOTAL) {
        // Hide current slide
        const currentSlideEl = document.querySelector(`[data-slide="${onboardSlide}"]`);
        const currentDotEl = document.querySelector(`[data-dot="${onboardSlide}"]`);
        if (currentSlideEl) currentSlideEl.classList.add("hidden");
        if (currentDotEl) currentDotEl.classList.remove("active");

        onboardSlide++;

        // Show next slide
        const nextSlideEl = document.querySelector(`[data-slide="${onboardSlide}"]`);
        const nextDotEl = document.querySelector(`[data-dot="${onboardSlide}"]`);
        if (nextSlideEl) nextSlideEl.classList.remove("hidden");
        if (nextDotEl) nextDotEl.classList.add("active");

        // Update button text on last slide
        if (onboardSlide === ONBOARD_TOTAL) {
          nextBtn.textContent = "Get started";
          const skipWrap = document.querySelector(".onboard-skip");
          if (skipWrap) skipWrap.style.display = "none";
        }
      } else {
        // Finish onboarding
        finishOnboarding();
      }
    });
  }

  if (skipBtn) {
    skipBtn.addEventListener("click", (e) => {
      e.preventDefault();
      finishOnboarding();
    });
  }
}

function finishOnboarding() {
  localStorage.setItem(ONBOARD_SEEN_KEY, "1");
  showHome();
}

function shouldShowOnboarding() {
  return !localStorage.getItem(ONBOARD_SEEN_KEY);
}

// ============================================================
// Home screen
// ============================================================
async function showHome() {
  // Update profile initial
  if (currentUser) {
    const initial = (currentUser.name || currentUser.email || "?").charAt(0).toUpperCase();
    const profileInitial = $("profile-initial");
    const loadingProfileInitial = $("loading-profile-initial");
    if (profileInitial) profileInitial.textContent = initial;
    if (loadingProfileInitial) loadingProfileInitial.textContent = initial;
  }

  // Update limits
  if (currentLimits) {
    updateLimits(currentLimits);
  }

  // Get current tab URL
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      currentUrl = tab.url;
      $("current-url").textContent = tab.url;
    }
  } catch (err) {
    $("current-url").textContent = "Unable to get current page";
  }

  showSection("home");
}

function updateLimits(limits) {
  currentLimits = limits;
  const used = limits.used || 0;
  const total = limits.limit || 20;
  const percent = Math.round((used / total) * 100);

  $("limits-text").textContent = `${used} / ${total} checks`;
  $("limits-progress").style.width = percent + "%";

  // Change color when limit reached
  if (used >= total) {
    $("limits-progress").style.background = "#8b1a0e";
  } else {
    $("limits-progress").style.background = "#66ba1e";
  }
}

// ============================================================
// Profile/Account screen
// ============================================================
function showProfile() {
  if (currentUser) {
    $("profile-name").textContent = currentUser.name || currentUser.email || "";
    $("profile-email").textContent = currentUser.email || "";
    const plan = currentUser.plan || "free";
    const planEl = $("profile-plan");
    if (planEl) {
      planEl.textContent = plan === "pro" ? t('ui.plan_pro') : t('ui.plan_free');
      planEl.className = "profile-plan" + (plan === "pro" ? " profile-plan-pro" : "");
    }
  }
  showSection("profile");
}

// ============================================================
// Result screen
// ============================================================
function showResult(data) {
  lastResult = data;

  // Update URL
  $("result-url").textContent = currentUrl;

  // Determine compliance: only "fail" causes non-compliance
  const compliant = Array.isArray(data.checks) && data.checks.every((c) => c.status !== "fail");
  const hasWarnings = Array.isArray(data.checks) && data.checks.some((c) => c.status === "warning");

  // Update verdict box
  const verdictBox = $("verdict-box");
  const verdictTitle = $("verdict-title");
  const verdictSummary = $("verdict-summary");

  if (compliant && !hasWarnings) {
    verdictBox.className = "verdict-box verdict-pass";
    verdictTitle.textContent = t('verdicts.pass_short');
  } else if (compliant && hasWarnings) {
    verdictBox.className = "verdict-box verdict-warning";
    verdictTitle.textContent = t('verdicts.warning_short');
  } else {
    verdictBox.className = "verdict-box verdict-fail";
    verdictTitle.textContent = t('verdicts.fail_short');
  }

  verdictSummary.textContent = data.summary || "";

  // Build checks list
  const checksList = $("checks-list");
  checksList.innerHTML = "";

  if (data.checks && data.checks.length > 0) {
    data.checks.forEach((check) => {
      const div = document.createElement("div");
      div.className = "check-item";

      let icon, iconClass, labelClass;
      if (check.status === "pass") {
        icon = "✓";
        iconClass = "check-icon check-icon-pass";
        labelClass = "check-label";
      } else if (check.status === "warning") {
        icon = "⚠";
        iconClass = "check-icon check-icon-warning";
        labelClass = "check-label check-label-warning";
      } else {
        icon = "✗";
        iconClass = "check-icon check-icon-fail";
        labelClass = "check-label check-label-fail";
      }
      const label = checkLabel(check.id);

      div.innerHTML = `
        <span class="${iconClass}">${icon}</span>
        <span class="${labelClass}">${escapeHtml(label)}</span>
      `;
      checksList.appendChild(div);
    });
  }

  // Change button text based on result: "See how to fix it" vs "View full report"
  const detailsBtn = $("details-btn");
  detailsBtn.classList.remove("hidden");
  if (compliant && !hasWarnings) {
    detailsBtn.textContent = t('ui.btn_details_pass');
  } else {
    detailsBtn.textContent = t('ui.btn_details');
  }

  // Update limits if returned
  if (data.limits) {
    updateLimits(data.limits);
  }

  showSection("result");
}

function checkLabel(id) {
  return t(`checks.${id}`) !== `checks.${id}` ? t(`checks.${id}`) : id;
}

// ============================================================
// History screen
// ============================================================
function renderHistory(data) {
  const list = $("history-list");
  list.innerHTML = "";

  if (!data.checks || data.checks.length === 0) {
    list.innerHTML = `<p class="history-empty">${t('history.empty')}</p>`;
    showSection("history");
    return;
  }

  data.checks.forEach((check) => {
    const div = document.createElement("div");
    div.className = "history-item";

    const isPass = check.issues_count === 0;
    const badgeClass = isPass ? "history-badge history-badge-pass" : "history-badge history-badge-fail";
    const badgeText = isPass ? "OK" : `${check.issues_count} ${check.issues_count === 1 ? "issue" : "issues"}`;

    div.innerHTML = `
      <span class="history-item-url">${escapeHtml(truncateUrl(check.url, 45))}</span>
      <span class="history-item-meta">
        <span class="${badgeClass}">${badgeText}</span>
        <span>${formatDate(check.created_at)}</span>
      </span>
    `;

    // Click to open in dashboard
    div.addEventListener("click", () => {
      openCheckInDashboard(check.id);
    });

    list.appendChild(div);
  });

  showSection("history");
}

/** Truncate URL showing start and end */
function truncateUrl(url, maxLength) {
  if (!url || url.length <= maxLength) return url;

  // Remove protocol for display
  let display = url.replace(/^https?:\/\//, "");

  if (display.length <= maxLength) return display;

  // Show start...end
  const keepChars = Math.floor((maxLength - 3) / 2);
  return display.slice(0, keepChars) + "..." + display.slice(-keepChars);
}

/** Open specific check in dashboard */
function openCheckInDashboard(checkId) {
  chrome.storage.local.get(["auth"], (data) => {
    let url = UI.dashboard_url + "?id=" + checkId;
    if (data.auth?.token) {
      url += "&ext_token=" + encodeURIComponent(data.auth.token);
    }
    chrome.tabs.create({ url });
  });
}

function formatDate(dateStr) {
  // Server returns UTC dates without 'Z' suffix - add it if missing
  const normalized = dateStr.endsWith("Z") || dateStr.includes("+") ? dateStr : dateStr + "Z";
  const date = new Date(normalized);
  const now = new Date();
  const diffMs = now - date;
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffHours < 1) return "Just now";
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ============================================================
// Error & Limit screens
// ============================================================
function showError(message) {
  $("error-message").textContent = message;
  showSection("error");
}

function showLimitReached(limits) {
  const resetDate = limits.resets_at
    ? new Date(limits.resets_at).toLocaleDateString(I18N.lang, { month: "long", day: "numeric", year: "numeric" })
    : "next month";
  $("limit-info").textContent = t('ui.limit_info', { used: limits.used, limit: limits.limit, date: resetDate });
  showSection("limit");
}

// ============================================================
// Utility functions
// ============================================================
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

async function openDashboardWithToken() {
  const data = await chrome.storage.local.get(["auth"]);
  let url = UI.dashboard_url;

  if (data.auth?.token) {
    const separator = url.includes("?") ? "&" : "?";
    url = url + separator + "ext_token=" + encodeURIComponent(data.auth.token);
  }

  chrome.tabs.create({ url });
}

// ============================================================
// Event handlers
// ============================================================
async function handleCheck() {
  try {
    showSection("loading");
    $("loading-text").textContent = t('ui.loading_extract');

    const headings = await extractFromActiveTab();

    if (headings.headingCount === 0) {
      showError(t('ui.no_headings'));
      return;
    }

    $("loading-text").textContent = t('ui.loading_analyze');

    // Send to server with language for Gemini summaries
    const geminiLang = I18N.strings?.gemini_language || 'English';
    const result = await checkPage(headings, geminiLang);

    if (result.error?.code === "LIMIT_EXCEEDED") {
      showLimitReached(result.error.details);
      return;
    }

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
    $("loading-text").textContent = "Loading history...";
    const data = await getHistory();
    renderHistory(data);
  } catch (err) {
    showError(err.message);
  }
}

// ============================================================
// Event listeners
// ============================================================

// Login buttons
$("google-btn").addEventListener("click", async () => {
  $("google-btn").disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ action: "login", provider: "google" });
    if (response?.success) {
      currentUser = response.data?.user;
      currentLimits = response.data?.limits;

      // Check if should show onboarding
      if (shouldShowOnboarding()) {
        showSection("onboard");
      } else {
        await showHome();
      }
    } else {
      showError(response?.error || "Login failed");
    }
  } catch (err) {
    showError(err?.message || "Login failed");
  } finally {
    $("google-btn").disabled = false;
  }
});

$("email-login-btn").addEventListener("click", () => {
  const url = UI.dashboard_url + (UI.dashboard_url.includes("?") ? "&" : "?") + "login=email";
  chrome.tabs.create({ url });
});

// Home screen
$("check-btn").addEventListener("click", handleCheck);
$("history-link").addEventListener("click", (e) => {
  e.preventDefault();
  handleHistory();
});
$("profile-btn").addEventListener("click", showProfile);
$("get-more-link").addEventListener("click", (e) => {
  e.preventDefault();
  openDashboardWithToken();
});

// Result screen
$("result-back-btn").addEventListener("click", showHome);
$("details-btn").addEventListener("click", () => {
  if (lastResult?.check_id) {
    openCheckInDashboard(lastResult.check_id);
  } else {
    openDashboardWithToken();
  }
});

// History screen
$("history-back-btn").addEventListener("click", showHome);

// Profile screen
$("profile-back-btn").addEventListener("click", showHome);
$("dashboard-btn").addEventListener("click", openDashboardWithToken);
$("logout-btn").addEventListener("click", async () => {
  await chrome.storage.local.remove(["auth"]);
  currentUser = null;
  currentLimits = null;
  showSection("login");
});

// Limit screen
$("limit-back-btn").addEventListener("click", showHome);
$("upgrade-btn").addEventListener("click", openDashboardWithToken);

// Error screen
$("error-back-btn").addEventListener("click", showHome);
$("error-retry-btn").addEventListener("click", handleCheck);

// Initialize onboarding
initOnboarding();

// ============================================================
// Startup
// ============================================================
(async () => {
  try {
    // Initialize i18n first (loads translations)
    await I18N.init();

    // Setup language pickers
    setupLanguagePickers();

    // Show loading state while checking auth
    $("loading-text").textContent = t('ui.loading');

    // Check storage first (fast, no network)
    const data = await chrome.storage.local.get(["auth"]);

    // Load UI from server (don't block on this)
    loadUIFromServer();

    if (data.auth?.token) {
      try {
        const result = await verifyToken();
        currentUser = result.user;
        currentLimits = result.limits;

        // Check if should show onboarding
        if (shouldShowOnboarding()) {
          showSection("onboard");
        } else {
          showHome();
        }
      } catch (err) {
        const errMsg = err?.message || String(err);
        // Only clear auth if it's a 401 (invalid token), not network errors
        if (errMsg.includes("401") || errMsg.includes("Session expired")) {
          await chrome.storage.local.remove(["auth"]);
          showSection("login");
        } else {
          // Network error - show home with cached data
          currentUser = data.auth.user;
          showHome();
        }
      }
    } else {
      showSection("login");
    }
  } catch (startupErr) {
    // Catch-all: if anything fails during startup, show login
    showSection("login");
  }
})();
