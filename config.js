// config.js — personal (no-login) build. Only the modular-worker base URL is
// needed; the extension calls the public /w/* workers directly with no auth.

// "dev" talks to api-dev, "prod" to api. Flip for release.
const ENV = "dev"; // "dev" | "prod"

const URLS = {
  prod: { WORKER_URL: "https://api.wcagpilot.com" },
  dev: { WORKER_URL: "https://api-dev.wcagpilot.com" },
};

const CONFIG = {
  ENV,
  WORKER_URL: URLS[ENV].WORKER_URL,
};
