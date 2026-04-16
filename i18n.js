// i18n.js — Internationalization for WCAGpilot Extension
// Fetches translations from wcagpilot.com/locales/{lang}.json

const I18N = {
  // Current language code
  lang: 'en',

  // Available languages (loaded from manifest)
  available: [],

  // Current translations
  strings: null,

  // Fallback strings (English) in case fetch fails
  fallback: {
    meta: { code: 'en', name: 'English' },
    ui: {
      language: 'Language',
      loading: 'Analyzing...',
      loading_warning: 'Do not close this window',
      btn_check: 'Check this page',
      btn_login: 'Sign in',
      btn_login_google: 'Sign in with Google',
      btn_login_email: 'Sign in with Email',
      btn_logout: 'Sign out',
      btn_dashboard: 'Open Dashboard',
      btn_copy: 'Copy result',
      btn_copied: 'Copied!',
      btn_share: 'Share',
      btn_details: 'See how to fix it',
      btn_details_pass: 'View full report',
      btn_recheck: 'Check again',
      btn_cancel: 'Cancel',
      login_prompt: 'Sign in to check pages',
      login_benefits: '20 free checks per month',
      welcome: 'Welcome, {name}',
      checks_remaining: '{remaining} of {limit} checks remaining',
      limit_resets: 'Resets {date}',
      result_for: 'Results for',
      no_issues: 'No issues found',
      untitled: 'Untitled',
      plan_free: 'Free Plan',
      plan_pro: 'Pro Plan',
      loading_extract: 'Reading headings...',
      loading_analyze: 'Analyzing heading structure...',
      no_headings: 'This page has no headings (h1–h6).',
      onboard_step: 'Step {current} of {total}',
      onboard_1: 'Open the page you want to check',
      onboard_2: 'Get a clear answer — does it meet WCAG?',
      onboard_3: 'Send the results to your developer',
      onboard_next: 'Next',
      onboard_start: 'Get started',
      onboard_skip: 'Skip'
    },
    verdicts: {
      pass: 'WCAG Compliant',
      pass_icon: '✓ Passed',
      warning: 'WCAG Compliant (review needed)',
      warning_icon: '⚠ Review needed',
      fail: 'WCAG Non-compliant',
      fail_icon: '✗ Failed'
    },
    checks: {
      presence: 'Heading presence',
      h1_first: 'H1 heading',
      hierarchy: 'Hierarchy order',
      empty_headings: 'Empty headings',
      aria_misuse: 'ARIA heading errors',
      visual_headings: 'Visual headings',
      content_match: 'Content match',
      logical_structure: 'Logical structure'
    },
    errors: {
      network_error: 'Network error. Please try again.',
      unknown_error: 'An error occurred'
    },
    history: {
      title: 'History',
      empty: 'No checks yet'
    }
  },

  // Base URL for translations
  baseUrl: 'https://wcagpilot.com/locales',

  /**
   * Initialize i18n - load language preference and translations
   */
  async init() {
    // Load saved language preference
    const data = await chrome.storage.local.get(['lang']);
    this.lang = data.lang || this.detectBrowserLanguage();

    // Load available languages
    await this.loadManifest();

    // Load translations
    await this.loadTranslations(this.lang);

    // Apply translations to DOM
    this.applyTranslations();

    return this.strings;
  },

  /**
   * Detect browser language and match to available
   */
  detectBrowserLanguage() {
    const browserLang = navigator.language.split('-')[0];
    const available = ['en', 'lv', 'de', 'fr', 'es'];
    return available.includes(browserLang) ? browserLang : 'en';
  },

  /**
   * Load available languages from manifest
   */
  async loadManifest() {
    try {
      const response = await fetch(`${this.baseUrl}/manifest.json`);
      if (response.ok) {
        const manifest = await response.json();
        this.available = manifest.locales || [];
      }
    } catch (err) {
      // Use default list
      this.available = [
        { code: 'en', name: 'English' },
        { code: 'lv', name: 'Latviešu' },
        { code: 'de', name: 'Deutsch' },
        { code: 'fr', name: 'Français' },
        { code: 'es', name: 'Español' }
      ];
    }
  },

  /**
   * Load translations for a specific language
   */
  async loadTranslations(lang) {
    try {
      const response = await fetch(`${this.baseUrl}/${lang}.json`);
      if (response.ok) {
        this.strings = await response.json();
        this.lang = lang;
      } else {
        throw new Error('Failed to load');
      }
    } catch (err) {
      // Fallback to English or built-in strings
      if (lang !== 'en') {
        try {
          const enResponse = await fetch(`${this.baseUrl}/en.json`);
          if (enResponse.ok) {
            this.strings = await enResponse.json();
            this.lang = 'en';
          } else {
            this.strings = this.fallback;
          }
        } catch (_) {
          this.strings = this.fallback;
        }
      } else {
        this.strings = this.fallback;
      }
    }
  },

  /**
   * Change language and reload translations
   */
  async setLanguage(lang) {
    await chrome.storage.local.set({ lang });
    this.lang = lang;
    await this.loadTranslations(lang);
    this.applyTranslations();

    // Notify other contexts (sync with web)
    try {
      chrome.runtime.sendMessage({ action: 'languageChanged', lang });
    } catch (_) {}

    return this.strings;
  },

  /**
   * Get a translation by key path (e.g., 'ui.btn_check')
   * Supports interpolation: t('ui.welcome', { name: 'John' })
   */
  t(keyPath, params = {}) {
    const keys = keyPath.split('.');
    let value = this.strings;

    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
        value = value[key];
      } else {
        // Try fallback
        value = this.fallback;
        for (const k of keys) {
          if (value && typeof value === 'object' && k in value) {
            value = value[k];
          } else {
            return keyPath; // Return key if not found
          }
        }
        break;
      }
    }

    if (typeof value !== 'string') {
      return keyPath;
    }

    // Interpolate {param} placeholders
    return value.replace(/\{(\w+)\}/g, (match, key) => {
      return params[key] !== undefined ? params[key] : match;
    });
  },

  /**
   * Apply translations to all elements with data-i18n attribute
   */
  applyTranslations() {
    // Elements with data-i18n attribute
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const text = this.t(key);
      if (text !== key) {
        el.textContent = text;
      }
    });

    // Elements with data-i18n-placeholder attribute
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      const text = this.t(key);
      if (text !== key) {
        el.placeholder = text;
      }
    });

    // Elements with data-i18n-title attribute
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const key = el.getAttribute('data-i18n-title');
      const text = this.t(key);
      if (text !== key) {
        el.title = text;
      }
    });

    // Onboarding step text (e.g., "Step 1 of 3")
    document.querySelectorAll('[data-onboard-step]').forEach(el => {
      const step = el.getAttribute('data-onboard-step');
      el.textContent = this.t('ui.onboard_step', { current: step, total: 3 });
    });

    // Update html lang attribute
    document.documentElement.lang = this.lang;
  },

  /**
   * Get check label by ID
   */
  checkLabel(id) {
    return this.t(`checks.${id}`) || id;
  },

  /**
   * Get verdict text
   */
  verdict(type, withIcon = false) {
    const key = withIcon ? `verdicts.${type}_icon` : `verdicts.${type}`;
    return this.t(key);
  }
};

// Export for use in popup.js
window.I18N = I18N;
