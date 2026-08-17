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
        const APP_VERSION = "v41";
        const APP_VERSION_DATE = "2026-08-17";

        // Runs immediately as this script executes (it's the last element in <body>, so the
        // DOM — including #versionBadge and the lock overlay — already exists by this point).
        // Deliberately NOT inside bootstrap() or the "load" listener: those gate on the app
        // being unlocked, and this badge needs to show before that.
        const versionBadgeEl = document.getElementById("versionBadge");
        if (versionBadgeEl) versionBadgeEl.textContent = `${APP_VERSION} · ${APP_VERSION_DATE}`;

        const DB_NAME = "EnterpriseMultiCurrencyLedgerDB_v4";
        const DB_VERSION = 4;
        const STORES = { ACCOUNTS: "accounts", TRANSACTIONS: "transactions", SETTINGS: "settings", CATEGORIES: "categories", MEMBERS: "members", FUNDS: "funds" };
        // Maps each object store to the field IndexedDB uses as its keyPath. That field must stay
        // unencrypted on the stored record (IndexedDB needs to read it directly to index/generate keys);
        // every other field on the record is encrypted as a single AES-GCM blob.
        const STORE_KEYPATHS = { accounts: "id", transactions: "id", settings: "key", categories: "id", members: "id", funds: "id" };

        // Fixed palette offered when picking a member's color (sidebar dot, net-worth rows, etc.)
        const MEMBER_COLORS = ["#3b82f6", "#ec4899", "#f59e0b", "#10b981", "#8b5cf6", "#ef4444", "#0ea5e9", "#14b8a6", "#f97316", "#64748b"];

        // Account grouping (v35) — every account belongs to one of these, used to sort/section
        // both the full Accounts page and a member's account list (group, then name). Accounts
        // saved before this existed default to "Bank/Cash" wherever a group is read.
        const ACCOUNT_GROUPS = ["Bank/Cash", "Credit Card", "Investment", "Real Estate"];
        const DEFAULT_ACCOUNT_GROUP = ACCOUNT_GROUPS[0];

        // Sub-groups (v39) — optional, per-Group breakdown so e.g. "Investment" can be split
        // into Fixed Deposit / KWSP / ASNB / Unit Trust rather than one flat list. A group with
        // no entry here (or an account left on "(No Sub-Group)") just isn't sub-divided. Purely
        // organizational — doesn't affect account.type (Normal/Multi-Currency/Fixed
        // Deposit/Unit Trust), just where it's filed on the Accounts page.
        const ACCOUNT_SUBGROUPS = {
            "Investment": ["Fixed Deposit", "KWSP", "ASNB", "Unit Trust"],
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

        async function handleForgotPasscode() {
            const step1 = await customConfirm("There is no passcode recovery. Resetting will permanently erase ALL data stored in this app on this device (accounts, transactions, categories). Continue?");
            if (!step1) return;
            const step2 = await customConfirm("Are you absolutely sure? This cannot be undone.");
            if (!step2) return;
            localStorage.removeItem(LOCK_CONFIG_KEY);
            try { indexedDB.deleteDatabase(DB_NAME); } catch (err) {}
            try { indexedDB.deleteDatabase(SECURITY_DB_NAME); } catch (err) {}
            location.reload();
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
        let directTypeView = "all"; 
        // Per-account "Account Activity" year navigation (v33) — which year is currently shown,
        // and the sorted list of years that actually have a transaction for that account (used to
        // skip empty years when paging with the </> controls). Reset whenever a fresh account view
        // is opened via navigateToLedgerPage(); recomputed every renderApp().
        let accountLedgerYear = "__fresh__"; // "__fresh__" = not yet initialized for this account view; null = user explicitly chose "All Years"; a number = one specific year
        let accountLedgerYearsCache = [];
        let ledgerBackToPage = "workspace"; 

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

        // Holds the compressed base64 image (if any) currently attached in the open transaction form.
        let currentTxImageData = null;

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

        // Built-in starter categories (auto-provisioned if missing; user can still
        // rename/remove via the Categories manager same as any custom category)
        const DEFAULT_CATEGORIES = [
            { name: "Dividend ASNB", type: "income", icon: "📈" },
            { name: "Divident EPF", type: "income", icon: "🏦" },
            { name: "EPF Contrib.(ER)", type: "income", icon: "🏦" },
            { name: "EPF Contrib.(EE)", type: "income", icon: "🏦" },
            { name: "FD Interest", type: "income", icon: "🏦" },
            { name: "Bank Interest", type: "income", icon: "💰" },
            { name: "Gift Received", type: "income", icon: "🎁" },
            { name: "Rebate", type: "income", icon: "💸" },
            { name: "Grants", type: "income", icon: "🎓" },
            { name: "Dividend Unit Trust", type: "income", icon: "🧺" },
            { name: "Bank Charges", type: "expense", icon: "💳" },
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
            { name: "Unknown", type: "expense", icon: "❓" }
        ];

        // Dynamic Rich Catalog of Preset Icons grouped logically
        const emojiDirectory = {
            "Money & Fin.": ["💵", "💰", "💳", "📈", "📉", "🪙", "💎", "💸"],
            "Food & Dining": ["🍔", "🍜", "🍕", "☕", "🍺", "🍏", "🍣", "🍩"],
            "Transport": ["🚗", "🚌", "🚆", "✈️", "🚲", "⛽", "🚕", "🚢"],
            "Home & Living": ["🏠", "🔌", "📡", "🛋️", "🧹", "💧", "📦", "🔑"],
            "Life & Leisure": ["🎬", "🎮", "⚽", "🏖️", "🛒", "👕", "🎁", "💊"],
            "Income & Business": ["🏢", "💼", "💻", "🛠️", "🤝", "🏡", "🎓", "👑"]
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
            "fd interest": "🏦",
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
            "unknown": "❓"
        };

        // Helper to retrieve correct category icon safely
        function getCategoryIcon(catName, type = "expense") {
            const clean = catName.toLowerCase().trim();
            const matched = dynamicCategories.find(c => c.name.toLowerCase() === clean);
            if (matched) return matched.icon;
            return fallbackIcons[clean] || (type === "income" ? "🟢" : "🔴");
        }

        // --- NATIVE ROUTING CORE (MOBILE BACK-BUTTON COUPLING) ---
        function pushVirtualState(stateName) {
            window.history.pushState({ view: stateName }, "");
        }

        window.addEventListener("popstate", (event) => {
            if (document.getElementById("editAccountId").value !== "") {
                resetAccountForm();
                return;
            }

            const activeModals = ["txModal", "accountsModal", "currencyModal", "categoriesModal", "imageViewerModal", "resolveFdModal", "memberModal", "fundModal", "fundTxModal"];
            let modalClosed = false;
            activeModals.forEach(id => {
                const modal = document.getElementById(id);
                if (modal && modal.classList.contains("active")) {
                    modal.classList.remove("active");
                    modalClosed = true;
                }
            });
            if (modalClosed) return;

            const ledgerPage = document.getElementById("page-ledger");
            const savingsPage = document.getElementById("page-savings");
            const accountsPage = document.getElementById("page-accounts");
            const categoriesPage = document.getElementById("page-categories");
            const backupPage = document.getElementById("page-backup");
            const autolockPage = document.getElementById("page-autolock");
            const databasePage = document.getElementById("page-database");
            const spendingBreakdownPage = document.getElementById("page-spending-breakdown");
            const incomeBreakdownPage = document.getElementById("page-income-breakdown");

            if (!ledgerPage.classList.contains("hidden")) {
                handleLedgerBackClick();
            } else if (
                !savingsPage.classList.contains("hidden") ||
                !accountsPage.classList.contains("hidden") ||
                !categoriesPage.classList.contains("hidden") ||
                !backupPage.classList.contains("hidden") ||
                !autolockPage.classList.contains("hidden") ||
                !databasePage.classList.contains("hidden") ||
                !spendingBreakdownPage.classList.contains("hidden") ||
                !incomeBreakdownPage.classList.contains("hidden")
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

        function populateRecentTxAccountSelect(accounts) {
            const sel = document.getElementById("recentTxAccountSelect");
            if (!sel) return;
            const current = recentTxAccountFilter;
            sel.innerHTML = `<option value="all">All Accounts</option>` +
                accounts.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(accountOptionLabel(a))}</option>`).join("");
            sel.value = accounts.some(a => a.id === current) ? current : "all";
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

            let filtered = txs.filter(t => t.type === "income" || t.type === "expense");
            if (recentTxTypeFilter !== "both") filtered = filtered.filter(t => t.type === recentTxTypeFilter);
            if (recentTxAccountFilter !== "all") filtered = filtered.filter(t => t.src === recentTxAccountFilter);

            filtered = [...filtered].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, recentTxCount);

            if (filtered.length === 0) {
                list.innerHTML = `<p style="color:var(--text-muted); text-align:center; padding:16px 0; font-size:0.85rem;">No matching transactions yet.</p>`;
                return;
            }

            list.innerHTML = filtered.map(t => {
                const col = t.type === "income" ? "income-color" : "expense-color";
                const sgn = t.type === "income" ? "+" : "-";
                const iconBadge = getCategoryIcon(t.cat, t.type);
                const acc = accounts.find(a => a.id === t.src);
                return `
                    <div class="ledger-item" data-click="openTransactionForm" data-type="${t.type}" data-id="${escapeHtml(t.id)}">
                        <div class="item-left">
                            <span class="item-name">${iconBadge} ${escapeHtml(t.desc)}</span>
                            <span class="item-meta">${t.date} [${escapeHtml(t.cat || '')}]</span>
                            <span class="item-meta" style="display:block; margin-top:2px; color:var(--text-muted);">🏦 ${acc ? escapeHtml(acc.name) : "(deleted account)"}</span>
                        </div>
                        <div class="item-right">
                            <div class="item-value" style="color:var(--${col}); font-weight:bold;">${sgn}${formatCurrency(t.amount, t.currency)}</div>
                        </div>
                    </div>
                `;
            }).join("");
        }

        function toggleRecentTxSettings() {
            const panel = document.getElementById("recentTxSettingsPanel");
            if (!panel) return;
            panel.style.display = panel.style.display === "none" ? "flex" : "none";
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
            pushVirtualState(id);
        }
        
        // Closing a modal is just "go back" — the popstate listener above is the single place
        // that actually removes the "active" class (see its activeModals loop). Previously this
        // function removed "active" itself before calling history.back(), which meant by the time
        // popstate fired, every modal already looked inactive — so the listener's own "was a modal
        // open?" check always came back false and fell through to page-level back navigation
        // instead (e.g. leaving an account's ledger view for the workspace right after Save/Cancel
        // on the transaction editor, rather than just closing that editor). Letting popstate do the
        // actual closing keeps the visible UI and the history stack in lockstep.
        function closeModal(id) { 
            const el = document.getElementById(id);
            if (el && el.classList.contains("active")) {
                window.history.back();
            }
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
        const APP_PAGE_IDS = ["page-workspace", "page-ledger", "page-savings", "page-accounts", "page-categories", "page-backup", "page-autolock", "page-database", "page-spending-breakdown", "page-income-breakdown", "page-datasecurity", "page-members", "page-member"];
        function showPage(id) {
            APP_PAGE_IDS.forEach(p => {
                const el = document.getElementById(p);
                if (el) el.classList.toggle("hidden", p !== id);
            });
            // Keeps the sidebar's active-item highlight correct even when it's persistently
            // visible (desktop/tablet) rather than only refreshed on drawer-open (mobile).
            updateSidebarActiveState();
        }

        function navigateToLedgerPage(accountId, backTarget = "workspace") {
            workspaceScrollY = window.scrollY;
            activeLedgerAccountView = accountId;
            activeCategoryView = "all";
            directTypeView = "all";
            accountLedgerYear = "__fresh__"; // fresh account view — default to its latest year with data
            ledgerBackToPage = backTarget;
            ledgerRenderLimit = LEDGER_PAGE_SIZE;
            showPage("page-ledger");
            window.scrollTo(0,0);
            pushVirtualState("ledger");
            renderApp();
        }

        function ledgerYearPrev() {
            const idx = accountLedgerYearsCache.indexOf(accountLedgerYear);
            if (idx > 0) { accountLedgerYear = accountLedgerYearsCache[idx - 1]; renderApp(); }
        }

        function ledgerYearNext() {
            const idx = accountLedgerYearsCache.indexOf(accountLedgerYear);
            if (idx >= 0 && idx < accountLedgerYearsCache.length - 1) { accountLedgerYear = accountLedgerYearsCache[idx + 1]; renderApp(); }
        }

        // Fired when the year <select> (which replaced the old plain "< 2019 >" label) changes —
        // lets the user jump straight to any year with data, or to "All Years" (accountLedgerYear
        // = null) to see the account's complete transaction history on one page.
        function ledgerYearSelectChange() {
            const val = document.getElementById("ledgerYearLabel").value;
            accountLedgerYear = val === "all" ? null : parseInt(val, 10);
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

        function navigateToCategoryPage(categoryName, backTarget = "workspace") {
            if (backTarget === "workspace") workspaceScrollY = window.scrollY;
            activeCategoryView = categoryName;
            activeLedgerAccountView = "all";
            directTypeView = "all";
            ledgerBackToPage = backTarget;
            ledgerRenderLimit = LEDGER_PAGE_SIZE;
            showPage("page-ledger");
            window.scrollTo(0,0);
            pushVirtualState("category_history");
            renderApp();
        }

        function navigateToDirectTypePage(type) {
            workspaceScrollY = window.scrollY;
            directTypeView = type;
            activeLedgerAccountView = "all";
            activeCategoryView = "all";
            ledgerBackToPage = "workspace";
            ledgerRenderLimit = LEDGER_PAGE_SIZE;
            showPage("page-ledger");
            window.scrollTo(0,0);
            pushVirtualState("ledger_type_filter");
            renderApp();
        }

        function navigateToSavingsPage() {
            workspaceScrollY = window.scrollY;
            showPage("page-savings");
            window.scrollTo(0,0);
            pushVirtualState("savings");
            renderApp();
        }

        async function navigateToWorkspace() {
            showPage("page-workspace");
            await renderApp();
            // Restored after renderApp() finishes rebuilding the dashboard's DOM (account list,
            // report card, etc.) — scrolling before that would target a not-yet-full-height page
            // and land in the wrong place.
            window.scrollTo(0, workspaceScrollY);
        }

        async function navigateToAccountsPage() {
            closeSidebar();
            workspaceScrollY = window.scrollY;
            showPage("page-accounts");
            window.scrollTo(0, 0);
            pushVirtualState("accounts");
            await renderAccountsPage();
        }

        async function navigateToCategoriesPage() {
            workspaceScrollY = window.scrollY;
            showPage("page-categories");
            window.scrollTo(0, 0);
            pushVirtualState("categories");
            await renderCategoriesPage();
        }

        function navigateToBackupPage() {
            workspaceScrollY = window.scrollY;
            showPage("page-backup");
            window.scrollTo(0, 0);
            pushVirtualState("backup");
            calculateStorageMetrics();
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

        function handleLedgerBackClick() {
            if (ledgerBackToPage === "savings") {
                showPage("page-savings");
            } else if (ledgerBackToPage === "accounts") {
                showPage("page-accounts");
                renderAccountsPage();
            } else if (ledgerBackToPage === "member") {
                showPage("page-member");
                renderMemberPage();
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
            let target = null;
            if (!savingsHidden) target = "savings";
            else if (!accountsHidden) target = "accounts";
            else if (!categoriesHidden) target = "categories";
            else if (!backupHidden) target = "backup";
            else if (!autolockHidden) target = "autolock";
            else if (!databaseHidden) target = "database";
            else if (!spendingHidden) target = "spending-breakdown";
            else if (!incomeHidden) target = "income-breakdown";
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
            else if (target === "autolock") navigateToAutoLockPage();
            else if (target === "database") navigateToDatabasePage();
            else if (target === "spending-breakdown") navigateToSpendingBreakdownPage();
            else if (target === "income-breakdown") navigateToIncomeBreakdownPage();
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

                document.getElementById("appStorageText").textContent = `App Local Database footprint: ~${appMB} MB (0 attachments, 0.00 MB)`;
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
            openModal("currencyModal");
        }

        function renderFxRatesInputs() {
            let html = "";
            Object.keys(fxRates).forEach(curr => {
                if (curr === baseCurrency) return;
                html += `
                    <div class="form-row" style="display: flex; align-items: center; gap: 8px;">
                        <span style="width: 80px; font-weight:700; font-size:0.85rem;">1 ${baseCurrency} =</span>
                        <input type="number" step="0.0001" id="fxRate-${curr}" value="${(fxRates[curr] / fxRates[baseCurrency]).toFixed(4)}" style="flex:1;">
                        <span style="width: 50px; font-weight:700; font-size:0.85rem;">${curr}</span>
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
                    fxRates[curr] = val;
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

        // --- ACCOUNTS MANAGER SETUP (WITH INTEGRATED EDITOR) ---
        // Opens the Accounts modal in "create" mode — used by the "+" FAB on the Accounts page.
        function openAccountFormModal() {
            const select = document.getElementById("newAccCurrency"); select.innerHTML = "";
            Object.keys(fxRates).forEach(c => { select.innerHTML += `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`; });
            select.value = baseCurrency;
            resetAccountForm();
            renderAccountMemberCheckboxes([]);
            openModal("accountsModal");
        }

        // Fills the Default Payment Account dropdown with every account, and selects whatever is
        // currently saved as the default.
        async function populateDefaultPaymentAccountSelect() {
            const accounts = await readAllDB(STORES.ACCOUNTS);
            const select = document.getElementById("defaultPaymentAccountSelect");
            select.innerHTML = `<option value="">(None)</option>` + accounts.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(accountOptionLabel(a))} (${escapeHtml(a.currency || a.type)})</option>`).join("");
            select.value = accounts.some(a => a.id === defaultPaymentAccount) ? defaultPaymentAccount : "";
        }

        async function saveDefaultPaymentAccount() {
            defaultPaymentAccount = document.getElementById("defaultPaymentAccountSelect").value;
            await writeDB(STORES.SETTINGS, { key: "defaultPaymentAccount", value: defaultPaymentAccount });
        }

        let multiOpeningRowCounter = 0;
        let fdOpeningRowCounter = 0;

        function setAccountTypeUI(type) {
            document.getElementById("newAccType").value = type;
            const normalBtn = document.getElementById("accTypeBtnNormal");
            const multiBtn = document.getElementById("accTypeBtnMulti");
            const fdBtn = document.getElementById("accTypeBtnFd");
            const utBtn = document.getElementById("accTypeBtnUt");
            const balCurrRow = document.getElementById("newAccBalCurrRow");
            const multiWrap = document.getElementById("multiOpeningWrap");
            const fdWrap = document.getElementById("fdOpeningWrap");
            const utWrap = document.getElementById("utInfoWrap");
            const hint = document.getElementById("accTypeHint");
            const isEditing = document.getElementById("editAccountId").value !== "";

            [normalBtn, multiBtn, fdBtn, utBtn].forEach(btn => {
                btn.style.background = "#e2e8f0"; btn.style.color = "var(--text-main)";
            });

            balCurrRow.style.display = "none";
            multiWrap.style.display = "none";
            fdWrap.style.display = "none";
            utWrap.style.display = "none";

            if (type === "normal") {
                normalBtn.style.background = "var(--transfer-color)"; normalBtn.style.color = "white";
                balCurrRow.style.display = "flex";
                hint.textContent = "A single fixed currency, chosen now — e.g. a MYR bank account.";
            } else if (type === "multi") {
                multiBtn.style.background = "var(--transfer-color)"; multiBtn.style.color = "white";
                hint.textContent = "Holds separate currency balances under one account name — e.g. \"Bank A\" with its own SGD and MYR balances side by side, never mixed together.";
                // Opening balances only make sense when creating a brand-new account — for an
                // existing account, use the normal Income/Transfer entry to add funds instead.
                if (!isEditing) {
                    multiWrap.style.display = "block";
                    if (document.getElementById("multiOpeningRows").children.length === 0) addMultiCurrencyRow();
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
            const today = new Date().toISOString().split("T")[0];

            const row = document.createElement("div");
            row.id = rowId;
            row.style.cssText = "background:#faf5ff; border:1px solid #ede9fe; border-radius:10px; padding:10px; margin-bottom:10px; position:relative;";
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
            const maturityStr = maturity.toISOString().split("T")[0];
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
        function handleAccGroupChange(preselectSubgroup) {
            const group = document.getElementById("newAccGroup").value;
            const list = subgroupsForGroup(group);
            const row = document.getElementById("newAccSubgroupRow");
            const sel = document.getElementById("newAccSubgroup");
            if (list.length === 0) {
                row.style.display = "none";
                sel.innerHTML = "";
                return;
            }
            row.style.display = "flex";
            sel.innerHTML = `<option value="">(No Sub-Group)</option>` + list.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
            sel.value = (preselectSubgroup && list.includes(preselectSubgroup)) ? preselectSubgroup : "";
        }

        function resetAccountForm() {
            const isEditing = document.getElementById("editAccountId").value !== "";
            document.getElementById("editAccountId").value = "";
            document.getElementById("newAccName").value = "";
            document.getElementById("newAccGroup").value = DEFAULT_ACCOUNT_GROUP;
            handleAccGroupChange();
            document.getElementById("newAccBal").value = "0";
            document.getElementById("newAccCurrency").value = baseCurrency;
            document.getElementById("accountFormHeaderTitle").textContent = "Create New Account";
            document.getElementById("accFormSubmitBtn").textContent = "Create Account";
            document.getElementById("accFormCancelBtn").style.display = "none";
            document.getElementById("accFormDeleteBtn").style.display = "none";

            document.getElementById("multiOpeningRows").innerHTML = "";
            document.getElementById("fdOpeningRows").innerHTML = "";
            renderAccountMemberCheckboxes([]);

            setAccountTypeUI("normal");

            if (isEditing) {
                pushVirtualState("accountsModal");
            }
        }

        // Dedicated custom execution for mobile click bypassing standard form intercept
        async function handleCreateAccountMobile() {
            const isNewAccount = document.getElementById("editAccountId").value === "";
            const id = document.getElementById("editAccountId").value || "acc_" + Date.now();
            const name = document.getElementById("newAccName").value.trim();
            const type = document.getElementById("newAccType").value;

            if(!name) { alert("Please enter an account name."); return; }

            const record = { id, name, type, group: document.getElementById("newAccGroup").value || DEFAULT_ACCOUNT_GROUP, subgroup: document.getElementById("newAccSubgroup").value || "", memberIds: getCheckedAccountMemberIds() };

            if (type === "normal") {
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
            const todayStr = new Date().toISOString().split("T")[0];

            if (isNewAccount && type === "multi") {
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
                    alert(`Account created, but ${failedCount.n} opening balance/placement entr${failedCount.n === 1 ? 'y' : 'ies'} could not be saved. You can add them manually via Income entries.`);
                }
            }

            resetAccountForm();
            await refreshAfterAccountChange();
        }

        // Refreshes the dashboard's compact account list (always, via renderApp) and, if the
        // full Accounts page happens to be the one on screen, its list too — called after any
        // account create/edit/delete so whichever view the user is looking at stays current.
        async function refreshAfterAccountChange() {
            await renderApp();
            renderSidebarMembers();
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
        function accountOptionLabel(a) {
            return `${a.name} (${accountOwnerNamesText(a)})`;
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
            await populateDefaultPaymentAccountSelect();
            const { accounts, nativeBalances } = await computeAccountBalances();
            const sorted = sortAccountsByGroupThenName(accounts);
            let html = "";
            let lastGroup = null;
            let lastSubgroup = undefined;
            let groupTotal = 0, subgroupTotal = 0;

            // Flushes the pending sub-group subtotal (only when that group actually has
            // sub-groups configured — plain groups with no sub-division never show one).
            function flushSubgroupTotal() {
                if (lastSubgroup) {
                    html += `<div class="config-list-subtotal">Sub-Total · ${escapeHtml(lastSubgroup)}: <strong>${formatBalanceHTML(subgroupTotal, baseCurrency)}</strong></div>`;
                }
                subgroupTotal = 0;
            }
            function flushGroupTotal() {
                if (lastGroup !== null) {
                    html += `<div class="config-list-grouptotal">Group Total · ${escapeHtml(lastGroup)}: <strong>${formatBalanceHTML(groupTotal, baseCurrency)}</strong></div>`;
                }
                groupTotal = 0;
            }

            sorted.forEach(a => {
                const group = a.group || DEFAULT_ACCOUNT_GROUP;
                const subgroup = a.subgroup || "";
                if (group !== lastGroup) {
                    flushSubgroupTotal();
                    flushGroupTotal();
                    html += `<div class="config-list-section-label">${escapeHtml(group)}</div>`;
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
                            : `<span style="font-size:0.65rem; padding:1px 4px; border-radius:4px; background:#e2e8f0; color:var(--text-muted); font-weight:bold;">${escapeHtml(a.currency)}</span>`;

                let balSummary;
                if (a.type === "fd" || a.type === "multi" || a.type === "unittrust") {
                    const baskets = nativeBalances[a.id];
                    const currencies = Object.keys(baskets);
                    balSummary = currencies.length === 0
                        ? '<span style="color:var(--text-muted);">No funds yet</span>'
                        : currencies.map(curr => `<strong>${formatBalanceHTML(baskets[curr], curr)}</strong>`).join(" + ");
                } else {
                    balSummary = `<strong>${formatBalanceHTML(nativeBalances[a.id], a.currency)}</strong>`;
                }

                const baseVal = accountBaseValue(a, nativeBalances);
                groupTotal += baseVal;
                subgroupTotal += baseVal;

                html += `
                    <div class="config-item" style="cursor:pointer;" data-click="navigateToLedgerPage" data-id="${escapeHtml(a.id)}" data-back="accounts">
                        <span>
                            <strong>${escapeHtml(a.name)}</strong> ${typeBadge} - ${balSummary}
                            <br>${accountOwnerTagHTML(a)}
                        </span>
                        <span style="color:var(--text-muted);">›</span>
                    </div>`;
            });
            flushSubgroupTotal();
            flushGroupTotal();
            document.getElementById("accountsPageList").innerHTML = html || `<p style="color:var(--text-muted); text-align:center; padding:24px 0; font-size:0.85rem;">No accounts yet — tap + to add one.</p>`;
        }

        // Shared by both entry points: the ✏️ icon on an account's Activity page, and (kept for
        // completeness) any future caller passing an id directly. Populates the form and opens
        // the Accounts modal in "edit" mode, showing the Delete button.
        async function editAccount(id) {
            const accounts = await readAllDB(STORES.ACCOUNTS);
            const account = accounts.find(a => a.id === id);
            if (!account) return;

            const select = document.getElementById("newAccCurrency"); select.innerHTML = "";
            Object.keys(fxRates).forEach(c => { select.innerHTML += `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`; });

            document.getElementById("editAccountId").value = account.id;
            document.getElementById("newAccName").value = account.name;
            document.getElementById("newAccGroup").value = account.group || DEFAULT_ACCOUNT_GROUP;
            handleAccGroupChange(account.subgroup || "");

            setAccountTypeUI(account.type || "normal");
            if (!account.type || account.type === "normal") {
                document.getElementById("newAccBal").value = account.initialBalance;
                document.getElementById("newAccCurrency").value = account.currency;
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
                <label style="display:flex; align-items:center; gap:4px; padding:6px 10px; border:1.5px solid var(--border-color); border-radius:20px; font-size:0.78rem; font-weight:600; cursor:pointer;">
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
        }

        async function handleDeleteFund() {
            const id = document.getElementById("fundId").value;
            if (!id) return;
            const ok = await customConfirm("Delete this fund? Its transaction history stays in the ledger, but will no longer be linked to a fund.");
            if (!ok) return;
            await deleteDB(STORES.FUNDS, id);
            closeModal("fundModal");
            renderApp();
        }

        async function openAddFundTxModal() {
            const accountId = activeLedgerAccountView;
            if (accountId === "all") return;
            const funds = await getFundsForAccount(accountId);
            if (funds.length === 0) { alert("Add a fund first, then log transactions against it."); return; }

            document.getElementById("fundTxAccountId").value = accountId;
            const fundSel = document.getElementById("fundTxFundId");
            fundSel.innerHTML = funds.map(f => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}${f.code ? " (" + escapeHtml(f.code) + ")" : ""}</option>`).join("");

            const accounts = await readAllDB(STORES.ACCOUNTS);
            const cashAccounts = accounts.filter(a => a.id !== accountId);
            const transferSel = document.getElementById("fundTxTransferAccount");
            transferSel.innerHTML = cashAccounts.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(accountOptionLabel(a))}</option>`).join("");

            document.getElementById("fundTxModalTitle").textContent = "Add Transaction";
            document.getElementById("fundTxId").value = "";
            document.getElementById("fundTxType").value = "buy";
            document.getElementById("fundTxDate").value = new Date().toISOString().split("T")[0];
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
            transferSel.innerHTML = cashAccounts.map(a => `<option value="${escapeHtml(a.id)}">${escapeHtml(accountOptionLabel(a))}</option>`).join("");

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
            const total = parseFloat(document.getElementById("fundTxTotal").value);
            const transferAccountId = document.getElementById("fundTxTransferAccount").value;
            const notes = document.getElementById("fundTxNotes").value.trim();

            if (!date) { alert("Please select a date."); return; }
            if (isNaN(total) || total <= 0) { alert("Please enter a valid Total Amount."); return; }
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
            await deleteDB(STORES.TRANSACTIONS, tx.id);
            closeModal("fundTxModal");
            renderApp();
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

            // Groups every fund-linked transaction under this account by fundId — used both to
            // compute each live fund's invested-cash-basis figure, and to find transactions whose
            // fundId no longer resolves to any fund record under this account (orphaned).
            const fundTxsByFundId = {};
            allTxs.forEach(t => {
                if (!t.fundId) return;
                (fundTxsByFundId[t.fundId] = fundTxsByFundId[t.fundId] || []).push(t);
            });

            function computeInvested(fundTxs) {
                let invested = 0;
                fundTxs.forEach(t => {
                    if (t.fundTxType === "buy" || t.fundTxType === "dividend_reinvest" || t.fundTxType === "contribution") invested += t.amount;
                    else if (t.fundTxType === "sell") invested -= t.amount;
                });
                return invested;
            }
            function computeHoldingYears(fundTxs) {
                const firstTxDate = fundTxs.length > 0 ? new Date(fundTxs[0].date) : null;
                return firstTxDate ? Math.max((todayMs - firstTxDate.getTime()) / (365.25 * 86400000), 0) : 0;
            }

            const rowsHtml = [];
            let totalValue = 0, totalInvested = 0, totalPl = 0;
            let commonCurrency = null, mixedCurrency = false;

            funds.forEach(f => {
                const fundTxs = (fundTxsByFundId[f.id] || []).slice().sort((a, b) => new Date(a.date) - new Date(b.date));
                const invested = computeInvested(fundTxs);
                const value = (f.units || 0) * (f.currentNav || 0);
                const pl = value - invested;
                const returnPct = invested > 0 ? (pl / invested) * 100 : 0;
                const holdingYears = computeHoldingYears(fundTxs);
                let annualised = 0;
                if (invested > 0 && value > 0 && holdingYears >= 0.08) {
                    annualised = (Math.pow(value / invested, 1 / holdingYears) - 1) * 100;
                }
                const ownerLabel = accountOwnerNamesText({ memberIds: f.ownerMemberIds });
                const plColor = pl >= 0 ? "var(--income-color)" : "var(--expense-color)";

                totalValue += value; totalInvested += invested; totalPl += pl;
                if (commonCurrency === null) commonCurrency = f.currency; else if (commonCurrency !== f.currency) mixedCurrency = true;

                rowsHtml.push(`
                    <tr style="cursor:pointer;" data-click="editFund" data-id="${escapeHtml(f.id)}">
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
            const liveFundIds = new Set(funds.map(f => f.id));
            const orphanFundIds = Object.keys(fundTxsByFundId).filter(fid => !liveFundIds.has(fid));
            orphanFundIds.forEach(fid => {
                const fundTxs = fundTxsByFundId[fid].slice().sort((a, b) => new Date(a.date) - new Date(b.date));
                if (fundTxs.length === 0) return;
                const invested = computeInvested(fundTxs);
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

                totalValue += invested; totalInvested += invested; // P/L 0 at cost basis, no live NAV
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
                        <td style="padding:8px 10px; text-align:right;"><strong>${formatCurrency(invested, currency)}</strong></td>
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
                <label style="display:flex; align-items:center; gap:4px; padding:6px 10px; border:1.5px solid var(--border-color); border-radius:20px; font-size:0.78rem; font-weight:600; cursor:pointer;">
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

        // Sums a subset of accounts into { total (in baseCurrency), currencyTotals { CODE: nativeAmt } }
        function summarizeAccountsNetWorth(accountsSubset, nativeBalances) {
            let total = 0;
            const currencyTotals = {};
            accountsSubset.forEach(a => {
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

        // Draws the dashboard's "Net Worth by Member" report: one row per member (solo-owned
        // accounts only), one row per distinct joint-owned account group, and — only if any exist
        // — a final "Unassigned" row so the breakdown always ties out to the grand total above it.
        function renderMemberNetWorthRows(accounts, nativeBalances) {
            const wrap = document.getElementById("memberNetWorthRows");
            if (!wrap) return;

            if (membersCache.length === 0) {
                wrap.innerHTML = `<p style="color:var(--text-muted); font-size:0.85rem;">No members yet — add one via Sidebar ▸ Manage Members to break this down by person.</p>`;
                return;
            }

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
            const { accounts, nativeBalances } = await computeAccountBalances();
            const subset = filterAccountsByOwnership(accounts, type, ids);
            const { total, currencyTotals } = summarizeAccountsNetWorth(subset, nativeBalances);

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
                        <div class="cur-code">${escapeHtml(curr)}</div>
                        <div class="cur-amt">${formatBalanceHTML(amt, curr)}</div>
                    </div>
                `).join("");

            let html = "";
            sortAccountsByGroupThenName(subset).forEach(a => {
                const typeBadge = a.type === "fd"
                    ? `<span style="font-size:0.65rem; padding:1px 4px; border-radius:4px; background:#ede9fe; color:#6d28d9; font-weight:bold;">Fixed Deposit</span>`
                    : a.type === "multi"
                        ? `<span style="font-size:0.65rem; padding:1px 4px; border-radius:4px; background:#e0f2fe; color:#0369a1; font-weight:bold;">Multi-Currency</span>`
                        : a.type === "unittrust"
                            ? `<span style="font-size:0.65rem; padding:1px 4px; border-radius:4px; background:#fef3c7; color:#92400e; font-weight:bold;">Unit Trust</span>`
                            : `<span style="font-size:0.65rem; padding:1px 4px; border-radius:4px; background:#e2e8f0; color:var(--text-muted); font-weight:bold;">${escapeHtml(a.currency)}</span>`;

                let balSummary;
                if (a.type === "fd" || a.type === "multi" || a.type === "unittrust") {
                    const baskets = nativeBalances[a.id];
                    const currencies = Object.keys(baskets);
                    balSummary = currencies.length === 0
                        ? '<span style="color:var(--text-muted);">No funds yet</span>'
                        : currencies.map(curr => `<strong>${formatBalanceHTML(baskets[curr], curr)}</strong>`).join(" + ");
                } else {
                    balSummary = `<strong>${formatBalanceHTML(nativeBalances[a.id], a.currency)}</strong>`;
                }

                html += `
                    <div class="config-item" style="cursor:pointer;" data-click="navigateToLedgerPage" data-id="${escapeHtml(a.id)}" data-back="member">
                        <span><strong>${escapeHtml(a.name)}</strong> ${typeBadge} - ${balSummary}<br><span style="font-size:0.7rem; color:var(--text-muted); font-weight:600;">${escapeHtml(a.group || DEFAULT_ACCOUNT_GROUP)}</span></span>
                        <span style="color:var(--text-muted);">›</span>
                    </div>`;
            });
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
            document.getElementById("catLabelName").value = "";
            document.getElementById("catSelectedEmoji").value = "🍔";
            document.getElementById("currentSelectedEmojiBadge").textContent = "🍔";
            buildEmojiSelectionPanel();
            openModal("categoriesModal");
        }

        // Fills the Default Income/Expense Category dropdowns with the same merged
        // (custom + starter) category lists used by the transaction form, plus a leading
        // "(None)" option, and selects whatever is currently saved as the default.
        function populateDefaultCategorySelects() {
            const incomeFallback = ["Salary", "Investments", "Freelance", "Other Income"];
            const expenseFallback = ["Groceries", "Dining Out", "Utilities", "Rent", "Commute", "Entertainment", "Other Expenses"];

            const incomeNames = [...new Set([...dynamicCategories.filter(c => c.type === "income").map(c => c.name), ...incomeFallback])].sort((a, b) => a.localeCompare(b));
            const expenseNames = [...new Set([...dynamicCategories.filter(c => c.type === "expense").map(c => c.name), ...expenseFallback])].sort((a, b) => a.localeCompare(b));

            const incSelect = document.getElementById("defaultIncomeCategorySelect");
            const expSelect = document.getElementById("defaultExpenseCategorySelect");

            incSelect.innerHTML = `<option value="">(None)</option>` + incomeNames.map(c => `<option value="${escapeHtml(c)}">${getCategoryIcon(c, "income")} ${escapeHtml(c)}</option>`).join("");
            expSelect.innerHTML = `<option value="">(None)</option>` + expenseNames.map(c => `<option value="${escapeHtml(c)}">${getCategoryIcon(c, "expense")} ${escapeHtml(c)}</option>`).join("");

            incSelect.value = incomeNames.includes(defaultIncomeCategory) ? defaultIncomeCategory : "";
            expSelect.value = expenseNames.includes(defaultExpenseCategory) ? defaultExpenseCategory : "";
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

        // Mobile Safe handler that overrides form submissions for zero keyboard delays
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

            const categoryId = "cat_" + Date.now();
            try {
                await writeDB(STORES.CATEGORIES, { id: categoryId, name, type, icon });
            } catch (err) {
                alert("Could not save category: " + (err && err.message ? err.message : err));
                return;
            }

            document.getElementById("catLabelName").value = "";
            
            await syncAndLoadCategories();
            await refreshAfterCategoryChange();
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
        async function renderCategoriesPage() {
            populateDefaultCategorySelects();

            const rowHtml = c => `
                <div class="config-item">
                    <span class="category-display-badge"><span>${c.icon}</span> <strong>${escapeHtml(c.name)}</strong></span>
                    <button class="trash-btn" data-click="removeCategory" data-id="${escapeHtml(c.id)}">🗑</button>
                </div>`;

            const incomeCats = dynamicCategories.filter(c => c.type === "income");
            const expenseCats = dynamicCategories.filter(c => c.type === "expense");

            document.getElementById("categoriesPageIncomeList").innerHTML = incomeCats.map(rowHtml).join("")
                || `<p style="color:var(--text-muted); padding:8px 0; font-size:0.85rem;">No income categories yet.</p>`;
            document.getElementById("categoriesPageExpenseList").innerHTML = expenseCats.map(rowHtml).join("")
                || `<p style="color:var(--text-muted); padding:8px 0; font-size:0.85rem;">No expense categories yet.</p>`;
        }

        async function removeCategory(id) {
            const ok = await customConfirm("Remove this custom category? Your transactions assigned to it will fallback to standard default icons.");
            if (!ok) return;

            try {
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

            const existingNames = new Set(existing.map(c => c.name.toLowerCase().trim()));
            const missing = DEFAULT_CATEGORIES.filter(c => !existingNames.has(c.name.toLowerCase()));

            const slugify = s => "cat_" + s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
            for (const c of missing) {
                await writeDB(STORES.CATEGORIES, { id: slugify(c.name), name: c.name, type: c.type, icon: c.icon });
            }
            await syncAndLoadCategories();
            await migrateOthersCategoryRename();
            await migrateStaleDestFieldCleanup();
            await migrateStaleCategoryOnTransfersCleanup();
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

        // --- TRANSACTION CREATION / EDITOR CORE ---
        async function openTransactionForm(type, existingTxId = null, presetSrcAccountId = null) {
            const accounts = await readAllDB(STORES.ACCOUNTS);
            if(accounts.length === 0) { alert("Add an account first!"); return; }

            const srcSelect = document.getElementById("srcAccount"); srcSelect.innerHTML = "";
            const destSelect = document.getElementById("destAccount"); destSelect.innerHTML = "";
            const currSelect = document.getElementById("txCurrency"); currSelect.innerHTML = "";
            const catSelect = document.getElementById("txCategory"); catSelect.innerHTML = "";

            Object.keys(fxRates).forEach(c => { currSelect.innerHTML += `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`; });
            accounts.forEach(a => {
                const prefix = a.type === "fd" ? "🏦 " : a.type === "multi" ? "💱 " : a.type === "unittrust" ? "📊 " : "";
                const currLabel = (a.type === "multi" || a.type === "fd" || a.type === "unittrust") ? "" : ` (${escapeHtml(a.currency)})`;
                const ownerLabel = ` — ${escapeHtml(accountOwnerNamesText(a))}`;
                srcSelect.innerHTML += `<option value="${escapeHtml(a.id)}">${prefix}${escapeHtml(a.name)}${currLabel}${ownerLabel}</option>`;
                destSelect.innerHTML += `<option value="${escapeHtml(a.id)}">${prefix}${escapeHtml(a.name)}${currLabel}${ownerLabel}</option>`;
            });

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
                const fallbackGroup = tx.type === "income" ? ["Salary", "Investments", "Freelance", "Other Income"] : ["Groceries", "Dining Out", "Utilities", "Rent", "Commute", "Entertainment", "Other Expenses"];
                
                // Transfers have no category at all (the Category row is hidden for them below) —
                // skip populating options entirely rather than leaving the <select> holding
                // whatever the expense list's alphabetically-first option happens to be. See the
                // matching comment on the "new entry" branch below for how that silently corrupted
                // Transfer records before this fix.
                if (tx.type !== "transfer") {
                    const uniqueMerged = [...new Set([...currentCats, ...fallbackGroup])].sort((a, b) => a.localeCompare(b));
                    uniqueMerged.forEach(c => {
                        const icon = getCategoryIcon(c, tx.type);
                        catSelect.innerHTML += `<option value="${escapeHtml(c)}">${icon} ${escapeHtml(c)}</option>`;
                    });
                }
                
                document.getElementById("txCategory").value = tx.cat || "";
                document.getElementById("destAccRow").style.display = tx.type === "transfer" ? "block" : "none";
                document.getElementById("categoryRow").style.display = tx.type === "transfer" ? "none" : "block";

                document.getElementById("txModalTitle").textContent = "Edit Ledger Entry";
                document.getElementById("txSubmitBtn").textContent = "Save Changes";
                document.getElementById("txDeleteBtn").style.display = "block";

                setTxImagePreview(tx.image || null);

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
                document.getElementById("txDate").value = new Date().toISOString().split('T')[0];
                document.getElementById("txDesc").value = "";
                document.getElementById("txAmount").value = "";

                // Pre-select the user's default payment account, if one is set and still exists —
                // new entries only, never when editing (handled above via tx.src). A preset
                // account passed in (e.g. opening this form via the "+" FAB on that account's own
                // Activity page — see quickAddChooseType()) takes priority over the stored default.
                if (defaultPaymentAccount && accounts.some(a => a.id === defaultPaymentAccount)) {
                    srcSelect.value = defaultPaymentAccount;
                }
                if (presetSrcAccountId && accounts.some(a => a.id === presetSrcAccountId)) {
                    srcSelect.value = presetSrcAccountId;
                }

                document.getElementById("destAccRow").style.display = type === "transfer" ? "block" : "none";
                document.getElementById("categoryRow").style.display = type === "transfer" ? "none" : "block";

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
                const fallbackGroup = type === "income" ? ["Salary", "Investments", "Freelance", "Other Income"] : ["Groceries", "Dining Out", "Utilities", "Rent", "Commute", "Entertainment", "Other Expenses"];
                
                // Transfers have no category (the Category row is hidden for them just above) — skip
                // populating the <select> entirely for them. Previously this always populated it
                // with the expense list even for Transfers (the ternary above only special-cases
                // "income", so "transfer" fell into the expense fallback too), and since a freshly
                // populated <select> auto-selects its first option, every new Transfer silently got
                // saved with the alphabetically-first expense category ("Commute") as its hidden
                // `cat` — invisible in the form, but shown on the ledger as "[Commute]".
                if (type !== "transfer") {
                    const uniqueMerged = [...new Set([...currentCats, ...fallbackGroup])].sort((a, b) => a.localeCompare(b));
                    uniqueMerged.forEach(c => {
                        const icon = getCategoryIcon(c, type);
                        catSelect.innerHTML += `<option value="${escapeHtml(c)}">${icon} ${escapeHtml(c)}</option>`;
                    });

                    // Pre-select the user's chosen default category for this type, if one is set
                    // and still exists among the current options — new entries only, never editing.
                    const defaultCat = type === "income" ? defaultIncomeCategory : defaultExpenseCategory;
                    if (defaultCat && uniqueMerged.includes(defaultCat)) {
                        catSelect.value = defaultCat;
                    }
                }

                document.getElementById("txModalTitle").textContent = "Log Ledger Item";
                document.getElementById("txSubmitBtn").textContent = "Commit Entry";
                document.getElementById("txDeleteBtn").style.display = "none";

                setTxImagePreview(null);

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

            openModal("txModal");
        }

        // --- RECEIPT / PHOTO ATTACHMENT ---

        function setTxImagePreview(base64OrNull) {
            currentTxImageData = base64OrNull;
            const wrap = document.getElementById("txImagePreviewWrap");
            const img = document.getElementById("txImagePreview");
            const status = document.getElementById("txImageStatus");

            if (base64OrNull) {
                img.src = base64OrNull;
                wrap.style.display = "block";
                status.textContent = "";
            } else {
                img.src = "";
                wrap.style.display = "none";
                status.textContent = "";
            }
            // Reset the file inputs so selecting the same file again still fires 'change'.
            document.getElementById("txCameraInput").value = "";
            document.getElementById("txGalleryInput").value = "";
        }

        function removeTxImage() {
            setTxImagePreview(null);
        }

        function handleTxImageSelected(event) {
            const file = event.target.files[0];
            if (!file) return;

            if (!file.type.startsWith("image/")) {
                alert("Please select an image file.");
                return;
            }

            const status = document.getElementById("txImageStatus");
            status.textContent = "Processing image...";

            const reader = new FileReader();
            reader.onload = (e) => {
                const rawDataUrl = e.target.result;
                compressImage(rawDataUrl, 1024, 0.7)
                    .then((compressedDataUrl) => {
                        currentTxImageData = compressedDataUrl;
                        document.getElementById("txImagePreview").src = compressedDataUrl;
                        document.getElementById("txImagePreviewWrap").style.display = "block";

                        const approxKb = Math.round((compressedDataUrl.length * 0.75) / 1024);
                        status.textContent = `Attached (~${approxKb} KB)`;
                    })
                    .catch(() => {
                        alert("Could not process this image. Please try another one.");
                        status.textContent = "";
                    });
            };
            reader.onerror = () => {
                alert("Could not read the selected file.");
                status.textContent = "";
            };
            reader.readAsDataURL(file);
        }

        // Resizes + re-encodes an image as JPEG to keep IndexedDB storage usage reasonable.
        // Receipts don't need full camera resolution to stay legible.
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

        function openImageViewer(base64, event) {
            if (event) event.stopPropagation();
            if (!base64) return;
            document.getElementById("imageViewerImg").src = base64;
            openModal("imageViewerModal");
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
                document.getElementById("txFdStartDate").value = document.getElementById("txDate").value || new Date().toISOString().split("T")[0];
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
            descRow.style.display = autoMode ? "none" : "block";
            descInput.required = !autoMode;
        }

        // Builds the auto-generated Description used for an FD placement when the user hasn't
        // opted to fill it in manually — derived from the Account/Reference No. if one was given,
        // else a generic placement label.
        function buildAutoFdDescription() {
            const ref = document.getElementById("txFdReference").value.trim();
            return ref ? `Fixed Deposit Placement (${ref})` : "Fixed Deposit Placement";
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
            const maturityStr = maturity.toISOString().split("T")[0];
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
                `${formatCurrency(tx.amount, tx.currency)} placement in "${holdingAccount.name}"${refText}`;
            document.getElementById("resolveFdMeta").textContent =
                `Commenced ${tx.fdStartDate} · ${tx.fdTenureMonths} months · ${tx.fdInterestRate}% p.a. · Matures ${tx.fdMaturityDate}`;

            // Prefill the interest field with the originally-projected simple-interest estimate —
            // the user can overwrite it with what the bank actually paid.
            const projectedInterest = tx.amount * (tx.fdInterestRate / 100) * (tx.fdTenureMonths / 12);
            document.getElementById("resolveFdInterest").value = projectedInterest.toFixed(2);

            // Destination account pickers for both flows — any account except this same FD placement's
            // holding account makes sense as a target (though we don't hard-block picking it either).
            const destOptions = accounts.map(a => {
                const prefix = a.type === "fd" ? "🏦 " : a.type === "multi" ? "💱 " : a.type === "unittrust" ? "📊 " : "";
                const currLabel = (a.type === "multi" || a.type === "fd" || a.type === "unittrust") ? "" : ` (${escapeHtml(a.currency)})`;
                return `<option value="${escapeHtml(a.id)}">${prefix}${escapeHtml(a.name)}${currLabel} — ${escapeHtml(accountOwnerNamesText(a))}</option>`;
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
                withdrawBtn.style.background = "#e2e8f0"; withdrawBtn.style.color = "var(--text-main)";
                renewWrap.style.display = "block";
                withdrawWrap.style.display = "none";
            } else {
                withdrawBtn.style.background = "var(--transfer-color)"; withdrawBtn.style.color = "white";
                renewBtn.style.background = "#e2e8f0"; renewBtn.style.color = "var(--text-main)";
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
                prinBtn.style.background = "#e2e8f0"; prinBtn.style.color = "var(--text-main)";
                destRow.style.display = "none";
            } else {
                prinBtn.style.background = "var(--transfer-color)"; prinBtn.style.color = "white";
                capBtn.style.background = "#e2e8f0"; capBtn.style.color = "var(--text-main)";
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
            const maturityStr = maturity.toISOString().split("T")[0];
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
            const today = new Date().toISOString().split("T")[0];
            const refLabel = tx.fdReferenceNo ? `Ref: ${tx.fdReferenceNo}` : `#${tx.id}`;

            try {
                if (action === "withdraw") {
                    const destId = document.getElementById("resolveFdWithdrawDest").value;
                    if (!destId) { alert("Please choose an account to receive the proceeds."); return; }

                    // Move the principal out of the FD basket into the chosen account. This is a
                    // "transfer" (not "expense") — moving your own principal isn't a spend, so it
                    // must not be counted in the Expense report.
                    await writeDB(STORES.TRANSACTIONS, {
                        type: "transfer", desc: `FD Withdrawal — Principal (${refLabel})`,
                        amount: tx.amount, src: holdingAccountId, dest: destId, currency: tx.currency,
                        cat: "Fixed Deposit", date: today, image: null,
                        fdReferenceNo: tx.fdReferenceNo || null,
                        fdStartDate: null, fdTenureMonths: null, fdInterestRate: null, fdMaturityDate: null
                    });

                    // The interest, however, IS genuine new income — record it as such into the destination account.
                    if (interest > 0) {
                        await writeDB(STORES.TRANSACTIONS, {
                            type: "income", desc: `FD Interest Received (${refLabel})`,
                            amount: interest, src: destId, dest: "", currency: tx.currency,
                            cat: "Interest Income", date: today, image: null,
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
                        type: "transfer", desc: `FD Placement Closed for Renewal (${refLabel})`,
                        amount: tx.amount, src: holdingAccountId, dest: "", currency: tx.currency,
                        cat: "Fixed Deposit", date: today, image: null,
                        fdReferenceNo: tx.fdReferenceNo || null,
                        fdStartDate: null, fdTenureMonths: null, fdInterestRate: null, fdMaturityDate: null
                    });

                    const newPrincipal = mode === "capitalize" ? tx.amount + interest : tx.amount;
                    await writeDB(STORES.TRANSACTIONS, {
                        type: "transfer", desc: `FD Renewal Placement`,
                        amount: newPrincipal, src: "", dest: holdingAccountId, currency: tx.currency,
                        cat: "Fixed Deposit", date: today, image: null,
                        fdReferenceNo: newReference,
                        fdStartDate: newStart, fdTenureMonths: newTenure, fdInterestRate: newRate, fdMaturityDate: newMaturity
                    });

                    if (mode === "principal" && interest > 0) {
                        const interestDestId = document.getElementById("resolveFdInterestDest").value;
                        if (!interestDestId) { alert("Please choose an account to receive the interest."); return; }
                        await writeDB(STORES.TRANSACTIONS, {
                            type: "income", desc: `FD Interest Received (${refLabel})`,
                            amount: interest, src: interestDestId, dest: "", currency: tx.currency,
                            cat: "Interest Income", date: today, image: null,
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
            renderApp();
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
            if (txIdInput !== "" && document.getElementById("txType").value === "transfer") {
                const existingTxs = await readAllDB(STORES.TRANSACTIONS);
                const existingTx = existingTxs.find(t => t.id === parseInt(txIdInput));
                if (existingTx && existingTx.cat === "Fixed Deposit") preservedTransferCat = "Fixed Deposit";
            }

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
                image: currentTxImageData || null,
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
                destAmount: transferDestAmountOverride
            };

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

            try {
                await writeDB(STORES.TRANSACTIONS, record);
            } catch (err) {
                const msg = (err && err.name === "QuotaExceededError")
                    ? "Not enough storage space to save this photo. Try removing the image or freeing up space."
                    : "Could not save transaction: " + (err && err.message ? err.message : err);
                alert(msg);
                return;
            }
            closeModal("txModal");
            renderApp();
        }

        // Delete button inside the "Edit Ledger Entry" modal itself — the ledger list no longer
        // has its own per-row delete affordance (tapping a row opens this modal instead; deleting
        // now happens from within it). Only shown when editing an existing entry (txDeleteBtn is
        // hidden for a brand-new entry, where there's nothing yet to delete).
        async function deleteTxFromEditModal() {
            const txIdInput = document.getElementById("txId").value;
            if (!txIdInput) return;

            const ok = await customConfirm("Delete this transaction item?");
            if (!ok) return;

            try {
                await deleteDB(STORES.TRANSACTIONS, parseInt(txIdInput));
            } catch (err) {
                alert("Could not delete transaction: " + (err && err.message ? err.message : err));
                return;
            }
            closeModal("txModal");
            renderApp();
        }

        // Populates the Year filter with only years that actually have a transaction, plus the
        // current year (so it's always available to default to). Preserves the user's current
        // selection across re-renders; only defaults to the current year on first load.
        let yearFilterInitialized = false;
        function populateYearFilterOptions(txs) {
            const select = document.getElementById("filterYear");
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

            if (!yearFilterInitialized) {
                select.value = String(currentYear);
                yearFilterInitialized = true;
            } else if (prevValue === "all" || sortedYears.map(String).includes(prevValue)) {
                select.value = prevValue;
            } else {
                select.value = "all";
            }
        }

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

            return { accounts, txs, nativeBalances };
        }

        // --- CONSOLIDATED RENDER ENGINE ---
        async function renderApp() {
            const { accounts, txs, nativeBalances } = await computeAccountBalances();
            populateYearFilterOptions(txs);
            const filterM = document.getElementById("filterMonth").value;
            const filterY = document.getElementById("filterYear").value;

            document.getElementById("currentBasePill").textContent = baseCurrency;

            let globalBaseNetWorth = 0;
            const currencyTotals = {}; // native (unconverted) sum per currency actually held, across every account
            accounts.forEach(a => {
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

            // "Net Worth by Member" rows (replaces the old single "Net Worth by Currency Held"
            // row, v34): one row per member (their solo-owned accounts only), one row per distinct
            // joint-owned account group, and — only if any exist — one row for unassigned accounts,
            // so the breakdown always ties out to the grand total above.
            renderMemberNetWorthRows(accounts, nativeBalances);
            renderRecentTransactionsWidget(accounts, txs);

            // --- Fixed Deposit maturity reminders ---
            // FD terms now live on the individual deposit transaction (each "placement"), not the
            // account itself — an FD account can hold several tranches, each maturing separately.
            // Placements the user has already renewed or withdrawn are flagged fdResolved and
            // dropped from this scan so the reminder clears once acted upon.
            const todayMs = new Date(new Date().toISOString().split("T")[0] + "T00:00:00").getTime();
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
                            <span>${overdue ? '⏰' : '🔔'} ${formatCurrency(t.amount, t.currency)} placement in "${escapeHtml(holdingAccount.name)}" ${label} — plan renewal or withdrawal.</span>
                            <span style="font-size:1.1rem;">›</span>
                        </div>
                    `;
                }
            });
            document.getElementById("fdReminderContainer").innerHTML = reminderHTML;

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
            } else {
                yearNavEl.style.display = "none";
            }

            // "+" quick-add FAB (v34) — only on a specific account's own Activity page.
            document.querySelector("#page-ledger .fab-btn").style.display = showFullAccountHistory ? "flex" : "none";
            closeLedgerQuickAddSheet();

            // Current Balance banner (v34) — the account's actual up-to-date balance, shown
            // regardless of which year is currently selected (unlike Balance B/F & C/F below,
            // which are specific to the selected year's boundaries).
            const balanceBanner = document.getElementById("ledgerCurrentBalanceBanner");
            if (showFullAccountHistory) {
                const viewingAcc = accounts.find(a => a.id === activeLedgerAccountView);
                if (viewingAcc) {
                    let balSummary;
                    if (viewingAcc.type === "fd" || viewingAcc.type === "multi" || viewingAcc.type === "unittrust") {
                        const baskets = nativeBalances[viewingAcc.id];
                        const currencies = Object.keys(baskets);
                        balSummary = currencies.length === 0
                            ? "No funds yet"
                            : currencies.map(curr => formatBalanceHTML(baskets[curr], curr)).join(" + ");
                    } else {
                        balSummary = formatBalanceHTML(nativeBalances[viewingAcc.id], viewingAcc.currency);
                    }
                    document.getElementById("ledgerCurrentBalanceValue").innerHTML = balSummary;
                    balanceBanner.style.display = "block";
                } else {
                    balanceBanner.style.display = "none";
                }
            } else {
                balanceBanner.style.display = "none";
            }

            // Fund Holdings section (Unit Trust accounts only) — shown above the normal
            // transaction ledger list, which still displays every Buy/Sell/Dividend/Contribution
            // as an ordinary-looking entry (they ARE ordinary transfer/income transactions under
            // the hood, just tagged with a fundId — see saveFundTransaction()).
            const fundSection = document.getElementById("fundHoldingsSection");
            if (showFullAccountHistory) {
                const viewingAcc2 = accounts.find(a => a.id === activeLedgerAccountView);
                if (viewingAcc2 && viewingAcc2.type === "unittrust") {
                    fundSection.style.display = "block";
                    await renderFundHoldingsTable(viewingAcc2.id, txs);
                } else {
                    fundSection.style.display = "none";
                }
            } else {
                fundSection.style.display = "none";
            }

            // Compute structural titles
            if (activeCategoryView !== "all") {
                const icon = getCategoryIcon(activeCategoryView);
                document.getElementById("ledgerTargetTitle").textContent = `${icon} ${activeCategoryView.toUpperCase()}`;
                document.getElementById("ledgerTargetEditBtn").style.display = "none";
            } else if (directTypeView !== "all") {
                document.getElementById("ledgerTargetTitle").textContent = `All ${directTypeView.charAt(0).toUpperCase() + directTypeView.slice(1)} Log`;
                document.getElementById("ledgerTargetEditBtn").style.display = "none";
            } else if (activeLedgerAccountView === "all") {
                document.getElementById("ledgerTargetTitle").textContent = "Portfolio General Log";
                document.getElementById("ledgerTargetEditBtn").style.display = "none";
            } else {
                const currentActiveAccName = accounts.find(a => a.id === activeLedgerAccountView)?.name || "Vault";
                document.getElementById("ledgerTargetTitle").textContent = `${currentActiveAccName} Activity`;
                document.getElementById("ledgerTargetEditBtn").style.display = "inline-block";
            }

            let incBaseTotal = 0, expBaseTotal = 0;
            let catSummary = { income: {}, expense: {} };
            
            // Prime fallback and custom categories
            const currentIncomeCategories = [...new Set([...dynamicCategories.filter(c => c.type === "income").map(c => c.name), "Salary", "Investments", "Freelance", "Other Income"])];
            const currentExpenseCategories = [...new Set([...dynamicCategories.filter(c => c.type === "expense").map(c => c.name), "Groceries", "Dining Out", "Utilities", "Rent", "Commute", "Entertainment", "Other Expenses"])];

            currentIncomeCategories.forEach(c => catSummary.income[c] = 0);
            currentExpenseCategories.forEach(c => catSummary.expense[c] = 0);

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

            // The dashboard's month/year filter is meant to scope PERIOD-based reporting — the
            // Total Income/Expenses stat boxes above, and the category/type breakdowns drilled into
            // via navigateToCategoryPage()/navigateToDirectTypePage() (which were themselves built
            // from that same filtered breakdown, so staying filtered there is consistent). It was
            // also being applied to the per-ACCOUNT ledger view, which is wrong: that page's whole
            // job is to show the complete history behind the account's balance (itself computed
            // above from the FULL unfiltered transaction set), so filtering it by month/year meant
            // the visible list and the balance could never be reconciled — a transaction dated
            // outside the selected period still counted toward the balance but silently vanished
            // from the list, with no indication anything was hidden. Viewing a specific account
            // (activeLedgerAccountView !== "all") now always shows its full history regardless of
            // the dashboard filter (scoped to one year at a time via the year nav above); category/
            // type views keep the previous filtered behaviour.

            txs.sort((a,b) => new Date(b.date) - new Date(a.date)).forEach(t => {
                const d = new Date(t.date);
                const withinPeriodFilter = (filterM === "all" || d.getMonth().toString() === filterM) && (filterY === "all" || d.getFullYear().toString() === filterY);
                if (!withinPeriodFilter && !showFullAccountHistory) return;

                const tBase = convertTxAmountToBase(t, accounts);

                if (withinPeriodFilter) {
                    if (t.type === "income") { 
                        incBaseTotal += tBase; 
                        if(catSummary.income[t.cat] !== undefined) catSummary.income[t.cat] += tBase;
                        else catSummary.income[t.cat] = tBase;
                    }
                    if (t.type === "expense") { 
                        expBaseTotal += tBase; 
                        if(catSummary.expense[t.cat] !== undefined) catSummary.expense[t.cat] += tBase;
                        else catSummary.expense[t.cat] = tBase;
                    }
                }

                let isBound = false;
                if (activeCategoryView !== "all") {
                    isBound = t.cat === activeCategoryView;
                } else if (directTypeView !== "all") {
                    isBound = t.type === directTypeView;
                } else if (activeLedgerAccountView !== "all") {
                    // Year-scoped Account Activity view (v33) — only this account's transactions
                    // dated within the currently selected year (accountLedgerYear).
                    isBound = (t.src === activeLedgerAccountView || t.dest === activeLedgerAccountView)
                        && (accountLedgerYear === null || d.getFullYear() === accountLedgerYear);
                } else {
                    isBound = true;
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
                const iconBadge = t.type === "transfer" ? "🔄" : getCategoryIcon(t.cat, t.type);
                const receiptBadge = t.image
                    ? `<span data-click="openImageViewer" data-image="${escapeHtml(t.image)}" style="cursor:pointer; margin-left:4px;" title="View attached photo">📎</span>`
                    : '';
                const referenceText = t.fdReferenceNo ? ` · Ref: ${escapeHtml(t.fdReferenceNo)}` : '';
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
                let displayAmountHTML = `${sgn}${formatCurrency(t.amount, t.currency)}`;
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
                const accountName = id => { const a = accounts.find(acc => acc.id === id); return a ? escapeHtml(a.name) : "(deleted account)"; };
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
                        fdStatusBadge = `<span style="font-size:0.62rem; font-weight:700; color:#64748b; background:#e2e8f0; padding:1px 5px; border-radius:4px; margin-left:6px; white-space:nowrap;">✅ Closed</span>`;
                    } else {
                        const isOverdue = new Date(t.fdMaturityDate + "T00:00:00").getTime() < new Date(new Date().toISOString().split("T")[0] + "T00:00:00").getTime();
                        fdStatusBadge = isOverdue
                            ? `<span style="font-size:0.62rem; font-weight:700; color:#b91c1c; background:#fee2e2; padding:1px 5px; border-radius:4px; margin-left:6px; white-space:nowrap;">⏰ Due</span>`
                            : `<span style="font-size:0.62rem; font-weight:700; color:#15803d; background:#dcfce7; padding:1px 5px; border-radius:4px; margin-left:6px; white-space:nowrap;">🟢 Active</span>`;
                    }
                }

                ledgerHTML += `
                    <div class="ledger-item" data-click="openTransactionForm" data-type="${t.type}" data-id="${escapeHtml(t.id)}">
                        <div class="item-left">
                            <span class="item-name">${iconBadge} ${escapeHtml(t.desc)}${fdStatusBadge}${manualFxBadge}</span>
                            <span class="item-meta">${t.date} [${escapeHtml(t.cat || 'Transfer')}]${referenceText}${receiptBadge}</span>
                            <span class="item-meta" style="display:block; margin-top:2px; color:var(--text-muted);">${accountText}</span>
                        </div>
                        <div class="item-right">
                            <div class="item-value" style="color:var(--${col}); font-weight: bold;">
                                ${displayAmountHTML}
                                ${sub}
                            </div>
                        </div>
                    </div>
                `;
            });

            if (matchedCount > ledgerRenderLimit) {
                const remaining = matchedCount - ledgerRenderLimit;
                ledgerHTML += `
                    <button type="button" class="submit-btn" style="background:#e2e8f0; color:var(--text-main); margin:12px;" data-click="loadMoreLedgerRows">
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

            document.getElementById("reportIncome").textContent = formatCurrency(incBaseTotal, baseCurrency);
            document.getElementById("reportExpense").textContent = formatCurrency(expBaseTotal, baseCurrency);
            const savings = incBaseTotal - expBaseTotal;
            document.getElementById("reportSavings").textContent = formatCurrency(savings, baseCurrency);
            document.getElementById("savingsBanner").style.background = savings >= 0 ? "#f0fdf4" : "#fef2f2";

            document.getElementById("ledgerList").innerHTML = ledgerHTML || '<p style="padding:20px; text-align:center; color:var(--text-muted); font-size:0.8rem;">No matches found.</p>';

            // The Net Savings Statement page has its own independent "All Years / Year" filter
            // (not the dashboard's month+year filter above), so it's rendered by a dedicated
            // function rather than sharing catSummary computed with filterM/filterY.
            await renderSavingsStatement();

            calculateStorageMetrics();
        }

        // Populates the Net Savings Statement's own Year filter — independent of the dashboard's
        // filterMonth/filterYear selects. Mirrors populateYearFilterOptions' behaviour (only years
        // that actually have a transaction, plus the current year; preserves selection across
        // re-renders; defaults to "All Years" on first load).
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

        async function renderSavingsStatement() {
            const txs = await readAllDB(STORES.TRANSACTIONS);
            const accounts = await readAllDB(STORES.ACCOUNTS);
            populateSavingsYearFilterOptions(txs);
            const filterY = document.getElementById("savingsYearFilter").value;

            const currentIncomeCategories = [...new Set([...dynamicCategories.filter(c => c.type === "income").map(c => c.name), "Salary", "Investments", "Freelance", "Other Income"])];
            const currentExpenseCategories = [...new Set([...dynamicCategories.filter(c => c.type === "expense").map(c => c.name), "Groceries", "Dining Out", "Utilities", "Rent", "Commute", "Entertainment", "Other Expenses"])];

            const catSummary = { income: {}, expense: {} };
            currentIncomeCategories.forEach(c => catSummary.income[c] = 0);
            currentExpenseCategories.forEach(c => catSummary.expense[c] = 0);

            let incBaseTotal = 0, expBaseTotal = 0;
            txs.forEach(t => {
                if (filterY !== "all" && new Date(t.date).getFullYear().toString() !== filterY) return;

                const tBase = convertTxAmountToBase(t, accounts);
                if (t.type === "income") {
                    incBaseTotal += tBase;
                    catSummary.income[t.cat] = (catSummary.income[t.cat] || 0) + tBase;
                }
                if (t.type === "expense") {
                    expBaseTotal += tBase;
                    catSummary.expense[t.cat] = (catSummary.expense[t.cat] || 0) + tBase;
                }
            });

            let incRowsHTML = "";
            Object.keys(catSummary.income).sort((a, b) => a.localeCompare(b)).forEach(c => {
                const val = catSummary.income[c];
                if (Math.abs(val) < SAVINGS_ZERO_EPS) return;
                const icon = getCategoryIcon(c, "income");
                incRowsHTML += `
                    <div class="statement-row" data-click="navigateToCategoryPage" data-category="${escapeHtml(c)}" data-back="savings">
                        <strong>${icon} ${escapeHtml(c)}</strong>
                        <span style="color: var(--income-color); font-weight:700;">+${formatCurrency(val, baseCurrency)}</span>
                    </div>
                `;
            });
            document.getElementById("savingsIncomeRows").innerHTML = incRowsHTML || '<p style="font-size:0.75rem; color:var(--text-muted);">No income entries logged.</p>';
            document.getElementById("savingsIncomeTotal").textContent = `+${formatCurrency(Math.abs(incBaseTotal) < SAVINGS_ZERO_EPS ? 0 : incBaseTotal, baseCurrency)}`;

            let expRowsHTML = "";
            Object.keys(catSummary.expense).sort((a, b) => a.localeCompare(b)).forEach(c => {
                const val = catSummary.expense[c];
                if (Math.abs(val) < SAVINGS_ZERO_EPS) return;
                const icon = getCategoryIcon(c, "expense");
                expRowsHTML += `
                    <div class="statement-row" data-click="navigateToCategoryPage" data-category="${escapeHtml(c)}" data-back="savings">
                        <strong>${icon} ${escapeHtml(c)}</strong>
                        <span style="color: var(--expense-color); font-weight:700;">-${formatCurrency(val, baseCurrency)}</span>
                    </div>
                `;
            });
            document.getElementById("savingsExpenseRows").innerHTML = expRowsHTML || '<p style="font-size:0.75rem; color:var(--text-muted);">No expense entries logged.</p>';
            document.getElementById("savingsExpenseTotal").textContent = `-${formatCurrency(Math.abs(expBaseTotal) < SAVINGS_ZERO_EPS ? 0 : expBaseTotal, baseCurrency)}`;

            const statementDiff = incBaseTotal - expBaseTotal;
            document.getElementById("savingsSurplusLabel").textContent = statementDiff >= 0 ? "Surplus Margin (Savings):" : "Deficit (Shortfall Margin):";
            document.getElementById("savingsSurplusValue").textContent = formatCurrency(statementDiff, baseCurrency);
            document.getElementById("savingsSurplusValue").style.color = statementDiff >= 0 ? "var(--income-color)" : "var(--expense-color)";
        }

        // --- SPENDING / INCOME BREAKDOWN PAGES (moved out of dashboard + Income Breakdown added, v32) ---

        // Small fixed palette, cycled by category index, used by the bar/donut chart views.
        const BREAKDOWN_CHART_COLORS = ["#6366f1", "#f97316", "#10b981", "#ef4444", "#0ea5e9", "#eab308", "#a855f7", "#14b8a6", "#ec4899", "#84cc16", "#64748b", "#f43f5e"];

        // Builds the shared "List" view (category rows with a % progress bar) — the same markup
        // the old dashboard Spending Breakdown used, now reused by both breakdown pages.
        function buildBreakdownListHTML(entries, total, type) {
            if (entries.length === 0) return '<p style="font-size: 0.75rem; text-align: center; color: var(--text-muted);">Nothing categorised yet.</p>';
            return entries.map(e => {
                const pct = total > 0 ? ((e.value / total) * 100).toFixed(0) : 0;
                const icon = getCategoryIcon(e.label, type);
                return `
                    <div class="category-row-item" data-click="navigateToCategoryPage" data-category="${escapeHtml(e.label)}" style="font-size:0.75rem; margin-top:4px;">
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
        // simple pie/donut in raw SVG. A separate color-coded legend accompanies it since slice
        // labels don't fit cleanly inside thin donut segments.
        function buildBreakdownDonutSVG(entries, total) {
            if (entries.length === 0 || total <= 0) return "";
            const size = 200, r = 70, cx = size / 2, cy = size / 2, circumference = 2 * Math.PI * r;
            let offset = 0;
            let segments = "";
            entries.forEach(e => {
                const frac = e.value / total;
                const dash = frac * circumference;
                segments += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${e.color}" stroke-width="28" stroke-dasharray="${dash.toFixed(2)} ${(circumference - dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"></circle>`;
                offset += dash;
            });
            const legend = entries.map(e => {
                const pct = total > 0 ? ((e.value / total) * 100).toFixed(0) : 0;
                return `<div style="display:flex; align-items:center; gap:6px; font-size:0.7rem; margin-bottom:4px;">
                    <span style="width:10px; height:10px; border-radius:50%; background:${e.color}; flex-shrink:0;"></span>
                    <span style="flex:1;">${escapeHtml(e.label)}</span>
                    <span style="color:var(--text-muted);">${pct}%</span>
                </div>`;
            }).join("");
            return `
                <div style="display:flex; flex-wrap:wrap; gap:16px; align-items:center; justify-content:center;">
                    <svg viewBox="0 0 ${size} ${size}" style="width:180px; height:180px; flex-shrink:0;">${segments}</svg>
                    <div style="min-width:140px; flex:1;">${legend}</div>
                </div>
            `;
        }

        function renderBreakdownChart(wrapId, chartType, entries, total, type) {
            const wrap = document.getElementById(wrapId);
            if (chartType === "bar") wrap.innerHTML = buildBreakdownBarSVG(entries);
            else if (chartType === "donut") wrap.innerHTML = buildBreakdownDonutSVG(entries, total);
            else wrap.innerHTML = ""; // "list" view has no separate chart — the list rows are the whole view
        }

        // Fills a breakdown page's "Member" filter dropdown with every member. "All Members"
        // (default) includes everyone plus joint accounts; picking one member restricts to that
        // member's solo-owned accounts only (joint accounts are excluded), per spec.
        function populateBreakdownMemberFilter(selectId) {
            const select = document.getElementById(selectId);
            const prevValue = select.value || "all";
            select.innerHTML = `<option value="all">All Members (everyone, incl. joint)</option>` +
                membersCache.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join("");
            select.value = membersCache.some(m => m.id === prevValue) ? prevValue : "all";
        }

        // Returns the set of account IDs solo-owned by a given member — used to scope the
        // Spending/Income Breakdown pages when a specific member is selected.
        function accountIdsForMember(accounts, memberId) {
            return new Set(accounts.filter(a => Array.isArray(a.memberIds) && a.memberIds.length === 1 && a.memberIds[0] === memberId).map(a => a.id));
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
            const memberAccountIds = filterMember !== "all" ? accountIdsForMember(accounts, filterMember) : null;

            const catTotals = {};
            let total = 0;
            txs.forEach(t => {
                if (t.type !== "expense") return;
                if (memberAccountIds && !memberAccountIds.has(t.src)) return;
                const d = new Date(t.date);
                if (filterM !== "all" && d.getMonth().toString() !== filterM) return;
                if (filterY !== "all" && d.getFullYear().toString() !== filterY) return;
                const tBase = convertTxAmountToBase(t, accounts);
                const cat = t.cat || "Other Expenses";
                catTotals[cat] = (catTotals[cat] || 0) + tBase;
                total += tBase;
            });

            const entries = Object.keys(catTotals)
                .filter(c => catTotals[c] > 0)
                .sort((a, b) => catTotals[b] - catTotals[a])
                .map((c, i) => ({ label: c, value: catTotals[c], color: BREAKDOWN_CHART_COLORS[i % BREAKDOWN_CHART_COLORS.length] }));

            document.getElementById("spendingBreakdownTotal").textContent = formatCurrency(total, baseCurrency);
            renderBreakdownChart("spendingBreakdownChartWrap", chartType, entries, total, "expense");
            document.getElementById("spendingBreakdownList").innerHTML = buildBreakdownListHTML(entries, total, "expense");
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
            const memberAccountIds = filterMember !== "all" ? accountIdsForMember(accounts, filterMember) : null;

            const catTotals = {};
            let total = 0;
            txs.forEach(t => {
                if (t.type !== "income") return;
                if (memberAccountIds && !memberAccountIds.has(t.src)) return;
                const d = new Date(t.date);
                if (filterM !== "all" && d.getMonth().toString() !== filterM) return;
                if (filterY !== "all" && d.getFullYear().toString() !== filterY) return;
                const tBase = convertTxAmountToBase(t, accounts);
                const cat = t.cat || "Other Income";
                catTotals[cat] = (catTotals[cat] || 0) + tBase;
                total += tBase;
            });

            const entries = Object.keys(catTotals)
                .filter(c => catTotals[c] > 0)
                .sort((a, b) => catTotals[b] - catTotals[a])
                .map((c, i) => ({ label: c, value: catTotals[c], color: BREAKDOWN_CHART_COLORS[i % BREAKDOWN_CHART_COLORS.length] }));

            document.getElementById("incomeBreakdownTotal").textContent = formatCurrency(total, baseCurrency);
            renderBreakdownChart("incomeBreakdownChartWrap", chartType, entries, total, "income");
            document.getElementById("incomeBreakdownList").innerHTML = buildBreakdownListHTML(entries, total, "income");
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

            const storedRecentTxType = await readKeyDB("settings", "recentTxTypeFilter");
            if (storedRecentTxType) recentTxTypeFilter = storedRecentTxType.value || "both";

            const storedRecentTxAccount = await readKeyDB("settings", "recentTxAccountFilter");
            if (storedRecentTxAccount) recentTxAccountFilter = storedRecentTxAccount.value || "all";

            const storedRecentTxCount = await readKeyDB("settings", "recentTxCount");
            if (storedRecentTxCount) recentTxCount = storedRecentTxCount.value || 5;

            await syncAndLoadCategories();
            await ensureDefaultCategories();

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

        async function exportBackup() {
            const bundle = {
                accounts: await readAllDB(STORES.ACCOUNTS),
                transactions: await readAllDB(STORES.TRANSACTIONS),
                categories: await readAllDB(STORES.CATEGORIES),
                members: await readAllDB(STORES.MEMBERS),
                funds: await readAllDB(STORES.FUNDS),
                baseCurrency: baseCurrency,
                fxRates: fxRates
            };

            const toggle = document.getElementById("exportEncryptToggle");
            const wantsEncryption = toggle ? toggle.checked : true; // encrypted-by-default

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
            a.href = url; a.download = `ledger_backup_${new Date().toISOString().split('T')[0]}${filenameSuffix}.json`;
            a.click(); URL.revokeObjectURL(url);
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

                    await syncAndLoadCategories();
                    await loadMembersCache();
                    renderSidebarMembers();
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
            sidebarGo: (el) => sidebarGo(el),
            handleSetupPasscodeSubmit: () => handleSetupPasscodeSubmit(),
            handleUnlockSubmit: () => handleUnlockSubmit(),
            handleForgotPasscode: () => handleForgotPasscode(),
            openCurrencyConfig: () => openCurrencyConfig(),
            lockAppNow: () => lockAppNow(),
            navigateToSavingsPage: () => navigateToSavingsPage(),
            navigateToAccountsPage: () => navigateToAccountsPage(),
            navigateToCategoriesPage: () => navigateToCategoriesPage(),
            navigateToBackupPage: () => navigateToBackupPage(),
            navigateToAllLedgerPage: () => navigateToAllLedgerPage(),
            navigateToDataSecurityPage: () => navigateToDataSecurityPage(),
            navigateToMembersPage: () => navigateToMembersPage(),
            sidebarGoMember: (el) => sidebarGoMember(el),
            openMemberFormModal: () => openMemberFormModal(),
            handleCreateMemberMobile: () => handleCreateMemberMobile(),
            deleteMemberFromForm: () => deleteMemberFromForm(),
            editMember: (el) => editMember(el.dataset.id),
            openAddAccountForMember: () => openAddAccountForMember(),
            toggleRecentTxSettings: () => toggleRecentTxSettings(),
            selectMemberColor: (el) => selectMemberColor(el),
            toggleMemberPageCurrencyBreakdown: () => toggleMemberPageCurrencyBreakdown(),
            ledgerYearPrev: () => ledgerYearPrev(),
            ledgerYearNext: () => ledgerYearNext(),
            toggleLedgerQuickAddSheet: () => toggleLedgerQuickAddSheet(),
            closeLedgerQuickAddSheet: () => closeLedgerQuickAddSheet(),
            quickAddChooseType: (el) => quickAddChooseType(el),
            openAccountFormModal: () => openAccountFormModal(),
            openCategoryFormModal: () => openCategoryFormModal(),
            deleteAccountFromForm: () => deleteAccountFromForm(),
            editAccountFromLedgerHeader: () => editAccountFromLedgerHeader(),
            exportBackup: () => exportBackup(),
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
            openGalleryInput: () => document.getElementById("txGalleryInput").click(),
            removeTxImage: () => removeTxImage(),
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
            openResolveFdModal: (el) => openResolveFdModal(Number(el.dataset.id)),
            navigateToLedgerPage: (el) => navigateToLedgerPage(el.dataset.id, el.dataset.back || "workspace"),
            openImageViewer: (el, e) => openImageViewer(el.dataset.image, e),
            deleteTxFromEditModal: () => deleteTxFromEditModal(),
            navigateToCategoryPage: (el) => navigateToCategoryPage(el.dataset.category, el.dataset.back || "workspace"),
            numpadDigit: (el) => numpadDigit(el.dataset.digit),
            numpadBackspace: () => numpadBackspace(),
            numpadClear: () => numpadClear(),
            openAddFundModal: () => openAddFundModal(),
            openAddFundTxModal: () => openAddFundTxModal(),
            editFund: (el) => editFund(el.dataset.id),
            handleSaveFund: () => handleSaveFund(),
            handleDeleteFund: () => handleDeleteFund(),
            handleSaveFundTx: () => handleSaveFundTx(),
            handleDeleteFundTxFromModal: () => handleDeleteFundTxFromModal(),
        };

        const CHANGE_ACTIONS = {
            resetLedgerPageAndRender: () => { ledgerRenderLimit = LEDGER_PAGE_SIZE; renderApp(); },
            importBackup: (el, e) => importBackup(e),
            handleExportEncryptToggleChange: () => handleExportEncryptToggleChange(),
            handleBiometricToggleChange: () => handleBiometricToggleChange(),
            handleBaseCurrencyChange: () => handleBaseCurrencyChange(),
            recalcTxFdMaturity: () => recalcTxFdMaturity(),
            syncTransactionCurrency: () => syncTransactionCurrency(),
            handleTxImageSelected: (el, e) => handleTxImageSelected(e),
            recalcResolveFdMaturity: () => recalcResolveFdMaturity(),
            recalcFdOpeningRowMaturity: (el) => recalcFdOpeningRowMaturity(el.dataset.rowId),
            handleAutoLockChange: () => handleAutoLockChange(),
            saveDefaultCategories: () => saveDefaultCategories(),
            saveDefaultPaymentAccount: () => saveDefaultPaymentAccount(),
            toggleTxFdDescMode: () => toggleTxFdDescMode(),
            resetSavingsPageAndRender: () => renderSavingsStatement(),
            toggleTxManualFx: () => toggleTxManualFx(),
            recalcTxManualFxPreview: () => recalcTxManualFxPreview(),
            renderSpendingBreakdownPage: () => renderSpendingBreakdownPage(),
            renderIncomeBreakdownPage: () => renderIncomeBreakdownPage(),
            toggleTxTransferFx: () => toggleTxTransferFx(),
            handleRecentTxSettingChange: () => handleRecentTxSettingChange(),
            ledgerYearSelectChange: () => ledgerYearSelectChange(),
            handleAccGroupChange: () => handleAccGroupChange(),
            handleFundTxTypeChange: () => handleFundTxTypeChange(),
            handleFundTxFundChange: () => handleFundTxFundChange(),
        };

        const INPUT_ACTIONS = {
            recalcTxFdMaturity: () => { recalcTxFdMaturity(); syncTransferFxOnAmountChange(); },
            recalcResolveFdMaturity: () => recalcResolveFdMaturity(),
            recalcFdOpeningRowMaturity: (el) => recalcFdOpeningRowMaturity(el.dataset.rowId),
            recalcTxManualFxPreview: () => recalcTxManualFxPreview(),
            recalcTransferFxFromRate: () => recalcTransferFxFromRate(),
            recalcTransferFxFromDestAmount: () => recalcTransferFxFromDestAmount(),
            recalcFundTxTotal: () => recalcFundTxTotal(),
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

        window.addEventListener("load", bootstrap);

        // Register the Service Worker for offline support. Only works when served over http(s)
        // (e.g. GitHub Pages) — silently does nothing when opened as a local file:// page.
        if ("serviceWorker" in navigator && (location.protocol === "https:" || location.protocol === "http:")) {
            window.addEventListener("load", () => {
                navigator.serviceWorker.register("./sw.js").catch((err) => {
                    console.warn("Service worker registration failed:", err);
                });
            });
        }
