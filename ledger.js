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
        const APP_VERSION = "v13";
        const APP_VERSION_DATE = "2026-08-08";

        // Runs immediately as this script executes (it's the last element in <body>, so the
        // DOM — including #versionBadge and the lock overlay — already exists by this point).
        // Deliberately NOT inside bootstrap() or the "load" listener: those gate on the app
        // being unlocked, and this badge needs to show before that.
        const versionBadgeEl = document.getElementById("versionBadge");
        if (versionBadgeEl) versionBadgeEl.textContent = `${APP_VERSION} · ${APP_VERSION_DATE}`;

        const DB_NAME = "EnterpriseMultiCurrencyLedgerDB_v4";
        const DB_VERSION = 2;
        const STORES = { ACCOUNTS: "accounts", TRANSACTIONS: "transactions", SETTINGS: "settings", CATEGORIES: "categories" };
        // Maps each object store to the field IndexedDB uses as its keyPath. That field must stay
        // unencrypted on the stored record (IndexedDB needs to read it directly to index/generate keys);
        // every other field on the record is encrypted as a single AES-GCM blob.
        const STORE_KEYPATHS = { accounts: "id", transactions: "id", settings: "key", categories: "id" };
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

        // Re-locks the app immediately: drops the in-memory key/passcode and reloads, which forces
        // the unlock screen again and guarantees no decrypted data lingers in memory or on screen.
        function lockAppNow() {
            appKey = null;
            currentPasscode = null;
            location.reload();
        }

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

        /* ================= BIOMETRIC QUICK UNLOCK (WebAuthn platform authenticator) =================
           WebAuthn doesn't hand us a reusable encryption key, so this isn't a second independent
           encryption path — it's a convenience layer on top of the same passcode: the passcode is
           wrapped with a non-extractable AES-GCM key that lives only in this browser's IndexedDB (so
           script can't read the raw key material out of it), and unwrapping it is gated behind a
           fingerprint/Face unlock prompt. The passcode itself remains the only way to derive the real
           data-encryption key, so it's still required as a fallback and after "Forgot passcode". Needs
           a secure context (https://) and a platform authenticator (e.g. Android fingerprint) — quietly
           unavailable otherwise (plain file:// or an unsupported browser). */
        const SECURITY_DB_NAME = "LedgerSecurityDB_v1";

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
                const req = tx.objectStore("security").get("biometric");
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            }));
        }

        // Registers a platform-authenticator (fingerprint/Face) credential, then wraps the current
        // passcode behind a non-extractable AES-GCM key gated by it.
        async function enableBiometricUnlock(passcode) {
            const challenge = crypto.getRandomValues(new Uint8Array(32));
            const userId = crypto.getRandomValues(new Uint8Array(16));
            const credential = await navigator.credentials.create({
                publicKey: {
                    challenge,
                    rp: { name: "Ledger" },
                    user: { id: userId, name: "ledger-local-user", displayName: "Ledger" },
                    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
                    authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
                    timeout: 60000,
                    attestation: "none"
                }
            });
            const wrappingKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
            const { iv, data } = await aesEncryptString(wrappingKey, passcode);
            const secDb = await openSecurityDB();
            await new Promise((resolve, reject) => {
                const tx = secDb.transaction(["security"], "readwrite");
                tx.objectStore("security").put({ key: "biometric", credentialId: bufToB64(credential.rawId), wrappingKey, iv, data });
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }

        async function disableBiometricUnlock() {
            const secDb = await openSecurityDB();
            await new Promise((resolve, reject) => {
                const tx = secDb.transaction(["security"], "readwrite");
                tx.objectStore("security").delete("biometric");
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        }

        // Prompts fingerprint/Face, unwraps the passcode, then derives the real app key from it
        // exactly like manual passcode entry does. Returns true/false — never throws, so callers can
        // silently fall back to the passcode input on cancel/failure.
        async function attemptBiometricUnlock() {
            try {
                const record = await getBiometricRecord();
                if (!record) return false;

                const assertion = await navigator.credentials.get({
                    publicKey: {
                        challenge: crypto.getRandomValues(new Uint8Array(32)),
                        allowCredentials: [{ id: b64ToBuf(record.credentialId), type: "public-key" }],
                        userVerification: "required",
                        timeout: 60000
                    }
                });
                if (!assertion) return false;

                const passcode = await aesDecryptString(record.wrappingKey, record.iv, record.data);
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
        let ledgerBackToPage = "workspace"; 

        // Pagination for the transaction list — avoids rendering thousands of DOM rows at once.
        let ledgerRenderLimit = 50;
        const LEDGER_PAGE_SIZE = 50;

        // Holds the compressed base64 image (if any) currently attached in the open transaction form.
        let currentTxImageData = null;

        let baseCurrency = "USD";
        let fxRates = { USD: 1.0, EUR: 0.92, GBP: 0.78, SGD: 1.34, MYR: 4.42 };
        const currencySymbols = { USD: "$", EUR: "€", GBP: "£", SGD: "S$", MYR: "RM" };
        
        // Dynamic category registry
        let dynamicCategories = [];

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
            groceries: "🍏",
            "dining out": "🍔",
            utilities: "🔌",
            rent: "🏠",
            commute: "🚌",
            entertainment: "🎬",
            "opening balance": "🏛️",
            "fixed deposit": "🏦",
            "interest income": "💰"
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

            const activeModals = ["txModal", "accountsModal", "currencyModal", "categoriesModal", "imageViewerModal", "resolveFdModal"];
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

            if (!ledgerPage.classList.contains("hidden")) {
                handleLedgerBackClick();
            } else if (!savingsPage.classList.contains("hidden")) {
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

        function formatCurrency(amount, curr) {
            const sym = currencySymbols[curr] || curr;
            return `${sym}${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        }

        function convertCurrency(amount, fromCurr, toCurr) {
            if (fromCurr === toCurr) return amount;
            return (amount / fxRates[fromCurr]) * fxRates[toCurr];
        }

        function openModal(id) { 
            document.getElementById(id).classList.add("active"); 
            pushVirtualState(id);
        }
        
        function closeModal(id) { 
            const el = document.getElementById(id);
            if (el && el.classList.contains("active")) {
                el.classList.remove("active");
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
        function navigateToLedgerPage(accountId) {
            activeLedgerAccountView = accountId;
            activeCategoryView = "all";
            directTypeView = "all";
            ledgerBackToPage = "workspace";
            ledgerRenderLimit = LEDGER_PAGE_SIZE;
            document.getElementById("page-workspace").classList.add("hidden");
            document.getElementById("page-savings").classList.add("hidden");
            document.getElementById("page-ledger").classList.remove("hidden");
            window.scrollTo(0,0);
            pushVirtualState("ledger");
            renderApp();
        }

        function navigateToCategoryPage(categoryName, backTarget = "workspace") {
            activeCategoryView = categoryName;
            activeLedgerAccountView = "all";
            directTypeView = "all";
            ledgerBackToPage = backTarget;
            ledgerRenderLimit = LEDGER_PAGE_SIZE;
            document.getElementById("page-workspace").classList.add("hidden");
            document.getElementById("page-savings").classList.add("hidden");
            document.getElementById("page-ledger").classList.remove("hidden");
            window.scrollTo(0,0);
            pushVirtualState("category_history");
            renderApp();
        }

        function navigateToDirectTypePage(type) {
            directTypeView = type;
            activeLedgerAccountView = "all";
            activeCategoryView = "all";
            ledgerBackToPage = "workspace";
            ledgerRenderLimit = LEDGER_PAGE_SIZE;
            document.getElementById("page-workspace").classList.add("hidden");
            document.getElementById("page-savings").classList.add("hidden");
            document.getElementById("page-ledger").classList.remove("hidden");
            window.scrollTo(0,0);
            pushVirtualState("ledger_type_filter");
            renderApp();
        }

        function navigateToSavingsPage() {
            document.getElementById("page-workspace").classList.add("hidden");
            document.getElementById("page-ledger").classList.add("hidden");
            document.getElementById("page-savings").classList.remove("hidden");
            window.scrollTo(0,0);
            pushVirtualState("savings");
            renderApp();
        }

        function navigateToWorkspace() {
            document.getElementById("page-ledger").classList.add("hidden");
            document.getElementById("page-savings").classList.add("hidden");
            document.getElementById("page-workspace").classList.remove("hidden");
            renderApp();
        }

        function handleLedgerBackClick() {
            if (ledgerBackToPage === "savings") {
                document.getElementById("page-ledger").classList.add("hidden");
                document.getElementById("page-savings").classList.remove("hidden");
            } else {
                navigateToWorkspace();
            }
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
            document.getElementById("baseCurrencySelect").value = baseCurrency;
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
        function openAccountsConfig() {
            const select = document.getElementById("newAccCurrency"); select.innerHTML = "";
            Object.keys(fxRates).forEach(c => { select.innerHTML += `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`; });
            
            select.value = baseCurrency;

            resetAccountForm();
            renderAccountSettingsList();
            openModal("accountsModal");
        }

        let multiOpeningRowCounter = 0;
        let fdOpeningRowCounter = 0;

        function setAccountTypeUI(type) {
            document.getElementById("newAccType").value = type;
            const normalBtn = document.getElementById("accTypeBtnNormal");
            const multiBtn = document.getElementById("accTypeBtnMulti");
            const fdBtn = document.getElementById("accTypeBtnFd");
            const balCurrRow = document.getElementById("newAccBalCurrRow");
            const multiWrap = document.getElementById("multiOpeningWrap");
            const fdWrap = document.getElementById("fdOpeningWrap");
            const hint = document.getElementById("accTypeHint");
            const isEditing = document.getElementById("editAccountId").value !== "";

            [normalBtn, multiBtn, fdBtn].forEach(btn => {
                btn.style.background = "#e2e8f0"; btn.style.color = "var(--text-main)";
            });

            balCurrRow.style.display = "none";
            multiWrap.style.display = "none";
            fdWrap.style.display = "none";

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

        function resetAccountForm() {
            const isEditing = document.getElementById("editAccountId").value !== "";
            document.getElementById("editAccountId").value = "";
            document.getElementById("newAccName").value = "";
            document.getElementById("newAccBal").value = "0";
            document.getElementById("newAccCurrency").value = baseCurrency;
            document.getElementById("accountFormHeaderTitle").textContent = "Create New Account";
            document.getElementById("accFormSubmitBtn").textContent = "Create Account";
            document.getElementById("accFormCancelBtn").style.display = "none";

            document.getElementById("multiOpeningRows").innerHTML = "";
            document.getElementById("fdOpeningRows").innerHTML = "";

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

            const record = { id, name, type };

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
            renderAccountSettingsList();
            renderApp();
        }

        async function renderAccountSettingsList() {
            const accounts = await readAllDB(STORES.ACCOUNTS);
            let html = "";
            accounts.forEach(a => {
                const typeBadge = a.type === "fd"
                    ? `<span style="font-size:0.65rem; padding:1px 4px; border-radius:4px; background:#ede9fe; color:#6d28d9; font-weight:bold;">Fixed Deposit</span>`
                    : a.type === "multi"
                        ? `<span style="font-size:0.65rem; padding:1px 4px; border-radius:4px; background:#e0f2fe; color:#0369a1; font-weight:bold;">Multi-Currency</span>`
                        : `<span style="font-size:0.65rem; padding:1px 4px; border-radius:4px; background:#e2e8f0; color:var(--text-muted); font-weight:bold;">${a.currency}</span>`;

                const balSummary = a.type === "fd" || a.type === "multi"
                    ? '<span style="color:var(--text-muted);">— balances shown in Accounts list</span>'
                    : `<span style="color:var(--text-muted);">${formatCurrency(a.initialBalance, a.currency)}</span>`;

                html += `
                    <div class="config-item">
                        <span style="cursor:pointer;" data-click="editAccount" data-id="${a.id}">
                            <strong>${escapeHtml(a.name)}</strong> ${typeBadge} - ${balSummary} 📝
                        </span>
                        <button class="trash-btn" data-click="removeAccount" data-id="${a.id}">🗑</button>
                    </div>`;
            });
            document.getElementById("accountConfigList").innerHTML = html;
        }

        async function editAccount(id) {
            const accounts = await readAllDB(STORES.ACCOUNTS);
            const account = accounts.find(a => a.id === id);
            if (!account) return;

            document.getElementById("editAccountId").value = account.id;
            document.getElementById("newAccName").value = account.name;

            setAccountTypeUI(account.type || "normal");
            if (!account.type || account.type === "normal") {
                document.getElementById("newAccBal").value = account.initialBalance;
                document.getElementById("newAccCurrency").value = account.currency;
            }

            document.getElementById("accountFormHeaderTitle").textContent = "Edit Account Credentials";
            document.getElementById("accFormSubmitBtn").textContent = "Save Changes";
            document.getElementById("accFormCancelBtn").style.display = "block";

            pushVirtualState("edit_account");
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
                await deleteDB(STORES.ACCOUNTS, id);
            } catch (err) {
                alert("Could not delete account: " + (err && err.message ? err.message : err));
                return;
            }

            if (activeLedgerAccountView === id) activeLedgerAccountView = "all";
            resetAccountForm();
            renderAccountSettingsList();
            renderApp();
        }

        // --- CATEGORIES SYSTEM WORKSPACE DESIGNER ---
        function openCategoriesConfig() {
            document.getElementById("catLabelName").value = "";
            document.getElementById("catSelectedEmoji").value = "🍔";
            document.getElementById("currentSelectedEmojiBadge").textContent = "🍔";
            buildEmojiSelectionPanel();
            renderCategoriesManagerList();
            openModal("categoriesModal");
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

            if (name.toLowerCase() === "others") {
                alert("The keyword 'Others' is protected.");
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
            renderCategoriesManagerList();
            renderApp();
        }

        async function renderCategoriesManagerList() {
            const listContainer = document.getElementById("categoriesConfigList");
            listContainer.innerHTML = "";
            
            dynamicCategories.forEach(c => {
                const item = document.createElement("div");
                item.className = "config-item";
                item.innerHTML = `
                    <span class="category-display-badge">
                        <span>${c.icon}</span> 
                        <strong>${escapeHtml(c.name)}</strong> 
                        <span style="font-size:0.65rem; padding:1px 4px; border-radius:4px; background:#e2e8f0; text-transform:uppercase; font-weight:bold;">${c.type}</span>
                    </span>
                    <button class="trash-btn" data-click="removeCategory" data-id="${c.id}">🗑</button>
                `;
                listContainer.appendChild(item);
            });
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
            renderCategoriesManagerList();
            renderApp();
        }

        async function syncAndLoadCategories() {
            const customCats = await readAllDB(STORES.CATEGORIES);
            dynamicCategories = customCats;
        }

        // --- TRANSACTION CREATION / EDITOR CORE ---
        async function openTransactionForm(type, existingTxId = null) {
            const accounts = await readAllDB(STORES.ACCOUNTS);
            if(accounts.length === 0) { alert("Add an account first!"); return; }

            const srcSelect = document.getElementById("srcAccount"); srcSelect.innerHTML = "";
            const destSelect = document.getElementById("destAccount"); destSelect.innerHTML = "";
            const currSelect = document.getElementById("txCurrency"); currSelect.innerHTML = "";
            const catSelect = document.getElementById("txCategory"); catSelect.innerHTML = "";

            Object.keys(fxRates).forEach(c => { currSelect.innerHTML += `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`; });
            accounts.forEach(a => {
                const prefix = a.type === "fd" ? "🏦 " : a.type === "multi" ? "💱 " : "";
                const currLabel = (a.type === "multi" || a.type === "fd") ? "" : ` (${a.currency})`;
                srcSelect.innerHTML += `<option value="${a.id}">${prefix}${escapeHtml(a.name)}${currLabel}</option>`;
                destSelect.innerHTML += `<option value="${a.id}">${prefix}${escapeHtml(a.name)}${currLabel}</option>`;
            });

            if (existingTxId !== null) {
                const txs = await readAllDB(STORES.TRANSACTIONS);
                const tx = txs.find(t => t.id === existingTxId);
                if (!tx) return;

                document.getElementById("txId").value = tx.id;
                document.getElementById("txType").value = tx.type;
                document.getElementById("txDesc").value = tx.desc;
                document.getElementById("txAmount").value = tx.amount;
                document.getElementById("txCurrency").value = tx.currency;
                document.getElementById("srcAccount").value = tx.src;
                document.getElementById("destAccount").value = tx.dest || "";
                document.getElementById("txDate").value = tx.date;

                const currentCats = dynamicCategories.filter(c => c.type === tx.type).map(c => c.name);
                const fallbackGroup = tx.type === "income" ? ["Salary", "Investments", "Freelance", "Others"] : ["Groceries", "Dining Out", "Utilities", "Rent", "Commute", "Entertainment", "Others"];
                
                const uniqueMerged = [...new Set([...currentCats, ...fallbackGroup])];
                uniqueMerged.forEach(c => {
                    const icon = getCategoryIcon(c, tx.type);
                    catSelect.innerHTML += `<option value="${escapeHtml(c)}">${icon} ${escapeHtml(c)}</option>`;
                });
                
                document.getElementById("txCategory").value = tx.cat || "";
                document.getElementById("destAccRow").style.display = tx.type === "transfer" ? "block" : "none";
                document.getElementById("categoryRow").style.display = tx.type === "transfer" ? "none" : "block";

                document.getElementById("txModalTitle").textContent = "Edit Ledger Entry";
                document.getElementById("txSubmitBtn").textContent = "Save Changes";

                setTxImagePreview(tx.image || null);

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

                document.getElementById("destAccRow").style.display = type === "transfer" ? "block" : "none";
                document.getElementById("categoryRow").style.display = type === "transfer" ? "none" : "block";

                const currentCats = dynamicCategories.filter(c => c.type === type).map(c => c.name);
                const fallbackGroup = type === "income" ? ["Salary", "Investments", "Freelance", "Others"] : ["Groceries", "Dining Out", "Utilities", "Rent", "Commute", "Entertainment", "Others"];
                
                const uniqueMerged = [...new Set([...currentCats, ...fallbackGroup])];
                uniqueMerged.forEach(c => {
                    const icon = getCategoryIcon(c, type);
                    catSelect.innerHTML += `<option value="${escapeHtml(c)}">${icon} ${escapeHtml(c)}</option>`;
                });

                document.getElementById("txModalTitle").textContent = "Log Ledger Item";
                document.getElementById("txSubmitBtn").textContent = "Commit Entry";

                setTxImagePreview(null);

                document.getElementById("txFdReference").value = "";
                document.getElementById("txFdStartDate").value = "";
                document.getElementById("txFdTenureMonths").value = "12";
                document.getElementById("txFdInterestRate").value = "3.0";
                document.getElementById("txFdMaturityDate").value = "";
                document.getElementById("txFdMaturityPreview").textContent = "";

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
                const prefix = a.type === "fd" ? "🏦 " : a.type === "multi" ? "💱 " : "";
                const currLabel = (a.type === "multi" || a.type === "fd") ? "" : ` (${a.currency})`;
                return `<option value="${a.id}">${prefix}${escapeHtml(a.name)}${currLabel}</option>`;
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
            const desc = document.getElementById("txDesc").value.trim();
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

            const record = {
                type: document.getElementById("txType").value,
                desc: desc,
                amount: parsedAmount,
                src: document.getElementById("srcAccount").value,
                dest: document.getElementById("destAccount").value,
                currency: document.getElementById("txCurrency").value,
                cat: document.getElementById("txCategory").value,
                date: dateVal,
                image: currentTxImageData || null,
                fdReferenceNo: null,
                fdStartDate: null,
                fdTenureMonths: null,
                fdInterestRate: null,
                fdMaturityDate: null
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

        async function deleteTx(id, event) {
            if (event) event.stopPropagation();
            const ok = await customConfirm("Delete this transaction item?");
            if (!ok) return;

            try {
                await deleteDB(STORES.TRANSACTIONS, id);
            } catch (err) {
                alert("Could not delete transaction: " + (err && err.message ? err.message : err));
                return;
            }
            renderApp();
        }

        // --- CONSOLIDATED RENDER ENGINE ---
        async function renderApp() {
            const accounts = await readAllDB(STORES.ACCOUNTS);
            const txs = await readAllDB(STORES.TRANSACTIONS);
            const filterM = document.getElementById("filterMonth").value;
            const filterY = document.getElementById("filterYear").value;

            document.getElementById("currentBasePill").textContent = baseCurrency;

            const nativeBalances = {};
            accounts.forEach(a => {
                nativeBalances[a.id] = (a.type === "multi" || a.type === "fd") ? {} : (a.initialBalance || 0);
            });

            // Applies a signed amount to an account's balance. "Normal" accounts are converted into
            // their one fixed currency (as before). Multi-Currency and Fixed Deposit accounts keep a
            // separate running balance per currency ("basket") — no conversion between baskets.
            function applyToAccountBalance(account, amount, currency, sign) {
                if (!account) return;
                if (account.type === "multi" || account.type === "fd") {
                    const basket = nativeBalances[account.id];
                    basket[currency] = (basket[currency] || 0) + sign * amount;
                } else {
                    nativeBalances[account.id] += sign * convertCurrency(amount, currency, account.currency);
                }
            }

            txs.forEach(t => {
                const aSrc = accounts.find(a => a.id === t.src);
                const aDest = accounts.find(a => a.id === t.dest);
                if (t.type === "income") applyToAccountBalance(aSrc, t.amount, t.currency, +1);
                if (t.type === "expense") applyToAccountBalance(aSrc, t.amount, t.currency, -1);
                if (t.type === "transfer") {
                    applyToAccountBalance(aSrc, t.amount, t.currency, -1);
                    applyToAccountBalance(aDest, t.amount, t.currency, +1);
                }
            });

            let globalBaseNetWorth = 0;
            accounts.forEach(a => {
                if (a.type === "multi" || a.type === "fd") {
                    Object.entries(nativeBalances[a.id]).forEach(([curr, amt]) => {
                        globalBaseNetWorth += convertCurrency(amt, curr, baseCurrency);
                    });
                } else {
                    globalBaseNetWorth += convertCurrency(nativeBalances[a.id], a.currency, baseCurrency);
                }
            });
            document.getElementById("netWorthDisplay").textContent = formatCurrency(globalBaseNetWorth, baseCurrency);

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
                        <div data-click="openResolveFdModal" data-id="${t.id}" style="cursor:pointer; background:${bg}; border:1px solid ${border}; color:${textCol}; border-radius:12px; padding:12px 14px; margin-bottom:8px; font-size:0.8rem; font-weight:600; display:flex; justify-content:space-between; align-items:center;">
                            <span>${overdue ? '⏰' : '🔔'} ${formatCurrency(t.amount, t.currency)} placement in "${holdingAccount.name}" ${label} — plan renewal or withdrawal.</span>
                            <span style="font-size:1.1rem;">›</span>
                        </div>
                    `;
                }
            });
            document.getElementById("fdReminderContainer").innerHTML = reminderHTML;

            let accListHTML = "";
            accounts.forEach(a => {
                if (a.type === "multi" || a.type === "fd") {
                    const baskets = nativeBalances[a.id];
                    const currencies = Object.keys(baskets);
                    const typeBadge = a.type === "fd"
                        ? `<span style="font-size:0.65rem; padding:1px 4px; border-radius:4px; background:#ede9fe; color:#6d28d9; font-weight:bold;">🏦 Fixed Deposit</span>`
                        : `<span style="font-size:0.65rem; padding:1px 4px; border-radius:4px; background:#e0f2fe; color:#0369a1; font-weight:bold;">💱 Multi-Currency</span>`;

                    const basketsHTML = currencies.length === 0
                        ? `<div style="font-size:0.75rem; color:var(--text-muted); padding-top:4px;">No funds yet — transfer in to get started</div>`
                        : currencies.map(curr => {
                            const amt = baskets[curr];
                            const conv = curr !== baseCurrency ? ` <span class="converted-subtext">≈ ${formatCurrency(convertCurrency(amt, curr, baseCurrency), baseCurrency)}</span>` : '';
                            return `<div style="display:flex; justify-content:space-between; font-size:0.82rem; padding:3px 0;"><span style="color:var(--text-muted); font-weight:600;">${curr}</span><span><strong>${formatCurrency(amt, curr)}</strong>${conv}</span></div>`;
                        }).join("");

                    accListHTML += `
                        <div class="account-list-row" style="flex-direction:column; align-items:stretch; cursor:pointer;" data-click="navigateToLedgerPage" data-id="${a.id}">
                            <div style="display:flex; justify-content:space-between; align-items:center;"><strong>${escapeHtml(a.name)}</strong>${typeBadge}</div>
                            ${basketsHTML}
                        </div>
                    `;
                } else {
                    const bal = nativeBalances[a.id];
                    const convText = a.currency !== baseCurrency ? `<span class="converted-subtext">≈ ${formatCurrency(convertCurrency(bal, a.currency, baseCurrency), baseCurrency)}</span>` : '';
                    accListHTML += `
                        <div class="account-list-row" data-click="navigateToLedgerPage" data-id="${a.id}">
                            <div><strong>${escapeHtml(a.name)}</strong> <span style="font-size:0.7rem; color:var(--text-muted); font-weight:bold; background:#e2e8f0; padding:2px 4px; border-radius:4px;">${a.currency}</span></div>
                            <div style="text-align:right;"><strong>${formatCurrency(bal, a.currency)}</strong>${convText}</div>
                        </div>
                    `;
                }
            });
            document.getElementById("accountsListView").innerHTML = accListHTML;

            // Compute structural titles
            if (activeCategoryView !== "all") {
                const icon = getCategoryIcon(activeCategoryView);
                document.getElementById("ledgerTargetTitle").textContent = `${icon} ${activeCategoryView.toUpperCase()}`;
            } else if (directTypeView !== "all") {
                document.getElementById("ledgerTargetTitle").textContent = `All ${directTypeView.charAt(0).toUpperCase() + directTypeView.slice(1)} Log`;
            } else if (activeLedgerAccountView === "all") {
                document.getElementById("ledgerTargetTitle").textContent = "Portfolio General Log";
            } else {
                const currentActiveAccName = accounts.find(a => a.id === activeLedgerAccountView)?.name || "Vault";
                document.getElementById("ledgerTargetTitle").textContent = `${currentActiveAccName} Activity`;
            }

            let incBaseTotal = 0, expBaseTotal = 0;
            let catSummary = { income: {}, expense: {} };
            
            // Prime fallback and custom categories
            const currentIncomeCategories = [...new Set([...dynamicCategories.filter(c => c.type === "income").map(c => c.name), "Salary", "Investments", "Freelance", "Others"])];
            const currentExpenseCategories = [...new Set([...dynamicCategories.filter(c => c.type === "expense").map(c => c.name), "Groceries", "Dining Out", "Utilities", "Rent", "Commute", "Entertainment", "Others"])];

            currentIncomeCategories.forEach(c => catSummary.income[c] = 0);
            currentExpenseCategories.forEach(c => catSummary.expense[c] = 0);

            let ledgerHTML = "";

            if (activeLedgerAccountView !== "all" && activeCategoryView === "all" && directTypeView === "all") {
                const viewingAcc = accounts.find(a => a.id === activeLedgerAccountView);
                if (viewingAcc && viewingAcc.type !== "multi" && viewingAcc.type !== "fd" && viewingAcc.initialBalance) {
                    const subText = viewingAcc.currency !== baseCurrency ? `<span class="converted-subtext">≈ ${formatCurrency(convertCurrency(viewingAcc.initialBalance, viewingAcc.currency, baseCurrency), baseCurrency)}</span>` : '';
                    ledgerHTML += `
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

            let matchedCount = 0;

            txs.sort((a,b) => new Date(b.date) - new Date(a.date)).forEach(t => {
                const d = new Date(t.date);
                if (filterM !== "all" && d.getMonth().toString() !== filterM) return;
                if (filterY !== "all" && d.getFullYear().toString() !== filterY) return;

                const tBase = convertCurrency(t.amount, t.currency, baseCurrency);
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

                let isBound = false;
                if (activeCategoryView !== "all") {
                    isBound = t.cat === activeCategoryView;
                } else if (directTypeView !== "all") {
                    isBound = t.type === directTypeView;
                } else {
                    isBound = activeLedgerAccountView === "all" || t.src === activeLedgerAccountView || t.dest === activeLedgerAccountView;
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
                    ? `<span data-click="openImageViewer" data-image="${t.image}" style="cursor:pointer; margin-left:4px;" title="View attached photo">📎</span>`
                    : '';
                const referenceText = t.fdReferenceNo ? ` · Ref: ${t.fdReferenceNo}` : '';

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
                    <div class="ledger-item" data-click="openTransactionForm" data-type="${t.type}" data-id="${t.id}">
                        <div class="item-left">
                            <span class="item-name">${iconBadge} ${escapeHtml(t.desc)} 📝${fdStatusBadge}</span>
                            <span class="item-meta">${t.date} [${t.cat || 'Transfer'}]${referenceText}${receiptBadge}</span>
                        </div>
                        <div class="item-right">
                            <div class="item-value" style="color:var(--${col}); font-weight: bold;">
                                ${sgn}${formatCurrency(t.amount, t.currency)}
                                ${sub}
                            </div>
                            <button class="trash-btn" data-click="deleteTx" data-id="${t.id}">🗑</button>
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

            document.getElementById("reportIncome").textContent = formatCurrency(incBaseTotal, baseCurrency);
            document.getElementById("reportExpense").textContent = formatCurrency(expBaseTotal, baseCurrency);
            const savings = incBaseTotal - expBaseTotal;
            document.getElementById("reportSavings").textContent = formatCurrency(savings, baseCurrency);
            document.getElementById("savingsBanner").style.background = savings >= 0 ? "#f0fdf4" : "#fef2f2";

            // Spending Breakdown rendering
            let catHTML = "";
            Object.keys(catSummary.expense).forEach(c => {
                const amount = catSummary.expense[c];
                if(amount === 0) return;
                const pct = expBaseTotal > 0 ? ((amount / expBaseTotal) * 100).toFixed(0) : 0;
                const icon = getCategoryIcon(c, "expense");
                catHTML += `
                    <div class="category-row-item" data-click="navigateToCategoryPage" data-category="${escapeHtml(c)}" style="font-size:0.75rem; margin-top:4px;">
                        <div style="display:flex; justify-content:space-between; margin-bottom: 2px;">
                            <strong>${icon} ${c.toUpperCase()}</strong>
                            <span>${formatCurrency(amount, baseCurrency)} (${pct}%)</span>
                        </div>
                        <div class="progress-bar-container"><div class="progress-bar-fill" style="width:${pct}%;"></div></div>
                    </div>
                `;
            });
            document.getElementById("categoryReportList").innerHTML = catHTML || '<p style="font-size: 0.75rem; text-align: center; color: var(--text-muted);">No spending categorised.</p>';
            document.getElementById("ledgerList").innerHTML = ledgerHTML || '<p style="padding:20px; text-align:center; color:var(--text-muted); font-size:0.8rem;">No matches found.</p>';

            // Balance Statement view rendering
            let incRowsHTML = "";
            Object.keys(catSummary.income).forEach(c => {
                const val = catSummary.income[c];
                const icon = getCategoryIcon(c, "income");
                incRowsHTML += `
                    <div class="statement-row" data-click="navigateToCategoryPage" data-category="${escapeHtml(c)}" data-back="savings">
                        <strong>${icon} ${escapeHtml(c)}</strong>
                        <span style="color: var(--income-color); font-weight:700;">+${formatCurrency(val, baseCurrency)}</span>
                    </div>
                `;
            });
            document.getElementById("savingsIncomeRows").innerHTML = incRowsHTML || '<p style="font-size:0.75rem; color:var(--text-muted);">No income entries logged.</p>';

            let expRowsHTML = "";
            Object.keys(catSummary.expense).forEach(c => {
                const val = catSummary.expense[c];
                const icon = getCategoryIcon(c, "expense");
                expRowsHTML += `
                    <div class="statement-row" data-click="navigateToCategoryPage" data-category="${escapeHtml(c)}" data-back="savings">
                        <strong>${icon} ${escapeHtml(c)}</strong>
                        <span style="color: var(--expense-color); font-weight:700;">-${formatCurrency(val, baseCurrency)}</span>
                    </div>
                `;
            });
            document.getElementById("savingsExpenseRows").innerHTML = expRowsHTML || '<p style="font-size:0.75rem; color:var(--text-muted);">No expense entries logged.</p>';

            const statementDiff = incBaseTotal - expBaseTotal;
            document.getElementById("savingsSurplusLabel").textContent = statementDiff >= 0 ? "Surplus Margin (Savings):" : "Deficit (Shortfall Margin):";
            document.getElementById("savingsSurplusValue").textContent = formatCurrency(statementDiff, baseCurrency);
            document.getElementById("savingsSurplusValue").style.color = statementDiff >= 0 ? "var(--income-color)" : "var(--expense-color)";

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

            await syncAndLoadCategories();

            const accs = await readAllDB(STORES.ACCOUNTS);
            if(accs.length === 0) {
                await writeDB(STORES.ACCOUNTS, { id: "usd_w", name: "US Dollar Wallet", initialBalance: 2500, currency: "USD", type: "normal" });
                await writeDB(STORES.ACCOUNTS, { id: "sgd_w", name: "DBS Singapore", initialBalance: 1200, currency: "SGD", type: "normal" });
                await writeDB(STORES.ACCOUNTS, { id: "myr_w", name: "Maybank Malaysia", initialBalance: 3400, currency: "MYR", type: "normal" });
            }
            
            window.history.replaceState({ view: "workspace" }, "");
            
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

        // One-time repair for accounts created before v14.0: opening balances, FD placements, and
        // renewal placements were mistakenly saved as "income" (and closures as "expense"), which
        // incorrectly inflated the Income/Expense reports. This finds those by their known
        // auto-generated description patterns and converts them to "transfer" — the same fix now
        // applied automatically to any new entries going forward. It never touches genuine income
        // or expense entries you logged yourself, and it's safe to run more than once.
        async function repairLegacyFdEntries() {
            const ok = await customConfirm("This will scan your transactions for opening balance / FD placement / renewal entries that were mistakenly counted as income or expense, and correct them to transfers. This does not change any account balances. Continue?");
            if (!ok) return;

            const txs = await readAllDB(STORES.TRANSACTIONS);
            const incomeLikePrefixes = ["Opening Balance", "Opening Fixed Deposit Placement", "FD Renewal Placement"];
            const expenseLikePrefix = "FD Placement Closed for Renewal";

            let fixedCount = 0;
            try {
                for (const t of txs) {
                    let changed = false;

                    if (t.type === "income" && incomeLikePrefixes.some(p => t.desc && t.desc.startsWith(p))) {
                        t.dest = t.src;
                        t.src = "";
                        t.type = "transfer";
                        changed = true;
                    } else if (t.type === "expense" && t.desc && t.desc.startsWith(expenseLikePrefix)) {
                        t.type = "transfer";
                        changed = true;
                    }

                    if (changed) {
                        await writeDB(STORES.TRANSACTIONS, t);
                        fixedCount++;
                    }
                }
            } catch (err) {
                alert("Repair stopped due to an error: " + (err && err.message ? err.message : err) + `. ${fixedCount} entr${fixedCount === 1 ? 'y was' : 'ies were'} fixed before the error.`);
                renderApp();
                return;
            }

            renderApp();
            alert(fixedCount > 0
                ? `Fixed ${fixedCount} entr${fixedCount === 1 ? 'y' : 'ies'}. They'll no longer be counted in your Income/Expense totals.`
                : "No legacy entries found — nothing needed fixing.");
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

                    if (bundle.baseCurrency) baseCurrency = bundle.baseCurrency;
                    if (bundle.fxRates) fxRates = bundle.fxRates;
                    await writeDB(STORES.SETTINGS, { key: "baseCurrency", value: baseCurrency });
                    await writeDB(STORES.SETTINGS, { key: "fxRates", value: fxRates });

                    for (const acc of bundle.accounts) await writeDB(STORES.ACCOUNTS, acc);
                    for (const tx of bundle.transactions) { delete tx.id; await writeDB(STORES.TRANSACTIONS, tx); }

                    if (bundle.categories) {
                        for (const cat of bundle.categories) await writeDB(STORES.CATEGORIES, cat);
                    }

                    await syncAndLoadCategories();
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
            handleSetupPasscodeSubmit: () => handleSetupPasscodeSubmit(),
            handleUnlockSubmit: () => handleUnlockSubmit(),
            handleForgotPasscode: () => handleForgotPasscode(),
            openCurrencyConfig: () => openCurrencyConfig(),
            lockAppNow: () => lockAppNow(),
            openCategoriesConfig: () => openCategoriesConfig(),
            navigateToSavingsPage: () => navigateToSavingsPage(),
            openAccountsConfig: () => openAccountsConfig(),
            exportBackup: () => exportBackup(),
            openImportInput: () => document.getElementById("importInput").click(),
            repairLegacyFdEntries: () => repairLegacyFdEntries(),
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
            navigateToLedgerPage: (el) => navigateToLedgerPage(el.dataset.id),
            openImageViewer: (el, e) => openImageViewer(el.dataset.image, e),
            deleteTx: (el, e) => deleteTx(Number(el.dataset.id), e),
            navigateToCategoryPage: (el) => navigateToCategoryPage(el.dataset.category, el.dataset.back || "workspace"),
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
        };

        const INPUT_ACTIONS = {
            recalcTxFdMaturity: () => recalcTxFdMaturity(),
            recalcResolveFdMaturity: () => recalcResolveFdMaturity(),
            recalcFdOpeningRowMaturity: (el) => recalcFdOpeningRowMaturity(el.dataset.rowId),
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
