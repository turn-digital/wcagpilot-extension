// config.js — all configuration in one place

const CONFIG = {
  // Accounts service for authentication
  ACCOUNTS_URL: "https://auth.wcagpilot.com",

  // Worker for AI checks and data
  // LOCAL DEV: use localhost (run: cd workers/worker-wcagpilot && npm run dev)
  WORKER_URL: "http://127.0.0.1:8787",
  // PRODUCTION: uncomment this and comment out the line above
  // WORKER_URL: "https://api.wcagpilot.com",

  // Google OAuth client ID
  GOOGLE_CLIENT_ID:
    "268844119090-fde6bu1ldovlmt7ap41dal4pq0f95d8a.apps.googleusercontent.com",
};
