WCAGpilot (personal) — Accessibility audit extension
=====================================================
Chrome or Edge. Audits the CURRENT tab (including pages behind login/VPN)
and downloads a self-contained HTML report with screenshots.

INSTALL (one time)
------------------
1. Get the code from git (either clone the repo, or use GitHub's
   "Code -> Download ZIP" and unzip it). You need the "extension" folder
   that contains this file. Keep it somewhere permanent — Chrome loads the
   extension live from this folder, it does not copy it. If you move or
   delete the folder, the extension breaks.
2. Open chrome://extensions  (Edge: edge://extensions)
3. Turn ON "Developer mode" (top-right toggle).
4. Click "Load unpacked" and select the "extension" folder.
5. The WCAGpilot icon appears in the toolbar (pin it via the puzzle icon).

To UPDATE later: git pull (or re-download), then click the refresh/reload
icon on the extension's card at chrome://extensions.

RUN AN AUDIT
------------
1. Go to the page you want to check (log in first if it needs login).
2. Click the WCAGpilot toolbar icon.
   -> A small window opens and runs the audit on that tab.
3. You WILL see a yellow bar: "WCAGpilot started debugging this browser."
   This is EXPECTED — it's how the real keyboard-Tab focus check works.
   Do NOT click "Cancel" on that bar; leave it until the audit finishes.
4. Don't switch tabs/windows while it runs (it needs the page in front to
   screenshot and to walk the keyboard focus). Takes ~20-60 seconds.
5. When done it auto-downloads an HTML report to your Downloads folder:
   a11y-audit-<site>-<date>.html
6. Open that HTML file in a browser to read the results. It is fully
   self-contained (screenshots embedded) — you can email it as-is.

WHAT TO REPORT BACK
-------------------
- Did every check produce a result, or did any say "Couldn't analyze"?
- Keyboard check: does "Tested X of Y focusable elements" look complete
  (X close to Y), or does it stall at a low number?
- Do the alt-text / contrast findings show screenshots?
- Anything that looks wrong, missing, or confusing in the report.
- Which site/page you tested + attach the downloaded HTML report.

NOTES
-----
- Chrome and Edge both work. Firefox does NOT (uses a different extension API).
- The extension talks only to api-dev.wcagpilot.com; it never sends the
  gated page's URL, only the extracted content it reads in your browser.
- If the toolbar click does nothing, reload the extension on the
  chrome://extensions page and try again.
