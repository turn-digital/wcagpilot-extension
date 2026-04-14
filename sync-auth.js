// sync-auth.js — Content script that syncs auth and language between web app and extension
// This runs on wcagpilot.com/app/* pages

(function() {
  // Only run once per page load
  if (window.__wcagpilot_sync_done) return;
  window.__wcagpilot_sync_done = true;

  const LANG_STORAGE_KEY = 'wcagpilot_lang';

  // Track if app had auth (to detect logout vs never-logged-in)
  let appHadAuth = false;
  // Track if we synced from extension (to prevent logout loop)
  let syncedFromExtension = false;
  // Track if language was synced from extension (to prevent sync loop)
  let langSyncedFromExtension = false;

  // Sync FROM app TO extension
  function syncAuthToExtension(isLogout = false) {
    try {
      const stored = localStorage.getItem("auth");

      // If this is an explicit logout (had auth, now doesn't)
      // But don't sync if we just synced FROM extension
      if (isLogout && !stored && !syncedFromExtension) {
        chrome.runtime.sendMessage({ action: "clearAuth" }, () => {
          if (chrome.runtime.lastError) return;
        });
        appHadAuth = false;
        return;
      }

      // Reset flag
      syncedFromExtension = false;

      // No auth - don't do anything
      if (!stored) return;

      const authData = JSON.parse(stored);
      if (!authData.token) return;

      // App has auth - sync to extension
      appHadAuth = true;
      chrome.runtime.sendMessage({
        action: "syncAuth",
        auth: {
          token: authData.token,
          provider: authData.provider || "web",
          user: authData.user,
        },
      }, (response) => {
        if (chrome.runtime.lastError) return;
      });
    } catch (err) {
      // Ignore errors
    }
  }

  // Sync FROM extension TO app
  function syncAuthFromExtension() {
    try {
      // Check if app already has auth
      const stored = localStorage.getItem("auth");
      let appHasAuth = false;
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          if (parsed.token) appHasAuth = true;
        } catch {}
      }

      // Always ask extension for auth status
      chrome.runtime.sendMessage({ action: "getAuth" }, (response) => {
        if (chrome.runtime.lastError) return;

        if (response?.auth?.token) {
          // Extension has auth
          if (!appHasAuth) {
            // App doesn't have auth, sync from extension
            syncedFromExtension = true;
            appHadAuth = true;
            localStorage.setItem("auth", JSON.stringify(response.auth));
            // Notify React app
            window.dispatchEvent(new CustomEvent("wcagpilot:auth-from-extension"));
          } else {
            // Both have auth - safe to sync app→extension (keeps them in sync)
            syncAuthToExtension();
          }
        } else {
          // Extension has NO auth
          if (appHasAuth) {
            // App has auth but extension doesn't - user logged out in extension
            syncedFromExtension = true;
            appHadAuth = false;
            localStorage.removeItem("auth");
            // Notify React app
            window.dispatchEvent(new CustomEvent("wcagpilot:logout-from-extension"));
          }
        }
      });
    } catch (err) {
      // Ignore errors
    }
  }

  // Listen for logout message from extension
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "logout") {
      appHadAuth = false;
      syncedFromExtension = true; // Prevent syncing this logout back
      localStorage.removeItem("auth");
      window.dispatchEvent(new CustomEvent("wcagpilot:logout-from-extension"));
      sendResponse({ success: true });
    }
    return false;
  });

  // Check initial state
  const initialAuth = localStorage.getItem("auth");
  if (initialAuth) {
    try {
      const parsed = JSON.parse(initialAuth);
      if (parsed.token) appHadAuth = true;
    } catch {}
  }

  // On page load: check extension status FIRST, then sync if needed
  // We must check extension before syncing app→extension, otherwise
  // we'd re-login the extension if user logged out while app was closed
  syncAuthFromExtension();

  // Listen for storage changes
  window.addEventListener("storage", (e) => {
    if (e.key === "auth") {
      const isLogout = appHadAuth && !e.newValue;
      syncAuthToExtension(isLogout);
    }
  });

  // Listen for custom event from the app
  window.addEventListener("wcagpilot:auth-changed", () => {
    const hasAuth = !!localStorage.getItem("auth");
    const isLogout = appHadAuth && !hasAuth;
    syncAuthToExtension(isLogout);
  });

  // ========== LANGUAGE SYNC ==========

  // Sync language FROM extension TO app
  function syncLangFromExtension() {
    try {
      chrome.runtime.sendMessage({ action: "getLang" }, (response) => {
        if (chrome.runtime.lastError) return;

        if (response?.lang) {
          const appLang = localStorage.getItem(LANG_STORAGE_KEY);
          if (response.lang !== appLang) {
            langSyncedFromExtension = true;
            localStorage.setItem(LANG_STORAGE_KEY, response.lang);
            // Notify React app about language change
            window.dispatchEvent(new CustomEvent("wcagpilot:lang-from-extension", {
              detail: { lang: response.lang }
            }));
          }
        }
      });
    } catch (err) {
      // Ignore errors
    }
  }

  // Sync language FROM app TO extension
  function syncLangToExtension(lang) {
    if (langSyncedFromExtension) {
      langSyncedFromExtension = false;
      return;
    }
    try {
      chrome.runtime.sendMessage({ action: "setLang", lang }, () => {
        if (chrome.runtime.lastError) return;
      });
    } catch (err) {
      // Ignore errors
    }
  }

  // Listen for language change from extension
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "languageChanged") {
      langSyncedFromExtension = true;
      localStorage.setItem(LANG_STORAGE_KEY, message.lang);
      window.dispatchEvent(new CustomEvent("wcagpilot:lang-from-extension", {
        detail: { lang: message.lang }
      }));
      sendResponse({ success: true });
    }
    return false;
  });

  // Listen for language change event from web app
  window.addEventListener("wcagpilot:lang-changed", (e) => {
    const lang = e.detail?.lang || localStorage.getItem(LANG_STORAGE_KEY);
    if (lang) {
      syncLangToExtension(lang);
    }
  });

  // Sync language on page load (extension → app)
  syncLangFromExtension();
})();
