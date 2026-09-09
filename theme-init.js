// theme-init.js — pre-first-paint theme/privacy-mode setup.
//
// v326 security fix: this used to be an inline <script> block directly in index.html.
// The page's own Content-Security-Policy (script-src 'self', no 'unsafe-inline', no
// hash/nonce) sits in a <meta> tag earlier in <head>, and a CSP delivered via <meta>
// applies to everything parsed after it — so that inline block was being silently
// blocked by any browser actually enforcing the policy (a CSP violation in the
// console), meaning the no-flash theme/privacy-mode pre-apply it exists for never ran.
// Moving it to this external, same-origin file makes it satisfy 'self' like ledger.js
// already does — no hash to maintain, no CSP change needed.
//
// Referenced from index.html via <script src="theme-init.js"></script> in the exact
// same <head> position the inline block used to occupy, so it still runs before first
// paint. See the comments above that tag in index.html for what each part below does
// (v179/v195/v202/v245/v247/v249/v255).
        (function () {
            try {
                var MIDNIGHT_THEME = {
                    id: "midnight", bg: "#0a0a0f", cardBg: "#15151d", textMain: "#e8eaf0", textMuted: "#8b93a8",
                    borderColor: "rgba(255,255,255,0.14)",
                    cardTopBorderColor: "rgba(255,255,255,0.22)", /* v207: lockstep with ledger.js */
                    neuLight: "rgba(255,255,255,0.04)", neuDark: "rgba(0,0,0,0.55)",
                    neuPrimaryLight: "rgba(255,255,255,0.10)", neuPrimaryDark: "rgba(0,0,0,0.5)",
                    glassBg: "rgba(20,20,28,0.72)", glassBgStrong: "rgba(20,20,28,0.85)",
                    // v204: kept in lockstep with ledger.js's BG_THEMES "midnight" entry — see its
                    // comment for why this is now opaque with a dedicated visible border.
                    glassBgModal: "#181820", glassBorder: "rgba(255,255,255,0.12)", modalSheetBorder: "#4b5563",
                    hoverBg: "rgba(255,255,255,0.06)", pressBg: "rgba(255,255,255,0.10)",
                    activeBg: "rgba(99,102,241,0.18)", activeBorder: "rgba(129,140,248,0.35)", chipBg: "rgba(255,255,255,0.08)",
                    incomeChipBg: "rgba(52,211,153,0.15)", incomeChipBorder: "rgba(52,211,153,0.35)",
                    expenseChipBg: "rgba(248,113,113,0.15)", expenseChipBorder: "rgba(248,113,113,0.35)",
                    primaryChipBg: "rgba(129,140,248,0.15)",
                    cardShadow: "none",
                    hardwareTrackBg: "#2a231c", hardwareTrackBorder: "#46392c",
                    hardwareFillStart: "#6b5642", hardwareFillEnd: "#4a3a2a",
                    dropdownOptionBg: "#28282f",
                    primary: "#818cf8", incomeColor: "#34d399", expenseColor: "#f87171",
                    transferColor: "#60a5fa", salaryColor: "#fbbf24",
                    colorScheme: "dark", themeColor: "#0a0a0f",
                };
                // v206: second dark preset, duplicated here in lockstep with ledger.js's
                // BG_THEMES "slate" entry — same reasoning as MIDNIGHT_THEME above (BG_THEMES
                // itself only lives in ledger.js, which hasn't loaded yet at this point).
                var SLATE_THEME = {
                    id: "slate", bg: "#0f172a", cardBg: "#1e293b", textMain: "#e2e8f0", textMuted: "#94a3b8",
                    borderColor: "rgba(255,255,255,0.12)",
                    cardTopBorderColor: "rgba(255,255,255,0.12)", /* v209: reverted, lockstep with ledger.js */
                    neuLight: "rgba(255,255,255,0.04)", neuDark: "rgba(0,0,0,0.55)",
                    neuPrimaryLight: "rgba(255,255,255,0.10)", neuPrimaryDark: "rgba(0,0,0,0.5)",
                    glassBg: "rgba(30,41,59,0.72)", glassBgStrong: "rgba(30,41,59,0.85)",
                    glassBgModal: "#1e293b", glassBorder: "rgba(255,255,255,0.12)", modalSheetBorder: "#64748b",
                    hoverBg: "rgba(255,255,255,0.06)", pressBg: "rgba(255,255,255,0.10)",
                    activeBg: "rgba(99,102,241,0.18)", activeBorder: "rgba(129,140,248,0.35)", chipBg: "rgba(255,255,255,0.08)",
                    incomeChipBg: "rgba(52,211,153,0.15)", incomeChipBorder: "rgba(52,211,153,0.35)",
                    expenseChipBg: "rgba(248,113,113,0.15)", expenseChipBorder: "rgba(248,113,113,0.35)",
                    primaryChipBg: "rgba(129,140,248,0.15)",
                    cardShadow: "none",
                    hardwareTrackBg: "#2a231c", hardwareTrackBorder: "#46392c",
                    hardwareFillStart: "#6b5642", hardwareFillEnd: "#4a3a2a",
                    dropdownOptionBg: "#293548",
                    primary: "#818cf8", incomeColor: "#34d399", expenseColor: "#f87171",
                    transferColor: "#60a5fa", salaryColor: "#fbbf24",
                    colorScheme: "dark", themeColor: "#0f172a",
                };
                var isAuto = localStorage.getItem("ledgerBgThemeAuto") === "1";
                var systemPrefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
                var saved = JSON.parse(localStorage.getItem("ledgerBgTheme"));
                if (isAuto) {
                    if (systemPrefersDark) {
                        // v206: which dark preset Auto lands on is itself a saved choice now
                        // (see ledger.js's getAutoDarkThemeId()/setAutoDarkThemeId() — tapping
                        // either dark swatch, any time, updates this) — was unconditionally
                        // MIDNIGHT_THEME back when it was the only dark preset offered.
                        var autoDarkId = localStorage.getItem("ledgerBgThemeAutoDarkId");
                        saved = (autoDarkId === "slate") ? SLATE_THEME : MIDNIGHT_THEME;
                    } else {
                        var lightSnapshot = JSON.parse(localStorage.getItem("ledgerBgThemeLightSnapshot"));
                        if (lightSnapshot && lightSnapshot.bg) saved = lightSnapshot;
                    }
                }
                if (saved && saved.bg) {
                    var varMap = {
                        bg: "--bg-color", cardBg: "--card-bg", textMain: "--text-main", textMuted: "--text-muted",
                        borderColor: "--border-color", neuLight: "--neu-light", neuDark: "--neu-dark",
                        neuPrimaryLight: "--neu-primary-light", neuPrimaryDark: "--neu-primary-dark",
                        glassBg: "--glass-bg", glassBgStrong: "--glass-bg-strong",
                        glassBgModal: "--glass-bg-modal", glassBorder: "--glass-border",
                        modalSheetBorder: "--modal-sheet-border",
                        hoverBg: "--hover-bg", pressBg: "--press-bg", activeBg: "--active-bg",
                        activeBorder: "--active-border", chipBg: "--chip-bg",
                        incomeChipBg: "--income-chip-bg", incomeChipBorder: "--income-chip-border",
                        expenseChipBg: "--expense-chip-bg", expenseChipBorder: "--expense-chip-border",
                        primaryChipBg: "--primary-chip-bg",
                        cardShadow: "--card-shadow",
                        cardTopBorderColor: "--card-top-border",
                        hardwareTrackBg: "--hardware-track-bg", hardwareTrackBorder: "--hardware-track-border",
                        hardwareFillStart: "--hardware-fill-start", hardwareFillEnd: "--hardware-fill-end",
                        dropdownOptionBg: "--dropdown-option-bg",
                        primary: "--primary", incomeColor: "--income-color", expenseColor: "--expense-color",
                        transferColor: "--transfer-color", salaryColor: "--salary-color",
                        colorScheme: "color-scheme"
                    };
                    var root = document.documentElement.style;
                    for (var key in varMap) { if (saved[key]) root.setProperty(varMap[key], saved[key]); }
                    if (saved.themeColor) {
                        var m = document.querySelector('meta[name="theme-color"]');
                        if (m) m.setAttribute("content", saved.themeColor);
                    }
                }
                // v245: mirrors ledger.js's applyBgTheme() data-bg-theme attribute here too, so
                // the crayon preset's scoped border/radius/wiggle CSS (see index.html <style>)
                // is already active before first paint instead of popping in a frame late.
                if (saved && saved.id) document.documentElement.setAttribute("data-bg-theme", saved.id);
                // v247: same reasoning, for the manual Kalam-font toggle (Settings > Background
                // Theme) — default "on" (matches ledger.js's isCrayonFontEnabled() default) so a
                // never-touched install still shows Kalam under the crayon preset from first paint.
                var crayonFontPref = localStorage.getItem("ledgerCrayonFontEnabled");
                document.documentElement.setAttribute("data-crayon-font", crayonFontPref === "0" ? "default" : "kalam");
                // v249: same before-first-paint reasoning as the two attributes above, for
                // Privacy Mode — a real amount briefly flashing unblurred for one frame while
                // someone's phone screen is visible to bystanders is exactly the scenario this
                // feature exists to prevent, so it can't wait for ledger.js to run.
                // v255: unconditional now — Privacy Mode is a per-session-only toggle (see
                // ledger.js's privacyModeEnabledSession), never persisted, so every fresh
                // load/relaunch always starts blurred regardless of whether it was turned off
                // last session. The old localStorage("ledgerPrivacyModeEnabled") check here (and
                // the "0" it used to look for) is gone along with that persistence.
                document.documentElement.setAttribute("data-privacy-mode", "on");
            } catch (e) {}
        })();
