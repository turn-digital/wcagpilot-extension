// api.js — Session-based auth, Worker communication, heading extraction
// Configuration comes from config.js (loaded before this file)

const ACCOUNTS_URL = CONFIG.ACCOUNTS_URL;  // Auth endpoints
const WORKER_URL = CONFIG.WORKER_URL;      // Check/history endpoints
const GOOGLE_CLIENT_ID = CONFIG.GOOGLE_CLIENT_ID;
const REDIRECT_URI = chrome.identity.getRedirectURL();

// =============================================
// PKCE helpers (Web Crypto API)
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
// Worker requests (Authorization header with session token)
// =============================================

async function workerFetch(endpoint, options = {}) {
  const data = await chrome.storage.local.get(["auth"]);
  if (!data.auth?.token) throw new Error("Not authenticated");

  const headers = {
    "Content-Type": "application/json",
    Authorization: "Bearer " + data.auth.token,
    ...options.headers,
  };

  const response = await fetch(WORKER_URL + endpoint, { ...options, headers });

  if (response.status === 401) {
    await chrome.storage.local.remove(["auth"]);
    throw new Error("Session expired — please sign in again");
  }

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error?.message || "Error (" + response.status + ")");
  }

  return result;
}

/**
 * Google OAuth token exchange — sends auth code to Accounts service, receives session_token.
 * Public endpoint — no Bearer token required.
 */
async function exchangeGoogleCode({ code, code_verifier, redirect_uri }) {
  const response = await fetch(ACCOUNTS_URL + "/api/auth/google", {
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

async function verifyToken() {
  const data = await chrome.storage.local.get(["auth"]);
  if (!data.auth?.token) throw new Error("Not authenticated");

  console.log("[WCAGpilot] verifyToken: Verifying with auth worker...");

  const response = await fetch(ACCOUNTS_URL + "/api/auth/verify", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + data.auth.token,
    },
  });

  console.log("[WCAGpilot] verifyToken: Response status:", response.status);

  if (response.status === 401) {
    await chrome.storage.local.remove(["auth"]);
    throw new Error("Session expired — please sign in again");
  }

  const result = await response.json();
  console.log("[WCAGpilot] verifyToken: Result:", result);

  if (!response.ok) {
    throw new Error(result.error?.message || "Error (" + response.status + ")");
  }

  // Use user from response (includes plan), or fall back to cached user
  const user = result.user || data.auth.user;

  // Update stored auth with latest user data (includes plan from auth)
  if (result.user) {
    await chrome.storage.local.set({
      auth: {
        ...data.auth,
        user: result.user,
      },
    });
    console.log("[WCAGpilot] verifyToken: Updated stored user with plan:", result.user.plan);
  }

  // Use limits from auth response (now stored in central-auth DB)
  let limits = result.limits || null;
  if (limits) {
    console.log("[WCAGpilot] verifyToken: Limits from auth:", limits);
  } else {
    // Fallback: fetch from API worker (which also reads from AUTH_DB now)
    try {
      limits = await getLimits();
      console.log("[WCAGpilot] verifyToken: Limits fetched from API:", limits);
    } catch (err) {
      console.log("[WCAGpilot] Failed to fetch limits:", err?.message || err);
    }
  }

  return {
    user: user,
    limits: limits,
  };
}

async function logout() {
  const data = await chrome.storage.local.get(["auth"]);
  if (data.auth?.token) {
    try {
      await fetch(ACCOUNTS_URL + "/api/auth/logout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + data.auth.token,
        },
      });
    } catch {
      // Ignore errors on logout
    }
  }
  await chrome.storage.local.remove(["auth"]);
}

async function checkPage(headingsData) {
  return workerFetch("/api/check", {
    method: "POST",
    body: JSON.stringify(headingsData),
  });
}

async function getHistory(limit = 20, offset = 0) {
  return workerFetch("/api/history?limit=" + limit + "&offset=" + offset);
}

async function getLimits() {
  return workerFetch("/api/limits");
}

// =============================================
// OAuth — Google (Auth Code + PKCE)
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

  const responseUrl = await launchAuthFlow(authUrl.toString());
  const code = extractCodeFromUrl(responseUrl);

  // Exchange code for session_token via Worker (server-side, with client_secret)
  const result = await exchangeGoogleCode({
    code,
    code_verifier: codeVerifier,
    redirect_uri: REDIRECT_URI,
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
// OAuth helpers
// =============================================

function launchAuthFlow(url) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive: true }, (responseUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!responseUrl) {
        reject(new Error("No response from auth provider"));
      } else {
        resolve(responseUrl);
      }
    });
  });
}

/**
 * Extract authorization code from redirect URL.
 * Auth Code flow: code comes as query parameter (?code=xxx),
 * not in URL fragment (#access_token=xxx) like old Implicit Grant.
 */
function extractCodeFromUrl(responseUrl) {
  const url = new URL(responseUrl);
  const code = url.searchParams.get("code");
  if (!code) {
    const error = url.searchParams.get("error");
    const errorDesc = url.searchParams.get("error_description");
    throw new Error(errorDesc || error || "No authorization code received");
  }
  return code;
}

// =============================================
// Heading extraction from active tab
// =============================================

async function extractFromActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    throw new Error("No active tab");
  }

  // Cannot inject into chrome://, edge://, about: pages
  if (
    tab.url?.startsWith("chrome://") ||
    tab.url?.startsWith("chrome-extension://") ||
    tab.url?.startsWith("edge://") ||
    tab.url?.startsWith("about:")
  ) {
    throw new Error("Cannot check browser internal pages");
  }

  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["extract-headings.js"],
  });

  if (!result?.result) {
    throw new Error("Failed to extract headings from page");
  }

  return result.result;
}

