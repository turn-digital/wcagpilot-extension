// config.js — all configuration in one place

const DEV_MODE = true; // true = lokālā promptu testēšana, false = produkcija

const CONFIG = {
  // Accounts service — vienmēr produkcija (autentifikācija strādā pret prod)
  ACCOUNTS_URL: "https://auth.wcagpilot.com",
  // Worker for AI checks and data — dev režīmā iet uz lokālo worker
  WORKER_URL: DEV_MODE ? "http://localhost:8787" : "https://api.wcagpilot.com",
  // Google OAuth client ID
  GOOGLE_CLIENT_ID:
    "268844119090-fde6bu1ldovlmt7ap41dal4pq0f95d8a.apps.googleusercontent.com",
};
