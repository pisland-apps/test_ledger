        // APP_VERSION / APP_VERSION_DATE: a plain display label, shown in the small version
        // badge in the corner of the screen (see index.html #versionBadge and the code right
        // below this that fills it in). This only tells you what code shipped in this build —
        // NOT what CACHE_NAME the Service Worker is actually serving right now, and it does NOT
        // sync automatically with CACHE_NAME in sw.js (they live in different files loaded at
        // different times). When you bump one, bump the other too — see the matching reminder
        // comment on CACHE_NAME in sw.js.
        //
        // If the badge ever shows a version that doesn't match what you expect after deploying,
        // that's the signal to hard-refresh (Ctrl/Cmd+Shift+R) or clear the site's Service
        // Worker/cache in devtools — not a signal that the deploy itself failed. The browser may
        // just be running a cached copy of the old ledger.js.
        const APP_VERSION = "v227";
        const APP_VERSION_DATE = "2026-08-31";

        // v100: shared calculator-button icon (replaces the 🧮 emoji, which rendered
        // inconsistently across platforms/fonts). Used by the static Amount field button
        // in index.html and the per-split-row button built dynamically below. Keep both
        // in sync if this ever changes — see calc-btn CSS comment in index.html.
        const CALC_ICON_SVG = `<svg width="36" height="36" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;">
            <rect x="3" y="3" width="30" height="30" rx="8" fill="#475569"/>
            <rect x="7" y="7" width="11" height="8" rx="2.5" fill="#e2e8f0"/>
            <rect x="7" y="19.5" width="11" height="8.5" rx="2.5" fill="#64748b"/>
            <rect x="20" y="19.5" width="11" height="8.5" rx="2.5" fill="#64748b"/>
            <path d="M9.5 23.75h6" stroke="#f8fafc" stroke-width="1.6" stroke-linecap="round"/>
            <path d="M23 21.75l5 4M28 21.75l-5 4" stroke="#f8fafc" stroke-width="1.6" stroke-linecap="round"/>
            <circle cx="30.5" cy="30.5" r="8.5" fill="#6366f1" stroke="#f8fafc" stroke-width="1.5"/>
            <path d="M27 28.7h7M27 32.3h7" stroke="#ffffff" stroke-width="1.7" stroke-linecap="round"/>
        </svg>`;

        // Runs immediately as this script executes (it's the last element in <body>, so the
        // DOM — including #versionBadge and the lock overlay — already exists by this point).
        // Deliberately NOT inside bootstrap() or the "load" listener: those gate on the app
        // being unlocked, and this badge needs to show before that.
        const versionBadgeEl = document.getElementById("versionBadge");
        if (versionBadgeEl) versionBadgeEl.textContent = `${APP_VERSION} · ${APP_VERSION_DATE}`;

        // pdf.js — vendored locally under lib/ (no CDN dependency, matches the companion
        // Family Health & Shield app's approach). pdfjs-dist 4.x only ships ES module
        // builds, so it's loaded via dynamic import() rather than a <script> tag — this file
        // (ledger.js) is a classic non-deferred script, so a `<script type="module">` for
        // pdf.js could easily end up running after it, leaving window.pdfjsLib unset right
        // when it's needed. Awaiting this promise at the point of use (openAttachment())
        // avoids that regardless of load order. Worker vendored at lib/pdf.worker.min.mjs —
        // must stay in lockstep with lib/pdf.min.mjs's package/version.
        const pdfjsLibPromise = import("./lib/pdf.min.mjs").then((mod) => {
            mod.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.mjs";
            return mod;
        });

        const DB_NAME = "EnterpriseMultiCurrencyLedgerDB_v4";
        // v121: DB_VERSION 5→6 adds the ATTACHMENTS store (multi-attachment receipts —
        // images and PDFs — replacing the old single inline `image` field on a transaction).
        const DB_VERSION = 6;
        const STORES = { ACCOUNTS: "accounts", TRANSACTIONS: "transactions", SETTINGS: "settings", CATEGORIES: "categories", MEMBERS: "members", FUNDS: "funds", NAV_HISTORY: "navHistory", ATTACHMENTS: "attachments" };
        // Maps each object store to the field IndexedDB uses as its keyPath. That field must stay
        // unencrypted on the stored record (IndexedDB needs to read it directly to index/generate keys);
        // every other field on the record is encrypted as a single AES-GCM blob.
        const STORE_KEYPATHS = { accounts: "id", transactions: "id", settings: "key", categories: "id", members: "id", funds: "id", navHistory: "date", attachments: "id" };

        // Fixed palette offered when picking a member's color (sidebar dot, net-worth rows, etc.)
        const MEMBER_COLORS = ["#3b82f6", "#ec4899", "#f59e0b", "#10b981", "#8b5cf6", "#ef4444", "#0ea5e9", "#14b8a6", "#f97316", "#64748b"];

        // v179: page-background presets (Setting > Background Theme). The 12 original presets
        // override --bg-color plus two cohesion touches: --neu-dark (the shadow half of the
        // chrome-only neumorphism effect — FAB, calculator keys, nav bar — tinted to match the
        // background's hue instead of staying a fixed slate-gray) and the browser-chrome
        // theme-color meta tag. They deliberately leave every other key alone (any key a preset
        // omits falls back to THEME_DEFAULTS below, which mirror the original light :root values).
        //
        // v195: added "midnight" (暗夜描边), the first FULL dark preset — it overrides every key,
        // including the data colors (--primary/--income-color/--expense-color/etc, softened —
        // full-saturation red/green on a near-black background causes halation/eye strain) and
        // the v195 chip/hardware/card-shadow tokens above, so switching to/from it correctly
        // resets every touched var either way, not just the two the light presets ever needed.
        const THEME_DEFAULTS = {
            bg: "#f8fafc", cardBg: "#ffffff", textMain: "#0f172a", textMuted: "#64748b",
            borderColor: "#e2e8f0", neuLight: "rgba(255,255,255,0.85)", neuDark: "rgba(148,163,184,0.45)",
            neuPrimaryLight: "rgba(255,255,255,0.22)", neuPrimaryDark: "rgba(49,46,129,0.55)",
            glassBg: "rgba(255,255,255,0.68)", glassBgStrong: "rgba(255,255,255,0.82)",
            // v204: glassBgModal was rgba(255,255,255,0.92) — fine as the only modal layer, but a
            // *second* modal opened on top of an already-open one (Select Category/Account, the
            // split-part picker, calc pad, the Options menu — any modal with an elevated z-index
            // in the CSS, see .modal-sheet comment) sits its own translucency on top of the first
            // modal's already-white sheet; blurring/dimming a surface that's already uniformly
            // white just stays white, so no border opacity could produce contrast against it.
            // Solid color removes the dependency on whatever happens to be behind it.
            // modalSheetBorder is a new, separate token (not glassBorder, which the sidebar
            // drawer/insights rail still use translucent) — a solid mid-gray so a modal-sheet's
            // edge stays visible even when stacked on another modal.
            glassBgModal: "#fdfdfe", glassBorder: "rgba(255,255,255,0.55)", modalSheetBorder: "#94a3b8",
            hoverBg: "#f3f4f6", pressBg: "#f1f5f9", activeBg: "#eef2ff", activeBorder: "#e0e7ff", chipBg: "#e2e8f0",
            incomeChipBg: "#f0fdf4", incomeChipBorder: "#bbf7d0", expenseChipBg: "#fef2f2", expenseChipBorder: "#fecaca",
            primaryChipBg: "#f5f3ff",
            cardShadow: "0 1px 3px rgba(0,0,0,0.06)",
            // v207: "light source from above" — top edge of every card can be brighter than the
            // sides/bottom. Defaults to the same value as borderColor (no visible change for
            // light presets); midnight/slate below override it to something brighter than their
            // own borderColor.
            cardTopBorderColor: "#e2e8f0",
            hardwareTrackBg: "#f4ede4", hardwareTrackBorder: "#dcd1c4", hardwareFillStart: "#e3cbb3", hardwareFillEnd: "#c5a88a",
            dropdownOptionBg: "#ffffff",
            primary: "#6366f1", incomeColor: "#10b981", expenseColor: "#ef4444", transferColor: "#3b82f6", salaryColor: "#d97706",
            colorScheme: "light",
            themeColor: "#4f46e5",
        };
        const BG_THEMES = [
            // v205: relabeled "Default" — was "Slate", but that name now belongs to the new dark
            // preset below (id "slate") which matches the reference swatch's actual slate-gray
            // tone much more closely than this pale off-white ever did. Same id ("default"), so
            // no saved preference or stored theme snapshot is affected — display label only.
            { id: "default",    name: "Default",      bg: "#f8fafc", neuDark: "rgba(148,163,184,0.45)", themeColor: "#4f46e5" },
            { id: "sand",       name: "Sand",         bg: "#faf5ec", neuDark: "rgba(180,150,110,0.40)", themeColor: "#b9863f" },
            { id: "mint",       name: "Mint",         bg: "#f1faf6", neuDark: "rgba(110,170,140,0.35)", themeColor: "#3f9d76" },
            { id: "lavender",   name: "Lavender",     bg: "#f6f4fc", neuDark: "rgba(150,130,190,0.35)", themeColor: "#7c6bc4" },
            { id: "sky",        name: "Sky",          bg: "#eff7fc", neuDark: "rgba(110,150,190,0.35)", themeColor: "#4a90c2" },
            { id: "blush",      name: "Blush",        bg: "#fdf3f2", neuDark: "rgba(200,140,140,0.35)", themeColor: "#c97f7f" },
            { id: "sage",       name: "Sage",         bg: "#f4f7f0", neuDark: "rgba(140,165,110,0.35)", themeColor: "#7a9a52" },
            { id: "peach",      name: "Peach",        bg: "#fdf6ee", neuDark: "rgba(210,160,110,0.35)", themeColor: "#d99a54" },
            { id: "periwinkle", name: "Periwinkle",   bg: "#f2f3fc", neuDark: "rgba(130,140,210,0.35)", themeColor: "#6a72c9" },
            { id: "rosegold",   name: "Rose Gold",    bg: "#fdf2f5", neuDark: "rgba(200,150,165,0.35)", themeColor: "#c97a95" },
            { id: "cloud",      name: "Cloud Gray",   bg: "#f5f5f6", neuDark: "rgba(150,150,155,0.40)", themeColor: "#6b7280" },
            { id: "butter",     name: "Butter",       bg: "#fdfaf0", neuDark: "rgba(200,180,110,0.35)", themeColor: "#c9a63f" },
            { id: "indigo",     name: "Indigo",       bg: "#eef1fd", neuDark: "rgba(99,102,241,0.40)", themeColor: "#4f46e5" },
            { id: "teal",       name: "Teal",         bg: "#eefaf8", neuDark: "rgba(20,166,151,0.35)", themeColor: "#0d9488" },
            { id: "purple",     name: "Purple",       bg: "#f7f0fd", neuDark: "rgba(168,85,247,0.35)", themeColor: "#9333ea" },
            {
                // v205: second full dark preset (alongside 暗夜描边/midnight below) — cooler,
                // blue-gray slate tone rather than near-black, per the reference Indigo/Teal/
                // Purple/Slate swatch set. Mirrors every key midnight overrides (see its comments
                // just below) since a full dark preset must supply all of them itself — any key
                // it left out would fall back to THEME_DEFAULTS' *light* value (e.g. a white
                // modal-sheet on a dark page) instead of resetting cleanly.
                id: "slate", name: "Slate",
                bg: "#0f172a", cardBg: "#1e293b", textMain: "#e2e8f0", textMuted: "#94a3b8",
                borderColor: "rgba(255,255,255,0.12)",
                // v207: top edge brighter than the sides/bottom above — "light source from
                // above", see the :root --card-top-border comment in index.html.
                // v209: reverted to plain/uniform (matches borderColor exactly, same as before
                // v207's card-top-highlight was introduced) per user request — keeping the
                // override key rather than removing it, since removing it would fall back to
                // THEME_DEFAULTS' *light* cardTopBorderColor (#e2e8f0), which would render as a
                // bright, wrong-toned edge on this dark preset. midnight below keeps the v207
                // highlight.
                cardTopBorderColor: "rgba(255,255,255,0.12)",
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
                colorScheme: "dark",
                themeColor: "#0f172a",
            },
            {
                id: "midnight", name: "暗夜描边",
                bg: "#0a0a0f", cardBg: "#15151d", textMain: "#e8eaf0", textMuted: "#8b93a8",
                borderColor: "rgba(255,255,255,0.14)",
                // v207: top edge brighter than the sides/bottom above — see the matching comment
                // on the "slate" entry above.
                cardTopBorderColor: "rgba(255,255,255,0.22)",
                neuLight: "rgba(255,255,255,0.04)", neuDark: "rgba(0,0,0,0.55)",
                neuPrimaryLight: "rgba(255,255,255,0.10)", neuPrimaryDark: "rgba(0,0,0,0.5)",
                glassBg: "rgba(20,20,28,0.72)", glassBgStrong: "rgba(20,20,28,0.85)",
                // v204: fully opaque (was rgba(24,24,32,0.95)) and a visible dedicated border —
                // see the matching THEME_DEFAULTS comment on glassBgModal/modalSheetBorder above.
                glassBgModal: "#181820", glassBorder: "rgba(255,255,255,0.12)", modalSheetBorder: "#4b5563",
                hoverBg: "rgba(255,255,255,0.06)", pressBg: "rgba(255,255,255,0.10)",
                activeBg: "rgba(99,102,241,0.18)", activeBorder: "rgba(129,140,248,0.35)", chipBg: "rgba(255,255,255,0.08)",
                // v195: soft/muted tints per 改进建议.md — low-alpha color-on-near-black chips
                // instead of the light pastel hexes, so they read as "colored glass" not white boxes.
                incomeChipBg: "rgba(52,211,153,0.15)", incomeChipBorder: "rgba(52,211,153,0.35)",
                expenseChipBg: "rgba(248,113,113,0.15)", expenseChipBorder: "rgba(248,113,113,0.35)",
                primaryChipBg: "rgba(129,140,248,0.15)",
                // A black box-shadow is invisible on a near-black card — elevation instead comes
                // from the crisp --border-color + cardBg being a shade lighter than bg.
                cardShadow: "none",
                hardwareTrackBg: "#2a231c", hardwareTrackBorder: "#46392c",
                hardwareFillStart: "#6b5642", hardwareFillEnd: "#4a3a2a",
                // v198: lighter than --card-bg, matching the blended tone of the app's own
                // input fields (--chip-bg over --card-bg) — see the :root comment above.
                dropdownOptionBg: "#28282f",
                // v195: softened/desaturated data colors — full-saturation red/green/indigo on a
                // near-black background causes halation (glow/"vibration") and eye strain; these
                // are the standard higher-lightness, lower-saturation dark-mode equivalents.
                primary: "#818cf8", incomeColor: "#34d399", expenseColor: "#f87171",
                transferColor: "#60a5fa", salaryColor: "#fbbf24",
                // v195: switches native form-control chrome (select dropdown lists, date/time
                // picker icons, checkboxes) to the browser's own dark rendering — see the :root
                // comment above. This is what actually fixes the Auto-Lock/Member/Scheme <select>
                // dropdowns and the NAV Date picker icon, which our CSS vars can't reach directly.
                colorScheme: "dark",
                themeColor: "#0a0a0f",
            },
        ];
        const BG_THEME_STORAGE_KEY = "ledgerBgTheme";
        // v202: separate slot that only ever holds the most recent *light* preset's full
        // snapshot (never midnight). Auto mode needs this so the head <script>'s no-flash
        // snippet can resolve "system says light" correctly on relaunch, even while
        // BG_THEME_STORAGE_KEY itself currently holds the dark snapshot (e.g. app was last
        // closed at night).
        const BG_THEME_LIGHT_SNAPSHOT_KEY = "ledgerBgThemeLightSnapshot";
        const BG_THEME_AUTO_KEY = "ledgerBgThemeAuto";
        const BG_THEME_AUTO_LIGHT_KEY = "ledgerBgThemeAutoLightId";
        // v206: was `const BG_THEME_DARK_ID = "midnight";` (a single hardcoded id) back when
        // 暗夜描边 was the only dark preset — now that "slate" is also a full dark preset, Auto
        // needs to know which *of the two* to land on, and that pick needs to be changeable any
        // time (not just while setting Auto up), mirroring how the light side already remembers
        // "whichever light preset was last active" — see BG_THEME_AUTO_DARK_KEY and
        // getAutoDarkThemeId()/setAutoDarkThemeId() below.
        const BG_THEME_DARK_IDS = ["midnight", "slate"];
        function isDarkBgThemeId(id) { return BG_THEME_DARK_IDS.indexOf(id) !== -1; }
        const BG_THEME_AUTO_DARK_KEY = "ledgerBgThemeAutoDarkId";

        // Account grouping (v35) — every account belongs to one of these, used to sort/section
        // both the full Accounts page and a member's account list (group, then name). Accounts
        // saved before this existed default to "Bank/Cash" wherever a group is read.
        // v70: added Account Payable / Account Receivable as their own groups (not subgroups of
        // one combined group) — AP and AR move in opposite directions financially, so a single
        // netted group total would be misleading; keeping them apart mirrors how Bank Loan is
        // already kept apart from Bank/Cash.
        // v156: replaced Account Payable / Account Receivable with "Other Assets" / "Other
        // Liabilities" — AP/AR are trade-specific accounting terms (money owed for goods/services
        // bought or sold on credit) and were being misused for things like refundable deposits
        // held/paid, which are custodial in nature, not trade debts. "Other Assets"/"Other
        // Liabilities" are the correct general-purpose catch-alls for that. Existing accounts
        // still saved under the old AP/AR groups are remapped by migrateAccountGroupRename().
        const ACCOUNT_GROUPS = ["Bank/Cash", "Credit Card", "Multi-Currency", "Investment", "Real Estate", "Other Assets", "Bank Loan", "Other Liabilities"];
        const DEFAULT_ACCOUNT_GROUP = ACCOUNT_GROUPS[0];

        // Sub-groups (v39) — optional, per-Group breakdown so e.g. "Investment" can be split
        // into Fixed Deposit / KWSP / ASNB / Unit Trust rather than one flat list. A group with
        // no entry here (or an account left on "(No Sub-Group)") just isn't sub-divided. Purely
        // organizational — doesn't affect account.type (Normal/Multi-Currency/Fixed
        // Deposit/Unit Trust), just where it's filed on the Accounts page.
        const ACCOUNT_SUBGROUPS = {
            "Bank/Cash": ["Current Account", "Savings Account", "Cash Account"],
            "Investment": ["Fixed Deposit", "KWSP", "CPF", "ASNB", "Unit Trust"],
        };
        function subgroupsForGroup(group) {
            return ACCOUNT_SUBGROUPS[group] || [];
        }

        // Sorts accounts by group (in ACCOUNT_GROUPS order) then by name — shared by the Accounts
        // page and per-member account lists so both stay consistent.
        function sortAccountsByGroupThenName(accounts) {
            return [...accounts].sort((a, b) => {
                const gi = ACCOUNT_GROUPS.indexOf(a.group || DEFAULT_ACCOUNT_GROUP) - ACCOUNT_GROUPS.indexOf(b.group || DEFAULT_ACCOUNT_GROUP);
                if (gi !== 0) return gi;
                const subList = subgroupsForGroup(a.group || DEFAULT_ACCOUNT_GROUP);
                const si = subList.indexOf(a.subgroup || "") - subList.indexOf(b.subgroup || "");
                if (si !== 0) return si;
                return (a.name || "").localeCompare(b.name || "");
            });
        }
        let membersCache = [];
        // Which member/joint-group is currently being viewed on page-member, e.g.
        // { type: "member", ids: ["mem_1"] } or { type: "joint", ids: ["mem_1","mem_2"] }.
        let activeMemberFilter = null;
        // Set by the sidebar's per-type shortcuts (see renderSidebarAccountTypeShortcuts) to
        // restrict the Accounts page list to one group/sub-group at a time, e.g.
        // { group: "Investment", subgroup: "Fixed Deposit", label: "Fixed Deposit" }. null shows
        // every account, same as opening the page from "Financial Accounts" directly.
        let accountsPageTypeFilter = null;
        // v222 fix: where the Accounts page's "← Back" (and hardware/gesture back) should
        // return to. Every pre-v222 entry point (sidebar, dashboard, delete-account flow)
        // only ever meant "back to Dashboard", so this defaulted implicitly via a hardcoded
        // navigateToWorkspace() call. v222's Net Worth Statement rows route through the same
        // navigateToAccountsPage() (via sidebarFilterAccountsByType) and got stranded on that
        // same hardcoded target instead of returning to Net Worth Statement. See
        // navigateToAccountsPage()/handleAccountsBackClick() below.
        let accountsPageBackTarget = "workspace"; // "workspace" | "networth-statement"
        // v62: which accounts' fund/currency/FD-placement subrows are expanded on the Accounts
        // page — collapsed by default (empty Set) so an account with many holdings doesn't push
        // the rest of the list down. v64: keys are "<filter>__<accountId>" (see
        // subrowFilterKeyPrefix in renderAccountsPage), not just the raw account id, so the same
        // account's expand state is independent between the unfiltered "All Accounts" list and
        // any sidebar-filtered view (e.g. "Unit Trust") that also shows that account. v65: now
        // persisted to the SETTINGS store (key "expandedAccountSubrows", value: array of keys) —
        // saved on every toggle, loaded in bootstrap(), and included in backup export/import — so
        // it survives a reload and carries over to a new device, instead of resetting each session.
        let expandedAccountSubrows = new Set();

        // Fire-and-forget persist of expandedAccountSubrows to the SETTINGS store. Not awaited by
        // callers (toggleAccountSubrows stays synchronous for instant UI feedback) — worst case on
        // a write failure is the expand state not surviving a reload, which isn't destructive.
        function saveExpandedAccountSubrows() {
            writeDB(STORES.SETTINGS, { key: "expandedAccountSubrows", value: Array.from(expandedAccountSubrows) })
                .catch(err => console.error("Failed to save subrow expand state:", err));
        }
        let db;

        // Escapes a value for safe insertion into HTML text content or a double-quoted HTML
        // attribute. Used anywhere user-entered free text (account names, category names,
        // transaction descriptions) is interpolated into a template string that gets set via
        // innerHTML — without this, a name/description containing e.g. a `"` or `<` character
        // could break out of its attribute or inject markup.
        function escapeHtml(value) {
            return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
                "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
            })[ch]);
        }

        // Deterministic color per currency code (v136) — so the same currency always looks the
        // same wherever a currency badge/chip appears (Accounts list, Member page account list,
        // Member page currency-held chips, the Net Worth by Currency report), instead of every
        // currency sharing one plain gray badge. A handful of currencies get hand-picked colors;
        // any other code (added later, e.g. a new account in a currency not in this list) falls
        // back to a hash-picked slot from the same palette, so it still gets a stable, readable
        // color rather than reverting to gray.
        const CURRENCY_BADGE_COLORS = {
            MYR: { bg: "#dbeafe", fg: "#1e40af" },
            SGD: { bg: "#fee2e2", fg: "#b91c1c" },
            USD: { bg: "#dcfce7", fg: "#166534" },
            EUR: { bg: "#e0e7ff", fg: "#3730a3" },
            GBP: { bg: "#ede9fe", fg: "#6d28d9" },
            JPY: { bg: "#fae8ff", fg: "#86198f" },
            AUD: { bg: "#ffedd5", fg: "#9a3412" },
            HKD: { bg: "#ccfbf1", fg: "#0f766e" },
            CNY: { bg: "#fef3c7", fg: "#92400e" },
            THB: { bg: "#ecfccb", fg: "#3f6212" },
            IDR: { bg: "#cffafe", fg: "#155e75" },
            INR: { bg: "#ffe4e6", fg: "#9f1239" },
        };
        const CURRENCY_BADGE_FALLBACK_PALETTE = Object.values(CURRENCY_BADGE_COLORS);
        function currencyBadgeColor(code) {
            if (CURRENCY_BADGE_COLORS[code]) return CURRENCY_BADGE_COLORS[code];
            let hash = 0;
            for (let i = 0; i < code.length; i++) hash = (hash * 31 + code.charCodeAt(i)) >>> 0;
            return CURRENCY_BADGE_FALLBACK_PALETTE[hash % CURRENCY_BADGE_FALLBACK_PALETTE.length];
        }
        function currencyBadgeHTML(code) {
            const { bg, fg } = currencyBadgeColor(code);
            return `<span style="font-size:0.65rem; padding:1px 4px; border-radius:4px; background:${bg}; color:${fg}; font-weight:bold;">${escapeHtml(code)}</span>`;
        }

        // v163 美化方案 point 2: deterministic gradient-avatar initial for an Accounts-page row —
        // same hash→palette idiom as currencyBadgeColor() above, so a given account name always
        // lands on the same two colors across reloads without needing a stored color field on
        // the account itself.
        const ACCOUNT_AVATAR_GRADIENTS = [
            ["#6366f1", "#8b5cf6"], ["#ec4899", "#f472b6"], ["#f59e0b", "#fb923c"],
            ["#10b981", "#14b8a6"], ["#0ea5e9", "#38bdf8"], ["#ef4444", "#f87171"],
            ["#8b5cf6", "#c084fc"], ["#0891b2", "#22d3ee"],
        ];
        function accountAvatarHTML(name) {
            const str = String(name || "").trim();
            let hash = 0;
            for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
            const [c1, c2] = ACCOUNT_AVATAR_GRADIENTS[hash % ACCOUNT_AVATAR_GRADIENTS.length];
            const initial = escapeHtml((str.charAt(0) || "?").toUpperCase());
            return `<div class="account-avatar" style="background:linear-gradient(135deg, ${c1}, ${c2});">${initial}</div>`;
        }

        // v163 美化方案 point 5: icon + color for an account Group's section-header pill on the
        // Accounts page — same emoji already used in the Add/Edit Account "Group" dropdown
        // (index.html), so the two stay visually consistent. Falls back to a neutral folder icon
        // for any group name not in this fixed list (there currently isn't one — ACCOUNT_GROUPS
        // above is a closed set — but this keeps the pill from rendering blank/broken if that
        // ever changes).
        const ACCOUNT_GROUP_BADGE = {
            "Bank/Cash": { icon: "🏦", bg: "#e0e7ff", fg: "#4338ca" },
            "Credit Card": { icon: "💳", bg: "#fce7f3", fg: "#9d174d" },
            "Multi-Currency": { icon: "💱", bg: "#ccfbf1", fg: "#0f766e" },
            "Investment": { icon: "📈", bg: "#dbeafe", fg: "#1d4ed8" },
            "Real Estate": { icon: "🏠", bg: "#ffedd5", fg: "#9a3412" },
            "Other Assets": { icon: "💼", bg: "#e0f2fe", fg: "#0369a1" },
            "Bank Loan": { icon: "💸", bg: "#fee2e2", fg: "#b91c1c" },
            "Other Liabilities": { icon: "🧾", bg: "#fef3c7", fg: "#92400e" },
        };
        function accountGroupBadgeHTML(group) {
            const info = ACCOUNT_GROUP_BADGE[group] || { icon: "🗂️", bg: "#f1f5f9", fg: "#475569" };
            return `<span class="group-pill" style="background:${info.bg}; color:${info.fg};">${info.icon} ${escapeHtml(group)}</span>`;
        }

        // v150: same deterministic hash-to-palette approach as currencyBadgeColor() above, for the
        // big round category icon on each Transactions list row — same category always gets the
        // same background color, without needing a new per-category color field/UI.
        const CATEGORY_ICON_BG_PALETTE = ["#fee2e2", "#ffedd5", "#fef3c7", "#ecfccb", "#dcfce7", "#ccfbf1", "#cffafe", "#dbeafe", "#e0e7ff", "#ede9fe", "#fae8ff", "#ffe4e6"];
        function categoryIconBgColor(name) {
            let hash = 0;
            const str = String(name || "");
            for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
            return CATEGORY_ICON_BG_PALETTE[hash % CATEGORY_ICON_BG_PALETTE.length];
        }

        // v80: formats a Date object as a "YYYY-MM-DD" calendar-date string using its LOCAL
        // year/month/day components. This exists because `date.toISOString().split("T")[0]`
        // (used throughout the FD maturity-date math) silently shifts the date for anyone in a
        // UTC+ timezone (e.g. Malaysia, UTC+8): a Date built from local midnight, once run
        // through toISOString(), gets re-expressed in UTC — which is still the *previous*
        // calendar day at that hour — so the maturity date it prints ends up one day earlier
        // than the commencing date + tenure actually works out to. Every FD maturity calculation
        // (opening-balance placement rows, the Add/Edit Transaction FD fields, and the Resolve
        // Maturity renewal form) now goes through this instead.
        function localDateStr(date) {
            const y = date.getFullYear();
            const m = String(date.getMonth() + 1).padStart(2, "0");
            const d = String(date.getDate()).padStart(2, "0");
            return `${y}-${m}-${d}`;
        }

        // v80: same fix as localDateStr(), for "today". `new Date().toISOString().split("T")[0]`
        // (the pattern used everywhere in this file for "today's date") reads the CURRENT INSTANT
        // back out in UTC, not the browser's local calendar date — for anyone in a UTC+ timezone
        // (e.g. Malaysia, UTC+8) that's still "yesterday" in UTC terms for the first ~8 hours of
        // every local day, which threw off the FD overdue/reminder check, default dates on new
        // entries, and the maturity-vs-commence comparison during Resolve Maturity. Use this
        // instead everywhere "today" means "today where the user is sitting".
        function todayLocalStr() {
            return localDateStr(new Date());
        }

        /* ================= APP LOCK: PBKDF2 + AES-GCM (Web Crypto) ================= */
        const LOCK_CONFIG_KEY = "ledgerAppLockV1";
        const PBKDF2_ITERATIONS = 250000;
        const VERIFIER_PLAINTEXT = "ledger-lock-verify-ok";

        // appKey: the derived AES-GCM CryptoKey used to encrypt/decrypt every IndexedDB record.
        // Lives only in memory — lost on reload/lock, which is what makes locking the app meaningful.
        let appKey = null;
        // currentPasscode: the raw passcode text, kept in memory only while unlocked, so backup
        // export/import can (re)derive independent, portably-salted keys without re-prompting.
        let currentPasscode = null;

        function bufToB64(buf) {
            const bytes = new Uint8Array(buf);
            let bin = "";
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            return btoa(bin);
        }
        function b64ToBuf(b64) {
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return bytes.buffer;
        }

        async function deriveKeyFromPasscode(passcode, saltB64, iterations) {
            const enc = new TextEncoder();
            const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(passcode), { name: "PBKDF2" }, false, ["deriveKey"]);
            return crypto.subtle.deriveKey(
                { name: "PBKDF2", salt: b64ToBuf(saltB64), iterations, hash: "SHA-256" },
                keyMaterial,
                { name: "AES-GCM", length: 256 },
                false,
                ["encrypt", "decrypt"]
            );
        }

        async function aesEncryptString(key, plaintext) {
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const enc = new TextEncoder();
            const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
            return { iv: bufToB64(iv), data: bufToB64(cipherBuf) };
        }

        async function aesDecryptString(key, ivB64, dataB64) {
            const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBuf(ivB64) }, key, b64ToBuf(dataB64));
            return new TextDecoder().decode(plainBuf);
        }

        function getLockConfig() {
            try {
                const raw = localStorage.getItem(LOCK_CONFIG_KEY);
                return raw ? JSON.parse(raw) : null;
            } catch (err) { return null; }
        }
        function saveLockConfig(cfg) {
            localStorage.setItem(LOCK_CONFIG_KEY, JSON.stringify(cfg));
        }

        // Encrypts a record before it's written to IndexedDB. The store's keyPath field (id/key) is
        // left in the clear so IndexedDB can index/auto-generate it; everything else becomes one
        // AES-GCM ciphertext blob under a fresh random IV.
        async function encryptRecord(storeName, record) {
            if (!appKey || !record) return record;
            const keyField = STORE_KEYPATHS[storeName];
            const keyVal = record[keyField];
            const plainCopy = { ...record };
            delete plainCopy[keyField];
            const { iv, data } = await aesEncryptString(appKey, JSON.stringify(plainCopy));
            const out = { iv, data };
            if (keyVal !== undefined) out[keyField] = keyVal;
            return out;
        }

        // Reverses encryptRecord. Records written before the app-lock feature existed (or before
        // migration completes) won't have iv/data and are passed through unchanged.
        async function decryptRecord(storeName, record) {
            if (!record || !record.data || !record.iv) return record;
            if (!appKey) return record;
            const keyField = STORE_KEYPATHS[storeName];
            const keyVal = record[keyField];
            const json = await aesDecryptString(appKey, record.iv, record.data);
            const plain = JSON.parse(json);
            if (keyVal !== undefined) plain[keyField] = keyVal;
            return plain;
        }

        // Reads a store's raw (still-encrypted, or legacy plaintext) records without decrypting —
        // used only by the one-time migration pass right after a passcode is first created.
        function rawReadAllDB(storeName) {
            return new Promise((resolve, reject) => {
                try {
                    const tx = db.transaction([storeName], "readonly");
                    const req = tx.objectStore(storeName).getAll();
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                } catch (err) { reject(err); }
            });
        }

        // Encrypts any still-plaintext records left over from before the app lock was set up.
        // Safe to run more than once — already-encrypted records (having iv+data) are left alone.
        async function migrateStoreToEncrypted(storeName) {
            const raw = await rawReadAllDB(storeName);
            for (const rec of raw) {
                if (rec && rec.data && rec.iv) continue;
                await writeDB(storeName, rec);
            }
        }
        async function migrateAllStoresToEncrypted() {
            for (const storeName of Object.values(STORES)) {
                await migrateStoreToEncrypted(storeName);
            }
        }

        // Resolves once the user has either created a new passcode or unlocked with an existing one.
        function runLockFlow() {
            return new Promise((resolve) => {
                const overlay = document.getElementById("lockOverlay");
                const setupView = document.getElementById("lockSetupView");
                const unlockView = document.getElementById("lockUnlockView");
                const cfg = getLockConfig();

                if (!cfg) {
                    setupView.style.display = "";
                    unlockView.style.display = "none";
                    window._resolveLockFlow = async () => {
                        const p1 = document.getElementById("setupPasscodeInput").value;
                        const p2 = document.getElementById("setupPasscodeConfirmInput").value;
                        const errEl = document.getElementById("lockError");
                        errEl.textContent = "";
                        if (!p1 || p1.length < 4) { errEl.textContent = "Passcode must be at least 4 characters."; return; }
                        if (p1 !== p2) { errEl.textContent = "Passcodes do not match."; return; }

                        const salt = crypto.getRandomValues(new Uint8Array(16));
                        const saltB64 = bufToB64(salt);
                        const key = await deriveKeyFromPasscode(p1, saltB64, PBKDF2_ITERATIONS);
                        const verifier = await aesEncryptString(key, VERIFIER_PLAINTEXT);
                        saveLockConfig({ salt: saltB64, iterations: PBKDF2_ITERATIONS, verifierIv: verifier.iv, verifierData: verifier.data });

                        appKey = key;
                        currentPasscode = p1;
                        overlay.classList.add("hidden");
                        resolve({ isNewSetup: true });
                    };
                } else {
                    setupView.style.display = "none";
                    unlockView.style.display = "";
                    const biometricBtn = document.getElementById("biometricUnlockBtn");
                    biometricBtn.style.display = "none";

                    const finishUnlock = () => {
                        overlay.classList.add("hidden");
                        resolve({ isNewSetup: false });
                    };

                    // If biometric quick-unlock is configured on this device, show the button and
                    // try it automatically once — falls back to the passcode field on cancel/failure.
                    (async () => {
                        const record = await getBiometricRecord();
                        const supported = record && await isBiometricSupported();
                        if (!supported) return;
                        biometricBtn.style.display = "";
                        const ok = await attemptBiometricUnlock();
                        if (ok) finishUnlock();
                    })();

                    biometricBtn.onclick = async () => {
                        const ok = await attemptBiometricUnlock();
                        if (ok) { finishUnlock(); }
                        else { document.getElementById("lockError2").textContent = "Biometric unlock failed. Enter your passcode instead."; }
                    };

                    window._resolveLockFlow = async () => {
                        const p1 = document.getElementById("unlockPasscodeInput").value;
                        const errEl = document.getElementById("lockError2");
                        errEl.textContent = "";
                        try {
                            const key = await deriveKeyFromPasscode(p1, cfg.salt, cfg.iterations);
                            const check = await aesDecryptString(key, cfg.verifierIv, cfg.verifierData);
                            if (check !== VERIFIER_PLAINTEXT) throw new Error("mismatch");
                            appKey = key;
                            currentPasscode = p1;
                            finishUnlock();
                        } catch (err) {
                            errEl.textContent = "Incorrect passcode. Try again.";
                        }
                    };
                }
            });
        }

        function handleSetupPasscodeSubmit() { if (window._resolveLockFlow) window._resolveLockFlow(); }
        function handleUnlockSubmit() { if (window._resolveLockFlow) window._resolveLockFlow(); }

        // Pressing Enter in any of the three passcode fields submits, same as tapping the
        // button below it (v34). None of these inputs sit inside a <form>, so the browser has no
        // built-in "Enter submits" behaviour to rely on here — without this listener, Enter does
        // nothing on some browsers/keyboards and inconsistently works on others (e.g. only ever
        // the very first time, right after the overlay's inputs first got focus). Registered once
        // at script load (not inside runLockFlow()) so it keeps working across every lock/unlock
        // cycle, including the full page reload that lockAppNow() triggers.
        const PASSCODE_ENTER_SUBMIT_IDS = ["setupPasscodeInput", "setupPasscodeConfirmInput", "unlockPasscodeInput"];
        document.addEventListener("keydown", (e) => {
            if (e.key !== "Enter") return;
            const id = e.target && e.target.id;
            if (!PASSCODE_ENTER_SUBMIT_IDS.includes(id)) return;
            e.preventDefault();
            if (id === "unlockPasscodeInput") handleUnlockSubmit();
            else handleSetupPasscodeSubmit();
        });

        // On-screen number pad for the unlock passcode field — appends/removes digits from
        // #unlockPasscodeInput. Purely an input aid alongside the physical/OS keyboard, not a
        // replacement: passcodes are free text (any characters, min 4 chars), not digit-only PINs,
        // so someone with a non-numeric passcode can still just type it as before.
        // Deliberately does NOT call input.focus() — focusing the field is what pops the mobile
        // OS keyboard, defeating the point of an on-screen numpad. blur() is called instead, so if
        // the field was already focused (user tapped it directly before switching to the numpad),
        // any open keyboard gets dismissed rather than staying up alongside the numpad.
        function numpadDigit(digit) {
            const input = document.getElementById("unlockPasscodeInput");
            if (!input || input.disabled) return;
            input.value += digit;
            input.blur();
        }
        function numpadBackspace() {
            const input = document.getElementById("unlockPasscodeInput");
            if (!input || input.disabled) return;
            input.value = input.value.slice(0, -1);
            input.blur();
        }
        function numpadClear() {
            const input = document.getElementById("unlockPasscodeInput");
            if (!input || input.disabled) return;
            input.value = "";
            input.blur();
        }

        // Re-locks the app immediately: drops the in-memory key/passcode and reloads, which forces
        // the unlock screen again and guarantees no decrypted data lingers in memory or on screen.
        function lockAppNow() {
            appKey = null;
            currentPasscode = null;
            location.reload();
        }

        // Re-encrypts every record in every store under a new AES-GCM key — the bulk-data half of
        // Change Passcode. Every store is fully read (decrypted under whichever key is currently
        // in `appKey`, i.e. the OLD one) before `appKey` is swapped to the new one, then every
        // record is written back (encryptRecord() inside writeDB() picks up the new global
        // `appKey` automatically). Reading everything up front, then swapping once, then writing
        // everything — never interleaved — avoids a partial state where some stores are already
        // readable only with the new key while others still need the old one.
        async function reencryptAllStoresWithKey(newKey) {
            const snapshots = {};
            for (const storeName of Object.values(STORES)) {
                snapshots[storeName] = await readAllDB(storeName);
            }
            appKey = newKey;
            for (const storeName of Object.values(STORES)) {
                for (const rec of snapshots[storeName]) {
                    await writeDB(storeName, rec);
                }
            }
        }

        function openChangePasscodeModal() {
            document.getElementById("changePasscodeCurrentInput").value = "";
            document.getElementById("changePasscodeNewInput").value = "";
            document.getElementById("changePasscodeConfirmInput").value = "";
            document.getElementById("changePasscodeError").textContent = "";
            openModal("changePasscodeModal");
        }

        async function handleChangePasscodeSubmit() {
            const curVal = document.getElementById("changePasscodeCurrentInput").value;
            const newVal = document.getElementById("changePasscodeNewInput").value;
            const confirmVal = document.getElementById("changePasscodeConfirmInput").value;
            const errEl = document.getElementById("changePasscodeError");
            const submitBtn = document.getElementById("changePasscodeSubmitBtn");
            errEl.textContent = "";

            if (!curVal) { errEl.textContent = "Enter your current passcode."; return; }
            if (!newVal || newVal.length < 4) { errEl.textContent = "New passcode must be at least 4 characters."; return; }
            if (newVal !== confirmVal) { errEl.textContent = "New passcodes do not match."; return; }
            if (newVal === curVal) { errEl.textContent = "New passcode must be different from the current one."; return; }

            const cfg = getLockConfig();
            if (!cfg) { errEl.textContent = "No passcode is set up yet."; return; }

            // Verify the CURRENT passcode against the stored verifier — never trust the
            // in-memory `currentPasscode` session variable alone here. The app being unlocked
            // only proves someone unlocked it at some point this session, not that whoever is
            // tapping "Change Passcode" right now actually knows the passcode (e.g. it was left
            // unlocked and picked up by someone else).
            try {
                const curKey = await deriveKeyFromPasscode(curVal, cfg.salt, cfg.iterations);
                const check = await aesDecryptString(curKey, cfg.verifierIv, cfg.verifierData);
                if (check !== VERIFIER_PLAINTEXT) throw new Error("mismatch");
            } catch (err) {
                errEl.textContent = "Current passcode is incorrect.";
                return;
            }

            submitBtn.disabled = true;
            submitBtn.textContent = "Re-encrypting your data…";
            try {
                const newSalt = crypto.getRandomValues(new Uint8Array(16));
                const newSaltB64 = bufToB64(newSalt);
                const newKey = await deriveKeyFromPasscode(newVal, newSaltB64, PBKDF2_ITERATIONS);

                await reencryptAllStoresWithKey(newKey);

                const verifier = await aesEncryptString(newKey, VERIFIER_PLAINTEXT);
                saveLockConfig({ salt: newSaltB64, iterations: PBKDF2_ITERATIONS, verifierIv: verifier.iv, verifierData: verifier.data });
                currentPasscode = newVal;

                // Biometric unlock wraps the OLD passcode text with a PRF-derived key (see
                // enableBiometricUnlock above) — that wrapped value is now stale, since unlocking
                // with it would try the old passcode against the new lock config and fail the
                // verifier check. Rather than leave a broken enrollment that silently fails on
                // next use, drop it and tell the user to re-enable it if they want it back — same
                // "fail clean, re-enroll" approach this app already uses for stale biometric
                // records (see attemptBiometricUnlock's v1-record handling).
                const hadBiometric = !!(await getBiometricRecord());
                if (hadBiometric) await disableBiometricUnlock().catch(() => {});

                closeModal("changePasscodeModal");
                alert(hadBiometric
                    ? "Passcode changed. Biometric quick unlock was turned off — you can re-enable it from Backup & Restore."
                    : "Passcode changed successfully.");
            } catch (err) {
                console.error("[ledger] change passcode failed", err);
                errEl.textContent = "Something went wrong changing your passcode. Please try again.";
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = "Change Passcode";
            }
        }

        function openResetAppDataModal() {
            document.getElementById("resetAppDataPasscodeInput").value = "";
            document.getElementById("resetAppDataConfirmInput").value = "";
            document.getElementById("resetAppDataError").textContent = "";
            openModal("resetAppDataModal");
        }

        // Reset App Data, reached from Setting (already-unlocked context) — deliberately stricter
        // than the lock screen's own "Forgot passcode? Reset app data" link: that one is for
        // someone who genuinely can't remember their passcode, so it can only ask two OK/Cancel
        // questions. Here the passcode is known (the app is unlocked), so requiring it to be
        // typed AND re-typed is a real, typo-proof accidental-tap guard rather than a dialog that
        // can be reflexively clicked through. A final confirm dialog still runs after the
        // passcode check passes, matching the lock screen's own two-step convention.
        async function handleResetAppDataSubmit() {
            const p1 = document.getElementById("resetAppDataPasscodeInput").value;
            const p2 = document.getElementById("resetAppDataConfirmInput").value;
            const errEl = document.getElementById("resetAppDataError");
            errEl.textContent = "";

            if (!p1) { errEl.textContent = "Enter your passcode."; return; }
            if (p1 !== p2) { errEl.textContent = "Passcodes do not match."; return; }

            const cfg = getLockConfig();
            if (!cfg) { errEl.textContent = "No passcode is set up."; return; }

            try {
                const key = await deriveKeyFromPasscode(p1, cfg.salt, cfg.iterations);
                const check = await aesDecryptString(key, cfg.verifierIv, cfg.verifierData);
                if (check !== VERIFIER_PLAINTEXT) throw new Error("mismatch");
            } catch (err) {
                errEl.textContent = "Incorrect passcode.";
                return;
            }

            const finalConfirm = await customConfirm("This will permanently erase ALL data in this app on this device — accounts, transactions, categories, everything. This cannot be undone. Continue?");
            if (!finalConfirm) return;

            closeModal("resetAppDataModal");
            performFullAppDataReset();
        }

        /* ================= IDLE AUTO-LOCK ================= */
        // Locks the app automatically after a period of no user activity — selectable via the
        // ⏱️ dropdown in the header (Never/1/5/15/30 min, default 15). The setting itself isn't
        // sensitive, so it's kept in localStorage (plain, unencrypted) rather than the encrypted
        // settings store — that also means it's available immediately on next launch without
        // waiting on a DB read.
        const AUTO_LOCK_KEY = "ledgerAutoLockMinutesV1";
        const DEFAULT_AUTO_LOCK_MINUTES = 15;
        const AUTO_LOCK_ACTIVITY_EVENTS = ["click", "keydown", "touchstart", "mousemove", "scroll"];
        let autoLockMinutes = DEFAULT_AUTO_LOCK_MINUTES;
        let autoLockTimer = null;
        let lastAutoLockActivityAt = 0;

        function getAutoLockMinutes() {
            const raw = localStorage.getItem(AUTO_LOCK_KEY);
            if (raw === null) return DEFAULT_AUTO_LOCK_MINUTES;
            const n = parseInt(raw, 10);
            return Number.isNaN(n) ? DEFAULT_AUTO_LOCK_MINUTES : n;
        }

        function resetAutoLockTimer() {
            if (autoLockTimer) { clearTimeout(autoLockTimer); autoLockTimer = null; }
            if (!appKey || !autoLockMinutes || autoLockMinutes <= 0) return; // "Never", or not unlocked
            autoLockTimer = setTimeout(() => { lockAppNow(); }, autoLockMinutes * 60 * 1000);
        }

        // Wired to the header <select data-change="handleAutoLockChange">.
        function handleAutoLockChange() {
            const sel = document.getElementById("autoLockSelect");
            autoLockMinutes = parseInt(sel.value, 10) || 0;
            localStorage.setItem(AUTO_LOCK_KEY, String(autoLockMinutes));
            resetAutoLockTimer();
        }

        // Called once from bootstrap() after a successful unlock — syncs the dropdown to the
        // stored setting and starts the idle timer. Activity listeners are registered once at
        // script load (below) and are cheap no-ops while the app is locked or set to "Never".
        function initAutoLock() {
            autoLockMinutes = getAutoLockMinutes();
            const sel = document.getElementById("autoLockSelect");
            if (sel) sel.value = String(autoLockMinutes);
            resetAutoLockTimer();
        }

        AUTO_LOCK_ACTIVITY_EVENTS.forEach((evt) => {
            document.addEventListener(evt, () => {
                if (!appKey || !autoLockMinutes) return;
                // Throttled — mousemove/scroll fire far more often than the timer needs resetting.
                const now = Date.now();
                if (now - lastAutoLockActivityAt < 1000) return;
                lastAutoLockActivityAt = now;
                resetAutoLockTimer();
            }, { passive: true });
        });

        // Actually erases everything — shared by the lock screen's "Forgot passcode? Reset app
        // data" link (handleForgotPasscode, below) and the Setting page's "Reset App Data" flow
        // (handleResetAppDataSubmit, further down). Each caller does its own confirmation UI
        // first; by the time this runs, the decision is final.
        function performFullAppDataReset() {
            localStorage.removeItem(LOCK_CONFIG_KEY);
            try { indexedDB.deleteDatabase(DB_NAME); } catch (err) {}
            try { indexedDB.deleteDatabase(SECURITY_DB_NAME); } catch (err) {}
            location.reload();
        }

        async function handleForgotPasscode() {
            const step1 = await customConfirm("There is no passcode recovery. Resetting will permanently erase ALL data stored in this app on this device (accounts, transactions, categories). Continue?");
            if (!step1) return;
            const step2 = await customConfirm("Are you absolutely sure? This cannot be undone.");
            if (!step2) return;
            performFullAppDataReset();
        }

        /* ================= BIOMETRIC QUICK UNLOCK (WebAuthn platform authenticator, PRF) =================
           PRF mode only: the wrapping key that unwraps the passcode is derived directly from the
           WebAuthn PRF extension output, so that key cannot exist without redoing the biometric
           ceremony — the fingerprint/Face check is cryptographically load-bearing, not just a UI
           gate in front of a separately-stored, independently-usable key.
           (An earlier build of this file used a non-extractable AES-GCM key generated and stored
           as a plain CryptoKey object in IndexedDB, gated only by *choosing* to call
           navigator.credentials.get() first in app code. That key was still directly readable and
           usable via idb + crypto.subtle.decrypt() by anyone with script execution in the page —
           devtools, or a future XSS bug — without ever completing a WebAuthn ceremony, i.e. the
           biometric prompt didn't actually protect anything. That mode has been removed:
           enableBiometricUnlock() below only succeeds when the platform returns usable PRF output,
           and attemptBiometricUnlock() has no path that trusts an unauthenticated wrapping key.
           Any pre-existing "gate"-mode record is detected and dropped automatically, falling back
           to the passcode field until the user re-enrolls — which will only succeed on a device
           that actually supports PRF.
           PRF support is inconsistent across Android/Chrome versions/OEMs: on some devices
           credentials.create() with a `prf` extension fails outright, on others it succeeds but
           never returns usable PRF output. On those devices biometric unlock simply isn't offered;
           the passcode remains the only unlock mechanism, which is always required to exist
           regardless. Needs a secure context (https://) and a platform authenticator — quietly
           unavailable otherwise (plain file:// or an unsupported browser). */
        const SECURITY_DB_NAME = "LedgerSecurityDB_v1";
        const BIO_RECORD_KEY = "biometric";

        function openSecurityDB() {
            return new Promise((resolve, reject) => {
                const req = indexedDB.open(SECURITY_DB_NAME, 1);
                req.onupgradeneeded = (e) => {
                    const d = e.target.result;
                    if (!d.objectStoreNames.contains("security")) {
                        d.createObjectStore("security", { keyPath: "key" });
                    }
                };
                req.onsuccess = (e) => resolve(e.target.result);
                req.onerror = (e) => reject(e.target.error);
            });
        }

        async function isBiometricSupported() {
            if (!window.PublicKeyCredential || !window.isSecureContext) return false;
            try {
                return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
            } catch (err) { return false; }
        }

        function getBiometricRecord() {
            return openSecurityDB().then(secDb => new Promise((resolve) => {
                const tx = secDb.transaction(["security"], "readonly");
                const req = tx.objectStore("security").get(BIO_RECORD_KEY);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            }));
        }

        function putBiometricRecord(record) {
            return openSecurityDB().then(secDb => new Promise((resolve, reject) => {
                const tx = secDb.transaction(["security"], "readwrite");
                tx.objectStore("security").put(Object.assign({ key: BIO_RECORD_KEY }, record));
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            }));
        }

        async function disableBiometricUnlock() {
            const secDb = await openSecurityDB();
            await new Promise((resolve, reject) => {
                const tx = secDb.transaction(["security"], "readwrite");
                tx.objectStore("security").delete(BIO_RECORD_KEY);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }

        async function deriveAesKeyFromPrfBytes(bytes) {
            return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
        }

        function biometricCreateOptions(withPrf, salt) {
            const opts = {
                challenge: crypto.getRandomValues(new Uint8Array(32)),
                rp: { name: "Ledger" },
                user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "ledger-local-user", displayName: "Ledger" },
                pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
                authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
                timeout: 60000,
                attestation: "none"
            };
            if (withPrf) opts.extensions = { prf: { eval: { first: salt } } };
            return opts;
        }

        // Registers a platform-authenticator (fingerprint/Face) credential and, only if the
        // platform actually returns usable PRF output, wraps the current passcode with a key
        // derived from that output. Returns true/false — never throws.
        async function enableBiometricUnlock(passcode) {
            const salt = crypto.getRandomValues(new Uint8Array(32));
            let cred = null;
            let prfRequested = true;

            // Attempt 1: register with the PRF extension requested — the stronger binding, key is
            // derived straight from the biometric result.
            try {
                cred = await navigator.credentials.create({ publicKey: biometricCreateOptions(true, salt) });
            } catch (err) {
                console.warn("[ledger] biometric registration with PRF failed, retrying without PRF", err);
                prfRequested = false;
            }

            // Attempt 2 (fallback): some devices reject credentials.create() outright the instant a
            // `prf` extension is requested. If that happened, retry the exact same registration
            // without asking for PRF at all — this still tells us whether platform auth works, even
            // though it won't yield PRF output and enrollment will fail cleanly below.
            if (!cred) {
                try {
                    cred = await navigator.credentials.create({ publicKey: biometricCreateOptions(false, salt) });
                } catch (err2) {
                    console.error("[ledger] biometric registration failed", err2);
                    return false;
                }
            }

            // Figure out whether we actually got usable PRF output. It can come back immediately on
            // create(), or only on a follow-up get() on some platforms — and on others it never
            // comes back at all.
            let prfBytes = null;
            if (prfRequested) {
                const ext = cred.getClientExtensionResults();
                if (ext && ext.prf && ext.prf.results && ext.prf.results.first) {
                    prfBytes = ext.prf.results.first;
                } else {
                    try {
                        const assertion = await navigator.credentials.get({
                            publicKey: {
                                challenge: crypto.getRandomValues(new Uint8Array(32)),
                                allowCredentials: [{ id: cred.rawId, type: "public-key" }],
                                userVerification: "required",
                                extensions: { prf: { eval: { first: salt } } }
                            }
                        });
                        const aext = assertion.getClientExtensionResults();
                        prfBytes = aext && aext.prf && aext.prf.results && aext.prf.results.first;
                    } catch (err3) { /* leave prfBytes null — enrollment fails cleanly below */ }
                }
            }

            // No usable PRF output: do not fall back to an unauthenticated "gate" mode (see the
            // comment block above this section) — fail enrollment cleanly instead of silently
            // storing something weaker than what the UI implies.
            if (!prfBytes) {
                console.error("[ledger] biometric registration succeeded but no usable PRF output was returned; not enrolling");
                alert("This device/browser's fingerprint or Face unlock doesn't support the security capability (PRF) this app requires, so biometric unlock can't be enabled here. Continue using your passcode.");
                return false;
            }

            const iv = crypto.getRandomValues(new Uint8Array(12));
            const bioKey = await deriveAesKeyFromPrfBytes(prfBytes);
            const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, bioKey, new TextEncoder().encode(passcode));
            await putBiometricRecord({
                v: 2,
                method: "prf",
                credentialId: bufToB64(cred.rawId),
                salt: bufToB64(salt),
                iv: bufToB64(iv),
                ct: bufToB64(ctBuf)
            });
            return true;
        }

        // Prompts fingerprint/Face, redoes the PRF ceremony to reconstruct the wrapping key,
        // unwraps the passcode, then derives the real app key from it exactly like manual passcode
        // entry does. Returns true/false — never throws, so callers can silently fall back to the
        // passcode input on cancel/failure.
        async function attemptBiometricUnlock() {
            try {
                const record = await getBiometricRecord();
                if (!record) return false;

                // v1 records predate PRF support and stored a plain, directly-usable CryptoKey —
                // that mode's biometric check could be bypassed entirely by anyone with script
                // execution in the page. Rather than honor a stale record that provides false
                // reassurance, remove it and fall back to the passcode field; the user can
                // re-enroll, which will only succeed if this device actually supports PRF.
                if (record.method !== "prf") {
                    console.warn("[ledger] removing legacy insecure biometric enrollment; re-enroll to use biometric unlock (requires PRF support)");
                    await disableBiometricUnlock().catch(() => {});
                    return false;
                }

                const assertion = await navigator.credentials.get({
                    publicKey: {
                        challenge: crypto.getRandomValues(new Uint8Array(32)),
                        allowCredentials: [{ id: b64ToBuf(record.credentialId), type: "public-key" }],
                        userVerification: "required",
                        timeout: 60000,
                        extensions: { prf: { eval: { first: new Uint8Array(b64ToBuf(record.salt)) } } }
                    }
                });
                if (!assertion) return false;

                const ext = assertion.getClientExtensionResults();
                const prfBytes = ext && ext.prf && ext.prf.results && ext.prf.results.first;
                if (!prfBytes) return false;

                const bioKey = await deriveAesKeyFromPrfBytes(prfBytes);
                const ivBuf = new Uint8Array(b64ToBuf(record.iv));
                const ptBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBuf }, bioKey, b64ToBuf(record.ct));
                const passcode = new TextDecoder().decode(ptBuf);

                const cfg = getLockConfig();
                const key = await deriveKeyFromPasscode(passcode, cfg.salt, cfg.iterations);
                const check = await aesDecryptString(key, cfg.verifierIv, cfg.verifierData);
                if (check !== VERIFIER_PLAINTEXT) return false;

                appKey = key;
                currentPasscode = passcode;
                return true;
            } catch (err) {
                return false; // user cancelled, or biometric failed — caller falls back to passcode entry
            }
        }

        // Syncs the "Biometric quick unlock" toggle in the backup panel with actual availability/state.
        async function initBiometricToggleRow() {
            const row = document.getElementById("biometricToggleRow");
            const toggle = document.getElementById("biometricToggle");
            const supported = await isBiometricSupported();
            if (!supported) { row.style.display = "none"; return; }
            row.style.display = "";
            toggle.checked = !!(await getBiometricRecord());
        }

        async function handleBiometricToggleChange() {
            const toggle = document.getElementById("biometricToggle");
            if (toggle.checked) {
                try {
                    await enableBiometricUnlock(currentPasscode);
                } catch (err) {
                    toggle.checked = false;
                    alert("Could not enable biometric unlock: " + (err && err.message ? err.message : err));
                }
            } else {
                await disableBiometricUnlock();
            }
        }
        
        // Active exploration navigation states
        let activeLedgerAccountView = "all";
        let activeCategoryView = "all";
        // v85: when a category page is reached from a page that has its own year/month filter
        // (Net Savings Statement, Spending/Income Breakdown), these carry that filter's value
        // along so the category page shows only that period instead of every transaction ever
        // logged under the category. "all" means unfiltered (e.g. reached some other way).
        // Deliberately separate from the dashboard's own month/year filter — see the v74 comment
        // in renderApp() for why category drill-ins must never silently inherit that one.
        let categoryDrillYear = "all";
        let categoryDrillMonth = "all";
        let directTypeView = "all";
        // v148: month scope + one-shot year override the report card's "Total" row uses to carry
        // its selected period onto the Savings Statement — see navigateToSavingsPage() and
        // populateSavingsYearFilterOptions().
        let savingsFilterMonth = "all";
        let pendingSavingsYearOverride = null;
        // Per-account "Account Activity" year navigation (v33) — which year is currently shown,
        // and the sorted list of years that actually have a transaction for that account (used to
        // skip empty years when paging with the </> controls). Reset whenever a fresh account view
        // is opened via navigateToLedgerPage(); recomputed every renderApp().
        let accountLedgerYear = "__fresh__"; // "__fresh__" = not yet initialized for this account view; null = user explicitly chose "All Years"; a number = one specific year
        let accountLedgerYearsCache = [];
        // Portfolio General Log's own year filter (the "all accounts" ledger view) — a sibling
        // to accountLedgerYear/accountLedgerYearsCache above, but scoped across every account's
        // transactions combined instead of one account. Defaults to null ("All Years") rather
        // than "__fresh__"-then-latest-year, since that's this page's long-standing default view
        // and changing that default on every visit would be a surprising behavior change; sticky
        // across visits within the session once the user picks a specific year. Recomputed every
        // renderApp().
        let portfolioLedgerYear = null;
        let portfolioLedgerYearsCache = [];
        let ledgerBackToPage = "workspace"; 

        // v86: which page the Backup & Restore page's Back button should return to — set by
        // navigateToBackupPage()'s optional param. "datasecurity" (the default, matching the
        // pre-v86 behavior) when reached via the Data Security hub's own "Backup & Restore" row;
        // "workspace" when reached via the dashboard header's 💾 shortcut, which used to always
        // land back on the Data Security hub regardless — a page the user may never have actually
        // visited — forcing a second Back tap to actually get back to the dashboard.
        let backupBackToPage = "datasecurity";

        // Fund's own Activity page (v48) — mirrors an account's Activity page, but scoped to one
        // fund's Buy/Sell/Dividend/Contribution transactions only.
        let activeFundActivityId = null;
        let fundActivityBackToPage = "accounts";
        let activeCurrencyActivityAccountId = null;
        let activeCurrencyActivityCurrency = null;
        let currencyActivityBackToPage = "ledger";

        // Remembers how far down the workspace dashboard the user had scrolled (e.g. down to "My
        // Financial Accounts") before drilling into an account/category/type ledger view. All three
        // pages share the browser's own window-level scroll (none of them has its own scrollable
        // container), so simply un-hiding page-workspace on the way back does not by itself restore
        // where the user was — without this, returning always lands back at the very top of the
        // dashboard instead of where they left off.
        let workspaceScrollY = 0;

        // Pagination for the transaction list — avoids rendering thousands of DOM rows at once.
        let ledgerRenderLimit = 50;
        const LEDGER_PAGE_SIZE = 50;

        // v121: replaced the old single currentTxImageData (one inline receipt photo) with a
        // multi-attachment model, images and PDFs, styled after the companion Family Health &
        // Shield app. tempTxAttachments holds newly-picked files not yet written to IndexedDB
        // (full data inline); existingTxAttachments holds the lightweight {id,name,mime,thumb,size}
        // refs already stored under STORES.ATTACHMENTS for the transaction being edited (id === ""
        // for a brand-new entry means this starts empty). Removing an existing one just drops it
        // from this array — the actual IDB record isn't deleted until save time (see
        // handleTransactionSubmitMobile), so cancelling the form leaves it untouched.
        let tempTxAttachments = [];
        let existingTxAttachments = [];

        // v88: Transaction Quick View / Options / Refund / Split state.
        // Which transaction id the Quick View modal is currently showing — set by openTxQuickView(),
        // read by the toggle-checked/options/duplicate/refund/delete actions reached from it.
        let activeQuickViewTxId = null;
        // v91: set alongside activeQuickViewTxId whenever the tapped row is the representative of
        // a Split Expense group (see getSplitGroupInfo()) — holds that group's member list, null
        // otherwise. toggleTxCheckedFromQuickView() reads it to toggle Checked across every member
        // at once (Quick View shows only one Checked button for the merged row); the Options menu
        // reads it to show the "which part?" picker instead of jumping straight to Edit/Duplicate/
        // Refund/Delete, since those still act on exactly one underlying record.
        let activeQuickViewSplitGroup = null;
        // When set, the next handleTransactionSubmitMobile() save is tagged as a refund of this
        // transaction id (isRefund:true, refundOf:<id>) instead of an ordinary income entry — set by
        // openRefundFromOptions(), cleared on every openTransactionForm() call and after saving.
        let pendingRefundOf = null;
        // v99: which underlying <select> (srcAccount/destAccount) the Account picker modal is
        // currently populated for — set by openAccountPicker(), read by selectAccountPickerOption()
        // when the user taps a row.
        let accountPickerTargetSelectId = null;
        // v141: type-ahead state for the Account picker modal — restores the letter-key "jump to
        // next option starting with R" behaviour a native <select> gives for free on desktop/PC,
        // which the picker's plain list of <button> rows doesn't get automatically (see the
        // ACCOUNT PICKER TYPE-AHEAD listener below). accountPickerTypeaheadChar is the single
        // character currently being cycled through matches for; accountPickerTypeaheadIndex is the
        // index (within the full match list for that character) most recently focused, so the next
        // press of the same key advances to the next match instead of restarting from the first.
        let accountPickerTypeaheadChar = "";
        let accountPickerTypeaheadIndex = -1;
        let accountPickerTypeaheadTimer = null;
        // Calculator/numpad popup — which input field "Use This Value" writes back into.
        let calcPadTargetId = null;
        let calcPadExpr = "";
        // v88 fix: LIFO stack of currently-open modal ids, in the order openModal() was called.
        // Needed once a modal can be opened ON TOP of another already-open modal (calcPadModal
        // over txModal) — see the popstate handler below for why a flat "which of these ids has
        // .active" scan broke as soon as two modals could be active at the same time.
        let modalStack = [];
        // Split Expenses — incrementing counter for unique split-row DOM ids within one form session.
        let txSplitRowCounter = 0;

        // Default currency set (v39) — the 10 currencies the user actually holds. Rates are
        // approximate starting points only (per 1 MYR) — the user edits real values via
        // Currency Settings ▸ Save FX Values; this just avoids a blank/wrong first run.
        let baseCurrency = "MYR";
        let fxRates = {
            MYR: 1.0, SGD: 0.3025, USD: 0.225, HKD: 1.755, CNY: 1.615,
            TWD: 7.15, THB: 7.65, KRW: 305.0, JPY: 33.3, BND: 0.3025
        };
        // Currencies a fresh v39+ install (or an existing install missing some) should have —
        // merged additively into fxRates on load (mergeInDefaultCurrencies below) so an existing
        // user's own custom rates for currencies they already had are never overwritten, while
        // any of these 10 they don't yet have are added with the placeholder rate above.
        const HELD_CURRENCIES = ["MYR", "SGD", "USD", "HKD", "CNY", "TWD", "THB", "KRW", "JPY", "BND"];
        const DEFAULT_FX_RATES_BY_CURRENCY = { MYR: 1.0, SGD: 0.3025, USD: 0.225, HKD: 1.755, CNY: 1.615, TWD: 7.15, THB: 7.65, KRW: 305.0, JPY: 33.3, BND: 0.3025 };

        // Adds any of HELD_CURRENCIES missing from the current fxRates table (e.g. an existing
        // install upgrading to v39) using the placeholder default rate, converted into whatever
        // base currency is actually active — never touches a currency the user already has.
        function mergeInDefaultCurrencies() {
            let changed = false;
            const basePlaceholder = DEFAULT_FX_RATES_BY_CURRENCY[baseCurrency] || 1.0;
            HELD_CURRENCIES.forEach(c => {
                if (fxRates[c] === undefined) {
                    const perMyr = DEFAULT_FX_RATES_BY_CURRENCY[c] || 1.0;
                    fxRates[c] = perMyr / basePlaceholder;
                    changed = true;
                }
            });
            return changed;
        }
        const currencySymbols = { USD: "$", EUR: "€", GBP: "£", SGD: "S$", MYR: "RM" };
        
        // Dynamic category registry
        let dynamicCategories = [];

        // User-chosen category pre-selected whenever a NEW Income / Expense entry is opened
        // (never applied when editing an existing transaction). Stored in the SETTINGS store,
        // "" / null means "no default — leave the dropdown at its first option" as before.
        let defaultIncomeCategory = "";
        let defaultExpenseCategory = "";

        // Account pre-selected in the "Account" field whenever a NEW transaction entry is opened
        // (never applied when editing). Stored in the SETTINGS store, "" means no default set.
        let defaultPaymentAccount = "";
        let defaultReceiveAccount = "";

        // v147: independent period selection for each of the two Financial Report Card tiles on
        // the dashboard (see renderReportCards()) — one of "thisYear"/"lastYear"/"thisMonth"/
        // "lastMonth". Stored in the SETTINGS store like the defaults above, so the choice
        // survives a reload/reinstall. Defaults mirror the reference design: left card on This
        // Year, right card on This Month.
        let reportCardPeriod1 = "thisYear";
        let reportCardPeriod2 = "thisMonth";

        // v211: which year the dashboard's Monthly Trend chart shows (see
        // renderMonthlyTrendChart() below) — a single year at a time, since the chart plots all
        // 12 of that year's months side by side (an "All Years" option wouldn't fit the same
        // chart shape). Stored in SETTINGS like the report card periods above.
        let monthlyTrendYear = new Date().getFullYear().toString();

        // v220: "Auto-scale" — rescales the Monthly Trend axis to the SECOND-highest bar value
        // (across income+expense, all months) instead of the tallest one, so one outlier month
        // (e.g. a big FD payout) doesn't flatten every other month's bar down near zero. The
        // single bar(s) that then exceed the axis get visually clipped at full plot height with a
        // small notch mark (see clipNotchSVG in buildMonthlyTrendBarSVG) rather than a floating
        // text label with their real value printed above them — that label idea reads fine on a
        // wide desktop chart but collides with the legend/other bars once the same layout is
        // squeezed onto a phone screen. The existing hover/tap tooltip already shows a bar's real
        // value regardless of its clipped rendered height (it reads from data-val, not from pixel
        // height), so tapping a clipped bar is how you see the true number on any screen size —
        // one mechanism instead of two, and it already works on mobile since v215.
        let monthlyTrendAutoScale = false;

        // Built-in starter categories (auto-provisioned if missing; user can still
        // rename/remove via the Categories manager same as any custom category).
        // v101: entries may carry an optional `parent: "Main Category Name"` field to seed
        // them as a Subcategory nested under that Main Category — see ensureDefaultCategories()
        // for how parentId gets resolved from this name at seed time. Entries with no `parent`
        // are Main Categories (top-level, same as every pre-v101 entry).
        const DEFAULT_CATEGORIES = [
            { name: "Salary", type: "income", icon: "💼" },
            { name: "Housing Allowance", type: "income", icon: "🏠", parent: "Salary" },
            { name: "Handphone Claim", type: "income", icon: "📱", parent: "Salary" },
            { name: "Overseas Allowance", type: "income", icon: "✈️", parent: "Salary" },
            { name: "Backpay", type: "income", icon: "🕒", parent: "Salary" },
            { name: "Investments", type: "income", icon: "📈" },
            { name: "Freelance", type: "income", icon: "💻" },
            { name: "Dividend ASNB", type: "income", icon: "📈" },
            { name: "Divident EPF", type: "income", icon: "🏦" },
            { name: "EPF Contrib.(ER)", type: "income", icon: "🏦" },
            { name: "EPF Contrib.(EE)", type: "income", icon: "🏦" },
            { name: "CPF Contrib.(ER)", type: "income", icon: "🏦" },
            { name: "CPF Contrib.(EE)", type: "income", icon: "🏦" },
            { name: "FD Interest Income", type: "income", icon: "🏦" },
            { name: "Bank Interest", type: "income", icon: "💰" },
            { name: "Gift Received", type: "income", icon: "🎁" },
            { name: "Rebate", type: "income", icon: "💸" },
            { name: "Grants", type: "income", icon: "🎓" },
            { name: "Dividend Unit Trust", type: "income", icon: "🧺" },
            { name: "Rental Income", type: "income", icon: "🏠" },
            { name: "Bank Charges", type: "expense", icon: "💳" },
            { name: "Mortgage Interest", type: "expense", icon: "🏠" },
            { name: "Education", type: "expense", icon: "🎓" },
            { name: "Family", type: "expense", icon: "👨‍👩‍👧‍👦" },
            { name: "Betting", type: "expense", icon: "🎰" },
            { name: "Clothing", type: "expense", icon: "👕" },
            { name: "Gift Given", type: "expense", icon: "🎁" },
            { name: "Subscription", type: "expense", icon: "📡" },
            { name: "Tech Appliances", type: "expense", icon: "💻" },
            { name: "Travelling", type: "expense", icon: "✈️" },
            { name: "Tax", type: "expense", icon: "🧾" },
            { name: "Offering", type: "expense", icon: "🙏" },
            { name: "Personal Care / Grooming", type: "expense", icon: "💇" },
            { name: "Insurance", type: "expense", icon: "🛡️" },
            { name: "Medical", type: "expense", icon: "🏥" },
            { name: "Unknown", type: "expense", icon: "❓" },
            { name: "Groceries & Household", type: "expense", icon: "🧺" },
            { name: "Professional Fees", type: "expense", icon: "📋" },
            { name: "Rental Expenses", type: "expense", icon: "🏠" },
            // Vehicle Expenses (Main) + its Subcategories
            { name: "Vehicle Expenses", type: "expense", icon: "🚗" },
            { name: "Compound", type: "expense", icon: "🚨", parent: "Vehicle Expenses" },
            { name: "Car Upkeep", type: "expense", icon: "🔧", parent: "Vehicle Expenses" },
            { name: "Fuel", type: "expense", icon: "⛽", parent: "Vehicle Expenses" },
            { name: "Ins & Road Tax", type: "expense", icon: "📄", parent: "Vehicle Expenses" },
            { name: "Transportation", type: "expense", icon: "🚌", parent: "Vehicle Expenses" },
            // Property Expenses (Main) + its Subcategories
            { name: "Property Expenses", type: "expense", icon: "🏢" },
            { name: "Property Insurance", type: "expense", icon: "🛡️", parent: "Property Expenses" },
            { name: "Assmt & Quit Rent", type: "expense", icon: "🧾", parent: "Property Expenses" },
            { name: "Management Fees", type: "expense", icon: "💼", parent: "Property Expenses" },
            { name: "Property Upkeep", type: "expense", icon: "🛠️", parent: "Property Expenses" },
            { name: "Electricity Bill", type: "expense", icon: "🔌", parent: "Property Expenses" },
            { name: "Water Bill", type: "expense", icon: "💧", parent: "Property Expenses" }
        ];

        // Dynamic Rich Catalog of Preset Icons grouped logically
        const emojiDirectory = {
            "Money & Fin.": ["💵", "💰", "💳", "📈", "📉", "🪙", "💎", "💸"],
            "Food & Dining": ["🍔", "🍜", "🍕", "☕", "🍺", "🍏", "🍣", "🍩", "🍷", "🧺"],
            "Transport": ["🚗", "🚌", "🚆", "✈️", "🚲", "⛽", "🚕", "🚢"],
            "Home & Living": ["🏠", "🔌", "📡", "🛋️", "🧹", "💧", "📦", "🔑"],
            "Life & Leisure": ["🎬", "🎮", "⚽", "🏖️", "🛒", "👕", "🎁", "💊", "🎭"],
            "Income & Business": ["🏢", "💼", "💻", "🛠️", "🤝", "🏡", "🎓", "👑", "📋"],
            "Family & Pets": ["👨‍👩‍👧‍👦", "🐹", "🐄", "🐶", "🐱"]
        };

        // Fallback default system icons if not found
        const fallbackIcons = {
            income: "🟢",
            expense: "🔴",
            transfer: "🔄",
            salary: "💼",
            investments: "📈",
            freelance: "💻",
            others: "📦",
            "other income": "📦",
            "other expenses": "📦",
            groceries: "🍏",
            "dining out": "🍔",
            utilities: "🔌",
            rent: "🏠",
            commute: "🚌",
            entertainment: "🎬",
            "opening balance": "🏛️",
            "fixed deposit": "🏦",
            "interest income": "💰",
            "dividend asnb": "📈",
            "divident epf": "🏦",
            "epf contrib.(er)": "🏦",
            "epf contrib.(ee)": "🏦",
            "cpf contrib.(er)": "🏦",
            "cpf contrib.(ee)": "🏦",
            "fd interest": "🏦",
            "fd interest income": "🏦",
            "bank interest": "💰",
            "gift received": "🎁",
            "rebate": "💸",
            "grants": "🎓",
            "bank charges": "💳",
            "education": "🎓",
            "family": "👨‍👩‍👧‍👦",
            "betting": "🎰",
            "clothing": "👕",
            "gift given": "🎁",
            "subscription": "📡",
            "tech appliances": "💻",
            "travelling": "✈️",
            "tax": "🧾",
            "offering": "🙏",
            "personal care / grooming": "💇",
            "insurance": "🛡️",
            "medical": "🏥",
            "unknown": "❓",
            "groceries & household": "🧺",
            "professional fees": "📋"
        };

        // Helper to retrieve correct category icon safely
        function getCategoryIcon(catName, type = "expense") {
            const clean = catName.toLowerCase().trim();
            const matched = dynamicCategories.find(c => c.name.toLowerCase() === clean);
            if (matched) return matched.icon;
            return fallbackIcons[clean] || (type === "income" ? "🟢" : "🔴");
        }

        // v101: shared builder for every <select> that lists categories for picking on a
        // transaction (Add/Edit Transaction, each Split row, Default Category selects) — replaces
        // 3-4 near-duplicate blocks that each built their own flat, alphabetically-sorted option
        // list. Now groups Subcategories under their Main Category via <optgroup> (still choosing
        // between the Main Category's own "(General)" option or one of its Subcategories), while a
        // Main Category with no Subcategories, or a legacy/fallback name with no matching category
        // record at all, still renders as a single flat top-level <option> exactly as before.
        // `namesToInclude` is the caller's own must-include name list (e.g. names currently in use
        // on existing transactions, so a renamed/deleted category doesn't vanish from its own
        // transaction's dropdown) — merged with the full legacy + DEFAULT_CATEGORIES fallback set.
        function buildCategoryOptionsHTML(type, namesToInclude) {
            const legacyFallback = type === "income" ? ["Salary", "Investments", "Freelance", "Other Income"] : ["Groceries", "Dining Out", "Utilities", "Rent", "Commute", "Entertainment", "Other Expenses"];
            const fallbackGroup = [...legacyFallback, ...DEFAULT_CATEGORIES.filter(c => c.type === type).map(c => c.name)];
            const allNames = new Set([...(namesToInclude || []), ...fallbackGroup]);

            const typeCats = dynamicCategories.filter(c => c.type === type);
            const mains = typeCats.filter(c => !c.parentId).sort((a, b) => a.name.localeCompare(b.name));

            // v145: each entry (a Main Category block, or a leftover flat name) is built as
            // {name, html} and ALL entries are sorted together by name at the end, instead of
            // emitting every Main Category block first and appending leftover/fallback names
            // afterward in their own separate sorted run. The old two-pass approach produced two
            // back-to-back alphabetical sequences in the rendered <select> (e.g. ...Unknown, Vehicle
            // Expenses, then restarting at Commute, Dining Out...) which read as broken sorting even
            // though each pass was individually sorted. A Main Category's sort position uses its own
            // name even when it renders as an <optgroup> (so "Vehicle Expenses" sorts under V).
            const covered = new Set();
            const entries = [];

            mains.forEach(main => {
                if (!allNames.has(main.name)) return;
                const subs = typeCats.filter(c => c.parentId === main.id && allNames.has(c.name)).sort((a, b) => a.name.localeCompare(b.name));
                covered.add(main.name);
                subs.forEach(s => covered.add(s.name));
                let html;
                if (subs.length) {
                    html = `<optgroup label="${main.icon} ${escapeHtml(main.name)}">`;
                    html += `<option value="${escapeHtml(main.name)}">${main.icon} ${escapeHtml(main.name)} (General)</option>`;
                    subs.forEach(s => { html += `<option value="${escapeHtml(s.name)}">${s.icon} ${escapeHtml(s.name)}</option>`; });
                    html += `</optgroup>`;
                } else {
                    html = `<option value="${escapeHtml(main.name)}">${main.icon} ${escapeHtml(main.name)}</option>`;
                }
                entries.push({ name: main.name, html });
            });

            // Anything left over — legacy/fallback names with no matching category record, or a
            // Subcategory whose parent record is missing from `allNames` for some reason — still
            // gets shown, as a flat top-level option, rather than silently disappearing. Now merged
            // into the same sorted `entries` array rather than tacked on after.
            [...allNames].filter(n => !covered.has(n)).forEach(n => {
                entries.push({ name: n, html: `<option value="${escapeHtml(n)}">${getCategoryIcon(n, type)} ${escapeHtml(n)}</option>` });
            });

            entries.sort((a, b) => a.name.localeCompare(b.name));
            return entries.map(e => e.html).join("");
        }

        // v91: Split Expenses groups (see collectTxSplitRows()/saveTransactionSubmit() around the
        // splitGroupId comment) — each split part is saved as its own ordinary transaction record
        // sharing a generated splitGroupId, purely for traceability. Every list view (dashboard
        // Recent Transactions, an account's Currency/Ledger Activity) previously showed each part
        // as its own separate row (e.g. one McD payment split Clothing/Dining Out appeared as two
        // unrelated-looking rows) instead of one combined row like the reference app screenshots
        // this was modeled on. This helper computes the DISPLAY-ONLY merge: given one member of a
        // group, returns every member (sorted by id — the lowest id is the original "main" part,
        // saved first, so it's the representative row the others collapse into), the summed
        // amount, and a comma-joined category label. Returns null for an ordinary transaction, or
        // for an orphaned split part whose siblings were since deleted individually (falls back to
        // rendering as a normal single-category row rather than vanishing). Nothing about balance
        // or report totals changes — those still iterate every individual record exactly as
        // before this existed; only which HTML row(s) a given transaction produces is affected.
        function getSplitGroupInfo(tx, allTxs) {
            if (!tx.splitGroupId) return null;
            const members = allTxs.filter(t => t.splitGroupId === tx.splitGroupId).sort((a, b) => a.id - b.id);
            if (members.length < 2) return null;
            return {
                repId: members[0].id,
                members,
                totalAmount: members.reduce((sum, m) => sum + m.amount, 0),
                catLabel: members.map(m => m.cat).join(", "),
            };
        }

        // --- NATIVE ROUTING CORE (MOBILE BACK-BUTTON COUPLING) ---
        function pushVirtualState(stateName) {
            window.history.pushState({ view: stateName }, "");
        }

        window.addEventListener("popstate", (event) => {
            // v143 fix: this used to call resetAccountForm() and return here, which reset the
            // Add/Edit Account form to blank "Create New Account" state but left the modal's
            // "active" class in place AND re-pushed a fresh history entry for it (see
            // resetAccountForm's own pushVirtualState call). That meant one hardware/gesture
            // back press while editing an account never actually closed anything — it just
            // showed the same modal reset to blank (matching the × button's old "needs two
            // clicks" bug, documented in closeModal() below) — while quietly consuming and
            // replacing a history entry. A second back press then closed the modal for real,
            // but by then the JS history stack and the real back stack were a step out of
            // sync, so instead of landing on the account's Activity page, the app exited.
            // Clearing the edit state here (without the re-push) and falling through to the
            // normal modal-close logic below closes it in one press, exactly like × does.
            if (document.getElementById("editAccountId").value !== "") {
                resetAccountForm(/* skipHistoryPush */ true);
            }

            // v88 fix: previously this scanned every known modal id and removed "active" from
            // ALL of them that happened to be open. That's correct when at most one modal is ever
            // open at a time, but v88 introduced calcPadModal, which opens ON TOP of an
            // already-open txModal (tap 🧮 in Add/Edit Transaction) — so both had the "active"
            // class simultaneously. Tapping the calculator's × or "Use This Value" called
            // closeModal("calcPadModal") → history.back() → this handler → the old loop closed
            // BOTH modals in one shot, since it didn't distinguish "the modal that should close
            // now" from "any modal that's currently open" — so the whole Add/Edit Transaction
            // form was discarded along with the calculator. Now only the most-recently-opened
            // modal (top of modalStack) is closed per back-navigation, matching how it was opened.
            let modalClosed = false;
            if (modalStack.length > 0) {
                const topId = modalStack.pop();
                const modal = document.getElementById(topId);
                if (modal) modal.classList.remove("active");
                modalClosed = true;
            }
            if (modalClosed) return;

            const ledgerPage = document.getElementById("page-ledger");
            const savingsPage = document.getElementById("page-savings");
            const networthStatementPage = document.getElementById("page-networth-statement");
            const accountsPage = document.getElementById("page-accounts");
            const categoriesPage = document.getElementById("page-categories");
            const backupPage = document.getElementById("page-backup");
            const autolockPage = document.getElementById("page-autolock");
            const databasePage = document.getElementById("page-database");
            const spendingBreakdownPage = document.getElementById("page-spending-breakdown");
            const incomeBreakdownPage = document.getElementById("page-income-breakdown");
            const portfolioReportPage = document.getElementById("page-portfolio-report");
            const ownerNetWorthReportPage = document.getElementById("page-owner-networth-report");
            const currencyReportPage = document.getElementById("page-currency-report");
            const navUpdatePage = document.getElementById("page-navupdate");
            const dataSecurityPage = document.getElementById("page-datasecurity");
            const membersPage = document.getElementById("page-members");
            const memberPage = document.getElementById("page-member");
            const fundActivityPage = document.getElementById("page-fundactivity");
            const currencyActivityPage = document.getElementById("page-currencyactivity");

            if (!ledgerPage.classList.contains("hidden")) {
                handleLedgerBackClick();
            } else if (!currencyActivityPage.classList.contains("hidden")) {
                handleCurrencyActivityBackClick();
            } else if (!fundActivityPage.classList.contains("hidden")) {
                handleFundActivityBackClick();
            } else if (!membersPage.classList.contains("hidden")) {
                navigateToDataSecurityPage();
            } else if (!memberPage.classList.contains("hidden")) {
                navigateToWorkspace();
            } else if (!accountsPage.classList.contains("hidden")) {
                // v222 fix: was bucketed with the plain-navigateToWorkspace() group below,
                // which ignored where Accounts was actually opened from (e.g. Net Worth
                // Statement) — same gap as the on-screen "← Back" button, fixed the same way.
                handleAccountsBackClick();
            } else if (
                !savingsPage.classList.contains("hidden") ||
                !networthStatementPage.classList.contains("hidden") ||
                !categoriesPage.classList.contains("hidden") ||
                !backupPage.classList.contains("hidden") ||
                !autolockPage.classList.contains("hidden") ||
                !databasePage.classList.contains("hidden") ||
                !spendingBreakdownPage.classList.contains("hidden") ||
                !incomeBreakdownPage.classList.contains("hidden") ||
                !portfolioReportPage.classList.contains("hidden") ||
                !ownerNetWorthReportPage.classList.contains("hidden") ||
                !currencyReportPage.classList.contains("hidden") ||
                !navUpdatePage.classList.contains("hidden") ||
                !dataSecurityPage.classList.contains("hidden")
            ) {
                navigateToWorkspace();
            }
        });

        function initDB() {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(DB_NAME, DB_VERSION);
                request.onsuccess = (e) => { db = e.target.result; resolve(db); };
                request.onupgradeneeded = (e) => {
                    const database = e.target.result;
                    if (!database.objectStoreNames.contains(STORES.ACCOUNTS)) {
                        database.createObjectStore(STORES.ACCOUNTS, { keyPath: "id" });
                    }
                    if (!database.objectStoreNames.contains(STORES.TRANSACTIONS)) {
                        database.createObjectStore(STORES.TRANSACTIONS, { keyPath: "id", autoIncrement: true });
                    }
                    if (!database.objectStoreNames.contains(STORES.SETTINGS)) {
                        database.createObjectStore(STORES.SETTINGS, { keyPath: "key" });
                    }
                    if (!database.objectStoreNames.contains(STORES.CATEGORIES)) {
                        database.createObjectStore(STORES.CATEGORIES, { keyPath: "id" });
                    }
                    if (!database.objectStoreNames.contains(STORES.MEMBERS)) {
                        database.createObjectStore(STORES.MEMBERS, { keyPath: "id" });
                    }
                    if (!database.objectStoreNames.contains(STORES.FUNDS)) {
                        database.createObjectStore(STORES.FUNDS, { keyPath: "id" });
                    }
                    if (!database.objectStoreNames.contains(STORES.NAV_HISTORY)) {
                        // One record per NAV Date (keyPath "date", e.g. "2026-08-17") — re-saving
                        // the same date overwrites it rather than creating a duplicate History row.
                        database.createObjectStore(STORES.NAV_HISTORY, { keyPath: "date" });
                    }
                    if (!database.objectStoreNames.contains(STORES.ATTACHMENTS)) {
                        // v121: one record per attachment file (id, name, mime, data — data is a full
                        // base64 data URL). Goes through the same writeDB()/encryptRecord() path as
                        // every other store, so it's encrypted (when app-lock is set up) exactly like
                        // accounts/transactions/etc — no separate crypto path needed. Transactions only
                        // keep a lightweight {id, name, mime, thumb, size} reference in their own
                        // `attachments` array; the actual file bytes live only here.
                        database.createObjectStore(STORES.ATTACHMENTS, { keyPath: "id" });
                    }
                };
                request.onerror = (e) => reject(e.target.error);
            });
        }

        async function writeDB(storeName, data) {
            const encrypted = await encryptRecord(storeName, data);
            return new Promise((resolve, reject) => {
                try {
                    const tx = db.transaction([storeName], "readwrite");
                    tx.objectStore(storeName).put(encrypted);
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => reject(tx.error);
                } catch (err) { reject(err); }
            });
        }

        async function readAllDB(storeName) {
            const raw = await new Promise((resolve, reject) => {
                try {
                    const tx = db.transaction([storeName], "readonly");
                    const req = tx.objectStore(storeName).getAll();
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                } catch (err) { reject(err); }
            });
            return Promise.all(raw.map(rec => decryptRecord(storeName, rec)));
        }

        function deleteDB(storeName, key) {
            return new Promise((resolve, reject) => {
                try {
                    const tx = db.transaction([storeName], "readwrite");
                    tx.objectStore(storeName).delete(key);
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => reject(tx.error);
                } catch (err) { reject(err); }
            });
        }

        // Dashboard "Recent Transactions" widget settings (v35) — persisted via SETTINGS store,
        // loaded in bootstrap(). "both" for type means Income + Expense (Transfers are never
        // included — the filter options are explicitly Expense/Income/Both, not Transfer).
        let recentTxTypeFilter = "both"; // "both" | "income" | "expense"
        let recentTxAccountFilter = "all"; // "all" | accountId
        let recentTxCount = 5; // 1-14
        // v224: which of the two Dashboard widgets (Accounts / Recent Transactions) renders
        // first — configured from Setting > Dashboard Widgets, applied via
        // applyDashboardWidgetOrder(). Persisted via SETTINGS like the filters above.
        let dashboardWidgetOrder = "accounts-first"; // "accounts-first" | "recenttx-first"

        // Dashboard "Accounts" widget settings (v75) — persisted via SETTINGS store, loaded in
        // bootstrap(). Mirrors the Recent Transactions widget above, but instead of a type/account
        // filter it's a fixed set of numbered slots, each pinned to one specific account (matching
        // the per-slot account-picker layout the user referenced from another budgeting app) —
        // pinnedAccountIds[i] is the account id for slot i, or "" if that slot is unset.
        let pinnedAccountCount = 5; // 1-10
        let pinnedAccountIds = []; // array of accountId | "", length === pinnedAccountCount

        // "Net Worth by Member" collapse state (v75) — persisted via SETTINGS store, loaded in
        // bootstrap(). Purely a display toggle; doesn't affect the totals shown elsewhere.
        let memberNetWorthCollapsed = false;

        function populateRecentTxAccountSelect(accounts) {
            const sel = document.getElementById("recentTxAccountSelect");
            if (!sel) return;
            const current = recentTxAccountFilter;
            sel.innerHTML = `<option value="all">All Accounts</option>` +
                accounts.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(accountOptionLabel(a, accounts))}</option>`).join("");
            sel.value = accounts.some(a => a.id === current) ? current : "all";
            syncAccountPickerButtonText("recentTxAccountSelect");
        }

        function populateRecentTxCountSelect() {
            const sel = document.getElementById("recentTxCountSelect");
            if (!sel || sel.options.length > 0) return;
            for (let i = 1; i <= 14; i++) {
                sel.innerHTML += `<option value="${i}">${i} item${i === 1 ? '' : 's'}</option>`;
            }
        }

        // Draws the compact "Recent Transactions" list on the dashboard — a small slice of
        // Income/Expense entries (never Transfers) filtered/limited per the settings panel above it.
        function renderRecentTransactionsWidget(accounts, txs) {
            const list = document.getElementById("recentTxList");
            if (!list) return;

            populateRecentTxCountSelect();
            populateRecentTxAccountSelect(accounts);
            const typeSel = document.getElementById("recentTxTypeSelect");
            const countSel = document.getElementById("recentTxCountSelect");
            if (typeSel) typeSel.value = recentTxTypeFilter;
            if (countSel) countSel.value = String(recentTxCount);
            syncAccountPickerButtonText("recentTxTypeSelect");
            syncAccountPickerButtonText("recentTxCountSelect");

            let filtered = txs.filter(t => t.type === "income" || t.type === "expense");
            if (recentTxTypeFilter !== "both") filtered = filtered.filter(t => t.type === recentTxTypeFilter);
            if (recentTxAccountFilter !== "all") filtered = filtered.filter(t => t.src === recentTxAccountFilter);

            // v91: collapse each Split Expense group to its representative row BEFORE sorting/
            // slicing to recentTxCount, so the count setting reflects visible rows (one per
            // group), not raw per-category records — see getSplitGroupInfo().
            filtered = filtered.filter(t => {
                if (!t.splitGroupId) return true;
                const info = getSplitGroupInfo(t, txs);
                return !info || t.id === info.repId;
            });

            filtered = [...filtered].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, recentTxCount);

            if (filtered.length === 0) {
                list.innerHTML = `<p style="color:var(--text-muted); text-align:center; padding:16px 0; font-size:0.85rem;">No matching transactions yet.</p>`;
                return;
            }

            list.innerHTML = filtered.map(t => {
                const col = t.type === "income" ? "income-color" : "expense-color";
                const sgn = t.type === "income" ? "+" : "-";
                const splitInfo = t.splitGroupId ? getSplitGroupInfo(t, txs) : null;
                const displayCat = splitInfo ? splitInfo.catLabel : (t.cat || '');
                const displayAmount = splitInfo ? splitInfo.totalAmount : t.amount;
                const iconBadge = splitInfo
                    ? splitInfo.members.map(m => getCategoryIcon(m.cat, t.type)).join("")
                    : getCategoryIcon(t.cat, t.type);
                const acc = accounts.find(a => a.id === t.src);
                // v96: Notes now doubles as the free-text "who/what" line that the removed To/From
                // field used to cover (see the txPayee removal above), so it's worth surfacing right
                // on the row — not just inside Quick View — matching the reference screenshot's
                // merchant/description line under the account.
                const notesLine = t.notes ? `<span class="item-meta" style="display:block; margin-top:2px; color:var(--text-muted); font-style:italic;">${escapeHtml(t.notes)}</span>` : '';
                return `
                    <div class="ledger-item" data-click="openTxQuickView" data-type="${t.type}" data-id="${escapeHtml(t.id)}">
                        <div class="item-left">
                            <span class="item-name">${iconBadge} ${escapeHtml(t.desc)}</span>
                            <span class="item-meta">${t.date} [${escapeHtml(displayCat)}]</span>
                            <span class="item-meta" style="display:block; margin-top:2px; color:var(--text-muted);">🏦 ${acc ? escapeHtml(accountOptionLabel(acc, accounts)) : "(deleted account)"}</span>
                            ${notesLine}
                        </div>
                        <div class="item-right">
                            <div class="item-value" style="color:var(--${col}); font-weight:bold;">${sgn}${formatCurrency(displayAmount, t.currency)}</div>
                        </div>
                    </div>
                `;
            }).join("");
        }

        // v224: single toggle for the relocated Dashboard Widgets settings panel (Setting hub) —
        // replaces the two separate inline "⚙ Settings" buttons that used to sit directly on the
        // Dashboard's Accounts/Recent Transactions widgets. Syncs the order <select> to the
        // current setting each time the panel opens, same as toggleBgThemeSettings() does for
        // its swatch grid.
        function toggleDashboardWidgetsSettings() {
            const panel = document.getElementById("dashboardWidgetsSettingsPanel");
            if (!panel) return;
            const isHidden = panel.style.display === "none";
            if (isHidden) {
                const orderSel = document.getElementById("dashboardWidgetOrderSelect");
                if (orderSel) orderSel.value = dashboardWidgetOrder;
                syncAccountPickerButtonText("dashboardWidgetOrderSelect");
            }
            panel.style.display = isHidden ? "flex" : "none";
        }

        // v227: single toggle for the relocated Default Payment/Receive Account settings panel
        // (Setting hub) — these used to live in a card at the top of the Accounts page; moved
        // here since they're app-wide preferences, not something specific to browsing accounts.
        // Re-populates both pickers from the accounts list each time the panel opens, same as
        // toggleDashboardWidgetsSettings() does for its own select.
        async function toggleDefaultAccountsSettings() {
            const panel = document.getElementById("defaultAccountsSettingsPanel");
            if (!panel) return;
            const isHidden = panel.style.display === "none";
            if (isHidden) {
                await populateDefaultPaymentAccountSelect();
                await populateDefaultReceiveAccountSelect();
            }
            panel.style.display = isHidden ? "flex" : "none";
        }

        // v224: persists the chosen Dashboard widget order and re-renders so it takes effect
        // immediately, even though the Dashboard itself isn't the visible page right now.
        async function handleDashboardWidgetOrderChange() {
            const sel = document.getElementById("dashboardWidgetOrderSelect");
            dashboardWidgetOrder = (sel && sel.value === "recenttx-first") ? "recenttx-first" : "accounts-first";
            await writeDB(STORES.SETTINGS, { key: "dashboardWidgetOrder", value: dashboardWidgetOrder });
            applyDashboardWidgetOrder();
        }

        // v224: physically reorders the two dashboard widget containers to match
        // dashboardWidgetOrder. insertBefore(X, Y) always places X immediately ahead of Y
        // regardless of their current order, so this is safe to call on every renderApp() —
        // idempotent, no "already in the right place" check needed.
        function applyDashboardWidgetOrder() {
            const accountsWidget = document.getElementById("dashboardAccountsWidget");
            const recentTxWidget = document.getElementById("dashboardRecentTxWidget");
            if (!accountsWidget || !recentTxWidget || !accountsWidget.parentNode) return;
            if (dashboardWidgetOrder === "recenttx-first") {
                accountsWidget.parentNode.insertBefore(recentTxWidget, accountsWidget);
            } else {
                accountsWidget.parentNode.insertBefore(accountsWidget, recentTxWidget);
            }
        }

        // v181: Desktop "Insights" right rail (only visible at 1400px+, see the matching CSS).
        // Three lightweight, non-configurable summaries — deliberately no settings/filters like
        // the dashboard's other widgets, since this is meant as a quick glance while working with
        // the main content, not a destination in itself:
        //   1. Spending Breakdown (This Month) — a donut chart, v183, reusing the same
        //      buildBreakdownDonutSVG() the full-page Spending Breakdown uses (see below), same
        //      expense/refund convention as #2.
        //   2. Top Categories This Month — same expense/refund convention as Spending Breakdown
        //      (a refund nets back against its own category rather than being ignored outright).
        //   3. Recent Large Transactions — the biggest income/expense entries (transfers excluded,
        //      since they don't represent money actually gained/spent) from the last 60 days.
        // No-ops harmlessly if the rail markup isn't present (defensive, matches the existing
        // `if (!list) return;` pattern in renderRecentTransactionsWidget above).
        function renderDesktopInsightsRail(accounts, txs) {
            const catListEl = document.getElementById("insightsTopCategoriesList");
            const largeTxListEl = document.getElementById("insightsLargeTxList");
            const donutWrapEl = document.getElementById("insightsSpendingDonutWrap");
            if (!catListEl || !largeTxListEl) return;

            const now = new Date();
            const curMonth = now.getMonth();
            const curYear = now.getFullYear();

            const catTotals = {};
            txs.forEach(t => {
                const isRefundCredit = t.type === "income" && t.isRefund;
                if (t.type !== "expense" && !isRefundCredit) return;
                const d = new Date(t.date);
                if (d.getMonth() !== curMonth || d.getFullYear() !== curYear) return;
                const base = convertTxAmountToBase(t, accounts);
                const cat = t.cat || "Other Expenses";
                catTotals[cat] = (catTotals[cat] || 0) + (isRefundCredit ? -base : base);
            });
            const topCats = Object.keys(catTotals).filter(c => catTotals[c] > 0).sort((a, b) => catTotals[b] - catTotals[a]).slice(0, 5);
            const maxCatAmt = topCats.length ? catTotals[topCats[0]] : 0;

            catListEl.innerHTML = topCats.length ? topCats.map(c => {
                const amt = catTotals[c];
                const pct = maxCatAmt > 0 ? Math.round((amt / maxCatAmt) * 100) : 0;
                return `
                    <div class="insights-row">
                        <div class="insights-row-top">
                            <span class="insights-row-label">${getCategoryIcon(c, "expense")} ${escapeHtml(c)}</span>
                            <span class="insights-row-amount">${formatCurrency(amt, baseCurrency)}</span>
                        </div>
                        <div class="progress-bar-container"><div class="progress-bar-fill" style="width:${pct}%;"></div></div>
                    </div>
                `;
            }).join("") : `<p class="insights-empty">No expenses yet this month.</p>`;

            // v183: same catTotals as the list above, but as a full donut chart — every category
            // with a positive net spend this month gets a slice (no top-5 cap, matching how the
            // full-page Spending Breakdown never caps its own chart either), colored/sorted the
            // same way that page does (BREAKDOWN_CHART_COLORS cycled by descending-spend rank).
            if (donutWrapEl) {
                const allCatsDesc = Object.keys(catTotals).filter(c => catTotals[c] > 0).sort((a, b) => catTotals[b] - catTotals[a]);
                const donutTotal = allCatsDesc.reduce((sum, c) => sum + catTotals[c], 0);
                const donutEntries = allCatsDesc.map((c, i) => ({ label: c, value: catTotals[c], color: BREAKDOWN_CHART_COLORS[i % BREAKDOWN_CHART_COLORS.length] }));
                if (donutEntries.length) renderDonutIntoWrap("insightsSpendingDonutWrap", donutEntries, donutTotal, "expense");
                else donutWrapEl.innerHTML = `<p class="insights-empty">No expenses yet this month.</p>`;
            }

            const cutoffMs = now.getTime() - 60 * 86400000;
            const largeTx = txs
                .filter(t => (t.type === "income" || t.type === "expense") && new Date(t.date).getTime() >= cutoffMs)
                .map(t => ({ t, base: convertTxAmountToBase(t, accounts) }))
                .sort((a, b) => b.base - a.base)
                .slice(0, 5);

            largeTxListEl.innerHTML = largeTx.length ? largeTx.map(({ t, base }) => {
                const col = t.type === "income" ? "income-color" : "expense-color";
                const sgn = t.type === "income" ? "+" : "-";
                return `
                    <div class="insights-row insights-tx-row" data-click="openTxQuickView" data-type="${t.type}" data-id="${escapeHtml(t.id)}">
                        <div class="insights-row-top">
                            <span class="insights-row-label">${getCategoryIcon(t.cat, t.type)} ${escapeHtml(t.desc)}</span>
                        </div>
                        <div class="insights-row-top" style="margin-top:2px;">
                            <span class="insights-tx-date">${t.date}</span>
                            <span class="insights-row-amount" style="color:var(--${col});">${sgn}${formatCurrency(base, baseCurrency)}</span>
                        </div>
                    </div>
                `;
            }).join("") : `<p class="insights-empty">No large transactions in the last 60 days.</p>`;
        }

        async function handleRecentTxSettingChange() {
            recentTxTypeFilter = document.getElementById("recentTxTypeSelect").value;
            recentTxAccountFilter = document.getElementById("recentTxAccountSelect").value;
            recentTxCount = parseInt(document.getElementById("recentTxCountSelect").value, 10) || 5;
            await writeDB(STORES.SETTINGS, { key: "recentTxTypeFilter", value: recentTxTypeFilter });
            await writeDB(STORES.SETTINGS, { key: "recentTxAccountFilter", value: recentTxAccountFilter });
            await writeDB(STORES.SETTINGS, { key: "recentTxCount", value: recentTxCount });
            await renderApp();
        }

        function populatePinnedAccountCountSelect() {
            const sel = document.getElementById("pinnedAccountCountSelect");
            if (!sel || sel.options.length > 0) return;
            for (let i = 1; i <= 10; i++) {
                sel.innerHTML += `<option value="${i}">${i} item${i === 1 ? '' : 's'}</option>`;
            }
        }

        // Builds one account-picker <select> per configured slot (1..pinnedAccountCount), each
        // pre-selected to whichever account is currently pinned there — mirrors the reference
        // screenshot's "Number of items shown" + one numbered dropdown per slot layout.
        // v226: each slot's <select> now pairs with an account-picker-btn (see openAccountPicker())
        // instead of rendering as a plain native <select> — matches the styling the user pointed
        // to (Image 1's "Select Account" list) used elsewhere in the app (srcAccount,
        // defaultPaymentAccountSelect, etc.), rather than the OS's own cramped dropdown/wheel.
        // Needs a stable per-slot id (`pinnedAccountSlotSelect${i}`) since data-select targets an
        // id, not a data-slot index — data-slot is kept on the (now-hidden) <select> itself only
        // for handlePinnedAccountSlotChange to read.
        function renderPinnedAccountSlotSelects(accounts) {
            const wrap = document.getElementById("pinnedAccountSlotSelects");
            if (!wrap) return;
            let html = "";
            for (let i = 0; i < pinnedAccountCount; i++) {
                const current = pinnedAccountIds[i] || "";
                const selId = `pinnedAccountSlotSelect${i}`;
                html += `
                    <div class="form-row" style="margin-bottom:0;">
                        <label>${i + 1}:</label>
                        <button type="button" id="${selId}Btn" class="form-input account-picker-btn" data-click="openAccountPicker" data-select="${selId}" data-title="Slot ${i + 1} Account">
                            <span id="${selId}BtnText">Select...</span><span class="account-picker-chevron">▾</span>
                        </button>
                        <select id="${selId}" style="display:none;" data-change="handlePinnedAccountSlotChange" data-slot="${i}">
                            <option value="">(None)</option>
                            ${accounts.map(a => `<option value="${escapeHtml(a.id)}" ${a.id === current ? "selected" : ""}>${escapeHtml(accountOptionLabel(a, accounts))}</option>`).join("")}
                        </select>
                    </div>
                `;
            }
            wrap.innerHTML = html;
            // Button labels are freshly-rendered DOM, not carried over from before, so each one
            // needs an explicit sync — the `selected` attribute above only sets the hidden
            // <select>'s value, it doesn't touch its picker button's text on its own.
            for (let i = 0; i < pinnedAccountCount; i++) syncAccountPickerButtonText(`pinnedAccountSlotSelect${i}`);
        }

        async function handlePinnedAccountCountChange() {
            pinnedAccountCount = parseInt(document.getElementById("pinnedAccountCountSelect").value, 10) || 5;
            // Trim or pad the pinned list to match the new count — existing picks in slots that
            // still exist are preserved; slots beyond the new count are simply dropped (not
            // deleted from anywhere else, they just stop being one of the numbered slots).
            pinnedAccountIds = pinnedAccountIds.slice(0, pinnedAccountCount);
            while (pinnedAccountIds.length < pinnedAccountCount) pinnedAccountIds.push("");
            await writeDB(STORES.SETTINGS, { key: "pinnedAccountCount", value: pinnedAccountCount });
            await writeDB(STORES.SETTINGS, { key: "pinnedAccountIds", value: pinnedAccountIds });
            await renderApp();
        }

        async function handlePinnedAccountSlotChange(el) {
            const slot = parseInt(el.dataset.slot, 10);
            if (Number.isNaN(slot)) return;
            while (pinnedAccountIds.length <= slot) pinnedAccountIds.push("");
            pinnedAccountIds[slot] = el.value;
            await writeDB(STORES.SETTINGS, { key: "pinnedAccountIds", value: pinnedAccountIds });
            await renderApp();
        }

        // Draws the dashboard's "Accounts" widget — a fixed set of accounts pinned to specific
        // numbered slots via the settings panel above it, in slot order. Slots left on "(None)"
        // are just skipped rather than rendered as empty rows.
        function renderPinnedAccountsWidget(accounts, nativeBalances) {
            const list = document.getElementById("pinnedAccountsList");
            if (!list) return;

            populatePinnedAccountCountSelect();
            const countSel = document.getElementById("pinnedAccountCountSelect");
            if (countSel) countSel.value = String(pinnedAccountCount);
            syncAccountPickerButtonText("pinnedAccountCountSelect");
            renderPinnedAccountSlotSelects(accounts);

            const rows = pinnedAccountIds
                .map(id => accounts.find(a => a.id === id))
                .filter(Boolean);

            if (rows.length === 0) {
                list.innerHTML = `<p style="color:var(--text-muted); text-align:center; padding:16px 0; font-size:0.85rem;">No accounts pinned yet — go to Setting &gt; Dashboard Widgets to choose some.</p>`;
                return;
            }

            list.innerHTML = rows.map(a => {
                const baseVal = accountBaseValue(a, nativeBalances);
                const metaLine = accountOwnerNamesText(a) + accountRelatedSuffix(a, accounts);
                return `
                    <div class="ledger-item" data-click="navigateToLedgerPage" data-id="${escapeHtml(a.id)}">
                        <div class="item-left">
                            <span class="item-name">${escapeHtml(a.name)}</span>
                            <span class="item-meta">${escapeHtml(metaLine)}</span>
                        </div>
                        <div class="item-right">
                            <div class="item-value" style="font-weight:bold;">${formatBalanceHTML(baseVal, baseCurrency)}</div>
                        </div>
                    </div>
                `;
            }).join("");
        }

        function formatCurrency(amount, curr) {
            const sym = currencySymbols[curr] || curr;
            return `${sym}${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        }

        // Formats a balance-type amount (net worth, account balance, member totals — anything
        // that can legitimately sit in deficit) as HTML: negative amounts render in red,
        // parenthesized on the absolute value (accounting convention), e.g. (S$8,648.94).
        // Positive/zero amounts render exactly like formatCurrency. Only use this for contexts
        // assigned via innerHTML — for a plain transaction amount (always shown with its own
        // explicit +/- sign elsewhere), use formatCurrency instead.
        function formatBalanceHTML(amount, curr) {
            if (amount < 0) {
                return `<span style="color:var(--expense-color);">(${formatCurrency(Math.abs(amount), curr)})</span>`;
            }
            return formatCurrency(amount, curr);
        }

        function convertCurrency(amount, fromCurr, toCurr) {
            if (fromCurr === toCurr) return amount;
            return (amount / fxRates[fromCurr]) * fxRates[toCurr];
        }

        // Converts a transaction's own amount/currency into the base currency for reporting
        // (dashboard totals, Spending/Income Breakdown, Net Savings Statement). If the
        // transaction has a manual FX rate (v32 — Income/Expense only, see
        // updateTxManualFxVisibility()), that locked rate is used for the tx-currency →
        // account-currency leg first, then the account's currency is converted to base currency
        // at the LIVE rate (base-currency valuation is always a live snapshot; only the leg the
        // user actually fixed — what the account itself received/paid — is frozen). Falls back to
        // the plain live conversion when there's no manual rate, exactly as before.
        function convertTxAmountToBase(t, accounts) {
            if (t.manualFxRate && t.src) {
                const acc = accounts.find(a => a.id === t.src);
                if (acc && acc.type !== "multi" && acc.type !== "fd" && acc.currency && acc.currency !== t.currency) {
                    const inAccountCurrency = t.amount * t.manualFxRate;
                    return convertCurrency(inAccountCurrency, acc.currency, baseCurrency);
                }
            }
            return convertCurrency(t.amount, t.currency, baseCurrency);
        }

        function openModal(id) { 
            document.getElementById(id).classList.add("active"); 
            modalStack.push(id);
            pushVirtualState(id);
        }
        
        // Closing a modal is just "go back" — the popstate listener above is the single place
        // that actually removes the "active" class (see its modalStack.pop() above). Previously this
        // function removed "active" itself before calling history.back(), which meant by the time
        // popstate fired, every modal already looked inactive — so the listener's own "was a modal
        // open?" check always came back false and fell through to page-level back navigation
        // instead (e.g. leaving an account's ledger view for the workspace right after Save/Cancel
        // on the transaction editor, rather than just closing that editor). Letting popstate do the
        // actual closing keeps the visible UI and the history stack in lockstep.
        //
        // v88 fix: if id isn't on top of modalStack (e.g. a modal was dismissed some other way —
        // shouldn't normally happen, but don't let the stack get out of sync with reality), drop
        // any stale entries above it first so history.back() pops the right number of states.
        function closeModal(id) { 
            const el = document.getElementById(id);
            if (el && el.classList.contains("active")) {
                // The Accounts modal's × button is a generic data-click="closeModal" handler,
                // unlike the Save Changes / Delete Account buttons inside that same form, which
                // both already call resetAccountForm() themselves before closeModal() to clear
                // editAccountId first. Without that, clicking × while mid-edit went straight to
                // history.back() with editAccountId still set — the popstate listener's
                // edit-account branch (above) intercepts that back-navigation and just resets the
                // form to "Create New Account" mode (a deliberate cancel-first safety net for the
                // hardware/gesture back button) instead of closing, so the × silently did nothing
                // visible and needed a second click. Clearing it here first, matching the
                // Save/Delete convention, makes × close in one click regardless of edit state.
                if (id === "accountsModal" && document.getElementById("editAccountId").value !== "") {
                    resetAccountForm();
                }
                const idx = modalStack.lastIndexOf(id);
                if (idx !== -1 && idx !== modalStack.length - 1) {
                    modalStack.splice(idx + 1);
                }
                window.history.back();
            }
        }

        // v194: lightweight bottom-of-screen toast for actions that don't navigate anywhere (e.g.
        // exportBackupQuick below) — without a page change, the person needs SOME confirmation
        // the action actually happened. Reuses one static #toastMsg element (see index.html) so
        // repeated calls just restart its timer rather than stacking multiple toasts.
        let toastHideTimer = null;
        function showToast(message) {
            const el = document.getElementById("toastMsg");
            if (!el) return;
            el.textContent = message;
            el.classList.add("show");
            clearTimeout(toastHideTimer);
            toastHideTimer = setTimeout(() => el.classList.remove("show"), 2400);
        }

        // Custom confirm dialog: returns a Promise<boolean>, styled consistently with the rest of the app.
        function customConfirm(message) {
            return new Promise((resolve) => {
                const modal = document.getElementById("confirmModal");
                document.getElementById("confirmModalMessage").textContent = message;
                const okBtn = document.getElementById("confirmModalOkBtn");
                const cancelBtn = document.getElementById("confirmModalCancelBtn");

                const cleanup = (result) => {
                    modal.classList.remove("active");
                    okBtn.onclick = null;
                    cancelBtn.onclick = null;
                    resolve(result);
                };

                okBtn.onclick = () => cleanup(true);
                cancelBtn.onclick = () => cleanup(false);
                modal.classList.add("active");
            });
        }

        // --- SPA NAVIGATION PIPELINE ---
        // Every top-level page div's id — used by showPage() to hide all but the target,
        // so adding a new page never risks leaving a stale one visible underneath.
        const APP_PAGE_IDS = ["page-workspace", "page-ledger", "page-savings", "page-networth-statement", "page-accounts", "page-categories", "page-backup", "page-autolock", "page-database", "page-spending-breakdown", "page-income-breakdown", "page-portfolio-report", "page-owner-networth-report", "page-currency-report", "page-datasecurity", "page-members", "page-member", "page-navupdate", "page-fundactivity", "page-currencyactivity"];
        function showPage(id) {
            APP_PAGE_IDS.forEach(p => {
                const el = document.getElementById(p);
                if (el) el.classList.toggle("hidden", p !== id);
            });
            // Keeps the sidebar's active-item highlight correct even when it's persistently
            // visible (desktop/tablet) rather than only refreshed on drawer-open (mobile).
            updateSidebarActiveState();
        }

        // Human-readable title for whichever page is currently on screen — used for the printed
        // document's own header line and as the browser tab/PDF filename while printing. Pages
        // with a dynamic on-screen heading (an account's Ledger, a Fund's Activity, a Member's
        // page, etc.) read that heading straight off the DOM so the printed title always matches
        // what the user was actually looking at, instead of a generic page-type label.
        function getActivePageTitle(pageId) {
            switch (pageId) {
                case "page-workspace": return "Dashboard — Net Worth Overview";
                case "page-ledger": return document.getElementById("ledgerTargetTitle")?.textContent || "Account Ledger";
                case "page-fundactivity": return document.getElementById("fundActivityTitle")?.textContent || "Fund Activity";
                case "page-currencyactivity": return document.getElementById("currencyActivityTitle")?.textContent || "Currency Activity";
                case "page-accounts": return "Financial Accounts";
                case "page-categories": return "Categories";
                case "page-backup": return "Export & Import";
                case "page-autolock": return "Auto-Lock Settings";
                case "page-database": return "Database";
                case "page-spending-breakdown": return "Spending Breakdown";
                case "page-income-breakdown": return "Income Breakdown";
                case "page-savings": return "Savings Statement";
                case "page-networth-statement": return "Net Worth Statement";
                case "page-portfolio-report": return "Unit Trust Portfolio";
                case "page-owner-networth-report": return "Financial Assets vs Real Estate";
                case "page-currency-report": return "Net Worth by Currency";
                case "page-datasecurity": return "Settings";
                case "page-navupdate": return "Daily NAV Update";
                case "page-members": return "Manage Members";
                case "page-member": return document.getElementById("memberPageTitle")?.textContent || "Member";
                default: return "Ledger";
            }
        }

        // Plain-text summary of a report page's active Year/Month/Member filters — printed in
        // place of the <select> dropdowns themselves (which are hidden for print via the
        // .print-filter-row rule in index.html), so the printed page still states what data
        // it's actually showing. Reads each <select>'s selected *option text* (not its value),
        // so it matches whatever the user sees on screen (e.g. "January", "All Years"). Returns
        // null for pages with no filters (e.g. the Owner Net Worth report), which skips the
        // filters line entirely.
        function getActivePageFilterSummary(pageId) {
            const selectedText = (id) => {
                const el = document.getElementById(id);
                if (!el || el.selectedIndex < 0) return null;
                const opt = el.options[el.selectedIndex];
                return opt ? opt.textContent.trim() : null;
            };
            let parts;
            switch (pageId) {
                case "page-spending-breakdown":
                    parts = [selectedText("spendingYearFilter"), selectedText("spendingMonthFilter"), selectedText("spendingMemberFilter")];
                    break;
                case "page-income-breakdown":
                    parts = [selectedText("incomeYearFilter"), selectedText("incomeMonthFilter"), selectedText("incomeMemberFilter")];
                    break;
                case "page-savings":
                    parts = [selectedText("savingsYearFilter")];
                    break;
                case "page-portfolio-report":
                    parts = [selectedText("portfolioMemberFilter")];
                    break;
                case "page-currency-report":
                    parts = [selectedText("currencyReportMemberFilter")];
                    break;
                default:
                    return null;
            }
            parts = parts.filter(Boolean);
            return parts.length ? parts.join(" · ") : null;
        }

        // Prints (or "Save as PDF"s) whichever page is currently visible. Works the same way on
        // every page in the app — there's no per-page print button/logic, just this one entry
        // point wired to the single floating 🖨 button that's present everywhere (see
        // .print-fab-btn in index.html) — the @media print CSS block does the work of hiding
        // chrome and showing only the active .page. A handful of report pages additionally get
        // their filter dropdowns swapped for a plain-text summary line and any collapsed detail
        // sections force-expanded first, purely so the printed output isn't missing data the
        // user simply hadn't clicked to reveal on screen (same idea as lifting the Ledger
        // page's render limit below).
        async function printCurrentApp() {
            const activePageId = APP_PAGE_IDS.find(id => {
                const el = document.getElementById(id);
                return el && !el.classList.contains("hidden");
            });
            if (!activePageId) { window.print(); return; }

            const activeEl = document.getElementById(activePageId);
            const title = getActivePageTitle(activePageId);
            const filterSummary = getActivePageFilterSummary(activePageId);

            // The Ledger page paginates long transaction histories behind a "Load more" button
            // (ledgerRenderLimit) so scrolling stays fast on a phone — but a printed statement
            // should include everything, not just whatever happened to be loaded on screen yet.
            // Temporarily lift that limit for the print, then restore it afterwards so normal
            // on-screen scrolling/pagination behavior is unaffected.
            const liftedLedgerLimit = (activePageId === "page-ledger" && ledgerRenderLimit < Infinity);
            if (liftedLedgerLimit) {
                ledgerRenderLimit = Infinity;
                await renderApp();
            }

            // Net Savings Statement: each Main Category with Subcategories starts collapsed
            // (see savingsExpandedMains/toggleSavingsMainExpand) — those subcategory rows simply
            // aren't in the DOM at all until expanded, so a print taken as-is would silently
            // drop them. Force every main category open for the print, then restore whatever the
            // user actually had expanded on screen afterwards.
            let savedSavingsExpanded = null;
            if (activePageId === "page-savings") {
                savedSavingsExpanded = savingsExpandedMains;
                savingsExpandedMains = new Set(dynamicCategories.filter(c => !c.parentId).map(c => c.id));
                renderSavingsStatement();
            }

            // Unit Trust Portfolio: the Fund Detail table is always fully rendered into the DOM
            // (unlike the Ledger/Savings cases above), just visually collapsed behind
            // display:none — so this is a simple show/hide rather than a re-render.
            let savedPortfolioDetailDisplay = null;
            if (activePageId === "page-portfolio-report") {
                const wrap = document.getElementById("portfolioDetailWrap");
                if (wrap) {
                    savedPortfolioDetailDisplay = wrap.style.display;
                    wrap.style.display = "";
                }
            }

            const header = document.createElement("div");
            header.id = "printHeader";
            header.innerHTML = `
                <div class="print-header-title">💰 My Ledger</div>
                <div class="print-header-sub">${escapeHtml(title)} · Printed ${new Date().toLocaleString()}</div>
                ${filterSummary ? `<div class="print-header-filters">${escapeHtml(filterSummary)}</div>` : ""}
            `;
            activeEl.prepend(header);

            const prevDocTitle = document.title;
            document.title = `Ledger - ${title}`;

            let cleanedUp = false;
            const cleanup = () => {
                if (cleanedUp) return;
                cleanedUp = true;
                clearTimeout(fallbackTimer);
                header.remove();
                document.title = prevDocTitle;
                if (liftedLedgerLimit) {
                    ledgerRenderLimit = LEDGER_PAGE_SIZE;
                    renderApp();
                }
                if (savedSavingsExpanded !== null) {
                    savingsExpandedMains = savedSavingsExpanded;
                    renderSavingsStatement();
                }
                if (savedPortfolioDetailDisplay !== null) {
                    const wrap = document.getElementById("portfolioDetailWrap");
                    if (wrap) wrap.style.display = savedPortfolioDetailDisplay;
                }
            };
            // afterprint covers both "Print" and "Cancel" in every modern browser, but a
            // fallback timeout guards against the rare browser that never fires it (some older
            // WebViews) so the temporary header/title/expanded state can't get stuck.
            window.addEventListener("afterprint", cleanup, { once: true });
            const fallbackTimer = setTimeout(cleanup, 60000);

            window.print();
        }

        function navigateToLedgerPage(accountId, backTarget = "workspace") {
            workspaceScrollY = window.scrollY;
            activeLedgerAccountView = accountId;
            activeCategoryView = "all";
            categoryDrillYear = "all";
            categoryDrillMonth = "all";
            directTypeView = "all";
            accountLedgerYear = "__fresh__"; // fresh account view — default to its latest year with data
            ledgerBackToPage = backTarget;
            ledgerRenderLimit = LEDGER_PAGE_SIZE;
            showPage("page-ledger");
            window.scrollTo(0,0);
            pushVirtualState("ledger");
            renderApp();
        }

        // These three handlers serve both year-nav modes (per-account Activity, and the
        // Portfolio General Log's own nav added alongside it) since only one is ever visible/
        // clickable at a time — activeLedgerAccountView === "all" distinguishes which cache/
        // selection to move.
        function ledgerYearPrev() {
            if (activeLedgerAccountView === "all") {
                const idx = portfolioLedgerYearsCache.indexOf(portfolioLedgerYear);
                if (idx > 0) { portfolioLedgerYear = portfolioLedgerYearsCache[idx - 1]; renderApp(); }
            } else {
                const idx = accountLedgerYearsCache.indexOf(accountLedgerYear);
                if (idx > 0) { accountLedgerYear = accountLedgerYearsCache[idx - 1]; renderApp(); }
            }
        }

        function ledgerYearNext() {
            if (activeLedgerAccountView === "all") {
                const idx = portfolioLedgerYearsCache.indexOf(portfolioLedgerYear);
                if (idx >= 0 && idx < portfolioLedgerYearsCache.length - 1) { portfolioLedgerYear = portfolioLedgerYearsCache[idx + 1]; renderApp(); }
            } else {
                const idx = accountLedgerYearsCache.indexOf(accountLedgerYear);
                if (idx >= 0 && idx < accountLedgerYearsCache.length - 1) { accountLedgerYear = accountLedgerYearsCache[idx + 1]; renderApp(); }
            }
        }

        // Fired when the year <select> (which replaced the old plain "< 2019 >" label) changes —
        // lets the user jump straight to any year with data, or to "All Years" (accountLedgerYear
        // / portfolioLedgerYear = null) to see the complete transaction history on one page.
        function ledgerYearSelectChange() {
            const val = document.getElementById("ledgerYearLabel").value;
            if (activeLedgerAccountView === "all") {
                portfolioLedgerYear = val === "all" ? null : parseInt(val, 10);
            } else {
                accountLedgerYear = val === "all" ? null : parseInt(val, 10);
            }
            renderApp();
        }

        // Quick-add type picker (v34) — the "+" FAB on an account's own Activity page.
        function toggleLedgerQuickAddSheet() {
            const sheet = document.getElementById("ledgerQuickAddSheet");
            const isOpen = sheet.style.display === "flex";
            sheet.style.display = isOpen ? "none" : "flex";
            document.getElementById("ledgerQuickAddBackdrop").style.display = isOpen ? "none" : "block";
        }

        function closeLedgerQuickAddSheet() {
            document.getElementById("ledgerQuickAddSheet").style.display = "none";
            document.getElementById("ledgerQuickAddBackdrop").style.display = "none";
        }

        function quickAddChooseType(el) {
            closeLedgerQuickAddSheet();
            // Preset the src account to whichever account this Activity page belongs to, so the
            // form opens ready to log against it rather than the stored default payment account.
            const presetAccountId = activeLedgerAccountView !== "all" ? activeLedgerAccountView : null;
            openTransactionForm(el.dataset.type, null, presetAccountId);
        }

        // Dashboard "Quick Transaction Entry" speed-dial FAB (v173) — same open/close/choose
        // shape as the Account Activity page's quick-add sheet above, but with a 4th option
        // (Salary, routing to openSalaryEntryForm() instead of openTransactionForm()) and no
        // preset account, matching what the old 4-button actions-bar row used to do.
        function toggleDashboardQuickAddSheet() {
            const sheet = document.getElementById("dashboardQuickAddSheet");
            const isOpen = sheet.style.display === "flex";
            sheet.style.display = isOpen ? "none" : "flex";
            document.getElementById("dashboardQuickAddBackdrop").style.display = isOpen ? "none" : "block";
            document.getElementById("dashboardQuickAddFab").classList.toggle("fab-btn-open", !isOpen);
        }

        function closeDashboardQuickAddSheet() {
            document.getElementById("dashboardQuickAddSheet").style.display = "none";
            document.getElementById("dashboardQuickAddBackdrop").style.display = "none";
            document.getElementById("dashboardQuickAddFab").classList.remove("fab-btn-open");
        }

        function dashboardQuickAddChooseAction(el) {
            closeDashboardQuickAddSheet();
            const action = el.dataset.action;
            if (action === "salary") {
                openSalaryEntryForm();
            } else {
                openTransactionForm(action);
            }
        }

        // v188: "Group by Description" — collapses every transaction in the category/period
        // currently being viewed (see navigateToCategoryPage below) into one row per distinct
        // Description text (case-insensitive, trimmed), each with a combined total, an
        // occurrence count, and every date it was logged — e.g. typing "mcd" as the description
        // on three separate McDonald's purchases groups them into one "mcd (x3)" row. Mirrors a
        // reference budgeting app's per-category note-merge summary. Groups by the transaction's
        // main Description field (t.desc) rather than the optional Notes field, since that's
        // where most people actually type the merchant/what-it-was text. Reuses the exact same
        // isBound rule the ledger list itself uses for a category view (t.cat ===
        // activeCategoryView, scoped by categoryDrillYear/Month) so the two always agree on
        // what's "in" this category/period — deliberately NOT limited to expenses only, so it
        // also works when viewing an income category.
        async function openNoteSummaryModal() {
            if (activeCategoryView === "all") return; // button is hidden otherwise, but guard anyway
            const txs = await readAllDB(STORES.TRANSACTIONS);
            const accounts = await readAllDB(STORES.ACCOUNTS);
            const groups = {}; // normalized note -> { label, total, count, dates: [] }
            let categoryTxType = "expense"; // fallback; overwritten below by whichever type this category's transactions actually are
            txs.forEach(t => {
                if (t.cat !== activeCategoryView) return;
                const d = new Date(t.date);
                if (categoryDrillYear !== "all" && d.getFullYear().toString() !== categoryDrillYear) return;
                if (categoryDrillMonth !== "all" && d.getMonth().toString() !== categoryDrillMonth) return;
                categoryTxType = t.type === "income" ? "income" : "expense";
                const noteRaw = (t.desc || "").trim();
                const key = noteRaw ? noteRaw.toLowerCase() : "\u0000no-note";
                if (!groups[key]) groups[key] = { label: noteRaw || "(No description)", total: 0, count: 0, dates: [] };
                groups[key].total += convertTxAmountToBase(t, accounts);
                groups[key].count += 1;
                groups[key].dates.push(t.date);
            });

            const entries = Object.values(groups).sort((a, b) => b.total - a.total);
            const icon = getCategoryIcon(activeCategoryView);
            document.getElementById("noteSummaryModalTitle").textContent = `${icon} ${activeCategoryView} — Description Summary`;

            // Accent colour follows this category's actual transaction type (income vs expense) —
            // see the handwritten-journal styling on #noteSummaryModal in index.html — rather than
            // hard-coding red the way the reference screenshot's expense-only summary does, since
            // this same modal is also reached from income categories.
            const accentColor = categoryTxType === "income" ? "var(--income-color)" : "var(--expense-color)";

            document.getElementById("noteSummaryModalList").innerHTML = entries.length === 0
                ? `<p style="font-size:0.8rem; text-align:center; color:var(--text-muted);">No transactions to group here.</p>`
                : entries.map(g => {
                    const datesHTML = g.dates.slice().sort().reverse().map(dt => `<div style="padding-left:2px;">• ${escapeHtml(dt)}</div>`).join("");
                    const countSuffix = g.count > 1 ? ` (x${g.count})` : "";
                    return `
                        <div class="note-summary-entry" style="border:1px solid var(--border-color); border-left:4px solid ${accentColor}; border-radius:10px; padding:12px 14px; margin-bottom:12px;">
                            <div style="display:flex; justify-content:space-between; align-items:baseline; gap:10px;">
                                <strong style="font-size:0.95rem;">${escapeHtml(g.label)}${countSuffix}</strong>
                                <span class="note-summary-amount" style="color:${accentColor}; white-space:nowrap;">${formatCurrency(g.total, baseCurrency)}</span>
                            </div>
                            <div style="font-size:0.72rem; color:var(--text-muted); margin-top:6px;">
                                📅 Dates:
                                ${datesHTML}
                            </div>
                        </div>
                    `;
                }).join("");

            openModal("noteSummaryModal");
        }

        function navigateToCategoryPage(categoryName, backTarget = "workspace", year = "all", month = "all") {
            if (backTarget === "workspace") workspaceScrollY = window.scrollY;
            activeCategoryView = categoryName;
            categoryDrillYear = year;
            categoryDrillMonth = month;
            activeLedgerAccountView = "all";
            directTypeView = "all";
            ledgerBackToPage = backTarget;
            ledgerRenderLimit = LEDGER_PAGE_SIZE;
            showPage("page-ledger");
            window.scrollTo(0,0);
            pushVirtualState("category_history");
            renderApp();
        }

        // v148: year/month args let a click carry the report card tile's own selected period
        // into the Income/Expense log (see renderReportCardTile's data-click wiring below) —
        // reuses the same categoryDrillYear/Month mechanism the category drill-ins already use,
        // since a page can only ever be scoped by one of activeCategoryView or directTypeView at
        // a time. Both default to "all" so every other existing caller (Spending/Income
        // Breakdown, etc.) keeps showing full history exactly as before.
        function navigateToDirectTypePage(type, year = "all", month = "all") {
            workspaceScrollY = window.scrollY;
            directTypeView = type;
            activeLedgerAccountView = "all";
            activeCategoryView = "all";
            categoryDrillYear = year;
            categoryDrillMonth = month;
            ledgerBackToPage = "workspace";
            ledgerRenderLimit = LEDGER_PAGE_SIZE;
            showPage("page-ledger");
            window.scrollTo(0,0);
            pushVirtualState("ledger_type_filter");
            renderApp();
        }

        // v148: yearOverride/month let the report card's "Total" row carry its own selected
        // period onto the Savings Statement. yearOverride defaults to null (not "all") so a plain
        // sidebar visit — which calls this with no args — keeps the statement's own year filter
        // exactly as the user last left it; passing a real value (or explicit "all") forces the
        // Year select to that value instead. savingsFilterMonth defaults back to "all" on every
        // call so the month scope never lingers into an unrelated visit.
        function navigateToSavingsPage(yearOverride = null, month = "all") {
            workspaceScrollY = window.scrollY;
            savingsFilterMonth = month;
            if (yearOverride !== null) pendingSavingsYearOverride = yearOverride;
            showPage("page-savings");
            window.scrollTo(0,0);
            pushVirtualState("savings");
            renderApp();
        }

        // v222: the Dashboard's big "Portfolio Net Worth" figure is tappable through to this —
        // a classic personal balance-sheet breakdown (see renderNetWorthStatementPage() below).
        async function navigateToNetWorthStatementPage() {
            workspaceScrollY = window.scrollY;
            showPage("page-networth-statement");
            window.scrollTo(0, 0);
            pushVirtualState("networth-statement");
            await renderNetWorthStatementPage();
        }

        // Clears just the report-card-driven month scope on the Savings Statement, leaving the
        // page's own Year filter as-is — the small "Clear" link shown next to the period badge.
        function clearSavingsMonthScope() {
            savingsFilterMonth = "all";
            renderSavingsStatement();
        }

        // --- FINANCIAL REPORT CARD (v147) ---
        // Two independently-filterable summary tiles on the dashboard (reference: a competing
        // budget app's "This year / August 2026" side-by-side cards). Replaces the old single
        // card driven by the filterMonth/filterYear selects — each tile now picks its own period
        // from REPORT_CARD_PERIODS and computes its own Income/Expense/Total directly from the
        // full `txs` list, completely decoupled from the other tile and from the ledger page
        // (which, per the v74 fix, always shows full history on every drill-in regardless of any
        // period selected here — clicking Income/Expense/Total below intentionally does NOT try
        // to carry the tile's period into the destination page, matching that existing behaviour).
        const REPORT_CARD_PERIODS = {
            thisYear: "This Year",
            lastYear: "Last Year",
            thisMonth: "This Month",
            lastMonth: "Last Month",
        };

        // Returns the [startMs, endMsExclusive) window for a period key, plus the label shown as
        // the tile's title — a generic "This Year"/"Last Year" for the two year options (matching
        // the reference image), or the actual "<Month> <Year>" for the two month options (e.g.
        // "August 2026") since which specific month "This Month"/"Last Month" means isn't obvious
        // from the option label alone.
        function getReportCardPeriodRange(periodKey) {
            const now = new Date();
            const y = now.getFullYear(), m = now.getMonth();
            if (periodKey === "lastYear") {
                return { start: new Date(y - 1, 0, 1).getTime(), end: new Date(y, 0, 1).getTime(), label: "Last Year" };
            }
            if (periodKey === "thisMonth" || periodKey === "lastMonth") {
                const offset = periodKey === "lastMonth" ? -1 : 0;
                const start = new Date(y, m + offset, 1);
                const end = new Date(y, m + offset + 1, 1);
                const label = start.toLocaleDateString(undefined, { month: "long", year: "numeric" });
                return { start: start.getTime(), end: end.getTime(), label };
            }
            // "thisYear" (also the fallback for any unrecognised/legacy stored value)
            return { start: new Date(y, 0, 1).getTime(), end: new Date(y + 1, 0, 1).getTime(), label: "This Year" };
        }

        // Sums Income/Expense (in base currency) for every transaction dated within [start, end),
        // mirroring the exclusion + refund-as-negative-expense rules the old dashboard banner and
        // Net Savings Statement both already use (see excludeFromSavings, isRefund).
        function computeReportCardTotals(txs, accounts, periodKey) {
            const { start, end, label } = getReportCardPeriodRange(periodKey);
            const excludedCatNames = new Set(dynamicCategories.filter(c => c.excludeFromSavings).map(c => c.name));
            let income = 0, expense = 0;
            txs.forEach(t => {
                const tMs = new Date(t.date + "T00:00:00").getTime();
                if (tMs < start || tMs >= end) return;
                if (excludedCatNames.has(t.cat)) return;
                const tBase = convertTxAmountToBase(t, accounts);
                if (t.type === "income" && t.isRefund) expense -= tBase;
                else if (t.type === "income") income += tBase;
                else if (t.type === "expense") expense += tBase;
            });
            return { income, expense, label };
        }

        // v148: converts a tile's period key into the {year, month} args navigateToDirectTypePage/
        // navigateToSavingsPage expect (year as a full-year string or "all"; month as a 0-indexed
        // string or "all") — so clicking Income/Expense/Total on a report card tile carries that
        // exact tile's selected period into the log/statement it opens, instead of always showing
        // full history regardless of what the tile was scoped to.
        function getReportCardDrillArgs(periodKey) {
            const { start } = getReportCardPeriodRange(periodKey);
            const startDate = new Date(start);
            if (periodKey === "thisMonth" || periodKey === "lastMonth") {
                return { year: startDate.getFullYear().toString(), month: startDate.getMonth().toString() };
            }
            // "thisYear" / "lastYear" (and the fallback for any unrecognised value)
            return { year: startDate.getFullYear().toString(), month: "all" };
        }

        // Data-click handlers for the report card tiles' Income/Expense/Total rows (index.html) —
        // read which tile (cardNum) and which of its own period selects was chosen, then hand off
        // to the real navigation functions with that period attached.
        function reportCardClickDirectType(el) {
            const period = el.dataset.cardnum === "1" ? reportCardPeriod1 : reportCardPeriod2;
            const { year, month } = getReportCardDrillArgs(period);
            navigateToDirectTypePage(el.dataset.type, year, month);
        }

        function reportCardClickTotal(el) {
            const period = el.dataset.cardnum === "1" ? reportCardPeriod1 : reportCardPeriod2;
            const { year, month } = getReportCardDrillArgs(period);
            navigateToSavingsPage(year, month);
        }

        function populateReportCardPeriodSelect(selectId, currentValue) {
            const select = document.getElementById(selectId);
            select.innerHTML = Object.entries(REPORT_CARD_PERIODS).map(([k, v]) => `<option value="${k}">${v}</option>`).join("");
            select.value = currentValue;
        }

        // Compact 2-slice (Income vs Expense) donut, no legend — the tile's own Income/Expense/
        // Total rows already carry the numbers, so this is purely the "at a glance" proportion
        // shown in the reference image. Uses the same stroke-dasharray technique as
        // buildBreakdownDonutSVG (see its comment) but simplified to exactly 2 fixed-color slices.
        function buildIncomeExpenseDonutSVG(income, expense) {
            const size = 84, r = 32, cx = size / 2, cy = size / 2, circumference = 2 * Math.PI * r;
            const total = income + expense;
            if (total <= 0) {
                return `<svg viewBox="0 0 ${size} ${size}" style="width:74px; height:74px; flex-shrink:0;"><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e2e8f0" stroke-width="14"></circle></svg>`;
            }
            const incFrac = income / total;
            const incDash = incFrac * circumference;
            const expDash = circumference - incDash;
            return `
                <svg viewBox="0 0 ${size} ${size}" style="width:74px; height:74px; flex-shrink:0;">
                    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ef4444" stroke-width="14" stroke-dasharray="${circumference.toFixed(2)} 0" transform="rotate(-90 ${cx} ${cy})"></circle>
                    ${incDash > 0 ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#22c55e" stroke-width="14" stroke-dasharray="${incDash.toFixed(2)} ${expDash.toFixed(2)}" stroke-dashoffset="0" transform="rotate(-90 ${cx} ${cy})"></circle>` : ""}
                </svg>
            `;
        }

        function renderReportCardTile(cardNum, periodKey, txs, accounts) {
            const { income, expense, label } = computeReportCardTotals(txs, accounts, periodKey);
            const total = income - expense;
            document.getElementById(`reportCardTitle${cardNum}`).textContent = label;
            document.getElementById(`reportCardDonut${cardNum}`).innerHTML = buildIncomeExpenseDonutSVG(income, expense);
            document.getElementById(`reportCardIncome${cardNum}`).textContent = formatCurrency(income, baseCurrency);
            document.getElementById(`reportCardExpense${cardNum}`).textContent = `-${formatCurrency(expense, baseCurrency)}`;
            const totalEl = document.getElementById(`reportCardTotal${cardNum}`);
            totalEl.textContent = formatCurrency(total, baseCurrency);
            totalEl.style.color = total >= 0 ? "var(--income-color)" : "var(--expense-color)";
        }

        function renderReportCards(txs, accounts) {
            populateReportCardPeriodSelect("reportCardPeriodSelect1", reportCardPeriod1);
            populateReportCardPeriodSelect("reportCardPeriodSelect2", reportCardPeriod2);
            renderReportCardTile(1, reportCardPeriod1, txs, accounts);
            renderReportCardTile(2, reportCardPeriod2, txs, accounts);
        }

        // --- Monthly Trend chart (v211) ---
        // Grouped income/expense bars, one pair per month, for a single selected year — the
        // dashboard didn't previously have anything showing the shape of the year at a glance
        // (the report cards above summarise one period at a time; this shows all 12 side by
        // side). Reuses computeReportCardTotals' exact exclusion + refund-as-negative-expense
        // rules (via the same per-month date-range totalling) so the numbers already tie out to
        // every other income/expense figure on the dashboard — no separate accounting logic.
        function populateMonthlyTrendYearOptions(txs) {
            const select = document.getElementById("monthlyTrendYearSelect");
            const currentYear = new Date().getFullYear();
            const years = new Set([currentYear]);
            txs.forEach(t => {
                const y = new Date(t.date + "T00:00:00").getFullYear();
                if (!isNaN(y)) years.add(y);
            });
            const sortedYears = [...years].sort((a, b) => b - a);
            select.innerHTML = sortedYears.map(y => `<option value="${y}">${y}</option>`).join("");
            select.value = sortedYears.map(String).includes(monthlyTrendYear) ? monthlyTrendYear : String(currentYear);
        }

        function computeMonthlyTrendData(txs, accounts, year) {
            const excludedCatNames = new Set(dynamicCategories.filter(c => c.excludeFromSavings).map(c => c.name));
            const months = Array.from({ length: 12 }, (_, i) => ({
                label: new Date(2000, i, 1).toLocaleDateString(undefined, { month: "short" }),
                income: 0, expense: 0
            }));
            txs.forEach(t => {
                const d = new Date(t.date + "T00:00:00");
                if (d.getFullYear() !== year) return;
                if (excludedCatNames.has(t.cat)) return;
                const tBase = convertTxAmountToBase(t, accounts);
                const bucket = months[d.getMonth()];
                if (t.type === "income" && t.isRefund) bucket.expense -= tBase;
                else if (t.type === "income") bucket.income += tBase;
                else if (t.type === "expense") bucket.expense += tBase;
            });
            return months;
        }

        // Builds the path for a bar rect whose TOP corners only are rounded (bottom stays
        // square-cornered against the baseline) — reads as a nicer "pill" top than a uniformly
        // rounded <rect> once bars get wider, without floating the bar off the axis line. Clamps
        // the radius down for very short bars (e.g. the minimum-visible-height floor below) so a
        // 3px-tall bar still renders as a rounded blob instead of a self-intersecting path.
        function topRoundedBarPath(x, y, width, height, r) {
            const rr = Math.max(0, Math.min(r, width / 2, height));
            if (rr <= 0.05) return `M${x},${y} h${width} v${height} h${-width} Z`;
            return `M${x},${y + height} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + width - rr} Q${x + width},${y} ${x + width},${y + rr} V${y + height} Z`;
        }

        // Grouped (paired) bar chart, no external chart library, styled to match this app's
        // other hand-drawn SVG charts (buildBreakdownBarSVG/buildBreakdownDonutSVG above) rather
        // than copying any other app's exact look. A light horizontal gridline + axis label every
        // ~1/4 of the scale, an income/expense legend up top, and a muted "no data" label under
        // any month with nothing logged (rather than just leaving it blank, which reads as a
        // rendering gap rather than "no transactions that month").
        //
        // v212: bars now tile edge-to-edge across the whole 12-month width (a single small,
        // uniform gap between every pair of bars — inside a month AND between neighbouring
        // months — instead of a narrow pair of bars floating in the middle of a wide, mostly-empty
        // month column). Bars are also wider and every non-zero value gets a minimum visible
        // height, so a small expense (e.g. RM10 next to a RM3,000 income bar) still shows up as a
        // sliver instead of vanishing into the baseline. Each bar carries data-* attributes read
        // by showMonthlyTrendTooltip()/hideMonthlyTrendTooltip() (wired below) for the hover
        // tooltip — no external chart library needed for that either.
        // Small "scale break" mark (two short parallel diagonal ticks) drawn near the top of any
        // bar that's been clipped by Auto-scale — the standard chart convention for "this bar
        // keeps going, the axis just stops here". Centered horizontally on the bar; y is the
        // bar's rendered top edge (= padTop, since a clipped bar always fills the full plot
        // height). White strokes read against both the green/red bar fills used here.
        function clipNotchSVG(x, y, barW) {
            const midX = x + barW / 2;
            return `
                <line x1="${(midX - 3.5).toFixed(1)}" y1="${(y + 8).toFixed(1)}" x2="${(midX + 1.5).toFixed(1)}" y2="${(y + 2).toFixed(1)}" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"></line>
                <line x1="${(midX - 0.5).toFixed(1)}" y1="${(y + 11).toFixed(1)}" x2="${(midX + 4.5).toFixed(1)}" y2="${(y + 5).toFixed(1)}" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"></line>
            `;
        }

        function buildMonthlyTrendBarSVG(months, isMobile, autoScale) {
            // On a narrow phone screen the SVG's viewBox gets scaled down to fit the card width,
            // so a font-size that reads fine on desktop (where the viewBox is barely scaled at
            // all) can shrink to a few real pixels on mobile and become unreadable. Rather than
            // just scaling the same layout down, mobile gets its own taller, wider-margined
            // layout with meaningfully larger font sizes and one fewer gridline (less clutter at
            // a smaller size) so the *rendered* text stays legible regardless of screen width.
            const w = isMobile ? 480 : 680;
            const h = isMobile ? 300 : 260;
            const padLeft = isMobile ? 54 : 46, padRight = 10, padTop = isMobile ? 40 : 34, padBottom = isMobile ? 34 : 26;
            const axisFontSize = isMobile ? 13 : 9;
            const monthFontSize = isMobile ? 13 : 9;
            const legendFontSize = isMobile ? 14 : 10;
            const plotW = w - padLeft - padRight, plotH = h - padTop - padBottom;
            // All bar values (both series, every month), used to find the true max and, for
            // Auto-scale, the second-highest value — the single value that decides the axis once
            // the tallest bar is set aside. With 0 or 1 non-zero values there's nothing to rescale
            // against, so Auto-scale just falls back to the normal max in that case.
            const allVals = months.flatMap(mo => [mo.income, mo.expense]).filter(v => v > 0).sort((a, b) => b - a);
            const trueMax = Math.max(allVals[0] || 0, 0.01);
            const scaleBasis = (autoScale && allVals.length > 1) ? allVals[1] : trueMax;
            // Round the axis ceiling up to a "nice" number (1/2/5 × a power of ten) so gridline
            // labels read like 4,000/8,000 rather than an arbitrary max-value fraction.
            const magnitude = Math.pow(10, Math.floor(Math.log10(scaleBasis || 1)));
            const niceSteps = [1, 2, 2.5, 5, 10];
            let axisMax = magnitude * 10;
            for (const step of niceSteps) {
                if (scaleBasis <= magnitude * step) { axisMax = magnitude * step; break; }
            }
            const gridlineCount = isMobile ? 3 : 4;
            let gridlinesSVG = "";
            for (let i = 0; i <= gridlineCount; i++) {
                const val = (axisMax / gridlineCount) * i;
                const y = padTop + plotH - (plotH * val) / axisMax;
                gridlinesSVG += `
                    <line x1="${padLeft}" y1="${y.toFixed(1)}" x2="${w - padRight}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-width="1"></line>
                    <text x="${padLeft - 8}" y="${(y + 3).toFixed(1)}" font-size="${axisFontSize}" text-anchor="end" fill="#94a3b8">${formatCompactAxisNumber(val)}</text>
                `;
            }
            const groupW = plotW / 12;
            const gap = 1.5; // same hairline gap used both between the two bars in a month AND between one month's bars and the next's — no wide dead zone marking where a month "ends"
            const barW = groupW / 2 - gap;
            const minVisibleH = 3; // any logged (>0) amount still shows a sliver even when tiny next to the tallest bar on the chart
            let barsSVG = "";
            let notchesSVG = ""; // drawn after all bars so a clipped bar's notch never sits under its taller neighbour
            months.forEach((mo, i) => {
                const groupX = padLeft + i * groupW;
                const incX = groupX + gap / 2;
                const expX = incX + barW + gap;
                if (mo.income > 0) {
                    const clipped = mo.income > axisMax;
                    const incH = clipped ? plotH : Math.max(minVisibleH, (plotH * mo.income) / axisMax);
                    const incY = padTop + plotH - incH;
                    barsSVG += `<path d="${topRoundedBarPath(incX, incY, barW, incH, 3)}" fill="#22c55e" class="mtrend-bar" data-label="${escapeHtml(mo.label)}" data-type="Income" data-val="${mo.income.toFixed(2)}" data-click="monthlyTrendBarTap"></path>`;
                    if (clipped) notchesSVG += clipNotchSVG(incX, incY, barW);
                }
                if (mo.expense > 0) {
                    const clipped = mo.expense > axisMax;
                    const expH = clipped ? plotH : Math.max(minVisibleH, (plotH * mo.expense) / axisMax);
                    const expY = padTop + plotH - expH;
                    barsSVG += `<path d="${topRoundedBarPath(expX, expY, barW, expH, 3)}" fill="#ef4444" class="mtrend-bar" data-label="${escapeHtml(mo.label)}" data-type="Expense" data-val="${mo.expense.toFixed(2)}" data-click="monthlyTrendBarTap"></path>`;
                    if (clipped) notchesSVG += clipNotchSVG(expX, expY, barW);
                }
                barsSVG += `<text x="${(groupX + groupW / 2).toFixed(1)}" y="${h - (isMobile ? 8 : 6)}" font-size="${monthFontSize}" text-anchor="middle" fill="#64748b">${escapeHtml(mo.label)}</text>`;
            });
            return `
                <svg viewBox="0 0 ${w} ${h}" style="width:100%; display:block;" data-click="hideMonthlyTrendTooltip">
                    <g>
                        <rect x="0" y="0" width="12" height="12" fill="#22c55e" rx="2" transform="translate(${padLeft}, 4)"></rect>
                        <text x="${padLeft + 16}" y="14" font-size="${legendFontSize}" fill="#334155">Income</text>
                        <rect x="0" y="0" width="12" height="12" fill="#ef4444" rx="2" transform="translate(${padLeft + (isMobile ? 78 : 66)}, 4)"></rect>
                        <text x="${padLeft + (isMobile ? 94 : 82)}" y="14" font-size="${legendFontSize}" fill="#334155">Expense</text>
                    </g>
                    ${gridlinesSVG}
                    ${barsSVG}
                    ${notchesSVG}
                </svg>
            `;
        }

        // Hover tooltip for the Monthly Trend chart's bars — shown/hidden via the delegated
        // document "mousemove" listener (desktop hover) and the "monthlyTrendBarTap" /
        // "hideMonthlyTrendTooltip" CLICK_ACTIONS entries (mobile tap), NOT inline event
        // attributes on the <path> elements — this app's CSP has no 'unsafe-inline' script-src,
        // so onmousemove="..." markup would be silently ignored by the browser. Positioned
        // relative to #monthlyTrendChartWrap's parent (must be position:relative — see
        // index.html; the tooltip lives as a SIBLING of the wrap, not nested inside it, since
        // the wrap's innerHTML gets fully replaced on every re-render and would otherwise wipe
        // the tooltip element out), and nudged left once the cursor is past ~70% of the wrap's
        // width so the tooltip doesn't run off the right edge of the card.
        function showMonthlyTrendTooltip(evt, el) {
            const wrap = document.getElementById("monthlyTrendChartWrap");
            const tip = document.getElementById("monthlyTrendTooltip");
            if (!wrap || !tip) return;
            const wrapRect = wrap.getBoundingClientRect();
            const x = evt.clientX - wrapRect.left;
            const y = evt.clientY - wrapRect.top;
            const label = el.getAttribute("data-label");
            const type = el.getAttribute("data-type");
            const val = parseFloat(el.getAttribute("data-val"));
            const swatch = type === "Income" ? "#22c55e" : "#ef4444";
            tip.innerHTML = `<div style="font-weight:700; margin-bottom:2px;">${escapeHtml(label)} ${escapeHtml(monthlyTrendYear)}</div>
                <div style="display:flex; align-items:center; gap:5px;">
                    <span style="width:8px; height:8px; border-radius:2px; background:${swatch}; display:inline-block;"></span>
                    <span style="color:var(--text-muted);">${escapeHtml(type)}</span>
                    <span style="font-weight:700; margin-left:4px;">${formatCurrency(val, baseCurrency)}</span>
                </div>`;
            const nearRightEdge = x > wrapRect.width * 0.7;
            tip.style.left = nearRightEdge ? "" : `${x + 12}px`;
            tip.style.right = nearRightEdge ? `${wrapRect.width - x + 12}px` : "";
            tip.style.top = `${Math.max(0, y - 38)}px`;
            tip.style.display = "block";
        }

        function hideMonthlyTrendTooltip() {
            const tip = document.getElementById("monthlyTrendTooltip");
            if (tip) tip.style.display = "none";
        }

        // Compact axis-label formatting (1,200 / 12K / 1.2M) — plain-language style matching the
        // rest of this app's currency/number display rather than a locale-aware Intl formatter,
        // since axis labels here are unitless (no currency symbol) at a glance.
        function formatCompactAxisNumber(val) {
            if (val >= 1000000) return (val / 1000000).toFixed(val % 1000000 === 0 ? 0 : 1) + "M";
            if (val >= 1000) return (val / 1000).toFixed(val % 1000 === 0 ? 0 : 1) + "K";
            return Math.round(val).toString();
        }

        function renderMonthlyTrendChart(txs, accounts) {
            populateMonthlyTrendYearOptions(txs);
            const year = parseInt(document.getElementById("monthlyTrendYearSelect").value, 10);
            const months = computeMonthlyTrendData(txs, accounts, year);
            const hasAnyData = months.some(mo => mo.income > 0 || mo.expense > 0);
            // Re-checked on every render (not cached) since rotating the phone or resizing a
            // desktop window between renders should switch layouts, not stick to whichever one
            // was true on first paint.
            const isMobile = window.innerWidth <= 480;
            document.getElementById("monthlyTrendChartWrap").innerHTML = hasAnyData
                ? buildMonthlyTrendBarSVG(months, isMobile, monthlyTrendAutoScale)
                : '<p style="font-size:0.75rem; text-align:center; color:var(--text-muted); padding: 40px 0;">No transactions logged for this year yet.</p>';
            const toggleBtn = document.getElementById("monthlyTrendAutoScaleToggle");
            if (toggleBtn) {
                toggleBtn.textContent = monthlyTrendAutoScale ? "⤢ Auto-scale: On" : "⤢ Auto-scale";
                toggleBtn.classList.toggle("active-filter-btn", monthlyTrendAutoScale);
            }
        }

        async function changeMonthlyTrendYear(el) {
            monthlyTrendYear = el.value;
            await writeDB(STORES.SETTINGS, { key: "monthlyTrendYear", value: monthlyTrendYear });
            const { accounts, txs } = await computeAccountBalances();
            renderMonthlyTrendChart(txs, accounts);
        }

        async function toggleMonthlyTrendAutoScale() {
            monthlyTrendAutoScale = !monthlyTrendAutoScale;
            await writeDB(STORES.SETTINGS, { key: "monthlyTrendAutoScale", value: monthlyTrendAutoScale });
            const { accounts, txs } = await computeAccountBalances();
            renderMonthlyTrendChart(txs, accounts);
        }

        async function changeReportCardPeriod(cardNum, value) {
            if (cardNum === 1) reportCardPeriod1 = value; else reportCardPeriod2 = value;
            await writeDB(STORES.SETTINGS, { key: `reportCardPeriod${cardNum}`, value });
            // Only these two tiles need to change — a full renderApp() would also re-fetch
            // balances and re-render everything else on the dashboard for nothing.
            const { accounts, txs } = await computeAccountBalances();
            renderReportCardTile(cardNum, cardNum === 1 ? reportCardPeriod1 : reportCardPeriod2, txs, accounts);
        }

        async function navigateToWorkspace() {
            showPage("page-workspace");
            await renderApp();
            // Restored after renderApp() finishes rebuilding the dashboard's DOM (account list,
            // report card, etc.) — scrolling before that would target a not-yet-full-height page
            // and land in the wrong place.
            window.scrollTo(0, workspaceScrollY);
        }

        async function navigateToAccountsPage(typeFilter, backTarget) {
            closeSidebar();
            // v222 fix: caller now says where Back should return to; defaults to "workspace"
            // to match every pre-v222 caller (sidebar, dashboard, delete-account flow).
            accountsPageBackTarget = backTarget || "workspace";
            workspaceScrollY = window.scrollY;
            accountsPageTypeFilter = typeFilter || null;
            showPage("page-accounts");
            window.scrollTo(0, 0);
            pushVirtualState("accounts");
            await renderAccountsPage();
        }

        // v222 fix: Accounts page's "← Back" button target — previously hardcoded to
        // navigateToWorkspace(), which stranded users on the Dashboard when Accounts was
        // opened from the new Net Worth Statement page instead of the sidebar/dashboard.
        function handleAccountsBackClick() {
            if (accountsPageBackTarget === "networth-statement") navigateToNetWorthStatementPage();
            else navigateToWorkspace();
        }

        // Clears the Accounts page's type filter (if any) and re-renders — wired to the "Show
        // All Accounts" link that appears whenever a sidebar type shortcut narrowed the list.
        async function clearAccountsPageTypeFilter() {
            accountsPageTypeFilter = null;
            await renderAccountsPage();
        }

        async function navigateToCategoriesPage() {
            workspaceScrollY = window.scrollY;
            showPage("page-categories");
            window.scrollTo(0, 0);
            pushVirtualState("categories");
            await renderCategoriesPage();
        }

        function navigateToBackupPage(backTarget = "datasecurity") {
            workspaceScrollY = window.scrollY;
            backupBackToPage = backTarget;
            showPage("page-backup");
            window.scrollTo(0, 0);
            pushVirtualState("backup");
            calculateStorageMetrics();
        }

        function handleBackupBackClick() {
            if (backupBackToPage === "workspace") navigateToWorkspace();
            else navigateToDataSecurityPage();
        }

        // "All Transactions" — used to be a sidebar item, now a bottom-of-dashboard button (v34).
        function navigateToAllLedgerPage() {
            navigateToLedgerPage("all");
        }

        // "Data Security" hub — replaces the old sidebar "Data & Security" section; groups
        // Backup & Restore / Auto-Lock / App Local Database / Lock App Now behind one bottom-of-
        // dashboard button.
        function navigateToDataSecurityPage() {
            closeSidebar();
            workspaceScrollY = window.scrollY;
            showPage("page-datasecurity");
            window.scrollTo(0, 0);
            pushVirtualState("datasecurity");
        }

        function navigateToMembersPage() {
            closeSidebar();
            workspaceScrollY = window.scrollY;
            showPage("page-members");
            window.scrollTo(0, 0);
            pushVirtualState("members");
            renderMembersPage();
        }

        // Opens the filtered member/joint-account view. filterKey is "m:<memberId>" for a single
        // member (their solo-owned accounts only) or "j:<id1>,<id2>,..." for a joint account group
        // (memberIds sorted so the same group always resolves to the same key).
        function navigateToMemberPage(filterKey) {
            closeSidebar();
            workspaceScrollY = window.scrollY;
            const [kind, idsStr] = filterKey.split(":");
            activeMemberFilter = { type: kind === "j" ? "joint" : "member", ids: idsStr.split(",") };
            showPage("page-member");
            window.scrollTo(0, 0);
            pushVirtualState("member");
            renderMemberPage();
        }

        // "Daily NAV Update" page — a manual price-entry sheet for every fund currently held
        // (units > 0) across every Unit Trust account, so updating a fund's price doesn't
        // require opening each account's Fund Holdings table and editing one fund at a time.
        // Card/Table are two views onto the same editable price fields (kept in sync by
        // handleNavPriceInput below); History is a read-only log of past "Update All Prices"
        // batches, one row per NAV Date.
        function navigateToNavUpdatePage() {
            closeSidebar();
            workspaceScrollY = window.scrollY;
            showPage("page-navupdate");
            window.scrollTo(0, 0);
            pushVirtualState("navupdate");
            renderNavUpdatePage();
        }

        // v62: none of these branches restored scroll position after re-rendering the page being
        // returned to — they navigated back to the top every time regardless of where in a long
        // Accounts/Member/Savings list the user had tapped from. workspaceScrollY already holds
        // the right value (captured by navigateToLedgerPage when the row was tapped); it just
        // was never applied here. Made async so each branch can await its re-render before
        // scrolling — scrolling before the list has re-rendered would target a not-yet-full-
        // height page and land in the wrong place (same reasoning as navigateToWorkspace above).
        async function handleLedgerBackClick() {
            if (ledgerBackToPage === "savings") {
                showPage("page-savings");
                window.scrollTo(0, workspaceScrollY);
            } else if (ledgerBackToPage === "accounts") {
                showPage("page-accounts");
                await renderAccountsPage();
                window.scrollTo(0, workspaceScrollY);
            } else if (ledgerBackToPage === "member") {
                showPage("page-member");
                await renderMemberPage();
                window.scrollTo(0, workspaceScrollY);
            } else {
                navigateToWorkspace();
            }
        }

        // --- SIDEBAR NAVIGATION DRAWER ---
        function openSidebar() {
            document.getElementById("sidebarOverlay").classList.add("open");
            document.getElementById("sidebarDrawer").classList.add("open");
            updateSidebarActiveState();
        }

        function closeSidebar() {
            document.getElementById("sidebarOverlay").classList.remove("open");
            document.getElementById("sidebarDrawer").classList.remove("open");
        }

        // --- v182: INSIGHTS RAIL AS A MOBILE (<768px) RIGHT-EDGE DRAWER ---
        // Same #desktopInsightsRail element/content as the 1400px+ rail (see
        // renderDesktopInsightsRail) — these two functions just toggle its .open class (and the
        // dedicated #insightsRailOverlay) so it slides in from the right on phones. Harmless to
        // call at any width: above 767px the CSS in the matching @media block simply doesn't
        // apply, so toggling .open there has no visual effect.
        function openInsightsDrawer() {
            closeSidebar(); // mutually exclusive with the left nav drawer, same as two modals
            document.getElementById("insightsRailOverlay").classList.add("open");
            document.getElementById("desktopInsightsRail").classList.add("open");
        }

        function closeInsightsDrawer() {
            document.getElementById("insightsRailOverlay").classList.remove("open");
            document.getElementById("desktopInsightsRail").classList.remove("open");
        }

        // Highlights the sidebar item matching whichever page is currently on screen —
        // called on open and after every sidebar-triggered navigation so the drawer stays
        // in sync even though page switches also happen from outside the sidebar (e.g. the
        // dashboard's own "Total Income" stat box also opens the ledger page).
        function updateSidebarActiveState() {
            document.querySelectorAll(".sidebar-item").forEach(i => i.classList.remove("active"));
            const workspaceHidden = document.getElementById("page-workspace").classList.contains("hidden");
            const savingsHidden = document.getElementById("page-savings").classList.contains("hidden");
            const ledgerHidden = document.getElementById("page-ledger").classList.contains("hidden");
            const accountsHidden = document.getElementById("page-accounts").classList.contains("hidden");
            const categoriesHidden = document.getElementById("page-categories").classList.contains("hidden");
            const backupHidden = document.getElementById("page-backup").classList.contains("hidden");
            const autolockHidden = document.getElementById("page-autolock").classList.contains("hidden");
            const databaseHidden = document.getElementById("page-database").classList.contains("hidden");
            const spendingHidden = document.getElementById("page-spending-breakdown").classList.contains("hidden");
            const incomeHidden = document.getElementById("page-income-breakdown").classList.contains("hidden");
            const portfolioReportHidden = document.getElementById("page-portfolio-report").classList.contains("hidden");
            const ownerNetWorthReportHidden = document.getElementById("page-owner-networth-report").classList.contains("hidden");
            const currencyReportHidden = document.getElementById("page-currency-report").classList.contains("hidden");
            const navUpdateHidden = document.getElementById("page-navupdate").classList.contains("hidden");
            let target = null;
            if (!savingsHidden) target = "savings";
            else if (!accountsHidden) target = "accounts";
            else if (!categoriesHidden) target = "categories";
            else if (!backupHidden) target = "backup";
            else if (!autolockHidden) target = "autolock";
            else if (!databaseHidden) target = "database";
            else if (!spendingHidden) target = "spending-breakdown";
            else if (!incomeHidden) target = "income-breakdown";
            else if (!portfolioReportHidden) target = "portfolio-report";
            else if (!ownerNetWorthReportHidden) target = "owner-networth-report";
            else if (!currencyReportHidden) target = "currency-report";
            else if (!navUpdateHidden) target = "navupdate";
            else if (!ledgerHidden) {
                const isUnfiltered = activeLedgerAccountView === "all" && activeCategoryView === "all" && directTypeView === "all";
                target = isUnfiltered ? "all-ledger" : null;
            } else if (!workspaceHidden) target = "workspace";
            if (target) {
                const el = document.querySelector(`.sidebar-item[data-target="${target}"]`);
                if (el) el.classList.add("active");
            }
        }

        // Routes a sidebar tap to the matching page/modal. Backup & Restore, Accounts/Categories,
        // Auto-Lock, App Local Database, and Spending/Income Breakdown are all full pages (not
        // modals) — see the matching navigateTo*Page functions.
        function sidebarGo(el) {
            const target = el.dataset.target;
            closeSidebar();
            if (target === "workspace") navigateToWorkspace();
            else if (target === "all-ledger") navigateToLedgerPage("all");
            else if (target === "savings") navigateToSavingsPage();
            else if (target === "accounts") navigateToAccountsPage();
            else if (target === "categories") navigateToCategoriesPage();
            else if (target === "backup") navigateToBackupPage();
            else if (target === "members") navigateToMembersPage();
            else if (target === "autolock") navigateToAutoLockPage();
            else if (target === "database") navigateToDatabasePage();
            else if (target === "spending-breakdown") navigateToSpendingBreakdownPage();
            else if (target === "income-breakdown") navigateToIncomeBreakdownPage();
            else if (target === "portfolio-report") navigateToPortfolioReportPage();
            else if (target === "owner-networth-report") navigateToOwnerNetWorthReportPage();
            else if (target === "currency-report") navigateToCurrencyReportPage();
            else if (target === "lock") lockAppNow();
        }

        // --- LOCAL STORAGE DATA CALCULATION ---
        async function calculateStorageMetrics() {
            if (navigator.storage && navigator.storage.estimate) {
                const estimate = await navigator.storage.estimate();
                const usedMB = (estimate.usage / (1024 * 1024)).toFixed(2);
                const totalMB = (estimate.quota / (1024 * 1024)).toFixed(2);
                
                const txs = await readAllDB(STORES.TRANSACTIONS);
                const localAppBytes = JSON.stringify(txs).length * 2 + 150000; 
                const appMB = (localAppBytes / (1024 * 1024)).toFixed(2);

                // v121: attachments now live in their own store — surface a real count/size
                // instead of the old hardcoded "0 attachments" placeholder.
                const atts = await readAllDB(STORES.ATTACHMENTS);
                const attBytes = JSON.stringify(atts).length;
                const attMB = (attBytes / (1024 * 1024)).toFixed(2);

                document.getElementById("appStorageText").textContent = `App Local Database footprint: ~${appMB} MB (${atts.length} attachment${atts.length === 1 ? '' : 's'}, ${attMB} MB)`;
                document.getElementById("systemQuotaText").textContent = `Total browser quota limit: ~${totalMB} MB, Used: ${usedMB} MB (across local sandboxes)`;
                
                const percentage = Math.min((estimate.usage / estimate.quota) * 100, 100);
                document.getElementById("meterFillElement").style.width = `${Math.max(percentage, 0.4)}%`;
            }
        }

        // --- CURRENCY SETTINGS CONTROLS ---
        function openCurrencyConfig() {
            const baseSelect = document.getElementById("baseCurrencySelect");
            baseSelect.innerHTML = Object.keys(fxRates).map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
            baseSelect.value = baseCurrency;
            renderFxRatesInputs();
            document.getElementById("fetchFxRatesStatus").textContent = "";
            openModal("currencyModal");
        }

        // Renders one row per non-base currency in `rates` (defaults to the saved fxRates when
        // called with no argument — handleBaseCurrencyChange and the initial openCurrencyConfig()
        // both rely on this default). v68: which side of "=" the base currency sits on now flips
        // per row based on relative value, matching how people actually quote a pair — a currency
        // worth MORE than 1 base unit (e.g. 1 USD = 4.20 MYR) is quoted as "1 {that currency} =",
        // while one worth LESS (e.g. 1 MYR = 8.15 THB) stays "1 {base} =". Each input's data-mode
        // ("direct" = value already IS fxRates[curr]; "inverted" = value is 1/fxRates[curr]) is
        // read back by saveFxRates() to convert whatever's on screen back to the stored
        // convention, so this is purely a display choice — storage/conversion math is unchanged.
        function renderFxRatesInputs(rates) {
            rates = rates || fxRates;
            let html = "";
            Object.keys(rates).forEach(curr => {
                if (curr === baseCurrency) return;
                const perBase = rates[curr] / (rates[baseCurrency] || 1); // units of curr per 1 base
                let leftLabel, rightLabel, mode, displayValue;
                if (perBase < 1) {
                    // Less than 1 unit of curr per base ⇒ 1 curr is worth MORE than 1 base unit.
                    leftLabel = `1 ${curr} =`;
                    rightLabel = baseCurrency;
                    mode = "inverted";
                    displayValue = 1 / perBase;
                } else {
                    leftLabel = `1 ${baseCurrency} =`;
                    rightLabel = curr;
                    mode = "direct";
                    displayValue = perBase;
                }
                html += `
                    <div class="form-row" style="display: flex; align-items: center; gap: 8px;">
                        <span style="width: 80px; font-weight:700; font-size:0.85rem;">${escapeHtml(leftLabel)}</span>
                        <input type="number" step="0.0001" id="fxRate-${curr}" data-mode="${mode}" value="${displayValue.toFixed(4)}" style="flex:1;">
                        <span style="width: 50px; font-weight:700; font-size:0.85rem;">${escapeHtml(rightLabel)}</span>
                    </div>
                `;
            });
            document.getElementById("fxRatesFormContainer").innerHTML = html;
        }

        function handleBaseCurrencyChange() {
            const newBase = document.getElementById("baseCurrencySelect").value;
            const pivotMultiplier = 1 / fxRates[newBase];
            Object.keys(fxRates).forEach(curr => { fxRates[curr] = fxRates[curr] * pivotMultiplier; });
            fxRates[newBase] = 1.0;
            baseCurrency = newBase;
            renderFxRatesInputs();
            document.getElementById("fetchFxRatesStatus").textContent = "";
        }

        async function saveFxRates() {
            for (const curr of Object.keys(fxRates)) {
                if (curr === baseCurrency) continue;
                const el = document.getElementById(`fxRate-${curr}`);
                if (el) {
                    const val = parseFloat(el.value);
                    if (isNaN(val) || val <= 0) {
                        alert(`Please enter a valid exchange rate for ${curr}.`);
                        return;
                    }
                    // v68: the field may be showing either the direct value (fxRates[curr] itself)
                    // or its reciprocal (see renderFxRatesInputs) — data-mode says which, so this
                    // always converts back to the stored "units of curr per 1 base" convention
                    // regardless of which way the row happened to be labeled on screen.
                    fxRates[curr] = el.dataset.mode === "inverted" ? (1 / val) : val;
                }
            }

            try {
                await writeDB(STORES.SETTINGS, { key: "baseCurrency", value: baseCurrency });
                await writeDB(STORES.SETTINGS, { key: "fxRates", value: fxRates });
            } catch (err) {
                alert("Could not save currency settings: " + (err && err.message ? err.message : err));
                return;
            }

            document.getElementById("currentBasePill").textContent = baseCurrency;
            closeModal("currencyModal");
            renderApp();
        }

        // Fetch Live Rates (v67) — pulls today's rates from the same open.er-api.com source the
        // Wealth Planner app's own "Fetch Live Rates" button uses, so both apps agree when
        // fetched around the same time instead of drifting apart from separately-typed manual
        // values. Only fills the visible input fields (matching Wealth Planner's own UX) — still
        // requires "Save FX Values" below to actually apply. Uses the currently-selected base in
        // the dropdown (which may not be saved yet), same as Wealth Planner's own version.
        //
        // No inversion needed here (unlike Wealth Planner's own fetch code, which stores rates in
        // "1 curr = ? base" form): the API's data.rates[c] ("1 base = X units of c") already
        // matches this app's own fxRates[c] storage convention ("units of c per 1 base") directly
        // — confirmed against convertCurrency()'s formula, (amount / fxRates[fromCurr]) *
        // fxRates[toCurr].
        //
        // v68: re-renders the whole form from a merged {...fxRates, ...fetched} snapshot (instead
        // of poking each input's .value directly) so every row's "1 X = Y Z" direction is
        // recomputed fresh against the just-fetched numbers too, not left over from whatever
        // direction the old stored rate happened to need.
        async function fetchLiveFxRates() {
            const base = document.getElementById("baseCurrencySelect").value;
            const others = Object.keys(fxRates).filter(c => c !== base);
            const statusEl = document.getElementById("fetchFxRatesStatus");
            const btn = document.getElementById("fetchFxRatesBtn");
            if (others.length === 0) {
                statusEl.textContent = "No other currencies configured — nothing to fetch.";
                return;
            }
            btn.disabled = true;
            statusEl.textContent = "Fetching latest rates…";
            try {
                const res = await fetch("https://open.er-api.com/v6/latest/" + encodeURIComponent(base));
                if (!res.ok) throw new Error("Request failed (" + res.status + ")");
                const data = await res.json();
                if (data.result !== "success" || !data.rates) throw new Error("Unexpected response");
                const merged = { ...fxRates, [base]: 1.0 };
                let filled = 0;
                others.forEach(c => {
                    const rate = data.rates[c];
                    if (rate && rate > 0) { merged[c] = rate; filled++; }
                });
                renderFxRatesInputs(merged);
                const missed = others.length - filled;
                statusEl.textContent = `✅ Filled ${filled} rate${filled !== 1 ? "s" : ""} as of ${data.time_last_update_utc || "just now"}.${missed > 0 ? ` ${missed} currenc${missed !== 1 ? "ies" : "y"} not found — enter manually.` : ""} Review and tap Save FX Values to apply.`;
            } catch (err) {
                statusEl.textContent = `⚠️ Could not fetch live rates (${err && err.message ? err.message : err}). Check your internet connection, or enter rates manually below.`;
            } finally {
                btn.disabled = false;
            }
        }

        // --- ACCOUNTS MANAGER SETUP (WITH INTEGRATED EDITOR) ---
        // Shared by every entry point that opens the Accounts modal (the "+" FAB, "+ Add
        // Account" on a member's page, and editAccount) — (re)populates the Currency <option>s
        // from fxRates and selects preselect (falling back to baseCurrency). Previously each
        // entry point duplicated this population inline, and resetAccountForm() — used by the
        // member-page "+ Add Account" flow — never populated it at all, just set .value on
        // whatever options happened to already be in the select (often none, leaving the field
        // blank with no dropdown arrow the first time a session went straight to a member page).
        function populateNewAccountCurrencySelect(preselect) {
            const select = document.getElementById("newAccCurrency");
            select.innerHTML = "";
            Object.keys(fxRates).forEach(c => { select.innerHTML += `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`; });
            select.value = preselect || baseCurrency;
        }

        // Opens the Accounts modal in "create" mode — used by the "+" FAB on the Accounts page.
        function openAccountFormModal() {
            populateNewAccountCurrencySelect(baseCurrency);
            resetAccountForm();
            // Same "only one member configured, so there's nothing to actually pick" default
            // already used for the Salary Contribution member select (see handleSalaryMemberChange
            // caller) — skips a pointless extra tap on solo-user setups. Anyone with 2+ members
            // still starts unchecked, same as before.
            renderAccountMemberCheckboxes(membersCache.length === 1 ? [membersCache[0].id] : []);
            openModal("accountsModal");
        }

        // Fills the Default Payment Account dropdown with every account, and selects whatever is
        // currently saved as the default. Used to pre-select the account field on new Expense
        // and Transfer (from-side) entries — see openTransactionForm().
        async function populateDefaultPaymentAccountSelect() {
            const accounts = await readAllDB(STORES.ACCOUNTS);
            const select = document.getElementById("defaultPaymentAccountSelect");
            select.innerHTML = `<option value="">(None)</option>` + accounts.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(accountOptionLabel(a, accounts))} (${escapeHtml(a.currency || a.type)})</option>`).join("");
            select.value = accounts.some(a => a.id === defaultPaymentAccount) ? defaultPaymentAccount : "";
            syncAccountPickerButtonText("defaultPaymentAccountSelect");
        }

        async function saveDefaultPaymentAccount() {
            defaultPaymentAccount = document.getElementById("defaultPaymentAccountSelect").value;
            await writeDB(STORES.SETTINGS, { key: "defaultPaymentAccount", value: defaultPaymentAccount });
        }

        // Same idea as populateDefaultPaymentAccountSelect(), but for money coming IN — used to
        // pre-select the account field on new Income entries (see openTransactionForm()) and the
        // Bank Account field in Salary Entry (see openSalaryEntryForm()). Kept as a separate
        // setting from Default Payment Account since a household very often routes outgoing
        // spending and incoming salary through different accounts on purpose (e.g. a joint
        // account for salary/bills, a personal account for discretionary spending).
        async function populateDefaultReceiveAccountSelect() {
            const accounts = await readAllDB(STORES.ACCOUNTS);
            const select = document.getElementById("defaultReceiveAccountSelect");
            select.innerHTML = `<option value="">(None)</option>` + accounts.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(accountOptionLabel(a, accounts))} (${escapeHtml(a.currency || a.type)})</option>`).join("");
            select.value = accounts.some(a => a.id === defaultReceiveAccount) ? defaultReceiveAccount : "";
            syncAccountPickerButtonText("defaultReceiveAccountSelect");
        }

        async function saveDefaultReceiveAccount() {
            defaultReceiveAccount = document.getElementById("defaultReceiveAccountSelect").value;
            await writeDB(STORES.SETTINGS, { key: "defaultReceiveAccount", value: defaultReceiveAccount });
        }

        let multiOpeningRowCounter = 0;
        let fdOpeningRowCounter = 0;

        // Fills a <select> with day-of-month options 1..31 — shared by Credit Card's Statement
        // Day and Payment Due Day fields (v127). Both are purely informational in this Tier-1
        // implementation (see the comment on #ccWrap in index.html) — nothing here buckets
        // transactions by billing cycle, they're just captured for reference/display.
        function populateDaySelect(sel, preselectDay) {
            sel.innerHTML = Array.from({ length: 31 }, (_, i) => i + 1)
                .map(d => `<option value="${d}">${d}</option>`).join("");
            sel.value = preselectDay || "1";
        }

        // Credit Card's "Default Payment Account" — same exclude-self pattern as
        // populateLinkedAccountSelect (Bank Loan's Related Account), but doesn't exclude other
        // Credit Card accounts (paying one card from another isn't a normal flow, but there's no
        // strong reason to forbid it either — e.g. a balance-transfer-style payment).
        async function populateCcPaymentAccountSelect(preselectId) {
            const sel = document.getElementById("newAccCcPaymentAccount");
            const excludeId = document.getElementById("editAccountId").value;
            const accounts = await readAllDB(STORES.ACCOUNTS);
            const candidates = accounts
                .filter(a => a.id !== excludeId)
                .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
            sel.innerHTML = `<option value="">(None)</option>` + candidates.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(accountOptionLabel(a, accounts))}</option>`).join("");
            sel.value = (preselectId && candidates.some(a => a.id === preselectId)) ? preselectId : "";
        }

        function setAccountTypeUI(type) {
            document.getElementById("newAccType").value = type;
            const normalBtn = document.getElementById("accTypeBtnNormal");
            const ccBtn = document.getElementById("accTypeBtnCc");
            const multiBtn = document.getElementById("accTypeBtnMulti");
            const fdBtn = document.getElementById("accTypeBtnFd");
            const utBtn = document.getElementById("accTypeBtnUt");
            const balCurrRow = document.getElementById("newAccBalCurrRow");
            const multiWrap = document.getElementById("multiOpeningWrap");
            const fdWrap = document.getElementById("fdOpeningWrap");
            const utWrap = document.getElementById("utInfoWrap");
            const ccWrap = document.getElementById("ccWrap");
            const hint = document.getElementById("accTypeHint");
            const isEditing = document.getElementById("editAccountId").value !== "";

            [normalBtn, ccBtn, multiBtn, fdBtn, utBtn].forEach(btn => {
                btn.style.background = "var(--chip-bg)"; btn.style.color = "var(--text-main)";
            });

            balCurrRow.style.display = "none";
            multiWrap.style.display = "none";
            fdWrap.style.display = "none";
            utWrap.style.display = "none";
            ccWrap.style.display = "none";

            if (type === "normal") {
                normalBtn.style.background = "var(--transfer-color)"; normalBtn.style.color = "white";
                balCurrRow.style.display = "flex";
                hint.textContent = "A single fixed currency, chosen now — e.g. a MYR bank account.";
            } else if (type === "creditcard") {
                ccBtn.style.background = "var(--transfer-color)"; ccBtn.style.color = "white";
                hint.textContent = "A single fixed currency, same as Normal — spending is logged as an ordinary Expense (pushing the balance negative = amount owed), and the 💳 Pay button below logs a payment as a Transfer from your chosen account.";
                balCurrRow.style.display = "flex";
                ccWrap.style.display = "block";
                // v127: new-account creation only defaults Group to "Credit Card" for
                // convenience — never overrides it while editing an existing account, in case
                // it was deliberately grouped elsewhere (matches the Multi-Currency/FD precedent
                // of only auto-populating their opening-balance rows for a brand-new account).
                if (!isEditing) {
                    document.getElementById("newAccGroup").value = "Credit Card";
                    handleAccGroupChange();
                }
                // v127 bugfix: always repopulate fresh (no "already populated, skip" guard) —
                // an earlier version only populated once ever, so switching from editing one
                // Credit Card account to creating a brand-new one left the previous account's
                // Statement/Due Day still showing instead of resetting to the "1" default.
                // editAccount() still overrides with the correct preselected values right after
                // calling setAccountTypeUI(account.type), so this repopulation is never wasted
                // work in that path — it's just always overwritten a moment later with the
                // account's real saved values.
                populateDaySelect(document.getElementById("newAccCcStatementDay"));
                populateDaySelect(document.getElementById("newAccCcDueDay"));
                populateCcPaymentAccountSelect();
            } else if (type === "multi") {
                multiBtn.style.background = "var(--transfer-color)"; multiBtn.style.color = "white";
                hint.textContent = "Holds separate currency balances under one account name — e.g. \"Bank A\" with its own SGD and MYR balances side by side, never mixed together.";
                // v137: this block used to be hidden entirely once editing (an existing account
                // had no way to add a brand-new currency leg from this form at all) on the theory
                // that adding funds to an existing account should go through a normal Income/
                // Transfer entry instead — true, but not obvious, and the create-flow's "+ Add
                // Currency" affordance is the more natural place to reach for it. Now shown for
                // both: any filled row becomes the exact same "Opening Balance" transfer this
                // form already creates for a brand-new account (src blank, dest this account) —
                // for an existing account, that's simply funds you're bringing into tracking now,
                // dated today, same reasoning as when the account was first created. Editing
                // starts with zero rows (no auto-added empty one) since there's nothing to
                // pre-fill, and the label is reworded so it doesn't read as a required setup step.
                multiWrap.style.display = "block";
                document.getElementById("multiOpeningWrapLabel").textContent = isEditing
                    ? "Add Another Currency (optional)"
                    : "Opening Balances (optional)";
                if (!isEditing && document.getElementById("multiOpeningRows").children.length === 0) addMultiCurrencyRow();
                // v171: new-account creation only defaults Group to "Multi-Currency" for
                // convenience, same precedent as Credit Card above — never overrides it while
                // editing an existing account, in case it was deliberately grouped elsewhere.
                if (!isEditing) {
                    document.getElementById("newAccGroup").value = "Multi-Currency";
                    handleAccGroupChange();
                }
            } else if (type === "fd") {
                fdBtn.style.background = "var(--transfer-color)"; fdBtn.style.color = "white";
                hint.textContent = "Just choose the type and name — currency, principal, tenure, rate, and maturity date are captured per placement below (or later, whenever you transfer funds in).";
                if (!isEditing) {
                    fdWrap.style.display = "block";
                    if (document.getElementById("fdOpeningRows").children.length === 0) addFdPlacementRow();
                }
            } else if (type === "unittrust") {
                utBtn.style.background = "var(--transfer-color)"; utBtn.style.color = "white";
                hint.textContent = "Holds one or more unit trust funds. Just choose the type and name here — add each fund, then log Buy/Sell/Dividend/Contribution transactions against it, from this account's own page.";
                utWrap.style.display = "block";
            }
        }

        // --- Multi-Currency: dynamic "opening balance" rows (one per currency) ---

        function addMultiCurrencyRow() {
            multiOpeningRowCounter++;
            const rowId = `mrow_${multiOpeningRowCounter}`;
            const currencyOptions = Object.keys(fxRates).map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");

            const row = document.createElement("div");
            row.id = rowId;
            row.className = "form-row-inline";
            row.style.cssText = "grid-template-columns: 1fr 1fr auto; align-items:end;";
            row.innerHTML = `
                <div>
                    <label>Currency</label>
                    <select class="form-input multi-row-currency">${currencyOptions}</select>
                </div>
                <div>
                    <label>Amount</label>
                    <input type="number" class="multi-row-amount" step="0.01" placeholder="0.00">
                </div>
                <button type="button" data-click="removeRow" data-row-id="${rowId}" class="trash-btn" style="margin-bottom:12px;">🗑</button>
            `;
            document.getElementById("multiOpeningRows").appendChild(row);
        }

        // --- Fixed Deposit: dynamic "opening placement" rows (one per existing FD tranche) ---

        function addFdPlacementRow() {
            fdOpeningRowCounter++;
            const rowId = `fdrow_${fdOpeningRowCounter}`;
            const currencyOptions = Object.keys(fxRates).map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
            const today = todayLocalStr();

            const row = document.createElement("div");
            row.id = rowId;
            row.style.cssText = "background:var(--primary-chip-bg); border:1px solid var(--border-color); border-radius:10px; padding:10px; margin-bottom:10px; position:relative;";
            row.innerHTML = `
                <button type="button" data-click="removeRow" data-row-id="${rowId}" style="position:absolute; top:8px; right:8px; background:none; border:none; font-size:1rem; cursor:pointer;">🗑</button>
                <div class="form-row-inline">
                    <div>
                        <label>Currency</label>
                        <select class="form-input fd-row-currency">${currencyOptions}</select>
                    </div>
                    <div>
                        <label>Principal Amount</label>
                        <input type="number" class="fd-row-amount" step="0.01" placeholder="0.00" data-input="recalcFdOpeningRowMaturity" data-row-id="${rowId}">
                    </div>
                </div>
                <div class="form-row">
                    <label>Account / Reference No. (optional)</label>
                    <input type="text" class="fd-row-reference" placeholder="e.g. FD-2026-00123">
                </div>
                <div class="form-row-inline">
                    <div>
                        <label>Commencing Date</label>
                        <input type="date" class="fd-row-start" value="${today}" data-change="recalcFdOpeningRowMaturity" data-row-id="${rowId}">
                    </div>
                    <div>
                        <label>Tenure (months)</label>
                        <input type="number" class="fd-row-tenure" step="1" min="1" value="12" data-change="recalcFdOpeningRowMaturity" data-row-id="${rowId}">
                    </div>
                </div>
                <div class="form-row-inline">
                    <div>
                        <label>Interest Rate (% p.a.)</label>
                        <input type="number" class="fd-row-rate" step="0.01" min="0" value="3.0" data-input="recalcFdOpeningRowMaturity" data-row-id="${rowId}">
                    </div>
                    <div>
                        <label>Maturity Date</label>
                        <input type="date" class="fd-row-maturity" readonly>
                    </div>
                </div>
                <p class="fd-row-preview" style="font-size:0.72rem; color:#6d28d9; margin-top:2px;"></p>
            `;
            document.getElementById("fdOpeningRows").appendChild(row);
            recalcFdOpeningRowMaturity(rowId);
        }

        function recalcFdOpeningRowMaturity(rowId) {
            const row = document.getElementById(rowId);
            if (!row) return;

            const startVal = row.querySelector(".fd-row-start").value;
            const tenure = parseInt(row.querySelector(".fd-row-tenure").value, 10);
            const preview = row.querySelector(".fd-row-preview");

            if (!startVal || isNaN(tenure) || tenure <= 0) {
                preview.textContent = "";
                return;
            }

            const start = new Date(startVal + "T00:00:00");
            const maturity = new Date(start);
            maturity.setMonth(maturity.getMonth() + tenure);
            const maturityStr = localDateStr(maturity);
            row.querySelector(".fd-row-maturity").value = maturityStr;

            const principal = parseFloat(row.querySelector(".fd-row-amount").value) || 0;
            const rate = parseFloat(row.querySelector(".fd-row-rate").value) || 0;
            const curr = row.querySelector(".fd-row-currency").value;
            const projectedInterest = principal * (rate / 100) * (tenure / 12);
            const projectedTotal = principal + projectedInterest;

            preview.textContent = `Matures ${maturityStr} — projected payout ≈ ${formatCurrency(projectedTotal, curr)}`;
        }

        // Populates the Sub-Group select for whichever Group is currently chosen, and shows/hides
        // the row entirely when that Group has no configured sub-groups (see ACCOUNT_SUBGROUPS).
        // Also shows/hides + populates the Bank Loan "Related Account" select (see
        // populateLinkedAccountSelect below) and the Redraw Facility checkbox whenever the Group
        // is switched to/from "Bank Loan", and the Real Estate "Include in Net Worth"/Type/Holding
        // Period fields whenever it's switched to/from "Real Estate".
        async function handleAccGroupChange(preselectSubgroup, preselectLinkedAccountId, preselectIncludeInNetWorth, preselectPropertyType, preselectHoldingStartDate, preselectHasRedraw, preselectRedrawAmount, preselectRedrawAsOfDate, preselectTenureType, preselectLeaseTermYears, preselectLeaseExpiryDate) {
            const group = document.getElementById("newAccGroup").value;
            const list = subgroupsForGroup(group);
            const row = document.getElementById("newAccSubgroupRow");
            const sel = document.getElementById("newAccSubgroup");
            if (list.length === 0) {
                row.style.display = "none";
                sel.innerHTML = "";
            } else {
                // block (not flex) — this row holds a <label> above a <select>, meant to stack
                // vertically like every other .form-row in this form. flex was laying them out
                // side-by-side instead, squeezing the select down to its min-content width.
                row.style.display = "block";
                sel.innerHTML = `<option value="">(No Sub-Group)</option>` + list.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
                sel.value = (preselectSubgroup && list.includes(preselectSubgroup)) ? preselectSubgroup : "";
            }

            const linkedRow = document.getElementById("newAccLinkedAccountRow");
            const redrawFacilityRow = document.getElementById("newAccRedrawFacilityRow");
            if (group === "Bank Loan") {
                linkedRow.style.display = "block";
                await populateLinkedAccountSelect(preselectLinkedAccountId);
                redrawFacilityRow.style.display = "block";
                document.getElementById("newAccHasRedraw").checked = !!preselectHasRedraw;
                document.getElementById("newAccRedrawAmount").value = preselectRedrawAmount || "";
                document.getElementById("newAccRedrawAsOfDate").value = preselectRedrawAsOfDate || "";
                toggleRedrawFacilityFields();
            } else {
                linkedRow.style.display = "none";
                document.getElementById("newAccLinkedAccount").innerHTML = "";
                redrawFacilityRow.style.display = "none";
                document.getElementById("newAccHasRedraw").checked = false;
                document.getElementById("newAccRedrawDetailsRow").style.display = "none";
            }

            const netWorthRow = document.getElementById("newAccNetWorthRow");
            const propertyTypeRow = document.getElementById("newAccPropertyTypeRow");
            const holdingStartRow = document.getElementById("newAccHoldingStartRow");
            const tenureRow = document.getElementById("newAccTenureRow");
            if (group === "Real Estate") {
                netWorthRow.style.display = "block";
                document.getElementById("newAccIncludeNetWorth").value = preselectIncludeInNetWorth === "no" ? "no" : "yes";
                propertyTypeRow.style.display = "block";
                document.getElementById("newAccPropertyType").value = preselectPropertyType || "";
                holdingStartRow.style.display = "block";
                document.getElementById("newAccHoldingStartDate").value = preselectHoldingStartDate || "";
                tenureRow.style.display = "block";
                document.getElementById("newAccTenure").value = preselectTenureType || "";
                document.getElementById("newAccLeaseTermYears").value = preselectLeaseTermYears || "";
                document.getElementById("newAccLeaseExpiryDate").value = preselectLeaseExpiryDate || "";
                toggleLeaseFields();
            } else {
                netWorthRow.style.display = "none";
                propertyTypeRow.style.display = "none";
                holdingStartRow.style.display = "none";
                tenureRow.style.display = "none";
                document.getElementById("newAccLeaseTermRow").style.display = "none";
                document.getElementById("newAccLeaseExpiryRow").style.display = "none";
            }
        }

        // Wired to the Tenure select's onchange, and also called after pre-filling it when
        // opening the form to edit an existing property (mirrors toggleRedrawFacilityFields
        // below) — shows Lease Term/Lease Expiry only when Tenure = "Leasehold"; a Freehold
        // property has no expiry, so those fields (and any values in them) don't apply.
        function toggleLeaseFields() {
            const isLeasehold = document.getElementById("newAccTenure").value === "Leasehold";
            document.getElementById("newAccLeaseTermRow").style.display = isLeasehold ? "block" : "none";
            document.getElementById("newAccLeaseExpiryRow").style.display = isLeasehold ? "block" : "none";
        }

        // Wired to the "This loan has a Redraw / Bank Withdrawal facility" checkbox — shows/hides
        // the Current Redraw Amount + As of Date fields underneath it. Kept as its own function
        // (rather than inline) so handleAccGroupChange can also call it after pre-checking the
        // box when opening the form to edit an existing loan.
        function toggleRedrawFacilityFields() {
            const checked = document.getElementById("newAccHasRedraw").checked;
            document.getElementById("newAccRedrawDetailsRow").style.display = checked ? "grid" : "none";
        }

        // Fills the Bank Loan "Related Account" select with every OTHER account (excluding the
        // account currently being edited, and excluding other Bank Loan accounts — a loan
        // shouldn't relate to another loan). Purely informational: doesn't affect any balance or
        // transaction, just shown alongside the loan account wherever it's displayed.
        async function populateLinkedAccountSelect(preselectId) {
            const sel = document.getElementById("newAccLinkedAccount");
            const excludeId = document.getElementById("editAccountId").value;
            const accounts = await readAllDB(STORES.ACCOUNTS);
            const candidates = accounts
                .filter(a => a.id !== excludeId && (a.group || DEFAULT_ACCOUNT_GROUP) !== "Bank Loan")
                .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
            sel.innerHTML = `<option value="">(None)</option>` + candidates.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(accountOptionLabel(a, accounts))}</option>`).join("");
            sel.value = (preselectId && candidates.some(a => a.id === preselectId)) ? preselectId : "";
        }

        function resetAccountForm(skipHistoryPush) {
            const isEditing = document.getElementById("editAccountId").value !== "";
            document.getElementById("editAccountId").value = "";
            document.getElementById("newAccName").value = "";
            document.getElementById("newAccRef").value = "";
            document.getElementById("newAccGroup").value = DEFAULT_ACCOUNT_GROUP;
            handleAccGroupChange();
            document.getElementById("newAccBal").value = "0";
            populateNewAccountCurrencySelect(baseCurrency);
            document.getElementById("accountFormHeaderTitle").textContent = "Create New Account";
            document.getElementById("accFormSubmitBtn").textContent = "Create Account";
            document.getElementById("accFormCancelBtn").style.display = "none";
            document.getElementById("accFormDeleteBtn").style.display = "none";

            document.getElementById("multiOpeningRows").innerHTML = "";
            document.getElementById("fdOpeningRows").innerHTML = "";
            // Same "only one member configured" default as openAccountFormModal — this is what
            // actually runs for "Cancel Edit" (form stays open, reverts to blank/create state)
            // and every other resetAccountForm() caller; openAccountFormModal's own call further
            // below just re-applies the identical default, which is harmless but redundant.
            renderAccountMemberCheckboxes(membersCache.length === 1 ? [membersCache[0].id] : []);

            // Credit Card (v127): explicit reset — setAccountTypeUI("normal") below hides
            // #ccWrap but doesn't touch its own field values, so without this a Credit Limit
            // typed while editing one account would still be sitting in the input the next time
            // Credit Card is picked for a different (or brand-new) account.
            document.getElementById("newAccCcLimit").value = "";

            setAccountTypeUI("normal");

            if (isEditing && !skipHistoryPush) {
                pushVirtualState("accountsModal");
            }
        }

        // Dedicated custom execution for mobile click bypassing standard form intercept
        async function handleCreateAccountMobile() {
            const isNewAccount = document.getElementById("editAccountId").value === "";
            const id = document.getElementById("editAccountId").value || "acc_" + Date.now();
            const name = document.getElementById("newAccName").value.trim();
            const accountRef = document.getElementById("newAccRef").value.trim();
            const type = document.getElementById("newAccType").value;

            if(!name) { alert("Please enter an account name."); return; }

            const group = document.getElementById("newAccGroup").value || DEFAULT_ACCOUNT_GROUP;
            const record = {
                id, name, type, group,
                // Account No. / Ref (v130): purely informational free-text, independent of
                // group/type — unlike propertyType/hasRedrawFacility below, this is NOT cleared
                // when the account is re-grouped, since a bank account number doesn't stop being
                // true just because the account got moved to a different Group/Sub-Group.
                accountRef: accountRef,
                subgroup: document.getElementById("newAccSubgroup").value || "",
                linkedAccountId: (group === "Bank Loan" ? (document.getElementById("newAccLinkedAccount").value || null) : null),
                includeInNetWorth: (group === "Real Estate" ? (document.getElementById("newAccIncludeNetWorth").value !== "no") : true),
                // Real Estate (v66): property Type + Holding Period Start Date — purely
                // informational, cleared out when the account isn't (or is no longer) grouped
                // under Real Estate so a re-grouped account doesn't carry stale values silently.
                propertyType: (group === "Real Estate" ? (document.getElementById("newAccPropertyType").value || "") : ""),
                holdingStartDate: (group === "Real Estate" ? (document.getElementById("newAccHoldingStartDate").value || "") : ""),
                // Real Estate (v131): Tenure (Freehold/Leasehold) + Lease Term/Expiry — same
                // clear-on-regroup treatment as propertyType/holdingStartDate above. Lease
                // Term/Expiry are additionally cleared whenever Tenure isn't "Leasehold" (even
                // while still Real Estate), same pattern as Bank Loan's redraw fields below.
                tenureType: (group === "Real Estate" ? (document.getElementById("newAccTenure").value || "") : ""),
                leaseTermYears: (group === "Real Estate" && document.getElementById("newAccTenure").value === "Leasehold") ? (parseInt(document.getElementById("newAccLeaseTermYears").value, 10) || 0) : 0,
                leaseExpiryDate: (group === "Real Estate" && document.getElementById("newAccTenure").value === "Leasehold") ? (document.getElementById("newAccLeaseExpiryDate").value || "") : "",
                // Bank Loan (v66): manual Redraw / Bank Withdrawal facility amount — same
                // clear-on-regroup treatment, and also cleared if the facility checkbox itself is
                // unticked even while still a Bank Loan.
                hasRedrawFacility: (group === "Bank Loan" && document.getElementById("newAccHasRedraw").checked),
                redrawAmount: (group === "Bank Loan" && document.getElementById("newAccHasRedraw").checked) ? (parseFloat(document.getElementById("newAccRedrawAmount").value) || 0) : 0,
                redrawAsOfDate: (group === "Bank Loan" && document.getElementById("newAccHasRedraw").checked) ? (document.getElementById("newAccRedrawAsOfDate").value || "") : "",
                // Credit Card (v127): Limit/Statement Day/Payment Due Day are purely
                // informational display fields, and Default Payment Account only feeds the 💳
                // Pay button's pre-selected source account — see setAccountTypeUI's comment on
                // #ccWrap for why none of this affects balance/due-amount math. Cleared out (same
                // as Real Estate/Bank Loan's fields above) when the account isn't a Credit Card,
                // so re-typing an account away from Credit Card doesn't leave stale values behind.
                creditLimit: (type === "creditcard") ? (parseFloat(document.getElementById("newAccCcLimit").value) || 0) : 0,
                statementDay: (type === "creditcard") ? (parseInt(document.getElementById("newAccCcStatementDay").value, 10) || null) : null,
                paymentDueDay: (type === "creditcard") ? (parseInt(document.getElementById("newAccCcDueDay").value, 10) || null) : null,
                defaultPaymentAccountId: (type === "creditcard") ? (document.getElementById("newAccCcPaymentAccount").value || null) : null,
                memberIds: getCheckedAccountMemberIds()
            };

            if (type === "normal" || type === "creditcard") {
                const balInput = document.getElementById("newAccBal").value;
                const bal = balInput === "" ? 0 : parseFloat(balInput);
                if (isNaN(bal)) { alert("Please enter a valid initial balance."); return; }
                record.initialBalance = bal;
                record.currency = document.getElementById("newAccCurrency").value;
            } else {
                // Multi-Currency and Fixed Deposit accounts don't have one native currency — their
                // balances/baskets are built up entirely from transactions (seeded below for a new
                // account, or added later via normal Income/Transfer entries).
                record.initialBalance = 0;
            }

            // Collect opening-balance / opening-placement rows BEFORE writing anything, so we can
            // validate everything up front and avoid creating an account with a half-seeded state.
            let openingTransactions = [];
            const todayStr = todayLocalStr();

            // v137: was `isNewAccount && type === "multi"` — the rows are now shown (and can be
            // filled) for an existing multi-currency account too (see setAccountTypeUI above), so
            // this must process them regardless of isNewAccount. Each becomes an ordinary
            // "Opening Balance" transfer into the account, exactly like manually creating one via
            // Income/Transfer entry — dated today for an existing account rather than the
            // account's original creation date, since that's genuinely when these funds are being
            // brought into tracking.
            if (type === "multi") {
                const rows = Array.from(document.getElementById("multiOpeningRows").children);
                for (const row of rows) {
                    const amount = parseFloat(row.querySelector(".multi-row-amount").value);
                    if (!amount || amount <= 0) continue; // skip empty rows
                    openingTransactions.push({
                        // "transfer" (not "income") — this is capital you're bringing into tracking,
                        // not earned income, so it must not inflate the Income report. src is left
                        // blank since the funds originate outside the app (e.g. cash you already had).
                        type: "transfer",
                        desc: "Opening Balance",
                        amount: amount,
                        src: "",
                        dest: id,
                        currency: row.querySelector(".multi-row-currency").value,
                        cat: "Opening Balance",
                        date: todayStr,
                        image: null,
                        fdReferenceNo: null,
                        fdStartDate: null, fdTenureMonths: null, fdInterestRate: null, fdMaturityDate: null
                    });
                }
            }

            if (isNewAccount && type === "fd") {
                const rows = Array.from(document.getElementById("fdOpeningRows").children);
                for (const row of rows) {
                    const amount = parseFloat(row.querySelector(".fd-row-amount").value);
                    if (!amount || amount <= 0) continue; // skip empty rows

                    const fdStartDate = row.querySelector(".fd-row-start").value;
                    const fdTenureMonths = parseInt(row.querySelector(".fd-row-tenure").value, 10);
                    const fdInterestRate = parseFloat(row.querySelector(".fd-row-rate").value);
                    const fdMaturityDate = row.querySelector(".fd-row-maturity").value;
                    const fdReferenceNo = row.querySelector(".fd-row-reference").value.trim() || null;

                    if (!fdStartDate) { alert("Please select a commencing date for each Fixed Deposit placement."); return; }
                    if (isNaN(fdTenureMonths) || fdTenureMonths <= 0) { alert("Please enter a valid tenure (in months) for each placement."); return; }
                    if (isNaN(fdInterestRate) || fdInterestRate < 0) { alert("Please enter a valid interest rate for each placement."); return; }
                    if (!fdMaturityDate) { alert("Could not calculate a maturity date for a placement — please re-check its commencing date and tenure."); return; }

                    openingTransactions.push({
                        // "transfer" (not "income") — same reasoning as above: this is principal
                        // capital, not earned income.
                        type: "transfer",
                        desc: "Opening Fixed Deposit Placement",
                        amount: amount,
                        src: "",
                        dest: id,
                        currency: row.querySelector(".fd-row-currency").value,
                        cat: "Fixed Deposit",
                        date: fdStartDate,
                        image: null,
                        fdReferenceNo,
                        fdStartDate, fdTenureMonths, fdInterestRate, fdMaturityDate
                    });
                }
            }

            try {
                await writeDB(STORES.ACCOUNTS, record);
            } catch (err) {
                alert("Could not save account: " + (err && err.message ? err.message : err));
                return;
            }

            if (openingTransactions.length > 0) {
                const failedCount = { n: 0 };
                for (const tx of openingTransactions) {
                    try {
                        await writeDB(STORES.TRANSACTIONS, tx);
                    } catch (err) {
                        failedCount.n++;
                    }
                }
                if (failedCount.n > 0) {
                    alert(`Account ${isNewAccount ? "created" : "saved"}, but ${failedCount.n} opening balance/placement entr${failedCount.n === 1 ? 'y' : 'ies'} could not be saved. You can add them manually via Income entries.`);
                }
            }

            resetAccountForm();
            closeModal("accountsModal");
            await refreshAfterAccountChange();
        }

        // Refreshes the dashboard's compact account list (always, via renderApp) and, if the
        // full Accounts page happens to be the one on screen, its list too — called after any
        // account create/edit/delete so whichever view the user is looking at stays current.
        async function refreshAfterAccountChange() {
            await renderApp();
            renderSidebarMembers();
            renderSidebarAccountTypeShortcuts();
            if (!document.getElementById("page-accounts").classList.contains("hidden")) {
                await renderAccountsPage();
            }
            if (!document.getElementById("page-member").classList.contains("hidden") && activeMemberFilter) {
                await renderMemberPage();
            }
        }

        // Renders the full "Accounts" page: the Default Payment Account selector plus a plain
        // list of every account (tap a row to open its Activity page — editing/deleting now
        // lives on that Activity page instead, via the ✏️ icon beside the account name).
        // Small colored "● Name" owner tag shown under an account row (Accounts page / member
        // account lists) — one dot+name per owner for a joint account, muted "Unassigned" if none.
        // Plain-text "Name (Member1, Member2)" / "Name (Unassigned)" label for an account —
        // used anywhere an account shows up inside a <select><option> or other plain-text
        // context, so accounts sharing the same name (e.g. two "KWSP (MYR)" accounts, one per
        // household member) can still be told apart. For rich HTML contexts (list rows) use
        // accountOwnerTagHTML instead, which colors each member's tag.
        function accountOwnerNamesText(account) {
            const ids = Array.isArray(account.memberIds) ? account.memberIds : [];
            if (ids.length === 0) return "Unassigned";
            return ids.map(id => getMemberById(id)?.name || "Unknown").join(", ");
        }
        // Bank Loan accounts (v50 linkedAccountId) can end up sharing BOTH the same name AND
        // the same owner — e.g. two accounts named "HSBC Loan", both tagged to the same family
        // member, one relating to Property A and the other to Property B. Owner alone doesn't
        // disambiguate that case, but the Related Account usually does, so this appends
        // " · <name>" whenever a.linkedAccountId is set. Returns "" when there's nothing to add
        // (including when the caller didn't pass the full accounts list — some call sites only
        // have a filtered subset in scope, and guessing wrong would be worse than just omitting
        // the suffix). Raw text, not HTML-escaped — same contract as accountOwnerNamesText, so
        // callers escape the combined label themselves.
        // v71: dropped the "Related: " prefix (just "· <name>" now) — this suffix only ever
        // shows up right next to the account's own name/owner, so the extra label was noise;
        // the dedicated "🔗 Related Account: X" banner (Accounts page, Activity page) still
        // spells it out in full since it's not sitting next to anything else there.
        function accountRelatedSuffix(a, accounts) {
            if (!a.linkedAccountId || !Array.isArray(accounts)) return "";
            const linked = accounts.find(x => x.id === a.linkedAccountId);
            return linked ? ` · ${linked.name}` : "";
        }
        // v68: now takes the full accounts list (optional, for backward compat) so it can also
        // append the Related Account suffix above — without it, two same-named+same-owner Bank
        // Loan accounts were indistinguishable in every dropdown and list built from this label.
        function accountOptionLabel(a, accounts) {
            return `${a.name} (${accountOwnerNamesText(a)})${accountRelatedSuffix(a, accounts)}`;
        }

        function accountOwnerTagHTML(account) {
            const ids = Array.isArray(account.memberIds) ? account.memberIds : [];
            if (ids.length === 0) {
                return `<span style="font-size:0.7rem; color:var(--text-muted); font-weight:600;">Unassigned</span>`;
            }
            return ids.map(id => {
                const m = getMemberById(id);
                return `<span style="font-size:0.7rem; font-weight:700; color:${m?.color || '#94a3b8'};">● ${escapeHtml(m?.name || 'Unknown')}</span>`;
            }).join(" ");
        }

        // Converts any account's current balance (scalar for Normal, or a currency-basket sum
        // for Multi-Currency/Fixed Deposit/Unit Trust) into base currency — used for the
        // Group/Sub-Group subtotal rows on the Accounts page.
        function accountBaseValue(a, nativeBalances) {
            if (a.type === "multi" || a.type === "fd" || a.type === "unittrust") {
                const baskets = nativeBalances[a.id] || {};
                return Object.keys(baskets).reduce((sum, curr) => sum + convertCurrency(baskets[curr], curr, baseCurrency), 0);
            }
            return convertCurrency(nativeBalances[a.id] || 0, a.currency, baseCurrency);
        }

        async function renderAccountsPage() {
            const { accounts, txs, nativeBalances } = await computeAccountBalances();
            // Fetched once up front (not per-account inside the loop below) and grouped by
            // accountId, so each Unit Trust account row can list its individual fund holdings
            // (e.g. "HLBB Value Fund — RM147.20") directly on the Accounts page without the user
            // having to tap into the account's Activity page first.
            const allFunds = await readAllDB(STORES.FUNDS);
            const fundsByAccountId = {};
            allFunds.forEach(f => { (fundsByAccountId[f.accountId] = fundsByAccountId[f.accountId] || []).push(f); });
            // Active Fixed Deposit placements, grouped by the account holding them (v55): every
            // still-open placement transfer (fdMaturityDate set, not yet fdResolved) into an FD
            // account, so each FD account row can list its individual tranches right here — same
            // idea as the fund/currency subrows above — instead of requiring a tap into that
            // account's own Activity page just to see what's actually placed.
            const fdPlacementsByAccountId = {};
            txs.filter(t => t.type === "transfer" && t.fdMaturityDate && !t.fdResolved && t.dest).forEach(t => {
                (fdPlacementsByAccountId[t.dest] = fdPlacementsByAccountId[t.dest] || []).push(t);
            });
            const filter = accountsPageTypeFilter;
            const filtered = filter
                ? accounts.filter(a => (a.group || DEFAULT_ACCOUNT_GROUP) === filter.group && (a.subgroup || "") === (filter.subgroup || ""))
                : accounts;
            const sorted = sortAccountsByGroupThenName(filtered);

            // v64: the collapse/expand state (expandedAccountSubrows) used to be keyed by
            // account id alone, so the same account's subrows showed the same open/closed state
            // whichever way you reached this page — e.g. via the unfiltered "Financial Accounts"
            // full list vs. a sidebar shortcut like "Unit Trust" that filters down to the same
            // account. Prefixing the key with the active filter (or "all" when unfiltered) makes
            // each of those a separate view with its own independent expand state.
            const subrowFilterKeyPrefix = (filter ? `${filter.group}_${filter.subgroup || "none"}` : "all").replace(/\s+/g, "-");

            const titleEl = document.getElementById("accountsPageListTitle");
            const hintEl = document.getElementById("accountsPageFilterHint");
            if (titleEl) titleEl.textContent = filter ? filter.label : "All Accounts";
            if (hintEl) hintEl.classList.toggle("hidden", !filter);

            let html = "";
            let lastGroup = null;
            let lastSubgroup = undefined;
            let groupTotal = 0, subgroupTotal = 0;

            // Flushes the pending sub-group subtotal (only when that group actually has
            // sub-groups configured — plain groups with no sub-division never show one).
            function flushSubgroupTotal() {
                if (lastSubgroup) {
                    html += `<div class="config-list-subtotal"><span class="total-label">Sub-Total · ${escapeHtml(lastSubgroup)}</span>: <span class="total-amount">${formatBalanceHTML(subgroupTotal, baseCurrency)}</span></div>`;
                }
                subgroupTotal = 0;
            }
            // v62: when the sidebar filter has narrowed the list down to one specific sub-group
            // (e.g. "Current Account" within "Bank/Cash"), every account shown already belongs to
            // that one sub-group, so the Group Total below would just repeat the exact same
            // number as the Sub-Total above it under a confusingly broader label ("Group Total ·
            // Bank/Cash" when only Current Account accounts are actually shown). Suppressed in
            // that case; a whole-group filter with no sub-groups (e.g. "Real Estate") still shows
            // its Group Total as normal, since that's the only total on screen for it.
            function flushGroupTotal() {
                if (lastGroup !== null && !(filter && filter.subgroup)) {
                    html += `<div class="config-list-grouptotal"><span class="total-label">Group Total · ${escapeHtml(lastGroup)}</span>: <span class="total-amount">${formatBalanceHTML(groupTotal, baseCurrency)}</span></div>`;
                }
                groupTotal = 0;
            }

            sorted.forEach(a => {
                const subrowKey = `${subrowFilterKeyPrefix}__${a.id}`;
                const group = a.group || DEFAULT_ACCOUNT_GROUP;
                const subgroup = a.subgroup || "";
                if (group !== lastGroup) {
                    flushSubgroupTotal();
                    flushGroupTotal();
                    html += `<div class="config-list-section-label">${accountGroupBadgeHTML(group)}</div>`;
                    lastGroup = group;
                    lastSubgroup = undefined;
                }
                if (subgroup !== lastSubgroup) {
                    flushSubgroupTotal();
                    if (subgroup) {
                        html += `<div class="config-list-subgroup-label">↳ ${escapeHtml(subgroup)}</div>`;
                    }
                    lastSubgroup = subgroup;
                }

                const typeBadge = a.type === "fd"
                    ? `<span style="font-size:0.65rem; padding:1px 4px; border-radius:4px; background:#ede9fe; color:#6d28d9; font-weight:bold;">Fixed Deposit</span>`
                    : a.type === "multi"
                        ? `<span style="font-size:0.65rem; padding:1px 4px; border-radius:4px; background:#e0f2fe; color:#0369a1; font-weight:bold;">Multi-Currency</span>`
                        : a.type === "unittrust"
                            ? `<span style="font-size:0.65rem; padding:1px 4px; border-radius:4px; background:#fef3c7; color:#92400e; font-weight:bold;">Unit Trust</span>`
                            : a.type === "creditcard"
                                ? `<span style="font-size:0.65rem; padding:1px 4px; border-radius:4px; background:#fce7f3; color:#9d174d; font-weight:bold;">Credit Card</span>`
                                : currencyBadgeHTML(a.currency);

                const baseVal = accountBaseValue(a, nativeBalances);

                let balSummary;
                if (a.type === "multi") {
                    // Multi-Currency accounts (v55): the headline now shows one converted Base
                    // total instead of a long "+"-joined string of every currency held — the
                    // per-currency breakdown moves to its own subrow list below (same pattern as
                    // Unit Trust's fund subrows), each line up on its own row and clickable
                    // through to that currency's own Activity page.
                    balSummary = `≈ ${formatBalanceHTML(baseVal, baseCurrency)}`;
                } else if (a.type === "fd" || a.type === "unittrust") {
                    const baskets = nativeBalances[a.id];
                    const currencies = Object.keys(baskets);
                    balSummary = currencies.length === 0
                        ? '<span style="color:var(--text-muted);">No funds yet</span>'
                        : currencies.map(curr => formatBalanceHTML(baskets[curr], curr)).join(" + ");
                } else {
                    balSummary = formatBalanceHTML(nativeBalances[a.id], a.currency);
                }

                groupTotal += baseVal;
                subgroupTotal += baseVal;

                // Bank Loan (v50): show which other account this loan relates to, if set —
                // purely informational, resolved from the id against the accounts list already
                // in scope here.
                const linkedAcc = a.linkedAccountId ? accounts.find(x => x.id === a.linkedAccountId) : null;
                const linkedLine = linkedAcc
                    ? `<br><span style="font-size:0.7rem; color:#92400e; font-weight:600;">🔗 Related: ${escapeHtml(accountOptionLabel(linkedAcc, accounts))}</span>`
                    : "";

                // Real Estate (v53): flag when a property was explicitly excluded from the
                // Dashboard's Net Worth total (see newAccIncludeNetWorth), so it's obvious here
                // too rather than just being a silent gap in the headline number.
                const excludedLine = a.includeInNetWorth === false
                    ? `<br><span style="font-size:0.7rem; color:#991b1b; font-weight:600;">🚫 Excluded from Net Worth</span>`
                    : "";

                // v164: Account No./Ref shown right under the account name (was bundled at the
                // bottom of the card via accountExtraInfoLine's own refLine) — includeRef:false
                // below so it isn't rendered twice.
                const acctRefLine = a.accountRef
                    ? `<div class="account-card-refline">${escapeHtml(a.accountRef)}</div>`
                    : "";
                const extraInfoLine = accountExtraInfoLine(a, nativeBalances, false);

                // Credit Card (v127): "Amount due" line + 💳 Pay button, both only shown when
                // there's actually something owed (a card paid off in full, or never used, has
                // nothing to show here) — amountDue is just this account's ordinary balance,
                // negated (see openCreditCardPayment's comment for why that's the right number).
                const ccAmountDue = a.type === "creditcard" ? Math.max(0, -(nativeBalances[a.id] || 0)) : 0;
                const ccAmountDueLine = ccAmountDue > 0.005
                    ? `<br><span style="font-size:0.72rem; color:#9d174d; font-weight:700;">💳 Amount due: ${formatBalanceHTML(ccAmountDue, a.currency)}</span>`
                    : "";
                const ccPayBtnHTML = ccAmountDue > 0.005
                    ? `<button type="button" data-click="openCreditCardPayment" data-id="${escapeHtml(a.id)}" style="font-size:0.66rem; font-weight:700; color:#fff; background:#db2777; border:none; border-radius:6px; padding:5px 8px; white-space:nowrap; cursor:pointer;">💳 Pay</button>`
                    : "";

                // v62: subrows collapsed by default (see expandedAccountSubrows) — built into
                // subrowsHtml first (before the main row, so the row can show a collapse/expand
                // toggle only when there's actually something to collapse), then wrapped in one
                // collapsible container appended right after the row.
                let subrowsHtml = "";

                // Multi-Currency account (v55): list each currency basket right under the
                // account row, one per line (same subrow pattern as Unit Trust funds below) —
                // tap a currency to jump straight to that currency's own Activity page, where
                // its Opening Balance and every other transaction in that currency actually live.
                if (a.type === "multi") {
                    const baskets = nativeBalances[a.id] || {};
                    const currencies = Object.keys(baskets).sort();
                    if (currencies.length > 0) {
                        // Base-currency equivalent under each currency subrow, same
                        // .converted-subtext pattern used on the Foreign Cash Activity page
                        // (v58). Name+amount combined into the left span with the chevron alone
                        // on the right (v60 fix, same as the Unit Trust fund subrow above) —
                        // the earlier v59 version still split name (left) from amount+chevron
                        // (right), which left the same big empty-middle gap it was meant to fix.
                        subrowsHtml += currencies.map(curr => {
                            const subText = curr !== baseCurrency
                                ? `<span class="converted-subtext">≈ ${formatCurrency(convertCurrency(baskets[curr], curr, baseCurrency), baseCurrency)}</span>`
                                : "";
                            return `
                            <div class="config-item fund-subrow" style="cursor:pointer;" data-click="navigateToCurrencyActivityPage" data-id="${escapeHtml(a.id)}" data-currency="${escapeHtml(curr)}" data-back="accounts">
                                <span>${escapeHtml(curr)} <span style="color:var(--text-muted); font-weight:600;">— ${formatBalanceHTML(baskets[curr], curr)}</span>${subText}</span>
                                <span style="color:var(--text-muted);">›</span>
                            </div>`;
                        }).join("");
                    }
                }

                // Unit Trust account: list its individual fund holdings right under the account
                // row (tap a fund to jump straight to that fund's own Activity page).
                if (a.type === "unittrust") {
                    const funds = (fundsByAccountId[a.id] || []).slice().sort((x, y) => x.name.localeCompare(y.name));
                    if (funds.length > 0) {
                        subrowsHtml += funds.map(f => {
                            const value = (f.units || 0) * (f.currentNav || 0);
                            return `
                                <div class="config-item fund-subrow" style="cursor:pointer;" data-click="navigateToFundActivityPage" data-id="${escapeHtml(f.id)}" data-back="accounts">
                                    <span>${escapeHtml(f.name)} <span style="color:var(--text-muted); font-weight:600;">— ${formatBalanceHTML(value, f.currency)}</span></span>
                                    <span style="color:var(--text-muted);">›</span>
                                </div>`;
                        }).join("");
                    }
                }

                // Fixed Deposit account (v55): list each still-open placement tranche right
                // under the account row — same subrow pattern as funds/currencies above — so
                // every active "Fixed Deposit Placement" across every FD account is visible
                // without tapping into each account's own Activity page. Tapping a placement
                // opens it straight in the transaction editor, same as tapping it there would.
                if (a.type === "fd") {
                    const placements = (fdPlacementsByAccountId[a.id] || []).slice().sort((x, y) => new Date(y.date) - new Date(x.date));
                    if (placements.length > 0) {
                        subrowsHtml += placements.map(t => {
                            const isOverdue = new Date(t.fdMaturityDate + "T00:00:00").getTime() < new Date(todayLocalStr() + "T00:00:00").getTime();
                            const statusBadge = isOverdue
                                ? `<span style="font-size:0.62rem; font-weight:700; color:#b91c1c; background:#fee2e2; padding:1px 5px; border-radius:4px; margin-left:6px; white-space:nowrap;">⏰ Due</span>`
                                : `<span style="font-size:0.62rem; font-weight:700; color:#15803d; background:#dcfce7; padding:1px 5px; border-radius:4px; margin-left:6px; white-space:nowrap;">🟢 Active</span>`;
                            const refText = t.fdReferenceNo ? ` (${escapeHtml(t.fdReferenceNo)})` : '';
                            // v78: an overdue placement gets its own "Resolve Maturity" button right on
                            // this subrow — previously the only way in was the workspace's maturity
                            // reminder banner, which only ever surfaces one overdue placement at a time.
                            // Reuses the same openResolveFdModal action as that banner. No
                            // stopPropagation needed: the click dispatcher resolves the nearest
                            // [data-click] ancestor via closest(), so tapping this button fires only
                            // its own action, never the parent row's openTransactionForm too — same
                            // reasoning as the subrow-toggle-btn caret above.
                            const resolveBtnHTML = isOverdue
                                ? `<button type="button" data-click="openResolveFdModal" data-id="${escapeHtml(t.id)}" style="font-size:0.66rem; font-weight:700; color:#fff; background:#b91c1c; border:none; border-radius:6px; padding:5px 8px; white-space:nowrap; cursor:pointer;">⏰ Resolve Maturity</button>`
                                : "";
                            return `
                                <div class="config-item fund-subrow" style="cursor:pointer;" data-click="openTransactionForm" data-type="${escapeHtml(t.type)}" data-id="${escapeHtml(t.id)}">
                                    <span>
                                        Fixed Deposit Placement${refText}${statusBadge}
                                        <br><span style="color:var(--text-muted); font-weight:600;">${formatBalanceHTML(t.amount, t.currency)} · Matures ${escapeHtml(t.fdMaturityDate)}</span>
                                    </span>
                                    <span style="display:flex; align-items:center; gap:6px;">
                                        ${resolveBtnHTML}
                                        <span style="color:var(--text-muted);">›</span>
                                    </span>
                                </div>`;
                        }).join("");
                    }
                }

                const isExpanded = expandedAccountSubrows.has(subrowKey);
                // Caret toggle only rendered when there's actually a subrow list to collapse —
                // stopPropagation isn't needed here since the click dispatcher resolves the
                // nearest [data-click] ancestor via closest(), so tapping the caret fires only
                // toggleAccountSubrows, not the row's own navigateToLedgerPage.
                const subrowToggleHTML = subrowsHtml
                    ? `<button type="button" class="subrow-toggle-btn" data-click="toggleAccountSubrows" data-id="${escapeHtml(subrowKey)}" aria-label="${isExpanded ? "Collapse" : "Expand"} details" title="${isExpanded ? "Collapse" : "Expand"} details">${isExpanded ? "▾" : "▸"}</button>`
                    : "";

                html += `
                    <div class="config-item account-card" style="cursor:pointer;" data-click="navigateToLedgerPage" data-id="${escapeHtml(a.id)}" data-back="accounts">
                        ${accountAvatarHTML(a.name)}
                        <div class="account-card-body">
                            <div class="account-card-toprow">
                                <span class="account-card-name">${escapeHtml(a.name)}</span>
                                <span class="account-card-balance">${balSummary}</span>
                            </div>
                            <div class="account-card-metarow" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">${typeBadge}${accountOwnerTagHTML(a)}</div>
                            ${acctRefLine}
                            ${(() => {
                                // v193: owner tags moved up into the metarow above (next to the
                                // MYR/type badge) — was buried in this subline below the account
                                // number, one glance too many to see who an account belongs to.
                                // Everything else here still stacks the same as before; each piece
                                // still carries its own leading "<br>" (needed when more than one
                                // is present, to separate them from each other), so strip only ONE
                                // leading "<br>" off the combined string — that's the one that used
                                // to separate this content from the owner tags, now unneeded since
                                // owner tags aren't the line right before it anymore. Omit the div
                                // entirely when nothing's left, so a plain account doesn't leave a
                                // dangling empty line.
                                const rest = `${linkedLine}${excludedLine}${extraInfoLine}${ccAmountDueLine}`.replace(/^<br>/, "");
                                return rest ? `<div class="account-card-subline">${rest}</div>` : "";
                            })()}
                        </div>
                        <span style="display:flex; align-items:center; gap:6px;">
                            ${ccPayBtnHTML}
                            ${subrowToggleHTML}
                            <span style="color:var(--text-muted);">›</span>
                        </span>
                    </div>`;

                if (subrowsHtml) {
                    html += `<div id="acctSubrows-${escapeHtml(subrowKey)}" class="${isExpanded ? "" : "hidden"}">${subrowsHtml}</div>`;
                }
            });
            flushSubgroupTotal();
            flushGroupTotal();
            document.getElementById("accountsPageList").innerHTML = html || (filter
                ? `<p style="color:var(--text-muted); text-align:center; padding:24px 0; font-size:0.85rem;">No ${escapeHtml(filter.label)} accounts yet.</p>`
                : `<p style="color:var(--text-muted); text-align:center; padding:24px 0; font-size:0.85rem;">No accounts yet — tap + to add one.</p>`);
        }

        // Wired to the ▸/▾ caret on an Accounts-page row that has fund/currency/FD-placement
        // subrows (v62) — toggles just that one account's subrow container + caret glyph
        // directly in the DOM rather than re-rendering the whole list, so the rest of the page
        // (scroll position, any other account's expand state) is undisturbed. `id` here is the
        // composite "<filter>__<accountId>" key (v64), not the raw account id — expand state is
        // scoped per filtered view (see subrowFilterKeyPrefix in renderAccountsPage), so the same
        // account can be independently expanded/collapsed in the unfiltered "All Accounts" list
        // vs. a sidebar-filtered view like "Unit Trust" without one affecting the other.
        function toggleAccountSubrows(el) {
            const id = el.dataset.id;
            const container = document.getElementById(`acctSubrows-${id}`);
            if (!container) return;
            const nowExpanded = container.classList.toggle("hidden") === false;
            if (nowExpanded) expandedAccountSubrows.add(id); else expandedAccountSubrows.delete(id);
            saveExpandedAccountSubrows();
            el.textContent = nowExpanded ? "▾" : "▸";
            el.setAttribute("aria-label", `${nowExpanded ? "Collapse" : "Expand"} details`);
            el.setAttribute("title", `${nowExpanded ? "Collapse" : "Expand"} details`);
        }

        // Shared by both entry points: the ✏️ icon on an account's Activity page, and (kept for
        // completeness) any future caller passing an id directly. Populates the form and opens
        // the Accounts modal in "edit" mode, showing the Delete button.
        async function editAccount(id) {
            const accounts = await readAllDB(STORES.ACCOUNTS);
            const account = accounts.find(a => a.id === id);
            if (!account) return;

            populateNewAccountCurrencySelect();

            document.getElementById("editAccountId").value = account.id;
            document.getElementById("newAccName").value = account.name;
            document.getElementById("newAccRef").value = account.accountRef || "";
            document.getElementById("newAccGroup").value = account.group || DEFAULT_ACCOUNT_GROUP;
            await handleAccGroupChange(
                account.subgroup || "",
                account.linkedAccountId || "",
                account.includeInNetWorth === false ? "no" : "yes",
                account.propertyType || "",
                account.holdingStartDate || "",
                !!account.hasRedrawFacility,
                account.redrawAmount || "",
                account.redrawAsOfDate || "",
                account.tenureType || "",
                account.leaseTermYears || "",
                account.leaseExpiryDate || ""
            );

            setAccountTypeUI(account.type || "normal");
            if (!account.type || account.type === "normal" || account.type === "creditcard") {
                document.getElementById("newAccBal").value = account.initialBalance;
                document.getElementById("newAccCurrency").value = account.currency;
            }
            if (account.type === "creditcard") {
                document.getElementById("newAccCcLimit").value = account.creditLimit || "";
                populateDaySelect(document.getElementById("newAccCcStatementDay"), account.statementDay);
                populateDaySelect(document.getElementById("newAccCcDueDay"), account.paymentDueDay);
                await populateCcPaymentAccountSelect(account.defaultPaymentAccountId || "");
            }
            renderAccountMemberCheckboxes(Array.isArray(account.memberIds) ? account.memberIds : []);

            document.getElementById("accountFormHeaderTitle").textContent = "Edit Account Credentials";
            document.getElementById("accFormSubmitBtn").textContent = "Save Changes";
            document.getElementById("accFormCancelBtn").style.display = "block";
            document.getElementById("accFormDeleteBtn").style.display = "block";

            const modal = document.getElementById("accountsModal");
            if (modal.classList.contains("active")) {
                pushVirtualState("edit_account");
            } else {
                openModal("accountsModal");
            }
        }

        // Wired to the ✏️ icon beside the account name on its Activity page — reads which
        // account is currently being viewed rather than relying on a data-id, since that page
        // is shared by several views (single account / category / type / "all").
        function editAccountFromLedgerHeader() {
            if (activeLedgerAccountView !== "all") editAccount(activeLedgerAccountView);
        }

        // Credit Card payment (v127, Tier 1 — see #ccWrap's comment in index.html for what
        // "Tier 1" means here). A card payment is modeled as nothing more than an ordinary
        // Transfer from the Default Payment Account into the card account — reusing the existing
        // Transfer entry form (rather than a separate payment data model/UI) means it
        // automatically gets correct balance math, category-free reporting, backup/restore, and
        // Quick View/Edit/Delete for free, exactly like every other transaction in the app.
        //
        // "Amount Due" is simply this account's current balance, negated and floored at 0 — NOT
        // a statement-cycle calculation. Spending on the card is logged as an ordinary Expense
        // (src = the card account), which — via the existing generic applyToAccountBalance() in
        // computeAccountBalances(), completely unmodified for this feature — already pushes the
        // card's balance negative exactly the way any account's balance goes negative from
        // overspending. So "amount owed" IS just -balance; there's deliberately no separate
        // running total to keep in sync with it. See this feature's design discussion for why
        // full statement-cycle bucketing (splitting "this cycle" vs "prior cycle, still unpaid"
        // amounts, as some banking apps show) was scoped out of this round.
        //
        // Called two ways: the Accounts/Member page's 💳 Pay button passes its own <button>
        // element (data-id = account id, read via el.dataset.id below); openCreditCardPaymentFromLedgerHeader
        // (the Activity page's own Pay button) calls this with the account id string directly,
        // same dual-signature pattern as openTransactionForm/openAttachment elsewhere in this file.
        async function openCreditCardPayment(accountIdOrEl) {
            const accountId = typeof accountIdOrEl === "string" ? accountIdOrEl : accountIdOrEl.dataset.id;
            const { accounts, nativeBalances } = await computeAccountBalances();
            const acc = accounts.find(a => a.id === accountId);
            if (!acc || acc.type !== "creditcard") return;

            await openTransactionForm("transfer", null, acc.defaultPaymentAccountId || null);
            // openTransactionForm's presetSrcAccountId param only pre-selects the SOURCE side —
            // the destination (this card) is set directly here afterward, since every other use
            // of that param presets where money comes FROM (e.g. opening the form from an
            // account's own Activity page quick-add), whereas a card payment's fixed/known side
            // is where money goes TO. Both remain fully editable — nothing here locks the fields.
            document.getElementById("destAccount").value = accountId;
            document.getElementById("txCurrency").value = acc.currency;
            const amountDue = Math.max(0, -(nativeBalances[acc.id] || 0));
            if (amountDue > 0.005) document.getElementById("txAmount").value = amountDue.toFixed(2);
            document.getElementById("txDesc").value = "Credit Card Payment";
            // v127 fix: openTransactionForm() already ran syncAccountPickerButtonText("destAccount")
            // as its very last step (see the comment there), snapshotting the "To Account" button's
            // visible label from whatever the <select> happened to hold at that moment — BEFORE the
            // destAccount.value assignment above ever runs, since that only happens after this
            // function's `await` on openTransactionForm resolves. So the underlying <select> was
            // correctly pointed at this card, but the button the user actually sees stayed stuck on
            // its earlier (wrong) label. Re-syncing it here, now that the value is actually set,
            // makes the visible "To Account" button match the card just clicked.
            syncAccountPickerButtonText("destAccount");
        }

        // Wired to the Activity page's own 💳 Pay button — reads which account is currently
        // being viewed rather than a data-id, same reasoning as editAccountFromLedgerHeader above.
        function openCreditCardPaymentFromLedgerHeader() {
            if (activeLedgerAccountView !== "all") openCreditCardPayment(activeLedgerAccountView);
        }

        // ================= UNIT TRUST: Funds subsystem (v39) =================
        // A "fund" is one holding filed under a Unit Trust account (see FUNDS store). Buy/Sell
        // transactions are ordinary Transfers between a cash account and the Unit Trust account
        // (so the account's basket balance reflects cash actually invested/withdrawn); Dividend
        // (Reinvest) and Contribution are ordinary Income transactions credited to the Unit Trust
        // account itself (mirroring how this app already treats KWSP-style dividends/employer
        // contributions as income directly on the holding account); Dividend (Cheque Payout) is
        // an ordinary Income transaction on whichever cash account the user names, since that
        // money leaves the fund entirely. Every one of these is a REAL row in STORES.TRANSACTIONS
        // (tagged with fundId + fundTxType so it can also be reconciled back to a specific fund),
        // so they automatically get year filtering, member ownership, category reporting, and
        // backup/restore for free — see saveFundTransaction() below for exactly how each type maps.
        // fund.units is the running unit balance, adjusted directly whenever a fund transaction
        // is saved or deleted; fund.currentNav is a manually-maintained price (edit the fund to
        // update it) used only for the live valuation shown in the Fund Holdings table.

        async function getFundsForAccount(accountId) {
            const all = await readAllDB(STORES.FUNDS);
            return all.filter(f => f.accountId === accountId);
        }

        // Fund's own Activity page (v48) — same idea as an account's Activity page
        // (navigateToLedgerPage), but scoped to just this one fund's transactions, so a Unit
        // Trust account holding several funds doesn't jumble all of them into one long list.
        function navigateToFundActivityPage(el) {
            const fundId = typeof el === "string" ? el : el.dataset.id;
            workspaceScrollY = window.scrollY;
            activeFundActivityId = fundId;
            // v78: rows in the Unit Trust Portfolio Report link here too — send Back to that
            // report instead of misrouting to Ledger/Accounts when that's where the tap came from.
            // v186: a member page's own fund subrow (data-back="member") gets a third explicit
            // target — needed now that the member page has fund/currency/FD subrows of its own
            // (see renderMemberPage), otherwise it fell through to the generic ledger/accounts
            // guess below and Back would strand the user on the wrong page.
            if (typeof el !== "string" && el.dataset.back === "member") {
                fundActivityBackToPage = "member";
            } else if (!document.getElementById("page-portfolio-report").classList.contains("hidden")) {
                fundActivityBackToPage = "portfolio-report";
            } else {
                fundActivityBackToPage = activeLedgerAccountView !== "all" ? "ledger" : "accounts";
            }
            showPage("page-fundactivity");
            window.scrollTo(0, 0);
            pushVirtualState("fundactivity");
            renderFundActivityPage();
        }

        async function handleFundActivityBackClick() {
            if (fundActivityBackToPage === "ledger") {
                showPage("page-ledger");
                await renderApp();
            } else if (fundActivityBackToPage === "portfolio-report") {
                showPage("page-portfolio-report");
                await renderPortfolioReportPage();
            } else if (fundActivityBackToPage === "member") {
                showPage("page-member");
                await renderMemberPage();
            } else {
                showPage("page-accounts");
                await renderAccountsPage();
            }
            window.scrollTo(0, workspaceScrollY);
        }

        function editFundFromActivityHeader() {
            if (activeFundActivityId) editFund(activeFundActivityId);
        }

        // Renders the Fund Activity page: a value banner (same style as an account's Current
        // Balance banner), the fund's own mini holding stats, and its transactions only — every
        // TRANSACTIONS row tagged with this fundId, newest first. Tapping a row opens the same
        // dedicated fund-transaction editor as everywhere else (openEditFundTxModal via
        // openTransactionForm's fundId branch).
        async function renderFundActivityPage() {
            const fundId = activeFundActivityId;
            if (!fundId) return;
            const funds = await readAllDB(STORES.FUNDS);
            const fund = funds.find(f => f.id === fundId);
            if (!fund) { handleFundActivityBackClick(); return; }

            document.getElementById("fundActivityTitle").textContent = `${fund.name} Activity`;

            const allTxs = await readAllDB(STORES.TRANSACTIONS);
            const fundTxs = allTxs.filter(t => t.fundId === fundId).sort((a, b) => new Date(b.date) - new Date(a.date));

            const value = (fund.units || 0) * (fund.currentNav || 0);
            document.getElementById("fundActivityBalanceValue").innerHTML = formatBalanceHTML(value, fund.currency);

            const ownerLabel = accountOwnerNamesText({ memberIds: fund.ownerMemberIds });
            document.getElementById("fundActivityMeta").innerHTML = `
                <span>${escapeHtml(fund.category || "")}${fund.code ? " · " + escapeHtml(fund.code) : ""}</span>
                <span style="color:var(--primary); font-weight:700;">${escapeHtml(ownerLabel)}</span>
                <span>${(fund.units || 0).toFixed(4)} units @ ${formatCurrency(fund.currentNav || 0, fund.currency)} NAV</span>
            `;

            const html = fundTxs.map(t => {
                const col = (t.fundTxType === "sell" || t.fundTxType === "dividend_payout") ? "expense-color" : "income-color";
                const sgn = (t.fundTxType === "sell" || t.fundTxType === "dividend_payout") ? "-" : "+";
                const unitsText = t.units != null ? `${t.units.toFixed(4)} units` : "";
                return `
                    <div class="ledger-item" data-click="openTransactionForm" data-type="${escapeHtml(t.type)}" data-id="${escapeHtml(t.id)}">
                        <div class="item-left">
                            <span class="item-name">${escapeHtml(fundTxTypeLabel(t.fundTxType))}</span>
                            <span class="item-meta">${escapeHtml(t.date)}${unitsText ? " · " + unitsText : ""}${t.notes ? " · " + escapeHtml(t.notes) : ""}</span>
                        </div>
                        <div class="item-right">
                            <div class="item-value" style="color:var(--${col}); font-weight:bold;">${sgn}${formatCurrency(t.amount, t.currency)}</div>
                        </div>
                    </div>`;
            }).join("");
            document.getElementById("fundActivityList").innerHTML = html || '<p style="padding:20px; text-align:center; color:var(--text-muted); font-size:0.8rem;">No transactions yet — tap + to log a Buy, Sell, or Dividend.</p>';
        }

        // Currency's own Activity page (v55) — same idea as navigateToFundActivityPage, but for
        // one currency basket within a Multi-Currency account, since that account's own Activity
        // page now only lists currency summary rows (see isMultiCurrencyAccountView above).
        function navigateToCurrencyActivityPage(el) {
            const accountId = el.dataset.id;
            const currency = el.dataset.currency;
            workspaceScrollY = window.scrollY;
            activeCurrencyActivityAccountId = accountId;
            activeCurrencyActivityCurrency = currency;
            // v186: added "member" as a third explicit target (see the matching comment on
            // navigateToFundActivityPage) now that the member page has currency subrows too.
            currencyActivityBackToPage = el.dataset.back === "accounts" ? "accounts"
                : el.dataset.back === "member" ? "member"
                : "ledger";
            showPage("page-currencyactivity");
            window.scrollTo(0, 0);
            pushVirtualState("currencyactivity");
            renderCurrencyActivityPage();
        }

        async function handleCurrencyActivityBackClick() {
            if (currencyActivityBackToPage === "accounts") {
                showPage("page-accounts");
                await renderAccountsPage();
            } else if (currencyActivityBackToPage === "member") {
                showPage("page-member");
                await renderMemberPage();
            } else {
                showPage("page-ledger");
                await renderApp();
            }
            window.scrollTo(0, workspaceScrollY);
        }

        // Renders the Currency Activity page: a native-currency balance banner (this basket's
        // running total, matching what the account row/subrow shows), and every transaction in
        // that account touching this specific currency, newest first — including the Opening
        // Balance entry that used to show directly on the account's own Activity page.
        async function renderCurrencyActivityPage() {
            const accountId = activeCurrencyActivityAccountId;
            const currency = activeCurrencyActivityCurrency;
            if (!accountId || !currency) return;

            const { accounts, txs, nativeBalances } = await computeAccountBalances();
            const account = accounts.find(a => a.id === accountId);
            if (!account) { handleCurrencyActivityBackClick(); return; }

            document.getElementById("currencyActivityTitle").textContent = `${currency} Activity`;
            document.getElementById("currencyActivityMeta").textContent = `${accountOptionLabel(account, accounts)} · ${currency}`;

            const basket = nativeBalances[accountId] || {};
            const balance = basket[currency] || 0;
            document.getElementById("currencyActivityBalanceValue").innerHTML = formatBalanceHTML(balance, currency);

            // Opening Balance entries deliberately leave src blank ("") — the funds originate
            // outside the app, not from a since-deleted account — so an empty id gets its own
            // label rather than being mistaken for a removed account record.
            const accountName = id => { if (!id) return "(Opening Balance)"; const a = accounts.find(acc => acc.id === id); return a ? escapeHtml(accountOptionLabel(a, accounts)) : "(deleted account)"; };

            const relevantTxs = txs
                .filter(t => t.currency === currency && (t.src === accountId || t.dest === accountId))
                // v91: collapse Split Expense group siblings to their representative row — see
                // getSplitGroupInfo().
                .filter(t => {
                    if (!t.splitGroupId) return true;
                    const info = getSplitGroupInfo(t, txs);
                    return !info || t.id === info.repId;
                })
                .sort((a, b) => new Date(b.date) - new Date(a.date));

            const html = relevantTxs.map(t => {
                let col, sgn;
                if (t.type === "income") { col = "income-color"; sgn = "+"; }
                else if (t.type === "expense") { col = "expense-color"; sgn = "-"; }
                else if (t.dest === accountId) { col = "income-color"; sgn = "+"; }
                else { col = "expense-color"; sgn = "-"; }

                const splitInfo = t.splitGroupId ? getSplitGroupInfo(t, txs) : null;
                const displayCat = splitInfo ? splitInfo.catLabel : (t.cat || 'Transfer');
                const displayAmount = splitInfo ? splitInfo.totalAmount : t.amount;
                const iconBadge = t.type === "transfer"
                    ? "🔄"
                    : (splitInfo ? splitInfo.members.map(m => getCategoryIcon(m.cat, t.type)).join("") : getCategoryIcon(t.cat, t.type));
                const accountText = t.type === "transfer"
                    ? `🏦 ${accountName(t.src)} → ${t.dest ? accountName(t.dest) : "(unknown)"}`
                    : `🏦 ${accountName(t.src)}`;
                const referenceText = t.fdReferenceNo ? ` · Ref: ${escapeHtml(t.fdReferenceNo)}` : '';
                const notesLine = t.notes ? `<span class="item-meta" style="display:block; margin-top:2px; color:var(--text-muted); font-style:italic;">${escapeHtml(t.notes)}</span>` : '';

                return `
                    <div class="ledger-item" data-click="openTxQuickView" data-type="${escapeHtml(t.type)}" data-id="${escapeHtml(t.id)}">
                        <div class="item-left">
                            <span class="item-name">${iconBadge} ${escapeHtml(t.desc)}</span>
                            <span class="item-meta">${escapeHtml(t.date)} [${escapeHtml(displayCat)}]${referenceText}</span>
                            <span class="item-meta" style="display:block; margin-top:2px; color:var(--text-muted);">${accountText}</span>
                            ${notesLine}
                        </div>
                        <div class="item-right">
                            <div class="item-value" style="color:var(--${col}); font-weight:bold;">${sgn}${formatCurrency(displayAmount, t.currency)}</div>
                        </div>
                    </div>`;
            }).join("");
            document.getElementById("currencyActivityList").innerHTML = html || '<p style="padding:20px; text-align:center; color:var(--text-muted); font-size:0.8rem;">No transactions yet.</p>';
        }

        // [+] on the Fund Activity page — same fundTxModal as everywhere else, but pre-set to
        // this page's fund (skipping the "add a fund first" account-wide picker since the fund
        // is already known from context).
        async function openAddFundTxModalForActiveFund() {
            const fundId = activeFundActivityId;
            if (!fundId) return;
            const funds = await readAllDB(STORES.FUNDS);
            const fund = funds.find(f => f.id === fundId);
            if (!fund) return;
            await openAddFundTxModal(fund.accountId, fundId);
        }

        // Called after any fund/fund-transaction save or delete so the Fund Activity page stays
        // current if that's what's on screen — mirrors refreshAfterAccountChange()'s pattern for
        // the Accounts page.
        async function refreshFundActivityPageIfVisible() {
            if (!document.getElementById("page-fundactivity").classList.contains("hidden")) {
                await renderFundActivityPage();
            }
        }

        // Same idea as refreshFundActivityPageIfVisible, for the Currency Activity page (a
        // Multi-Currency account's own per-currency transaction list).
        async function refreshCurrencyActivityPageIfVisible() {
            if (!document.getElementById("page-currencyactivity").classList.contains("hidden")) {
                await renderCurrencyActivityPage();
            }
        }

        // v80: general-purpose refresh for anything that can touch a Fixed Deposit placement's
        // status — saving/editing a transaction, deleting one, or resolving an FD's maturity
        // (renew/withdraw). renderApp() alone keeps the dashboard reminder banner and the
        // per-account Activity page (page-ledger, rendered inline inside renderApp) current, but
        // it does NOT re-run renderAccountsPage() — a separate function — so the Accounts page's
        // own FD placement subrows (active/due badge, amount, maturity date; added v56) kept
        // showing stale data until the user navigated away and back. Also covers the Fund/
        // Currency Activity pages for the same reason, since a transaction edit/delete can affect
        // those too. Mirrors the existing refreshAfterAccountChange() pattern used for account
        // create/edit/delete.
        async function refreshAfterTransactionChange() {
            await renderApp();
            if (!document.getElementById("page-accounts").classList.contains("hidden")) {
                await renderAccountsPage();
            }
            await refreshFundActivityPageIfVisible();
            await refreshCurrencyActivityPageIfVisible();
        }

        function openAddFundModal() {
            const accountId = activeLedgerAccountView;
            if (accountId === "all") return;
            document.getElementById("fundModalTitle").textContent = "Add Fund";
            document.getElementById("fundId").value = "";
            document.getElementById("fundAccountId").value = accountId;
            document.getElementById("fundName").value = "";
            document.getElementById("fundCode").value = "";
            document.getElementById("fundCategory").value = "Equity";
            const currSel = document.getElementById("fundCurrency");
            currSel.innerHTML = Object.keys(fxRates).map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
            currSel.value = baseCurrency;
            document.getElementById("fundNav").value = "1.0000";
            document.getElementById("fundDeleteBtn").style.display = "none";
            renderFundOwnerCheckboxes([]);
            openModal("fundModal");
        }

        async function editFund(fundId) {
            const all = await readAllDB(STORES.FUNDS);
            const fund = all.find(f => f.id === fundId);
            if (!fund) return;
            document.getElementById("fundModalTitle").textContent = "Edit Fund";
            document.getElementById("fundId").value = fund.id;
            document.getElementById("fundAccountId").value = fund.accountId;
            document.getElementById("fundName").value = fund.name;
            document.getElementById("fundCode").value = fund.code || "";
            document.getElementById("fundCategory").value = fund.category || "Equity";
            const currSel = document.getElementById("fundCurrency");
            currSel.innerHTML = Object.keys(fxRates).map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
            currSel.value = fund.currency || baseCurrency;
            document.getElementById("fundNav").value = fund.currentNav;
            document.getElementById("fundDeleteBtn").style.display = "block";
            renderFundOwnerCheckboxes(Array.isArray(fund.ownerMemberIds) ? fund.ownerMemberIds : []);
            openModal("fundModal");
        }

        function renderFundOwnerCheckboxes(selectedIds) {
            const wrap = document.getElementById("fundOwnerCheckboxes");
            wrap.innerHTML = membersCache.map(m => `
                <label class="owner-chip">
                    <input type="checkbox" class="fund-owner-checkbox" value="${escapeHtml(m.id)}" ${selectedIds.includes(m.id) ? "checked" : ""} style="accent-color:${escapeHtml(m.color)};">
                    ${escapeHtml(m.name)}
                </label>`).join("") || '<span style="font-size:0.78rem; color:var(--text-muted);">No members set up yet.</span>';
        }

        async function handleSaveFund() {
            const name = document.getElementById("fundName").value.trim();
            if (!name) { alert("Please enter a fund name."); return; }
            const nav = parseFloat(document.getElementById("fundNav").value);
            if (isNaN(nav) || nav < 0) { alert("Please enter a valid Current NAV."); return; }
            const ownerMemberIds = Array.from(document.querySelectorAll(".fund-owner-checkbox:checked")).map(cb => cb.value);

            const id = document.getElementById("fundId").value || "fund_" + Date.now();
            const record = {
                id,
                accountId: document.getElementById("fundAccountId").value,
                name,
                code: document.getElementById("fundCode").value.trim() || null,
                category: document.getElementById("fundCategory").value,
                currency: document.getElementById("fundCurrency").value,
                ownerMemberIds,
                currentNav: nav,
                units: 0
            };
            // Preserve the running unit balance when editing — this form never touches units,
            // only fund metadata + NAV.
            if (document.getElementById("fundId").value) {
                const existing = (await readAllDB(STORES.FUNDS)).find(f => f.id === id);
                record.units = existing ? (existing.units || 0) : 0;
            }
            await writeDB(STORES.FUNDS, record);
            closeModal("fundModal");
            renderApp();
            refreshFundActivityPageIfVisible();
        }

        async function handleDeleteFund() {
            const id = document.getElementById("fundId").value;
            if (!id) return;
            const ok = await customConfirm("Delete this fund? Its transaction history stays in the ledger, but will no longer be linked to a fund.");
            if (!ok) return;
            await deleteDB(STORES.FUNDS, id);
            closeModal("fundModal");
            renderApp();
            refreshFundActivityPageIfVisible();
        }

        async function openAddFundTxModal(accountIdOverride, presetFundId) {
            const accountId = accountIdOverride || activeLedgerAccountView;
            if (accountId === "all") return;
            const funds = await getFundsForAccount(accountId);
            if (funds.length === 0) { alert("Add a fund first, then log transactions against it."); return; }

            document.getElementById("fundTxAccountId").value = accountId;
            const fundSel = document.getElementById("fundTxFundId");
            fundSel.innerHTML = funds.map(f => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}${f.code ? " (" + escapeHtml(f.code) + ")" : ""}</option>`).join("");
            if (presetFundId) fundSel.value = presetFundId;

            const accounts = await readAllDB(STORES.ACCOUNTS);
            const cashAccounts = accounts.filter(a => a.id !== accountId);
            const transferSel = document.getElementById("fundTxTransferAccount");
            transferSel.innerHTML = cashAccounts.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(accountOptionLabel(a, accounts))}</option>`).join("");

            document.getElementById("fundTxModalTitle").textContent = "Add Transaction";
            document.getElementById("fundTxId").value = "";
            document.getElementById("fundTxType").value = "buy";
            document.getElementById("fundTxDate").value = todayLocalStr();
            document.getElementById("fundTxUnits").value = "";
            document.getElementById("fundTxPrice").value = "";
            document.getElementById("fundTxTotal").value = "";
            document.getElementById("fundTxNotes").value = "";
            document.getElementById("fundTxDeleteBtn").style.display = "none";
            handleFundTxTypeChange();
            openModal("fundTxModal");
        }

        // Opens the same fund-transaction form pre-filled for editing an existing Buy / Sell /
        // Dividend (Reinvest) / Dividend (Cheque Payout) / Contribution row. Tapping a fund-linked
        // row in the normal ledger list used to jump straight to a delete confirmation (v39/v40)
        // because editing amount/units in the plain Edit Transaction modal would silently desync
        // the fund's running unit balance — this dedicated editor solves that properly instead of
        // just blocking edits: handleSaveFundTx() below unwinds the old unit delta (from whichever
        // fund the entry was originally tagged to) before applying the new one.
        async function openEditFundTxModal(tx) {
            const funds = await readAllDB(STORES.FUNDS);
            const fund = funds.find(f => f.id === tx.fundId);
            if (!fund) {
                // The fund this entry was tagged to no longer exists (deleted separately) — there's
                // no account/currency/fund-list context left to build an editor around, so fall
                // back to the original delete-with-unwind flow rather than editing blind.
                await handleFundTxRowTap(tx);
                return;
            }
            const accountId = fund.accountId;
            const accountFunds = await getFundsForAccount(accountId);

            document.getElementById("fundTxModalTitle").textContent = "Edit Transaction";
            document.getElementById("fundTxId").value = tx.id;
            document.getElementById("fundTxAccountId").value = accountId;

            const fundSel = document.getElementById("fundTxFundId");
            fundSel.innerHTML = accountFunds.map(f => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}${f.code ? " (" + escapeHtml(f.code) + ")" : ""}</option>`).join("");
            fundSel.value = tx.fundId;

            const accounts = await readAllDB(STORES.ACCOUNTS);
            const cashAccounts = accounts.filter(a => a.id !== accountId);
            const transferSel = document.getElementById("fundTxTransferAccount");
            transferSel.innerHTML = cashAccounts.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(accountOptionLabel(a, accounts))}</option>`).join("");

            document.getElementById("fundTxType").value = tx.fundTxType;
            document.getElementById("fundTxDate").value = tx.date;
            document.getElementById("fundTxUnits").value = tx.units != null ? tx.units : "";
            document.getElementById("fundTxPrice").value = tx.pricePerUnit != null ? tx.pricePerUnit : "";
            document.getElementById("fundTxTotal").value = tx.amount;
            document.getElementById("fundTxNotes").value = tx.notes || "";
            handleFundTxTypeChange();

            // Pre-select which cash account this entry transferred from/to/into, based on type —
            // dividend_reinvest/contribution have no cash leg (acctRow is hidden for those).
            let transferAccountId = null;
            if (tx.fundTxType === "buy") transferAccountId = tx.src;
            else if (tx.fundTxType === "sell") transferAccountId = tx.dest;
            else if (tx.fundTxType === "dividend_payout") transferAccountId = tx.src;
            if (transferAccountId) transferSel.value = transferAccountId;

            document.getElementById("fundTxDeleteBtn").style.display = "block";
            openModal("fundTxModal");
        }

        // Units × Price → Total, kept in sync as a convenience (Total Amount is still directly
        // editable afterward — e.g. to match an exact contract-note figure with rounding).
        function recalcFundTxTotal() {
            const units = parseFloat(document.getElementById("fundTxUnits").value);
            const price = parseFloat(document.getElementById("fundTxPrice").value);
            if (!isNaN(units) && !isNaN(price)) {
                document.getElementById("fundTxTotal").value = (units * price).toFixed(2);
            }
        }

        // The reverse direction: once Units is filled in, typing straight into Total Amount
        // derives Price per Unit automatically (Total ÷ Units) — so either "Units then Price"
        // or "Units then Total" works as an entry order, matching how a real contract note is
        // usually read (sometimes it states the price, sometimes just the total consideration).
        function recalcFundTxPriceFromTotal() {
            const units = parseFloat(document.getElementById("fundTxUnits").value);
            const total = parseFloat(document.getElementById("fundTxTotal").value);
            if (!isNaN(units) && units > 0 && !isNaN(total)) {
                document.getElementById("fundTxPrice").value = (total / units).toFixed(4);
            }
        }

        // Shows/hides + relabels the Units/Price row and the transfer-Account row based on which
        // fund transaction type is selected — this is exactly the field the user's reference
        // screenshots were missing ("this card short of 'amount transfer from/to which account'").
        function handleFundTxTypeChange() {
            const type = document.getElementById("fundTxType").value;
            const unitsRow = document.getElementById("fundTxUnitsRow");
            const acctRow = document.getElementById("fundTxAccountRow");
            const acctLabel = document.getElementById("fundTxAccountLabel");

            unitsRow.style.display = (type === "dividend_payout") ? "none" : "grid";

            if (type === "buy") {
                acctRow.style.display = "flex"; acctLabel.textContent = "Account (transfer from)";
            } else if (type === "sell") {
                acctRow.style.display = "flex"; acctLabel.textContent = "Account (transfer to)";
            } else if (type === "dividend_payout") {
                acctRow.style.display = "flex"; acctLabel.textContent = "Account (cheque paid into)";
            } else {
                // dividend_reinvest / contribution — units are added straight back into the
                // fund, no cash account involved.
                acctRow.style.display = "none";
            }
        }
        function handleFundTxFundChange() { /* no-op hook, kept for symmetry with other forms */ }

        async function handleSaveFundTx() {
            const editId = document.getElementById("fundTxId").value;
            const accountId = document.getElementById("fundTxAccountId").value;
            const fundId = document.getElementById("fundTxFundId").value;
            const type = document.getElementById("fundTxType").value;
            const date = document.getElementById("fundTxDate").value;
            const units = parseFloat(document.getElementById("fundTxUnits").value) || 0;
            const price = parseFloat(document.getElementById("fundTxPrice").value) || 0;
            // Total Amount is only a real cash figure for the types that move money into/out of
            // an account (Buy/Sell/Dividend Cheque Payout) — Dividend (Reinvest) and Contribution
            // just add units straight into the fund with no cash leg, so their Total Amount is
            // optional/informational and left blank most of the time; treat a blank field as 0
            // rather than blocking the save.
            const total = parseFloat(document.getElementById("fundTxTotal").value) || 0;
            const transferAccountId = document.getElementById("fundTxTransferAccount").value;
            const notes = document.getElementById("fundTxNotes").value.trim();
            const totalAmountRequired = (type === "buy" || type === "sell" || type === "dividend_payout");

            if (!date) { alert("Please select a date."); return; }
            if (totalAmountRequired && total <= 0) { alert("Please enter a valid Total Amount."); return; }
            if (type !== "dividend_payout" && (isNaN(units) || units <= 0)) { alert("Please enter valid Units."); return; }
            if ((type === "buy" || type === "sell" || type === "dividend_payout") && !transferAccountId) {
                alert("Please choose which account this transfers from/to."); return;
            }

            const funds = await readAllDB(STORES.FUNDS);
            const fund = funds.find(f => f.id === fundId);
            if (!fund) { alert("Fund not found."); return; }

            // Editing: look up the exact original record (preserving its real id, whatever type
            // IndexedDB's autoIncrement gave it) so the save below overwrites it in place instead
            // of accidentally creating a duplicate with a re-stringified id.
            const allTxs = editId ? await readAllDB(STORES.TRANSACTIONS) : null;
            const existingTx = editId ? allTxs.find(t => String(t.id) === String(editId)) : null;

            const baseTx = {
                fundId, fundTxType: type,
                desc: `${fundTxTypeLabel(type)} — ${fund.name}`,
                amount: total, date,
                units: type === "dividend_payout" ? null : units,
                pricePerUnit: (type === "dividend_payout" || price === 0) ? null : price,
                notes: notes || null,
                currency: fund.currency,
                image: null,
                fdReferenceNo: null, fdStartDate: null, fdTenureMonths: null, fdInterestRate: null, fdMaturityDate: null
            };
            if (existingTx) baseTx.id = existingTx.id;

            let unitDelta = 0;
            if (type === "buy") {
                Object.assign(baseTx, { type: "transfer", src: transferAccountId, dest: accountId, cat: null });
                unitDelta = units;
            } else if (type === "sell") {
                Object.assign(baseTx, { type: "transfer", src: accountId, dest: transferAccountId, cat: null });
                unitDelta = -units;
            } else if (type === "dividend_reinvest") {
                Object.assign(baseTx, { type: "income", src: accountId, dest: null, cat: "Dividend Unit Trust" });
                unitDelta = units;
            } else if (type === "contribution") {
                Object.assign(baseTx, { type: "income", src: accountId, dest: null, cat: "Dividend Unit Trust" });
                unitDelta = units;
            } else if (type === "dividend_payout") {
                Object.assign(baseTx, { type: "income", src: transferAccountId, dest: null, cat: "Dividend Unit Trust" });
                unitDelta = 0;
            }

            // Editing: first unwind whatever unit effect the ORIGINAL entry had, on whichever fund
            // it was originally tagged to (may differ from the fund now selected, if the user
            // switched funds while editing) — otherwise the new delta below would just stack on
            // top of the old one and desync fund.units.
            if (existingTx) {
                let oldUnitDelta = 0;
                if (existingTx.fundTxType === "buy" || existingTx.fundTxType === "dividend_reinvest" || existingTx.fundTxType === "contribution") oldUnitDelta = -(existingTx.units || 0);
                else if (existingTx.fundTxType === "sell") oldUnitDelta = (existingTx.units || 0);

                if (oldUnitDelta !== 0) {
                    if (existingTx.fundId === fundId) {
                        // Same fund — fold the reversal into the same in-memory record the new
                        // delta is about to be applied to, so only one write happens for it below.
                        fund.units = Math.max(0, (fund.units || 0) + oldUnitDelta);
                    } else {
                        const oldFund = funds.find(f => f.id === existingTx.fundId);
                        if (oldFund) {
                            oldFund.units = Math.max(0, (oldFund.units || 0) + oldUnitDelta);
                            await writeDB(STORES.FUNDS, oldFund);
                        }
                    }
                }
            }

            await writeDB(STORES.TRANSACTIONS, baseTx);
            fund.units = Math.max(0, (fund.units || 0) + unitDelta);
            await writeDB(STORES.FUNDS, fund);

            closeModal("fundTxModal");
            renderApp();
            refreshFundActivityPageIfVisible();
        }

        // Wired to the "🗑 Delete Transaction" button inside the fund-transaction editor (only
        // visible when editing, i.e. fundTxId is populated). Same confirm-then-unwind-then-delete
        // flow as handleFundTxRowTap()'s fallback path, just triggered from inside the modal
        // instead of immediately on tapping the ledger row.
        async function handleDeleteFundTxFromModal() {
            const editId = document.getElementById("fundTxId").value;
            if (!editId) return;
            const allTxs = await readAllDB(STORES.TRANSACTIONS);
            const tx = allTxs.find(t => String(t.id) === String(editId));
            if (!tx) return;

            const ok = await customConfirm(`Delete this "${fundTxTypeLabel(tx.fundTxType)}" fund transaction? The fund's unit balance will be adjusted accordingly.`);
            if (!ok) return;

            const funds = await readAllDB(STORES.FUNDS);
            const fund = funds.find(f => f.id === tx.fundId);
            if (fund) {
                let unitDelta = 0;
                if (tx.fundTxType === "buy" || tx.fundTxType === "dividend_reinvest" || tx.fundTxType === "contribution") unitDelta = -(tx.units || 0);
                else if (tx.fundTxType === "sell") unitDelta = (tx.units || 0);
                fund.units = Math.max(0, (fund.units || 0) + unitDelta);
                await writeDB(STORES.FUNDS, fund);
            }
            await deleteTxAttachments(tx);
            await deleteDB(STORES.TRANSACTIONS, tx.id);
            closeModal("fundTxModal");
            renderApp();
            refreshFundActivityPageIfVisible();
        }

        function fundTxTypeLabel(type) {
            return {
                buy: "Buy", sell: "Sell",
                dividend_reinvest: "Dividend (Reinvest)",
                dividend_payout: "Dividend (Cheque Payout)",
                contribution: "Contribution"
            }[type] || type;
        }

        // Fallback used only when a fund-linked row's fund record no longer exists (e.g. the fund
        // itself was separately deleted, leaving this transaction "orphaned" — see the Fund
        // Holdings table's handling of orphaned rows below). With no fund/account/currency context
        // left to build a proper editor around, this offers delete-with-unwind instead: removes
        // the transaction and reverses whatever unit change it made when saved. The normal case
        // (fund still exists) goes through openEditFundTxModal() instead, which supports full
        // editing.
        async function handleFundTxRowTap(tx) {
            const ok = await customConfirm(`Delete this "${fundTxTypeLabel(tx.fundTxType)}" fund transaction? The fund's unit balance will be adjusted accordingly. To change it instead, delete then log a new one from "+ Transaction".`);
            if (!ok) return;

            const funds = await readAllDB(STORES.FUNDS);
            const fund = funds.find(f => f.id === tx.fundId);
            if (fund) {
                let unitDelta = 0;
                if (tx.fundTxType === "buy" || tx.fundTxType === "dividend_reinvest" || tx.fundTxType === "contribution") unitDelta = -(tx.units || 0);
                else if (tx.fundTxType === "sell") unitDelta = (tx.units || 0);
                fund.units = Math.max(0, (fund.units || 0) + unitDelta);
                await writeDB(STORES.FUNDS, fund);
            }
            await deleteTxAttachments(tx);
            await deleteDB(STORES.TRANSACTIONS, tx.id);
            renderApp();
        }


        // Draws the Fund Holdings table (image7-style): UNITS / NAV / VALUE / INVESTED / P/L /
        // RETURN / ANNUALISED / HOLDING per fund under this Unit Trust account, each row tagged
        // with its owner member name(s) so funds held by different family members under the same
        // account are never confused with one another.
        //
        // Tally note: every Buy/Sell/Dividend(Reinvest)/Contribution/Dividend(Payout) row is a
        // real transaction that already counts toward this account's Current Balance banner above
        // — but a fund's own units/holdings only get a row here as long as its FUNDS record still
        // exists. If a fund was deleted separately (its transaction history intentionally stays in
        // the ledger — see handleDeleteFund()'s confirm text), those transactions kept affecting
        // the account's real balance but silently dropped out of this table entirely, which is
        // exactly what made the total look like it didn't "tally" against the balance above. Those
        // now still surface as an "(fund deleted)" row below, built straight from their orphaned
        // transactions, and a Totals row ties the whole table's Value/Invested/P&L together so a
        // mismatch against the Current Balance banner is visible at a glance instead of hidden.
        async function renderFundHoldingsTable(accountId, allTxs) {
            const funds = await getFundsForAccount(accountId);
            const wrap = document.getElementById("fundHoldingsTableWrap");

            const todayMs = Date.now();

            const liveFundIds = new Set(funds.map(f => f.id));

            // Every fund record that currently exists ANYWHERE in the app, not just under this
            // account — used to tell "this fund still exists, just under a different Unit Trust
            // account" apart from "this fund was genuinely deleted". `allTxs` here is the
            // whole-app transaction list (renderApp() passes it in unfiltered), so without this
            // check every OTHER account's live fund transactions were being swept up below as
            // orphaned "fund deleted" rows belonging to THIS account too — inflating this
            // account's Fund Holdings total (and Current Balance) with every other Unit Trust
            // account's holdings, and showing each of those funds as "deleted" here even while
            // it's alive and well under its real account.
            const allFunds = await readAllDB(STORES.FUNDS);
            const fundExistsElsewhere = new Set(allFunds.filter(f => !liveFundIds.has(f.id)).map(f => f.id));

            // Groups every fund-linked transaction that actually belongs to this account by
            // fundId — used both to compute each live fund's invested-cash-basis figure, and to
            // find transactions whose fundId no longer resolves to any fund record under this
            // account (orphaned).
            const fundTxsByFundId = {};
            allTxs.forEach(t => {
                if (!t.fundId) return;
                if (liveFundIds.has(t.fundId)) {
                    // One of this account's own live funds — always relevant, regardless of tx type.
                    (fundTxsByFundId[t.fundId] = fundTxsByFundId[t.fundId] || []).push(t);
                    return;
                }
                if (fundExistsElsewhere.has(t.fundId)) return; // belongs to a different account's live fund — already shown there, not ours
                // Fund genuinely deleted everywhere — only attribute it to THIS account if the
                // transaction itself references this account. Buy/Sell/Dividend(Reinvest)/
                // Contribution all do via src/dest; Dividend (Cheque Payout) doesn't carry any
                // account link once its fund is gone, so it's left out here rather than guessed
                // at (better to drop it than misattribute it to the wrong account).
                if (t.src === accountId || t.dest === accountId) {
                    (fundTxsByFundId[t.fundId] = fundTxsByFundId[t.fundId] || []).push(t);
                }
            });

            function computeInvested(fundTxs) {
                // Total-cost-basis "Invested" = cumulative principal the owner has ever put in —
                // Buy only (cash transferred in from another account). Unlike an earlier version of
                // this function, a Sell no longer subtracts from Invested: a sale's proceeds are a
                // mix of returned cost AND realised profit, and treating the whole proceeds as "cost
                // recovered" artificially shrinks the denominator, making Return % jump on every
                // partial sell (e.g. selling units worth mostly profit could even push Invested
                // negative on a near-full sell). Sell proceeds are tracked separately as
                // `recovered` and folded into P/L instead, so Invested always reflects the true
                // amount ever contributed and Return % stays stable across partial sells.
                //
                // Dividend (Reinvest) and Contribution add units without the owner injecting new
                // cash for them (a reinvested dividend/employer contribution is a return ON the
                // existing holding, not new principal), so they're deliberately excluded here and
                // instead show up entirely as P/L — that's what makes P/L match "profit" in the
                // everyday sense a user expects (e.g. RM100 Buy + RM100 Reinvest + RM100
                // Contribution, all at NAV 1.00, should read as RM100 invested / RM200 profit, not
                // RM300 invested / RM0 profit).
                //
                // Dividend (Cheque Payout) is cash paid straight out to another account — no units
                // change, so unlike Reinvest it never shows up in `value`. It's real cash the owner
                // actually pocketed from the holding, exactly like a Sell's proceeds, so it's folded
                // into `recovered` alongside Sell rather than being silently dropped from P/L.
                let invested = 0, recovered = 0;
                fundTxs.forEach(t => {
                    if (t.fundTxType === "buy") invested += t.amount;
                    else if (t.fundTxType === "sell" || t.fundTxType === "dividend_payout") recovered += t.amount;
                });
                return { invested, recovered };
            }
            function computeHoldingYears(fundTxs) {
                const firstTxDate = fundTxs.length > 0 ? new Date(fundTxs[0].date) : null;
                return firstTxDate ? Math.max((todayMs - firstTxDate.getTime()) / (365.25 * 86400000), 0) : 0;
            }

            const rowsHtml = [];
            let totalValue = 0, totalInvested = 0, totalPl = 0, totalRecovered = 0;
            let commonCurrency = null, mixedCurrency = false;

            funds.forEach(f => {
                const fundTxs = (fundTxsByFundId[f.id] || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
                const { invested, recovered } = computeInvested(fundTxs);
                const value = (f.units || 0) * (f.currentNav || 0);
                // P/L is total return: current value PLUS everything already sold off and taken
                // out, minus the principal ever put in. This is what stops Return % from jumping
                // after a partial sell — the cash you already pocketed still counts toward P/L
                // exactly as it should, it just no longer shrinks Invested to do so.
                const pl = value + recovered - invested;
                const returnPct = invested > 0 ? (pl / invested) * 100 : 0;
                const holdingYears = computeHoldingYears(fundTxs);
                let annualised = 0;
                const growth = value + recovered;
                if (invested > 0 && growth > 0 && holdingYears >= 0.08) {
                    annualised = (Math.pow(growth / invested, 1 / holdingYears) - 1) * 100;
                }
                const ownerLabel = accountOwnerNamesText({ memberIds: f.ownerMemberIds });
                const plColor = pl >= 0 ? "var(--income-color)" : "var(--expense-color)";

                totalValue += value; totalInvested += invested; totalPl += pl; totalRecovered += recovered;
                if (commonCurrency === null) commonCurrency = f.currency; else if (commonCurrency !== f.currency) mixedCurrency = true;

                rowsHtml.push(`
                    <tr style="cursor:pointer;" data-click="navigateToFundActivityPage" data-id="${escapeHtml(f.id)}">
                        <td style="padding:8px 10px;">
                            <strong>${escapeHtml(f.name)}</strong><br>
                            <span style="font-size:0.68rem; color:var(--text-muted);">${escapeHtml(f.code || "")}</span><br>
                            <span style="font-size:0.68rem; color:var(--primary); font-weight:700;">${escapeHtml(ownerLabel)}</span>
                        </td>
                        <td style="padding:8px 10px;">${escapeHtml(f.category || "")}</td>
                        <td style="padding:8px 10px; text-align:right;">${(f.units || 0).toFixed(4)}</td>
                        <td style="padding:8px 10px; text-align:right;">${formatCurrency(f.currentNav || 0, f.currency)}</td>
                        <td style="padding:8px 10px; text-align:right;"><strong>${formatCurrency(value, f.currency)}</strong></td>
                        <td style="padding:8px 10px; text-align:right;">${formatCurrency(invested, f.currency)}</td>
                        <td style="padding:8px 10px; text-align:right; color:${plColor}; font-weight:700;">${pl >= 0 ? "+" : ""}${formatCurrency(pl, f.currency)}</td>
                        <td style="padding:8px 10px; text-align:right; color:${plColor};">${returnPct.toFixed(2)}%</td>
                        <td style="padding:8px 10px; text-align:right;">${holdingYears >= 0.08 ? annualised.toFixed(2) + "%" : "-"}</td>
                        <td style="padding:8px 10px; text-align:right;">${holdingYears >= 0.08 ? holdingYears.toFixed(1) + " yrs" : "-"}</td>
                    </tr>`);
            });

            // Orphaned rows: transactions tagged with a fundId that doesn't match any fund record
            // still under this account (the fund was deleted, or its record moved/removed some
            // other way). Grouped and shown as their own read-only row so their cash basis still
            // counts toward the Totals row below — there's no live NAV left to value them at, so
            // Value is shown at cost (= Invested, P/L "-") rather than guessed.
            const orphanFundIds = Object.keys(fundTxsByFundId).filter(fid => !liveFundIds.has(fid));
            orphanFundIds.forEach(fid => {
                const fundTxs = fundTxsByFundId[fid].slice().sort((a, b) => new Date(a.date) - new Date(b.date));
                if (fundTxs.length === 0) return;
                const { invested, recovered } = computeInvested(fundTxs);
                // Recover a display name/currency from the orphaned transactions themselves —
                // desc is saved as "<Type> — <Fund Name>" at the time it was created.
                const rawDesc = fundTxs[0].desc || "";
                const dashIdx = rawDesc.indexOf("—");
                const name = dashIdx >= 0 ? rawDesc.slice(dashIdx + 1).trim() : "(unknown fund)";
                const currency = fundTxs[0].currency || baseCurrency;
                let units = 0;
                fundTxs.forEach(t => {
                    if (t.fundTxType === "buy" || t.fundTxType === "dividend_reinvest" || t.fundTxType === "contribution") units += (t.units || 0);
                    else if (t.fundTxType === "sell") units -= (t.units || 0);
                });

                // No live NAV survives fund deletion, so there's no real "Value" to show — approximate
                // it as remaining cost basis (invested so far, minus whatever's already been sold
                // off) so the row still contributes ~0 P/L to the totals below rather than silently
                // inflating or deflating them.
                const orphanValue = Math.max(invested - recovered, 0);
                totalValue += orphanValue; totalInvested += invested; totalRecovered += recovered;
                if (commonCurrency === null) commonCurrency = currency; else if (commonCurrency !== currency) mixedCurrency = true;

                rowsHtml.push(`
                    <tr style="opacity:0.7;">
                        <td style="padding:8px 10px;">
                            <strong>${escapeHtml(name)}</strong><br>
                            <span style="font-size:0.68rem; color:var(--expense-color); font-weight:700;">⚠️ fund deleted</span>
                        </td>
                        <td style="padding:8px 10px;">-</td>
                        <td style="padding:8px 10px; text-align:right;">${units.toFixed(4)}</td>
                        <td style="padding:8px 10px; text-align:right;">-</td>
                        <td style="padding:8px 10px; text-align:right;"><strong>${formatCurrency(orphanValue, currency)}</strong></td>
                        <td style="padding:8px 10px; text-align:right;">${formatCurrency(invested, currency)}</td>
                        <td style="padding:8px 10px; text-align:right;">-</td>
                        <td style="padding:8px 10px; text-align:right;">-</td>
                        <td style="padding:8px 10px; text-align:right;">-</td>
                        <td style="padding:8px 10px; text-align:right;">-</td>
                    </tr>`);
            });

            if (rowsHtml.length === 0) {
                wrap.innerHTML = '<p style="padding:12px 4px; text-align:center; color:var(--text-muted); font-size:0.8rem;">No funds yet — tap "+ Fund" to add one.</p>';
                return;
            }

            const totalPlColor = totalPl >= 0 ? "var(--income-color)" : "var(--expense-color)";
            const totalReturnPct = totalInvested > 0 ? (totalPl / totalInvested) * 100 : 0;
            // Totals only mean much as one number when every fund shares a currency — with a
            // mixed basket, sum the figures at face value but flag it rather than implying a false
            // single-currency total.
            const totalsRow = `
                <tr style="border-top:2px solid var(--border-color); font-weight:700;">
                    <td style="padding:8px 10px;" colspan="2">Total${mixedCurrency ? ' <span style="font-weight:400; font-size:0.68rem; color:var(--text-muted);">(mixed currencies — summed at face value)</span>' : ""}</td>
                    <td style="padding:8px 10px;"></td>
                    <td style="padding:8px 10px;"></td>
                    <td style="padding:8px 10px; text-align:right;">${formatCurrency(totalValue, commonCurrency || baseCurrency)}</td>
                    <td style="padding:8px 10px; text-align:right;">${formatCurrency(totalInvested, commonCurrency || baseCurrency)}</td>
                    <td style="padding:8px 10px; text-align:right; color:${totalPlColor};">${totalPl >= 0 ? "+" : ""}${formatCurrency(totalPl, commonCurrency || baseCurrency)}</td>
                    <td style="padding:8px 10px; text-align:right; color:${totalPlColor};">${totalReturnPct.toFixed(2)}%</td>
                    <td style="padding:8px 10px;"></td>
                    <td style="padding:8px 10px;"></td>
                </tr>`;

            wrap.innerHTML = `
                <table style="width:100%; border-collapse:collapse; font-size:0.78rem; white-space:nowrap;">
                    <thead>
                        <tr style="text-align:left; color:var(--text-muted); font-size:0.68rem; text-transform:uppercase;">
                            <th style="padding:6px 10px;">Fund</th>
                            <th style="padding:6px 10px;">Category</th>
                            <th style="padding:6px 10px; text-align:right;">Units</th>
                            <th style="padding:6px 10px; text-align:right;">NAV</th>
                            <th style="padding:6px 10px; text-align:right;">Value</th>
                            <th style="padding:6px 10px; text-align:right;">Invested</th>
                            <th style="padding:6px 10px; text-align:right;">P/L</th>
                            <th style="padding:6px 10px; text-align:right;">Return</th>
                            <th style="padding:6px 10px; text-align:right;">Annualised</th>
                            <th style="padding:6px 10px; text-align:right;">Holding</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml.join("")}${totalsRow}</tbody>
                </table>`;
        }

        // --- DAILY NAV UPDATE PAGE ---
        // Formats a fund price at 4 decimal places — unlike formatCurrency() (2 d.p., meant for
        // account balances/transaction amounts), a unit trust NAV like $0.0736 loses all its
        // meaningful precision if rounded to $0.07.
        function formatNav(value, currency) {
            const sym = currencySymbols[currency] || currency || "";
            return `${sym}${(value || 0).toFixed(4)}`;
        }

        function formatNavHistoryDate(iso) {
            const d = new Date(iso + "T00:00:00");
            if (isNaN(d.getTime())) return iso;
            const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            return `${String(d.getDate()).padStart(2, "0")}-${months[d.getMonth()]}-${String(d.getFullYear()).slice(-2)}`;
        }

        // Real Estate (v66): "how long has this been held" computed from Holding Period Start
        // Date to today — e.g. "15y 10m", or just "3m" for anything under a year. Returns "" for
        // an unset/invalid/future date so callers can skip the line entirely.
        function formatHoldingPeriod(startDateStr) {
            if (!startDateStr) return "";
            const start = new Date(startDateStr + "T00:00:00");
            if (isNaN(start.getTime())) return "";
            const now = new Date();
            if (start > now) return "";
            let years = now.getFullYear() - start.getFullYear();
            let months = now.getMonth() - start.getMonth();
            if (now.getDate() < start.getDate()) months--;
            if (months < 0) { years--; months += 12; }
            return years > 0 ? `${years}y ${months}m` : `${months}m`;
        }

        // Real Estate (v131): "how long until the lease runs out" computed from Lease Expiry to
        // today — e.g. "62y 3m remaining", or "Expired" for a past date. Mirrors
        // formatHoldingPeriod above but counts down instead of up. Returns "" for an unset/invalid
        // date so callers can skip the line entirely.
        function formatYearsRemaining(expiryDateStr) {
            if (!expiryDateStr) return "";
            const expiry = new Date(expiryDateStr + "T00:00:00");
            if (isNaN(expiry.getTime())) return "";
            const now = new Date();
            if (expiry <= now) return "Expired";
            let years = expiry.getFullYear() - now.getFullYear();
            let months = expiry.getMonth() - now.getMonth();
            if (expiry.getDate() < now.getDate()) months--;
            if (months < 0) { years--; months += 12; }
            return years > 0 ? `${years}y ${months}m remaining` : `${months}m remaining`;
        }

        // Real Estate (v131): Tenure line — "**-year Leasehold · Expiry <date> · <n>y <n>m
        // remaining" or plain "Freehold". Factored out of accountExtraInfoLine so it can be
        // appended after the Type/Holding Period line (a property may have either set without
        // the other) instead of the two being mutually exclusive.
        function realEstateTenureLine(a) {
            const bits = [];
            if (a.tenureType === "Leasehold") {
                bits.push(a.leaseTermYears ? `${a.leaseTermYears}-year Leasehold` : "Leasehold");
                if (a.leaseExpiryDate) bits.push(`Expiry ${formatNavHistoryDate(a.leaseExpiryDate)}`);
                const remaining = formatYearsRemaining(a.leaseExpiryDate);
                if (remaining) bits.push(remaining);
            } else {
                bits.push("Freehold");
            }
            return `<br><span style="font-size:0.7rem; color:#9a3412; font-weight:600;">📜 ${bits.join(" · ")}</span>`;
        }

        // Real Estate (v66): Property Type + Holding Period, or Bank Loan (v66): manual Redraw
        // Facility amount — one short HTML line (or "" if nothing to show) meant to sit right
        // under an account's name wherever it's listed. Shared by the Accounts page, a member's
        // own Accounts list, and the account's own Activity page header banner so all three stay
        // in sync automatically instead of drifting out of step with separately-written markup.
        // v164: `includeRef` (default true, unchanged for existing callers) lets a caller that
        // wants to show the Account No./Ref in its own separate spot — see the Accounts-page
        // .account-card-refline below the account name — opt out of it here, so it isn't also
        // repeated in whatever this function returns for the rest of the row/banner.
        function accountExtraInfoLine(a, nativeBalances, includeRef = true) {
            const group = a.group || DEFAULT_ACCOUNT_GROUP;
            // Account No. / Ref (v130): plain informational text, independent of group/type, so
            // it's built separately here and prepended ahead of whichever type-specific line (if
            // any) applies below, rather than living inside one of those mutually-exclusive
            // branches.
            const refLine = (includeRef && a.accountRef) ? `<br><span style="font-size:0.7rem; color:var(--text-muted); font-weight:600;">${escapeHtml(a.accountRef)}</span>` : "";
            if (a.type === "creditcard" && (a.creditLimit || a.statementDay || a.paymentDueDay)) {
                const bits = [];
                if (a.creditLimit) bits.push(`Limit ${formatBalanceHTML(a.creditLimit, a.currency || baseCurrency)}`);
                if (a.statementDay) bits.push(`Statement day ${a.statementDay}`);
                if (a.paymentDueDay) bits.push(`Due day ${a.paymentDueDay}`);
                // v127: "Available" = credit limit minus whatever's currently owed (same amountDue
                // math used everywhere else on the card, i.e. this account's balance negated and
                // floored at 0). Only computable when both a limit is set AND balances were passed
                // in by the caller — accountExtraInfoLine() is also called from a couple of spots
                // that don't have nativeBalances handy (e.g. before it's been computed yet), so this
                // stays optional rather than breaking those call sites.
                if (a.creditLimit && nativeBalances) {
                    const ccAmountDueForAvail = Math.max(0, -(nativeBalances[a.id] || 0));
                    const available = Math.max(0, a.creditLimit - ccAmountDueForAvail);
                    bits.push(`Available ${formatBalanceHTML(available, a.currency || baseCurrency)}`);
                }
                return refLine + (bits.length ? `<br><span style="font-size:0.7rem; color:#9d174d; font-weight:600;">💳 ${bits.join(" · ")}</span>` : "");
            }
            if (group === "Real Estate" && (a.propertyType || a.holdingStartDate)) {
                const bits = [];
                if (a.propertyType) bits.push(escapeHtml(a.propertyType));
                const held = formatHoldingPeriod(a.holdingStartDate);
                if (held) bits.push(`Held ${held}`);
                const typeLine = bits.length ? `<br><span style="font-size:0.7rem; color:var(--income-color); font-weight:600;">🏷️ ${bits.join(" · ")}</span>` : "";
                return refLine + typeLine + realEstateTenureLine(a);
            }
            if (group === "Real Estate" && a.tenureType) {
                return refLine + realEstateTenureLine(a);
            }
            if (group === "Bank Loan" && a.hasRedrawFacility) {
                const dateStr = a.redrawAsOfDate ? ` (as of ${formatNavHistoryDate(a.redrawAsOfDate)})` : "";
                return refLine + `<br><span style="font-size:0.7rem; color:#0369a1; font-weight:600;">💰 Redraw Available: ${formatBalanceHTML(a.redrawAmount || 0, a.currency || baseCurrency)}${dateStr}</span>`;
            }
            return refLine;
        }

        let navUpdateView = "card"; // "card" | "table" | "history" — which of the 3 views is shown
        let navUpdateFundsCache = []; // funds currently held (units > 0), across every account

        // Re-fetches every currently-held fund and rebuilds all 3 views. Called once on page
        // entry and again after a successful save (so "Current: $X" and the History log both
        // reflect what was just written).
        async function renderNavUpdatePage() {
            const allFunds = await readAllDB(STORES.FUNDS);
            // "Currently holding" = a live positive unit balance — the same definition the Fund
            // Holdings table on each Unit Trust account page uses to decide a fund still has an
            // active position (a fully sold-out fund's record can still exist at 0 units).
            navUpdateFundsCache = allFunds
                .filter(f => (f.units || 0) > 0.00005)
                .sort((a, b) => a.name.localeCompare(b.name));

            const dateInput = document.getElementById("navUpdateDate");
            if (dateInput && !dateInput.value) dateInput.value = todayLocalStr();

            renderNavUpdateCardView();
            renderNavUpdateTableView();
            await renderNavUpdateHistoryView();
            applyNavUpdateViewVisibility();
        }

        function navUpdateEmptyStateHtml() {
            return '<p style="padding:24px 4px; text-align:center; color:var(--text-muted); font-size:0.85rem;">No fund holdings yet — buy units under a Unit Trust account first.</p>';
        }

        function renderNavUpdateCardView() {
            const wrap = document.getElementById("navUpdateCardView");
            if (navUpdateFundsCache.length === 0) { wrap.innerHTML = navUpdateEmptyStateHtml(); return; }
            wrap.innerHTML = `<div class="navfund-card-grid">${navUpdateFundsCache.map(f => `
                <div class="navfund-card">
                    <div class="navfund-card-name">${escapeHtml(f.name)}</div>
                    <div class="navfund-card-current">Current: ${formatNav(f.currentNav || 0, f.currency)}</div>
                    <input type="number" step="0.0001" min="0" inputmode="decimal" class="navfund-price-input"
                        id="navPriceCard_${escapeHtml(f.id)}" data-input="handleNavPriceInput" data-id="${escapeHtml(f.id)}"
                        value="${(f.currentNav || 0).toFixed(4)}">
                </div>`).join("")}</div>`;
        }

        function renderNavUpdateTableView() {
            const wrap = document.getElementById("navUpdateTableView");
            if (navUpdateFundsCache.length === 0) { wrap.innerHTML = navUpdateEmptyStateHtml(); return; }
            const rows = navUpdateFundsCache.map(f => `
                <tr>
                    <td style="padding:10px 8px;">
                        <strong>${escapeHtml(f.name)}</strong><br>
                        <span style="font-size:0.68rem; color:var(--text-muted);">${escapeHtml(f.code || "")}</span>
                    </td>
                    <td style="padding:10px 8px; text-align:right;">${formatNav(f.currentNav || 0, f.currency)}</td>
                    <td style="padding:10px 8px; text-align:right;">
                        <input type="number" step="0.0001" min="0" inputmode="decimal" style="text-align:right; width:112px; display:inline-block;"
                            id="navPriceTable_${escapeHtml(f.id)}" data-input="handleNavPriceInput" data-id="${escapeHtml(f.id)}"
                            value="${(f.currentNav || 0).toFixed(4)}">
                    </td>
                </tr>`).join("");
            wrap.innerHTML = `
                <div style="overflow-x:auto;">
                <table style="width:100%; border-collapse:collapse; font-size:0.82rem;">
                    <thead>
                        <tr style="border-bottom:2px solid var(--border-color); text-align:left;">
                            <th style="padding:8px; font-size:0.68rem; color:var(--text-muted); text-transform:uppercase;">Fund</th>
                            <th style="padding:8px; text-align:right; font-size:0.68rem; color:var(--text-muted); text-transform:uppercase;">Current NAV</th>
                            <th style="padding:8px; text-align:right; font-size:0.68rem; color:var(--text-muted); text-transform:uppercase;">New NAV</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
                </div>`;
        }

        async function renderNavUpdateHistoryView() {
            const wrap = document.getElementById("navUpdateHistoryView");
            const history = (await readAllDB(STORES.NAV_HISTORY)).sort((a, b) => new Date(a.date) - new Date(b.date));
            if (history.length === 0) {
                wrap.innerHTML = '<p style="padding:24px 4px; text-align:center; color:var(--text-muted); font-size:0.85rem;">No NAV updates recorded yet — switch to Card or Table view and tap "Update All Prices".</p>';
                return;
            }

            // Column set = every fund that has ever appeared in a saved update, in first-seen
            // order, using each fund's most-recently-recorded name/currency. This is a self-
            // contained snapshot (name/currency stored per entry, not looked up live), so a later
            // fund rename or deletion doesn't blank out or reshuffle its historical column — same
            // "keep showing it, just mark it's gone" approach as the orphaned-fund rows in the
            // Fund Holdings table above.
            const fundOrder = [];
            const fundMetaById = {};
            history.forEach(h => {
                (h.entries || []).forEach(e => {
                    if (!(e.fundId in fundMetaById)) fundOrder.push(e.fundId);
                    fundMetaById[e.fundId] = { name: e.name, currency: e.currency };
                });
            });

            const headerCells = fundOrder.map(fid => `<th style="padding:8px 10px; white-space:nowrap;">${escapeHtml((fundMetaById[fid].name || "").toUpperCase())}</th>`).join("");
            const bodyRows = history.map((h, idx) => {
                const navByFund = {};
                (h.entries || []).forEach(e => { navByFund[e.fundId] = e; });
                const cells = fundOrder.map(fid => {
                    const e = navByFund[fid];
                    return `<td style="padding:8px 10px;">${e ? formatNav(e.nav, e.currency) : "-"}</td>`;
                }).join("");
                return `<tr style="${idx % 2 === 0 ? "background:var(--chip-bg);" : ""}">
                    <td style="padding:8px 10px; color:var(--text-muted);">${idx + 1}</td>
                    <td style="padding:8px 10px; white-space:nowrap; font-weight:700;">${formatNavHistoryDate(h.date)}</td>
                    ${cells}
                </tr>`;
            }).join("");

            wrap.innerHTML = `
                <div class="report-card" style="padding:0; overflow:hidden;">
                    <div style="padding:14px 16px; font-weight:800; font-size:0.88rem; border-bottom:1.5px solid var(--border-color);">📜 Historical NAV / Unit Price Log</div>
                    <div style="overflow-x:auto;">
                    <table style="width:100%; border-collapse:collapse; font-size:0.78rem;">
                        <thead>
                            <tr style="background:var(--primary); color:#fff; text-align:left;">
                                <th style="padding:8px 10px;">No.</th>
                                <th style="padding:8px 10px;">Date</th>
                                ${headerCells}
                            </tr>
                        </thead>
                        <tbody>${bodyRows}</tbody>
                    </table>
                    </div>
                </div>`;
        }

        // Shows/hides the 3 view containers + the date row + Update All Prices button to match
        // navUpdateView, and highlights the matching toggle button. Pure visibility switch — it
        // never re-renders, so anything the user already typed into an input stays exactly as
        // typed while flipping between Card and Table.
        function applyNavUpdateViewVisibility() {
            document.querySelectorAll("#navUpdateViewToggle .nav-view-toggle-btn").forEach(b => b.classList.toggle("active", b.dataset.view === navUpdateView));
            document.getElementById("navUpdateDateRow").style.display = navUpdateView === "history" ? "none" : "";
            document.getElementById("navUpdateCardView").classList.toggle("hidden", navUpdateView !== "card");
            document.getElementById("navUpdateTableView").classList.toggle("hidden", navUpdateView !== "table");
            document.getElementById("navUpdateHistoryView").classList.toggle("hidden", navUpdateView !== "history");
            document.getElementById("navUpdateSaveBtn").style.display = navUpdateView === "history" ? "none" : "block";
        }

        function setNavUpdateView(el) {
            navUpdateView = el.dataset.view;
            applyNavUpdateViewVisibility();
        }

        // Card and Table each have their own <input> per fund (different ids) so they can be
        // shown/hidden without re-rendering — this keeps the one the user isn't looking at in
        // sync every keystroke, so switching views mid-edit never shows a stale value.
        function handleNavPriceInput(el) {
            const fundId = el.dataset.id;
            const val = el.value;
            const card = document.getElementById(`navPriceCard_${fundId}`);
            const table = document.getElementById(`navPriceTable_${fundId}`);
            if (card && card !== el) card.value = val;
            if (table && table !== el) table.value = val;
        }

        // Applies every typed price straight to its fund record (what the Fund Holdings table
        // actually reads for live valuation) and snapshots the whole batch into NAV_HISTORY under
        // the chosen date — re-saving the same date overwrites that date's row rather than adding
        // a duplicate, so correcting a mis-typed price the same day just fixes it in place.
        async function handleSaveAllNav() {
            if (navUpdateFundsCache.length === 0) return;
            const dateVal = document.getElementById("navUpdateDate").value;
            if (!dateVal) { alert("Please pick a NAV date."); return; }

            const entries = [];
            let anyChanged = false;
            for (const f of navUpdateFundsCache) {
                const input = document.getElementById(`navPriceCard_${f.id}`) || document.getElementById(`navPriceTable_${f.id}`);
                const raw = input ? parseFloat(input.value) : NaN;
                const newNav = (isNaN(raw) || raw < 0) ? (f.currentNav || 0) : raw;
                if (newNav !== (f.currentNav || 0)) anyChanged = true;
                entries.push({ fundId: f.id, name: f.name, currency: f.currency, nav: newNav });
            }

            if (!anyChanged) { alert("No prices were changed."); return; }

            for (const e of entries) {
                const fund = navUpdateFundsCache.find(f => f.id === e.fundId);
                if (!fund) continue;
                await writeDB(STORES.FUNDS, { ...fund, currentNav: e.nav });
            }
            await writeDB(STORES.NAV_HISTORY, { date: dateVal, entries });

            await renderNavUpdatePage();
            alert("Prices updated.");
        }

        // Wired to the Delete button inside the Accounts modal — only visible while editing,
        // so editAccountId is always populated when this fires.
        function deleteAccountFromForm() {
            const id = document.getElementById("editAccountId").value;
            if (id) removeAccount(id);
        }

        async function removeAccount(id) {
            const ok = await customConfirm("Delete this account? All transactions linked to it (as source or destination) will also be permanently deleted.");
            if (!ok) return;

            try {
                const allTx = await readAllDB(STORES.TRANSACTIONS);
                const linkedTx = allTx.filter(t => t.src === id || t.dest === id);
                for (const t of linkedTx) {
                    await deleteTxAttachments(t);
                    await deleteDB(STORES.TRANSACTIONS, t.id);
                }
                // Cascade-delete any Unit Trust funds filed under this account too — they're
                // meaningless without their holding account.
                const allFunds = await readAllDB(STORES.FUNDS);
                for (const f of allFunds.filter(f => f.accountId === id)) {
                    await deleteDB(STORES.FUNDS, f.id);
                }
                await deleteDB(STORES.ACCOUNTS, id);
            } catch (err) {
                alert("Could not delete account: " + (err && err.message ? err.message : err));
                return;
            }

            const wasViewingThisAccount = activeLedgerAccountView === id;
            if (wasViewingThisAccount) activeLedgerAccountView = "all";

            resetAccountForm();
            closeModal("accountsModal");

            if (wasViewingThisAccount && !document.getElementById("page-ledger").classList.contains("hidden")) {
                await navigateToAccountsPage();
            } else {
                await refreshAfterAccountChange();
            }
        }

        // --- HOUSEHOLD MEMBERS SUBSYSTEM (v34) ---
        // Members tag accounts as belonging to a person (or several people, for a joint account).
        // membersCache is refreshed after every create/edit/delete and used to draw the Sidebar's
        // "Members" section, the account form's Owner(s) checkboxes, and the Manage Members page.

        async function loadMembersCache() {
            membersCache = await readAllDB(STORES.MEMBERS);
            return membersCache;
        }

        function getMemberById(id) {
            return membersCache.find(m => m.id === id);
        }

        function memberNamesForIds(ids) {
            return ids.map(id => getMemberById(id)?.name || "Unknown").join(" + ");
        }

        // Builds the round color-swatch picker used inside the Add/Edit Member modal.
        function buildMemberColorSwatchGrid(selectedColor) {
            const grid = document.getElementById("memberColorSwatchGrid");
            grid.innerHTML = MEMBER_COLORS.map(c => `
                <span class="color-swatch${c === selectedColor ? ' selected' : ''}" style="background:${c};" data-click="selectMemberColor" data-color="${c}"></span>
            `).join("");
            document.getElementById("newMemberColor").value = selectedColor;
        }

        function selectMemberColor(el) {
            document.getElementById("newMemberColor").value = el.dataset.color;
            document.querySelectorAll("#memberColorSwatchGrid .color-swatch").forEach(s => s.classList.toggle("selected", s.dataset.color === el.dataset.color));
        }

        // --- v179: Background Theme (Setting page) -----------------------------------------
        function getSavedBgThemeId() {
            try {
                const saved = JSON.parse(localStorage.getItem(BG_THEME_STORAGE_KEY));
                return (saved && saved.id) || "default";
            } catch (e) { return "default"; }
        }

        // Applies a preset's full palette (bg/card/text/border/neu/glass/chip/data-colors + the
        // theme-color meta tag) to the live page, and — unless save is false — persists it so
        // both the next app launch and the no-flash inline snippet in <head> pick it up before
        // first paint.
        // v195: every key now falls back to THEME_DEFAULTS and is always (re)written, so
        // switching from a full preset like "midnight" back to a light preset that only ever
        // specifies bg/neuDark/themeColor correctly resets every other var it had touched,
        // instead of leaving it stuck at the previous theme's value.
        const BG_THEME_VAR_MAP = {
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
            colorScheme: "color-scheme",
        };
        function applyBgTheme(themeId, { save = true } = {}) {
            const theme = BG_THEMES.find(t => t.id === themeId) || BG_THEMES[0];
            for (const key in BG_THEME_VAR_MAP) {
                document.documentElement.style.setProperty(BG_THEME_VAR_MAP[key], theme[key] || THEME_DEFAULTS[key]);
            }
            const metaThemeColor = document.querySelector('meta[name="theme-color"]');
            if (metaThemeColor) metaThemeColor.setAttribute("content", theme.themeColor || THEME_DEFAULTS.themeColor);
            if (save) {
                try {
                    localStorage.setItem(BG_THEME_STORAGE_KEY, JSON.stringify(theme));
                    // v206: mirrors every pick into its matching Auto-side slot — light snapshot
                    // or dark id — regardless of whether Auto is on right now. That's what lets
                    // tapping any swatch, any time, set what Auto lands on next time day/night
                    // flips to that side, instead of only being settable while Auto is being
                    // turned on (see setBgThemeAutoEnabled() below, which only runs at that one
                    // moment — this runs on every single pick).
                    if (isDarkBgThemeId(theme.id)) {
                        setAutoDarkThemeId(theme.id);
                    } else {
                        localStorage.setItem(BG_THEME_LIGHT_SNAPSHOT_KEY, JSON.stringify(theme));
                    }
                } catch (e) {}
            }
            return theme;
        }

        // --- v202: Auto (follow system day/night) for Background Theme ---------------------
        // Piggybacks on the OS's own light/dark switch (prefers-color-scheme) instead of a
        // fixed clock — mirrors how the phone's own auto day/night toggle works. v206: either
        // dark preset (暗夜描边 or Slate) can be the dark side now — whichever was tapped most
        // recently — and whichever light preset was active when Auto was turned on (or last
        // manually picked while system-light) is remembered as the light side.
        function isBgThemeAutoEnabled() {
            return localStorage.getItem(BG_THEME_AUTO_KEY) === "1";
        }
        function getAutoLightThemeId() {
            return localStorage.getItem(BG_THEME_AUTO_LIGHT_KEY) || "default";
        }
        function setAutoLightThemeId(id) {
            try { localStorage.setItem(BG_THEME_AUTO_LIGHT_KEY, id); } catch (e) {}
        }
        // v206: mirrors getAutoLightThemeId()/setAutoLightThemeId() above for the dark side —
        // falls back to "midnight" (暗夜描边) if nothing's been picked yet, or if a stored value
        // somehow doesn't name a current dark preset.
        function getAutoDarkThemeId() {
            const id = localStorage.getItem(BG_THEME_AUTO_DARK_KEY);
            return isDarkBgThemeId(id) ? id : "midnight";
        }
        function setAutoDarkThemeId(id) {
            try { localStorage.setItem(BG_THEME_AUTO_DARK_KEY, id); } catch (e) {}
        }
        function systemPrefersDarkTheme() {
            return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
        }
        function resolveAutoBgThemeId() {
            return systemPrefersDarkTheme() ? getAutoDarkThemeId() : getAutoLightThemeId();
        }
        function applyAutoBgTheme() {
            applyBgTheme(resolveAutoBgThemeId());
        }
        function setBgThemeAutoEnabled(enabled) {
            try { localStorage.setItem(BG_THEME_AUTO_KEY, enabled ? "1" : "0"); } catch (e) {}
            if (enabled) {
                // Remember whatever's active right now as the matching side (light or dark) so
                // switching Auto on doesn't silently discard the user's pick.
                const currentId = getSavedBgThemeId();
                if (isDarkBgThemeId(currentId)) setAutoDarkThemeId(currentId);
                else setAutoLightThemeId(currentId);
                applyAutoBgTheme();
            }
        }

        function buildBgThemeSwatchGrid() {
            const grid = document.getElementById("bgThemeSwatchGrid");
            if (!grid) return;
            const selectedId = getSavedBgThemeId();
            grid.innerHTML = BG_THEMES.map(t => `
                <span class="bg-theme-swatch-wrap">
                    <span class="color-swatch${t.id === selectedId ? ' selected' : ''}" style="background:${t.bg};" data-click="selectBgTheme" data-theme-id="${t.id}" title="${t.name}"></span>
                    <span class="bg-theme-swatch-label">${t.name}</span>
                </span>
            `).join("");
            const autoToggle = document.getElementById("bgThemeAutoToggle");
            if (autoToggle) autoToggle.checked = isBgThemeAutoEnabled();
        }

        function selectBgTheme(el) {
            // Manually tapping a swatch is a deliberate override — turn Auto back off so it
            // doesn't immediately flip the pick back at the next day/night change.
            setBgThemeAutoEnabled(false);
            const autoToggle = document.getElementById("bgThemeAutoToggle");
            if (autoToggle) autoToggle.checked = false;
            applyBgTheme(el.dataset.themeId);
            document.querySelectorAll("#bgThemeSwatchGrid .color-swatch").forEach(s => s.classList.toggle("selected", s.dataset.themeId === el.dataset.themeId));
        }

        function handleBgThemeAutoToggleChange() {
            const autoToggle = document.getElementById("bgThemeAutoToggle");
            setBgThemeAutoEnabled(!!(autoToggle && autoToggle.checked));
            buildBgThemeSwatchGrid();
        }

        function toggleBgThemeSettings() {
            const panel = document.getElementById("bgThemeSettingsPanel");
            const isHidden = panel.style.display === "none";
            if (isHidden) buildBgThemeSwatchGrid();
            panel.style.display = isHidden ? "flex" : "none";
        }

        // v184: re-applies the saved theme the moment this script parses (this runs long before
        // bootstrap()'s async lock/DB work, since ledger.js is loaded via a plain <script src>
        // at the end of <body>, not gated on "load" or DB init). This is a deliberate SECOND
        // application on top of the "no-flash" snippet already in index.html's <head> — reported
        // symptom: on an installed PWA, after fully quitting and relaunching, the saved theme was
        // still correctly recorded (Settings > Background Theme's swatch grid showed the right
        // one selected) but the page's actual background/chrome had silently reverted to
        // default, only fixing itself once the swatch was tapped again (i.e. once applyBgTheme()
        // ran again "for real"). Whatever causes the <head> snippet to occasionally not stick in
        // that environment, this line re-runs the exact same, already-proven-correct code path a
        // second time, later in the page's life, as a safety net. save:false so it never
        // rewrites localStorage with the value it just read from it.
        // v202: if Auto (follow system) is on, resolve day/night from the OS right now instead
        // of blindly replaying the last saved snapshot — the OS's state may well have changed
        // since the app was last open, and that's the entire point of Auto.
        if (isBgThemeAutoEnabled()) {
            applyAutoBgTheme();
        } else {
            applyBgTheme(getSavedBgThemeId(), { save: false });
        }

        // v202: keeps Auto mode tracking the OS live for as long as this tab/PWA stays open,
        // not just once at launch — e.g. sunset triggering the OS's own auto dark mode while the
        // app is sitting open in the background. addListener is the pre-2020 Safari fallback for
        // browsers whose MediaQueryList doesn't support addEventListener yet.
        const bgThemeSystemQuery = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
        if (bgThemeSystemQuery) {
            const handleBgThemeSystemChange = () => {
                if (!isBgThemeAutoEnabled()) return;
                applyAutoBgTheme();
                const panel = document.getElementById("bgThemeSettingsPanel");
                if (panel && panel.style.display !== "none") buildBgThemeSwatchGrid();
            };
            if (bgThemeSystemQuery.addEventListener) bgThemeSystemQuery.addEventListener("change", handleBgThemeSystemChange);
            else if (bgThemeSystemQuery.addListener) bgThemeSystemQuery.addListener(handleBgThemeSystemChange);
        }

        function openMemberFormModal() {
            document.getElementById("editMemberId").value = "";
            document.getElementById("newMemberName").value = "";
            document.getElementById("memberFormHeaderTitle").textContent = "Add Member";
            document.getElementById("memberFormSubmitBtn").textContent = "Add Member";
            document.getElementById("memberFormDeleteBtn").style.display = "none";
            const nextColor = MEMBER_COLORS[membersCache.length % MEMBER_COLORS.length];
            buildMemberColorSwatchGrid(nextColor);
            openModal("memberModal");
        }

        async function editMember(id) {
            const member = getMemberById(id);
            if (!member) return;
            document.getElementById("editMemberId").value = member.id;
            document.getElementById("newMemberName").value = member.name;
            document.getElementById("memberFormHeaderTitle").textContent = "Edit Member";
            document.getElementById("memberFormSubmitBtn").textContent = "Save Changes";
            document.getElementById("memberFormDeleteBtn").style.display = "block";
            buildMemberColorSwatchGrid(member.color || MEMBER_COLORS[0]);
            openModal("memberModal");
        }

        async function handleCreateMemberMobile() {
            const name = document.getElementById("newMemberName").value.trim();
            if (!name) { alert("Please enter a member name."); return; }
            const color = document.getElementById("newMemberColor").value || MEMBER_COLORS[0];
            const id = document.getElementById("editMemberId").value || "mem_" + Date.now();

            try {
                await writeDB(STORES.MEMBERS, { id, name, color });
            } catch (err) {
                alert("Could not save member: " + (err && err.message ? err.message : err));
                return;
            }

            closeModal("memberModal");
            await afterMembersChanged();
        }

        function deleteMemberFromForm() {
            const id = document.getElementById("editMemberId").value;
            if (id) removeMember(id);
        }

        async function removeMember(id) {
            const ok = await customConfirm("Remove this member? Any accounts tagged to them will become unassigned (their transactions are kept).");
            if (!ok) return;

            try {
                // Strip this member from every account that referenced them, rather than deleting
                // those accounts — losing a household member shouldn't delete anyone's transactions.
                const accounts = await readAllDB(STORES.ACCOUNTS);
                for (const acc of accounts) {
                    if (Array.isArray(acc.memberIds) && acc.memberIds.includes(id)) {
                        acc.memberIds = acc.memberIds.filter(m => m !== id);
                        await writeDB(STORES.ACCOUNTS, acc);
                    }
                }
                await deleteDB(STORES.MEMBERS, id);
            } catch (err) {
                alert("Could not remove member: " + (err && err.message ? err.message : err));
                return;
            }

            closeModal("memberModal");
            await afterMembersChanged();
        }

        // Refreshes everything that depends on the member list/account ownership after any
        // member create/edit/delete: the cache itself, the sidebar, whichever page is on screen,
        // and the dashboard's per-member net worth rows.
        async function afterMembersChanged() {
            await loadMembersCache();
            renderSidebarMembers();
            renderSidebarAccountTypeShortcuts();
            if (!document.getElementById("page-members").classList.contains("hidden")) {
                await renderMembersPage();
            }
            if (!document.getElementById("page-workspace").classList.contains("hidden")) {
                await renderApp();
            }
        }

        async function renderMembersPage() {
            await loadMembersCache();
            const html = membersCache.map(m => `
                <div class="config-item" style="cursor:pointer;" data-click="editMember" data-id="${escapeHtml(m.id)}">
                    <span style="display:flex; align-items:center; gap:10px;">
                        <span class="member-color-dot" style="background:${m.color};"></span>
                        <strong>${escapeHtml(m.name)}</strong>
                    </span>
                    <span style="color:var(--text-muted);">✏️</span>
                </div>
            `).join("");
            document.getElementById("membersPageList").innerHTML = html || `<p style="color:var(--text-muted); text-align:center; padding:24px 0; font-size:0.85rem;">No members yet — tap + to add husband, wife, kids, etc.</p>`;
        }

        // Draws the checkbox list inside the Accounts modal for tagging Owner(s). Called whenever
        // the modal opens (create or edit) so it always reflects the latest member list.
        // Styled as the same rounded-pill chip group used for a fund's Owner(s) picker
        // (renderFundOwnerCheckboxes) — kept as one consistent "Owner(s)" design everywhere in
        // the app rather than two different looks for what is conceptually the same control.
        function renderAccountMemberCheckboxes(selectedIds) {
            const wrap = document.getElementById("accountMemberCheckboxes");
            const selected = selectedIds || [];
            if (membersCache.length === 0) {
                wrap.innerHTML = `<p style="font-size:0.75rem; color:var(--text-muted);">No members yet — add one via Sidebar ▸ Manage Members to tag this account.</p>`;
                return;
            }
            wrap.innerHTML = membersCache.map(m => `
                <label class="owner-chip">
                    <input type="checkbox" class="acc-member-checkbox" value="${escapeHtml(m.id)}" ${selected.includes(m.id) ? "checked" : ""} style="accent-color:${escapeHtml(m.color)};">
                    ${escapeHtml(m.name)}
                </label>
            `).join("");
        }

        function getCheckedAccountMemberIds() {
            return Array.from(document.querySelectorAll(".acc-member-checkbox:checked")).map(cb => cb.value);
        }

        // --- SIDEBAR: MEMBERS SECTION ---
        // Renders each member as its own row (colored dot + name → their solo accounts + net
        // worth), followed by one row per distinct joint-owned account group (e.g. "Husband +
        // Wife"), discovered by scanning every account's memberIds.
        async function renderSidebarMembers() {
            const wrap = document.getElementById("sidebarMembersSection");
            if (!wrap) return;
            const accounts = await readAllDB(STORES.ACCOUNTS);

            let html = "";
            membersCache.forEach(m => {
                html += `
                    <button class="sidebar-member-item" data-click="sidebarGoMember" data-key="m:${m.id}">
                        <span class="member-color-dot" style="background:${m.color};"></span>
                        <span class="member-row-name">${escapeHtml(m.name)}</span>
                    </button>
                `;
            });

            const jointGroups = {};
            accounts.forEach(a => {
                if (Array.isArray(a.memberIds) && a.memberIds.length > 1) {
                    const key = [...a.memberIds].sort().join(",");
                    jointGroups[key] = true;
                }
            });
            Object.keys(jointGroups).forEach(key => {
                const ids = key.split(",");
                html += `
                    <button class="sidebar-member-item" data-click="sidebarGoMember" data-key="j:${key}">
                        <span style="display:flex;">${ids.map(id => `<span class="member-color-dot" style="background:${getMemberById(id)?.color || '#94a3b8'}; margin-left:-4px;"></span>`).join("")}</span>
                        <span class="member-row-name">${escapeHtml(memberNamesForIds(ids))}</span>
                    </button>
                `;
            });

            wrap.innerHTML = html || `<p class="sidebar-empty-hint">No members yet.</p>`;
        }

        function sidebarGoMember(el) {
            navigateToMemberPage(el.dataset.key);
        }

        // --- SIDEBAR: "ADD <TYPE>" SHORTCUTS UNDER FINANCIAL ACCOUNTS ---
        // Flattens ACCOUNT_GROUPS + ACCOUNT_SUBGROUPS into the 7 concrete account "types" a
        // user can file something under (Bank/Cash, Credit Card, Fixed Deposit, KWSP, ASNB,
        // Unit Trust, Real Estate) — a group with sub-groups configured contributes one entry
        // per sub-group instead of the bare group.
        function accountTypeShortcutList() {
            const list = [];
            ACCOUNT_GROUPS.forEach(group => {
                const subs = subgroupsForGroup(group);
                if (subs.length === 0) {
                    list.push({ label: group, group, subgroup: "" });
                } else {
                    subs.forEach(sub => list.push({ label: sub, group, subgroup: sub }));
                }
            });
            return list;
        }

        // Renders one shortcut button per account type, but only for a type that already has
        // at least one account filed under it — keeps the sidebar from listing every possible
        // type up front and only offers shortcuts for types actually in use. Tapping one opens
        // the Accounts page filtered to just that group/sub-group (see
        // sidebarFilterAccountsByType / accountsPageTypeFilter).
        // v63: whether the sidebar's "Financial Accounts" type-shortcut list (Current Account,
        // Savings Account, ... Bank Loan) is expanded — completely separate state from
        // expandedAccountSubrows (the Accounts-page fund/currency/FD subrow toggle, v62). The two
        // toggles look similar but control unrelated parts of the UI (sidebar drawer vs. main
        // content list) and were built to stay fully independent of each other.
        let sidebarAccountShortcutsExpanded = true;

        async function renderSidebarAccountTypeShortcuts() {
            const wrap = document.getElementById("sidebarAccountTypeShortcuts");
            if (!wrap) return;
            const accounts = await readAllDB(STORES.ACCOUNTS);
            const usedTypes = accountTypeShortcutList().filter(t =>
                accounts.some(a => (a.group || DEFAULT_ACCOUNT_GROUP) === t.group && (a.subgroup || "") === t.subgroup)
            );
            const accountsPageVisible = !document.getElementById("page-accounts").classList.contains("hidden");
            wrap.innerHTML = usedTypes.map(t => {
                const isActive = accountsPageVisible && accountsPageTypeFilter
                    && accountsPageTypeFilter.group === t.group && (accountsPageTypeFilter.subgroup || "") === t.subgroup;
                return `
                    <button class="sidebar-account-type-item${isActive ? " active" : ""}" data-click="sidebarFilterAccountsByType" data-group="${escapeHtml(t.group)}" data-subgroup="${escapeHtml(t.subgroup)}" data-label="${escapeHtml(t.label)}">
                        ${escapeHtml(t.label)}
                    </button>
                `;
            }).join("");
            // wrap.innerHTML above rebuilds the list on every sidebar refresh (e.g. re-opening
            // the drawer, an active-item update) — re-apply the collapsed/expanded state each
            // time so a previous collapse doesn't get silently undone by the next render.
            wrap.classList.toggle("hidden", !sidebarAccountShortcutsExpanded);
            const toggleBtn = document.getElementById("sidebarAccountShortcutsToggle");
            if (toggleBtn) {
                // v165: was toggleBtn.textContent = "▾"/"▸" — the button now holds a static SVG
                // chevron (see index.html) rotated via this class + a CSS transition instead, so
                // collapsing/expanding animates instead of instantly swapping glyphs.
                toggleBtn.classList.toggle("collapsed", !sidebarAccountShortcutsExpanded);
                const label = `${sidebarAccountShortcutsExpanded ? "Collapse" : "Expand"} account type list`;
                toggleBtn.setAttribute("aria-label", label);
                toggleBtn.setAttribute("title", label);
                // No shortcuts to show at all (no accounts yet) — hide the toggle itself rather
                // than leaving a caret that expands/collapses an empty list.
                toggleBtn.classList.toggle("hidden", usedTypes.length === 0);
            }
        }

        // Wired to the chevron beside "Financial Accounts" in the sidebar — purely a local
        // show/hide of the type-shortcut list; does not touch accountsPageTypeFilter or navigate
        // anywhere, so it's safe to tap even while a filter from one of those shortcuts is still
        // active.
        function toggleSidebarAccountShortcuts() {
            sidebarAccountShortcutsExpanded = !sidebarAccountShortcutsExpanded;
            const wrap = document.getElementById("sidebarAccountTypeShortcuts");
            if (wrap) wrap.classList.toggle("hidden", !sidebarAccountShortcutsExpanded);
            const toggleBtn = document.getElementById("sidebarAccountShortcutsToggle");
            if (toggleBtn) {
                toggleBtn.classList.toggle("collapsed", !sidebarAccountShortcutsExpanded);
                const label = `${sidebarAccountShortcutsExpanded ? "Collapse" : "Expand"} account type list`;
                toggleBtn.setAttribute("aria-label", label);
                toggleBtn.setAttribute("title", label);
            }
        }

        // Wired to each shortcut above — opens the Accounts page filtered to just that
        // group/sub-group instead of the full list.
        function sidebarFilterAccountsByType(el) {
            // v222 fix: this same handler is now wired to both the sidebar's type shortcuts
            // (want "back to Dashboard") and the Net Worth Statement page's rows (want "back
            // to Net Worth Statement") — tell them apart by which markup called it, since both
            // share this one data-click action.
            const backTarget = el.classList.contains("statement-row") ? "networth-statement" : "workspace";
            navigateToAccountsPage({ group: el.dataset.group, subgroup: el.dataset.subgroup || "", label: el.dataset.label }, backTarget);
        }

        // --- FILTERED NET WORTH HELPERS (shared by the dashboard's per-member rows and the
        // member/joint filtered page) ---

        // Returns the subset of accounts belonging to a member (solo-owned only, i.e. memberIds
        // is exactly [id]) or a joint group (memberIds, sorted, exactly matches ids).
        function filterAccountsByOwnership(accounts, type, ids) {
            const sortedIds = [...ids].sort();
            return accounts.filter(a => {
                const owners = Array.isArray(a.memberIds) ? [...a.memberIds].sort() : [];
                if (type === "member") return owners.length === 1 && owners[0] === sortedIds[0];
                return owners.length > 1 && owners.length === sortedIds.length && owners.every((o, i) => o === sortedIds[i]);
            });
        }

        // Splits a subset of accounts into { financial, realEstate, total } (all in baseCurrency)
        // for the "Financial Assets vs Real Estate" owner report — Real Estate is whatever's
        // grouped under the "Real Estate" account group, Financial Assets is everything else
        // (Bank/Cash, Credit Card, Investment, Bank Loan, Other Assets/Liabilities, etc.), so
        // the two always add up to exactly the same Total Net Worth this app shows everywhere
        // else. Same includeInNetWorth opt-out as summarizeAccountsNetWorth, so a property
        // excluded from Net Worth is excluded here too (from both the Real Estate and Total
        // figures — it simply doesn't contribute to either side of the split).
        function summarizeOwnerAssetSplit(accountsSubset, nativeBalances) {
            let realEstate = 0, total = 0;
            accountsSubset.forEach(a => {
                if (a.includeInNetWorth === false) return;
                const val = accountBaseValue(a, nativeBalances);
                total += val;
                if ((a.group || DEFAULT_ACCOUNT_GROUP) === "Real Estate") realEstate += val;
            });
            return { financial: total - realEstate, realEstate, total };
        }

        // Splits a subset of accounts into { byCurrency: { CODE: { financial, realEstate } },
        // totalBase } for the "Net Worth by Currency" report (v132) — the currency-pivoted
        // sibling of summarizeOwnerAssetSplit just above. Each currency's financial/realEstate
        // figures are native (unconverted) amounts; totalBase is the one converted figure, used
        // only for the Grand Total row and % of Net Worth column. Same includeInNetWorth opt-out
        // and Real Estate group-based split as summarizeOwnerAssetSplit, so a currency row here
        // always reconciles against that report's Real Estate total for the same account subset.
        function summarizeCurrencySplit(accountsSubset, nativeBalances) {
            const byCurrency = {};
            let totalBase = 0;
            const bump = (curr, amt, isRealEstate) => {
                if (!byCurrency[curr]) byCurrency[curr] = { financial: 0, realEstate: 0 };
                if (isRealEstate) byCurrency[curr].realEstate += amt;
                else byCurrency[curr].financial += amt;
            };
            accountsSubset.forEach(a => {
                if (a.includeInNetWorth === false) return;
                const isRealEstate = (a.group || DEFAULT_ACCOUNT_GROUP) === "Real Estate";
                if (a.type === "multi" || a.type === "fd" || a.type === "unittrust") {
                    Object.entries(nativeBalances[a.id] || {}).forEach(([curr, amt]) => {
                        totalBase += convertCurrency(amt, curr, baseCurrency);
                        bump(curr, amt, isRealEstate);
                    });
                } else {
                    const amt = nativeBalances[a.id] || 0;
                    totalBase += convertCurrency(amt, a.currency, baseCurrency);
                    bump(a.currency, amt, isRealEstate);
                }
            });
            return { byCurrency, totalBase };
        }

        // Sums a subset of accounts into { total (in baseCurrency), currencyTotals { CODE: nativeAmt } }
        function summarizeAccountsNetWorth(accountsSubset, nativeBalances) {
            let total = 0;
            const currencyTotals = {};
            accountsSubset.forEach(a => {
                // Include in Net Worth (v53/v54) — same opt-out as the main Dashboard total
                // (currently only settable on Real Estate accounts); kept in sync here so a
                // property excluded from the headline Net Worth is excluded from every member's
                // and joint group's net worth too, not just the dashboard-wide figure.
                if (a.includeInNetWorth === false) return;
                if (a.type === "multi" || a.type === "fd" || a.type === "unittrust") {
                    Object.entries(nativeBalances[a.id] || {}).forEach(([curr, amt]) => {
                        total += convertCurrency(amt, curr, baseCurrency);
                        currencyTotals[curr] = (currencyTotals[curr] || 0) + amt;
                    });
                } else {
                    total += convertCurrency(nativeBalances[a.id] || 0, a.currency, baseCurrency);
                    currencyTotals[a.currency] = (currencyTotals[a.currency] || 0) + (nativeBalances[a.id] || 0);
                }
            });
            return { total, currencyTotals };
        }

        // v222: Net Worth Statement page — a classic personal balance-sheet layout (reached by
        // tapping the Dashboard's big Portfolio Net Worth figure). Buckets every account by its
        // existing group/sub-group (ACCOUNT_GROUPS/ACCOUNT_SUBGROUPS) into Assets / Liabilities /
        // Fixed Assets sections, respecting the same includeInNetWorth opt-out and the same
        // accountBaseValue() conversion every other net-worth figure in this app uses — so the
        // three section totals always add up to EXACTLY the Dashboard's headline number (Assets +
        // Liabilities are naturally signed: a Credit Card/Bank Loan balance is already negative,
        // "amount owed" being -balance, same convention documented on the Pay button's hint text
        // — so "Net Current Assets = Total Assets + Total Liabilities" is just addition, no
        // special-casing). A group/sub-group with nothing in it is skipped entirely rather than
        // shown as a zero row, same "don't show empty" convention the Net Savings Statement uses
        // for categories with no transactions.
        async function renderNetWorthStatementPage() {
            const { accounts, nativeBalances } = await computeAccountBalances();
            const included = accounts.filter(a => a.includeInNetWorth !== false);

            // Sums accountBaseValue() over every account matching `group` (and, if given,
            // exactly that `subgroup` — pass a list to merge a few subgroups into one row, e.g.
            // Savings + Cash below). `catchAllSubgroups`, when given, ADDITIONALLY sums any
            // account in that group whose subgroup ISN'T one of the group's known subgroups
            // (typically "" — never assigned one) — used once per section so an orphaned account
            // still counts toward that section's total even though it gets no dedicated row.
            const sumGroup = (group, subgroups = null) => included
                .filter(a => (a.group || DEFAULT_ACCOUNT_GROUP) === group && (subgroups === null || subgroups.includes(a.subgroup || "")))
                .reduce((sum, a) => sum + accountBaseValue(a, nativeBalances), 0);

            const nwsRow = (label, amount, group, subgroup = "") => {
                if (Math.abs(amount) < 0.005) return ""; // nothing here — skip the row rather than show a zero
                return `
                    <div class="statement-row" data-click="sidebarFilterAccountsByType" data-group="${escapeHtml(group)}" data-subgroup="${escapeHtml(subgroup)}" data-label="${escapeHtml(label)}">
                        <span>${escapeHtml(label)}</span>
                        <span style="font-weight:700;">${formatBalanceHTML(amount, baseCurrency)}</span>
                    </div>
                `;
            };

            // --- WHAT I HAVE ---
            const currentAcct = sumGroup("Bank/Cash", ["Current Account"]);
            // v222 note: kept as 2 separate rows rather than one merged "Savings & Cash Account"
            // line — sidebarFilterAccountsByType/navigateToAccountsPage only support an EXACT
            // single subgroup match (see the Accounts page's own filter, a few hundred lines up:
            // `(a.subgroup||"") === (filter.subgroup||"")`), so a merged row's tap-through would
            // have had no single subgroup value that actually matches both underlying subgroups —
            // it'd either show nothing or only one of the two. Two precise, correctly-tappable
            // rows beat one convenient-looking but broken one.
            const savingsAcct = sumGroup("Bank/Cash", ["Savings Account"]);
            const cashAcct = sumGroup("Bank/Cash", ["Cash Account"]);
            const otherBankTotal = sumGroup("Bank/Cash", [""]); // un-sub-grouped Bank/Cash accounts
            const foreignMoneyAcct = sumGroup("Multi-Currency");

            const fdTotal = sumGroup("Investment", ["Fixed Deposit"]);
            const kwspTotal = sumGroup("Investment", ["KWSP"]);
            const cpfTotal = sumGroup("Investment", ["CPF"]);
            const asnbTotal = sumGroup("Investment", ["ASNB"]);
            const unitTrustTotal = sumGroup("Investment", ["Unit Trust"]);
            const otherInvTotal = sumGroup("Investment", [""]); // un-sub-grouped Investment accounts

            const otherAssetsTotal = sumGroup("Other Assets");

            document.getElementById("nwsAssetsRows").innerHTML = [
                nwsRow("Current Account", currentAcct, "Bank/Cash", "Current Account"),
                nwsRow("Savings Account", savingsAcct, "Bank/Cash", "Savings Account"),
                nwsRow("Cash Account", cashAcct, "Bank/Cash", "Cash Account"),
                nwsRow("Other Bank/Cash", otherBankTotal, "Bank/Cash", ""),
                nwsRow("Foreign Money Account", foreignMoneyAcct, "Multi-Currency"),
                nwsRow("Fixed Deposit", fdTotal, "Investment", "Fixed Deposit"),
                nwsRow("KWSP", kwspTotal, "Investment", "KWSP"),
                nwsRow("CPF", cpfTotal, "Investment", "CPF"),
                nwsRow("ASNB", asnbTotal, "Investment", "ASNB"),
                nwsRow("Unit Trust", unitTrustTotal, "Investment", "Unit Trust"),
                nwsRow("Other Investment", otherInvTotal, "Investment", ""),
                nwsRow("Other Assets", otherAssetsTotal, "Other Assets"),
            ].join("") || `<p style="font-size:0.75rem; color:var(--text-muted);">No asset accounts yet.</p>`;
            const totalAssets = currentAcct + savingsAcct + cashAcct + otherBankTotal + foreignMoneyAcct + fdTotal + kwspTotal + cpfTotal + asnbTotal + unitTrustTotal + otherInvTotal + otherAssetsTotal;
            document.getElementById("nwsAssetsTotal").innerHTML = formatBalanceHTML(totalAssets, baseCurrency);

            // --- WHAT I OWE ---
            const bankLoanTotal = sumGroup("Bank Loan");
            const creditCardTotal = sumGroup("Credit Card");
            const otherLiabTotal = sumGroup("Other Liabilities");

            document.getElementById("nwsLiabilitiesRows").innerHTML = [
                nwsRow("Bank Loan", bankLoanTotal, "Bank Loan"),
                nwsRow("Credit Card", creditCardTotal, "Credit Card"),
                nwsRow("Other Liabilities", otherLiabTotal, "Other Liabilities"),
            ].join("") || `<p style="font-size:0.75rem; color:var(--text-muted);">No liabilities logged — nothing owed.</p>`;
            const totalLiabilities = bankLoanTotal + creditCardTotal + otherLiabTotal; // already negative (or 0) — see the function-level comment
            document.getElementById("nwsLiabilitiesTotal").innerHTML = formatBalanceHTML(totalLiabilities, baseCurrency);

            const netCurrentAssets = totalAssets + totalLiabilities;
            document.getElementById("nwsNetCurrentValue").innerHTML = formatBalanceHTML(netCurrentAssets, baseCurrency);

            // --- FIXED ASSETS (Real Estate) ---
            const realEstateTotal = sumGroup("Real Estate");
            const hasRealEstate = included.some(a => (a.group || DEFAULT_ACCOUNT_GROUP) === "Real Estate");
            document.getElementById("nwsFixedAssetsCard").classList.toggle("hidden", !hasRealEstate);
            document.getElementById("nwsFixedAssetsRows").innerHTML = nwsRow("Real Estate", realEstateTotal, "Real Estate");
            document.getElementById("nwsFixedAssetsTotal").innerHTML = formatBalanceHTML(realEstateTotal, baseCurrency);

            document.getElementById("nwsFinalNetWorth").innerHTML = formatBalanceHTML(netCurrentAssets + realEstateTotal, baseCurrency);
        }

        // Flips the "Net Worth by Member" section between expanded/collapsed and persists the
        // choice — purely a display preference, the underlying totals are unaffected.
        async function toggleMemberNetWorthCollapse() {
            memberNetWorthCollapsed = !memberNetWorthCollapsed;
            await writeDB(STORES.SETTINGS, { key: "memberNetWorthCollapsed", value: memberNetWorthCollapsed });
            applyMemberNetWorthCollapseState();
        }

        // Applies the current collapse state to the DOM without a full re-render — swaps the
        // rows container's visibility and the ▾/▸ toggle icon. Safe to call even before the rows
        // themselves have been populated yet.
        function applyMemberNetWorthCollapseState() {
            const wrap = document.getElementById("memberNetWorthRows");
            const toggleBtn = document.getElementById("memberNetWorthCollapseToggle");
            if (wrap) wrap.style.display = memberNetWorthCollapsed ? "none" : "";
            if (toggleBtn) toggleBtn.textContent = memberNetWorthCollapsed ? "▸" : "▾";
        }

        // Draws the dashboard's "Net Worth by Member" report: one row per member (solo-owned
        // accounts only), one row per distinct joint-owned account group, and — only if any exist
        // — a final "Unassigned" row so the breakdown always ties out to the grand total above it.
        function renderMemberNetWorthRows(accounts, nativeBalances) {
            const section = document.getElementById("memberNetWorthSection");
            // With only 0 or 1 members configured, this breakdown is either empty or a pointless
            // re-statement of the "Portfolio Net Worth" figure already shown above it — hide the
            // whole section (header + collapse toggle + rows) rather than show a single row that
            // just repeats the grand total. Re-appears automatically the moment a second member
            // is added, since this re-renders on every dashboard load via afterMembersChanged().
            if (section) section.classList.toggle("hidden", membersCache.length <= 1);
            if (membersCache.length <= 1) return;

            const wrap = document.getElementById("memberNetWorthRows");
            if (!wrap) return;
            applyMemberNetWorthCollapseState();

            let html = "";
            membersCache.forEach(m => {
                const subset = filterAccountsByOwnership(accounts, "member", [m.id]);
                const { total } = summarizeAccountsNetWorth(subset, nativeBalances);
                html += `
                    <div class="member-networth-row" data-click="sidebarGoMember" data-key="m:${m.id}">
                        <div class="member-row-left">
                            <span class="member-color-dot" style="background:${m.color};"></span>
                            <div>
                                <div class="member-row-name">${escapeHtml(m.name)}</div>
                                <div class="member-row-sub">${subset.length} account${subset.length === 1 ? '' : 's'}</div>
                            </div>
                        </div>
                        <span class="member-row-amt">${formatBalanceHTML(total, baseCurrency)}</span>
                    </div>
                `;
            });

            const jointGroups = {};
            accounts.forEach(a => {
                if (Array.isArray(a.memberIds) && a.memberIds.length > 1) {
                    jointGroups[[...a.memberIds].sort().join(",")] = true;
                }
            });
            Object.keys(jointGroups).forEach(key => {
                const ids = key.split(",");
                const subset = filterAccountsByOwnership(accounts, "joint", ids);
                const { total } = summarizeAccountsNetWorth(subset, nativeBalances);
                html += `
                    <div class="member-networth-row" data-click="sidebarGoMember" data-key="j:${key}">
                        <div class="member-row-left">
                            <span style="display:flex;">${ids.map(id => `<span class="member-color-dot" style="background:${getMemberById(id)?.color || '#94a3b8'}; margin-left:-4px;"></span>`).join("")}</span>
                            <div>
                                <div class="member-row-name">${escapeHtml(memberNamesForIds(ids))} (Joint)</div>
                                <div class="member-row-sub">${subset.length} account${subset.length === 1 ? '' : 's'}</div>
                            </div>
                        </div>
                        <span class="member-row-amt">${formatBalanceHTML(total, baseCurrency)}</span>
                    </div>
                `;
            });

            const unassigned = accounts.filter(a => !Array.isArray(a.memberIds) || a.memberIds.length === 0);
            if (unassigned.length > 0) {
                const { total } = summarizeAccountsNetWorth(unassigned, nativeBalances);
                html += `
                    <div class="member-networth-row" style="cursor:default;">
                        <div class="member-row-left">
                            <span class="member-color-dot" style="background:#cbd5e1;"></span>
                            <div>
                                <div class="member-row-name">Unassigned</div>
                                <div class="member-row-sub">${unassigned.length} account${unassigned.length === 1 ? '' : 's'} — tap an account to assign an owner</div>
                            </div>
                        </div>
                        <span class="member-row-amt">${formatBalanceHTML(total, baseCurrency)}</span>
                    </div>
                `;
            }

            wrap.innerHTML = html;
        }

        // Renders page-member: the filtered net worth card (with an optional per-currency
        // breakdown reveal) plus the list of accounts owned by that member/joint group.
        async function renderMemberPage() {
            if (!activeMemberFilter) return;
            const { type, ids } = activeMemberFilter;
            const { accounts, txs, nativeBalances } = await computeAccountBalances();
            const subset = filterAccountsByOwnership(accounts, type, ids);
            const { total, currencyTotals } = summarizeAccountsNetWorth(subset, nativeBalances);
            // v186: same fund/FD-placement subrow data the global Accounts page builds (see
            // renderAccountsPage) — needed here now that this page's cards match that page's
            // card style/arrangement (accountAvatarHTML, group headers, subrows) instead of the
            // older plain-list format.
            const allFunds = await readAllDB(STORES.FUNDS);
            const fundsByAccountId = {};
            allFunds.forEach(f => { (fundsByAccountId[f.accountId] = fundsByAccountId[f.accountId] || []).push(f); });
            const fdPlacementsByAccountId = {};
            txs.filter(t => t.type === "transfer" && t.fdMaturityDate && !t.fdResolved && t.dest).forEach(t => {
                (fdPlacementsByAccountId[t.dest] = fdPlacementsByAccountId[t.dest] || []).push(t);
            });
            // Subrow expand/collapse state (v64 pattern) is scoped per view — this page's own
            // prefix so it can never collide with the global Accounts page's "all"/filter-based
            // keys for the same account id.
            const subrowFilterKeyPrefix = `member_${type}_${ids.join("-")}`.replace(/\s+/g, "-");

            const titleEl = document.getElementById("memberPageTitle");
            if (type === "member") {
                const m = getMemberById(ids[0]);
                titleEl.innerHTML = `<span class="member-color-dot" style="background:${m?.color || '#94a3b8'};"></span> ${escapeHtml(m?.name || "Member")}`;
            } else {
                titleEl.innerHTML = `${ids.map(id => `<span class="member-color-dot" style="background:${getMemberById(id)?.color || '#94a3b8'};"></span>`).join("")} ${escapeHtml(memberNamesForIds(ids))} (Joint)`;
            }

            document.getElementById("memberPageNetWorthDisplay").innerHTML = formatBalanceHTML(total, baseCurrency);

            const currencyCount = Object.keys(currencyTotals).length;
            const card = document.getElementById("memberPageNetWorthCard");
            const hint = document.getElementById("memberPageCurrencyHint");
            card.classList.toggle("no-toggle", currencyCount <= 1);
            hint.style.display = currencyCount > 1 ? "block" : "none";
            document.getElementById("memberPageCurrencyRow").style.display = "none";
            document.getElementById("memberPageCurrencyRow").innerHTML = Object.entries(currencyTotals)
                .sort((a, b) => b[1] - a[1])
                .map(([curr, amt]) => `
                    <div class="currency-total-chip">
                        <div class="cur-code" style="color:${currencyBadgeColor(curr).fg};">${escapeHtml(curr)}</div>
                        <div class="cur-amt">${formatBalanceHTML(amt, curr)}</div>
                    </div>
                `).join("");

            // v186: card markup/grouping below mirrors renderAccountsPage's "account-card" style
            // exactly (avatar chip, top row name+balance, meta-row type badge, ref line, subline,
            // group/sub-group section headers + sub-totals, collapsible fund/currency/FD subrows)
            // so a member's own Accounts view matches the global Accounts page's arrangement —
            // this page had been left on an older plain-row format. Per the standing "duplicated
            // list renderers" lesson, this is a second hand-written copy of that same block, not
            // a shared component — any future layout change to one needs the same check against
            // the other.
            let html = "";
            let lastGroup = null;
            let lastSubgroup = undefined;
            let groupTotal = 0, subgroupTotal = 0;

            function flushSubgroupTotal() {
                if (lastSubgroup) {
                    html += `<div class="config-list-subtotal"><span class="total-label">Sub-Total · ${escapeHtml(lastSubgroup)}</span>: <span class="total-amount">${formatBalanceHTML(subgroupTotal, baseCurrency)}</span></div>`;
                }
                subgroupTotal = 0;
            }
            function flushGroupTotal() {
                if (lastGroup !== null) {
                    html += `<div class="config-list-grouptotal"><span class="total-label">Group Total · ${escapeHtml(lastGroup)}</span>: <span class="total-amount">${formatBalanceHTML(groupTotal, baseCurrency)}</span></div>`;
                }
                groupTotal = 0;
            }

            sortAccountsByGroupThenName(subset).forEach(a => {
                const subrowKey = `${subrowFilterKeyPrefix}__${a.id}`;
                const group = a.group || DEFAULT_ACCOUNT_GROUP;
                const subgroup = a.subgroup || "";
                if (group !== lastGroup) {
                    flushSubgroupTotal();
                    flushGroupTotal();
                    html += `<div class="config-list-section-label">${accountGroupBadgeHTML(group)}</div>`;
                    lastGroup = group;
                    lastSubgroup = undefined;
                }
                if (subgroup !== lastSubgroup) {
                    flushSubgroupTotal();
                    if (subgroup) {
                        html += `<div class="config-list-subgroup-label">↳ ${escapeHtml(subgroup)}</div>`;
                    }
                    lastSubgroup = subgroup;
                }

                const typeBadge = a.type === "fd"
                    ? `<span style="font-size:0.65rem; padding:1px 4px; border-radius:4px; background:#ede9fe; color:#6d28d9; font-weight:bold;">Fixed Deposit</span>`
                    : a.type === "multi"
                        ? `<span style="font-size:0.65rem; padding:1px 4px; border-radius:4px; background:#e0f2fe; color:#0369a1; font-weight:bold;">Multi-Currency</span>`
                        : a.type === "unittrust"
                            ? `<span style="font-size:0.65rem; padding:1px 4px; border-radius:4px; background:#fef3c7; color:#92400e; font-weight:bold;">Unit Trust</span>`
                            : a.type === "creditcard"
                                ? `<span style="font-size:0.65rem; padding:1px 4px; border-radius:4px; background:#fce7f3; color:#9d174d; font-weight:bold;">Credit Card</span>`
                                : currencyBadgeHTML(a.currency);

                const baseVal = accountBaseValue(a, nativeBalances);

                let balSummary;
                if (a.type === "multi") {
                    balSummary = `≈ ${formatBalanceHTML(baseVal, baseCurrency)}`;
                } else if (a.type === "fd" || a.type === "unittrust") {
                    const baskets = nativeBalances[a.id];
                    const currencies = Object.keys(baskets);
                    balSummary = currencies.length === 0
                        ? '<span style="color:var(--text-muted);">No funds yet</span>'
                        : currencies.map(curr => formatBalanceHTML(baskets[curr], curr)).join(" + ");
                } else {
                    balSummary = formatBalanceHTML(nativeBalances[a.id], a.currency);
                }

                groupTotal += baseVal;
                subgroupTotal += baseVal;

                const linkedAcc = a.linkedAccountId ? accounts.find(x => x.id === a.linkedAccountId) : null;
                const linkedLine = linkedAcc
                    ? `<br><span style="font-size:0.7rem; color:#92400e; font-weight:600;">🔗 Related: ${escapeHtml(accountOptionLabel(linkedAcc, accounts))}</span>`
                    : "";

                // Real Estate (v53): same "excluded from Net Worth" flag renderAccountsPage()
                // already shows on the global Accounts page.
                const excludedLine = a.includeInNetWorth === false
                    ? `<br><span style="font-size:0.7rem; color:#991b1b; font-weight:600;">🚫 Excluded from Net Worth</span>`
                    : "";

                const acctRefLine = a.accountRef
                    ? `<div class="account-card-refline">${escapeHtml(a.accountRef)}</div>`
                    : "";
                const extraInfoLine = accountExtraInfoLine(a, nativeBalances, false);

                // Credit Card (v127): same "Amount due" line + 💳 Pay button as the main Accounts
                // page (renderAccountsPage) — see that copy's comment for what amountDue means.
                const ccAmountDue = a.type === "creditcard" ? Math.max(0, -(nativeBalances[a.id] || 0)) : 0;
                const ccAmountDueLine = ccAmountDue > 0.005
                    ? `<br><span style="font-size:0.72rem; color:#9d174d; font-weight:700;">💳 Amount due: ${formatBalanceHTML(ccAmountDue, a.currency)}</span>`
                    : "";
                const ccPayBtnHTML = ccAmountDue > 0.005
                    ? `<button type="button" data-click="openCreditCardPayment" data-id="${escapeHtml(a.id)}" style="font-size:0.66rem; font-weight:700; color:#fff; background:#db2777; border:none; border-radius:6px; padding:5px 8px; white-space:nowrap; cursor:pointer;">💳 Pay</button>`
                    : "";

                let subrowsHtml = "";

                if (a.type === "multi") {
                    const baskets = nativeBalances[a.id] || {};
                    const currencies = Object.keys(baskets).sort();
                    if (currencies.length > 0) {
                        subrowsHtml += currencies.map(curr => {
                            const subText = curr !== baseCurrency
                                ? `<span class="converted-subtext">≈ ${formatCurrency(convertCurrency(baskets[curr], curr, baseCurrency), baseCurrency)}</span>`
                                : "";
                            return `
                            <div class="config-item fund-subrow" style="cursor:pointer;" data-click="navigateToCurrencyActivityPage" data-id="${escapeHtml(a.id)}" data-currency="${escapeHtml(curr)}" data-back="member">
                                <span>${escapeHtml(curr)} <span style="color:var(--text-muted); font-weight:600;">— ${formatBalanceHTML(baskets[curr], curr)}</span>${subText}</span>
                                <span style="color:var(--text-muted);">›</span>
                            </div>`;
                        }).join("");
                    }
                }

                if (a.type === "unittrust") {
                    const funds = (fundsByAccountId[a.id] || []).slice().sort((x, y) => x.name.localeCompare(y.name));
                    if (funds.length > 0) {
                        subrowsHtml += funds.map(f => {
                            const value = (f.units || 0) * (f.currentNav || 0);
                            return `
                                <div class="config-item fund-subrow" style="cursor:pointer;" data-click="navigateToFundActivityPage" data-id="${escapeHtml(f.id)}" data-back="member">
                                    <span>${escapeHtml(f.name)} <span style="color:var(--text-muted); font-weight:600;">— ${formatBalanceHTML(value, f.currency)}</span></span>
                                    <span style="color:var(--text-muted);">›</span>
                                </div>`;
                        }).join("");
                    }
                }

                if (a.type === "fd") {
                    const placements = (fdPlacementsByAccountId[a.id] || []).slice().sort((x, y) => new Date(y.date) - new Date(x.date));
                    if (placements.length > 0) {
                        subrowsHtml += placements.map(t => {
                            const isOverdue = new Date(t.fdMaturityDate + "T00:00:00").getTime() < new Date(todayLocalStr() + "T00:00:00").getTime();
                            const statusBadge = isOverdue
                                ? `<span style="font-size:0.62rem; font-weight:700; color:#b91c1c; background:#fee2e2; padding:1px 5px; border-radius:4px; margin-left:6px; white-space:nowrap;">⏰ Due</span>`
                                : `<span style="font-size:0.62rem; font-weight:700; color:#15803d; background:#dcfce7; padding:1px 5px; border-radius:4px; margin-left:6px; white-space:nowrap;">🟢 Active</span>`;
                            const refText = t.fdReferenceNo ? ` (${escapeHtml(t.fdReferenceNo)})` : '';
                            const resolveBtnHTML = isOverdue
                                ? `<button type="button" data-click="openResolveFdModal" data-id="${escapeHtml(t.id)}" style="font-size:0.66rem; font-weight:700; color:#fff; background:#b91c1c; border:none; border-radius:6px; padding:5px 8px; white-space:nowrap; cursor:pointer;">⏰ Resolve Maturity</button>`
                                : "";
                            return `
                                <div class="config-item fund-subrow" style="cursor:pointer;" data-click="openTransactionForm" data-type="${escapeHtml(t.type)}" data-id="${escapeHtml(t.id)}">
                                    <span>
                                        Fixed Deposit Placement${refText}${statusBadge}
                                        <br><span style="color:var(--text-muted); font-weight:600;">${formatBalanceHTML(t.amount, t.currency)} · Matures ${escapeHtml(t.fdMaturityDate)}</span>
                                    </span>
                                    <span style="display:flex; align-items:center; gap:6px;">
                                        ${resolveBtnHTML}
                                        <span style="color:var(--text-muted);">›</span>
                                    </span>
                                </div>`;
                        }).join("");
                    }
                }

                const isExpanded = expandedAccountSubrows.has(subrowKey);
                const subrowToggleHTML = subrowsHtml
                    ? `<button type="button" class="subrow-toggle-btn" data-click="toggleAccountSubrows" data-id="${escapeHtml(subrowKey)}" aria-label="${isExpanded ? "Collapse" : "Expand"} details" title="${isExpanded ? "Collapse" : "Expand"} details">${isExpanded ? "▾" : "▸"}</button>`
                    : "";

                html += `
                    <div class="config-item account-card" style="cursor:pointer;" data-click="navigateToLedgerPage" data-id="${escapeHtml(a.id)}" data-back="member">
                        ${accountAvatarHTML(a.name)}
                        <div class="account-card-body">
                            <div class="account-card-toprow">
                                <span class="account-card-name">${escapeHtml(a.name)}</span>
                                <span class="account-card-balance">${balSummary}</span>
                            </div>
                            <div class="account-card-metarow" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">${typeBadge}${accountOwnerTagHTML(a)}</div>
                            ${acctRefLine}
                            ${(() => {
                                // v193: see the matching comment on the Accounts-page copy of this
                                // card (renderAccountsPage) — same owner-tags-moved-up change here.
                                const rest = `${linkedLine}${excludedLine}${extraInfoLine}${ccAmountDueLine}`.replace(/^<br>/, "");
                                return rest ? `<div class="account-card-subline">${rest}</div>` : "";
                            })()}
                        </div>
                        <span style="display:flex; align-items:center; gap:6px;">
                            ${ccPayBtnHTML}
                            ${subrowToggleHTML}
                            <span style="color:var(--text-muted);">›</span>
                        </span>
                    </div>`;

                if (subrowsHtml) {
                    html += `<div id="acctSubrows-${escapeHtml(subrowKey)}" class="${isExpanded ? "" : "hidden"}">${subrowsHtml}</div>`;
                }
            });
            flushSubgroupTotal();
            flushGroupTotal();
            document.getElementById("memberPageAccountsList").innerHTML = html || `<p style="color:var(--text-muted); text-align:center; padding:24px 0; font-size:0.85rem;">No accounts tagged to this member yet.</p>`;
        }

        // Wired to the "+" button on a member's Accounts page — opens the Add Account modal
        // fresh, pre-checking the member(s) currently being viewed as the new account's owner(s)
        // so the account is tagged correctly without extra taps.
        function openAddAccountForMember() {
            if (!activeMemberFilter) return;
            resetAccountForm();
            renderAccountMemberCheckboxes(activeMemberFilter.ids);
            openModal("accountsModal");
        }

        function toggleMemberPageCurrencyBreakdown() {
            const row = document.getElementById("memberPageCurrencyRow");
            if (document.getElementById("memberPageCurrencyHint").style.display === "none") return; // only 1 currency — nothing to reveal
            row.style.display = row.style.display === "none" ? "flex" : "none";
        }

        // --- CATEGORIES SYSTEM WORKSPACE DESIGNER ---
        // Opens the Categories modal in "add" mode — used by the "+" FAB on the Categories page.
        function openCategoryFormModal() {
            document.getElementById("categoriesModalTitle").textContent = "Add Category";
            document.getElementById("catSubmitBtn").textContent = "Register Category Badge";
            document.getElementById("catEditId").value = "";
            document.getElementById("catLabelName").value = "";
            document.getElementById("catTypeSelect").value = "expense";
            document.getElementById("catTypeSelect").disabled = false;
            document.getElementById("catSelectedEmoji").value = "🍔";
            document.getElementById("currentSelectedEmojiBadge").textContent = "🍔";
            document.getElementById("catExcludeFromSavings").checked = false;
            buildEmojiSelectionPanel();
            populateCategoryParentSelect();
            document.getElementById("catParentSelect").value = "";
            openModal("categoriesModal");
        }

        // v101: opens the same modal pre-filled to edit an existing category (rename, change
        // icon/type, move it under a different Main Category, or promote/demote it). Previously
        // the Categories page only offered exclude-toggle + delete — this is the first way to
        // actually rename a category or change its parent after creation.
        function editCategory(id) {
            const cat = dynamicCategories.find(c => c.id === id);
            if (!cat) return;

            document.getElementById("categoriesModalTitle").textContent = "Edit Category";
            document.getElementById("catSubmitBtn").textContent = "Save Changes";
            document.getElementById("catEditId").value = cat.id;
            document.getElementById("catLabelName").value = cat.name;
            document.getElementById("catTypeSelect").value = cat.type;
            document.getElementById("catExcludeFromSavings").checked = !!cat.excludeFromSavings;

            buildEmojiSelectionPanel();
            selectCategoryEmoji(cat.icon, [...document.querySelectorAll(".emoji-btn")].find(b => b.textContent === cat.icon) || document.querySelector(".emoji-btn"));

            // A category that already has its own Subcategories must stay a Main Category —
            // nesting it under another one would create a 3rd level, which this app doesn't
            // support (every dropdown/report only understands Main → Subcategory, one level).
            const hasChildren = dynamicCategories.some(c => c.parentId === cat.id);
            document.getElementById("catTypeSelect").disabled = hasChildren;
            document.getElementById("catParentRow").style.display = hasChildren ? "none" : "block";
            document.getElementById("catParentLockedNote").style.display = hasChildren ? "block" : "none";
            if (!hasChildren) {
                populateCategoryParentSelect(cat.id);
                document.getElementById("catParentSelect").value = cat.parentId || "";
            }

            openModal("categoriesModal");
        }

        // Fills the "Parent Category" select with every Main Category (parentId == null) of the
        // currently-selected Fin. Type, excluding `excludeId` itself when editing. Called on open,
        // and again whenever Fin. Type changes, since Income and Expense Main Categories don't mix.
        function populateCategoryParentSelect(excludeId) {
            const sel = document.getElementById("catParentSelect");
            if (!sel) return;
            const type = document.getElementById("catTypeSelect").value;
            const mains = dynamicCategories.filter(c => !c.parentId && c.type === type && c.id !== excludeId);
            sel.innerHTML = `<option value="">— None (Main Category) —</option>` +
                mains.map(c => `<option value="${escapeHtml(c.id)}">${c.icon} ${escapeHtml(c.name)}</option>`).join("");
        }

        // Fills the Default Income/Expense Category dropdowns with the same merged
        // (custom + starter) category lists used by the transaction form, plus a leading
        // "(None)" option, and selects whatever is currently saved as the default.
        function populateDefaultCategorySelects() {
            const incomeFallback = ["Salary", "Investments", "Freelance", "Other Income"];
            const expenseFallback = ["Groceries", "Dining Out", "Utilities", "Rent", "Commute", "Entertainment", "Other Expenses"];

            const incomeNames = [...new Set([...dynamicCategories.filter(c => c.type === "income").map(c => c.name), ...incomeFallback])];
            const expenseNames = [...new Set([...dynamicCategories.filter(c => c.type === "expense").map(c => c.name), ...expenseFallback])];

            const incSelect = document.getElementById("defaultIncomeCategorySelect");
            const expSelect = document.getElementById("defaultExpenseCategorySelect");

            incSelect.innerHTML = `<option value="">(None)</option>` + buildCategoryOptionsHTML("income", incomeNames);
            expSelect.innerHTML = `<option value="">(None)</option>` + buildCategoryOptionsHTML("expense", expenseNames);

            incSelect.value = incomeNames.includes(defaultIncomeCategory) ? defaultIncomeCategory : "";
            expSelect.value = expenseNames.includes(defaultExpenseCategory) ? defaultExpenseCategory : "";
            syncAccountPickerButtonText("defaultIncomeCategorySelect");
            syncAccountPickerButtonText("defaultExpenseCategorySelect");
        }

        async function saveDefaultCategories() {
            defaultIncomeCategory = document.getElementById("defaultIncomeCategorySelect").value;
            defaultExpenseCategory = document.getElementById("defaultExpenseCategorySelect").value;
            await writeDB(STORES.SETTINGS, { key: "defaultIncomeCategory", value: defaultIncomeCategory });
            await writeDB(STORES.SETTINGS, { key: "defaultExpenseCategory", value: defaultExpenseCategory });
        }

        function buildEmojiSelectionPanel() {
            const container = document.getElementById("emojiPickerPanel");
            container.innerHTML = "";
            
            Object.keys(emojiDirectory).forEach(groupName => {
                const title = document.createElement("div");
                title.className = "emoji-section-title";
                title.textContent = groupName;
                container.appendChild(title);

                const grid = document.createElement("div");
                grid.className = "emoji-grid";

                emojiDirectory[groupName].forEach(emoji => {
                    const btn = document.createElement("button");
                    btn.type = "button";
                    btn.className = "emoji-btn";
                    btn.textContent = emoji;
                    if(emoji === "🍔") btn.classList.add("selected");
                    btn.onclick = (e) => {
                        e.preventDefault();
                        selectCategoryEmoji(emoji, btn);
                    };
                    grid.appendChild(btn);
                });

                container.appendChild(grid);
            });
        }

        function selectCategoryEmoji(emoji, element) {
            document.querySelectorAll(".emoji-btn").forEach(b => b.classList.remove("selected"));
            element.classList.add("selected");
            document.getElementById("catSelectedEmoji").value = emoji;
            document.getElementById("currentSelectedEmojiBadge").textContent = emoji;
        }

        // Mobile Safe handler that overrides form submissions for zero keyboard delays.
        // v101: now also handles Edit (catEditId set by editCategory()) and reads the optional
        // Parent Category select to save/update parentId.
        async function handleCreateCategoryMobile() {
            const rawName = document.getElementById("catLabelName").value.trim();
            if(!rawName) {
                alert("Please enter a category name first!");
                return;
            }

            const name = rawName.charAt(0).toUpperCase() + rawName.slice(1);
            const type = document.getElementById("catTypeSelect").value;
            const icon = document.getElementById("catSelectedEmoji").value;

            if (name.toLowerCase() === "other income" || name.toLowerCase() === "other expenses") {
                alert("The keyword '" + name + "' is protected.");
                return;
            }

            const editId = document.getElementById("catEditId").value;
            const hasChildren = editId ? dynamicCategories.some(c => c.parentId === editId) : false;
            const parentId = hasChildren ? null : (document.getElementById("catParentSelect").value || null);

            if (parentId === editId) {
                alert("A category can't be its own parent.");
                return;
            }

            const categoryId = editId || ("cat_" + Date.now());
            const excludeFromSavings = document.getElementById("catExcludeFromSavings").checked;
            try {
                await writeDB(STORES.CATEGORIES, { id: categoryId, name, type, icon, excludeFromSavings, parentId });
            } catch (err) {
                alert("Could not save category: " + (err && err.message ? err.message : err));
                return;
            }

            document.getElementById("catLabelName").value = "";
            document.getElementById("catExcludeFromSavings").checked = false;
            document.getElementById("catEditId").value = "";

            await syncAndLoadCategories();
            await refreshAfterCategoryChange();
            closeModal("categoriesModal");
        }

        // Refreshes the dashboard (renderApp, for category dropdowns elsewhere) and, if the full
        // Categories page happens to be the one on screen, its income/spending lists too.
        async function refreshAfterCategoryChange() {
            await renderApp();
            if (!document.getElementById("page-categories").classList.contains("hidden")) {
                await renderCategoriesPage();
            }
        }

        // Renders the full "Categories" page: Default Category selectors up top, then every
        // category split into Income / Spending sections (dynamicCategories already includes
        // both custom and starter categories — see ensureDefaultCategories).
        // v101: categories now form a 2-level tree (Main Category → Subcategories, via parentId)
        // — each type's list is rendered as Main Categories in order, with their Subcategories
        // indented directly beneath, followed by any remaining Main Categories that have none.
        async function renderCategoriesPage() {
            populateDefaultCategorySelects();

            // v72: the 📊 toggle flips excludeFromSavings in place — solid + labeled when a
            // category is currently excluded, dim when it counts normally in the report.
            // v101: added the ✏️ edit button (rename / re-icon / move under a different Main
            // Category) and an `indent` flag for Subcategory rows.
            const rowHtml = (c, indent) => `
                <div class="config-item" style="${indent ? 'padding-left:22px; border-left:2px solid var(--border-color); margin-left:6px;' : ''}">
                    <span class="category-display-badge">
                        ${indent ? '<span style="color:var(--text-muted);">↳</span> ' : ''}<span>${c.icon}</span> <strong>${escapeHtml(c.name)}</strong>
                        ${c.excludeFromSavings ? '<span style="font-size:0.65rem; color:#92400e; font-weight:700; margin-left:6px;">🚫 Not in Report</span>' : ''}
                    </span>
                    <div style="display:flex; align-items:center;">
                        <button class="trash-btn" data-click="editCategory" data-id="${escapeHtml(c.id)}" title="Edit category">✏️</button>
                        <button class="trash-btn" data-click="toggleCategoryExcludeFromSavings" data-id="${escapeHtml(c.id)}" title="${c.excludeFromSavings ? 'Included in Net Savings Report' : 'Excluded from Net Savings Report'}" style="opacity:${c.excludeFromSavings ? '1' : '0.3'};">📊</button>
                        <button class="trash-btn" data-click="removeCategory" data-id="${escapeHtml(c.id)}">🗑</button>
                    </div>
                </div>`;

            const buildTreeHtml = type => {
                const all = dynamicCategories.filter(c => c.type === type);
                const mains = all.filter(c => !c.parentId);
                let html = "";
                mains.forEach(main => {
                    html += rowHtml(main, false);
                    all.filter(c => c.parentId === main.id).forEach(sub => { html += rowHtml(sub, true); });
                });
                // Safety net: a Subcategory whose parent record was since deleted/renamed away
                // (see removeCategory's orphan handling — this shouldn't normally happen, but
                // covers any stale parentId from older data) still gets shown, un-indented,
                // rather than silently vanishing from the page.
                all.filter(c => c.parentId && !mains.some(m => m.id === c.parentId)).forEach(orphan => { html += rowHtml(orphan, false); });
                return html;
            };

            document.getElementById("categoriesPageIncomeList").innerHTML = buildTreeHtml("income")
                || `<p style="color:var(--text-muted); padding:8px 0; font-size:0.85rem;">No income categories yet.</p>`;
            document.getElementById("categoriesPageExpenseList").innerHTML = buildTreeHtml("expense")
                || `<p style="color:var(--text-muted); padding:8px 0; font-size:0.85rem;">No expense categories yet.</p>`;
        }

        // v72: flips whether transactions in this category are counted in the Net Savings Report's
        // Surplus/Deficit or tallied separately as "Excluded from Report" (see renderSavingsStatement).
        async function toggleCategoryExcludeFromSavings(id) {
            const cat = dynamicCategories.find(c => c.id === id);
            if (!cat) return;
            const updated = { ...cat, excludeFromSavings: !cat.excludeFromSavings };
            try {
                await writeDB(STORES.CATEGORIES, updated);
            } catch (err) {
                alert("Could not update category: " + (err && err.message ? err.message : err));
                return;
            }
            await syncAndLoadCategories();
            await refreshAfterCategoryChange();
        }

        async function removeCategory(id) {
            const children = dynamicCategories.filter(c => c.parentId === id);
            const msg = children.length
                ? `Remove this Main Category? Its ${children.length} Subcategor${children.length === 1 ? "y" : "ies"} will become Main Categories on their own, not be deleted. Your transactions assigned to it will fallback to standard default icons.`
                : "Remove this custom category? Your transactions assigned to it will fallback to standard default icons.";
            const ok = await customConfirm(msg);
            if (!ok) return;

            try {
                // v101: promote any Subcategories to Main Category (parentId: null) rather than
                // deleting them too — losing a whole branch of subcategories (and every
                // transaction's assignment to them) just because the parent was removed would be
                // far more destructive than what deleting a single flat category used to do.
                for (const child of children) {
                    await writeDB(STORES.CATEGORIES, { ...child, parentId: null });
                }
                await deleteDB(STORES.CATEGORIES, id);
            } catch (err) {
                alert("Could not remove category: " + (err && err.message ? err.message : err));
                return;
            }
            await syncAndLoadCategories();
            await refreshAfterCategoryChange();
        }

        async function syncAndLoadCategories() {
            const customCats = await readAllDB(STORES.CATEGORIES);
            // Sorted alphabetically by name so every consumer (transaction form dropdown,
            // Categories manager list, income/expense report lists) lists categories in a
            // predictable order without each call site needing to sort separately. Income
            // and expense categories are filtered by type at each use site, so this single
            // alphabetical sort keeps both lists sorted within their own type.
            dynamicCategories = customCats.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
        }

        // Idempotent: inserts any DEFAULT_CATEGORIES entry not already present
        // (matched case-insensitively by name), so re-running on every launch is safe
        // and never overwrites a category the user has renamed or customised.
        async function ensureDefaultCategories() {
            const existing = await readAllDB(STORES.CATEGORIES);

            // One-time migration: v19 seeded a category named "Beting" (typo) — rename it
            // to "Betting" in place rather than adding a new one, so v19 users don't end
            // up with both. Only touches the record if it still has the auto-seeded id,
            // never a category the user has since renamed away from "Beting".
            const legacyBeting = existing.find(c => c.id === "cat_beting");
            if (legacyBeting && legacyBeting.name.toLowerCase() === "beting") {
                legacyBeting.name = "Betting";
                await writeDB(STORES.CATEGORIES, legacyBeting);
            }

            // One-time migration: v101 briefly seeded a category named "Renting Expenses" —
            // renamed to "Rental Expenses" per user request. Only touches the record if it still
            // has the auto-seeded id, never a category the user has since renamed away from
            // "Renting Expenses". Existing transactions filed under the old name are updated too
            // (mirrors migrateOthersCategoryRename()'s approach below), so nothing shows up as an
            // orphaned "Renting Expenses" string in reports.
            const legacyRentingExpenses = existing.find(c => c.id === "cat_renting_expenses");
            if (legacyRentingExpenses && legacyRentingExpenses.name.toLowerCase() === "renting expenses") {
                legacyRentingExpenses.name = "Rental Expenses";
                await writeDB(STORES.CATEGORIES, legacyRentingExpenses);
                const txs = await readAllDB(STORES.TRANSACTIONS);
                for (const t of txs) {
                    if (t.cat === "Renting Expenses") {
                        t.cat = "Rental Expenses";
                        await writeDB(STORES.TRANSACTIONS, t);
                    }
                }
            }

            const slugify = s => "cat_" + s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

            // Matched by EITHER current name OR the deterministic id a DEFAULT_CATEGORIES entry
            // would have been seeded with (slugify(c.name)) — not name alone. Name-only matching
            // meant renaming a seeded category away from its original DEFAULT_CATEGORIES name
            // (e.g. "Rental Income" → "Rental Income -Warehouse") made it look "missing" on the
            // very next launch, silently recreating a duplicate under the old name — exactly the
            // kind of unwanted resurrection the id-based "legacyBeting"/"legacyRentingExpenses"
            // migrations above were already special-cased to prevent, just for those two specific
            // renames. Checking the seeded id generalizes that protection to every
            // DEFAULT_CATEGORIES entry, present or future, without needing a new one-time
            // migration each time a user renames one.
            const existingIds = new Set(existing.map(c => c.id));
            const existingNames = new Set(existing.map(c => c.name.toLowerCase().trim()));
            const missing = DEFAULT_CATEGORIES.filter(c => !existingNames.has(c.name.toLowerCase()) && !existingIds.has(slugify(c.name)));

            // v101: two passes so a Subcategory's `parent` name (see DEFAULT_CATEGORIES comment)
            // can always be resolved to an id — Main Categories first (any entry with no `parent`,
            // or whose parent is itself missing this run for some reason), then Subcategories,
            // which look their parent up by name (case-insensitive) among everything that exists
            // by that point — either already in the DB, or just inserted in the first pass.
            for (const c of missing.filter(c => !c.parent)) {
                await writeDB(STORES.CATEGORIES, { id: slugify(c.name), name: c.name, type: c.type, icon: c.icon, parentId: null });
            }
            const afterMains = await readAllDB(STORES.CATEGORIES);
            for (const c of missing.filter(c => c.parent)) {
                const parentRec = afterMains.find(p => p.name.toLowerCase() === c.parent.toLowerCase());
                await writeDB(STORES.CATEGORIES, { id: slugify(c.name), name: c.name, type: c.type, icon: c.icon, parentId: parentRec ? parentRec.id : null });
            }
            await syncAndLoadCategories();
            await migrateOthersCategoryRename();
            await migrateFdInterestIncomeRename();
            await migrateStaleDestFieldCleanup();
            await migrateStaleCategoryOnTransfersCleanup();
            await migrateAccountGroupRename();
        }

        // One-time migration: "Others" (the implicit income/expense fallback category — never a
        // real stored Categories record, just a literal string on transactions) was renamed to
        // "Other Income" / "Other Expenses" per type. Existing transactions whose cat is still the
        // literal string "Others" are updated in place to the type-appropriate new name, so old
        // data lines up with the new dropdown options/labels instead of becoming an orphaned
        // unmatched category string. Only touches transactions with the exact legacy value —
        // never anything the user has since re-categorised.
        async function migrateOthersCategoryRename() {
            const txs = await readAllDB(STORES.TRANSACTIONS);
            for (const t of txs) {
                if (t.cat === "Others" && (t.type === "income" || t.type === "expense")) {
                    t.cat = t.type === "income" ? "Other Income" : "Other Expenses";
                    await writeDB(STORES.TRANSACTIONS, t);
                }
            }
        }

        // One-time migration: FD Interest Received transactions were previously saved under the
        // literal category "Interest Income" — a name that was never actually added to
        // DEFAULT_CATEGORIES, so it showed up in reports (Net Savings Statement, breakdowns) as
        // an orphaned category invisible in Manage Categories. Renamed to "FD Interest Income"
        // (now a real, manageable category) both here going forward and on existing records, so
        // old and new FD interest entries land under the same category instead of splitting into
        // two. Only touches the exact legacy value — never a category the user has since
        // re-categorised away from it.
        async function migrateFdInterestIncomeRename() {
            const txs = await readAllDB(STORES.TRANSACTIONS);
            for (const t of txs) {
                if (t.cat === "Interest Income") {
                    t.cat = "FD Interest Income";
                    await writeDB(STORES.TRANSACTIONS, t);
                }
            }
        }

        // One-time cleanup for a fixed bug: the "To Account" <select> used to keep whatever value
        // it last held from an earlier Transfer entry even after being hidden for Income/Expense,
        // so some already-saved Income/Expense records may carry a leftover `dest` pointing at an
        // unrelated account. That stray `dest` made the record wrongly show up in that other
        // account's ledger too (the per-account view matches on src OR dest). Only `dest` is
        // cleared — the record's real account (`src`), amount, category, etc. are untouched.
        async function migrateStaleDestFieldCleanup() {
            const txs = await readAllDB(STORES.TRANSACTIONS);
            for (const t of txs) {
                if (t.type !== "transfer" && t.dest) {
                    t.dest = null;
                    await writeDB(STORES.TRANSACTIONS, t);
                }
            }
        }

        // One-time cleanup for another fixed bug: the Category <select> used to always get
        // populated with the expense category list — including for Transfers, which have no
        // category and hide that field entirely. A freshly-populated <select> auto-selects its
        // first option, so every Transfer created through the standard entry form silently got
        // saved with whatever expense category sorted alphabetically first ("Commute") as its
        // `cat`, invisible in the form but shown on the ledger as e.g. "[Commute]" next to a
        // transfer. Nulls out `cat` on any already-saved Transfer that has one — EXCEPT "Fixed
        // Deposit", which the separate FD maturity-resolution flow (handleResolveFdSubmit) sets
        // deliberately on its own transfer-type records (withdrawals/renewals) and writes directly
        // to the DB, bypassing this bug entirely — those are left untouched.
        async function migrateStaleCategoryOnTransfersCleanup() {
            const txs = await readAllDB(STORES.TRANSACTIONS);
            for (const t of txs) {
                if (t.type === "transfer" && t.cat && t.cat !== "Fixed Deposit") {
                    t.cat = null;
                    await writeDB(STORES.TRANSACTIONS, t);
                }
            }
        }

        // One-time migration (v156): "Account Payable" and "Account Receivable" were removed
        // from ACCOUNT_GROUPS — they're trade-specific accounting terms (money owed for goods/
        // services bought or sold on credit), and some accounts had been filed under them for
        // things like refundable deposits held/paid, which aren't trade debts. Any account still
        // saved under either old group is remapped to its "Other" equivalent: Account Payable
        // (money you owe) → Other Liabilities, Account Receivable (money owed to you) → Other
        // Assets — same direction, just under the correct general-purpose group name. Only
        // touches accounts with the exact legacy group value — never one the user has since
        // changed away from it.
        async function migrateAccountGroupRename() {
            const accs = await readAllDB(STORES.ACCOUNTS);
            for (const a of accs) {
                if (a.group === "Account Payable") {
                    a.group = "Other Liabilities";
                    await writeDB(STORES.ACCOUNTS, a);
                } else if (a.group === "Account Receivable") {
                    a.group = "Other Assets";
                    await writeDB(STORES.ACCOUNTS, a);
                }
            }
        }

        // --- TRANSACTION CREATION / EDITOR CORE ---
        async function openTransactionForm(type, existingTxId = null, presetSrcAccountId = null) {
            const accounts = await readAllDB(STORES.ACCOUNTS);
            if(accounts.length === 0) { alert("Add an account first!"); return; }

            // v88: every open of this form starts from a clean slate for the Refund/Split/Category-
            // lock state a prior Quick View action (Refund, Duplicate) may have left behind — a form
            // opened normally (the "+" buttons, editing a row) must never silently inherit those.
            pendingRefundOf = null;
            document.getElementById("txCategory").disabled = false;
            // v142: txCategory's own disabled state (Refund flow locks it, see
            // openRefundFromOptions()) doesn't do anything on its own anymore now that picking a
            // category goes through the txCategoryBtn button+picker modal rather than the <select>
            // directly — the button needs its own disabled reset here too, or a category locked by
            // a previous Refund would stay un-tappable-but-also-un-lockable-looking on the next
            // normal open.
            const catBtn = document.getElementById("txCategoryBtn");
            catBtn.disabled = false;
            catBtn.style.opacity = "";
            resetTxSplitRows();

            const srcSelect = document.getElementById("srcAccount"); srcSelect.innerHTML = "";
            const destSelect = document.getElementById("destAccount"); destSelect.innerHTML = "";
            const currSelect = document.getElementById("txCurrency"); currSelect.innerHTML = "";
            const catSelect = document.getElementById("txCategory"); catSelect.innerHTML = "";

            // v84: currency options previously listed in Object.keys(fxRates) insertion order
            // (whatever order currencies were first added to Currency Settings in — not
            // alphabetical, and unrelated to which one is the Base currency), and nothing
            // afterward selected a default for a brand-new entry, so the browser just defaulted
            // to whichever currency happened to land first in that order (e.g. USD) instead of
            // the account holder's actual Base currency (MYR). Sorted alphabetically for a
            // predictable list, and the "Account / To Account" dropdowns are sorted by
            // group-then-name (matching the Accounts page, via the shared
            // sortAccountsByGroupThenName()) instead of raw IndexedDB read order.
            Object.keys(fxRates).sort((a, b) => a.localeCompare(b)).forEach(c => { currSelect.innerHTML += `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`; });
            const sortedAccountsForTxForm = sortAccountsByGroupThenName(accounts);
            sortedAccountsForTxForm.forEach(a => {
                const prefix = a.type === "fd" ? "🏦 " : a.type === "multi" ? "💱 " : a.type === "unittrust" ? "📊 " : a.type === "creditcard" ? "💳 " : "";
                const currLabel = (a.type === "multi" || a.type === "fd" || a.type === "unittrust") ? "" : ` (${escapeHtml(a.currency)})`;
                // v68: owner alone can still leave two accounts looking identical (e.g. two
                // "HSBC Loan" accounts under the same family member) — accountRelatedSuffix
                // tacks on the Related Account too, when one's set, so this list stays
                // unambiguous even for that case.
                const ownerLabel = ` — ${escapeHtml(accountOwnerNamesText(a) + accountRelatedSuffix(a, accounts))}`;
                srcSelect.innerHTML += `<option value="${escapeHtml(a.id)}">${prefix}${escapeHtml(a.name)}${currLabel}${ownerLabel}</option>`;
                destSelect.innerHTML += `<option value="${escapeHtml(a.id)}">${prefix}${escapeHtml(a.name)}${currLabel}${ownerLabel}</option>`;
            });
            if (existingTxId === null && fxRates[baseCurrency] !== undefined) {
                currSelect.value = baseCurrency;
            }


            if (existingTxId !== null) {
                const txs = await readAllDB(STORES.TRANSACTIONS);
                const tx = txs.find(t => t.id === existingTxId);
                if (!tx) return;
                // Fund transactions (Buy/Sell/Dividend/Contribution) keep a linked fund's unit
                // balance in sync, so they can't go through the normal Edit Transaction modal
                // below — tapping one instead opens the dedicated fund-transaction editor, which
                // knows how to unwind the old unit delta and apply the new one correctly.
                if (tx.fundId) {
                    await openEditFundTxModal(tx);
                    return;
                }

                document.getElementById("txId").value = tx.id;
                document.getElementById("txType").value = tx.type;
                document.getElementById("txDesc").value = tx.desc;
                document.getElementById("txAmount").value = tx.amount;
                document.getElementById("txCurrency").value = tx.currency;
                document.getElementById("srcAccount").value = tx.src;
                document.getElementById("destAccount").value = tx.dest || "";
                document.getElementById("txDate").value = tx.date;
                document.getElementById("txNotes").value = tx.notes || "";
                document.getElementById("txChecked").checked = !!tx.checked;
                // Split Expenses is a new-entry-only affordance (see the comment on #txSplitWrap in
                // index.html) — an existing record, split or not, is always edited as the single row
                // it already is.
                document.getElementById("txSplitWrap").style.display = "none";

                document.getElementById("txManualFxToggle").checked = !!tx.manualFxRate;
                document.getElementById("txManualFxRate").value = tx.manualFxRate || "";
                document.getElementById("txManualFxRateRow").style.display = tx.manualFxRate ? "block" : "none";
                await updateTxManualFxVisibility();
                recalcTxManualFxPreview();

                // Transfer conversion (v33, redesigned v34): destAmount is the ground truth
                // stored value — both fields are shown together, so editing just pre-fills each
                // from what was saved (the rate is re-derived for display).
                document.getElementById("txTransferFxToggle").checked = tx.destAmount != null;
                document.getElementById("txTransferDestAmount").value = tx.destAmount != null ? tx.destAmount : "";
                document.getElementById("txTransferRate").value = (tx.destAmount != null && tx.amount) ? (tx.destAmount / tx.amount).toFixed(6) : "";
                document.getElementById("txTransferFxManualFields").style.display = tx.destAmount != null ? "block" : "none";
                await updateTxTransferFxVisibility();
                if (tx.destAmount != null) {
                    const transferSrcAcc = accounts.find(a => a.id === tx.src);
                    const transferDestAcc = accounts.find(a => a.id === tx.dest);
                    if (transferSrcAcc && transferDestAcc) updateTransferFxPreview(transferSrcAcc, transferDestAcc);
                }

                const currentCats = dynamicCategories.filter(c => c.type === tx.type).map(c => c.name);
                // v82: unioned with the full DEFAULT_CATEGORIES list (kept alongside the original
                // legacy names) so every built-in category is always selectable here regardless of
                // what's actually persisted in the Categories store. v101: now grouped into
                // Main Category / Subcategory <optgroup>s via buildCategoryOptionsHTML() — see its
                // own comment.
                //
                // Transfers have no category at all (the Category row is hidden for them below) —
                // skip populating options entirely rather than leaving the <select> holding
                // whatever the expense list's alphabetically-first option happens to be. See the
                // matching comment on the "new entry" branch below for how that silently corrupted
                // Transfer records before this fix.
                if (tx.type !== "transfer") {
                    catSelect.innerHTML += buildCategoryOptionsHTML(tx.type, currentCats);
                }
                
                document.getElementById("txCategory").value = tx.cat || "";
                document.getElementById("destAccRow").style.display = tx.type === "transfer" ? "flex" : "none";
                document.getElementById("categoryRow").style.display = tx.type === "transfer" ? "none" : "flex";

                document.getElementById("txModalTitle").textContent = "Edit Ledger Entry";
                document.getElementById("txSubmitBtn").textContent = "Save Changes";
                document.getElementById("txDeleteBtn").style.display = "block";

                // v121: load already-saved attachments (id/name/mime/thumb/size refs — no full
                // file data pulled in here, that's only fetched on demand when one is opened).
                // A legacy pre-v121 entry that only has the old inline tx.image field is seeded
                // as one existing attachment with a null id — handleTransactionSubmitMobile()
                // notices the missing id at save time and migrates it into a real IndexedDB
                // attachment then, so it only needs handling in one place.
                existingTxAttachments = Array.isArray(tx.attachments) ? tx.attachments.map(a => ({ ...a })) :
                    (tx.image ? [{ id: null, name: "Receipt.jpg", mime: "image/jpeg", thumb: tx.image, size: tx.image.length, legacyData: tx.image }] : []);
                tempTxAttachments = [];
                renderTxAttachmentPreview();

                // Editing: default to "manual" so an existing saved Description stays visible
                // and editable rather than being hidden the moment the FD block re-appears.
                document.getElementById("txFdManualDesc").checked = true;
                updateTxFdFieldsVisibilitySync(accounts);
                if (tx.fdMaturityDate) {
                    document.getElementById("txFdReference").value = tx.fdReferenceNo || "";
                    document.getElementById("txFdStartDate").value = tx.fdStartDate || "";
                    document.getElementById("txFdTenureMonths").value = tx.fdTenureMonths || 12;
                    document.getElementById("txFdInterestRate").value = tx.fdInterestRate || 0;
                    document.getElementById("txFdMaturityDate").value = tx.fdMaturityDate || "";
                    recalcTxFdMaturity();
                }
            } else {
                document.getElementById("txId").value = "";
                document.getElementById("txType").value = type;
                document.getElementById("txDate").value = todayLocalStr();
                document.getElementById("txDesc").value = "";
                document.getElementById("txAmount").value = "";
                document.getElementById("txNotes").value = "";
                document.getElementById("txChecked").checked = false;
                // Split Expenses only makes sense for a brand-new Income/Expense entry.
                document.getElementById("txSplitWrap").style.display = (type === "transfer") ? "none" : "block";

                // Pre-select the user's default account, if one is set and still exists — new
                // entries only, never when editing (handled above via tx.src). Income uses
                // Default Receive Account; Expense and Transfer's "from" side use Default
                // Payment Account — kept as two separate settings since a household very often
                // routes outgoing spending and incoming salary through different accounts on
                // purpose. A preset account passed in (e.g. opening this form via the "+" FAB on
                // that account's own Activity page — see quickAddChooseType()) takes priority
                // over either stored default.
                const defaultSrcAccount = type === "income" ? defaultReceiveAccount : defaultPaymentAccount;
                if (defaultSrcAccount && accounts.some(a => a.id === defaultSrcAccount)) {
                    srcSelect.value = defaultSrcAccount;
                }
                if (presetSrcAccountId && accounts.some(a => a.id === presetSrcAccountId)) {
                    srcSelect.value = presetSrcAccountId;
                }

                document.getElementById("destAccRow").style.display = type === "transfer" ? "flex" : "none";
                document.getElementById("categoryRow").style.display = type === "transfer" ? "none" : "flex";

                // "To Account" is a single <select> shared across every time the transaction modal
                // is opened. It's only reset here (not on every open) because without it, a value
                // picked for an earlier Transfer entry silently lingers in the DOM after the field
                // is hidden for Income/Expense — and would otherwise get saved as that record's
                // `dest`, making it wrongly appear in that other account's ledger too. See also the
                // defensive `record.dest = null` guard in handleTransactionSubmitMobile().
                if (type !== "transfer") {
                    document.getElementById("destAccount").value = "";
                }

                const currentCats = dynamicCategories.filter(c => c.type === type).map(c => c.name);
                // v82: see matching comment on the "edit entry" branch above — unioned with
                // DEFAULT_CATEGORIES (kept alongside the legacy names) so every built-in category
                // is always offered here too. v101: grouped via buildCategoryOptionsHTML().
                //
                // Transfers have no category (the Category row is hidden for them just above) — skip
                // populating the <select> entirely for them. Previously this always populated it
                // with the expense list even for Transfers (the ternary above only special-cases
                // "income", so "transfer" fell into the expense fallback too), and since a freshly
                // populated <select> auto-selects its first option, every new Transfer silently got
                // saved with the alphabetically-first expense category ("Commute") as its hidden
                // `cat` — invisible in the form, but shown on the ledger as "[Commute]".
                if (type !== "transfer") {
                    catSelect.innerHTML += buildCategoryOptionsHTML(type, currentCats);

                    // Pre-select the user's chosen default category for this type, if one is set
                    // and still exists among the current options — new entries only, never editing.
                    const defaultCat = type === "income" ? defaultIncomeCategory : defaultExpenseCategory;
                    if (defaultCat && [...catSelect.options].some(o => o.value === defaultCat)) {
                        catSelect.value = defaultCat;
                    }
                }

                document.getElementById("txModalTitle").textContent = "Log Ledger Item";
                document.getElementById("txSubmitBtn").textContent = "Commit Entry";
                document.getElementById("txDeleteBtn").style.display = "none";

                existingTxAttachments = [];
                tempTxAttachments = [];
                renderTxAttachmentPreview();

                document.getElementById("txFdReference").value = "";
                document.getElementById("txFdStartDate").value = "";
                document.getElementById("txFdTenureMonths").value = "12";
                document.getElementById("txFdInterestRate").value = "3.0";
                document.getElementById("txFdMaturityDate").value = "";
                document.getElementById("txFdMaturityPreview").textContent = "";

                // New entry: default to "auto" Description (off) — most FD placements don't need
                // a separate free-text description on top of their Account/Reference No.
                document.getElementById("txFdManualDesc").checked = false;

                document.getElementById("txManualFxToggle").checked = false;
                document.getElementById("txManualFxRate").value = "";
                document.getElementById("txManualFxRateRow").style.display = "none";

                document.getElementById("txTransferFxToggle").checked = false;
                document.getElementById("txTransferRate").value = "";
                document.getElementById("txTransferDestAmount").value = "";
                document.getElementById("txTransferFxManualFields").style.display = "none";

                syncTransactionCurrency();
            }

            // v99: the visible Account/To Account buttons show a snapshot of the <select>'s
            // current option text (see openAccountPicker()) — refresh it here, once, after every
            // branch above has finished touching srcAccount/destAccount's value, rather than
            // duplicating this call at each individual assignment site. v142: txCategory joined
            // the same picker pattern, so it needs the same refresh — harmless no-op for Transfers,
            // where txCategory's <select> was left empty/untouched above.
            syncAccountPickerButtonText("srcAccount");
            syncAccountPickerButtonText("destAccount");
            syncAccountPickerButtonText("txCategory");

            openModal("txModal");
        }

        // --- SPLIT EXPENSES (v88) ---
        // A split row is its own Category + Amount pair, added via the "➕ Split into another
        // category" button and removable via its own [-]. On save, if any split rows exist,
        // handleTransactionSubmitMobile() writes the main row PLUS every split row as separate,
        // ordinary transaction records (same account/date/desc/notes/payee/checked state) sharing
        // a generated splitGroupId — so nothing about how the rest of the app aggregates a normal
        // transaction (account balances, category totals, reports) needs to know split rows exist
        // at all. Only offered for a brand-new Income/Expense entry — see openTransactionForm().

        function resetTxSplitRows() {
            document.getElementById("txSplitRows").innerHTML = "";
            txSplitRowCounter = 0;
            recalcTxSplitTotal();
        }

        function buildSplitCategoryOptionsHTML(type) {
            const currentCats = dynamicCategories.filter(c => c.type === type).map(c => c.name);
            return buildCategoryOptionsHTML(type, currentCats);
        }

        function addTxSplitRow() {
            const type = document.getElementById("txType").value;
            if (type === "transfer") return;
            txSplitRowCounter++;
            const rowId = `txSplitRow_${txSplitRowCounter}`;
            const catSelectId = `${rowId}_cat`;
            const row = document.createElement("div");
            row.className = "split-row";
            row.id = rowId;
            // v150: rebuilt to reuse the exact same markup pattern as #txMainEntryCard (Amount on
            // top, then an icon-avatar + picker-button Category line below) instead of a
            // differently-styled block, so every split row now looks identical to the main entry
            // and to every other split row — see the "make main & split rows the same style"
            // reference screenshots. Category swaps from a plain visible <select> to the same
            // hidden-<select>-plus-picker-button pattern txCategory/srcAccount use (openAccountPicker()
            // is generic over any select id via data-select, so this "just works" for a dynamically
            // added row too), which is what gives it the same font size/look as the main entry
            // instead of the OS's own oversized native dropdown. Remove is now a small round − button
            // trailing the Category line, matching the reference's compact per-row remove control.
            row.innerHTML = `
                <label>Amount</label>
                <div class="split-amt-line">
                    <input type="number" class="tx-split-amt" step="0.01" inputmode="decimal" placeholder="Amount" style="flex:1;" data-input="recalcTxSplitTotal">
                    <button type="button" class="calc-btn" data-click="openCalcPadFor" data-target="${rowId}_amt" title="Calculator / Numpad">${CALC_ICON_SVG}</button>
                </div>
                <div class="split-row-catline">
                    <span class="split-cat-icon" id="${catSelectId}Icon">🏷️</span>
                    <button type="button" class="form-input account-picker-btn" data-click="openAccountPicker" data-select="${catSelectId}" data-title="Select Category">
                        <span id="${catSelectId}BtnText">Select category</span><span class="account-picker-chevron">▾</span>
                    </button>
                    <button type="button" class="split-remove-btn" data-click="removeTxSplitRow" data-row-id="${rowId}" title="Remove this split">−</button>
                </div>
                <select class="form-input tx-split-cat" id="${catSelectId}" style="display:none;">${buildSplitCategoryOptionsHTML(type)}</select>
            `;
            document.getElementById("txSplitRows").appendChild(row);
            row.querySelector(".tx-split-amt").id = `${rowId}_amt`;
            // Initializes the new row's picker-button text + icon avatar from whatever its hidden
            // <select> defaulted to (its first option), same as the main Category field does.
            syncAccountPickerButtonText(catSelectId);
            recalcTxSplitTotal();
        }

        function removeTxSplitRow(el) {
            const rowId = el.dataset.rowId;
            const row = document.getElementById(rowId);
            if (row) row.remove();
            recalcTxSplitTotal();
        }

        function recalcTxSplitTotal() {
            const mainAmt = parseFloat(document.getElementById("txAmount").value) || 0;
            let splitTotal = mainAmt;
            document.querySelectorAll("#txSplitRows .tx-split-amt").forEach(inp => {
                splitTotal += parseFloat(inp.value) || 0;
            });
            const currency = document.getElementById("txCurrency").value || baseCurrency;
            const display = document.getElementById("txSplitTotalDisplay");
            if (display) display.textContent = formatCurrency(splitTotal, currency);
        }

        // Collects every split row into [{cat, amount}] — rows with no category or a non-positive
        // amount are skipped rather than blocking save, since a half-filled row the user is still
        // typing into shouldn't stop the main entry from being saved.
        function collectTxSplitRows() {
            const rows = [];
            document.querySelectorAll("#txSplitRows .split-row").forEach(rowEl => {
                const cat = rowEl.querySelector(".tx-split-cat").value;
                const amt = parseFloat(rowEl.querySelector(".tx-split-amt").value);
                if (cat && !isNaN(amt) && amt > 0) rows.push({ cat, amount: amt });
            });
            return rows;
        }

        // --- CALCULATOR / NUMPAD (v88) ---
        function openCalcPad(el) {
            calcPadTargetId = el.dataset.target;
            const targetInput = document.getElementById(calcPadTargetId);
            const existing = targetInput ? targetInput.value : "";
            calcPadExpr = (existing && !isNaN(parseFloat(existing))) ? String(existing) : "";
            updateCalcPadDisplay();
            openModal("calcPadModal");
        }

        function updateCalcPadDisplay() {
            document.getElementById("calcPadDisplay").textContent = calcPadExpr || "0";
        }

        function calcPadPress(el) {
            const val = el.dataset.val;
            if (val === "C") {
                calcPadExpr = "";
            } else if (val === "⌫") {
                calcPadExpr = calcPadExpr.slice(0, -1);
            } else if (val === "=") {
                const sanitized = calcPadExpr.replace(/×/g, "*").replace(/÷/g, "/").replace(/−/g, "-");
                // Only digits/operators/dot/space allowed — this is a plain arithmetic
                // calculator, not a general expression evaluator, and the input is the user's
                // own typing (via these fixed buttons), not external data.
                if (!/^[0-9+\-*/.\s]*$/.test(sanitized) || sanitized.trim() === "") { return; }
                const result = evalCalcExpression(sanitized);
                if (typeof result === "number" && isFinite(result)) {
                    calcPadExpr = String(Math.round(result * 100) / 100);
                }
                // else: invalid expression (e.g. divide by zero, trailing operator) — leave display as-is
            } else {
                calcPadExpr += val;
            }
            updateCalcPadDisplay();
        }

        // Evaluates a plain arithmetic string (digits, + - * / ., no parentheses) WITHOUT
        // Function()/eval — this app's CSP is script-src 'self' with no 'unsafe-eval', so any
        // Function()-based "quick eval" is silently blocked by the browser and throws, which a
        // wrapping try/catch swallows: the exact "press '=', nothing happens" symptom this
        // replaced. Standard * / before + - precedence, two passes over hand-tokenized input;
        // returns null (not NaN/undefined) on anything malformed so the caller's isFinite check
        // cleanly rejects it and leaves the display untouched, same as the old catch-and-ignore.
        function evalCalcExpression(sanitized) {
            const tokens = [];
            let i = 0;
            while (i < sanitized.length) {
                const c = sanitized[i];
                if (/\s/.test(c)) { i++; continue; }
                if (/[0-9.]/.test(c)) {
                    let num = c; i++;
                    while (i < sanitized.length && /[0-9.]/.test(sanitized[i])) { num += sanitized[i]; i++; }
                    // Reject "9.5.5" etc rather than let parseFloat quietly drop the tail.
                    if ((num.match(/\./g) || []).length > 1) return null;
                    const n = parseFloat(num);
                    if (isNaN(n)) return null;
                    tokens.push({ type: "num", value: n });
                } else if ("+-*/".includes(c)) {
                    tokens.push({ type: "op", value: c });
                    i++;
                } else {
                    return null;
                }
            }
            if (tokens.length === 0) return null;

            // Fold unary +/- (leading, or right after another operator) into the following number.
            const folded = [];
            for (let j = 0; j < tokens.length; j++) {
                const t = tokens[j];
                if (t.type === "op" && (t.value === "+" || t.value === "-") &&
                    (folded.length === 0 || folded[folded.length - 1].type === "op")) {
                    const next = tokens[j + 1];
                    if (!next || next.type !== "num") return null;
                    folded.push({ type: "num", value: t.value === "-" ? -next.value : next.value });
                    j++;
                } else {
                    folded.push(t);
                }
            }
            if (folded.length === 0 || folded[0].type !== "num") return null;

            // Pass 1: resolve * and / left-to-right.
            const pass1 = [folded[0]];
            for (let j = 1; j < folded.length; j += 2) {
                const op = folded[j];
                const num = folded[j + 1];
                if (!op || !num || op.type !== "op" || num.type !== "num") return null;
                if (op.value === "*" || op.value === "/") {
                    if (op.value === "/" && num.value === 0) return null;
                    const prev = pass1.pop();
                    pass1.push({ type: "num", value: op.value === "*" ? prev.value * num.value : prev.value / num.value });
                } else {
                    pass1.push(op, num);
                }
            }

            // Pass 2: resolve + and - left-to-right.
            let result = pass1[0].value;
            for (let j = 1; j < pass1.length; j += 2) {
                const op = pass1[j];
                const num = pass1[j + 1];
                if (!op || !num) return null;
                result = op.value === "+" ? result + num.value : result - num.value;
            }
            return result;
        }

        function calcPadApply() {
            if (calcPadTargetId) {
                const num = parseFloat(calcPadExpr);
                const input = document.getElementById(calcPadTargetId);
                if (input && !isNaN(num)) {
                    input.value = num;
                    input.dispatchEvent(new Event("input", { bubbles: true }));
                    input.dispatchEvent(new Event("change", { bubbles: true }));
                }
            }
            closeModal("calcPadModal");
        }

        // --- RECEIPT ATTACHMENTS (images + PDFs, multiple per transaction) ---

        function makeAttId() {
            return "att_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
        }

        function readFileAsDataUrl(file) {
            return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = (e) => resolve(e.target.result);
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(file);
            });
        }

        // Resizes + re-encodes an image as JPEG to keep IndexedDB storage usage reasonable.
        // Receipts don't need full camera resolution to stay legible. Also reused at a small
        // size/quality to build the inline preview thumbnail kept on the transaction record.
        function compressImage(dataUrl, maxDimension, quality) {
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => {
                    let { width, height } = img;
                    if (width > maxDimension || height > maxDimension) {
                        if (width > height) {
                            height = Math.round(height * (maxDimension / width));
                            width = maxDimension;
                        } else {
                            width = Math.round(width * (maxDimension / height));
                            height = maxDimension;
                        }
                    }
                    const canvas = document.createElement("canvas");
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext("2d");
                    ctx.drawImage(img, 0, 0, width, height);
                    try {
                        resolve(canvas.toDataURL("image/jpeg", quality));
                    } catch (err) {
                        reject(err);
                    }
                };
                img.onerror = reject;
                img.src = dataUrl;
            });
        }

        function formatAttBytes(n) {
            if (!n) return "";
            if (n < 1024) return n + " B";
            if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
            return (n / 1024 / 1024).toFixed(1) + " MB";
        }

        // Fired by both the camera input (image/* only) and the "Add Files" input
        // (image/*,application/pdf, multiple). Reads every selected file, compresses images
        // (a small inline thumb is generated for the preview list; PDFs show a 📄 icon
        // instead — a full-page thumbnail isn't worth the pdf.js render cost just for a list
        // row), and appends each to tempTxAttachments. Actual IndexedDB writes happen only on
        // save (handleTransactionSubmitMobile) — cancelling the form discards these.
        async function handleTxAttachmentsSelected(event) {
            const files = Array.from(event.target.files || []);
            for (const file of files) {
                const isImage = file.type.startsWith("image/");
                const isPdf = file.type === "application/pdf";
                if (!isImage && !isPdf) {
                    alert(`"${file.name}" isn't an image or a PDF — skipped.`);
                    continue;
                }
                if (isPdf && file.size > 8 * 1024 * 1024) {
                    const mb = (file.size / 1024 / 1024).toFixed(1);
                    if (!confirm(`"${file.name}" is ${mb}MB. Large PDFs take longer to store. Add it anyway?`)) continue;
                }

                let data, thumb;
                if (isImage) {
                    const raw = await readFileAsDataUrl(file);
                    if (!raw) { alert(`Couldn't read "${file.name}" — it wasn't added.`); continue; }
                    try {
                        data = await compressImage(raw, 1280, 0.75);
                        thumb = await compressImage(raw, 96, 0.5);
                    } catch (err) {
                        alert(`Could not process "${file.name}" — it wasn't added.`);
                        continue;
                    }
                } else {
                    data = await readFileAsDataUrl(file);
                    if (!data) { alert(`Couldn't read "${file.name}" — it wasn't added.`); continue; }
                    thumb = null;
                }

                tempTxAttachments.push({
                    name: file.name,
                    mime: isImage ? "image/jpeg" : "application/pdf",
                    data,
                    thumb,
                    size: data.length
                });
            }
            renderTxAttachmentPreview();
            // Reset both file inputs so selecting the same file again still fires 'change'.
            document.getElementById("txCameraInput").value = "";
            document.getElementById("txFilesInput").value = "";
        }

        // Renders the combined list — already-saved attachments (existingTxAttachments, only
        // present when editing) plus newly-picked-but-unsaved ones (tempTxAttachments) — into
        // the transaction form's attachment preview area, each with its own Remove button.
        function renderTxAttachmentPreview() {
            const wrap = document.getElementById("txAttachmentPreview");
            const items = [];
            existingTxAttachments.forEach((att, idx) => {
                items.push(renderTxAttachmentRow(att, `removeExistingTxAttachment" data-idx="${idx}`));
            });
            tempTxAttachments.forEach((att, idx) => {
                items.push(renderTxAttachmentRow(att, `removeTempTxAttachment" data-idx="${idx}`));
            });
            wrap.innerHTML = items.join("");
            wrap.style.display = items.length ? "flex" : "none";
        }

        function renderTxAttachmentRow(att, removeDataClick) {
            const isImage = (att.mime || "").startsWith("image/");
            const thumbSrc = att.thumb || (isImage ? att.data : null);
            const icon = isImage ? "🖼️" : "📄";
            return `
                <div class="tx-att-item" style="display:flex; align-items:center; gap:8px; background:var(--chip-bg); border:1px solid var(--border-color); border-radius:8px; padding:6px 8px;">
                    <div style="width:36px; height:36px; border-radius:6px; overflow:hidden; flex-shrink:0; display:flex; align-items:center; justify-content:center; background:var(--chip-bg); font-size:1.1rem;">
                        ${thumbSrc ? `<img src="${thumbSrc}" alt="" style="width:100%; height:100%; object-fit:cover;">` : icon}
                    </div>
                    <div style="flex:1; min-width:0;">
                        <div style="font-size:0.78rem; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(att.name || "Attachment")}</div>
                        <div style="font-size:0.68rem; color:var(--text-muted);">${formatAttBytes(att.size)}</div>
                    </div>
                    <button type="button" data-click="${removeDataClick}" style="border:none; background:none; color:var(--expense-color); font-weight:700; font-size:1rem; cursor:pointer; padding:2px 6px; flex-shrink:0;">✕</button>
                </div>
            `;
        }

        function removeExistingTxAttachment(el) {
            const idx = parseInt(el.dataset.idx, 10);
            existingTxAttachments.splice(idx, 1);
            renderTxAttachmentPreview();
        }

        function removeTempTxAttachment(el) {
            const idx = parseInt(el.dataset.idx, 10);
            tempTxAttachments.splice(idx, 1);
            renderTxAttachmentPreview();
        }

        // Object URLs are deliberately NOT used anywhere in the attachment viewer below — every
        // attachment's bytes are already available as a data: URL (either read straight off the
        // transaction record for a legacy single-image entry, or resolved from IndexedDB via
        // readKeyDB(STORES.ATTACHMENTS, id) below), so <img src="data:..."> and an <a download
        // href="data:...">  work directly with no createObjectURL/revokeObjectURL bookkeeping and
        // no img-src CSP change needed (data: was already allowed).

        // Opens the small picker listing every attachment on a transaction (tapped from the 📎
        // badge on a ledger row) — or, if there's only one, skips straight to the full viewer.
        function openTxAttachmentsBadge(el, event) {
            if (event) event.stopPropagation();
            let atts;
            try { atts = JSON.parse(el.dataset.attachments || "[]"); } catch (err) { atts = []; }
            // Legacy transactions saved before v121 kept one inline image directly on the record
            // (t.image) instead of an `attachments` array — synthesize a matching pseudo-entry so
            // the same viewer code path handles both without a separate legacy branch everywhere.
            if (el.dataset.legacyImage) {
                atts = [{ name: "Receipt.jpg", mime: "image/jpeg", data: el.dataset.legacyImage, legacy: true }];
            }
            if (atts.length === 0) return;
            if (atts.length === 1) { openAttachment(atts[0]); return; }

            const list = document.getElementById("txAttachmentsPickerList");
            list.innerHTML = atts.map((att, idx) => `
                <div class="tx-att-item" data-click="openAttachmentFromPicker" data-idx="${idx}" style="display:flex; align-items:center; gap:8px; background:var(--chip-bg); border:1px solid var(--border-color); border-radius:8px; padding:8px; cursor:pointer;">
                    <div style="width:36px; height:36px; border-radius:6px; overflow:hidden; flex-shrink:0; display:flex; align-items:center; justify-content:center; background:var(--chip-bg); font-size:1.1rem;">
                        ${att.thumb ? `<img src="${att.thumb}" alt="" style="width:100%; height:100%; object-fit:cover;">` : ((att.mime || "").startsWith("image/") ? "🖼️" : "📄")}
                    </div>
                    <div style="flex:1; min-width:0; font-size:0.8rem; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(att.name || "Attachment")}</div>
                </div>
            `).join("");
            txAttachmentsPickerCurrent = atts;
            openModal("txAttachmentsPickerModal");
        }
        let txAttachmentsPickerCurrent = [];

        function openAttachmentFromPicker(el) {
            const idx = parseInt(el.dataset.idx, 10);
            const att = txAttachmentsPickerCurrent[idx];
            if (!att) return;
            // v121 bugfix: this used to call openAttachment(att) directly, leaving
            // txAttachmentsPickerModal "active" underneath the newly-opened attachmentViewerModal
            // (both stayed in modalStack, correctly LIFO-ordered) — that part was fine. The actual
            // bug was visual: without an elevated z-index, the viewer rendered BEHIND the picker
            // (later modals in DOM source paint on top when z-index ties, and the picker happens
            // to sit later in index.html), so the picker looked like it was blocking the photo/PDF.
            // That led people to close the picker FIRST (out of stack order) — which hit closeModal's
            // "trim stale entries above id" branch: it truncated the JS modalStack array down to the
            // picker without ever removing the viewer's own "active" class, permanently desyncing
            // modalStack from the real browser history stack for the rest of the session (every
            // Close after that popped one real history entry too many, eventually navigating out of
            // the app entirely). attachmentViewerModal's z-index is now set above every other modal
            // (see index.html) so this out-of-order close can't be triggered by the visual bug
            // anymore — but since the picker is a disposable "which one?" dialog with nothing to
            // return to, it's also just closed outright before opening the viewer, same idiom used
            // throughout the app for "close A, then open B" (see closeModalAndThen and its other
            // call sites, e.g. editTransactionFromOptions). Contrast with openAttachmentFromQuickView
            // below, which deliberately does NOT close its parent modal first.
            closeModalAndThen("txAttachmentsPickerModal", () => openAttachment(att));
        }

        // Used by the inline attachment list rendered directly inside txQuickViewModal (see
        // openTxQuickView()) — unlike openAttachmentFromPicker above, Quick View is a real
        // transaction-detail screen worth returning to, so it's deliberately left open/active
        // underneath: closing the viewer here should land back on Quick View, not the ledger list.
        function openAttachmentFromQuickView(el) {
            const idx = parseInt(el.dataset.idx, 10);
            const att = txAttachmentsPickerCurrent[idx];
            if (att) openAttachment(att);
        }

        // Deletes every IndexedDB attachment blob referenced by a transaction — used wherever a
        // transaction itself is deleted (options-menu delete, account-delete cascade, fund-tx
        // delete) so a removed transaction doesn't leave orphaned attachment records behind.
        // Legacy pre-v121 entries only carry inline `image` data on the transaction record
        // itself (nothing separate in STORES.ATTACHMENTS), so there's nothing to clean up there.
        async function deleteTxAttachments(tx) {
            if (!tx || !Array.isArray(tx.attachments)) return;
            for (const att of tx.attachments) {
                if (att && att.id) {
                    try { await deleteDB(STORES.ATTACHMENTS, att.id); } catch (err) { /* non-fatal */ }
                }
            }
        }

        // Resolves an attachment's full bytes and renders it into attachmentViewerModal — images
        // directly via <img>, PDFs page-by-page onto <canvas> via pdf.js (never handed to an
        // <iframe>/native plugin, so rendering is identical across every platform and no
        // PDF-embedded JavaScript is ever executed — pdf.js only reads page content). Accepts
        // either a lightweight ref ({id, ...}, resolved from IndexedDB) or one already carrying
        // its data inline (a legacy single-image entry, or a not-yet-saved temp attachment).
        async function openAttachment(att) {
            if (!att) return;
            const body = document.getElementById("attachmentViewerBody");
            body.innerHTML = "<p style=\"font-size:0.85rem; color:var(--text-muted);\">Loading…</p>";
            document.getElementById("attachmentViewerTitle").textContent = att.name || "Attachment";
            openModal("attachmentViewerModal");

            let dataUrl = att.data || null;
            if (!dataUrl && att.id) {
                try {
                    const rec = await readKeyDB(STORES.ATTACHMENTS, att.id);
                    dataUrl = rec ? rec.data : null;
                } catch (err) {
                    body.innerHTML = "<p style=\"color:var(--expense-color);\">Could not load this attachment.</p>";
                    return;
                }
            }
            if (!dataUrl) {
                body.innerHTML = "<p style=\"color:var(--expense-color);\">This attachment's file data could not be found.</p>";
                return;
            }

            const isPdf = (att.mime === "application/pdf") || /\.pdf$/i.test(att.name || "");
            body.innerHTML = "";
            const dl = document.getElementById("btnDownloadAttachment");
            dl.href = dataUrl;
            dl.download = att.name || "attachment";

            if (isPdf) {
                body.innerHTML = "<p style=\"font-size:0.85rem; color:var(--text-muted);\">Loading PDF…</p>";
                try {
                    const base64 = dataUrl.split(",")[1] || "";
                    const bytes = b64ToBuf(base64);
                    const pdfjsLib = await pdfjsLibPromise;
                    // isEvalSupported: false — belt-and-suspenders on top of only ever calling
                    // getPage()/render() here: tells pdf.js not to use eval()/new Function() for
                    // any internal optimization, so a malicious PDF can't get script execution
                    // out of the parser. Harmless for rendering — eval is only ever used there as
                    // a speed optimization, never a required code path.
                    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
                    body.innerHTML = "";
                    const containerWidth = body.clientWidth || 320;
                    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
                        const page = await pdf.getPage(pageNum);
                        const unscaledViewport = page.getViewport({ scale: 1 });
                        const scale = Math.max(0.1, (containerWidth - 16) / unscaledViewport.width);
                        const viewport = page.getViewport({ scale });
                        const canvas = document.createElement("canvas");
                        canvas.width = viewport.width;
                        canvas.height = viewport.height;
                        canvas.style.display = "block";
                        canvas.style.maxWidth = "100%";
                        canvas.style.margin = "0 auto 10px";
                        canvas.style.boxShadow = "0 1px 4px rgba(0,0,0,0.15)";
                        body.appendChild(canvas);
                        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
                    }
                } catch (pdfErr) {
                    body.innerHTML = "<p style=\"color:var(--expense-color);\">Could not preview this PDF: " + escapeHtml(pdfErr.message) + "<br><br>Use Download below to save it and open it another way.</p>";
                }
            } else {
                const img = document.createElement("img");
                img.src = dataUrl;
                img.style.maxWidth = "100%";
                img.style.maxHeight = "70vh";
                img.style.display = "block";
                img.style.margin = "0 auto";
                body.appendChild(img);
            }
        }

        // Determines whether this transaction is depositing funds INTO a Fixed Deposit account
        // (income → src account, or transfer → dest account), and shows/hides the FD terms block
        // accordingly. Takes an already-loaded accounts array to avoid redundant DB reads.
        function updateTxFdFieldsVisibilitySync(accounts) {
            const type = document.getElementById("txType").value;
            const wrap = document.getElementById("txFdFieldsWrap");

            const relevantAccountId = type === "income" ? document.getElementById("srcAccount").value
                                     : type === "transfer" ? document.getElementById("destAccount").value
                                     : null;

            const relevantAccount = accounts.find(a => a.id === relevantAccountId);
            const showFd = !!(relevantAccount && relevantAccount.type === "fd");
            wrap.style.display = showFd ? "block" : "none";

            if (showFd && !document.getElementById("txFdStartDate").value) {
                document.getElementById("txFdStartDate").value = document.getElementById("txDate").value || todayLocalStr();
                recalcTxFdMaturity();
            }

            toggleTxFdDescMode();
        }

        // Description field is optional/auto-filled for Fixed Deposit placements (the placement
        // already has its own Account/Reference No. field), unless the user flips "Manually fill
        // Description" on. For every non-FD transaction the Description field behaves as before —
        // always shown and required.
        function toggleTxFdDescMode() {
            const fdVisible = document.getElementById("txFdFieldsWrap").style.display !== "none";
            const manualChecked = document.getElementById("txFdManualDesc").checked;
            const descRow = document.getElementById("txDescRow");
            const descInput = document.getElementById("txDesc");

            const autoMode = fdVisible && !manualChecked;
            descRow.style.display = autoMode ? "none" : "flex";
            descInput.required = !autoMode;
        }

        // Builds the auto-generated Description used for an FD placement when the user hasn't
        // opted to fill it in manually — derived from the Account/Reference No. if one was given,
        // else a generic placement label.
        function buildAutoFdDescription() {
            // v168: no longer appends "(ref)" here — the ledger row already shows the reference
            // number on its own meta line (via fdReferenceNo / referenceText), so baking it into
            // the title too was showing it twice on the same row.
            return "Fixed Deposit Placement";
        }

        async function syncTransactionCurrency() {
            const accounts = await readAllDB(STORES.ACCOUNTS);
            const isEditing = document.getElementById("txId").value !== "";

            if (!isEditing) {
                const selectedAccountId = document.getElementById("srcAccount").value;
                const targetAccount = accounts.find(a => a.id === selectedAccountId);
                // Only auto-follow the account's currency for single-currency ("normal") accounts.
                // Multi-currency and Fixed Deposit accounts don't have one fixed currency, so the
                // user picks the currency for this specific transaction/placement instead.
                if (targetAccount && targetAccount.type !== "multi" && targetAccount.type !== "fd" && targetAccount.currency) {
                    document.getElementById("txCurrency").value = targetAccount.currency;
                }
            }

            updateTxFdFieldsVisibilitySync(accounts);
            updateTxManualFxVisibility();
            updateTxTransferFxVisibility();
        }

        // Auto-calculates the FD placement's maturity date from commencing date + tenure, and
        // previews the simple-interest projected payout for this specific deposit.
        function recalcTxFdMaturity() {
            const startVal = document.getElementById("txFdStartDate").value;
            const tenure = parseInt(document.getElementById("txFdTenureMonths").value, 10);
            const preview = document.getElementById("txFdMaturityPreview");

            if (!startVal || isNaN(tenure) || tenure <= 0) {
                preview.textContent = "";
                return;
            }

            const start = new Date(startVal + "T00:00:00");
            const maturity = new Date(start);
            maturity.setMonth(maturity.getMonth() + tenure);
            const maturityStr = localDateStr(maturity);
            document.getElementById("txFdMaturityDate").value = maturityStr;

            const principal = parseFloat(document.getElementById("txAmount").value) || 0;
            const rate = parseFloat(document.getElementById("txFdInterestRate").value) || 0;
            const projectedInterest = principal * (rate / 100) * (tenure / 12);
            const projectedTotal = principal + projectedInterest;
            const curr = document.getElementById("txCurrency").value;

            preview.textContent = `Matures ${maturityStr} — projected payout ≈ ${formatCurrency(projectedTotal, curr)} (principal + ${formatCurrency(projectedInterest, curr)} interest, simple interest estimate)`;

            updateTxManualFxVisibility();
        }

        // --- MANUAL FX RATE (per-transaction override, v32) ---
        // Only relevant for Income/Expense entries against a single-currency ("normal") account
        // when the entry's own currency differs from that account's currency. Multi-currency and
        // Fixed Deposit accounts keep separate per-currency baskets with no conversion, and
        // Transfers have two account legs (src + dest currency), so a single rate would be
        // ambiguous — out of scope here.
        async function updateTxManualFxVisibility() {
            const wrap = document.getElementById("txManualFxWrap");
            const type = document.getElementById("txType").value;
            const txCurr = document.getElementById("txCurrency").value;
            const srcId = document.getElementById("srcAccount").value;

            if (type === "transfer" || !srcId || !txCurr) {
                wrap.style.display = "none";
                return;
            }

            const accounts = await readAllDB(STORES.ACCOUNTS);
            const account = accounts.find(a => a.id === srcId);

            if (!account || account.type === "multi" || account.type === "fd" || !account.currency || account.currency === txCurr) {
                wrap.style.display = "none";
                document.getElementById("txManualFxToggle").checked = false;
                document.getElementById("txManualFxRateRow").style.display = "none";
                return;
            }

            wrap.style.display = "block";
            document.getElementById("txManualFxRateLabel").textContent = `Rate (1 ${txCurr} = ? ${account.currency})`;
            const liveRate = convertCurrency(1, txCurr, account.currency);
            document.getElementById("txManualFxAutoHint").textContent = document.getElementById("txManualFxToggle").checked
                ? ""
                : `Auto: currently ${liveRate.toFixed(4)} (today's rate from Currency & FX Rates). This is recalculated live — if that rate changes later, this transaction's effect on the account balance changes with it.`;
            recalcTxManualFxPreview();
        }

        function toggleTxManualFx() {
            const on = document.getElementById("txManualFxToggle").checked;
            document.getElementById("txManualFxRateRow").style.display = on ? "block" : "none";
            if (on && !document.getElementById("txManualFxRate").value) {
                const txCurr = document.getElementById("txCurrency").value;
                readAllDB(STORES.ACCOUNTS).then(accounts => {
                    const account = accounts.find(a => a.id === document.getElementById("srcAccount").value);
                    if (account) {
                        document.getElementById("txManualFxRate").value = convertCurrency(1, txCurr, account.currency).toFixed(6);
                        recalcTxManualFxPreview();
                    }
                });
            }
            updateTxManualFxVisibility();
        }

        async function recalcTxManualFxPreview() {
            const preview = document.getElementById("txManualFxPreview");
            const on = document.getElementById("txManualFxToggle").checked;
            if (!on) { preview.textContent = ""; return; }

            const amount = parseFloat(document.getElementById("txAmount").value) || 0;
            const rate = parseFloat(document.getElementById("txManualFxRate").value) || 0;
            const txCurr = document.getElementById("txCurrency").value;
            const accounts = await readAllDB(STORES.ACCOUNTS);
            const account = accounts.find(a => a.id === document.getElementById("srcAccount").value);
            if (!account) { preview.textContent = ""; return; }

            const converted = amount * rate;
            preview.textContent = `≈ ${formatCurrency(converted, account.currency)} will be applied to ${account.name}'s balance, locked at this rate regardless of future FX rate table changes.`;
        }

        // --- MANUAL FX / RECEIVED AMOUNT FOR TRANSFERS (v33, redesigned v34) ---
        // Only relevant for Transfers between two single-currency ("normal") accounts whose
        // currencies differ. Multi-currency and Fixed Deposit accounts hold per-currency baskets
        // (a transfer into one just credits that basket in the transaction's own currency — no
        // conversion happens at all, so there's nothing to fix there).
        async function updateTxTransferFxVisibility() {
            const wrap = document.getElementById("txTransferFxWrap");
            const type = document.getElementById("txType").value;
            const srcId = document.getElementById("srcAccount").value;
            const destId = document.getElementById("destAccount").value;

            if (type !== "transfer" || !srcId || !destId) {
                wrap.style.display = "none";
                return;
            }

            const accounts = await readAllDB(STORES.ACCOUNTS);
            const srcAcc = accounts.find(a => a.id === srcId);
            const destAcc = accounts.find(a => a.id === destId);

            if (!srcAcc || !destAcc || srcAcc.type === "multi" || srcAcc.type === "fd" || destAcc.type === "multi" || destAcc.type === "fd" || srcAcc.currency === destAcc.currency) {
                wrap.style.display = "none";
                document.getElementById("txTransferFxToggle").checked = false;
                document.getElementById("txTransferFxManualFields").style.display = "none";
                return;
            }

            wrap.style.display = "block";
            document.getElementById("txTransferRateLabel").textContent = `Exchange Rate (1 ${srcAcc.currency} = ? ${destAcc.currency})`;
            document.getElementById("txTransferDestAmountLabel").textContent = `Amount Received (${destAcc.currency})`;

            const liveRate = convertCurrency(1, srcAcc.currency, destAcc.currency);
            document.getElementById("txTransferFxAutoHint").textContent = document.getElementById("txTransferFxToggle").checked
                ? ""
                : `Auto: currently ${liveRate.toFixed(4)} (today's rate from Currency & FX Rates). This is recalculated live — if that rate changes later, the received amount recorded for this transfer changes with it.`;
        }

        function toggleTxTransferFx() {
            const on = document.getElementById("txTransferFxToggle").checked;
            document.getElementById("txTransferFxManualFields").style.display = on ? "block" : "none";
            if (on) {
                readAllDB(STORES.ACCOUNTS).then(accounts => {
                    const srcAcc = accounts.find(a => a.id === document.getElementById("srcAccount").value);
                    const destAcc = accounts.find(a => a.id === document.getElementById("destAccount").value);
                    if (srcAcc && destAcc && !document.getElementById("txTransferRate").value) {
                        // Prefill both fields from today's live rate as a starting point — either
                        // one can then be overwritten to recalculate the other (see the two recalc
                        // functions below).
                        const rate = convertCurrency(1, srcAcc.currency, destAcc.currency);
                        const amount = parseFloat(document.getElementById("txAmount").value) || 0;
                        document.getElementById("txTransferRate").value = rate.toFixed(6);
                        document.getElementById("txTransferDestAmount").value = amount > 0 ? (amount * rate).toFixed(2) : "";
                    }
                    updateTransferFxPreview(srcAcc, destAcc);
                });
            }
            updateTxTransferFxVisibility();
        }

        // Typing in the Rate field recalculates Amount Received — the field the user isn't
        // actively editing always reflects whichever one they last touched.
        async function recalcTransferFxFromRate() {
            const accounts = await readAllDB(STORES.ACCOUNTS);
            const srcAcc = accounts.find(a => a.id === document.getElementById("srcAccount").value);
            const destAcc = accounts.find(a => a.id === document.getElementById("destAccount").value);
            if (!srcAcc || !destAcc) return;

            const amount = parseFloat(document.getElementById("txAmount").value) || 0;
            const rate = parseFloat(document.getElementById("txTransferRate").value) || 0;
            document.getElementById("txTransferDestAmount").value = amount > 0 && rate > 0 ? (amount * rate).toFixed(2) : "";
            updateTransferFxPreview(srcAcc, destAcc);
        }

        // Typing in the Amount Received field recalculates the effective Rate.
        async function recalcTransferFxFromDestAmount() {
            const accounts = await readAllDB(STORES.ACCOUNTS);
            const srcAcc = accounts.find(a => a.id === document.getElementById("srcAccount").value);
            const destAcc = accounts.find(a => a.id === document.getElementById("destAccount").value);
            if (!srcAcc || !destAcc) return;

            const amount = parseFloat(document.getElementById("txAmount").value) || 0;
            const destAmount = parseFloat(document.getElementById("txTransferDestAmount").value) || 0;
            document.getElementById("txTransferRate").value = amount > 0 && destAmount > 0 ? (destAmount / amount).toFixed(6) : "";
            updateTransferFxPreview(srcAcc, destAcc);
        }

        function updateTransferFxPreview(srcAcc, destAcc) {
            const preview = document.getElementById("txTransferFxPreview");
            if (!document.getElementById("txTransferFxToggle").checked) { preview.textContent = ""; return; }
            const destAmount = parseFloat(document.getElementById("txTransferDestAmount").value) || 0;
            const rate = parseFloat(document.getElementById("txTransferRate").value) || 0;
            if (!destAmount || !rate) { preview.textContent = ""; return; }
            preview.textContent = `${destAcc.name} receives ${formatCurrency(destAmount, destAcc.currency)} at rate ${rate.toFixed(4)} — locked in for this transfer regardless of future FX rate table changes.`;
        }

        // Also keeps the two conversion fields in sync when the base transaction Amount itself
        // changes while manual conversion is on (recalcTxFdMaturity is already wired to txAmount's
        // input event) — recomputes Amount Received from whatever Rate is currently entered.
        async function syncTransferFxOnAmountChange() {
            if (document.getElementById("txTransferFxWrap").style.display === "none") return;
            if (!document.getElementById("txTransferFxToggle").checked) return;
            recalcTransferFxFromRate();
        }

        // --- RESOLVE FIXED DEPOSIT MATURITY (renew or withdraw) ---

        async function openResolveFdModal(txId) {
            const txs = await readAllDB(STORES.TRANSACTIONS);
            const tx = txs.find(t => t.id === txId);
            if (!tx) return;

            const accounts = await readAllDB(STORES.ACCOUNTS);
            const holdingAccount = accounts.find(a => a.id === (tx.type === "transfer" ? tx.dest : tx.src));
            if (!holdingAccount) return;

            document.getElementById("resolveFdTxId").value = tx.id;

            const refText = tx.fdReferenceNo ? ` · Ref: ${tx.fdReferenceNo}` : '';
            document.getElementById("resolveFdSummary").textContent =
                `${formatCurrency(tx.amount, tx.currency)} placement in "${accountOptionLabel(holdingAccount, accounts)}"${refText}`;
            document.getElementById("resolveFdMeta").textContent =
                `Commenced ${tx.fdStartDate} · ${tx.fdTenureMonths} months · ${tx.fdInterestRate}% p.a. · Matures ${tx.fdMaturityDate}`;

            // Prefill the interest field with the originally-projected simple-interest estimate —
            // the user can overwrite it with what the bank actually paid.
            const projectedInterest = tx.amount * (tx.fdInterestRate / 100) * (tx.fdTenureMonths / 12);
            document.getElementById("resolveFdInterest").value = projectedInterest.toFixed(2);

            // v81: dates every transaction this modal creates (withdrawal/renewal/interest legs).
            // Defaults to the placement's own maturity date rather than today — when a placement
            // has sat overdue for a while before you get around to resolving it, the entries
            // should reflect when the FD actually matured, not whatever day you happened to log
            // into the app. Still fully editable for the (more common) case of resolving it
            // right on/near maturity, or when the bank actually settled it on a different date.
            document.getElementById("resolveFdResolutionDate").value = tx.fdMaturityDate || todayLocalStr();

            // Destination account pickers for both flows — any account except this same FD placement's
            // holding account makes sense as a target (though we don't hard-block picking it either).
            const destOptions = accounts.map(a => {
                const prefix = a.type === "fd" ? "🏦 " : a.type === "multi" ? "💱 " : a.type === "unittrust" ? "📊 " : a.type === "creditcard" ? "💳 " : "";
                const currLabel = (a.type === "multi" || a.type === "fd" || a.type === "unittrust") ? "" : ` (${escapeHtml(a.currency)})`;
                return `<option value="${escapeHtml(a.id)}">${prefix}${escapeHtml(a.name)}${currLabel} — ${escapeHtml(accountOwnerNamesText(a) + accountRelatedSuffix(a, accounts))}</option>`;
            }).join("");
            document.getElementById("resolveFdInterestDest").innerHTML = destOptions;
            document.getElementById("resolveFdWithdrawDest").innerHTML = destOptions;

            // Many banks reuse the same certificate/account number on renewal — default to it, but
            // it's fully editable since some issue a fresh reference number instead.
            document.getElementById("resolveFdNewReference").value = tx.fdReferenceNo || "";
            document.getElementById("resolveFdNewStart").value = tx.fdMaturityDate;
            document.getElementById("resolveFdNewTenure").value = tx.fdTenureMonths;
            document.getElementById("resolveFdNewRate").value = tx.fdInterestRate;

            setResolveFdAction("renew");
            setResolveFdRenewMode("capitalize");
            recalcResolveFdMaturity();

            openModal("resolveFdModal");
        }

        function setResolveFdAction(action) {
            document.getElementById("resolveFdAction").value = action;
            const renewBtn = document.getElementById("resolveFdActionRenewBtn");
            const withdrawBtn = document.getElementById("resolveFdActionWithdrawBtn");
            const renewWrap = document.getElementById("resolveFdRenewWrap");
            const withdrawWrap = document.getElementById("resolveFdWithdrawWrap");

            if (action === "renew") {
                renewBtn.style.background = "var(--transfer-color)"; renewBtn.style.color = "white";
                withdrawBtn.style.background = "var(--chip-bg)"; withdrawBtn.style.color = "var(--text-main)";
                renewWrap.style.display = "block";
                withdrawWrap.style.display = "none";
            } else {
                withdrawBtn.style.background = "var(--transfer-color)"; withdrawBtn.style.color = "white";
                renewBtn.style.background = "var(--chip-bg)"; renewBtn.style.color = "var(--text-main)";
                renewWrap.style.display = "none";
                withdrawWrap.style.display = "block";
                recalcResolveFdWithdrawPreview();
            }
        }

        function setResolveFdRenewMode(mode) {
            document.getElementById("resolveFdRenewMode").value = mode;
            const capBtn = document.getElementById("resolveFdModeCapitalizeBtn");
            const prinBtn = document.getElementById("resolveFdModePrincipalBtn");
            const destRow = document.getElementById("resolveFdInterestDestRow");

            if (mode === "capitalize") {
                capBtn.style.background = "var(--transfer-color)"; capBtn.style.color = "white";
                prinBtn.style.background = "var(--chip-bg)"; prinBtn.style.color = "var(--text-main)";
                destRow.style.display = "none";
            } else {
                prinBtn.style.background = "var(--transfer-color)"; prinBtn.style.color = "white";
                capBtn.style.background = "var(--chip-bg)"; capBtn.style.color = "var(--text-main)";
                destRow.style.display = "block";
            }
            recalcResolveFdMaturity();
        }

        async function recalcResolveFdMaturity() {
            const startVal = document.getElementById("resolveFdNewStart").value;
            const tenure = parseInt(document.getElementById("resolveFdNewTenure").value, 10);
            const preview = document.getElementById("resolveFdRenewPreview");

            if (!startVal || isNaN(tenure) || tenure <= 0) {
                preview.textContent = "";
                return;
            }

            const start = new Date(startVal + "T00:00:00");
            const maturity = new Date(start);
            maturity.setMonth(maturity.getMonth() + tenure);
            const maturityStr = localDateStr(maturity);
            document.getElementById("resolveFdNewMaturity").value = maturityStr;

            const txId = parseInt(document.getElementById("resolveFdTxId").value);
            const txs = await readAllDB(STORES.TRANSACTIONS);
            const tx = txs.find(t => t.id === txId);
            if (!tx) return;

            const mode = document.getElementById("resolveFdRenewMode").value;
            const interest = parseFloat(document.getElementById("resolveFdInterest").value) || 0;
            const newPrincipal = mode === "capitalize" ? tx.amount + interest : tx.amount;

            preview.textContent = `New placement: ${formatCurrency(newPrincipal, tx.currency)} at ${document.getElementById("resolveFdNewRate").value}% p.a., maturing ${maturityStr}`;
        }

        async function recalcResolveFdWithdrawPreview() {
            const txId = parseInt(document.getElementById("resolveFdTxId").value);
            const txs = await readAllDB(STORES.TRANSACTIONS);
            const tx = txs.find(t => t.id === txId);
            if (!tx) return;

            const interest = parseFloat(document.getElementById("resolveFdInterest").value) || 0;
            const total = tx.amount + interest;
            document.getElementById("resolveFdWithdrawPreview").textContent =
                `Total payout: ${formatCurrency(tx.amount, tx.currency)} principal + ${formatCurrency(interest, tx.currency)} interest = ${formatCurrency(total, tx.currency)}`;
        }

        document.getElementById("resolveFdInterest") && document.getElementById("resolveFdInterest").addEventListener("input", () => {
            recalcResolveFdMaturity();
            recalcResolveFdWithdrawPreview();
        });

        async function confirmResolveFd() {
            const txId = parseInt(document.getElementById("resolveFdTxId").value);
            const txs = await readAllDB(STORES.TRANSACTIONS);
            const tx = txs.find(t => t.id === txId);
            if (!tx) { alert("Could not find this placement — it may have already been resolved."); closeModal("resolveFdModal"); return; }

            const holdingAccountId = tx.type === "transfer" ? tx.dest : tx.src;
            const interest = parseFloat(document.getElementById("resolveFdInterest").value);
            if (isNaN(interest) || interest < 0) { alert("Please enter a valid interest amount (0 if none)."); return; }

            const action = document.getElementById("resolveFdAction").value;
            const resolutionDate = document.getElementById("resolveFdResolutionDate").value;
            if (!resolutionDate) { alert("Please select a resolution date."); return; }
            // v168: previously always "(Ref: xxx)" / "(#id)" baked into these titles — but when a
            // reference number exists, the ledger row already shows it separately on its meta line
            // (via fdReferenceNo), so it was appearing twice on the same row. Now this only supplies
            // a "(#id)" fallback suffix for placements that have no reference number to show there.
            const refLabel = tx.fdReferenceNo ? "" : ` (#${tx.id})`;

            try {
                if (action === "withdraw") {
                    const destId = document.getElementById("resolveFdWithdrawDest").value;
                    if (!destId) { alert("Please choose an account to receive the proceeds."); return; }

                    // Move the principal out of the FD basket into the chosen account. This is a
                    // "transfer" (not "expense") — moving your own principal isn't a spend, so it
                    // must not be counted in the Expense report.
                    await writeDB(STORES.TRANSACTIONS, {
                        type: "transfer", desc: `FD Withdrawal — Principal${refLabel}`,
                        amount: tx.amount, src: holdingAccountId, dest: destId, currency: tx.currency,
                        cat: "Fixed Deposit", date: resolutionDate, image: null,
                        fdReferenceNo: tx.fdReferenceNo || null,
                        fdStartDate: null, fdTenureMonths: null, fdInterestRate: null, fdMaturityDate: null
                    });

                    // The interest, however, IS genuine new income — record it as such into the destination account.
                    if (interest > 0) {
                        await writeDB(STORES.TRANSACTIONS, {
                            type: "income", desc: `FD Interest Received${refLabel}`,
                            amount: interest, src: destId, dest: "", currency: tx.currency,
                            cat: "FD Interest Income", date: resolutionDate, image: null,
                            fdReferenceNo: tx.fdReferenceNo || null,
                            fdStartDate: null, fdTenureMonths: null, fdInterestRate: null, fdMaturityDate: null
                        });
                    }
                } else {
                    // Renew: close out the old placement's contribution to the FD basket, then open
                    // a fresh placement under the new terms (capitalizing interest, or principal-only
                    // with interest routed to another account). Both the closing and re-opening legs
                    // are "transfer" (not "expense"/"income") — this is capital moving within your own
                    // tracked funds, not money earned or spent, so it must not skew those reports.
                    const mode = document.getElementById("resolveFdRenewMode").value;
                    const newReference = document.getElementById("resolveFdNewReference").value.trim() || null;
                    const newStart = document.getElementById("resolveFdNewStart").value;
                    const newTenure = parseInt(document.getElementById("resolveFdNewTenure").value, 10);
                    const newRate = parseFloat(document.getElementById("resolveFdNewRate").value);
                    const newMaturity = document.getElementById("resolveFdNewMaturity").value;

                    if (!newStart) { alert("Please select a commencing date for the renewed placement."); return; }
                    if (isNaN(newTenure) || newTenure <= 0) { alert("Please enter a valid tenure for the renewed placement."); return; }
                    if (isNaN(newRate) || newRate < 0) { alert("Please enter a valid interest rate for the renewed placement."); return; }
                    if (!newMaturity) { alert("Could not calculate the new maturity date — please re-check the commencing date and tenure."); return; }

                    await writeDB(STORES.TRANSACTIONS, {
                        type: "transfer", desc: `FD Placement Closed for Renewal${refLabel}`,
                        amount: tx.amount, src: holdingAccountId, dest: "", currency: tx.currency,
                        cat: "Fixed Deposit", date: resolutionDate, image: null,
                        fdReferenceNo: tx.fdReferenceNo || null,
                        fdStartDate: null, fdTenureMonths: null, fdInterestRate: null, fdMaturityDate: null
                    });

                    const newPrincipal = mode === "capitalize" ? tx.amount + interest : tx.amount;
                    await writeDB(STORES.TRANSACTIONS, {
                        type: "transfer", desc: `FD Renewal Placement`,
                        amount: newPrincipal, src: "", dest: holdingAccountId, currency: tx.currency,
                        cat: "Fixed Deposit", date: resolutionDate, image: null,
                        fdReferenceNo: newReference,
                        fdStartDate: newStart, fdTenureMonths: newTenure, fdInterestRate: newRate, fdMaturityDate: newMaturity
                    });

                    if (mode === "principal" && interest > 0) {
                        const interestDestId = document.getElementById("resolveFdInterestDest").value;
                        if (!interestDestId) { alert("Please choose an account to receive the interest."); return; }
                        await writeDB(STORES.TRANSACTIONS, {
                            type: "income", desc: `FD Interest Received${refLabel}`,
                            amount: interest, src: interestDestId, dest: "", currency: tx.currency,
                            cat: "FD Interest Income", date: resolutionDate, image: null,
                            fdReferenceNo: tx.fdReferenceNo || null,
                            fdStartDate: null, fdTenureMonths: null, fdInterestRate: null, fdMaturityDate: null
                        });
                    }
                }

                // Flag the original placement as resolved so it drops out of the reminder scan.
                tx.fdResolved = true;
                await writeDB(STORES.TRANSACTIONS, tx);
            } catch (err) {
                alert("Could not complete this action: " + (err && err.message ? err.message : err));
                return;
            }

            closeModal("resolveFdModal");
            await refreshAfterTransactionChange();
        }

        // Direct Mobile Save execution avoiding forms issues
        async function handleTransactionSubmitMobile() {
            const txIdInput = document.getElementById("txId").value;
            const fdFieldsVisibleForDesc = document.getElementById("txFdFieldsWrap").style.display !== "none";
            const fdAutoDescMode = fdFieldsVisibleForDesc && !document.getElementById("txFdManualDesc").checked;
            const desc = fdAutoDescMode ? buildAutoFdDescription() : document.getElementById("txDesc").value.trim();
            const amountVal = document.getElementById("txAmount").value;
            const dateVal = document.getElementById("txDate").value;

            if(!desc || !amountVal) {
                alert("Please fill out both description and amount fields.");
                return;
            }

            const parsedAmount = parseFloat(amountVal);
            if (isNaN(parsedAmount) || parsedAmount <= 0) {
                alert("Please enter a valid amount greater than zero.");
                return;
            }

            if (!dateVal) {
                alert("Please select a date.");
                return;
            }

            if (document.getElementById("txManualFxWrap").style.display !== "none" && document.getElementById("txManualFxToggle").checked) {
                const manualRateVal = parseFloat(document.getElementById("txManualFxRate").value);
                if (isNaN(manualRateVal) || manualRateVal <= 0) {
                    alert("Please enter a valid manual FX rate greater than zero, or turn off manual FX to use the auto rate.");
                    return;
                }
            }

            // Transfer conversion (v33, redesigned v34) — both fields stay in sync with each
            // other as the user types (see recalcTransferFxFromRate/FromDestAmount), so by submit
            // time the Amount Received field already holds the number to store either way.
            let transferDestAmountOverride = null;
            if (document.getElementById("txTransferFxWrap").style.display !== "none" && document.getElementById("txTransferFxToggle").checked) {
                const destAmountVal = parseFloat(document.getElementById("txTransferDestAmount").value);
                if (isNaN(destAmountVal) || destAmountVal <= 0) {
                    alert("Please enter a valid exchange rate or amount received (greater than zero), or turn off manual conversion to use the auto rate.");
                    return;
                }
                transferDestAmountOverride = destAmountVal;
            }

            // Editing an existing Transfer that already carries the "Fixed Deposit" category (set
            // deliberately by the FD maturity-resolution flow, not through this form) should keep
            // it rather than losing it to the blanket "Transfers have no category" rule just below
            // — otherwise a routine edit (e.g. fixing a typo in the description) would silently
            // strip that tag.
            let preservedTransferCat = null;
            // v92: also look up the existing record (regardless of type) so an edit can carry its
            // splitGroupId forward — see the record.splitGroupId assignment below.
            let existingTxForEdit = null;
            if (txIdInput !== "") {
                const existingTxs = await readAllDB(STORES.TRANSACTIONS);
                existingTxForEdit = existingTxs.find(t => t.id === parseInt(txIdInput)) || null;
                if (document.getElementById("txType").value === "transfer" && existingTxForEdit && existingTxForEdit.cat === "Fixed Deposit") {
                    preservedTransferCat = "Fixed Deposit";
                }
            }

            // v121: persist attachments before building the record. tempTxAttachments (newly
            // picked, full data inline) each get a fresh IndexedDB id; existingTxAttachments
            // entries are either already-saved refs (kept as-is) or — for a legacy pre-v121
            // entry — a `legacyData` payload that gets migrated into a real IndexedDB attachment
            // right now. Anything present on the ORIGINAL record but no longer in the kept list
            // (i.e. removed via the ✕ button) is deleted from IndexedDB only after the
            // transaction itself saves successfully, so a failed save doesn't orphan-delete data
            // still referenced by the untouched original record.
            let finalAttachments = [];
            let attachmentIdsToDelete = [];
            try {
                for (const att of existingTxAttachments) {
                    if (att.legacyData) {
                        const id = makeAttId();
                        await writeDB(STORES.ATTACHMENTS, { id, name: att.name, mime: att.mime, data: att.legacyData });
                        finalAttachments.push({ id, name: att.name, mime: att.mime, thumb: att.thumb, size: att.size });
                    } else {
                        finalAttachments.push({ id: att.id, name: att.name, mime: att.mime, thumb: att.thumb, size: att.size });
                    }
                }
                for (const att of tempTxAttachments) {
                    const id = makeAttId();
                    await writeDB(STORES.ATTACHMENTS, { id, name: att.name, mime: att.mime, data: att.data });
                    finalAttachments.push({ id, name: att.name, mime: att.mime, thumb: att.thumb, size: att.size });
                }
            } catch (err) {
                const msg = (err && err.name === "QuotaExceededError")
                    ? "Not enough storage space to save these attachments. Try removing one or freeing up space."
                    : "Could not save attachments: " + (err && err.message ? err.message : err);
                alert(msg);
                return;
            }
            const originalAttachmentIds = new Set(
                (existingTxForEdit && Array.isArray(existingTxForEdit.attachments) ? existingTxForEdit.attachments.map(a => a.id) : []).filter(Boolean)
            );
            const keptAttachmentIds = new Set(finalAttachments.map(a => a.id).filter(Boolean));
            attachmentIdsToDelete = [...originalAttachmentIds].filter(id => !keptAttachmentIds.has(id));

            const record = {
                type: document.getElementById("txType").value,
                desc: desc,
                amount: parsedAmount,
                src: document.getElementById("srcAccount").value,
                // "To Account" only applies to Transfers — the <select> can carry a leftover
                // value from an earlier Transfer entry (the field is hidden, not cleared, when
                // switching to Income/Expense), so it's forced to null here rather than trusted
                // as-is; otherwise a stale `dest` makes this record wrongly appear in that other
                // account's ledger too (see the isBound check in renderApp()).
                dest: document.getElementById("txType").value === "transfer" ? document.getElementById("destAccount").value : null,
                currency: document.getElementById("txCurrency").value,
                // Category only applies to Income/Expense — the <select> is hidden (not cleared)
                // for Transfers, and forced to null here rather than trusted as-is; otherwise a
                // stale/leftover category value gets saved onto the Transfer record and shown as
                // e.g. "[Commute]" on the ledger even though Transfers have no category.
                cat: document.getElementById("txType").value === "transfer" ? preservedTransferCat : document.getElementById("txCategory").value,
                date: dateVal,
                image: null, // v121: superseded by `attachments` below; kept null going forward (legacy entries are migrated into `attachments` above the moment they're next edited).
                attachments: finalAttachments,
                // v88: To/From (payee) and free-text Notes — optional on every type, blank stored as
                // null (not "") so existing code that checks `t.notes` truthy keeps working unchanged.
                // v96: the "To/From" field itself was removed from the entry form (Notes now covers
                // that need — see the list-row rendering below), so this no longer reads from an
                // input; it just carries forward whatever an existing record already had, rather than
                // silently wiping historic payee data the moment an old entry is edited and re-saved.
                payee: existingTxForEdit ? existingTxForEdit.payee : null,
                notes: document.getElementById("txNotes").value.trim() || null,
                checked: document.getElementById("txChecked").checked,
                fdReferenceNo: null,
                fdStartDate: null,
                fdTenureMonths: null,
                fdInterestRate: null,
                fdMaturityDate: null,
                // Manual FX rate override (v32) — only meaningful for Income/Expense against a
                // "normal" account when the entry's currency differs from the account's currency.
                // null means "auto": convert using the live global fxRates table, as before.
                manualFxRate: (document.getElementById("txManualFxWrap").style.display !== "none" && document.getElementById("txManualFxToggle").checked)
                    ? (parseFloat(document.getElementById("txManualFxRate").value) || null)
                    : null,
                // Transfer received-amount override (v33) — only meaningful for a Transfer
                // between two "normal" accounts with different currencies. null means "auto":
                // the destination account is credited via a live currency conversion each time
                // the app renders, as before (see computeAccountBalances()/applyToAccountBalance()).
                destAmount: transferDestAmountOverride,
                // v92 fix: writeDB() does a full put() that replaces the entire stored record, so
                // an edit that omitted this field was silently stripping splitGroupId off of split
                // parts, ungrouping them into standalone transactions the moment they were edited
                // (this record object never set splitGroupId at all before v92). Carry the
                // existing value forward on every edit; stays undefined for a brand-new entry,
                // where the split-save branch below assigns its own freshly generated one anyway.
                splitGroupId: existingTxForEdit ? existingTxForEdit.splitGroupId : undefined
            };

            // v88: Refund — set only by openRefundFromOptions(), which opens this same form as a
            // plain Income entry with the category locked to the original expense's category.
            // Tagging it here (rather than a separate save path) means it inherits every other
            // field/validation above for free; renderApp()/renderSavingsStatement()/the Spending
            // & Income Breakdown pages special-case isRefund so it reduces the original expense
            // category instead of counting as income (see those functions), while
            // computeAccountBalances() needs no change at all — crediting the account back is
            // exactly what an ordinary income record already does.
            if (pendingRefundOf !== null && record.type === "income") {
                record.isRefund = true;
                record.refundOf = pendingRefundOf;
            }

            const fdFieldsVisible = document.getElementById("txFdFieldsWrap").style.display !== "none";
            if (fdFieldsVisible) {
                const fdStartDate = document.getElementById("txFdStartDate").value;
                const fdTenureMonths = parseInt(document.getElementById("txFdTenureMonths").value, 10);
                const fdInterestRate = parseFloat(document.getElementById("txFdInterestRate").value);
                const fdMaturityDate = document.getElementById("txFdMaturityDate").value;
                const fdReferenceNo = document.getElementById("txFdReference").value.trim() || null;

                if (!fdStartDate) { alert("Please select a commencing date for this Fixed Deposit placement."); return; }
                if (isNaN(fdTenureMonths) || fdTenureMonths <= 0) { alert("Please enter a valid tenure (in months) for this placement."); return; }
                if (isNaN(fdInterestRate) || fdInterestRate < 0) { alert("Please enter a valid interest rate for this placement."); return; }
                if (!fdMaturityDate) { alert("Could not calculate a maturity date — please re-check the commencing date and tenure."); return; }

                record.fdReferenceNo = fdReferenceNo;
                record.fdStartDate = fdStartDate;
                record.fdTenureMonths = fdTenureMonths;
                record.fdInterestRate = fdInterestRate;
                record.fdMaturityDate = fdMaturityDate;
            }

            if (txIdInput !== "") {
                record.id = parseInt(txIdInput);
            }

            // v88: Split Expenses — only reachable for a brand-new Income/Expense entry (the
            // #txSplitWrap UI is hidden for Transfers and for any edit — see openTransactionForm()
            // and index.html's comment on #txSplitWrap), so this never fires for an edit or a
            // Transfer even if stale rows were somehow left in the DOM. Each split row becomes its
            // own ordinary transaction record — same account/date/desc/payee/notes/checked as the
            // main row above, just its own category+amount — sharing a generated splitGroupId
            // purely for traceability. Because every row is a completely normal record, every
            // existing balance/report calculation already handles it correctly with no changes.
            const isNewEntry = txIdInput === "";
            const splitEligible = isNewEntry && (record.type === "income" || record.type === "expense");
            const splitRows = splitEligible ? collectTxSplitRows() : [];

            try {
                if (splitRows.length > 0) {
                    const splitGroupId = "split_" + Date.now() + "_" + Math.floor(Math.random() * 100000);
                    record.splitGroupId = splitGroupId;
                    await writeDB(STORES.TRANSACTIONS, record);
                    for (const row of splitRows) {
                        const extraRecord = Object.assign({}, record, { cat: row.cat, amount: row.amount, splitGroupId });
                        delete extraRecord.id;
                        // Only the first (main) row in a split carries the attachments, if any —
                        // attaching the same files to every split part would be misleading.
                        extraRecord.image = null;
                        extraRecord.attachments = [];
                        await writeDB(STORES.TRANSACTIONS, extraRecord);
                    }
                } else {
                    await writeDB(STORES.TRANSACTIONS, record);
                }
            } catch (err) {
                const msg = (err && err.name === "QuotaExceededError")
                    ? "Not enough storage space to save this transaction. Try removing an attachment or freeing up space."
                    : "Could not save transaction: " + (err && err.message ? err.message : err);
                alert(msg);
                return;
            }
            // Only delete newly-orphaned attachment blobs after the transaction itself saved
            // successfully (see the comment above where attachmentIdsToDelete is computed).
            for (const id of attachmentIdsToDelete) {
                try { await deleteDB(STORES.ATTACHMENTS, id); } catch (err) { /* non-fatal — a leftover blob costs storage, not correctness */ }
            }
            pendingRefundOf = null;
            closeModal("txModal");
            await refreshAfterTransactionChange();
        }

        // --- SALARY ENTRY (Gross Salary → Net Bank + EPF(Malaysia)/CPF(Singapore) split) ---
        // Opens with an empty form: today's date, an auto-filled "<Month> <Year> Salary"
        // description (editable), scheme defaulted to "none", and both account dropdowns
        // listing every account (sorted group-then-name, owner shown per accountOptionLabel) —
        // same convention as the ordinary Income/Expense/Transfer form's own account pickers.
        // v138 added four fixed, always-visible optional allowance fields (Housing Allowance,
        // Handphone Claim, Overseas Allowance, Backpay) — each folds into the "Gross Salary"
        // total shown in the preview but never passes through the EE/ER split (see
        // recalcSalaryPreview()/handleSaveSalaryRecord()); each non-zero amount is saved as its
        // own Income leg straight to the Bank Account under its own category (seeded as
        // Subcategories of "Salary" in DEFAULT_CATEGORIES). v140 added an optional "Backpay
        // Note" free-text field (shown once Backpay > 0) saved into the Backpay leg's own
        // `notes` field only — the other three allowance legs still save notes: null.
        async function openSalaryEntryForm() {
            const accounts = await readAllDB(STORES.ACCOUNTS);
            if (accounts.length === 0) { alert("Add an account first!"); return; }

            const now = new Date();
            document.getElementById("salaryDate").value = now.toISOString().slice(0, 10);
            const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
            document.getElementById("salaryDesc").value = `${monthNames[now.getMonth()]} ${now.getFullYear()} Salary`;

            const memberSelect = document.getElementById("salaryMemberSelect");
            memberSelect.innerHTML = `<option value="all">All Members (show every account)</option>`;
            membersCache.forEach(m => { memberSelect.innerHTML += `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`; });
            // v155: when the household only has one member set up, there's no real choice to make —
            // auto-select that member instead of defaulting to "All Members", and run the same
            // smart-default logic a manual pick would trigger (Bank Account / EPF-CPF Account
            // nudged toward that member's own accounts). With 2+ members "All Members" remains the
            // safer default since guessing which one just got paid isn't possible.
            memberSelect.value = membersCache.length === 1 ? membersCache[0].id : "all";
            syncAccountPickerButtonText("salaryMemberSelect");

            document.getElementById("salaryScheme").value = "none";
            syncAccountPickerButtonText("salaryScheme");
            document.getElementById("salaryGross").value = "";
            document.getElementById("salaryEEAmount").value = "";
            document.getElementById("salaryERAmount").value = "";
            document.getElementById("salaryHousingAllowance").value = "";
            document.getElementById("salaryHandphoneClaim").value = "";
            document.getElementById("salaryOverseasAllowance").value = "";
            document.getElementById("salaryBackpay").value = "";
            document.getElementById("salaryBackpayNote").value = "";
            document.getElementById("salaryBackpayNoteRow").style.display = "none";

            const currSelect = document.getElementById("salaryCurrency");
            currSelect.innerHTML = Object.keys(fxRates).sort((a, b) => a.localeCompare(b)).map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
            currSelect.value = baseCurrency;
            syncAccountPickerButtonText("salaryCurrency");

            const catSelect = document.getElementById("salaryCategory");
            catSelect.innerHTML = buildCategoryOptionsHTML("income", dynamicCategories.filter(c => c.type === "income").map(c => c.name));
            catSelect.value = "Salary";
            syncAccountPickerButtonText("salaryCategory");

            populateSalaryAccountSelects(accounts);
            // Bank Account defaults to Default Receive Account, if one is set and still exists —
            // same setting the ordinary Income form now also defaults to (see openTransactionForm()).
            if (defaultReceiveAccount && accounts.some(a => a.id === defaultReceiveAccount)) {
                document.getElementById("salaryBankAccount").value = defaultReceiveAccount;
                syncAccountPickerButtonText("salaryBankAccount");
            }
            // Member defaults to "All Members" unless the household only has one member (handled
            // above), in which case run the same smart-default logic a manual pick would trigger —
            // nudging Bank Account / EPF-CPF Account toward that member's own accounts. Picking a
            // different Member afterward re-runs this via handleSalaryMemberChange() either way.
            if (memberSelect.value !== "all") await handleSalaryMemberChange();
            await handleSalarySchemeChange();
            recalcSalaryPreview();
            openModal("salaryModal");
        }

        // Builds the two account <select>s (Bank Account, EPF/CPF Account) — always with EVERY
        // account (sorted group-then-name), regardless of which Member is picked above. A member
        // may legitimately bank their salary into a joint account (or one nominally owned by
        // their spouse) rather than only an account solely in their own name, so the Member
        // picker must never remove options from either dropdown — it only nudges the default
        // selection (see handleSalaryMemberChange()). Option text/format matches the
        // Income/Expense/Transfer form's own Account picker exactly (same type-prefix emoji,
        // currency suffix, and " — Owner" suffix) — see openTransactionForm()'s srcSelect/
        // destSelect population, which this mirrors — since both pickers share the same
        // account-picker-btn + accountPickerModal UI (see openAccountPicker()).
        function populateSalaryAccountSelects(accounts) {
            const sorted = sortAccountsByGroupThenName(accounts);
            const optionsHTML = sorted.map(a => {
                const prefix = a.type === "fd" ? "🏦 " : a.type === "multi" ? "💱 " : a.type === "unittrust" ? "📊 " : a.type === "creditcard" ? "💳 " : "";
                const currLabel = (a.type === "multi" || a.type === "fd" || a.type === "unittrust") ? "" : ` (${escapeHtml(a.currency)})`;
                const ownerLabel = ` — ${escapeHtml(accountOwnerNamesText(a) + accountRelatedSuffix(a, accounts))}`;
                return `<option value="${escapeHtml(a.id)}">${prefix}${escapeHtml(a.name)}${currLabel}${ownerLabel}</option>`;
            }).join("");
            document.getElementById("salaryBankAccount").innerHTML = optionsHTML;
            document.getElementById("salaryContribAccount").innerHTML = optionsHTML;
            syncAccountPickerButtonText("salaryBankAccount");
            syncAccountPickerButtonText("salaryContribAccount");
        }

        // Re-picking a Member never narrows either dropdown (see populateSalaryAccountSelects) —
        // it only nudges the two selects toward a sensible default for that person, so the full
        // account list (including joint accounts) stays reachable either way: Bank Account
        // defaults to their own solely-owned Bank/Cash account if one exists (but ONLY when no
        // Default Receive Account is configured — see below); EPF/CPF Account defaults to any
        // account under the Investment group's KWSP or CPF sub-group they're an owner of, matching
        // whichever subgroup the currently-selected Scheme calls for (see
        // updateContribAccountDefault() below) — solo OR joint, since a household's EPF/CPF pot is
        // sometimes filed jointly. Left alone (no default change) when no match is found — "All
        // Members" or a member with no matching account never overwrites whatever the user already
        // picked by hand.
        async function handleSalaryMemberChange() {
            const memberId = document.getElementById("salaryMemberSelect").value;
            if (memberId === "all") return;
            const accounts = await readAllDB(STORES.ACCOUNTS);

            // Default Receive Account is an explicit, deliberate setting (Sidebar ▸ Accounts) —
            // it should win over this per-member guess, not get silently overwritten by it.
            // openSalaryEntryForm() already applies it once when the modal opens (while Member is
            // still "All Members"); this only re-nudges Bank Account toward the member's own solo
            // account when there's no Default Receive Account configured to defer to instead.
            const hasDefaultReceive = defaultReceiveAccount && accounts.some(a => a.id === defaultReceiveAccount);
            if (!hasDefaultReceive) {
                const soloBank = accounts.find(a =>
                    Array.isArray(a.memberIds) && a.memberIds.length === 1 && a.memberIds[0] === memberId &&
                    (a.group || DEFAULT_ACCOUNT_GROUP) === "Bank/Cash"
                );
                if (soloBank) {
                    document.getElementById("salaryBankAccount").value = soloBank.id;
                    syncAccountPickerButtonText("salaryBankAccount");
                }
            }

            updateContribAccountDefault(accounts, memberId);
        }

        // Shared by handleSalaryMemberChange() (member just picked) and handleSalarySchemeChange()
        // (scheme just picked/changed) — whichever fires later "wins" the default, matching how a
        // user actually fills the form in either order. Matches the EPF/CPF Account dropdown to an
        // Investment-group account under the subgroup the CURRENT Scheme calls for specifically
        // (KWSP for "epf", CPF for "cpf") rather than either subgroup — previously this matched
        // "KWSP or CPF" regardless of Scheme, so a member with both a KWSP and a CPF account could
        // land on the wrong one depending on which happened to come first in account order (e.g.
        // Scheme = CPF (Singapore) but the KWSP (MYR) account stayed selected). No-ops when Scheme
        // is "none" (no subgroup to match) or Member is still "All Members" (memberId undefined).
        function updateContribAccountDefault(accounts, memberId) {
            if (!memberId || memberId === "all") return;
            const scheme = document.getElementById("salaryScheme").value;
            const wantSubgroup = scheme === "epf" ? "KWSP" : scheme === "cpf" ? "CPF" : null;
            if (!wantSubgroup) return;
            const contribAcc = accounts.find(a =>
                Array.isArray(a.memberIds) && a.memberIds.includes(memberId) &&
                (a.group || DEFAULT_ACCOUNT_GROUP) === "Investment" && a.subgroup === wantSubgroup
            );
            if (contribAcc) {
                document.getElementById("salaryContribAccount").value = contribAcc.id;
                syncAccountPickerButtonText("salaryContribAccount");
            }
        }

        // Shows/hides the EE/ER fields and the EPF/CPF Account row, and relabels everything
        // (EPF vs CPF wording) based on the chosen scheme. "None" collapses this to a plain
        // single-leg salary entry — Gross goes straight to the Bank Account as one Income record.
        // Also auto-sets the Currency selector to each scheme's natural currency (MYR for EPF,
        // SGD for CPF) — a plain "Salary" (no scheme) leaves whatever currency was already
        // chosen alone, since there's no single natural currency to default it to.
        async function handleSalarySchemeChange() {
            const scheme = document.getElementById("salaryScheme").value;
            const isEpf = scheme === "epf";
            const isCpf = scheme === "cpf";
            const hasScheme = isEpf || isCpf;

            document.getElementById("salaryContribAccountRow").style.display = hasScheme ? "block" : "none";
            document.getElementById("salaryContribRow").style.display = hasScheme ? "grid" : "none";

            const contribLabel = isEpf ? "EPF / KWSP Account" : isCpf ? "CPF Account" : "Contribution Account";
            document.getElementById("salaryContribAccountLabel").textContent = contribLabel;
            document.getElementById("salaryContribAccountBtn").dataset.title = `Select ${contribLabel}`;
            document.getElementById("salaryEELabel").textContent = isEpf ? "EPF Employee (EE)" : "CPF Employee (EE)";
            document.getElementById("salaryERLabel").textContent = isEpf ? "EPF Employer (ER)" : "CPF Employer (ER)";
            document.getElementById("salaryPreviewEELabel").textContent = isEpf ? "EPF (EE)" : "CPF (EE)";
            document.getElementById("salaryPreviewERLabel").textContent = isEpf ? "EPF (ER)" : "CPF (ER)";

            const currSelect = document.getElementById("salaryCurrency");
            const schemeCurrency = isEpf ? "MYR" : isCpf ? "SGD" : null;
            if (schemeCurrency && fxRates[schemeCurrency] !== undefined) {
                currSelect.value = schemeCurrency;
                syncAccountPickerButtonText("salaryCurrency");
            }

            if (hasScheme) {
                const memberId = document.getElementById("salaryMemberSelect").value;
                const accounts = await readAllDB(STORES.ACCOUNTS);
                updateContribAccountDefault(accounts, memberId);
            }

            recalcSalaryPreview();
        }

        function handleSalaryCurrencyChange() {
            recalcSalaryPreview();
        }

        // Live preview box (mirrors the reference screenshot's "Gross → Bank + EPF" breakdown):
        // Bank leg = (base Gross − EE) + allowances — EE never appears twice (deducted from
        // gross, not on top of it), and allowances are added straight into the Bank leg without
        // ever passing through the EE/ER split (Housing/Handphone/Overseas/Backpay aren't
        // statutory-deductible). The "Gross Salary" total line shown up top is base + all four
        // allowances combined, so the preview reads as one true gross-pay figure even though only
        // the base portion actually goes through the EPF/CPF split below it. The ER leg is purely
        // additive, shown only when > 0, and never subtracted from the Bank leg since the
        // employer's contribution never touches the employee's pay. Every figure is formatted in
        // the currently selected Currency (RM for MYR, S$ for SGD, etc.) so the preview reads the
        // same as whatever currency the saved legs will actually use.
        function recalcSalaryPreview() {
            const scheme = document.getElementById("salaryScheme").value;
            const hasScheme = scheme === "epf" || scheme === "cpf";
            const currency = document.getElementById("salaryCurrency").value;
            const baseGross = parseFloat(document.getElementById("salaryGross").value) || 0;
            const ee = hasScheme ? (parseFloat(document.getElementById("salaryEEAmount").value) || 0) : 0;
            const er = hasScheme ? (parseFloat(document.getElementById("salaryERAmount").value) || 0) : 0;
            const housing = parseFloat(document.getElementById("salaryHousingAllowance").value) || 0;
            const handphone = parseFloat(document.getElementById("salaryHandphoneClaim").value) || 0;
            const overseas = parseFloat(document.getElementById("salaryOverseasAllowance").value) || 0;
            const backpay = parseFloat(document.getElementById("salaryBackpay").value) || 0;
            const allowanceTotal = housing + handphone + overseas + backpay;
            const totalGross = baseGross + allowanceTotal;
            const net = (baseGross - ee) + allowanceTotal;

            document.getElementById("salaryPreviewGross").textContent = formatCurrency(totalGross, currency);
            document.getElementById("salaryPreviewNet").textContent = formatCurrency(net, currency);
            document.getElementById("salaryPreviewEERow").style.display = (hasScheme && ee > 0) ? "flex" : "none";
            document.getElementById("salaryPreviewERRow").style.display = (hasScheme && er > 0) ? "flex" : "none";
            document.getElementById("salaryPreviewEE").textContent = formatCurrency(ee, currency);
            document.getElementById("salaryPreviewER").textContent = formatCurrency(er, currency);

            document.getElementById("salaryPreviewHousingRow").style.display = housing > 0 ? "flex" : "none";
            document.getElementById("salaryPreviewHandphoneRow").style.display = handphone > 0 ? "flex" : "none";
            document.getElementById("salaryPreviewOverseasRow").style.display = overseas > 0 ? "flex" : "none";
            document.getElementById("salaryPreviewBackpayRow").style.display = backpay > 0 ? "flex" : "none";
            document.getElementById("salaryPreviewHousing").textContent = formatCurrency(housing, currency);
            document.getElementById("salaryPreviewHandphone").textContent = formatCurrency(handphone, currency);
            document.getElementById("salaryPreviewOverseas").textContent = formatCurrency(overseas, currency);
            document.getElementById("salaryPreviewBackpay").textContent = formatCurrency(backpay, currency);

            // Backpay Note only makes sense once there's a Backpay amount to attach it to —
            // hidden (not cleared) when Backpay drops back to 0, so re-entering an amount
            // restores whatever note was already typed.
            document.getElementById("salaryBackpayNoteRow").style.display = backpay > 0 ? "flex" : "none";
        }

        // Saves 1–3 ordinary Income transactions (Bank leg always; EE/ER legs only when a
        // scheme is chosen and that amount is > 0) sharing a generated salaryGroupId — purely
        // for traceability, same pattern as Split Expenses' splitGroupId. Every existing
        // balance/report calculation already handles a plain Income record correctly, so
        // nothing downstream needed to change to support this. All three legs are recorded in
        // the form's own selected Currency (not necessarily each account's native currency) —
        // computeAccountBalances() already converts a transaction's currency into its account's
        // own currency at the live FX rate when they differ, same as every other Income/Expense
        // entry in the app, so a currency mismatch here is handled exactly like anywhere else.
        // The Bank leg's category comes from the Category select (defaults to "Salary", but any
        // of its Subcategories — e.g. a per-member "Salary -VF" — can be picked directly here
        // instead of having to manually re-categorize the transaction afterward).
        async function handleSaveSalaryRecord() {
            const date = document.getElementById("salaryDate").value;
            const desc = document.getElementById("salaryDesc").value.trim();
            const bankAccountId = document.getElementById("salaryBankAccount").value;
            const category = document.getElementById("salaryCategory").value;
            const scheme = document.getElementById("salaryScheme").value;
            const hasScheme = scheme === "epf" || scheme === "cpf";
            const contribAccountId = document.getElementById("salaryContribAccount").value;
            const currency = document.getElementById("salaryCurrency").value;
            const gross = parseFloat(document.getElementById("salaryGross").value);
            const ee = hasScheme ? (parseFloat(document.getElementById("salaryEEAmount").value) || 0) : 0;
            const er = hasScheme ? (parseFloat(document.getElementById("salaryERAmount").value) || 0) : 0;
            const housing = parseFloat(document.getElementById("salaryHousingAllowance").value) || 0;
            const handphone = parseFloat(document.getElementById("salaryHandphoneClaim").value) || 0;
            const overseas = parseFloat(document.getElementById("salaryOverseasAllowance").value) || 0;
            const backpay = parseFloat(document.getElementById("salaryBackpay").value) || 0;
            const backpayNote = document.getElementById("salaryBackpayNote").value.trim() || null;

            if (!date) { alert("Please select a date."); return; }
            if (!desc) { alert("Please enter a description."); return; }
            if (!bankAccountId) { alert("Please select a Bank Account."); return; }
            if (!category) { alert("Please select a Category."); return; }
            if (isNaN(gross) || gross <= 0) { alert("Please enter a valid Gross Salary greater than zero."); return; }
            if (hasScheme && !contribAccountId) { alert("Please select an EPF/CPF Account, or switch Scheme to \"None\"."); return; }
            if (ee < 0 || er < 0) { alert("EE/ER amounts can't be negative."); return; }
            if (ee > gross) { alert("EE contribution can't be greater than Gross Salary."); return; }
            if (housing < 0 || handphone < 0 || overseas < 0 || backpay < 0) { alert("Allowance amounts can't be negative."); return; }

            // Housing/Handphone/Overseas/Backpay are additive allowances that never pass through
            // the EE/ER split (see recalcSalaryPreview()) — each is its own Income leg, in its
            // own category, straight to the Bank Account. The base salary's Net leg (Gross − EE)
            // is unaffected by their presence.
            const netAmount = gross - ee;
            const salaryGroupId = "salary_" + Date.now() + "_" + Math.floor(Math.random() * 100000);

            const baseRecord = {
                type: "income", desc, date, currency, notes: null, payee: null, checked: false, image: null,
                fdReferenceNo: null, fdStartDate: null, fdTenureMonths: null, fdInterestRate: null, fdMaturityDate: null,
                manualFxRate: null, destAmount: null, dest: null, salaryGroupId
            };

            try {
                if (netAmount > 0) {
                    await writeDB(STORES.TRANSACTIONS, Object.assign({}, baseRecord, {
                        amount: netAmount, src: bankAccountId, cat: category
                    }));
                }
                if (hasScheme && ee > 0) {
                    await writeDB(STORES.TRANSACTIONS, Object.assign({}, baseRecord, {
                        amount: ee, src: contribAccountId,
                        cat: scheme === "epf" ? "EPF Contrib.(EE)" : "CPF Contrib.(EE)"
                    }));
                }
                if (hasScheme && er > 0) {
                    await writeDB(STORES.TRANSACTIONS, Object.assign({}, baseRecord, {
                        amount: er, src: contribAccountId,
                        cat: scheme === "epf" ? "EPF Contrib.(ER)" : "CPF Contrib.(ER)"
                    }));
                }
                const allowanceLegs = [
                    { amount: housing, cat: "Housing Allowance", notes: null },
                    { amount: handphone, cat: "Handphone Claim", notes: null },
                    { amount: overseas, cat: "Overseas Allowance", notes: null },
                    { amount: backpay, cat: "Backpay", notes: backpayNote }
                ];
                for (const leg of allowanceLegs) {
                    if (leg.amount > 0) {
                        await writeDB(STORES.TRANSACTIONS, Object.assign({}, baseRecord, {
                            amount: leg.amount, src: bankAccountId, cat: leg.cat, notes: leg.notes
                        }));
                    }
                }
            } catch (err) {
                alert("Could not save salary record: " + (err && err.message ? err.message : err));
                return;
            }

            closeModal("salaryModal");
            await refreshAfterTransactionChange();
        }

        // Delete button inside the "Edit Ledger Entry" modal itself — the ledger list no longer
        // has its own per-row delete affordance (tapping a row opens this modal instead; deleting
        // now happens from within it). Only shown when editing an existing entry (txDeleteBtn is
        // hidden for a brand-new entry, where there's nothing yet to delete).
        async function deleteTxFromEditModal() {
            const txIdInput = document.getElementById("txId").value;
            if (!txIdInput) return;
            const ok = await deleteTransactionById(parseInt(txIdInput), /* alreadyConfirmed */ false, /* skipModalClose */ true);
            if (ok) closeModal("txModal");
        }

        // Shared delete-by-id, used by the Edit modal's own Delete button above and by "Delete
        // transaction" in the Quick View Options menu (deleteTransactionFromOptions()). Confirms
        // first unless the caller already did (the Options menu path shows its own confirm-free
        // flow through customConfirm here too, so alreadyConfirmed is currently always false —
        // kept as a parameter in case a future caller has already confirmed some other way).
        async function deleteTransactionById(id, alreadyConfirmed = false, skipModalClose = false) {
            if (!id) return false;
            if (!alreadyConfirmed) {
                const ok = await customConfirm("Delete this transaction item?");
                if (!ok) return false;
            }
            try {
                const tx = (await readAllDB(STORES.TRANSACTIONS)).find(t => t.id === id);
                if (tx) await deleteTxAttachments(tx);
                await deleteDB(STORES.TRANSACTIONS, id);
            } catch (err) {
                alert("Could not delete transaction: " + (err && err.message ? err.message : err));
                return false;
            }
            if (!skipModalClose) closeModal("txModal");
            await refreshAfterTransactionChange();
            return true;
        }

        // --- TRANSACTION QUICK VIEW / OPTIONS (v88) ---
        // Tapping a ledger row opens this Quick View instead of jumping straight into the full
        // Edit form — a glance at the amount/account/payee/notes, a one-tap Checked toggle
        // (matching a credit-card-style "tally against statement" workflow), and a ⋮ menu for
        // Duplicate / Edit / Refund / Delete. "Edit transaction" from that menu still opens the
        // exact same txModal as before; nothing about editing itself changed.
        async function openTxQuickView(el) {
            const id = Number(el.dataset.id);
            if (!id) return;
            const txs = await readAllDB(STORES.TRANSACTIONS);
            const tx = txs.find(t => t.id === id);
            if (!tx) return;
            // Fund transactions (Buy/Sell/Dividend/Contribution) keep a linked fund's unit balance
            // in sync and already have their own dedicated editor — Quick View doesn't apply to
            // them (no Checked/Refund/Duplicate concept for a fund-linked row), so fall straight
            // through to the normal edit flow exactly as tapping used to do everywhere.
            if (tx.fundId) {
                activeQuickViewSplitGroup = null;
                await openTransactionForm(tx.type, id);
                return;
            }

            activeQuickViewTxId = id;
            const splitInfo = tx.splitGroupId ? getSplitGroupInfo(tx, txs) : null;
            if (splitInfo) { splitInfo.type = tx.type; splitInfo.currency = tx.currency; }
            activeQuickViewSplitGroup = splitInfo;
            const accounts = await readAllDB(STORES.ACCOUNTS);
            const accountName = accId => { if (!accId) return "(Opening Balance)"; const a = accounts.find(acc => acc.id === accId); return a ? escapeHtml(accountOptionLabel(a, accounts)) : "(deleted account)"; };

            let headerColor, sgn;
            if (tx.type === "income") { headerColor = "var(--income-color)"; sgn = "+"; }
            else if (tx.type === "expense") { headerColor = "var(--expense-color)"; sgn = "-"; }
            else { headerColor = "var(--primary)"; sgn = "🔄"; }

            document.getElementById("txQuickViewHeader").style.background = headerColor;
            document.getElementById("txQuickViewAmount").textContent = `${sgn}${formatCurrency(splitInfo ? splitInfo.totalAmount : tx.amount, tx.currency)}`;
            document.getElementById("txQuickViewDate").textContent = tx.date;

            const icon = tx.type === "transfer"
                ? "🔄"
                : (splitInfo ? splitInfo.members.map(m => getCategoryIcon(m.cat, tx.type)).join("") : getCategoryIcon(tx.cat, tx.type));
            document.getElementById("txQuickViewDesc").textContent = `${icon} ${tx.desc}`;

            let destLine = "";
            if (tx.type === "transfer") {
                destLine = `<div>To Account: ${tx.dest ? accountName(tx.dest) : "(unknown)"}</div>`;
            }
            const refundLine = tx.isRefund ? `<div style="color:var(--income-color); font-weight:700;">↩️ Refund entry</div>` : "";

            // v91: a Split Expense group's breakdown — one line per category+amount part,
            // matching the reference screenshots — shown above the Account/To/Notes fields
            // (identical across every member; see saveTransactionSubmit()'s splitGroupId
            // comment), in place of the single "Category: X" line an ordinary entry gets.
            const splitBreakdownHTML = splitInfo
                ? splitInfo.members.map(m => `
                    <div style="display:flex; justify-content:space-between;">
                        <span>${getCategoryIcon(m.cat, tx.type)} ${escapeHtml(m.cat)}</span>
                        <span>${sgn}${formatCurrency(m.amount, tx.currency)}</span>
                    </div>
                `).join("")
                : "";

            // v121 fix: attachments were only reachable via the small 📎 badge on the ledger
            // list row (easy to miss/mis-tap) — surfaced here in Quick View too, since tapping
            // the row itself (opening this modal) is the primary way people open a transaction.
            // On a split group, only the representative/main row carries attachments (see the
            // v88/v91 comments on saveTransactionSubmit() and the list-row renderer), so `tx`
            // here already has the right ones regardless of splitInfo.
            let quickViewAtts = Array.isArray(tx.attachments) ? tx.attachments : [];
            if (quickViewAtts.length === 0 && tx.image) {
                quickViewAtts = [{ name: "Receipt.jpg", mime: "image/jpeg", data: tx.image }];
            }
            txAttachmentsPickerCurrent = quickViewAtts; // reused by openAttachmentFromQuickView() below
            const attachmentsHTML = quickViewAtts.length ? `
                <div style="margin-top:4px;">
                    <div style="font-size:0.7rem; font-weight:700; color:var(--text-muted); text-transform:uppercase; margin-bottom:6px;">Attachments</div>
                    <div style="display:flex; flex-direction:column; gap:6px;">
                        ${quickViewAtts.map((att, idx) => `
                            <div class="tx-att-item" data-click="openAttachmentFromQuickView" data-idx="${idx}" style="display:flex; align-items:center; gap:8px; background:var(--chip-bg); border:1px solid var(--border-color); border-radius:8px; padding:6px 8px; cursor:pointer;">
                                <div style="width:32px; height:32px; border-radius:6px; overflow:hidden; flex-shrink:0; display:flex; align-items:center; justify-content:center; background:var(--chip-bg); font-size:1rem;">
                                    ${att.thumb || ((att.mime || "").startsWith("image/") && att.data) ? `<img src="${att.thumb || att.data}" alt="" style="width:100%; height:100%; object-fit:cover;">` : ((att.mime || "").startsWith("image/") ? "🖼️" : "📄")}
                                </div>
                                <div style="flex:1; min-width:0; font-size:0.78rem; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(att.name || "Attachment")}</div>
                                <span style="font-size:0.7rem; color:var(--text-muted); flex-shrink:0;">View ›</span>
                            </div>
                        `).join("")}
                    </div>
                </div>
            ` : "";

            document.getElementById("txQuickViewDetails").innerHTML = `
                ${splitBreakdownHTML}
                <div>Account: ${accountName(tx.src)}</div>
                ${destLine}
                ${(!splitInfo && tx.cat) ? `<div>Category: ${escapeHtml(tx.cat)}</div>` : ""}
                <div>Notes: ${tx.notes ? escapeHtml(tx.notes) : "-"}</div>
                ${refundLine}
                ${attachmentsHTML}
            `;

            updateTxQuickViewCheckedBtn(!!tx.checked);
            // Refund only makes sense for an ordinary expense — not for a Transfer, not for
            // another refund (no "refund of a refund"), and not for Income. Split Expenses are
            // only ever created for a brand-new Income/Expense entry (never a refund entry, and
            // refunds never offer the split UI — see openRefundFromOptions()), so every member of
            // a group shares the same type/isRefund as the representative checked here.
            document.getElementById("txOptionsRefundBtn").style.display = (tx.type === "expense" && !tx.isRefund) ? "flex" : "none";

            openModal("txQuickViewModal");
        }

        function updateTxQuickViewCheckedBtn(isChecked) {
            const btn = document.getElementById("txQuickViewCheckedBtn");
            if (!btn) return;
            if (isChecked) {
                btn.textContent = "✅ CHECKED — tap to unmark";
                btn.style.background = "#dcfce7";
                btn.style.color = "#15803d";
            } else {
                btn.textContent = "☐ Mark as Checked";
                btn.style.background = "var(--chip-bg)";
                btn.style.color = "var(--text-main)";
            }
        }

        async function toggleTxCheckedFromQuickView() {
            if (!activeQuickViewTxId) return;
            const txs = await readAllDB(STORES.TRANSACTIONS);
            const tx = txs.find(t => t.id === activeQuickViewTxId);
            if (!tx) return;
            const newChecked = !tx.checked;
            if (activeQuickViewSplitGroup) {
                // v91: Quick View shows a single Checked button for the whole merged split-group
                // row, so toggling it reconciles every category+amount part together — otherwise
                // some parts could end up checked and others not, with no way to see that from
                // the merged row alone.
                for (const member of activeQuickViewSplitGroup.members) {
                    const m = txs.find(t => t.id === member.id);
                    if (m) {
                        m.checked = newChecked;
                        await writeDB(STORES.TRANSACTIONS, m);
                    }
                }
            } else {
                tx.checked = newChecked;
                await writeDB(STORES.TRANSACTIONS, tx);
            }
            closeModal("txQuickViewModal");
            await refreshAfterTransactionChange();
        }

        // Options is a layer on top of Quick View, not its own navigable step — it shares Quick
        // View's single pushed history entry (see openModal()/pushVirtualState()) rather than
        // pushing a second one. A single back-press (or closeModal("txQuickViewModal") call)
        // pops that one entry and the popstate handler's own forEach already clears every
        // currently-active modal in one shot, so Options disappears along with Quick View either
        // way. Pushing a second entry here would instead leave a "phantom" extra history step
        // behind every time this menu is used to jump into Edit/Duplicate/Refund below — see
        // closeModalAndThen() for why that matters.
        // v91: on a Split Expense group's merged Quick View row, Duplicate/Edit/Refund/Delete
        // each still need exactly one underlying transaction record to act on (there's no
        // split-aware editor), so this routes through a "which part?" picker first instead of
        // opening the Options menu directly — see openTxSplitPicker().
        function openTxOptionsMenu() {
            if (activeQuickViewSplitGroup) {
                openTxSplitPicker();
                return;
            }
            document.getElementById("txOptionsModal").classList.add("active");
        }

        // Lists every category+amount part of the current Quick View's split group; tapping one
        // repoints activeQuickViewTxId at that specific record's id, then opens the normal
        // Options menu exactly as if a non-split row had been tapped directly.
        function openTxSplitPicker() {
            const info = activeQuickViewSplitGroup;
            if (!info) return;
            const sgn = info.type === "income" ? "+" : "-";
            document.getElementById("txSplitPickerList").innerHTML = info.members.map(m => `
                <button type="button" class="option-menu-btn" data-click="selectTxSplitPickerRow" data-id="${m.id}" style="display:flex; justify-content:space-between;">
                    <span>${getCategoryIcon(m.cat, info.type)} ${escapeHtml(m.cat)}</span>
                    <span>${sgn}${formatCurrency(m.amount, info.currency)}</span>
                </button>
            `).join("");
            document.getElementById("txSplitPickerModal").classList.add("active");
        }

        // Dismisses just the split-part picker, back to Quick View underneath — same non-history-
        // navigating pattern as closeTxOptionsMenu() below (see openTxOptionsMenu() above).
        function closeTxSplitPicker() {
            document.getElementById("txSplitPickerModal").classList.remove("active");
        }

        function selectTxSplitPickerRow(el) {
            const id = Number(el.dataset.id);
            if (!id) return;
            activeQuickViewTxId = id;
            closeTxSplitPicker();
            document.getElementById("txOptionsModal").classList.add("active");
        }

        // --- ACCOUNT PICKER (v99) ---
        // Stands in for the native <select> popup on the Account / To Account fields of the
        // transaction form. Android Chrome renders an expanded <select>'s option list at a fixed
        // system font size that page CSS can't shrink — illegibly large on a phone next to the
        // select box's own (correctly small) closed-state text — so this reads the same <option>
        // elements the existing account-population code already builds (openTransactionForm()) and
        // shows them in an ordinary app modal instead, where font size is fully in our control.
        // The underlying <select> stays in the DOM (just hidden) and remains the single source of
        // truth every other part of the app already reads via .value — this only changes how a
        // human picks a value for it, not how the rest of the codebase stores or reads one.
        // v142: genuinely generic over any <select> — el.dataset.select just names the target id —
        // so the Category field (txCategory) now opens through this same function/modal too,
        // picking up the identical look, feel, and keyboard type-ahead the Account fields already
        // had. Category's <select> is built with <optgroup>s (buildCategoryOptionsHTML(), Main
        // Category / Subcategory), which this renders as inert group-label rows above their child
        // options — see the select.children walk below.
        function openAccountPicker(el) {
            const selectId = el.dataset.select;
            const select = document.getElementById(selectId);
            if (!select) return;
            accountPickerTargetSelectId = selectId;
            // Fresh type-ahead state each time the picker opens, so leftover "R" cycling position
            // from a previous picker session (e.g. a different account field) doesn't carry over.
            accountPickerTypeaheadChar = "";
            accountPickerTypeaheadIndex = -1;
            clearTimeout(accountPickerTypeaheadTimer);
            document.getElementById("accountPickerTitle").textContent = el.dataset.title || "Select Account";
            const currentVal = select.value;
            // v142: walks select.children (not the flat select.options) so a select built with
            // <optgroup>s — e.g. txCategory's Main Category / Subcategory grouping from
            // buildCategoryOptionsHTML() — renders the same grouped structure here instead of a
            // flat list. A plain select (srcAccount/destAccount, no optgroups) renders exactly as
            // before, just via this same loop. Group labels are inert (no data-click), so they're
            // skipped automatically by option-menu-btn's click handling and by the typeahead
            // listener below (which only ever queries for ".option-menu-btn").
            const optionRowHTML = (opt) => `
                <button type="button" class="option-menu-btn" data-click="selectAccountPickerOption" data-value="${escapeHtml(opt.value)}" style="display:flex; justify-content:space-between; align-items:center; ${opt.value === currentVal ? "background:var(--primary-chip-bg);" : ""}">
                    <span>${opt.textContent}</span>
                    ${opt.value === currentVal ? '<span style="color:var(--primary); font-weight:900; margin-left:8px; flex:0 0 auto;">✓</span>' : ""}
                </button>
            `;
            document.getElementById("accountPickerList").innerHTML = Array.from(select.children).map(child => {
                if (child.tagName === "OPTGROUP") {
                    return `<div class="option-group-label" style="background:var(--card-bg); color:var(--text-muted);">${escapeHtml(child.label)}</div>` + Array.from(child.children).map(optionRowHTML).join("");
                }
                return optionRowHTML(child);
            }).join("");
            // Uses the shared openModal() (see "NATIVE ROUTING CORE" above) so this picker pushes
            // its own history entry and joins modalStack like every other modal. Previously this
            // just toggled the "active" class directly, with no history entry of its own — so the
            // hardware/gesture back button had nothing belonging to this picker to pop and fell
            // through to whatever history entry was next (often none), exiting the app instead of
            // just closing the picker.
            openModal("accountPickerModal");
        }

        function closeAccountPicker() {
            // See openAccountPicker() above — closing goes through the shared closeModal(), which
            // triggers history.back() and lets the popstate handler remove "active" in lockstep,
            // matching how every other modal opens/closes.
            closeModal("accountPickerModal");
        }

        function selectAccountPickerOption(el) {
            const select = document.getElementById(accountPickerTargetSelectId);
            if (select) {
                select.value = el.dataset.value;
                // Fires syncTransactionCurrency() etc. exactly as a native <select> change would —
                // see the data-change="syncTransactionCurrency" still wired on the (now hidden)
                // <select> itself in index.html.
                select.dispatchEvent(new Event("change", { bubbles: true }));
            }
            syncAccountPickerButtonText(accountPickerTargetSelectId);
            closeAccountPicker();
        }

        // Refreshes a picker button's visible label from its paired <select>'s currently selected
        // option — called after every place in the codebase that sets an account-picker <select>'s
        // .value directly (bypassing the picker modal), so the button never goes stale. Follows
        // the `<selectId>BtnText` naming convention every account-picker button pair uses (e.g.
        // srcAccount → srcAccountBtnText, salaryBankAccount → salaryBankAccountBtnText,
        // txCategory → txCategoryBtnText) — see the call sites in openTransactionForm()/
        // duplicateTransactionFromOptions()/openRefundFromOptions()/openSalaryEntryForm()/
        // handleSalaryMemberChange().
        function syncAccountPickerButtonText(selectId) {
            const select = document.getElementById(selectId);
            const btnText = document.getElementById(selectId + "BtnText");
            if (!select || !btnText) return;
            const opt = select.options[select.selectedIndex];
            // Generic fallback (not "Select account") since v142 added txCategory as a picker
            // field too — this only ever shows when a picker <select> has no options selected at
            // all (e.g. txCategory while Transfer is chosen, whose Category row is hidden anyway).
            btnText.textContent = opt ? opt.textContent : "Select...";
            // v150: keeps a category picker's icon avatar (the small colored circle beside the
            // button — see the .split-cat-icon CSS comment) in sync with whichever category is
            // currently selected. Only category pickers have a "<selectId>Icon" element in the DOM
            // (txCategory / each split row's <rowId>_cat), so this is a no-op for Account pickers.
            const iconEl = document.getElementById(selectId + "Icon");
            if (iconEl) {
                const typeEl = document.getElementById("txType");
                const type = (typeEl && typeEl.value === "income") ? "income" : "expense";
                const catName = select.value;
                iconEl.textContent = catName ? getCategoryIcon(catName, type) : "🏷️";
                iconEl.style.background = catName ? getCategoryAvatarColor(catName) : "var(--active-bg)";
            }
        }

        // v150: deterministic pastel background for a category's icon avatar circle, so different
        // categories are visually distinguishable at a glance (matching the reference screenshots'
        // colored icon circles) without needing a per-category color stored anywhere — same name
        // always maps to the same palette color.
        const CATEGORY_AVATAR_PALETTE = ["#fee2e2", "#ffedd5", "#fef9c3", "#dcfce7", "#d1fae5", "#cffafe", "#dbeafe", "#e0e7ff", "#ede9fe", "#fce7f3"];
        function getCategoryAvatarColor(name) {
            if (!name) return "#eef2ff";
            let hash = 0;
            for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
            return CATEGORY_AVATAR_PALETTE[hash % CATEGORY_AVATAR_PALETTE.length];
        }

        // v141: PC keyboard type-ahead for the Account picker — a native <select> lets you press
        // "R" to jump to the first option starting with R, press "R" again to jump to the next one,
        // and so on. Swapping the native dropdown for a plain list of <button> rows (see the
        // ACCOUNT PICKER comment above openAccountPicker()) dropped that for-free browser behaviour
        // along with the oversized-font problem it was meant to fix, so it's reimplemented here:
        // one document-level keydown listener (same registration pattern as the passcode Enter
        // listener near the top of the file), gated on the picker actually being open, that finds
        // every row whose label starts with the pressed letter and focus()es the next one in that
        // subset each time the same letter is pressed again, resetting after a pause or a different
        // letter — matching the native select's own type-ahead timeout behaviour.
        document.addEventListener("keydown", (e) => {
            const modal = document.getElementById("accountPickerModal");
            if (!modal || !modal.classList.contains("active")) return;
            // Single printable character only, no modifier combos — so Ctrl+R / Cmd+R (reload)
            // and similar browser/OS shortcuts keep working normally while the picker is open.
            if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
            const buttons = Array.from(document.querySelectorAll("#accountPickerList .option-menu-btn"));
            if (buttons.length === 0) return;
            const char = e.key.toLowerCase();
            // v142: category rows (buildCategoryOptionsHTML) always lead with an emoji icon
            // ("🏦 Rental Income"), so matching the raw label's first character would never fire
            // for typed letters. pickerTypeaheadKey() strips any leading run of non-alphanumeric
            // characters (icon + the space after it) before comparing, so typing "r" jumps to
            // "Rental Income" the same way it already jumped to a plain account name.
            const pickerTypeaheadKey = (text) => text.trim().replace(/^[^a-z0-9]+/i, "").toLowerCase();
            const matches = buttons.filter((btn) => {
                const label = btn.querySelector("span");
                return label && pickerTypeaheadKey(label.textContent).startsWith(char);
            });
            if (matches.length === 0) return;
            e.preventDefault();
            clearTimeout(accountPickerTypeaheadTimer);
            if (char === accountPickerTypeaheadChar) {
                accountPickerTypeaheadIndex = (accountPickerTypeaheadIndex + 1) % matches.length;
            } else {
                accountPickerTypeaheadChar = char;
                accountPickerTypeaheadIndex = 0;
            }
            // Native selects reset the typed search after a short pause of no typing — same idea
            // here, so pressing "R" again a while later restarts from the first R instead of
            // continuing to advance.
            accountPickerTypeaheadTimer = setTimeout(() => {
                accountPickerTypeaheadChar = "";
                accountPickerTypeaheadIndex = -1;
            }, 800);
            matches[accountPickerTypeaheadIndex].focus();
            matches[accountPickerTypeaheadIndex].scrollIntoView({ block: "nearest" });
        });

        // Dismisses just the Options submenu, back to Quick View underneath — not a history
        // navigation (see the comment on openTxOptionsMenu() above for why Options doesn't have
        // its own history entry), so this only ever removes its own "active" class.
        function closeTxOptionsMenu() {
            document.getElementById("txOptionsModal").classList.remove("active");
        }

        // Used only when a Quick View/Options action needs to hand off into a freshly-opened
        // txModal (Edit / Duplicate / Refund below). A plain closeModal() + openModal() pair
        // would race: closeModal()'s history.back() doesn't take effect until its popstate event
        // fires on a later tick, but openModal()'s pushState() runs immediately — so the new
        // entry would land before the pop actually happened, leaving the browser's back-stack
        // permanently one step longer than the visible modal stack every time this runs. Waiting
        // for the real popstate event before pushing the next state keeps the two in lockstep.
        function closeModalAndThen(id, then) {
            const onPop = () => {
                window.removeEventListener("popstate", onPop);
                then();
            };
            window.addEventListener("popstate", onPop);
            closeModal(id);
        }


        function editTransactionFromOptions() {
            const id = activeQuickViewTxId;
            // v95 fix: txOptionsModal is a plain overlay with no history entry of its own (see
            // openTxOptionsMenu()/closeTxOptionsMenu() above), so closeModalAndThen("txQuickViewModal", ...)
            // below only ever pops Quick View off the history stack — it never touches Options'
            // "active" class. Left open, Options stayed visible and on top of whatever opened next
            // (e.g. the Edit form), making that new page look like it "hid behind" Options. Every
            // Options action that hands off into a new screen needs this same explicit close first.
            closeTxOptionsMenu();
            closeModalAndThen("txQuickViewModal", async () => {
                if (!id) return;
                const txs = await readAllDB(STORES.TRANSACTIONS);
                const tx = txs.find(t => t.id === id);
                if (!tx) return;
                await openTransactionForm(tx.type, id);
            });
        }

        // Opens a brand-new entry of the same type, pre-filled from the tapped transaction —
        // everything except the id (so it saves as a new record) and the Checked state (a
        // duplicate is, by definition, not yet reconciled against a statement).
        function duplicateTransactionFromOptions() {
            const id = activeQuickViewTxId;
            closeTxOptionsMenu(); // v95 fix — see editTransactionFromOptions() above.
            closeModalAndThen("txQuickViewModal", async () => {
                if (!id) return;
                const txs = await readAllDB(STORES.TRANSACTIONS);
                const tx = txs.find(t => t.id === id);
                if (!tx || tx.fundId) return;

                await openTransactionForm(tx.type, null);
                document.getElementById("txDesc").value = tx.desc;
                document.getElementById("txAmount").value = tx.amount;
                document.getElementById("txCurrency").value = tx.currency;
                document.getElementById("srcAccount").value = tx.src || "";
                if (tx.type === "transfer") {
                    document.getElementById("destAccount").value = tx.dest || "";
                } else {
                    document.getElementById("txCategory").value = tx.cat || "";
                }
                document.getElementById("txNotes").value = tx.notes || "";
                document.getElementById("txDate").value = tx.date;
                document.getElementById("txChecked").checked = false;
                syncTransactionCurrency();
                syncAccountPickerButtonText("srcAccount"); // v99 — see comment in openTransactionForm().
                syncAccountPickerButtonText("destAccount");
                syncAccountPickerButtonText("txCategory"); // v142 — see comment in openTransactionForm().
                document.getElementById("txModalTitle").textContent = "Duplicate Entry";
            });
        }

        async function deleteTransactionFromOptions() {
            const id = activeQuickViewTxId;
            closeTxOptionsMenu(); // v95 fix — see editTransactionFromOptions() above.
            closeModal("txQuickViewModal");
            if (!id) return;
            await deleteTransactionById(id);
        }

        // Opens a new Income entry, pre-filled from the tapped expense and locked to its exact
        // category — the category is forced (not just pre-selected) because the Income category
        // dropdown otherwise only ever lists Income categories, and the Spending/Income Breakdown
        // + Net Savings Statement + dashboard totals all key their refund offset off `t.cat`
        // matching the original expense's category exactly (see the isRefund handling in
        // renderApp()/renderSavingsStatement()/renderSpendingBreakdownPage()/
        // renderIncomeBreakdownPage()). pendingRefundOf (read by handleTransactionSubmitMobile) is
        // the actual flag that makes this save as a refund rather than an ordinary Income entry.
        function openRefundFromOptions() {
            const id = activeQuickViewTxId;
            closeTxOptionsMenu(); // v95 fix — see editTransactionFromOptions() above.
            closeModalAndThen("txQuickViewModal", async () => {
                if (!id) return;
                const txs = await readAllDB(STORES.TRANSACTIONS);
                const tx = txs.find(t => t.id === id);
                if (!tx || tx.type !== "expense") return;

                await openTransactionForm("income", null);
                document.getElementById("txDesc").value = `Refund: ${tx.desc}`;
                document.getElementById("txAmount").value = tx.amount;
                document.getElementById("txCurrency").value = tx.currency;
                document.getElementById("srcAccount").value = tx.src || "";
                syncAccountPickerButtonText("srcAccount"); // v99 — see comment in openTransactionForm().

                const catSelect = document.getElementById("txCategory");
                const catName = tx.cat || "Other Expenses";
                const icon = getCategoryIcon(catName, "expense");
                catSelect.innerHTML = `<option value="${escapeHtml(catName)}">${icon} ${escapeHtml(catName)}</option>`;
                catSelect.value = catName;
                catSelect.disabled = true;
                // v142: the button now stands in for the <select> (see openAccountPicker()) — a
                // disabled button never dispatches click, so this alone stops openAccountPicker()
                // from firing and re-opening a picker the user shouldn't be able to change; the
                // dimmed opacity just makes that locked state visible, matching how a disabled
                // <select> looks greyed out.
                const catBtn = document.getElementById("txCategoryBtn");
                catBtn.disabled = true;
                catBtn.style.opacity = "0.6";
                syncAccountPickerButtonText("txCategory");

                document.getElementById("txDate").value = todayLocalStr();
                document.getElementById("txSplitWrap").style.display = "none";
                syncTransactionCurrency();

                document.getElementById("txModalTitle").textContent = `Refund: ${tx.desc}`;
                document.getElementById("txSubmitBtn").textContent = "Save Refund";

                // Set last — openTransactionForm() itself resets pendingRefundOf to null on
                // every call, so this has to happen after it returns, not before.
                pendingRefundOf = id;
            });
        }

        // (v147: the old filterMonth/filterYear-driven year filter was removed along with the
        // Financial Report Card redesign — see renderReportCards()/populateReportCardPeriodOptions
        // below — since every card's own period select (This Year/Last Year/This Month/Last
        // Month) now computes its own totals directly from `txs` instead.)


        // Shared by renderApp() (dashboard/header) and renderAccountsPage() (Accounts page list)
        // so both always show the same live, transaction-derived balances rather than each
        // re-deriving it (or worse, one of them falling back to stale a.initialBalance).
        async function computeAccountBalances() {
            const accounts = await readAllDB(STORES.ACCOUNTS);
            const txs = await readAllDB(STORES.TRANSACTIONS);

            const nativeBalances = {};
            accounts.forEach(a => {
                nativeBalances[a.id] = (a.type === "multi" || a.type === "fd" || a.type === "unittrust") ? {} : (a.initialBalance || 0);
            });

            // Applies a signed amount to an account's balance. "Normal" accounts are converted into
            // their one fixed currency (as before). Multi-Currency and Fixed Deposit accounts keep a
            // separate running balance per currency ("basket") — no conversion between baskets.
            // manualFxRate (v32): when a transaction has one set (Income/Expense only — see the
            // scoping note on updateTxManualFxVisibility()), it's used instead of the live global
            // fxRates table for this specific leg, so a later change to those rates doesn't
            // retroactively change what this past transaction actually did to the account balance.
            // directAmountOverride (v33): for a Transfer's destination leg, the exact received
            // amount in the destination account's own currency (see updateTxTransferFxVisibility())
            // — bypasses conversion entirely rather than deriving it from a rate.
            function applyToAccountBalance(account, amount, currency, sign, manualFxRate, directAmountOverride) {
                if (!account) return;
                if (account.type === "multi" || account.type === "fd" || account.type === "unittrust") {
                    const basket = nativeBalances[account.id];
                    basket[currency] = (basket[currency] || 0) + sign * amount;
                } else if (directAmountOverride != null) {
                    nativeBalances[account.id] += sign * directAmountOverride;
                } else if (manualFxRate && currency !== account.currency) {
                    nativeBalances[account.id] += sign * (amount * manualFxRate);
                } else {
                    nativeBalances[account.id] += sign * convertCurrency(amount, currency, account.currency);
                }
            }

            txs.forEach(t => {
                const aSrc = accounts.find(a => a.id === t.src);
                const aDest = accounts.find(a => a.id === t.dest);
                if (t.type === "income") applyToAccountBalance(aSrc, t.amount, t.currency, +1, t.manualFxRate);
                if (t.type === "expense") applyToAccountBalance(aSrc, t.amount, t.currency, -1, t.manualFxRate);
                if (t.type === "transfer") {
                    applyToAccountBalance(aSrc, t.amount, t.currency, -1);
                    applyToAccountBalance(aDest, t.amount, t.currency, +1, null, t.destAmount);
                }
            });

            // Unit Trust accounts (v50): the cash-flow basket built above (Buy amount in, Sell
            // amount out, plus whatever Total Amount was typed for Dividend Reinvest/
            // Contribution) only approximates what the holding is worth — it never re-marks
            // itself when a fund's NAV moves, so it silently drifts away from the Fund Holdings
            // table's own "Total" row (units × currentNav). Net worth, the Accounts/Member page
            // balances, and the Current Balance banner should all agree with that Total row, so
            // for Unit Trust accounts specifically the basket above is discarded and rebuilt here
            // from live market value instead — same inputs, same math, as renderFundHoldingsTable().
            const unitTrustAccounts = accounts.filter(a => a.type === "unittrust");
            if (unitTrustAccounts.length > 0) {
                const funds = await readAllDB(STORES.FUNDS);
                const allFundIds = new Set(funds.map(f => f.id));
                const fundsByAccountId = {};
                funds.forEach(f => { (fundsByAccountId[f.accountId] = fundsByAccountId[f.accountId] || []).push(f); });

                unitTrustAccounts.forEach(acc => {
                    const basket = {};
                    const accFunds = fundsByAccountId[acc.id] || [];
                    accFunds.forEach(f => {
                        basket[f.currency] = (basket[f.currency] || 0) + (f.units || 0) * (f.currentNav || 0);
                    });

                    // Orphaned fund transactions (the FUNDS record was deleted separately, but its
                    // history intentionally stays — see handleDeleteFund()) still count toward this
                    // account's balance. There's no live NAV left to mark them at, so they're
                    // valued at remaining cost basis, exactly like the Fund Holdings table's own
                    // "(fund deleted)" row.
                    //
                    // `txs` here is the whole-app transaction list, so a transaction's fundId can
                    // belong to a fund that's still alive under a DIFFERENT unit trust account —
                    // that's not orphaned, it's just not ours, and must be excluded rather than
                    // counted here too (otherwise every account's balance silently includes every
                    // other account's fund holdings — see renderFundHoldingsTable() for the same fix).
                    const liveFundIds = new Set(accFunds.map(f => f.id));
                    const orphanTxsByFundId = {};
                    txs.forEach(t => {
                        if (!t.fundId || liveFundIds.has(t.fundId)) return;
                        if (allFundIds.has(t.fundId)) return; // alive under a different account — shown/counted there instead
                        // Fund deleted everywhere — only attribute it to this account if the
                        // transaction itself references this account (true for Buy/Sell/
                        // Dividend(Reinvest)/Contribution; Dividend Cheque Payout carries no
                        // account link once its fund is gone, so it's left out rather than guessed).
                        if (t.src !== acc.id && t.dest !== acc.id) return;
                        (orphanTxsByFundId[t.fundId] = orphanTxsByFundId[t.fundId] || []).push(t);
                    });
                    Object.values(orphanTxsByFundId).forEach(fTxs => {
                        let invested = 0, recovered = 0;
                        fTxs.forEach(t => {
                            if (t.fundTxType === "buy") invested += t.amount;
                            else if (t.fundTxType === "sell" || t.fundTxType === "dividend_payout") recovered += t.amount;
                        });
                        const currency = fTxs[0].currency || baseCurrency;
                        basket[currency] = (basket[currency] || 0) + Math.max(invested - recovered, 0);
                    });

                    nativeBalances[acc.id] = basket;
                });
            }

            return { accounts, txs, nativeBalances };
        }

        // --- CONSOLIDATED RENDER ENGINE ---
        async function renderApp() {
            // Reset the dashboard quick-add speed-dial to its closed "+" state on every render
            // (mirrors closeLedgerQuickAddSheet() being called on every ledger-page render) so it
            // never stays stuck open across a navigation or a data-driven re-render.
            closeDashboardQuickAddSheet();

            const { accounts, txs, nativeBalances } = await computeAccountBalances();

            document.getElementById("currentBasePill").textContent = baseCurrency;

            let globalBaseNetWorth = 0;
            const currencyTotals = {}; // native (unconverted) sum per currency actually held, across every account
            accounts.forEach(a => {
                // Include in Net Worth (v53) — currently only settable on Real Estate accounts
                // (see newAccIncludeNetWorth); every other account has no way to opt out, so
                // undefined/missing here always means "include" and this only ever filters out
                // a Real Estate account whose owner explicitly excluded it.
                if (a.includeInNetWorth === false) return;
                if (a.type === "multi" || a.type === "fd" || a.type === "unittrust") {
                    Object.entries(nativeBalances[a.id]).forEach(([curr, amt]) => {
                        globalBaseNetWorth += convertCurrency(amt, curr, baseCurrency);
                        currencyTotals[curr] = (currencyTotals[curr] || 0) + amt;
                    });
                } else {
                    globalBaseNetWorth += convertCurrency(nativeBalances[a.id], a.currency, baseCurrency);
                    currencyTotals[a.currency] = (currencyTotals[a.currency] || 0) + nativeBalances[a.id];
                }
            });
            document.getElementById("netWorthDisplay").innerHTML = formatBalanceHTML(globalBaseNetWorth, baseCurrency);

            // v157: Financial Assets vs Real Estate split row under the main figure — reuses the
            // same summarizeOwnerAssetSplit() the "Financial Assets vs Real Estate" owner report
            // already relies on, so this always reconciles to globalBaseNetWorth above. Hidden
            // entirely (not just zeroed) when the user has no Real Estate account at all, so
            // someone who's never used that group only ever sees the single Portfolio Net Worth
            // figure, same as before this existed.
            const hasRealEstateAccount = accounts.some(a => (a.group || DEFAULT_ACCOUNT_GROUP) === "Real Estate");
            document.getElementById("netWorthSplitRow").classList.toggle("hidden", !hasRealEstateAccount);
            if (hasRealEstateAccount) {
                const { financial, realEstate } = summarizeOwnerAssetSplit(accounts, nativeBalances);
                document.getElementById("financialAssetsDisplay").innerHTML = formatBalanceHTML(financial, baseCurrency);
                document.getElementById("realEstateDisplay").innerHTML = formatBalanceHTML(realEstate, baseCurrency);
            }

            // "Net Worth by Member" rows (replaces the old single "Net Worth by Currency Held"
            // row, v34): one row per member (their solo-owned accounts only), one row per distinct
            // joint-owned account group, and — only if any exist — one row for unassigned accounts,
            // so the breakdown always ties out to the grand total above.
            renderMemberNetWorthRows(accounts, nativeBalances);
            renderPinnedAccountsWidget(accounts, nativeBalances);
            renderRecentTransactionsWidget(accounts, txs);
            applyDashboardWidgetOrder();
            renderDesktopInsightsRail(accounts, txs);

            // --- Fixed Deposit maturity reminders ---
            // FD terms now live on the individual deposit transaction (each "placement"), not the
            // account itself — an FD account can hold several tranches, each maturing separately.
            // Placements the user has already renewed or withdrawn are flagged fdResolved and
            // dropped from this scan so the reminder clears once acted upon.
            const todayMs = new Date(todayLocalStr() + "T00:00:00").getTime();
            const MS_PER_DAY = 86400000;
            let reminderHTML = "";
            txs.filter(t => t.fdMaturityDate && !t.fdResolved).forEach(t => {
                const holdingAccount = accounts.find(a => a.id === (t.type === "transfer" ? t.dest : t.src));
                if (!holdingAccount) return;

                const maturityMs = new Date(t.fdMaturityDate + "T00:00:00").getTime();
                const daysLeft = Math.round((maturityMs - todayMs) / MS_PER_DAY);

                if (daysLeft <= 30) {
                    const overdue = daysLeft < 0;
                    const bg = overdue ? "#fee2e2" : "#fef3c7";
                    const border = overdue ? "#fecaca" : "#fde68a";
                    const textCol = overdue ? "#b91c1c" : "#92400e";
                    const label = overdue
                        ? `matured ${Math.abs(daysLeft)} day${Math.abs(daysLeft) === 1 ? '' : 's'} ago — action needed`
                        : (daysLeft === 0 ? `matures today` : `matures in ${daysLeft} day${daysLeft === 1 ? '' : 's'} (${t.fdMaturityDate})`);
                    reminderHTML += `
                        <div data-click="openResolveFdModal" data-id="${escapeHtml(t.id)}" style="cursor:pointer; background:${bg}; border:1px solid ${border}; color:${textCol}; border-radius:12px; padding:12px 14px; margin-bottom:8px; font-size:0.8rem; font-weight:600; display:flex; justify-content:space-between; align-items:center;">
                            <span>${overdue ? '⏰' : '🔔'} ${formatCurrency(t.amount, t.currency)} placement in "${escapeHtml(accountOptionLabel(holdingAccount, accounts))}" ${label} — plan renewal or withdrawal.</span>
                            <span style="font-size:1.1rem;">›</span>
                        </div>
                    `;
                }
            });
            document.getElementById("fdReminderContainer").innerHTML = reminderHTML;

            // --- Credit Card payment due reminders ---
            // Unlike an FD placement's one-off maturity date, a card's due date recurs monthly
            // on a fixed day-of-month (paymentDueDay), which creates a rollover trap the FD
            // reminder above doesn't have: naively computing "this calendar month's due date"
            // and comparing it to today means that the instant the calendar rolls into a new
            // month, that computed date jumps forward to a future date — even if last month's
            // bill was never paid — silently turning an overdue reminder into a calm "due in N
            // days" (or making it vanish under the 7-day window entirely) until the new month's
            // due date comes back into range. Potentially weeks of a real overdue balance going
            // unflagged. Fixed below by always anchoring the "overdue" check on the most recent
            // due-day occurrence that has already happened relative to today (this month's, or
            // last month's if this month's hasn't arrived yet) rather than "this month's" alone
            // — that anchor only ever moves forward once a further due date has also been
            // reached, so it can never flip back to a calm state while a balance remains
            // outstanding. It briefly steps aside for the "due soon" advance notice once we're
            // within a week of the *next* due date, so the banner reads as "heads up, due in 3
            // days" rather than "27 days overdue" right as a new cycle's due date approaches —
            // then flips straight back to overdue the moment that date also passes unpaid.
            //
            // Note: like the 💳 Pay amount-due figure elsewhere in this app, this has no
            // separate per-statement-cycle bucketing — "outstanding" is just -balance. So a
            // card that's always paid to zero each cycle will only ever show this reminder in
            // its accurate "due soon"/"due today" form (balance is 0 the rest of the time,
            // which already suppresses it below). A card that's left carrying a partial balance
            // across cycles will show as overdue somewhat eagerly, since there's no way to tell
            // "old unpaid balance" from "this cycle's fresh spending, not due yet" from the
            // balance alone.
            function ccDueDateFor(year, month, day) {
                // Clamps to the last real day of the month instead of letting JS Date silently
                // roll over into the following month (e.g. day 31 in a 30-day month).
                const lastDayOfMonth = new Date(year, month + 1, 0).getDate();
                return new Date(year, month, Math.min(day, lastDayOfMonth));
            }
            let ccReminderHTML = "";
            accounts.filter(a => a.type === "creditcard" && a.paymentDueDay).forEach(a => {
                const amountDue = Math.max(0, -(nativeBalances[a.id] || 0));
                if (amountDue <= 0.005) return; // nothing owed — nothing to remind about

                const todayDate = new Date(todayLocalStr() + "T00:00:00");

                let anchor = ccDueDateFor(todayDate.getFullYear(), todayDate.getMonth(), a.paymentDueDay);
                if (anchor > todayDate) anchor = ccDueDateFor(todayDate.getFullYear(), todayDate.getMonth() - 1, a.paymentDueDay);
                const daysSinceAnchor = Math.round((todayDate - anchor) / MS_PER_DAY);

                const upcoming = ccDueDateFor(anchor.getFullYear(), anchor.getMonth() + 1, a.paymentDueDay);
                const daysUntilUpcoming = Math.round((upcoming - todayDate) / MS_PER_DAY);

                let overdue, daysOverdue, dueDateStr, dueToday;
                if (daysSinceAnchor === 0) {
                    overdue = false; dueToday = true; dueDateStr = anchor.toISOString().slice(0, 10);
                } else if (daysUntilUpcoming <= 7) {
                    overdue = false; dueToday = (daysUntilUpcoming === 0); dueDateStr = upcoming.toISOString().slice(0, 10);
                } else {
                    overdue = true; daysOverdue = daysSinceAnchor; dueDateStr = anchor.toISOString().slice(0, 10);
                }
                const daysAway = overdue ? null : (dueToday ? 0 : daysUntilUpcoming);
                if (!overdue && !dueToday && daysAway > 7) return; // outside the 1-week advance window

                const bg = overdue ? "#fee2e2" : "#fef3c7";
                const border = overdue ? "#fecaca" : "#fde68a";
                const textCol = overdue ? "#b91c1c" : "#92400e";
                const label = overdue
                    ? `payment overdue by ${daysOverdue} day${daysOverdue === 1 ? '' : 's'} (since ${dueDateStr}) — action needed`
                    : (dueToday ? `due today` : `due in ${daysAway} day${daysAway === 1 ? '' : 's'} (${dueDateStr})`);
                ccReminderHTML += `
                    <div data-click="openCreditCardPayment" data-id="${escapeHtml(a.id)}" style="cursor:pointer; background:${bg}; border:1px solid ${border}; color:${textCol}; border-radius:12px; padding:12px 14px; margin-bottom:8px; font-size:0.8rem; font-weight:600; display:flex; justify-content:space-between; align-items:center;">
                        <span>${overdue ? '⏰' : '🔔'} ${formatCurrency(amountDue, a.currency)} on "${escapeHtml(accountOptionLabel(a, accounts))}" ${label}.</span>
                        <span style="font-size:1.1rem;">›</span>
                    </div>
                `;
            });
            document.getElementById("ccReminderContainer").innerHTML = ccReminderHTML;

            // --- Per-account "Account Activity" year navigation (v33) ---
            // Only meaningful when viewing one specific account with no category/type filter
            // layered on top (the same scope as showFullAccountHistory just below). Restricts the
            // list to one year at a time, moving only between years that actually contain a
            // transaction for this account (years with nothing logged are skipped entirely).
            const showFullAccountHistory = activeLedgerAccountView !== "all" && activeCategoryView === "all" && directTypeView === "all";
            accountLedgerYearsCache = [];
            if (showFullAccountHistory) {
                const acctId = activeLedgerAccountView;
                accountLedgerYearsCache = [...new Set(
                    txs.filter(t => t.src === acctId || t.dest === acctId).map(t => new Date(t.date).getFullYear())
                )].sort((a, b) => a - b);

                if (accountLedgerYearsCache.length > 0) {
                    if (accountLedgerYear === "__fresh__" || (accountLedgerYear !== null && !accountLedgerYearsCache.includes(accountLedgerYear))) {
                        accountLedgerYear = accountLedgerYearsCache[accountLedgerYearsCache.length - 1];
                    }
                } else {
                    accountLedgerYear = null;
                }
            } else {
                accountLedgerYear = "__fresh__";
            }

            // --- Portfolio General Log's own year navigation ---
            // Sibling of the per-account block just above, but scoped across every account's
            // transactions combined — this is the unfiltered "all" ledger view (no account/
            // category/type filter layered on top), i.e. the page opened via
            // navigateToLedgerPage("all") from the sidebar's "Transactions" link.
            const isPortfolioAllView = activeLedgerAccountView === "all" && activeCategoryView === "all" && directTypeView === "all";
            portfolioLedgerYearsCache = [];
            if (isPortfolioAllView) {
                portfolioLedgerYearsCache = [...new Set(txs.map(t => new Date(t.date).getFullYear()))].sort((a, b) => a - b);
                // Unlike accountLedgerYear's "__fresh__" handling above, a specific selected year
                // here is only cleared back to "All Years" if it no longer has any data at all
                // (e.g. every transaction in that year was deleted) — it otherwise stays sticky
                // across visits within the session rather than resetting to latest-year each time.
                if (portfolioLedgerYearsCache.length > 0) {
                    if (portfolioLedgerYear !== null && !portfolioLedgerYearsCache.includes(portfolioLedgerYear)) {
                        portfolioLedgerYear = null;
                    }
                } else {
                    portfolioLedgerYear = null;
                }
            }

            const yearNavEl = document.getElementById("ledgerYearNav");
            let accountYearIdx = -1;
            if (showFullAccountHistory && accountLedgerYearsCache.length > 0) {
                accountYearIdx = accountLedgerYearsCache.indexOf(accountLedgerYear);
                yearNavEl.style.display = "flex";
                const yearSelect = document.getElementById("ledgerYearLabel");
                yearSelect.innerHTML = accountLedgerYearsCache.map(y => `<option value="${y}">${y}</option>`).join("") + `<option value="all">All Years</option>`;
                yearSelect.value = accountLedgerYear === null ? "all" : String(accountLedgerYear);
                document.getElementById("ledgerYearPrevBtn").disabled = accountLedgerYear === null || accountYearIdx <= 0;
                document.getElementById("ledgerYearNextBtn").disabled = accountLedgerYear === null || accountYearIdx >= accountLedgerYearsCache.length - 1;
            } else if (isPortfolioAllView && portfolioLedgerYearsCache.length > 0) {
                accountYearIdx = portfolioLedgerYearsCache.indexOf(portfolioLedgerYear);
                yearNavEl.style.display = "flex";
                const yearSelect = document.getElementById("ledgerYearLabel");
                yearSelect.innerHTML = portfolioLedgerYearsCache.map(y => `<option value="${y}">${y}</option>`).join("") + `<option value="all">All Years</option>`;
                yearSelect.value = portfolioLedgerYear === null ? "all" : String(portfolioLedgerYear);
                document.getElementById("ledgerYearPrevBtn").disabled = portfolioLedgerYear === null || accountYearIdx <= 0;
                document.getElementById("ledgerYearNextBtn").disabled = portfolioLedgerYear === null || accountYearIdx >= portfolioLedgerYearsCache.length - 1;
            } else {
                yearNavEl.style.display = "none";
            }

            // "+" quick-add FAB (v34) — only on a specific account's own Activity page.
            document.querySelector("#page-ledger .fab-btn").style.display = showFullAccountHistory ? "flex" : "none";
            closeLedgerQuickAddSheet();

            // Current Balance banner (v34) — the account's actual up-to-date balance, shown
            // regardless of which year is currently selected (unlike Balance B/F & C/F below,
            // which are specific to the selected year's boundaries). Label (v51): reads
            // "Purchase Cost" for Real Estate accounts instead of "Current Balance" — a property
            // account's running total is the cumulative cost put into it (purchase price + extras
            // like an extra car park, less any rebate/credit note logged as a reverse Transfer),
            // not a "balance" in the everyday cash-account sense, so the old label was misleading.
            const balanceBanner = document.getElementById("ledgerCurrentBalanceBanner");
            if (showFullAccountHistory) {
                const viewingAcc = accounts.find(a => a.id === activeLedgerAccountView);
                if (viewingAcc) {
                    let balSummary;
                    if (viewingAcc.type === "multi") {
                        // v55: Current Balance for a Multi-Currency account is now its single
                        // converted Base total (matching the Accounts page headline), not the
                        // raw "+"-joined string of every currency basket.
                        balSummary = formatBalanceHTML(accountBaseValue(viewingAcc, nativeBalances), baseCurrency);
                    } else if (viewingAcc.type === "fd" || viewingAcc.type === "unittrust") {
                        const baskets = nativeBalances[viewingAcc.id];
                        const currencies = Object.keys(baskets);
                        balSummary = currencies.length === 0
                            ? "No funds yet"
                            : currencies.map(curr => formatBalanceHTML(baskets[curr], curr)).join(" + ");
                    } else {
                        balSummary = formatBalanceHTML(nativeBalances[viewingAcc.id], viewingAcc.currency);
                    }
                    document.getElementById("ledgerCurrentBalanceLabel").textContent =
                        (viewingAcc.group || DEFAULT_ACCOUNT_GROUP) === "Real Estate" ? "Purchase Cost" : "Current Balance";
                    document.getElementById("ledgerCurrentBalanceValue").innerHTML = balSummary;
                    balanceBanner.style.display = "block";
                } else {
                    balanceBanner.style.display = "none";
                }
            } else {
                balanceBanner.style.display = "none";
            }

            // Related Account banner (v50) — Bank Loan accounts only, shown just under Current
            // Balance when a linked account was set on this loan (see populateLinkedAccountSelect).
            // Tapping it jumps straight to that account's own Activity page.
            const linkedBanner = document.getElementById("ledgerLinkedAccountBanner");
            if (showFullAccountHistory) {
                const viewingAcc = accounts.find(a => a.id === activeLedgerAccountView);
                const linkedAcc = viewingAcc && viewingAcc.linkedAccountId ? accounts.find(a => a.id === viewingAcc.linkedAccountId) : null;
                if (linkedAcc) {
                    document.getElementById("ledgerLinkedAccountValue").textContent = linkedAcc.name;
                    linkedBanner.dataset.id = linkedAcc.id;
                    linkedBanner.style.display = "block";
                } else {
                    linkedBanner.style.display = "none";
                }
            } else {
                linkedBanner.style.display = "none";
            }

            // Property Type/Holding Period or Redraw Facility banner (v66) — accountExtraInfoLine()
            // already returns a "<br>..." prefixed line meant to sit under an account name, so the
            // leading "<br>" is stripped here since this banner is its own standalone block, not a
            // continuation of another line.
            const extraInfoBanner = document.getElementById("ledgerExtraInfoBanner");
            if (showFullAccountHistory) {
                const viewingAcc = accounts.find(a => a.id === activeLedgerAccountView);
                const infoHtml = viewingAcc ? accountExtraInfoLine(viewingAcc, nativeBalances).replace(/^<br>/, "") : "";
                if (infoHtml) {
                    extraInfoBanner.innerHTML = infoHtml;
                    extraInfoBanner.style.display = "block";
                } else {
                    extraInfoBanner.style.display = "none";
                }
            } else {
                extraInfoBanner.style.display = "none";
            }

            // Credit Card (v127): Amount Due + 💳 Pay banner — see openCreditCardPayment()'s
            // comment for what "Amount Due" means here (just the ordinary balance, negated).
            const ccBanner = document.getElementById("ledgerCcBanner");
            if (showFullAccountHistory) {
                const viewingAcc = accounts.find(a => a.id === activeLedgerAccountView);
                const amountDue = (viewingAcc && viewingAcc.type === "creditcard") ? Math.max(0, -(nativeBalances[viewingAcc.id] || 0)) : 0;
                if (viewingAcc && viewingAcc.type === "creditcard" && amountDue > 0.005) {
                    document.getElementById("ledgerCcAmountDue").innerHTML = formatBalanceHTML(amountDue, viewingAcc.currency);
                    ccBanner.style.display = "flex";
                } else {
                    ccBanner.style.display = "none";
                }
            } else {
                ccBanner.style.display = "none";
            }

            // Fund Holdings section (Unit Trust accounts only) — shown above the normal
            // transaction ledger list, which still displays every Buy/Sell/Dividend/Contribution
            // as an ordinary-looking entry (they ARE ordinary transfer/income transactions under
            // the hood, just tagged with a fundId — see saveFundTransaction()).
            const fundSection = document.getElementById("fundHoldingsSection");
            let isUnitTrustAccountView = false;
            if (showFullAccountHistory) {
                const viewingAcc2 = accounts.find(a => a.id === activeLedgerAccountView);
                if (viewingAcc2 && viewingAcc2.type === "unittrust") {
                    isUnitTrustAccountView = true;
                    fundSection.style.display = "block";
                    await renderFundHoldingsTable(viewingAcc2.id, txs);
                } else {
                    fundSection.style.display = "none";
                }
            } else {
                fundSection.style.display = "none";
            }

            // Multi-Currency account's own Activity page (v55): rather than a jumbled list of
            // raw Opening Balance / transaction rows across every currency at once, this view
            // shows one row per currency basket held — each currency's own transactions
            // (including its Opening Balance) live on that currency's dedicated Activity page
            // instead (see navigateToCurrencyActivityPage / renderCurrencyActivityPage).
            let isMultiCurrencyAccountView = false;
            let viewingMultiAcc = null;
            if (showFullAccountHistory) {
                viewingMultiAcc = accounts.find(a => a.id === activeLedgerAccountView);
                isMultiCurrencyAccountView = !!(viewingMultiAcc && viewingMultiAcc.type === "multi");
            }

            // Compute structural titles
            if (activeCategoryView !== "all") {
                const icon = getCategoryIcon(activeCategoryView);
                const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
                let periodSuffix = "";
                if (categoryDrillMonth !== "all" && categoryDrillYear !== "all") periodSuffix = ` · ${monthNames[parseInt(categoryDrillMonth)]} ${categoryDrillYear}`;
                else if (categoryDrillYear !== "all") periodSuffix = ` · ${categoryDrillYear}`;
                else if (categoryDrillMonth !== "all") periodSuffix = ` · ${monthNames[parseInt(categoryDrillMonth)]} (All Years)`;
                document.getElementById("ledgerTargetTitle").textContent = `${icon} ${activeCategoryView.toUpperCase()}${periodSuffix}`;
                document.getElementById("ledgerTargetEditBtn").style.display = "none";
                document.getElementById("ledgerTargetOwnerTags").style.display = "none";
                // v188: "Group by Note" — only makes sense once a single category is being
                // viewed (mirrors a reference app's per-category note-merge summary: same note
                // text logged across several entries — e.g. "mcd" — collapsed into one row with
                // its combined total and every date it was used).
                document.getElementById("ledgerNoteSummaryBtn").style.display = "";
            } else if (directTypeView !== "all") {
                // v148: same period-suffix treatment as the category branch above, for the report
                // card's Income/Expense clicks (categoryDrillYear/Month "all" when reached any
                // other way, so this reads exactly as before for those).
                const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
                let periodSuffix = "";
                if (categoryDrillMonth !== "all" && categoryDrillYear !== "all") periodSuffix = ` · ${monthNames[parseInt(categoryDrillMonth)]} ${categoryDrillYear}`;
                else if (categoryDrillYear !== "all") periodSuffix = ` · ${categoryDrillYear}`;
                else if (categoryDrillMonth !== "all") periodSuffix = ` · ${monthNames[parseInt(categoryDrillMonth)]} (All Years)`;
                document.getElementById("ledgerTargetTitle").textContent = `All ${directTypeView.charAt(0).toUpperCase() + directTypeView.slice(1)} Log${periodSuffix}`;
                document.getElementById("ledgerTargetEditBtn").style.display = "none";
                document.getElementById("ledgerTargetOwnerTags").style.display = "none";
                document.getElementById("ledgerNoteSummaryBtn").style.display = "none";
            } else if (activeLedgerAccountView === "all") {
                document.getElementById("ledgerTargetTitle").textContent = "Portfolio General Log";
                document.getElementById("ledgerTargetEditBtn").style.display = "none";
                document.getElementById("ledgerTargetOwnerTags").style.display = "none";
                document.getElementById("ledgerNoteSummaryBtn").style.display = "none";
            } else {
                const activeAcc = accounts.find(a => a.id === activeLedgerAccountView);
                // v166: owner names moved out of the title (was cluttered as plain text in
                // parentheses) and shown instead as colored ● tags on their own line, reusing
                // accountOwnerTagHTML — the same per-member color dots used on the Accounts page.
                const currentActiveAccName = activeAcc ? activeAcc.name : "Vault";
                document.getElementById("ledgerTargetTitle").textContent = `${currentActiveAccName} Activity`;
                document.getElementById("ledgerTargetEditBtn").style.display = "inline-block";
                document.getElementById("ledgerNoteSummaryBtn").style.display = "none";
                const ownerTagsEl = document.getElementById("ledgerTargetOwnerTags");
                if (activeAcc) {
                    ownerTagsEl.innerHTML = accountOwnerTagHTML(activeAcc);
                    ownerTagsEl.style.display = "flex";
                } else {
                    ownerTagsEl.style.display = "none";
                }
            }

            let ledgerHTML = "";

            // Helper for Balance B/F & C/F (v33): the native (own-currency) balance of a single
            // "normal" account counting only transactions dated strictly before cutoffMs, plus its
            // initial balance. Mirrors computeAccountBalances()'s per-transaction conversion rules
            // (manualFxRate for Income/Expense, explicit destAmount for Transfers) so these rows
            // tie out exactly with the running balance shown elsewhere.
            function computeAccountBalanceAsOf(account, cutoffMs) {
                let bal = account.initialBalance || 0;
                txs.forEach(t => {
                    const tMs = new Date(t.date + "T00:00:00").getTime();
                    if (tMs >= cutoffMs) return;
                    if (t.type === "income" && t.src === account.id) {
                        bal += (t.manualFxRate && t.currency !== account.currency) ? (t.amount * t.manualFxRate) : convertCurrency(t.amount, t.currency, account.currency);
                    } else if (t.type === "expense" && t.src === account.id) {
                        bal -= (t.manualFxRate && t.currency !== account.currency) ? (t.amount * t.manualFxRate) : convertCurrency(t.amount, t.currency, account.currency);
                    } else if (t.type === "transfer") {
                        if (t.src === account.id) bal -= convertCurrency(t.amount, t.currency, account.currency);
                        if (t.dest === account.id) bal += (t.destAmount != null) ? t.destAmount : convertCurrency(t.amount, t.currency, account.currency);
                    }
                });
                return bal;
            }

            // The "Opening Balance Setup" pseudo-entry represents the account's earliest starting
            // point, so it's built here but appended AFTER the transaction list below (not before)
            // — it belongs at the bottom/last position, underneath every real transaction, rather
            // than pinned above them regardless of date sort. Only shown on the earliest year that
            // has data (or, if the account has no transactions at all, on every visit) — later
            // years show "Balance B/F" instead (see below), so the two never both appear together.
            let openingBalanceHTML = "";
            const isEarliestYear = accountYearIdx <= 0;
            if (showFullAccountHistory && isEarliestYear) {
                const viewingAcc = accounts.find(a => a.id === activeLedgerAccountView);
                if (viewingAcc && viewingAcc.type !== "multi" && viewingAcc.type !== "fd" && viewingAcc.type !== "unittrust" && viewingAcc.initialBalance) {
                    const subText = viewingAcc.currency !== baseCurrency ? `<span class="converted-subtext">≈ ${formatCurrency(convertCurrency(viewingAcc.initialBalance, viewingAcc.currency, baseCurrency), baseCurrency)}</span>` : '';
                    openingBalanceHTML = `
                        <div class="ledger-item" style="background-color: #fafbfd; border-left: 4px solid var(--primary); cursor: default;">
                            <div class="item-left">
                                <span class="item-name" style="font-style: italic;">🏦 [Opening Balance Setup]</span>
                                <span class="item-meta">Account Opening Initial Vault Point</span>
                            </div>
                            <div class="item-right">
                                <div class="item-value" style="color: var(--text-main);">
                                    ${formatCurrency(viewingAcc.initialBalance, viewingAcc.currency)}
                                    ${subText}
                                </div>
                            </div>
                        </div>
                    `;
                }
            }

            // Balance B/F (bottom of the list, below every real transaction for the selected
            // year) and Balance C/F (top, above every real transaction) — only for a specific
            // "normal" account's year-scoped Activity view. B/F is skipped on the earliest year
            // with data (the Opening Balance Setup row above already covers that origin point);
            // C/F is skipped on the latest year with data (there's nothing further to carry into).
            let balanceBfHTML = "", balanceCfHTML = "";
            if (showFullAccountHistory && accountLedgerYearsCache.length > 0 && accountLedgerYear !== null) {
                const viewingAcc = accounts.find(a => a.id === activeLedgerAccountView);
                if (viewingAcc && viewingAcc.type !== "multi" && viewingAcc.type !== "fd" && viewingAcc.type !== "unittrust") {
                    const isLatestYear = accountYearIdx >= accountLedgerYearsCache.length - 1;

                    if (!isEarliestYear) {
                        const yearStartMs = new Date(accountLedgerYear + "-01-01T00:00:00").getTime();
                        const bf = computeAccountBalanceAsOf(viewingAcc, yearStartMs);
                        const subText = viewingAcc.currency !== baseCurrency ? `<span class="converted-subtext">≈ ${formatCurrency(convertCurrency(bf, viewingAcc.currency, baseCurrency), baseCurrency)}</span>` : '';
                        balanceBfHTML = `
                            <div class="ledger-item" style="background-color: #fafbfd; border-left: 4px solid var(--primary); cursor: default;">
                                <div class="item-left">
                                    <span class="item-name" style="font-style: italic;">↩️ Balance B/F</span>
                                    <span class="item-meta">Brought forward from ${accountLedgerYearsCache[accountYearIdx - 1]}</span>
                                </div>
                                <div class="item-right">
                                    <div class="item-value" style="color: var(--text-main);">
                                        ${formatCurrency(bf, viewingAcc.currency)}
                                        ${subText}
                                    </div>
                                </div>
                            </div>
                        `;
                    }

                    if (!isLatestYear) {
                        const yearEndExclusiveMs = new Date((accountLedgerYear + 1) + "-01-01T00:00:00").getTime();
                        const cf = computeAccountBalanceAsOf(viewingAcc, yearEndExclusiveMs);
                        const subText = viewingAcc.currency !== baseCurrency ? `<span class="converted-subtext">≈ ${formatCurrency(convertCurrency(cf, viewingAcc.currency, baseCurrency), baseCurrency)}</span>` : '';
                        balanceCfHTML = `
                            <div class="ledger-item" style="background-color: #fafbfd; border-left: 4px solid var(--primary); cursor: default;">
                                <div class="item-left">
                                    <span class="item-name" style="font-style: italic;">↪️ Balance C/F</span>
                                    <span class="item-meta">Carried forward to ${accountLedgerYearsCache[accountYearIdx + 1]}</span>
                                </div>
                                <div class="item-right">
                                    <div class="item-value" style="color: var(--text-main);">
                                        ${formatCurrency(cf, viewingAcc.currency)}
                                        ${subText}
                                    </div>
                                </div>
                            </div>
                        `;
                    }
                }
            }

            let matchedCount = 0;

            // v74: the dashboard's own month/year filter is meant to scope PERIOD-based reporting
            // on THIS page (the Total Income/Expenses stat boxes above). It used to also gate
            // category/type drill-ins reached via navigateToCategoryPage()/navigateToDirectTypePage()
            // — on the (now stale) assumption those always originated from a breakdown built with
            // this same filter. They don't anymore: the Net Savings Statement and Spending/Income
            // Breakdown pages each have their own independent year/month filters, completely
            // decoupled from this one, so a category click from any of them was silently re-filtered
            // by whatever this dashboard filter happened to be set to — with no indication anything
            // was hidden, sometimes landing on "No matches found" for a category that clearly has
            // transactions. Same root problem as the per-account view fix below: a drill-in's whole
            // job is to show the complete history behind the number you clicked, so category/type
            // views now always show full history too, exactly like the account view already does.
            const showFullHistoryForThisView = showFullAccountHistory || activeCategoryView !== "all" || directTypeView !== "all" || isPortfolioAllView;

            txs.sort((a,b) => new Date(b.date) - new Date(a.date)).forEach(t => {
                const tBase = convertTxAmountToBase(t, accounts);
                // Multi-Currency account view (v55): skip building any per-transaction row here
                // — see isMultiCurrencyAccountView above, this account's own list is replaced
                // with per-currency summary rows further down instead.
                if (isMultiCurrencyAccountView) return;

                // v148: was missing entirely — every branch below that checks a year/month filter
                // (categoryDrillYear/Month, portfolioLedgerYear) reads `d`, but nothing declared
                // it in this scope, so any drill-in that actually set one of those to a real value
                // (e.g. clicking a category from a year-filtered Savings Statement) threw
                // "d is not defined" and silently broke this render. Needed now regardless, since
                // the report card's Income/Expense/Total clicks (below) rely on the same check.
                const d = new Date(t.date);

                let isBound = false;
                if (activeCategoryView !== "all") {
                    // v85: categoryDrillYear/Month carry the year/month filter that was active on
                    // the page this category was clicked from (Net Savings Statement, Spending/
                    // Income Breakdown) — "all" when not set, so a category reached any other way
                    // still shows its complete history exactly as before.
                    isBound = t.cat === activeCategoryView
                        && (categoryDrillYear === "all" || d.getFullYear().toString() === categoryDrillYear)
                        && (categoryDrillMonth === "all" || d.getMonth().toString() === categoryDrillMonth);
                } else if (directTypeView !== "all") {
                    // v148: categoryDrillYear/Month also carry the report card tile's period here
                    // (see navigateToDirectTypePage) — "all" when reached any other way, so every
                    // other existing Income/Expense drill-in still shows full history unchanged.
                    isBound = t.type === directTypeView
                        && (categoryDrillYear === "all" || d.getFullYear().toString() === categoryDrillYear)
                        && (categoryDrillMonth === "all" || d.getMonth().toString() === categoryDrillMonth);
                } else if (activeLedgerAccountView !== "all") {
                    // Year-scoped Account Activity view (v33) — only this account's transactions
                    // dated within the currently selected year (accountLedgerYear).
                    isBound = (t.src === activeLedgerAccountView || t.dest === activeLedgerAccountView)
                        && (accountLedgerYear === null || d.getFullYear() === accountLedgerYear);
                } else {
                    // Portfolio General Log (v128) — the pure "all accounts" view, now year-scoped
                    // by its own nav (portfolioLedgerYear) exactly like a single account's Activity
                    // view is above, rather than only via the Dashboard's separate Month/Year filter.
                    isBound = (portfolioLedgerYear === null || d.getFullYear() === portfolioLedgerYear);
                }

                // v91: skip non-representative Split Expense group siblings for display — the
                // group collapses into one row keyed on its lowest-id member. Balance/report
                // totals above are untouched since they already ran for every individual record.
                // v93 fix: this must NOT apply when viewing one specific category
                // (activeCategoryView !== "all") — isBound there already means "this exact record
                // is the split part belonging to the category being viewed", so hiding it again
                // because some OTHER part of the group (a different category) happens to be the
                // group's rep made every non-rep category's own drill-down page show empty/"No
                // matches found" even though the transaction was correctly counted in every total.
                // Collapsing to one row only makes sense for views spanning multiple categories at
                // once (All / account / type), where a combined row is a helpful summary.
                if (isBound && t.splitGroupId && activeCategoryView === "all") {
                    const info = getSplitGroupInfo(t, txs);
                    if (info && t.id !== info.repId) isBound = false;
                }

                if (!isBound) return;

                matchedCount++;
                // Only build DOM markup for the first `ledgerRenderLimit` matches — keeps large ledgers fast on mobile.
                if (matchedCount > ledgerRenderLimit) return;

                // For transfers, show a directional +/− and color when viewing a specific account
                // (money leaving that account = red/−, money arriving = green/+). When viewing "All"
                // accounts the direction is ambiguous, so it falls back to the neutral 🔄 style.
                let col, sgn;
                if (t.type === "income") { col = "income-color"; sgn = "+"; }
                else if (t.type === "expense") { col = "expense-color"; sgn = "-"; }
                else if (activeLedgerAccountView !== "all" && t.dest === activeLedgerAccountView) { col = "income-color"; sgn = "+"; }
                else if (activeLedgerAccountView !== "all" && t.src === activeLedgerAccountView) { col = "expense-color"; sgn = "-"; }
                else { col = "transfer-color"; sgn = "🔄"; }

                const sub = t.currency !== baseCurrency ? `<span class="converted-subtext">≈ ${formatCurrency(tBase, baseCurrency)}</span>` : '';
                // v91: a representative Split Expense row shows the combined category icons and
                // joined category label — see getSplitGroupInfo().
                // v93 fix: only pull in the whole group's aggregate (combined icons/label/total)
                // when this row is being shown as part of a multi-category view (All / account /
                // type). Inside one specific category's own drill-down, `t` already *is* that
                // category's own split part — showing the group total there was the RM190-for-a-
                // RM90-or-RM100-part bug from Images 1/3/4, so those views must use this record's
                // own cat/amount instead, exactly like a non-split transaction would.
                const splitInfo = (t.splitGroupId && activeCategoryView === "all") ? getSplitGroupInfo(t, txs) : null;
                const iconBadge = t.type === "transfer"
                    ? "🔄"
                    : (splitInfo ? splitInfo.members.map(m => getCategoryIcon(m.cat, t.type)).join("") : getCategoryIcon(t.cat, t.type));
                // v88: a small ✅ overlay flags a transaction the user has already reconciled
                // against a bank/card statement (see the Checked toggle in Quick View / the entry
                // form) — purely a visual cue, no effect on any total. v150: moved from an inline
                // overlay on the small text-line icon (checkedIconHTML) onto the big tx-icon-circle
                // instead — see txCheckOverlay below.
                const refundBadge = t.isRefund
                    ? `<span style="font-size:0.62rem; font-weight:700; color:#15803d; background:#dcfce7; padding:1px 5px; border-radius:4px; margin-left:6px; white-space:nowrap;">↩️ Refund</span>`
                    : '';
                const attCount = (Array.isArray(t.attachments) ? t.attachments.length : 0) + (t.image ? 1 : 0);
                const receiptBadge = attCount > 0
                    ? `<span data-click="openTxAttachmentsBadge" data-attachments="${escapeHtml(JSON.stringify(t.attachments || []))}" ${t.image ? `data-legacy-image="${escapeHtml(t.image)}"` : ''} style="cursor:pointer; margin-left:4px;" title="View attachment${attCount > 1 ? 's' : ''}">📎${attCount > 1 ? `<span style="font-size:0.6rem; vertical-align:top;">×${attCount}</span>` : ''}</span>`
                    : '';
                const referenceText = t.fdReferenceNo ? ` · Ref: ${escapeHtml(t.fdReferenceNo)}` : '';
                // Maturity date (v55) — shown inline on every FD placement row, not just inside
                // the maturity reminder banner, so it's visible while scrolling that account's
                // own Activity history too. fdResolved placements keep showing their maturity
                // date for reference even though the ✅ Closed badge already covers status.
                const maturityText = t.fdMaturityDate ? ` · Matures ${escapeHtml(t.fdMaturityDate)}` : '';
                const manualFxBadge = (t.manualFxRate || (t.type === "transfer" && t.destAmount != null))
                    ? `<span style="font-size:0.62rem; font-weight:700; color:#c2410c; background:#ffedd5; padding:1px 5px; border-radius:4px; margin-left:6px; white-space:nowrap;">✏️ Manual FX</span>`
                    : '';

                // What to show as the headline amount for this row. For a cross-currency Transfer
                // viewed from its destination account specifically, showing the source amount/
                // currency (e.g. "S$500" on a MYR account's own Activity page) doesn't match what
                // that account actually shows as credited — so it's swapped for the destination-
                // side figure instead: the locked destAmount when one was entered, or (matching
                // what computeAccountBalances() actually applies) a live-converted estimate
                // otherwise, clearly marked "≈" since it isn't fixed.
                let displayAmountHTML = `${sgn}${formatCurrency(splitInfo ? splitInfo.totalAmount : t.amount, t.currency)}`;
                if (t.type === "transfer" && activeLedgerAccountView === t.dest) {
                    const destAcc = accounts.find(a => a.id === t.dest);
                    const srcAcc = accounts.find(a => a.id === t.src);
                    if (destAcc && srcAcc && destAcc.type !== "multi" && destAcc.type !== "fd" && destAcc.type !== "unittrust" && destAcc.currency !== t.currency) {
                        const shown = t.destAmount != null ? t.destAmount : convertCurrency(t.amount, t.currency, destAcc.currency);
                        const prefix = t.destAmount != null ? "" : "≈ ";
                        displayAmountHTML = `${sgn}${prefix}${formatCurrency(shown, destAcc.currency)}`;
                    }
                }

                // Which account(s) this entry touches — shown as its own line so an Income/Expense
                // row states where the money came from/went, and a Transfer states both legs,
                // regardless of which page it's viewed from (a single account's own Activity page,
                // or a combined view like a category/type breakdown where the account otherwise
                // isn't obvious at all).
                // Opening Balance / Opening Fixed Deposit Placement entries deliberately leave
                // src blank ("") — the funds originate outside the app, not from a since-deleted
                // account — so an empty id is labelled distinctly from an id that actually points
                // at a removed account record.
                const accountName = id => { if (!id) return "(Opening Balance)"; const a = accounts.find(acc => acc.id === id); return a ? escapeHtml(accountOptionLabel(a, accounts)) : "(deleted account)"; };
                let accountText;
                if (t.type === "transfer") {
                    accountText = `🏦 ${accountName(t.src)} → ${t.dest ? accountName(t.dest) : "(unknown)"}`;
                } else {
                    accountText = `🏦 ${accountName(t.src)}`;
                }

                // FD placement status — shows at a glance whether a placement is still running,
                // overdue for action, or has already been renewed/withdrawn and closed out.
                let fdStatusBadge = '';
                if (t.fdMaturityDate) {
                    if (t.fdResolved) {
                        fdStatusBadge = `<span style="font-size:0.62rem; font-weight:700; color:#b91c1c; background:#e2e8f0; padding:1px 5px; border-radius:4px; margin-left:6px; white-space:nowrap;">✅ Closed</span>`;
                    } else {
                        const isOverdue = new Date(t.fdMaturityDate + "T00:00:00").getTime() < new Date(todayLocalStr() + "T00:00:00").getTime();
                        fdStatusBadge = isOverdue
                            ? `<span style="font-size:0.62rem; font-weight:700; color:#b91c1c; background:#fee2e2; padding:1px 5px; border-radius:4px; margin-left:6px; white-space:nowrap;">⏰ Due</span>`
                            : `<span style="font-size:0.62rem; font-weight:700; color:#15803d; background:#dcfce7; padding:1px 5px; border-radius:4px; margin-left:6px; white-space:nowrap;">🟢 Active</span>`;
                    }
                }

                // v96: Notes now doubles as the free-text "who/what" line the removed To/From field
                // used to cover — see the txPayee removal comment on the record-save assignment
                // above — so it's surfaced right on the row here too, not just inside Quick View.
                const notesLine = t.notes ? `<span class="item-meta" style="display:block; margin-top:2px; color:var(--text-muted); font-style:italic;">${escapeHtml(t.notes)}</span>` : '';

                // v150: the category icon now shows big, in its own colored circle beside the
                // details (reference: a competing budget app's Transactions list) — checkedIconHTML
                // above still holds the emoji (+ ✅ checkmark overlay when reconciled), just moved
                // out of the title text into txIconCircleHTML below. Transfers get a neutral
                // lavender circle since they aren't tied to any one category.
                const txIconBg = t.type === "transfer" ? "#e0e7ff" : categoryIconBgColor(splitInfo ? splitInfo.catLabel : (t.cat || t.type));
                const txCheckOverlay = t.checked
                    ? `<span style="position:absolute; bottom:-2px; right:-2px; font-size:0.55rem; background:#15803d; color:white; border-radius:50%; width:14px; height:14px; line-height:14px; text-align:center; border:2px solid var(--card-bg);">✓</span>`
                    : '';
                const txIconCircleHTML = `<div class="tx-icon-circle" style="background:${txIconBg};"><span style="line-height:1;">${iconBadge}</span>${txCheckOverlay}</div>`;

                ledgerHTML += `
                    <div class="ledger-item ledger-item-tx" data-click="openTxQuickView" data-type="${t.type}" data-id="${escapeHtml(t.id)}">
                        ${txIconCircleHTML}
                        <div class="tx-row-body">
                            <div class="item-left">
                                <span class="item-name">${escapeHtml(t.desc)}${fdStatusBadge}${manualFxBadge}${refundBadge}</span>
                                <span class="item-meta">${t.date} [${escapeHtml(splitInfo ? splitInfo.catLabel : (t.cat || 'Transfer'))}]${referenceText}${maturityText}${receiptBadge}</span>
                                <span class="item-meta" style="display:block; margin-top:2px; color:var(--text-muted);">${accountText}</span>
                                ${notesLine}
                            </div>
                            <div class="item-right">
                                <div class="item-value" style="color:var(--${col}); font-weight: bold;">
                                    ${displayAmountHTML}
                                    ${sub}
                                </div>
                            </div>
                        </div>
                        <span class="tx-side-bar" style="background:var(--${col});"></span>
                    </div>
                `;
            });

            if (matchedCount > ledgerRenderLimit) {
                const remaining = matchedCount - ledgerRenderLimit;
                ledgerHTML += `
                    <button type="button" class="submit-btn" style="background:var(--chip-bg); color:var(--text-main); margin:12px;" data-click="loadMoreLedgerRows">
                        Load ${Math.min(remaining, LEDGER_PAGE_SIZE)} more (${remaining} remaining)
                    </button>
                `;
            }

            // Balance C/F goes above every transaction rendered above it, then B/F and Opening
            // Balance Setup go below — prepend/append accordingly so both sit outside the real
            // transaction list regardless of the "Load more" button that may sit just above them.
            ledgerHTML = balanceCfHTML + ledgerHTML;
            ledgerHTML += balanceBfHTML;
            ledgerHTML += openingBalanceHTML;

            renderReportCards(txs, accounts);
            renderMonthlyTrendChart(txs, accounts);

            // Unit Trust account's own Activity page: each fund now has its own dedicated
            // Activity page (see navigateToFundActivityPage) showing that fund's transactions,
            // so the mixed Buy/Sell/Dividend log below the Fund Holdings table here would just
            // duplicate — and, across multiple funds, jumble together — what's already broken
            // out per-fund elsewhere. Skip building/showing it for this account type only.
            const ledgerListEl = document.getElementById("ledgerList");
            if (isUnitTrustAccountView) {
                ledgerListEl.innerHTML = "";
                ledgerListEl.style.display = "none";
            } else if (isMultiCurrencyAccountView) {
                const baskets = nativeBalances[viewingMultiAcc.id] || {};
                const currencies = Object.keys(baskets).sort();
                ledgerListEl.style.display = "";
                ledgerListEl.innerHTML = currencies.length === 0
                    ? '<p style="padding:20px; text-align:center; color:var(--text-muted); font-size:0.8rem;">No funds yet — tap + to log an opening balance or transaction.</p>'
                    : currencies.map(curr => {
                        // Base-currency equivalent shown under the name+amount line (same
                        // .converted-subtext pattern used on the account's own ledger rows), so
                        // it's clear at a glance what each foreign balance is worth in baseCurrency
                        // without having to open that currency's own Activity log.
                        const subText = curr !== baseCurrency
                            ? `<span class="converted-subtext">≈ ${formatCurrency(convertCurrency(baskets[curr], curr, baseCurrency), baseCurrency)}</span>`
                            : "";
                        // Name and amount combined into one item-left block (Unit Trust fund
                        // subrow style) rather than split across item-left/item-right — with only
                        // a short currency code on the left and a short amount on the right,
                        // .ledger-item's justify-content:space-between left a wide empty gap
                        // between them.
                        return `
                        <div class="ledger-item" style="cursor:pointer;" data-click="navigateToCurrencyActivityPage" data-id="${escapeHtml(viewingMultiAcc.id)}" data-currency="${escapeHtml(curr)}" data-back="ledger">
                            <div class="item-left" style="max-width:100%;">
                                <span class="item-name">${escapeHtml(curr)} <span style="color:var(--text-muted); font-weight:600;">— ${formatBalanceHTML(baskets[curr], curr)}</span></span>
                                ${subText}
                            </div>
                        </div>`;
                    }).join("");
            } else {
                ledgerListEl.style.display = "";
                ledgerListEl.innerHTML = ledgerHTML || '<p style="padding:20px; text-align:center; color:var(--text-muted); font-size:0.8rem;">No matches found.</p>';
            }

            // The Net Savings Statement page has its own independent "All Years / Year" filter
            // (not the dashboard's report card tiles, see renderReportCards()/getReportCardPeriodRange()
            // above), so it's rendered by a dedicated function with its own totals.
            await renderSavingsStatement();

            calculateStorageMetrics();
        }

        // Populates the Net Savings Statement's own Year filter — independent of the dashboard's
        // report card period selects (see renderReportCards()). Only years that actually have a
        // transaction, plus the current year; preserves selection across re-renders; defaults to
        // "All Years" on first load.
        let savingsYearFilterInitialized = false;
        function populateSavingsYearFilterOptions(txs) {
            const select = document.getElementById("savingsYearFilter");
            const prevValue = select.value;
            const currentYear = new Date().getFullYear();

            const years = new Set([currentYear]);
            txs.forEach(t => {
                const y = new Date(t.date).getFullYear();
                if (!isNaN(y)) years.add(y);
            });

            const sortedYears = [...years].sort((a, b) => b - a);
            select.innerHTML = `<option value="all">All Years</option>` +
                sortedYears.map(y => `<option value="${y}">${y}</option>`).join("");

            // v148: report card "Total" click forcing a specific year takes priority over both
            // the first-load default and the normal preserve-selection-across-renders behaviour
            // below — one-shot, cleared immediately so it doesn't stick past this render.
            if (pendingSavingsYearOverride !== null) {
                const preset = pendingSavingsYearOverride;
                pendingSavingsYearOverride = null;
                select.value = (preset === "all" || sortedYears.map(String).includes(preset)) ? preset : "all";
                savingsYearFilterInitialized = true;
                return;
            }

            if (!savingsYearFilterInitialized) {
                select.value = "all";
                savingsYearFilterInitialized = true;
            } else if (prevValue === "all" || sortedYears.map(String).includes(prevValue)) {
                select.value = prevValue;
            } else {
                select.value = "all";
            }
        }

        // Below this, a category total is treated as 0.00 and hidden — covers exact 0 as well as
        // FX-conversion rounding noise (e.g. an expense that nets to -0.001 after currency
        // conversion) that would otherwise display as a misleading "-0.00" row.
        const SAVINGS_ZERO_EPS = 0.005;

        // v103: which Main Categories currently have their Subcategory breakdown expanded on the
        // Net Savings Statement — keyed by category id (unique across income/expense, so one Set
        // covers both sections). Module-level state, not persisted: resets to all-collapsed on
        // reload, same lifetime as e.g. activeCategoryView. Toggled by toggleSavingsMainExpand().
        let savingsExpandedMains = new Set();

        function toggleSavingsMainExpand(id) {
            if (savingsExpandedMains.has(id)) savingsExpandedMains.delete(id);
            else savingsExpandedMains.add(id);
            renderSavingsStatement();
        }

        // v103: builds one section's (income or expense) rows for the Net Savings Statement.
        // A Main Category with its own Subcategories now shows ONE combined row summing its own
        // directly-assigned total plus every Subcategory's total, with a ▼/▲ toggle to reveal the
        // Subcategories underneath (each with its own individual total) — see
        // savingsExpandedMains/toggleSavingsMainExpand() above for the expand/collapse state.
        // A Main Category with no Subcategories, or a legacy/fallback category name with no
        // matching record at all, still renders exactly as a single flat row like before v103.
        // v190: filterM (savingsFilterMonth at render time) added — every row here carries it
        // through to navigateToCategoryPage as data-month, alongside the year it already carried.
        // Previously only the year was passed, so a category clicked from a month-scoped visit
        // (report card's "Total" click — see navigateToSavingsPage/savingsFilterMonth) opened
        // that category's whole-year history instead of just the month actually being viewed.
        function buildSavingsSectionRowsHTML(catSummary, type, filterY, filterM) {
            const catRecords = dynamicCategories.filter(c => c.type === type);
            const mains = catRecords.filter(c => !c.parentId).sort((a, b) => a.name.localeCompare(b.name));
            const subsByMainId = new Map();
            catRecords.filter(c => c.parentId).forEach(s => {
                if (!subsByMainId.has(s.parentId)) subsByMainId.set(s.parentId, []);
                subsByMainId.get(s.parentId).push(s);
            });

            const sign = type === "income" ? "+" : "-";
            const color = type === "income" ? "var(--income-color)" : "var(--expense-color)";
            const rendered = new Set();
            let html = "";

            mains.forEach(main => {
                const subs = (subsByMainId.get(main.id) || []).slice().sort((a, b) => a.name.localeCompare(b.name));
                rendered.add(main.name);
                const directVal = catSummary[main.name] || 0;
                let combined = directVal;
                const subRowsData = [];
                subs.forEach(s => {
                    rendered.add(s.name);
                    const v = catSummary[s.name] || 0;
                    combined += v;
                    if (Math.abs(v) >= SAVINGS_ZERO_EPS) subRowsData.push({ name: s.name, value: v, icon: s.icon });
                });

                if (Math.abs(combined) < SAVINGS_ZERO_EPS && subRowsData.length === 0) return;

                const icon = main.icon || getCategoryIcon(main.name, type);
                const hasSubs = subRowsData.length > 0;
                const expanded = savingsExpandedMains.has(main.id);

                html += `
                    <div class="statement-row" style="align-items:center;">
                        <span style="cursor:pointer;" data-click="navigateToCategoryPage" data-category="${escapeHtml(main.name)}" data-back="savings" data-year="${escapeHtml(filterY)}" data-month="${escapeHtml(filterM)}">
                            <strong>${icon} ${escapeHtml(main.name)}</strong>
                        </span>
                        <span style="display:flex; align-items:center; gap:8px;">
                            <span style="color:${color}; font-weight:700;">${sign}${formatCurrency(combined, baseCurrency)}</span>
                            ${hasSubs ? `<button type="button" class="trash-btn" data-click="toggleSavingsMainExpand" data-id="${escapeHtml(main.id)}" title="${expanded ? 'Hide subcategories' : 'Show subcategories'}" style="padding:2px 6px; font-size:0.7rem;">${expanded ? '▲' : '▼'}</button>` : ''}
                        </span>
                    </div>
                `;

                if (hasSubs && expanded) {
                    subRowsData.forEach(s => {
                        html += `
                            <div class="statement-row" data-click="navigateToCategoryPage" data-category="${escapeHtml(s.name)}" data-back="savings" data-year="${escapeHtml(filterY)}" data-month="${escapeHtml(filterM)}" style="padding-left:22px; border-left:2px solid var(--border-color); margin-left:6px;">
                                <span><span style="color:var(--text-muted);">↳</span> ${s.icon} ${escapeHtml(s.name)}</span>
                                <span style="color:${color}; font-weight:700;">${sign}${formatCurrency(s.value, baseCurrency)}</span>
                            </div>
                        `;
                    });
                }
            });

            Object.keys(catSummary).sort((a, b) => a.localeCompare(b)).forEach(name => {
                if (rendered.has(name)) return;
                const val = catSummary[name];
                if (Math.abs(val) < SAVINGS_ZERO_EPS) return;
                const icon = getCategoryIcon(name, type);
                html += `
                    <div class="statement-row" data-click="navigateToCategoryPage" data-category="${escapeHtml(name)}" data-back="savings" data-year="${escapeHtml(filterY)}" data-month="${escapeHtml(filterM)}">
                        <strong>${icon} ${escapeHtml(name)}</strong>
                        <span style="color:${color}; font-weight:700;">${sign}${formatCurrency(val, baseCurrency)}</span>
                    </div>
                `;
            });

            return html;
        }

        async function renderSavingsStatement() {
            const txs = await readAllDB(STORES.TRANSACTIONS);
            const accounts = await readAllDB(STORES.ACCOUNTS);
            populateSavingsYearFilterOptions(txs);
            const filterY = document.getElementById("savingsYearFilter").value;

            // v148: small "Filtered: <Month Year> · Clear" badge for the report card's Total
            // click — only ever visible when savingsFilterMonth is set, i.e. reached that way.
            const monthScopeBadge = document.getElementById("savingsMonthScopeBadge");
            if (savingsFilterMonth !== "all") {
                const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
                const yearLabel = filterY !== "all" ? filterY : new Date().getFullYear();
                document.getElementById("savingsMonthScopeBadgeText").textContent = `Filtered: ${monthNames[parseInt(savingsFilterMonth)]} ${yearLabel}`;
                monthScopeBadge.style.display = "flex";
            } else {
                monthScopeBadge.style.display = "none";
            }

            const currentIncomeCategories = [...new Set([...dynamicCategories.filter(c => c.type === "income").map(c => c.name), "Salary", "Investments", "Freelance", "Other Income"])];
            const currentExpenseCategories = [...new Set([...dynamicCategories.filter(c => c.type === "expense").map(c => c.name), "Groceries", "Dining Out", "Utilities", "Rent", "Commute", "Entertainment", "Other Expenses"])];

            // v72: categories flagged "Exclude from Net Savings Report" (Manage Categories) —
            // their transactions are pulled out of incBaseTotal/expBaseTotal/catSummary below and
            // tallied separately into excludedSummary/excludedNetTotal instead, so they don't move
            // the Surplus/Deficit but still show up as their own total on this page.
            const excludedCatNames = new Set(dynamicCategories.filter(c => c.excludeFromSavings).map(c => c.name));

            const catSummary = { income: {}, expense: {} };
            currentIncomeCategories.forEach(c => catSummary.income[c] = 0);
            currentExpenseCategories.forEach(c => catSummary.expense[c] = 0);

            const excludedSummary = {};
            let excludedNetTotal = 0;

            let incBaseTotal = 0, expBaseTotal = 0;
            txs.forEach(t => {
                if (filterY !== "all" && new Date(t.date).getFullYear().toString() !== filterY) return;
                // v148: report card "Total" click may also carry a specific month (see
                // navigateToSavingsPage/savingsFilterMonth) — "all" the rest of the time, so this
                // page filters by year alone exactly as before for every other visit.
                if (savingsFilterMonth !== "all" && new Date(t.date).getMonth().toString() !== savingsFilterMonth) return;

                const tBase = convertTxAmountToBase(t, accounts);
                if (t.type === "income" && t.isRefund) {
                    // v88: refund — reduces the original expense category (matched via t.cat, see
                    // openRefundFromOptions()) instead of counting as income. Still respects the
                    // same "exclude from savings" category setting an ordinary expense in that
                    // category would.
                    if (excludedCatNames.has(t.cat)) {
                        excludedSummary[t.cat] = excludedSummary[t.cat] || { value: 0, type: "expense" };
                        excludedSummary[t.cat].value -= tBase;
                        excludedNetTotal += tBase;
                        return;
                    }
                    expBaseTotal -= tBase;
                    catSummary.expense[t.cat] = (catSummary.expense[t.cat] || 0) - tBase;
                    return;
                }
                if (t.type === "income") {
                    if (excludedCatNames.has(t.cat)) {
                        excludedSummary[t.cat] = excludedSummary[t.cat] || { value: 0, type: "income" };
                        excludedSummary[t.cat].value += tBase;
                        excludedNetTotal += tBase;
                        return;
                    }
                    incBaseTotal += tBase;
                    catSummary.income[t.cat] = (catSummary.income[t.cat] || 0) + tBase;
                }
                if (t.type === "expense") {
                    if (excludedCatNames.has(t.cat)) {
                        excludedSummary[t.cat] = excludedSummary[t.cat] || { value: 0, type: "expense" };
                        excludedSummary[t.cat].value += tBase;
                        excludedNetTotal -= tBase;
                        return;
                    }
                    expBaseTotal += tBase;
                    catSummary.expense[t.cat] = (catSummary.expense[t.cat] || 0) + tBase;
                }
            });

            let incRowsHTML = buildSavingsSectionRowsHTML(catSummary.income, "income", filterY, savingsFilterMonth);
            document.getElementById("savingsIncomeRows").innerHTML = incRowsHTML || '<p style="font-size:0.75rem; color:var(--text-muted);">No income entries logged.</p>';
            document.getElementById("savingsIncomeTotal").textContent = `+${formatCurrency(Math.abs(incBaseTotal) < SAVINGS_ZERO_EPS ? 0 : incBaseTotal, baseCurrency)}`;

            let expRowsHTML = buildSavingsSectionRowsHTML(catSummary.expense, "expense", filterY, savingsFilterMonth);
            document.getElementById("savingsExpenseRows").innerHTML = expRowsHTML || '<p style="font-size:0.75rem; color:var(--text-muted);">No expense entries logged.</p>';
            document.getElementById("savingsExpenseTotal").textContent = `-${formatCurrency(Math.abs(expBaseTotal) < SAVINGS_ZERO_EPS ? 0 : expBaseTotal, baseCurrency)}`;

            const statementDiff = incBaseTotal - expBaseTotal;
            document.getElementById("savingsSurplusLabel").textContent = statementDiff >= 0 ? "Surplus Margin (Savings):" : "Deficit (Shortfall Margin):";
            document.getElementById("savingsSurplusValue").textContent = formatCurrency(statementDiff, baseCurrency);
            document.getElementById("savingsSurplusValue").style.color = statementDiff >= 0 ? "var(--income-color)" : "var(--expense-color)";

            // v72: "Excluded from Report" card — categories flagged excludeFromSavings (e.g.
            // "Family" gifts), tallied but kept out of the Surplus/Deficit above. Hidden entirely
            // when nothing's excluded so the page looks exactly like before for anyone not using
            // the feature.
            let excludedRowsHTML = "";
            Object.keys(excludedSummary).sort((a, b) => a.localeCompare(b)).forEach(c => {
                const entry = excludedSummary[c];
                if (Math.abs(entry.value) < SAVINGS_ZERO_EPS) return;
                const icon = getCategoryIcon(c, entry.type);
                const sign = entry.type === "income" ? "+" : "-";
                const color = entry.type === "income" ? "var(--income-color)" : "var(--expense-color)";
                excludedRowsHTML += `
                    <div class="statement-row" data-click="navigateToCategoryPage" data-category="${escapeHtml(c)}" data-back="savings" data-year="${escapeHtml(filterY)}" data-month="${escapeHtml(savingsFilterMonth)}">
                        <strong>${icon} ${escapeHtml(c)}</strong>
                        <span style="color:${color}; font-weight:700;">${sign}${formatCurrency(entry.value, baseCurrency)}</span>
                    </div>
                `;
            });
            const excludedCard = document.getElementById("savingsExcludedCard");
            if (excludedRowsHTML) {
                excludedCard.style.display = "";
                document.getElementById("savingsExcludedRows").innerHTML = excludedRowsHTML;
                document.getElementById("savingsExcludedTotal").textContent = formatCurrency(Math.abs(excludedNetTotal) < SAVINGS_ZERO_EPS ? 0 : excludedNetTotal, baseCurrency);
                document.getElementById("savingsExcludedTotal").style.color = excludedNetTotal >= 0 ? "var(--income-color)" : "var(--expense-color)";
            } else {
                excludedCard.style.display = "none";
            }
        }

        // --- SPENDING / INCOME BREAKDOWN PAGES (moved out of dashboard + Income Breakdown added, v32) ---

        // Small fixed palette, cycled by category index, used by the bar/donut chart views.
        const BREAKDOWN_CHART_COLORS = ["#6366f1", "#f97316", "#10b981", "#ef4444", "#0ea5e9", "#eab308", "#a855f7", "#14b8a6", "#ec4899", "#84cc16", "#64748b", "#f43f5e"];

        // Builds the shared "List" view (category rows with a % progress bar) — the same markup
        // the old dashboard Spending Breakdown used, now reused by both breakdown pages.
        function buildBreakdownListHTML(entries, total, type, year = "all", month = "all") {
            if (entries.length === 0) return '<p style="font-size: 0.75rem; text-align: center; color: var(--text-muted);">Nothing categorised yet.</p>';
            return entries.map(e => {
                const pct = total > 0 ? ((e.value / total) * 100).toFixed(0) : 0;
                const icon = getCategoryIcon(e.label, type);
                return `
                    <div class="category-row-item" data-click="navigateToCategoryPage" data-category="${escapeHtml(e.label)}" data-year="${escapeHtml(year)}" data-month="${escapeHtml(month)}" style="font-size:0.75rem; margin-top:4px;">
                        <div style="display:flex; justify-content:space-between; margin-bottom: 2px;">
                            <strong>${icon} ${escapeHtml(e.label.toUpperCase())}</strong>
                            <span>${formatCurrency(e.value, baseCurrency)} (${pct}%)</span>
                        </div>
                        <div class="progress-bar-container"><div class="progress-bar-fill" style="width:${pct}%; background:${e.color};"></div></div>
                    </div>
                `;
            }).join("");
        }

        // Simple vertical bar chart, no external chart library — plain SVG scaled to the largest
        // category so bars are comparable at a glance.
        function buildBreakdownBarSVG(entries) {
            if (entries.length === 0) return "";
            const w = 320, h = 200, padBottom = 34, padTop = 10;
            const maxVal = Math.max(...entries.map(e => e.value), 0.01);
            const barW = Math.min(48, (w - 20) / entries.length - 10);
            const gap = (w - 20 - barW * entries.length) / (entries.length + 1);
            let bars = "";
            entries.forEach((e, i) => {
                const barH = ((h - padBottom - padTop) * e.value) / maxVal;
                const x = 10 + gap + i * (barW + gap);
                const y = h - padBottom - barH;
                bars += `
                    <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="4" fill="${e.color}"></rect>
                    <text x="${(x + barW / 2).toFixed(1)}" y="${h - padBottom + 14}" font-size="9" text-anchor="middle" fill="#64748b">${escapeHtml(e.label.length > 8 ? e.label.slice(0, 7) + "…" : e.label)}</text>
                `;
            });
            return `<svg viewBox="0 0 ${w} ${h}" style="width:100%; max-width:${w}px; display:block; margin:0 auto;">${bars}</svg>`;
        }

        // Donut chart via stroke-dasharray on a circle — the standard no-library technique for a
        // simple pie/donut in raw SVG. v187: rounded, gapped segments + an HTML overlay centered
        // in the hole showing the top (largest) category, plus a full-width legend list below
        // with icon/name/amount/percentage per row — see the matching CSS comment on
        // .breakdown-donut-svg-holder for why (was a plain solid-stroke ring + cramped side
        // legend that didn't fit the 300px dashboard Insights rail). `entries` must already be
        // sorted descending by value (every caller already does this for its own legend/ranking,
        // so entries[0] is the largest slice — that's what the center overlay shows by default).
        // v191: interactive — tapping a slice (or its matching legend row) "pops" that segment
        // outward and swaps the center overlay to show ITS icon/name/amount/share instead of the
        // default top category; tapping the same one again puts it back. `activeIndex` is which
        // entries[] index is currently popped (null = none, showing the default top-category
        // center). `wrapId` is stamped onto every clickable element as data-wrap so the click
        // handler (toggleDonutSlice, wired through donutState below) knows which <div id=wrapId>
        // to re-render — every caller must render through renderDonutIntoWrap() (not call this
        // function directly) for that state tracking to work.
        function buildBreakdownDonutSVG(entries, total, type = "expense", activeIndex = null, wrapId = "") {
            if (entries.length === 0 || total <= 0) return "";
            const size = 220, r = 76, cx = size / 2, cy = size / 2, circumference = 2 * Math.PI * r;
            // Small fixed-px gap between adjacent segments, centered on each boundary via the
            // half-gap dashoffset nudge below — only applied when there's more than one slice
            // (a single 100% category should still read as a clean unbroken ring).
            const gapPx = entries.length > 1 ? 5 : 0;
            const popPx = 12; // how far the active slice is pushed outward, in SVG user units
            let offsetCursor = 0;
            let segments = "";
            entries.forEach((e, i) => {
                const sliceLen = (e.value / total) * circumference;
                const dashVisible = Math.max(0, sliceLen - gapPx);
                const isActive = i === activeIndex;
                // Pop transform: computed as translate-THEN-rotate (rightmost transform applies
                // first) so the translate happens in the already-rotated screen frame — i.e. dx/dy
                // below are plain "push this many px toward 3 o'clock / 6 o'clock" screen deltas,
                // no extra angle correction needed for the existing rotate(-90 cx cy) every slice
                // already carries.
                let popTransform = "";
                if (isActive) {
                    const midFrac = (offsetCursor + sliceLen / 2) / circumference;
                    const visualAngleRad = (midFrac * 360 - 90) * (Math.PI / 180);
                    const dx = (popPx * Math.cos(visualAngleRad)).toFixed(2);
                    const dy = (popPx * Math.sin(visualAngleRad)).toFixed(2);
                    popTransform = `translate(${dx} ${dy}) `;
                }
                const strokeW = isActive ? 30 : 26;
                const opacity = (activeIndex !== null && !isActive) ? 0.55 : 1;
                segments += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${e.color}" stroke-width="${strokeW}" stroke-opacity="${opacity}" stroke-linecap="round" stroke-dasharray="${dashVisible.toFixed(2)} ${(circumference - dashVisible).toFixed(2)}" stroke-dashoffset="${(-(offsetCursor + gapPx / 2)).toFixed(2)}" transform="${popTransform}rotate(-90 ${cx} ${cy})" style="cursor:pointer; transition:stroke-width 0.15s, stroke-opacity 0.15s;" data-click="toggleDonutSlice" data-wrap="${escapeHtml(wrapId)}" data-index="${i}"></circle>`;
                offsetCursor += sliceLen;
            });

            // Center overlay: the active slice if one's popped, else the largest category by
            // value (entries[0]) — icon, name, amount, and its share of the total. A plain HTML
            // div positioned over the SVG hole rather than SVG <text>, so normal CSS (ellipsis,
            // font-weight, var(--text-main)) applies.
            const shown = activeIndex !== null ? entries[activeIndex] : entries[0];
            const shownPct = total > 0 ? Math.round((shown.value / total) * 100) : 0;
            const centerHTML = `
                <div class="breakdown-donut-center">
                    <div class="breakdown-donut-center-icon">${getCategoryIcon(shown.label, type)}</div>
                    <div class="breakdown-donut-center-label">${escapeHtml(shown.label)}</div>
                    <div class="breakdown-donut-center-amount">${formatCurrency(shown.value, baseCurrency)}</div>
                    <div class="breakdown-donut-center-pct">${shownPct}% of total</div>
                </div>`;

            const legend = entries.map((e, i) => {
                const pct = total > 0 ? ((e.value / total) * 100).toFixed(0) : 0;
                const isActive = i === activeIndex;
                const rowStyle = isActive
                    ? "background:var(--bg-color); border-radius:8px; padding:4px 6px; margin:-4px -6px;"
                    : "";
                return `
                    <div class="breakdown-donut-legend-row" style="cursor:pointer; ${rowStyle}" data-click="toggleDonutSlice" data-wrap="${escapeHtml(wrapId)}" data-index="${i}">
                        <span class="breakdown-donut-legend-dot" style="background:${e.color};${isActive ? " box-shadow:0 0 0 3px " + e.color + "40;" : ""}"></span>
                        <span class="breakdown-donut-legend-label" style="${isActive ? "font-weight:800;" : ""}">${getCategoryIcon(e.label, type)} ${escapeHtml(e.label)}</span>
                        <span class="breakdown-donut-legend-amount">${formatCurrency(e.value, baseCurrency)}</span>
                        <span class="breakdown-donut-legend-pct">${pct}%</span>
                    </div>`;
            }).join("");

            return `
                <div class="breakdown-donut-svg-holder">
                    <svg viewBox="0 0 ${size} ${size}">${segments}</svg>
                    ${centerHTML}
                </div>
                <div class="breakdown-donut-legend">${legend}</div>
            `;
        }

        // v191: per-wrapId memory of { entries, total, type, activeIndex } so a slice/legend-row
        // click (toggleDonutSlice below) can re-render just that one donut with its popped state
        // toggled, without needing to re-run the whole page's data query. Every donut-producing
        // caller must go through renderDonutIntoWrap() (not call buildBreakdownDonutSVG directly)
        // so this stays in sync — a full re-render (filter change, month tick, etc.) always
        // resets that wrap's activeIndex to null, matching plain "nothing selected" default.
        let donutState = {};

        function renderDonutIntoWrap(wrapId, entries, total, type) {
            donutState[wrapId] = { entries, total, type, activeIndex: null };
            const wrap = document.getElementById(wrapId);
            if (!wrap) return;
            wrap.innerHTML = entries.length ? buildBreakdownDonutSVG(entries, total, type, null, wrapId) : "";
        }

        function toggleDonutSlice(el) {
            const wrapId = el.dataset.wrap;
            const idx = parseInt(el.dataset.index, 10);
            const state = donutState[wrapId];
            if (!state) return;
            state.activeIndex = state.activeIndex === idx ? null : idx;
            const wrap = document.getElementById(wrapId);
            if (wrap) wrap.innerHTML = buildBreakdownDonutSVG(state.entries, state.total, state.type, state.activeIndex, wrapId);
        }

        function renderBreakdownChart(wrapId, chartType, entries, total, type) {
            const wrap = document.getElementById(wrapId);
            if (chartType === "bar") wrap.innerHTML = buildBreakdownBarSVG(entries);
            else if (chartType === "donut") renderDonutIntoWrap(wrapId, entries, total, type);
            else wrap.innerHTML = ""; // "list" view has no separate chart — the list rows are the whole view

        }

        // Fills a breakdown page's "Member" filter dropdown with every member. "All Members"
        // (default) includes everyone plus joint accounts; picking one member restricts to that
        // member's solo-owned accounts only (joint accounts are excluded); "Joint" (v87) is the
        // mirror image — restricts to accounts/funds with 2+ owners only, excluding every
        // solo-owned account.
        function populateBreakdownMemberFilter(selectId) {
            const select = document.getElementById(selectId);
            const prevValue = select.value || "all";
            select.innerHTML = `<option value="all">All Members (everyone, incl. joint)</option>` +
                `<option value="joint">Joint (2+ owners)</option>` +
                membersCache.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join("");
            select.value = (prevValue === "joint" || membersCache.some(m => m.id === prevValue)) ? prevValue : "all";
        }

        // Returns the set of account IDs matching a breakdown page's Member filter value: solo-
        // owned by that member for a specific member id, 2+ owners for "joint". Caller only calls
        // this when filterValue !== "all" (that case needs no restriction at all).
        function accountIdsForMemberFilter(accounts, filterValue) {
            if (filterValue === "joint") {
                return new Set(accounts.filter(a => Array.isArray(a.memberIds) && a.memberIds.length > 1).map(a => a.id));
            }
            return new Set(accounts.filter(a => Array.isArray(a.memberIds) && a.memberIds.length === 1 && a.memberIds[0] === filterValue).map(a => a.id));
        }

        async function renderSpendingBreakdownPage() {
            const txs = await readAllDB(STORES.TRANSACTIONS);
            const accounts = await readAllDB(STORES.ACCOUNTS);
            populateYearFilterOptionsFor("spendingYearFilter", txs, "spendingYearFilterInit");
            populateBreakdownMemberFilter("spendingMemberFilter");
            const filterM = document.getElementById("spendingMonthFilter").value;
            const filterY = document.getElementById("spendingYearFilter").value;
            const filterMember = document.getElementById("spendingMemberFilter").value;
            const chartType = document.getElementById("spendingChartType").value;
            const memberAccountIds = filterMember !== "all" ? accountIdsForMemberFilter(accounts, filterMember) : null;

            // v73: categories flagged "Exclude from Net Savings Report" (Manage Categories) are
            // pulled out of the chart/total below and tallied into their own card instead —
            // matches the same treatment on the Net Savings Statement page.
            const excludedCatNames = new Set(dynamicCategories.filter(c => c.excludeFromSavings).map(c => c.name));

            const catTotals = {};
            const excludedTotals = {};
            let total = 0, excludedTotal = 0;
            txs.forEach(t => {
                // v88: a refund (income-type, isRefund:true) is folded into this same Spending
                // Breakdown — as a negative contribution to the category it refunds — instead of
                // being excluded outright, so a fully-refunded category correctly nets to zero/
                // disappears from the chart rather than still showing the original full spend.
                const isRefundCredit = t.type === "income" && t.isRefund;
                if (t.type !== "expense" && !isRefundCredit) return;
                if (memberAccountIds && !memberAccountIds.has(t.src)) return;
                const d = new Date(t.date);
                if (filterM !== "all" && d.getMonth().toString() !== filterM) return;
                if (filterY !== "all" && d.getFullYear().toString() !== filterY) return;
                const tBase = convertTxAmountToBase(t, accounts);
                const signedBase = isRefundCredit ? -tBase : tBase;
                const cat = t.cat || "Other Expenses";
                if (excludedCatNames.has(cat)) {
                    excludedTotals[cat] = (excludedTotals[cat] || 0) + signedBase;
                    excludedTotal += signedBase;
                    return;
                }
                catTotals[cat] = (catTotals[cat] || 0) + signedBase;
                total += signedBase;
            });

            const entries = Object.keys(catTotals)
                .filter(c => catTotals[c] > 0)
                .sort((a, b) => catTotals[b] - catTotals[a])
                .map((c, i) => ({ label: c, value: catTotals[c], color: BREAKDOWN_CHART_COLORS[i % BREAKDOWN_CHART_COLORS.length] }));

            document.getElementById("spendingBreakdownTotal").textContent = formatCurrency(total, baseCurrency);
            renderBreakdownChart("spendingBreakdownChartWrap", chartType, entries, total, "expense");
            document.getElementById("spendingBreakdownList").innerHTML = buildBreakdownListHTML(entries, total, "expense", filterY, filterM);

            const excludedEntries = Object.keys(excludedTotals)
                .filter(c => excludedTotals[c] > 0)
                .sort((a, b) => excludedTotals[b] - excludedTotals[a])
                .map((c, i) => ({ label: c, value: excludedTotals[c], color: BREAKDOWN_CHART_COLORS[i % BREAKDOWN_CHART_COLORS.length] }));
            const excludedCard = document.getElementById("spendingBreakdownExcludedCard");
            if (excludedEntries.length) {
                excludedCard.style.display = "";
                document.getElementById("spendingBreakdownExcludedTotal").textContent = formatCurrency(excludedTotal, baseCurrency);
                document.getElementById("spendingBreakdownExcludedList").innerHTML = buildBreakdownListHTML(excludedEntries, excludedTotal, "expense", filterY, filterM);
            } else {
                excludedCard.style.display = "none";
            }
        }

        async function renderIncomeBreakdownPage() {
            const txs = await readAllDB(STORES.TRANSACTIONS);
            const accounts = await readAllDB(STORES.ACCOUNTS);
            populateYearFilterOptionsFor("incomeYearFilter", txs, "incomeYearFilterInit");
            populateBreakdownMemberFilter("incomeMemberFilter");
            const filterM = document.getElementById("incomeMonthFilter").value;
            const filterY = document.getElementById("incomeYearFilter").value;
            const filterMember = document.getElementById("incomeMemberFilter").value;
            const chartType = document.getElementById("incomeChartType").value;
            const memberAccountIds = filterMember !== "all" ? accountIdsForMemberFilter(accounts, filterMember) : null;

            const excludedCatNames = new Set(dynamicCategories.filter(c => c.excludeFromSavings).map(c => c.name));

            const catTotals = {};
            const excludedTotals = {};
            let total = 0, excludedTotal = 0;
            txs.forEach(t => {
                if (t.type !== "income") return;
                // v88: a refund is credited to the account like income, but per-spec must not
                // count as income anywhere — see the isRefund handling in
                // renderSpendingBreakdownPage()/renderApp()/renderSavingsStatement().
                if (t.isRefund) return;
                if (memberAccountIds && !memberAccountIds.has(t.src)) return;
                const d = new Date(t.date);
                if (filterM !== "all" && d.getMonth().toString() !== filterM) return;
                if (filterY !== "all" && d.getFullYear().toString() !== filterY) return;
                const tBase = convertTxAmountToBase(t, accounts);
                const cat = t.cat || "Other Income";
                if (excludedCatNames.has(cat)) {
                    excludedTotals[cat] = (excludedTotals[cat] || 0) + tBase;
                    excludedTotal += tBase;
                    return;
                }
                catTotals[cat] = (catTotals[cat] || 0) + tBase;
                total += tBase;
            });

            const entries = Object.keys(catTotals)
                .filter(c => catTotals[c] > 0)
                .sort((a, b) => catTotals[b] - catTotals[a])
                .map((c, i) => ({ label: c, value: catTotals[c], color: BREAKDOWN_CHART_COLORS[i % BREAKDOWN_CHART_COLORS.length] }));

            document.getElementById("incomeBreakdownTotal").textContent = formatCurrency(total, baseCurrency);
            renderBreakdownChart("incomeBreakdownChartWrap", chartType, entries, total, "income");
            document.getElementById("incomeBreakdownList").innerHTML = buildBreakdownListHTML(entries, total, "income", filterY, filterM);

            const excludedEntries = Object.keys(excludedTotals)
                .filter(c => excludedTotals[c] > 0)
                .sort((a, b) => excludedTotals[b] - excludedTotals[a])
                .map((c, i) => ({ label: c, value: excludedTotals[c], color: BREAKDOWN_CHART_COLORS[i % BREAKDOWN_CHART_COLORS.length] }));
            const excludedCard = document.getElementById("incomeBreakdownExcludedCard");
            if (excludedEntries.length) {
                excludedCard.style.display = "";
                document.getElementById("incomeBreakdownExcludedTotal").textContent = formatCurrency(excludedTotal, baseCurrency);
                document.getElementById("incomeBreakdownExcludedList").innerHTML = buildBreakdownListHTML(excludedEntries, excludedTotal, "income", filterY, filterM);
            } else {
                excludedCard.style.display = "none";
            }
        }

        // Generic year-filter populator (mirrors populateYearFilterOptions/populateSavingsYearFilterOptions)
        // for the two new breakdown pages, keyed by a distinct "already initialized" flag per select
        // so each page defaults to "All Years" on first load and preserves the user's choice after.
        const breakdownYearFilterInit = {};
        function populateYearFilterOptionsFor(selectId, txs, initKey) {
            const select = document.getElementById(selectId);
            const prevValue = select.value;
            const currentYear = new Date().getFullYear();

            const years = new Set([currentYear]);
            txs.forEach(t => {
                const y = new Date(t.date).getFullYear();
                if (!isNaN(y)) years.add(y);
            });

            const sortedYears = [...years].sort((a, b) => b - a);
            select.innerHTML = `<option value="all">All Years</option>` +
                sortedYears.map(y => `<option value="${y}">${y}</option>`).join("");

            if (!breakdownYearFilterInit[initKey]) {
                select.value = "all";
                breakdownYearFilterInit[initKey] = true;
            } else if (prevValue === "all" || sortedYears.map(String).includes(prevValue)) {
                select.value = prevValue;
            } else {
                select.value = "all";
            }
        }

        // --- UNIT TRUST PORTFOLIO REPORT (new, v78) ---
        // Rolls up every live fund across every "unittrust" account into one report — the
        // per-account Fund Holdings table (renderFundHoldingsTable, on an account's Activity
        // page) only ever shows a single account's funds, so there was previously no page
        // that answered "how is my investment portfolio doing" across the whole ledger.
        //
        // Reuses the exact same Invested/Recovered/P&L formula as that table: Buy is the only
        // thing that counts as "Invested" (cost basis); Sell and Dividend (Cheque Payout) are
        // folded into `recovered` and combined into P/L instead of being subtracted from
        // Invested, so Return % stays stable across partial sells. See the full rationale on
        // computeInvested() inside renderFundHoldingsTable — deliberately duplicated here
        // rather than shared, so a future change to the per-account table can't silently alter
        // this report's numbers (or vice versa) without both being touched on purpose.
        function computePortfolioFundPL(fundTxs) {
            let invested = 0, recovered = 0;
            fundTxs.forEach(t => {
                if (t.fundTxType === "buy") invested += t.amount;
                else if (t.fundTxType === "sell" || t.fundTxType === "dividend_payout") recovered += t.amount;
            });
            return { invested, recovered };
        }

        // Solo-owned funds only when a specific member is picked — mirrors accountIdsForMemberFilter's
        // "solo only, joint excluded" convention already used by the Spending/Income Breakdown
        // member filter, so this report's filter behaves the same way a user already expects.
        // "joint" (v87) mirrors it back the other way — only funds with 2+ owners.
        function fundMatchesMemberFilter(fund, memberId) {
            if (memberId === "all") return true;
            const ids = Array.isArray(fund.ownerMemberIds) ? fund.ownerMemberIds : [];
            if (memberId === "joint") return ids.length > 1;
            return ids.length === 1 && ids[0] === memberId;
        }

        async function renderPortfolioReportPage() {
            const [accounts, funds, allTxs] = await Promise.all([
                readAllDB(STORES.ACCOUNTS),
                readAllDB(STORES.FUNDS),
                readAllDB(STORES.TRANSACTIONS)
            ]);

            populateBreakdownMemberFilter("portfolioMemberFilter");
            const filterMember = document.getElementById("portfolioMemberFilter").value;
            document.getElementById("portfolioBaseCurrLabel").textContent = baseCurrency;

            const unitTrustAccountIds = new Set(accounts.filter(a => a.type === "unittrust").map(a => a.id));
            const liveFunds = funds.filter(f => unitTrustAccountIds.has(f.accountId) && fundMatchesMemberFilter(f, filterMember));

            const fundTxsByFundId = {};
            allTxs.forEach(t => {
                if (t.fundId) (fundTxsByFundId[t.fundId] = fundTxsByFundId[t.fundId] || []).push(t);
            });

            let totalValueBase = 0, totalInvestedBase = 0, totalPlBase = 0;
            const rowsByAccount = {};

            liveFunds.forEach(f => {
                const fundTxs = (fundTxsByFundId[f.id] || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
                const { invested, recovered } = computePortfolioFundPL(fundTxs);
                const value = (f.units || 0) * (f.currentNav || 0);
                const pl = value + recovered - invested; // total return: unrealised + already-recovered cash, minus principal ever put in
                const returnPct = invested > 0 ? (pl / invested) * 100 : 0;
                const ownerLabel = accountOwnerNamesText({ memberIds: f.ownerMemberIds });
                const plColor = pl >= 0 ? "var(--income-color)" : "var(--expense-color)";

                totalValueBase += convertCurrency(value, f.currency, baseCurrency);
                totalInvestedBase += convertCurrency(invested, f.currency, baseCurrency);
                totalPlBase += convertCurrency(pl, f.currency, baseCurrency);

                const acc = accounts.find(a => a.id === f.accountId);
                const accName = acc ? acc.name : "(unknown account)";
                (rowsByAccount[accName] = rowsByAccount[accName] || []).push(`
                    <tr style="cursor:pointer;" data-click="navigateToFundActivityPage" data-id="${escapeHtml(f.id)}">
                        <td style="padding:8px 10px;">
                            <strong>${escapeHtml(f.name)}</strong><br>
                            <span style="font-size:0.68rem; color:var(--text-muted);">${escapeHtml(f.code || "")}</span><br>
                            <span style="font-size:0.68rem; color:var(--primary); font-weight:700;">${escapeHtml(ownerLabel)}</span>
                        </td>
                        <td style="padding:8px 10px; text-align:right;"><strong>${formatCurrency(value, f.currency)}</strong></td>
                        <td style="padding:8px 10px; text-align:right;">${formatCurrency(invested, f.currency)}</td>
                        <td style="padding:8px 10px; text-align:right; color:${plColor}; font-weight:700;">${pl >= 0 ? "+" : ""}${formatCurrency(pl, f.currency)}</td>
                        <td style="padding:8px 10px; text-align:right; color:${plColor};">${returnPct.toFixed(2)}%</td>
                    </tr>`);
            });

            document.getElementById("portfolioValueTotal").textContent = formatCurrency(totalValueBase, baseCurrency);
            document.getElementById("portfolioInvestedTotal").textContent = formatCurrency(totalInvestedBase, baseCurrency);
            const totalReturnPctBase = totalInvestedBase > 0 ? (totalPlBase / totalInvestedBase) * 100 : 0;

            const plBox = document.getElementById("portfolioPlBox");
            const returnBox = document.getElementById("portfolioReturnBox");
            const c = totalPlBase >= 0
                ? { bg: "#f0fdf4", border: "#bbf7d0", text: "#15803d" }
                : { bg: "#fef2f2", border: "#fecaca", text: "#b91c1c" };
            plBox.style.background = c.bg; plBox.style.border = `1px solid ${c.border}`;
            returnBox.style.background = c.bg; returnBox.style.border = `1px solid ${c.border}`;
            document.getElementById("portfolioPlTotal").style.color = c.text;
            document.getElementById("portfolioReturnTotal").style.color = c.text;
            document.getElementById("portfolioPlTotal").textContent = (totalPlBase >= 0 ? "+" : "") + formatCurrency(totalPlBase, baseCurrency);
            document.getElementById("portfolioReturnTotal").textContent = totalReturnPctBase.toFixed(2) + "%";

            const detailWrap = document.getElementById("portfolioDetailWrap");
            const accNames = Object.keys(rowsByAccount).sort();
            if (accNames.length === 0) {
                detailWrap.innerHTML = '<p style="padding:12px 4px; text-align:center; color:var(--text-muted); font-size:0.8rem;">No unit trust funds match this filter.</p>';
                return;
            }
            // Grouped by account (rather than one flat list) since the whole point of this report
            // is spanning multiple Unit Trust accounts — a flat list would make it hard to tell
            // which account each fund actually sits under.
            detailWrap.innerHTML = accNames.map(accName => `
                <div style="margin-bottom:14px;">
                    <div style="font-size:0.72rem; font-weight:800; color:var(--text-muted); text-transform:uppercase; margin-bottom:4px;">📊 ${escapeHtml(accName)}</div>
                    <table style="width:100%; border-collapse:collapse; font-size:0.78rem; white-space:nowrap;">
                        <thead>
                            <tr style="text-align:left; color:var(--text-muted); font-size:0.68rem; text-transform:uppercase;">
                                <th style="padding:6px 10px;">Fund</th>
                                <th style="padding:6px 10px; text-align:right;">Value</th>
                                <th style="padding:6px 10px; text-align:right;">Invested</th>
                                <th style="padding:6px 10px; text-align:right;">P/L</th>
                                <th style="padding:6px 10px; text-align:right;">Return</th>
                            </tr>
                        </thead>
                        <tbody>${rowsByAccount[accName].join("")}</tbody>
                    </table>
                </div>`).join("");
        }

        // Detail table starts collapsed — a portfolio spanning several accounts/funds can get
        // long, and the summary tiles above already answer the headline question. Same
        // collapse/expand pattern as the sidebar's account-type shortcuts list.
        function togglePortfolioDetail() {
            const wrap = document.getElementById("portfolioDetailWrap");
            const btn = document.getElementById("portfolioDetailToggle");
            const expanded = wrap.style.display !== "none";
            wrap.style.display = expanded ? "none" : "";
            btn.textContent = expanded ? "▸" : "▾";
            btn.title = expanded ? "Expand fund detail" : "Collapse fund detail";
            btn.setAttribute("aria-label", btn.title);
        }

        function navigateToSpendingBreakdownPage() {
            workspaceScrollY = window.scrollY;
            showPage("page-spending-breakdown");
            window.scrollTo(0, 0);
            pushVirtualState("spending-breakdown");
            renderSpendingBreakdownPage();
        }

        function navigateToIncomeBreakdownPage() {
            workspaceScrollY = window.scrollY;
            showPage("page-income-breakdown");
            window.scrollTo(0, 0);
            pushVirtualState("income-breakdown");
            renderIncomeBreakdownPage();
        }

        function navigateToPortfolioReportPage() {
            workspaceScrollY = window.scrollY;
            showPage("page-portfolio-report");
            window.scrollTo(0, 0);
            pushVirtualState("portfolio-report");
            renderPortfolioReportPage();
        }

        // --- OWNER NET WORTH SPLIT REPORT (Financial Assets vs Real Estate, v104) ---
        // One row per owner — solo member, joint-owned group, and (if any) "Unassigned" — same
        // ownership breakdown as the dashboard's "Net Worth by Member" section, but each row here
        // is split Financial Assets + Real Estate = Total Net Worth, plus that owner's % share of
        // the grand total, so the two figures are always visible side by side instead of only the
        // single blended total the dashboard section shows.
        async function renderOwnerNetWorthReportPage() {
            const { accounts, nativeBalances } = await computeAccountBalances();
            const grandTotal = summarizeOwnerAssetSplit(accounts, nativeBalances).total;
            document.getElementById("ownerNetWorthBaseCurrLabel").textContent = baseCurrency;

            const pctOf = (total) => grandTotal !== 0 ? ((total / grandTotal) * 100).toFixed(1) + "%" : "—";

            const rowHTML = (label, colorDotsHTML, subset) => {
                const { financial, realEstate, total } = summarizeOwnerAssetSplit(subset, nativeBalances);
                return `
                    <tr>
                        <td style="padding:8px 10px;">
                            <div style="display:flex; align-items:center; gap:6px;">${colorDotsHTML}<strong>${escapeHtml(label)}</strong></div>
                            <span style="font-size:0.68rem; color:var(--text-muted);">${subset.length} account${subset.length === 1 ? '' : 's'}</span>
                        </td>
                        <td style="padding:8px 10px; text-align:right;">${formatBalanceHTML(financial, baseCurrency)}</td>
                        <td style="padding:8px 10px; text-align:right;">${formatBalanceHTML(realEstate, baseCurrency)}</td>
                        <td style="padding:8px 10px; text-align:right;"><strong>${formatBalanceHTML(total, baseCurrency)}</strong></td>
                        <td style="padding:8px 10px; text-align:right;">${pctOf(total)}</td>
                    </tr>`;
            };

            let rows = "";
            membersCache.forEach(m => {
                const subset = filterAccountsByOwnership(accounts, "member", [m.id]);
                const dot = `<span class="member-color-dot" style="background:${m.color};"></span>`;
                rows += rowHTML(m.name, dot, subset);
            });

            const jointGroups = {};
            accounts.forEach(a => {
                if (Array.isArray(a.memberIds) && a.memberIds.length > 1) {
                    jointGroups[[...a.memberIds].sort().join(",")] = true;
                }
            });
            Object.keys(jointGroups).forEach(key => {
                const ids = key.split(",");
                const subset = filterAccountsByOwnership(accounts, "joint", ids);
                const dots = ids.map(id => `<span class="member-color-dot" style="background:${getMemberById(id)?.color || '#94a3b8'}; margin-left:-4px;"></span>`).join("");
                rows += rowHTML(`${memberNamesForIds(ids)} (Joint)`, dots, subset);
            });

            const unassigned = accounts.filter(a => !Array.isArray(a.memberIds) || a.memberIds.length === 0);
            if (unassigned.length > 0) {
                const dot = `<span class="member-color-dot" style="background:#cbd5e1;"></span>`;
                rows += rowHTML("Unassigned", dot, unassigned);
            }

            const wrap = document.getElementById("ownerNetWorthTableWrap");
            if (membersCache.length === 0 && unassigned.length === accounts.length) {
                wrap.innerHTML = `<p style="color:var(--text-muted); font-size:0.85rem; text-align:center; padding:24px 0;">No members yet — add one via Sidebar ▸ Setting ▸ Manage Members to break this report down by owner.</p>`;
                return;
            }

            const { financial: gFinancial, realEstate: gRealEstate } = summarizeOwnerAssetSplit(accounts, nativeBalances);
            wrap.innerHTML = `
                <table style="width:100%; border-collapse:collapse; font-size:0.78rem; white-space:nowrap;">
                    <thead>
                        <tr style="text-align:left; color:var(--text-muted); font-size:0.68rem; text-transform:uppercase;">
                            <th style="padding:6px 10px;">Owner(s)</th>
                            <th style="padding:6px 10px; text-align:right;">Financial Assets</th>
                            <th style="padding:6px 10px; text-align:right;">Real Estate</th>
                            <th style="padding:6px 10px; text-align:right;">Total Net Worth</th>
                            <th style="padding:6px 10px; text-align:right;">% of Net Worth</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                    <tfoot>
                        <tr style="border-top:2px solid var(--border-color); font-weight:800;">
                            <td style="padding:8px 10px;">Grand Total</td>
                            <td style="padding:8px 10px; text-align:right;">${formatBalanceHTML(gFinancial, baseCurrency)}</td>
                            <td style="padding:8px 10px; text-align:right;">${formatBalanceHTML(gRealEstate, baseCurrency)}</td>
                            <td style="padding:8px 10px; text-align:right;">${formatBalanceHTML(grandTotal, baseCurrency)}</td>
                            <td style="padding:8px 10px; text-align:right;">100.0%</td>
                        </tr>
                    </tfoot>
                </table>`;
        }

        function navigateToOwnerNetWorthReportPage() {
            workspaceScrollY = window.scrollY;
            showPage("page-owner-networth-report");
            window.scrollTo(0, 0);
            pushVirtualState("owner-networth-report");
            renderOwnerNetWorthReportPage();
        }

        // --- NET WORTH BY CURRENCY REPORT (v132) ---
        // Currency-pivoted sibling of the Owner report above: one row per currency actually held
        // (native, unconverted Financial Assets / Real Estate / Total), a ≈ Base Currency column
        // and % of Net Worth for comparison, plus a Grand Total row. Optional Member filter
        // (same "all" / "joint" / one member convention as Spending/Income Breakdown and the
        // Unit Trust Portfolio report) narrows the account subset before summing.
        async function renderCurrencyReportPage() {
            const { accounts, nativeBalances } = await computeAccountBalances();
            populateBreakdownMemberFilter("currencyReportMemberFilter");
            const filterMember = document.getElementById("currencyReportMemberFilter").value;
            document.getElementById("currencyReportBaseCurrLabel").textContent = baseCurrency;

            const subset = filterMember !== "all"
                ? (() => { const ids = accountIdsForMemberFilter(accounts, filterMember); return accounts.filter(a => ids.has(a.id)); })()
                : accounts;

            const { byCurrency, totalBase: grandTotal } = summarizeCurrencySplit(subset, nativeBalances);
            const pctOf = (base) => grandTotal !== 0 ? ((base / grandTotal) * 100).toFixed(1) + "%" : "—";

            const wrap = document.getElementById("currencyReportTableWrap");
            const codes = Object.keys(byCurrency);
            if (codes.length === 0) {
                wrap.innerHTML = `<p style="color:var(--text-muted); font-size:0.85rem; text-align:center; padding:24px 0;">No accounts to report on yet.</p>`;
                return;
            }

            // Sorted by base-currency-equivalent value, largest holding first — same convention
            // as the member currency-chip breakdown (renderMemberPage) rather than alphabetical,
            // so the currency you actually hold the most of leads the table.
            const sortedCodes = codes
                .map(code => {
                    const { financial, realEstate } = byCurrency[code];
                    const base = convertCurrency(financial + realEstate, code, baseCurrency);
                    return { code, financial, realEstate, base };
                })
                .sort((a, b) => b.base - a.base);

            let rows = "";
            let gFinancialBase = 0, gRealEstateBase = 0;
            sortedCodes.forEach(({ code, financial, realEstate, base }) => {
                gFinancialBase += convertCurrency(financial, code, baseCurrency);
                gRealEstateBase += convertCurrency(realEstate, code, baseCurrency);
                rows += `
                    <tr>
                        <td style="padding:8px 10px;">${currencyBadgeHTML(code)}</td>
                        <td style="padding:8px 10px; text-align:right;">${formatBalanceHTML(financial, code)}</td>
                        <td style="padding:8px 10px; text-align:right;">${formatBalanceHTML(realEstate, code)}</td>
                        <td style="padding:8px 10px; text-align:right;"><strong>${formatBalanceHTML(financial + realEstate, code)}</strong></td>
                        <td style="padding:8px 10px; text-align:right; color:var(--text-muted);">≈ ${formatBalanceHTML(base, baseCurrency)}</td>
                        <td style="padding:8px 10px; text-align:right;">${pctOf(base)}</td>
                    </tr>`;
            });

            wrap.innerHTML = `
                <table style="width:100%; border-collapse:collapse; font-size:0.78rem; white-space:nowrap;">
                    <thead>
                        <tr style="text-align:left; color:var(--text-muted); font-size:0.68rem; text-transform:uppercase;">
                            <th style="padding:6px 10px;">Currency</th>
                            <th style="padding:6px 10px; text-align:right;">Financial Assets</th>
                            <th style="padding:6px 10px; text-align:right;">Real Estate</th>
                            <th style="padding:6px 10px; text-align:right;">Total</th>
                            <th style="padding:6px 10px; text-align:right;">≈ ${escapeHtml(baseCurrency)}</th>
                            <th style="padding:6px 10px; text-align:right;">% of Net Worth</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                    <tfoot>
                        <tr style="border-top:2px solid var(--border-color); font-weight:800;">
                            <td style="padding:8px 10px;">Grand Total</td>
                            <td style="padding:8px 10px; text-align:right;">${formatBalanceHTML(gFinancialBase, baseCurrency)}</td>
                            <td style="padding:8px 10px; text-align:right;">${formatBalanceHTML(gRealEstateBase, baseCurrency)}</td>
                            <td style="padding:8px 10px; text-align:right;">${formatBalanceHTML(grandTotal, baseCurrency)}</td>
                            <td style="padding:8px 10px; text-align:right;">—</td>
                            <td style="padding:8px 10px; text-align:right;">100.0%</td>
                        </tr>
                    </tfoot>
                </table>`;
        }

        function navigateToCurrencyReportPage() {
            workspaceScrollY = window.scrollY;
            showPage("page-currency-report");
            window.scrollTo(0, 0);
            pushVirtualState("currency-report");
            renderCurrencyReportPage();
        }

        function navigateToAutoLockPage() {
            workspaceScrollY = window.scrollY;
            showPage("page-autolock");
            window.scrollTo(0, 0);
            pushVirtualState("autolock");
        }

        function navigateToDatabasePage() {
            workspaceScrollY = window.scrollY;
            showPage("page-database");
            window.scrollTo(0, 0);
            pushVirtualState("database");
            calculateStorageMetrics();
        }

        // v168 data migration (one-time, guarded by a settings flag so it never re-runs): earlier
        // versions baked the FD reference number straight into these four auto-generated
        // transaction descriptions — "Fixed Deposit Placement (ref)", "FD Withdrawal — Principal
        // (Ref: ref)", "FD Interest Received (Ref: ref)", "FD Placement Closed for Renewal
        // (Ref: ref)" — while the ledger row's meta line *also* shows that same fdReferenceNo
        // separately, so any transaction saved before this fix displays its reference number
        // twice on the same row (see the FD Withdrawal / Fixed Deposit Placement screenshot).
        // The code fix only changes how new descriptions are generated going forward — it can't
        // retroactively rewrite text already committed to existing records — so this strips the
        // now-redundant "(...)" suffix from any already-saved transaction whose desc still has it
        // baked in, one time, the first time this version runs.
        async function migrateFdDescRefDedup() {
            const flagKey = "migratedFdDescRefDedup_v168";
            const already = await readKeyDB("settings", flagKey);
            if (already) return;

            const patterns = [
                { prefix: "Fixed Deposit Placement" },
                { prefix: "FD Withdrawal — Principal" },
                { prefix: "FD Interest Received" },
                { prefix: "FD Placement Closed for Renewal" },
            ];

            const allTx = await readAllDB(STORES.TRANSACTIONS);
            for (const t of allTx) {
                if (!t.fdReferenceNo || typeof t.desc !== "string") continue;
                for (const { prefix } of patterns) {
                    // Matches "<prefix> (Ref: xxx)" or "<prefix> (xxx)" only when it's this exact
                    // record's own reference number being repeated — never touches a manually-
                    // typed description that just happens to start the same way with different
                    // trailing text.
                    const refEsc = t.fdReferenceNo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                    const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\((?:Ref: )?${refEsc}\\)$`);
                    if (re.test(t.desc)) {
                        t.desc = prefix;
                        await writeDB(STORES.TRANSACTIONS, t);
                        break;
                    }
                }
            }

            await writeDB(STORES.SETTINGS, { key: flagKey, value: true });
        }

        async function bootstrap() {
            const lockResult = await runLockFlow();
            await initDB();
            if (lockResult.isNewSetup) {
                await migrateAllStoresToEncrypted();
                if (await isBiometricSupported()) {
                    const wantsBiometric = await customConfirm("Enable fingerprint / Face unlock for faster access next time?");
                    if (wantsBiometric) {
                        try { await enableBiometricUnlock(currentPasscode); } catch (err) { alert("Could not enable biometric unlock: " + (err && err.message ? err.message : err)); }
                    }
                }
            }
            initBiometricToggleRow();

            const storedBase = await readKeyDB("settings", "baseCurrency");
            if (storedBase) baseCurrency = storedBase.value;

            const storedRates = await readKeyDB("settings", "fxRates");
            if (storedRates) fxRates = storedRates.value;
            if (mergeInDefaultCurrencies()) {
                await writeDB(STORES.SETTINGS, { key: "fxRates", value: fxRates });
            }

            const storedDefaultIncomeCat = await readKeyDB("settings", "defaultIncomeCategory");
            if (storedDefaultIncomeCat) defaultIncomeCategory = storedDefaultIncomeCat.value || "";

            const storedDefaultExpenseCat = await readKeyDB("settings", "defaultExpenseCategory");
            if (storedDefaultExpenseCat) defaultExpenseCategory = storedDefaultExpenseCat.value || "";

            const storedDefaultPaymentAcc = await readKeyDB("settings", "defaultPaymentAccount");
            if (storedDefaultPaymentAcc) defaultPaymentAccount = storedDefaultPaymentAcc.value || "";

            const storedDefaultReceiveAcc = await readKeyDB("settings", "defaultReceiveAccount");
            if (storedDefaultReceiveAcc) defaultReceiveAccount = storedDefaultReceiveAcc.value || "";

            const storedReportCardPeriod1 = await readKeyDB("settings", "reportCardPeriod1");
            if (storedReportCardPeriod1) reportCardPeriod1 = storedReportCardPeriod1.value || "thisYear";

            const storedReportCardPeriod2 = await readKeyDB("settings", "reportCardPeriod2");
            if (storedReportCardPeriod2) reportCardPeriod2 = storedReportCardPeriod2.value || "thisMonth";

            const storedMonthlyTrendYear = await readKeyDB("settings", "monthlyTrendYear");
            if (storedMonthlyTrendYear) monthlyTrendYear = storedMonthlyTrendYear.value || new Date().getFullYear().toString();

            const storedMonthlyTrendAutoScale = await readKeyDB("settings", "monthlyTrendAutoScale");
            if (storedMonthlyTrendAutoScale) monthlyTrendAutoScale = !!storedMonthlyTrendAutoScale.value;

            const storedRecentTxType = await readKeyDB("settings", "recentTxTypeFilter");
            if (storedRecentTxType) recentTxTypeFilter = storedRecentTxType.value || "both";

            const storedRecentTxAccount = await readKeyDB("settings", "recentTxAccountFilter");
            if (storedRecentTxAccount) recentTxAccountFilter = storedRecentTxAccount.value || "all";

            const storedRecentTxCount = await readKeyDB("settings", "recentTxCount");
            if (storedRecentTxCount) recentTxCount = storedRecentTxCount.value || 5;

            const storedDashboardWidgetOrder = await readKeyDB("settings", "dashboardWidgetOrder");
            if (storedDashboardWidgetOrder) dashboardWidgetOrder = storedDashboardWidgetOrder.value === "recenttx-first" ? "recenttx-first" : "accounts-first";

            const storedPinnedCount = await readKeyDB("settings", "pinnedAccountCount");
            if (storedPinnedCount) pinnedAccountCount = storedPinnedCount.value || 5;

            const storedPinnedIds = await readKeyDB("settings", "pinnedAccountIds");
            if (storedPinnedIds && Array.isArray(storedPinnedIds.value)) pinnedAccountIds = storedPinnedIds.value;

            const storedMemberNwCollapsed = await readKeyDB("settings", "memberNetWorthCollapsed");
            if (storedMemberNwCollapsed) memberNetWorthCollapsed = !!storedMemberNwCollapsed.value;

            const storedExpandedSubrows = await readKeyDB("settings", "expandedAccountSubrows");
            if (storedExpandedSubrows && Array.isArray(storedExpandedSubrows.value)) {
                expandedAccountSubrows = new Set(storedExpandedSubrows.value);
            }

            await syncAndLoadCategories();
            await ensureDefaultCategories();
            await migrateFdDescRefDedup();

            const accs = await readAllDB(STORES.ACCOUNTS);
            if(accs.length === 0) {
                await writeDB(STORES.ACCOUNTS, { id: "usd_w", name: "US Dollar Wallet", initialBalance: 2500, currency: "USD", type: "normal", memberIds: [] });
                await writeDB(STORES.ACCOUNTS, { id: "sgd_w", name: "DBS Singapore", initialBalance: 1200, currency: "SGD", type: "normal", memberIds: [] });
                await writeDB(STORES.ACCOUNTS, { id: "myr_w", name: "Maybank Malaysia", initialBalance: 3400, currency: "MYR", type: "normal", memberIds: [] });
            }

            // Seed a friendly starting set of household members (fully editable/removable) so the
            // Sidebar's Members feature isn't empty on first run.
            const existingMembers = await readAllDB(STORES.MEMBERS);
            if (existingMembers.length === 0) {
                await writeDB(STORES.MEMBERS, { id: "mem_husband", name: "Husband", color: MEMBER_COLORS[0] });
                await writeDB(STORES.MEMBERS, { id: "mem_wife", name: "Wife", color: MEMBER_COLORS[1] });
                await writeDB(STORES.MEMBERS, { id: "mem_kid", name: "Kid", color: MEMBER_COLORS[2] });
            }
            await loadMembersCache();
            renderSidebarMembers();
            renderSidebarAccountTypeShortcuts();

            window.history.replaceState({ view: "workspace" }, "");
            
            initAutoLock();
            renderApp();
        }

        async function readKeyDB(storeName, key) {
            const raw = await new Promise((resolve) => {
                const tx = db.transaction([storeName], "readonly");
                const req = tx.objectStore(storeName).get(key);
                req.onsuccess = () => resolve(req.result);
            });
            return decryptRecord(storeName, raw);
        }

        function handleExportEncryptToggleChange() {
            const toggle = document.getElementById("exportEncryptToggle");
            const hint = document.getElementById("exportPlaintextHint");
            hint.classList.toggle("hidden", toggle.checked);
        }

        // v194: forceEncrypted lets a caller skip the on-page toggle entirely and always produce
        // an encrypted backup — used by the dashboard's quick 💾 button (exportBackupQuick below)
        // so that quick action always behaves the same regardless of whatever the Backup &
        // Restore page's own toggle happens to be left at, and can never accidentally produce an
        // unencrypted file with no page/confirmation in view. The Backup & Restore page's own
        // "Export JSON" button still calls this with no argument, so it keeps respecting the
        // toggle exactly as before.
        async function exportBackup(forceEncrypted = false) {
            const bundle = {
                accounts: await readAllDB(STORES.ACCOUNTS),
                transactions: await readAllDB(STORES.TRANSACTIONS),
                categories: await readAllDB(STORES.CATEGORIES),
                members: await readAllDB(STORES.MEMBERS),
                funds: await readAllDB(STORES.FUNDS),
                navHistory: await readAllDB(STORES.NAV_HISTORY),
                // v121: attachment file blobs (id/name/mime/data) referenced by transactions'
                // own `attachments` arrays — without this, a restored backup's transactions
                // would still list attachments, but tapping one would fail to load.
                attachments: await readAllDB(STORES.ATTACHMENTS),
                // v65: full SETTINGS store dump ({key,value} rows — defaultPaymentAccount,
                // defaultReceiveAccount, defaultIncomeCategory, defaultExpenseCategory, recentTx*
                // widget filters, expandedAccountSubrows, plus baseCurrency/fxRates which are
                // also kept below as their own top-level fields for backward compatibility with
                // older backups/import code that reads them directly off the bundle).
                settings: await readAllDB(STORES.SETTINGS),
                baseCurrency: baseCurrency,
                fxRates: fxRates
            };

            const toggle = document.getElementById("exportEncryptToggle");
            const wantsEncryption = forceEncrypted ? true : (toggle ? toggle.checked : true); // encrypted-by-default

            let outputPayload = bundle;
            let filenameSuffix = "";

            if (wantsEncryption) {
                if (!currentPasscode) {
                    alert("The app must be unlocked to create an encrypted backup.");
                    return;
                }
                const salt = crypto.getRandomValues(new Uint8Array(16));
                const saltB64 = bufToB64(salt);
                const key = await deriveKeyFromPasscode(currentPasscode, saltB64, PBKDF2_ITERATIONS);
                const { iv, data } = await aesEncryptString(key, JSON.stringify(bundle));
                outputPayload = { encrypted: true, salt: saltB64, iterations: PBKDF2_ITERATIONS, iv, data };
                filenameSuffix = "_encrypted";
            } else {
                const proceed = await customConfirm("This backup will be saved as plain, unencrypted text. Anyone with the file can read it. Continue?");
                if (!proceed) return;
            }

            const blob = new Blob([JSON.stringify(outputPayload)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = `ledger_backup_${todayLocalStr()}${filenameSuffix}.json`;
            a.click(); URL.revokeObjectURL(url);
            showToast(wantsEncryption ? "🔒 Encrypted backup downloaded" : "📄 Backup downloaded (unencrypted)");
        }

        // v194: the dashboard header's quick 💾 button — see exportBackup's comment above for why
        // this always forces encryption rather than reading the Backup & Restore page's toggle.
        async function exportBackupQuick() {
            await exportBackup(true);
        }

        // Prompts for a backup's passcode via the backupPasscodeModal; resolves with the entered
        // string, or null if the user cancels.
        function promptBackupPasscode(presetError) {
            return new Promise((resolve) => {
                const modal = document.getElementById("backupPasscodeModal");
                const input = document.getElementById("backupPasscodeInput");
                const errEl = document.getElementById("backupPasscodeError");
                const okBtn = document.getElementById("backupPasscodeOkBtn");
                const cancelBtn = document.getElementById("backupPasscodeCancelBtn");
                input.value = "";
                errEl.textContent = presetError || "";

                const cleanup = (result) => {
                    modal.classList.remove("active");
                    okBtn.onclick = null;
                    cancelBtn.onclick = null;
                    resolve(result);
                };
                okBtn.onclick = () => cleanup(input.value);
                cancelBtn.onclick = () => cleanup(null);
                modal.classList.add("active");
            });
        }

        // Decrypts an { encrypted: true, salt, iterations, iv, data } backup payload back into the
        // original { accounts, transactions, categories, baseCurrency, fxRates } bundle. Tries the
        // current session's passcode first (seamless same-device restore); if that fails — or the
        // app isn't unlocked with a matching passcode — prompts for the backup's own passcode.
        // Returns null if the user cancels or every attempt fails.
        async function decryptBackupBundle(payload) {
            if (currentPasscode) {
                try {
                    const key = await deriveKeyFromPasscode(currentPasscode, payload.salt, payload.iterations);
                    const json = await aesDecryptString(key, payload.iv, payload.data);
                    return JSON.parse(json);
                } catch (err) { /* fall through to prompting */ }
            }

            let lastAttemptFailed = false;
            while (true) {
                const passcode = await promptBackupPasscode(lastAttemptFailed ? "Incorrect passcode." : "");
                if (passcode === null) return null;
                try {
                    const key = await deriveKeyFromPasscode(passcode, payload.salt, payload.iterations);
                    const json = await aesDecryptString(key, payload.iv, payload.data);
                    return JSON.parse(json);
                } catch (err) {
                    lastAttemptFailed = true;
                }
            }
        }

        function clearStoreDB(storeName) {
            return new Promise((resolve, reject) => {
                try {
                    const tx = db.transaction([storeName], "readwrite");
                    tx.objectStore(storeName).clear();
                    tx.oncomplete = () => resolve();
                    tx.onerror = () => reject(tx.error);
                } catch (err) { reject(err); }
            });
        }

        async function importBackup(e) {
            const file = e.target.files[0]; if (!file) return;

            const ok = await customConfirm("Importing a backup will permanently replace ALL current accounts, transactions, and categories. This cannot be undone. Continue?");
            if (!ok) { e.target.value = ""; return; }

            const reader = new FileReader();
            reader.onload = async function(evt) {
                try {
                    const parsed = JSON.parse(evt.target.result);
                    let bundle;
                    if (parsed && parsed.encrypted) {
                        bundle = await decryptBackupBundle(parsed);
                        if (!bundle) { e.target.value = ""; return; } // user cancelled the passcode prompt
                    } else {
                        bundle = parsed;
                    }

                    if (!bundle.accounts || !bundle.transactions) {
                        alert("Invalid backup file: missing required data.");
                        return;
                    }

                    await clearStoreDB(STORES.ACCOUNTS);
                    await clearStoreDB(STORES.TRANSACTIONS);

                    if (db.objectStoreNames.contains(STORES.CATEGORIES)) {
                        await clearStoreDB(STORES.CATEGORIES);
                    }
                    if (db.objectStoreNames.contains(STORES.MEMBERS)) {
                        await clearStoreDB(STORES.MEMBERS);
                    }
                    if (db.objectStoreNames.contains(STORES.FUNDS)) {
                        await clearStoreDB(STORES.FUNDS);
                    }
                    if (db.objectStoreNames.contains(STORES.NAV_HISTORY)) {
                        await clearStoreDB(STORES.NAV_HISTORY);
                    }
                    if (db.objectStoreNames.contains(STORES.ATTACHMENTS)) {
                        await clearStoreDB(STORES.ATTACHMENTS);
                    }

                    if (bundle.baseCurrency) baseCurrency = bundle.baseCurrency;
                    if (bundle.fxRates) fxRates = bundle.fxRates;
                    await writeDB(STORES.SETTINGS, { key: "baseCurrency", value: baseCurrency });
                    await writeDB(STORES.SETTINGS, { key: "fxRates", value: fxRates });

                    for (const acc of bundle.accounts) await writeDB(STORES.ACCOUNTS, acc);
                    for (const tx of bundle.transactions) { delete tx.id; await writeDB(STORES.TRANSACTIONS, tx); }

                    if (bundle.categories) {
                        for (const cat of bundle.categories) await writeDB(STORES.CATEGORIES, cat);
                    }
                    if (bundle.members) {
                        for (const mem of bundle.members) await writeDB(STORES.MEMBERS, mem);
                    }
                    if (bundle.funds) {
                        for (const fund of bundle.funds) await writeDB(STORES.FUNDS, fund);
                    }
                    if (bundle.navHistory) {
                        for (const rec of bundle.navHistory) await writeDB(STORES.NAV_HISTORY, rec);
                    }
                    // v121: attachment blobs — written with their ORIGINAL ids (unlike transactions,
                    // whose auto-increment `id` is deleted above before re-import) so each restored
                    // transaction's own `attachments[].id` refs keep resolving correctly.
                    if (bundle.attachments) {
                        for (const att of bundle.attachments) await writeDB(STORES.ATTACHMENTS, att);
                    }

                    // v65: restore preferences from the SETTINGS store dump (defaultPaymentAccount,
                    // defaultIncomeCategory, defaultExpenseCategory, recentTx* widget filters,
                    // expandedAccountSubrows). Absent on older backups, so this is skipped entirely
                    // for those — accounts/transactions/etc. still import fine, just without prefs.
                    // baseCurrency/fxRates rows are included in this dump too but are already
                    // applied above from bundle.baseCurrency/bundle.fxRates; writing them again here
                    // is harmless (same values, same store row).
                    if (bundle.settings && Array.isArray(bundle.settings)) {
                        for (const rec of bundle.settings) {
                            if (!rec || !rec.key) continue;
                            await writeDB(STORES.SETTINGS, rec);
                            switch (rec.key) {
                                case "defaultPaymentAccount": defaultPaymentAccount = rec.value || ""; break;
                                case "defaultReceiveAccount": defaultReceiveAccount = rec.value || ""; break;
                                case "reportCardPeriod1": reportCardPeriod1 = rec.value || "thisYear"; break;
                                case "reportCardPeriod2": reportCardPeriod2 = rec.value || "thisMonth"; break;
                                case "monthlyTrendYear": monthlyTrendYear = rec.value || new Date().getFullYear().toString(); break;
                                case "monthlyTrendAutoScale": monthlyTrendAutoScale = !!rec.value; break;
                                case "defaultIncomeCategory": defaultIncomeCategory = rec.value || ""; break;
                                case "defaultExpenseCategory": defaultExpenseCategory = rec.value || ""; break;
                                case "recentTxTypeFilter": recentTxTypeFilter = rec.value || "both"; break;
                                case "recentTxAccountFilter": recentTxAccountFilter = rec.value || "all"; break;
                                case "recentTxCount": recentTxCount = rec.value || 5; break;
                                case "dashboardWidgetOrder": dashboardWidgetOrder = rec.value === "recenttx-first" ? "recenttx-first" : "accounts-first"; break;
                                case "pinnedAccountCount": pinnedAccountCount = rec.value || 5; break;
                                case "pinnedAccountIds": pinnedAccountIds = Array.isArray(rec.value) ? rec.value : []; break;
                                case "memberNetWorthCollapsed": memberNetWorthCollapsed = !!rec.value; break;
                                case "expandedAccountSubrows":
                                    expandedAccountSubrows = new Set(Array.isArray(rec.value) ? rec.value : []);
                                    break;
                            }
                        }
                    }

                    await syncAndLoadCategories();
                    await loadMembersCache();
                    renderSidebarMembers();
                    renderSidebarAccountTypeShortcuts();
                    renderApp();
                    alert("Backup imported successfully.");
                } catch (err) {
                    alert("Import failed: " + (err && err.message ? err.message : "Invalid backup structure file."));
                } finally {
                    e.target.value = "";
                }
            };
            reader.readAsText(file);
        }

        // ---------------------------------------------------------------------------------
        // Delegated event handling (replaces inline onclick/onchange/oninput attributes).
        // A strict CSP script-src (no 'unsafe-inline') blocks inline event-handler attributes
        // just like it blocks inline <script> tags, so every element that used to carry
        // onclick="fn(...)" now carries data-click="fn" (+ data-* args) instead, and these
        // three delegated listeners look the action up in a small dispatch table and call the
        // real function. This works the same whether the element was in the static page shell
        // or generated later via innerHTML, since delegation is attached to `document` once.
        // ---------------------------------------------------------------------------------
        const CLICK_ACTIONS = {
            openSidebar: () => openSidebar(),
            closeSidebar: () => closeSidebar(),
            monthlyTrendBarTap: (el, e) => { e.stopPropagation(); showMonthlyTrendTooltip(e, el); },
            hideMonthlyTrendTooltip: () => hideMonthlyTrendTooltip(),
            toggleMonthlyTrendAutoScale: () => toggleMonthlyTrendAutoScale(),
            navigateToNetWorthStatementPage: () => navigateToNetWorthStatementPage(),
            openInsightsDrawer: () => openInsightsDrawer(),
            closeInsightsDrawer: () => closeInsightsDrawer(),
            sidebarGo: (el) => sidebarGo(el),
            handleSetupPasscodeSubmit: () => handleSetupPasscodeSubmit(),
            handleUnlockSubmit: () => handleUnlockSubmit(),
            handleForgotPasscode: () => handleForgotPasscode(),
            openChangePasscodeModal: () => openChangePasscodeModal(),
            handleChangePasscodeSubmit: () => handleChangePasscodeSubmit(),
            openResetAppDataModal: () => openResetAppDataModal(),
            handleResetAppDataSubmit: () => handleResetAppDataSubmit(),
            openCurrencyConfig: () => openCurrencyConfig(),
            lockAppNow: () => lockAppNow(),
            navigateToSavingsPage: () => navigateToSavingsPage(),
            reportCardClickDirectType: (el) => reportCardClickDirectType(el),
            reportCardClickTotal: (el) => reportCardClickTotal(el),
            clearSavingsMonthScope: () => clearSavingsMonthScope(),
            navigateToAccountsPage: () => navigateToAccountsPage(),
            handleAccountsBackClick: () => handleAccountsBackClick(),
            navigateToCategoriesPage: () => navigateToCategoriesPage(),
            navigateToBackupPage: () => navigateToBackupPage(),
            handleBackupBackClick: () => handleBackupBackClick(),
            navigateToAllLedgerPage: () => navigateToAllLedgerPage(),
            navigateToDataSecurityPage: () => navigateToDataSecurityPage(),
            navigateToMembersPage: () => navigateToMembersPage(),
            sidebarGoMember: (el) => sidebarGoMember(el),
            sidebarFilterAccountsByType: (el) => sidebarFilterAccountsByType(el),
            clearAccountsPageTypeFilter: () => clearAccountsPageTypeFilter(),
            toggleAccountSubrows: (el) => toggleAccountSubrows(el),
            toggleSidebarAccountShortcuts: () => toggleSidebarAccountShortcuts(),
            openMemberFormModal: () => openMemberFormModal(),
            handleCreateMemberMobile: () => handleCreateMemberMobile(),
            deleteMemberFromForm: () => deleteMemberFromForm(),
            editMember: (el) => editMember(el.dataset.id),
            openAddAccountForMember: () => openAddAccountForMember(),
            toggleMemberNetWorthCollapse: () => toggleMemberNetWorthCollapse(),
            selectMemberColor: (el) => selectMemberColor(el),
            toggleBgThemeSettings: () => toggleBgThemeSettings(),
            toggleDashboardWidgetsSettings: () => toggleDashboardWidgetsSettings(),
            toggleDefaultAccountsSettings: () => toggleDefaultAccountsSettings(),
            selectBgTheme: (el) => selectBgTheme(el),
            toggleMemberPageCurrencyBreakdown: () => toggleMemberPageCurrencyBreakdown(),
            ledgerYearPrev: () => ledgerYearPrev(),
            ledgerYearNext: () => ledgerYearNext(),
            toggleLedgerQuickAddSheet: () => toggleLedgerQuickAddSheet(),
            closeLedgerQuickAddSheet: () => closeLedgerQuickAddSheet(),
            quickAddChooseType: (el) => quickAddChooseType(el),
            toggleDashboardQuickAddSheet: () => toggleDashboardQuickAddSheet(),
            closeDashboardQuickAddSheet: () => closeDashboardQuickAddSheet(),
            dashboardQuickAddChooseAction: (el) => dashboardQuickAddChooseAction(el),
            openAccountFormModal: () => openAccountFormModal(),
            openCategoryFormModal: () => openCategoryFormModal(),
            editCategory: (el) => editCategory(el.dataset.id),
            toggleSavingsMainExpand: (el) => toggleSavingsMainExpand(el.dataset.id),
            deleteAccountFromForm: () => deleteAccountFromForm(),
            editAccountFromLedgerHeader: () => editAccountFromLedgerHeader(),
            openCreditCardPayment: (el) => openCreditCardPayment(el),
            openCreditCardPaymentFromLedgerHeader: () => openCreditCardPaymentFromLedgerHeader(),
            navigateToLinkedAccountFromLedgerHeader: (el) => { if (el.dataset.id) navigateToLedgerPage(el.dataset.id, "workspace"); },
            exportBackup: () => exportBackup(),
            exportBackupQuick: () => exportBackupQuick(),
            openImportInput: () => document.getElementById("importInput").click(),
            handleLedgerBackClick: () => handleLedgerBackClick(),
            navigateToWorkspace: () => navigateToWorkspace(),
            saveFxRates: () => saveFxRates(),
            addMultiCurrencyRow: () => addMultiCurrencyRow(),
            addFdPlacementRow: () => addFdPlacementRow(),
            handleCreateAccountMobile: () => handleCreateAccountMobile(),
            resetAccountForm: () => resetAccountForm(),
            handleCreateCategoryMobile: () => handleCreateCategoryMobile(),
            openCameraInput: () => document.getElementById("txCameraInput").click(),
            openFilesInput: () => document.getElementById("txFilesInput").click(),
            removeExistingTxAttachment: (el) => removeExistingTxAttachment(el),
            removeTempTxAttachment: (el) => removeTempTxAttachment(el),
            openTxAttachmentsBadge: (el, e) => openTxAttachmentsBadge(el, e),
            openAttachmentFromPicker: (el) => openAttachmentFromPicker(el),
            openAttachmentFromQuickView: (el) => openAttachmentFromQuickView(el),
            handleTransactionSubmitMobile: () => handleTransactionSubmitMobile(),
            confirmResolveFd: () => confirmResolveFd(),
            loadMoreLedgerRows: () => { ledgerRenderLimit += LEDGER_PAGE_SIZE; renderApp(); },
            closeModal: (el) => closeModal(el.dataset.modal),
            openTransactionForm: (el) => openTransactionForm(el.dataset.type, el.dataset.id ? Number(el.dataset.id) : null),
            navigateToDirectTypePage: (el) => navigateToDirectTypePage(el.dataset.type),
            setAccountTypeUI: (el) => setAccountTypeUI(el.dataset.type),
            setResolveFdAction: (el) => setResolveFdAction(el.dataset.actionValue),
            setResolveFdRenewMode: (el) => setResolveFdRenewMode(el.dataset.mode),
            removeRow: (el) => { const row = document.getElementById(el.dataset.rowId); if (row) row.remove(); },
            editAccount: (el) => editAccount(el.dataset.id),
            removeAccount: (el) => removeAccount(el.dataset.id),
            removeCategory: (el) => removeCategory(el.dataset.id),
            toggleCategoryExcludeFromSavings: (el) => toggleCategoryExcludeFromSavings(el.dataset.id),
            openResolveFdModal: (el) => openResolveFdModal(Number(el.dataset.id)),
            navigateToLedgerPage: (el) => navigateToLedgerPage(el.dataset.id, el.dataset.back || "workspace"),
            deleteTxFromEditModal: () => deleteTxFromEditModal(),
            navigateToCategoryPage: (el) => navigateToCategoryPage(el.dataset.category, el.dataset.back || "workspace", el.dataset.year || "all", el.dataset.month || "all"),
            openNoteSummaryModal: () => openNoteSummaryModal(),
            numpadDigit: (el) => numpadDigit(el.dataset.digit),
            numpadBackspace: () => numpadBackspace(),
            numpadClear: () => numpadClear(),
            openAddFundModal: () => openAddFundModal(),
            openAddFundTxModal: () => openAddFundTxModal(),
            openAddFundTxModalForActiveFund: () => openAddFundTxModalForActiveFund(),
            editFund: (el) => editFund(el.dataset.id),
            navigateToFundActivityPage: (el) => navigateToFundActivityPage(el),
            navigateToPortfolioReportPage: () => navigateToPortfolioReportPage(),
            navigateToOwnerNetWorthReportPage: () => navigateToOwnerNetWorthReportPage(),
            togglePortfolioDetail: () => togglePortfolioDetail(),
            handleFundActivityBackClick: () => handleFundActivityBackClick(),
            editFundFromActivityHeader: () => editFundFromActivityHeader(),
            navigateToCurrencyActivityPage: (el) => navigateToCurrencyActivityPage(el),
            handleCurrencyActivityBackClick: () => handleCurrencyActivityBackClick(),
            handleSaveFund: () => handleSaveFund(),
            handleDeleteFund: () => handleDeleteFund(),
            handleSaveFundTx: () => handleSaveFundTx(),
            handleDeleteFundTxFromModal: () => handleDeleteFundTxFromModal(),
            navigateToNavUpdatePage: () => navigateToNavUpdatePage(),
            setNavUpdateView: (el) => setNavUpdateView(el),
            handleSaveAllNav: () => handleSaveAllNav(),
            scrollToTop: () => scrollToTop(),
            fetchLiveFxRates: () => fetchLiveFxRates(),
            // v88: split expenses, calculator/numpad, transaction quick view/options/refund.
            addTxSplitRow: () => addTxSplitRow(),
            removeTxSplitRow: (el) => removeTxSplitRow(el),
            openCalcPadFor: (el) => openCalcPad(el),
            calcPadPress: (el) => calcPadPress(el),
            calcPadApply: () => calcPadApply(),
            openTxQuickView: (el) => openTxQuickView(el),
            toggleTxCheckedFromQuickView: () => toggleTxCheckedFromQuickView(),
            openTxOptionsMenu: () => openTxOptionsMenu(),
            closeTxOptionsMenu: () => closeTxOptionsMenu(),
            closeTxSplitPicker: () => closeTxSplitPicker(),
            selectTxSplitPickerRow: (el) => selectTxSplitPickerRow(el),
            editTransactionFromOptions: () => editTransactionFromOptions(),
            duplicateTransactionFromOptions: () => duplicateTransactionFromOptions(),
            deleteTransactionFromOptions: () => deleteTransactionFromOptions(),
            openRefundFromOptions: () => openRefundFromOptions(),
            openAccountPicker: (el) => openAccountPicker(el),
            closeAccountPicker: () => closeAccountPicker(),
            selectAccountPickerOption: (el) => selectAccountPickerOption(el),
            openSalaryEntryForm: () => openSalaryEntryForm(),
            handleSaveSalaryRecord: () => handleSaveSalaryRecord(),
            printCurrentApp: () => printCurrentApp(),
            toggleDonutSlice: (el) => toggleDonutSlice(el),
        };

        const CHANGE_ACTIONS = {
            resetLedgerPageAndRender: () => { ledgerRenderLimit = LEDGER_PAGE_SIZE; renderApp(); },
            importBackup: (el, e) => importBackup(e),
            handleExportEncryptToggleChange: () => handleExportEncryptToggleChange(),
            handleBiometricToggleChange: () => handleBiometricToggleChange(),
            handleBaseCurrencyChange: () => handleBaseCurrencyChange(),
            recalcTxFdMaturity: () => { recalcTxFdMaturity(); recalcTxSplitTotal(); },
            syncTransactionCurrency: () => syncTransactionCurrency(),
            handleTxAttachmentsSelected: (el, e) => handleTxAttachmentsSelected(e),
            recalcResolveFdMaturity: () => recalcResolveFdMaturity(),
            recalcFdOpeningRowMaturity: (el) => recalcFdOpeningRowMaturity(el.dataset.rowId),
            handleAutoLockChange: () => handleAutoLockChange(),
            saveDefaultCategories: () => saveDefaultCategories(),
            saveDefaultPaymentAccount: () => saveDefaultPaymentAccount(),
            saveDefaultReceiveAccount: () => saveDefaultReceiveAccount(),
            toggleTxFdDescMode: () => toggleTxFdDescMode(),
            resetSavingsPageAndRender: () => renderSavingsStatement(),
            toggleTxManualFx: () => toggleTxManualFx(),
            recalcTxManualFxPreview: () => recalcTxManualFxPreview(),
            renderSpendingBreakdownPage: () => renderSpendingBreakdownPage(),
            renderIncomeBreakdownPage: () => renderIncomeBreakdownPage(),
            renderPortfolioReportPage: () => renderPortfolioReportPage(),
            renderCurrencyReportPage: () => renderCurrencyReportPage(),
            toggleTxTransferFx: () => toggleTxTransferFx(),
            handleRecentTxSettingChange: () => handleRecentTxSettingChange(),
            handlePinnedAccountCountChange: () => handlePinnedAccountCountChange(),
            handleDashboardWidgetOrderChange: () => handleDashboardWidgetOrderChange(),
            handlePinnedAccountSlotChange: (el) => handlePinnedAccountSlotChange(el),
            ledgerYearSelectChange: () => ledgerYearSelectChange(),
            handleAccGroupChange: () => handleAccGroupChange(),
            toggleRedrawFacilityFields: () => toggleRedrawFacilityFields(),
            toggleLeaseFields: () => toggleLeaseFields(),
            handleFundTxTypeChange: () => handleFundTxTypeChange(),
            handleFundTxFundChange: () => handleFundTxFundChange(),
            onCategoryFormTypeChange: () => populateCategoryParentSelect(),
            handleSalaryMemberChange: () => handleSalaryMemberChange(),
            handleSalarySchemeChange: () => handleSalarySchemeChange(),
            handleSalaryCurrencyChange: () => handleSalaryCurrencyChange(),
            changeReportCardPeriod1: (el) => changeReportCardPeriod(1, el.value),
            changeReportCardPeriod2: (el) => changeReportCardPeriod(2, el.value),
            changeMonthlyTrendYear: (el) => changeMonthlyTrendYear(el),
            handleBgThemeAutoToggleChange: () => handleBgThemeAutoToggleChange(),
        };

        const INPUT_ACTIONS = {
            recalcTxFdMaturity: () => { recalcTxFdMaturity(); syncTransferFxOnAmountChange(); recalcTxSplitTotal(); },
            recalcResolveFdMaturity: () => recalcResolveFdMaturity(),
            recalcFdOpeningRowMaturity: (el) => recalcFdOpeningRowMaturity(el.dataset.rowId),
            recalcTxManualFxPreview: () => recalcTxManualFxPreview(),
            recalcTransferFxFromRate: () => recalcTransferFxFromRate(),
            recalcTransferFxFromDestAmount: () => recalcTransferFxFromDestAmount(),
            recalcFundTxTotal: () => recalcFundTxTotal(),
            recalcFundTxPriceFromTotal: () => recalcFundTxPriceFromTotal(),
            handleNavPriceInput: (el) => handleNavPriceInput(el),
            recalcTxSplitTotal: () => recalcTxSplitTotal(),
            recalcSalaryPreview: () => recalcSalaryPreview(),
        };

        document.addEventListener("click", (e) => {
            const el = e.target.closest("[data-click]");
            if (!el) return;
            const action = CLICK_ACTIONS[el.dataset.click];
            if (action) action(el, e);
        });

        document.addEventListener("change", (e) => {
            const el = e.target.closest("[data-change]");
            if (!el) return;
            const action = CHANGE_ACTIONS[el.dataset.change];
            if (action) action(el, e);
        });

        document.addEventListener("input", (e) => {
            const el = e.target.closest("[data-input]");
            if (!el) return;
            const action = INPUT_ACTIONS[el.dataset.input];
            if (action) action(el, e);
        });

        // Monthly Trend chart hover tooltip (desktop) — delegated the same way as
        // click/change/input above rather than inline onmousemove, since the CSP here has no
        // 'unsafe-inline'. mousemove fires constantly while the mouse is anywhere on the page,
        // but the closest() check is cheap and this only actually does anything while a
        // .mtrend-bar element is under the cursor, so it's fine to leave attached at the
        // document level. Mobile/touch doesn't fire mousemove, which is why bars ALSO carry
        // data-click="monthlyTrendBarTap" above for tap support.
        document.addEventListener("mousemove", (e) => {
            const bar = e.target.closest(".mtrend-bar");
            if (bar) showMonthlyTrendTooltip(e, bar);
            else hideMonthlyTrendTooltip();
        });

        // v83: number inputs (Amount, Interest Rate, Tenure, etc.) silently change value when the
        // mouse wheel/trackpad scrolls over them WHILE FOCUSED — this is standard browser behavior
        // for <input type="number">, not a bug in this app's code, but it's a well-known footgun:
        // type a value into a field near the top of a long form (e.g. Amount in the Add/Edit
        // Transaction modal), then scroll the page down to reach fields further below, and if the
        // cursor happens to pass over that still-focused number field while scrolling, each wheel
        // notch nudges the value by one `step` — e.g. 3 notches over a step="0.01" field quietly
        // turns 50000.00 into 49999.97. Fixed by blurring any number input the instant a wheel
        // event reaches it; this does not block the page scroll itself (no preventDefault), it
        // just stops that scroll from being interpreted as a value change.
        document.addEventListener("wheel", () => {
            const active = document.activeElement;
            if (active && active.tagName === "INPUT" && active.type === "number") {
                active.blur();
            }
        }, { passive: true });

        window.addEventListener("load", bootstrap);

        // Floating "back to top" button (v66) — scrolls the page (this app scrolls at the
        // document/window level, not an inner container) smoothly back to the top when tapped.
        function scrollToTop() {
            window.scrollTo({ top: 0, behavior: "smooth" });
        }

        // Shows/hides the back-to-top button based on scroll position — hidden near the top of a
        // page (nothing to scroll back up to), visible once scrolled down past a small threshold.
        // Passive listener registered once at load time, independent of bootstrap() / page
        // switches since the button itself lives outside every .page div.
        function toggleBackToTopVisibility() {
            const btn = document.getElementById("backToTopBtn");
            if (!btn) return;
            btn.classList.toggle("visible", window.scrollY > 300);
        }
        window.addEventListener("scroll", toggleBackToTopVisibility, { passive: true });

        // v181: edge-swipe to open the sidebar drawer on phones. Only below the 768px
        // breakpoint (above that the sidebar is already permanently docked open, see the
        // matching @media rule in index.html) and only when the swipe STARTS within ~24px of
        // the left screen edge, matching the standard "edge swipe" gesture used by most mobile
        // apps/OSes — this avoids hijacking an ordinary left-right scroll or swipe gesture that
        // starts in the middle of the page content (e.g. dismissing a card, a chart pan, etc.).
        // v185: swipe-to-close added alongside the existing edge-swipe-to-open above. When the
        // drawer is OPEN, a touch starting anywhere inside #sidebarDrawer (not just the edge —
        // the whole open panel is a natural "drag it away" target) that moves leftward past the
        // threshold closes it, mirroring the rightward open gesture. Tracked with the same
        // touchStartX/Y pair so only one of the two branches (open vs close) can ever be "armed"
        // for a given touch, since the open-branch's own guard already bails out when the drawer
        // is open.
        (function setupSidebarSwipeGesture() {
            const EDGE_ZONE_PX = 24;
            const MIN_SWIPE_PX = 60;
            let touchStartX = null;
            let touchStartY = null;
            let startedInEdgeZone = false;
            let startedInsideOpenDrawer = false;

            document.addEventListener("touchstart", (e) => {
                if (window.innerWidth >= 768) return; // desktop/tablet: sidebar already docked
                const isOpen = document.getElementById("sidebarDrawer").classList.contains("open");
                const t = e.touches[0];
                touchStartX = t.clientX;
                touchStartY = t.clientY;
                if (isOpen) {
                    startedInEdgeZone = false;
                    startedInsideOpenDrawer = document.getElementById("sidebarDrawer").contains(e.target);
                } else {
                    startedInEdgeZone = t.clientX <= EDGE_ZONE_PX;
                    startedInsideOpenDrawer = false;
                }
            }, { passive: true });

            document.addEventListener("touchend", (e) => {
                if (touchStartX === null) return;
                const t = e.changedTouches[0];
                const dx = t.clientX - touchStartX;
                const dy = Math.abs(t.clientY - touchStartY);
                if (startedInEdgeZone) {
                    // Require a mostly-horizontal rightward swipe so an edge-starting vertical
                    // scroll doesn't accidentally pop the drawer open.
                    if (dx > MIN_SWIPE_PX && dy < dx) {
                        openSidebar();
                    }
                } else if (startedInsideOpenDrawer) {
                    // Mirror image: mostly-horizontal leftward swipe closes the open drawer.
                    if (dx < -MIN_SWIPE_PX && dy < -dx) {
                        closeSidebar();
                    }
                }
                touchStartX = null;
                touchStartY = null;
                startedInEdgeZone = false;
                startedInsideOpenDrawer = false;
            }, { passive: true });
        })();

        // v182: right-edge swipe (start near the right screen edge, drag leftward) opens the
        // insights drawer (Top Categories This Month / Recent Large Transactions — same content
        // as the 1400px+ rail) on phones. Mirrors setupSidebarSwipeGesture() above exactly, just
        // the opposite edge/direction, so the two can never both match the same touch.
        //
        // v182 follow-up: the first cut of this gestured on ANY left-to-right swipe starting
        // outside the left-edge zone, gated by a generic "is any ancestor horizontally
        // scrollable?" walk up the DOM. That walk was true for almost every element on the page
        // (containers commonly end up 1-2px wider than their clientWidth from borders/rounding,
        // with nothing actually scrollable) — so nearly every swipe got silently disqualified,
        // matching the "1 in 10" report. Switched to the same deterministic edge-zone check the
        // left drawer already uses reliably, instead of trying to detect scrollability at all.
        // v185: swipe-to-close added alongside the existing edge-swipe-to-open above, mirroring
        // setupSidebarSwipeGesture()'s open/close pairing exactly but for the opposite edge —
        // when the rail is OPEN, a touch starting anywhere inside #desktopInsightsRail that
        // moves rightward past the threshold closes it.
        (function setupInsightsDrawerSwipeGesture() {
            const EDGE_ZONE_PX = 24;
            const MIN_SWIPE_PX = 60;
            let touchStartX = null;
            let touchStartY = null;
            let startedInEdgeZone = false;
            let startedInsideOpenDrawer = false;

            document.addEventListener("touchstart", (e) => {
                if (window.innerWidth >= 768) return; // tablet/desktop: rail is docked or hidden, not a drawer
                const isOpen = document.getElementById("desktopInsightsRail").classList.contains("open");
                const t = e.touches[0];
                touchStartX = t.clientX;
                touchStartY = t.clientY;
                if (isOpen) {
                    startedInEdgeZone = false;
                    startedInsideOpenDrawer = document.getElementById("desktopInsightsRail").contains(e.target);
                } else {
                    startedInEdgeZone = t.clientX >= window.innerWidth - EDGE_ZONE_PX;
                    startedInsideOpenDrawer = false;
                }
            }, { passive: true });

            document.addEventListener("touchend", (e) => {
                if (touchStartX === null) return;
                const t = e.changedTouches[0];
                const dx = t.clientX - touchStartX;
                const dy = Math.abs(t.clientY - touchStartY);
                if (startedInEdgeZone) {
                    // Require a mostly-horizontal leftward swipe (dx negative), same "mostly
                    // horizontal" guard as the sidebar gesture, so an edge-starting vertical
                    // scroll doesn't accidentally pop the drawer open.
                    if (dx < -MIN_SWIPE_PX && dy < -dx) {
                        openInsightsDrawer();
                    }
                } else if (startedInsideOpenDrawer) {
                    // Mirror image: mostly-horizontal rightward swipe closes the open rail.
                    if (dx > MIN_SWIPE_PX && dy < dx) {
                        closeInsightsDrawer();
                    }
                }
                touchStartX = null;
                touchStartY = null;
                startedInEdgeZone = false;
                startedInsideOpenDrawer = false;
            }, { passive: true });
        })();


        // Register the Service Worker for offline support. Only works when served over http(s)
        // (e.g. GitHub Pages) — silently does nothing when opened as a local file:// page.
        if ("serviceWorker" in navigator && (location.protocol === "https:" || location.protocol === "http:")) {
            window.addEventListener("load", () => {
                navigator.serviceWorker.register("./sw.js").catch((err) => {
                    console.warn("Service worker registration failed:", err);
                });
            });
        }
