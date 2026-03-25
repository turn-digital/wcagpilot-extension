// background.js — Service Worker for OAuth handling
// This runs persistently and won't close when popup loses focus

const WORKER_URL = "https://a11y-test-worker.peteris-6aa.workers.dev";
const GOOGLE_CLIENT_ID = "268844119090-fde6bu1ldovlmt7ap41dal4pq0f95d8a.apps.googleusercontent.com";
const REDIRECT_URI = chrome.identity.getRedirectURL();

// =============================================
// PKCE helpers
// =============================================

function base64urlEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64urlEncode(array);
}

async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64urlEncode(hash);
}

// =============================================
// Token exchange with Worker
// =============================================

async function exchangeGoogleCode({ code, code_verifier, redirect_uri }) {
  const response = await fetch(WORKER_URL + "/api/auth/google", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier, redirect_uri }),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error?.message || "Auth error (" + response.status + ")");
  }

  return result;
}

// =============================================
// Google OAuth flow
// =============================================

async function loginWithGoogle() {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  const responseUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true }, (url) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!url) {
        reject(new Error("No response from auth provider"));
      } else {
        resolve(url);
      }
    });
  });

  const code = new URL(responseUrl).searchParams.get("code");
  if (!code) {
    const error = new URL(responseUrl).searchParams.get("error_description") || "No code received";
    throw new Error(error);
  }

  const result = await exchangeGoogleCode({
    code,
    code_verifier: codeVerifier,
    redirect_uri: REDIRECT_URI,
  });

  // Save auth to storage (session_token instead of access_token)
  await chrome.storage.local.set({
    auth: {
      token: result.session_token,
      expiresAt: result.expires_at,
      provider: "google",
      user: result.user,
    },
  });

  return {
    provider: "google",
    token: result.session_token,
    expiresAt: result.expires_at,
    user: result.user,
    limits: result.limits,
  };
}

// =============================================
// Email code authentication
// =============================================

async function sendEmailCode(email) {
  const response = await fetch(WORKER_URL + "/api/auth/email/send-code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error?.message || "Failed to send code");
  }

  return result;
}

async function verifyEmailCode(email, code) {
  const response = await fetch(WORKER_URL + "/api/auth/email/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error?.message || "Invalid code");
  }

  // Save auth to storage
  await chrome.storage.local.set({
    auth: {
      token: result.session_token,
      expiresAt: result.expires_at,
      provider: "email",
      user: result.user,
    },
  });

  return {
    provider: "email",
    token: result.session_token,
    expiresAt: result.expires_at,
    user: result.user,
    limits: result.limits,
  };
}

// =============================================
// Message handling from popup
// =============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "login") {
    // Only Google is supported now
    loginWithGoogle()
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));

    return true; // Keep channel open for async response
  }

  if (message.action === "sendEmailCode") {
    sendEmailCode(message.email)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));

    return true;
  }

  if (message.action === "verifyEmailCode") {
    verifyEmailCode(message.email, message.code)
      .then((result) => sendResponse({ success: true, data: result }))
      .catch((err) => sendResponse({ success: false, error: err.message }));

    return true;
  }

  // Auth sync from web app content script
  if (message.action === "syncAuth") {
    const auth = message.auth;
    if (auth?.token) {
      chrome.storage.local.set({
        auth: {
          token: auth.token,
          provider: auth.provider || "web",
          user: auth.user,
        },
      }).then(() => {
        console.log("[WCAGpilot] Auth synced from web app");
        sendResponse({ success: true });
      }).catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
      return true;
    }
    sendResponse({ success: false, error: "No token provided" });
    return false;
  }

  // Clear auth (logout sync from app)
  if (message.action === "clearAuth") {
    chrome.storage.local.remove(["auth"]).then(() => {
      console.log("[WCAGpilot] Auth cleared (synced from app logout)");
      sendResponse({ success: true });
    }).catch(() => {
      sendResponse({ success: false });
    });
    return true;
  }

  // Get auth (for extension → app sync)
  if (message.action === "getAuth") {
    chrome.storage.local.get(["auth"]).then((data) => {
      sendResponse({ auth: data.auth || null });
    }).catch(() => {
      sendResponse({ auth: null });
    });
    return true;
  }
});

// =============================================
// Listen for auth changes to sync logout to app tabs
// =============================================
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === "local" && changes.auth) {
    // Auth was removed (logout)
    if (!changes.auth.newValue && changes.auth.oldValue) {
      console.log("[WCAGpilot] Auth removed, notifying app tabs");
      notifyAppTabsLogout();
    }
  }
});

async function notifyAppTabsLogout() {
  try {
    const tabs = await chrome.tabs.query({
      url: ["https://wcagpilot.com/app/*", "http://localhost/app/*", "http://localhost:*/app/*"]
    });

    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { action: "logout" }).catch(() => {
        // Tab might not have content script, ignore
      });
    }
  } catch (err) {
    console.log("[WCAGpilot] Error notifying tabs:", err.message);
  }
}

console.log("[WCAGpilot] Background service worker loaded");
