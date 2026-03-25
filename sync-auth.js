// sync-auth.js — Content script that syncs auth between web app and extension
// This runs on wcagpilot.com/app/* pages

(function() {
  // Only run once per page load
  if (window.__wcagpilot_sync_done) return;
  window.__wcagpilot_sync_done = true;

  // Track if app had auth (to detect logout vs never-logged-in)
  let appHadAuth = false;
  // Track if we synced from extension (to prevent logout loop)
  let syncedFromExtension = false;

  // Sync FROM app TO extension
  function syncAuthToExtension(isLogout = false) {
    try {
      const stored = localStorage.getItem("auth");

      // If this is an explicit logout (had auth, now doesn't)
      // But don't sync if we just synced FROM extension
      if (isLogout && !stored && !syncedFromExtension) {
        chrome.runtime.sendMessage({ action: "clearAuth" }, () => {
          if (chrome.runtime.lastError) return;
          console.log("[WCAGpilot] Logout synced to extension");
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
        if (response?.success) {
          console.log("[WCAGpilot] Auth synced to extension");
        }
      });
    } catch (err) {
      // Ignore errors
    }
  }

  // Sync FROM extension TO app (if app has no auth)
  function syncAuthFromExtension() {
    try {
      // Check if app already has auth
      const stored = localStorage.getItem("auth");
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          if (parsed.token) return; // App already has auth
        } catch {}
      }

      // Ask extension for auth
      chrome.runtime.sendMessage({ action: "getAuth" }, (response) => {
        if (chrome.runtime.lastError) return;

        if (response?.auth?.token) {
          console.log("[WCAGpilot] Auth received from extension");
          syncedFromExtension = true;
          appHadAuth = true;
          localStorage.setItem("auth", JSON.stringify(response.auth));
          // Notify React app
          window.dispatchEvent(new CustomEvent("wcagpilot:auth-from-extension"));
        }
      });
    } catch (err) {
      // Ignore errors
    }
  }

  // Listen for logout message from extension
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "logout") {
      console.log("[WCAGpilot] Logout received from extension");
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

  // On page load: sync both directions
  syncAuthToExtension();
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
})();
