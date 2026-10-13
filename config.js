// config.js — personal build. Needs the modular-worker base URL plus a personal
// ACCESS KEY (issued to you). The /w/* workers reject any call without a valid
// key, so the audit won't run until you paste yours in below.

// "dev" talks to api-dev, "prod" to api. Flip for release.
const ENV = "dev"; // "dev" | "prod"

// ── ACCESS KEY ───────────────────────────────────────────────────────────────
// Paste the access key you were given between the quotes, e.g.
//   const CLIENT_TOKEN = "TESTER_janis_x7q2...";
// Without it the audit stops with "No access key set". The key is personal —
// don't share it. If it stops working ("Access key rejected"), ask for a new one.
const CLIENT_TOKEN = "";
// ─────────────────────────────────────────────────────────────────────────────

const URLS = {
  prod: { WORKER_URL: "https://api.wcagpilot.com" },
  dev: { WORKER_URL: "https://api-dev.wcagpilot.com" },
};

const CONFIG = {
  ENV,
  WORKER_URL: URLS[ENV].WORKER_URL,
  CLIENT_TOKEN,
};
