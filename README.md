# My Ledger

Static, single-file-style PWA (IndexedDB-based, offline-first, no backend).
Deploy the contents of this folder as-is (e.g. to GitHub Pages).

## Files

```
index.html      ← page structure + styles + the CSP <meta> tag
ledger.js       ← all app logic (external file — see CSP notes in index.html <head>)
sw.js           ← Service Worker: offline caching (CACHE_NAME / ASSETS_TO_CACHE)
manifest.json   ← Web App Manifest (installable as a PWA)
icon-192.png / icon-512.png
lib/pdfjs-6.4.299/ ← vendored pdf.js 6.4.299: pdf.min.mjs + pdf.worker.min.mjs and
                  wasm/ (its image decoders: .wasm + plain-JS *_nowasm_fallback.js),
                  used by the transaction-attachment PDF viewer added in v121 —
                  no CDN dependency. The folder name carries the version on purpose
                  (v467, see below)
```

## Deploy checklist

- [ ] Push **`index.html` and `ledger.js` together** — the CSP requires app
      logic to live in the external `ledger.js`; if only `index.html` goes
      up, the page loads to a blank screen (it requests a file that isn't there).
- [ ] Push the **whole `lib/pdfjs-6.4.299/` folder** (`pdf.min.mjs`,
      `pdf.worker.min.mjs` and the `wasm/` subfolder) — without it, opening a
      PDF attachment fails, or a scanner PDF shows blank pages (the camera/
      image-attachment path is unaffected, only PDF preview needs these). Since
      v467 the old `lib/pdf.min.mjs`, `lib/pdf.worker.min.mjs` and `lib/wasm/`
      are no longer used — delete them from the repo.
- [ ] **Updating pdf.js:** take `build/pdf.min.mjs`, `build/pdf.worker.min.mjs`
      and the whole `wasm/` folder (including the `*_nowasm_fallback.js` files)
      from the SAME `pdfjs-dist` release, put them in a NEW folder
      `lib/pdfjs-<version>/`, and change the version in exactly two places:
      `PDFJS_DIR` in `ledger.js` and the five `./lib/pdfjs-…` lines in `sw.js`.
      Never overwrite the files of an existing versioned folder.
- [ ] Bump **both** version markers if you're shipping a change worth being
      able to identify at a glance — they do **not** sync automatically,
      since they live in different files:
  - `APP_VERSION` / `APP_VERSION_DATE` near the top of `ledger.js` — the
    display label shown in the small version badge, bottom-right of the
    screen (visible even on the lock screen, before the passcode is
    entered).
  - `CACHE_NAME` near the top of `sw.js` — controls which cached files the
    Service Worker actually serves. This is the one that matters for
    whether people actually get your new code; the badge is just a label.
  - Each file has a comment pointing at the other as a reminder.
- [ ] If `ledger.js` changed, make sure it's still listed in `sw.js`'s
      `ASSETS_TO_CACHE` (it should already be there — just checking nothing
      dropped it).
- [ ] Test via `http://localhost:PORT` (`python3 -m http.server 8000`), not
      by double-clicking `index.html` — the CSP's `'self'` checks behave
      differently under `file://` and can produce misleading failures that
      don't happen in real (`https://`) deployment.

## About the version badge

The badge only reflects what code **shipped** in this build — it's read
directly from the `ledger.js` that's currently running, so it can't tell
you whether the *browser* is actually running that latest `ledger.js` or a
stale cached copy.

**As of v217, `"./"` and `ledger.js` are served network-first (falling back
to cache only when offline) — see `NETWORK_FIRST_ASSETS` in `sw.js` — so a
normal reload while online should pick up a new deploy without any manual
cache-clearing.** Icons, `manifest.json`, and the vendored `lib/pdf.*`
files stay cache-first, since they essentially never change and there's no
reason to hit the network for them every load.

The one case that still needs a couple of extra reloads is the **version
transition that first introduces this network-first behavior** (i.e.
going from a pre-v217 Service Worker to v217+): whichever Service Worker
is still in control of the tab is the one whose fetch handler runs, so if
the *old*, cache-first SW hasn't finished installing/activating the new
one yet, a reload can still be served by the old logic. `skipWaiting()` +
`clients.claim()` (in `sw.js`'s `install`/`activate` handlers, present
since the original v211 scaffold) mean this resolves itself within a
reload or two, with no need to close tabs or clear site data — just
reload again if the badge still doesn't match right after a deploy.

If the badge *still* doesn't match after a couple of reloads, hard-refresh
(Ctrl/Cmd+Shift+R) or clear the site's Service Worker/cache in devtools —
that remains the fallback, just no longer the expected default.

## Security notes

See the CSP design-note comment at the top of `index.html`'s `<head>` for
the full reasoning behind the Content-Security-Policy, and the
`escapeHtml()` comment near the top of `ledger.js` for why user-entered
free text (account/category names, transaction descriptions, FD reference
numbers) must be passed through it before being inserted into the page via
`innerHTML`. As of v15 this is applied consistently at every such site —
an earlier v14 audit found four call sites (FD reminder banner, ledger row
category/reference text, spending breakdown header, receipt image
attribute) that skipped it, which was fixed in v15.

Note that `importBackup()` writes account/transaction/category records
from an imported JSON file directly into IndexedDB with no field
validation — the escaping above is what actually neutralizes a malicious
field in a tampered backup at render time, since nothing sanitizes it on
the way in. Keep that in mind before removing `escapeHtml()` from any of
these render paths, or before adding a new render path for one of these
fields.

## v16: idle auto-lock, numpad

- **Idle auto-lock** — ⏱️ dropdown in the header (Never/1/5/15/30 min,
  default 15). Resets on click/keydown/touch/scroll/mousemove (throttled
  to once/sec) while unlocked; calls `lockAppNow()` after the selected
  interval of inactivity. Setting is stored in `localStorage`
  (`ledgerAutoLockMinutesV1`), not the encrypted settings store, since
  it isn't sensitive and needs to be readable before unlock.
- **Number pad** on the unlock screen — appends/removes digits from the
  passcode field. Purely an input aid alongside the OS keyboard; passcodes
  remain free text (not digit-only), so non-numeric passcodes still work
  by typing normally. Numpad taps deliberately avoid focusing the field
  (and blur it if it was already focused), so using the numpad doesn't
  pop the mobile virtual keyboard up alongside it — tapping the field
  directly still opens the normal keyboard for anyone who'd rather type.

A client-side brute-force lockout (delay after repeated wrong passcodes)
was considered and built, then deliberately removed: for this app's
threat model it mostly punished the legitimate owner mistyping their own
passcode (no recovery besides a full wipe) while adding little real
resistance, since anyone with devtools access can call the underlying
crypto functions directly, bypassing any UI-layer lockout. PBKDF2's 250k
iterations remains the actual brute-force defense.

## v19: starter categories

Added `DEFAULT_CATEGORIES` (in `ledger.js`) — a starter set of income and
expense categories with icons, auto-provisioned on launch by
`ensureDefaultCategories()`:

- **Income:** Dividend ASNB 📈, Divident EPF 🏦, FD Interest 🏦, Bank
  Interest 💰, Gift Received 🎁, Rebate 💸, Grants 🎓
- **Expense:** Bank Charges 💳, Education 🎓, Family 👨‍👩‍👧‍👦, Beting 🎰,
  Clothing 👕, Gift Given 🎁, Subscription 📡, Tech Appliances 💻,
  Travelling ✈️, Tax 🧾, Offering 🙏

`ensureDefaultCategories()` runs every launch (right after
`syncAndLoadCategories()` in `bootstrap()`) but is idempotent: it reads
existing categories, skips any name that already exists (case-insensitive
match), and only inserts what's missing. So it's safe to run repeatedly —
it never overwrites or duplicates a category you've since renamed,
re-iconed, or deleted. Matching entries were also added to the
`fallbackIcons` map as a backstop, so the right icon still shows even if
one of these categories is later deleted from the Categories store while
old transactions still reference its name.

## v20: category sort, Betting rename, year range, cleanup

- **Categories now sort alphabetically.** `syncAndLoadCategories()` sorts
  `dynamicCategories` by name (locale-aware, case-insensitive) once on
  load, so the transaction-form category dropdown, the Categories
  manager list, and the income/expense report lists are all sorted
  automatically — each of those filters `dynamicCategories` by type
  without re-sorting, so they inherit the order.
- **"Beting" → "Betting".** `DEFAULT_CATEGORIES` and `fallbackIcons` were
  corrected to "Betting". `ensureDefaultCategories()` also does a
  one-time migration: if a category with the auto-seeded id `cat_beting`
  still has the name "Beting", it's renamed in place to "Betting" rather
  than left alongside a newly-inserted "Betting" entry — so v19 users
  don't end up with a duplicate. It only touches that specific
  auto-seeded record, never a category you've since renamed yourself.
- **Removed the "Fix Legacy FD/Opening Balance Entries" button** from
  the main page.
- **Year filter range** changed from All Years, 2024–2028 to All Years,
  2026–2036.

## v21: removed legacy FD repair function

`repairLegacyFdEntries()` and its `CLICK_ACTIONS` dispatch entry are now
fully deleted from `ledger.js` (v20 only removed the button; the
function and its console-callable path remained). If a pre-v14.0
account's opening balance / FD placement / renewal entries ever need
that repair again, restore the function from an earlier deploy zip
(v19 or v20) rather than re-adding a UI entry point for it.

## v22: dynamic year range, category sort carried forward

(No functional changes beyond v21 beyond the version bump baseline this
zip was built from — see the app's own in-file history for detail.)

## v23: default categories, "Others" rename, opening balance ordering,
current value row, FD description toggle, savings statement filters

- **Default Income/Expense category.** The Categories manager
  (🏷 Categories) now has a "Default Category" section with two
  dropdowns — Default Income Category / Default Expense Category.
  Selecting one persists it to the `settings` store
  (`defaultIncomeCategory` / `defaultExpenseCategory`) via
  `saveDefaultCategories()`. `openTransactionForm()` pre-selects that
  category on a brand-new Income/Expense entry (never when editing an
  existing transaction), only if the saved default still exists among
  the current category options.
- **"Others" → "Other Income" / "Other Expenses".** The implicit
  fallback category (never a real stored `categories` record — just a
  literal string merged into the dropdown/summary lists) is now
  type-specific: income entries see "Other Income", expense entries see
  "Other Expenses". Updated everywhere the old literal `"Others"`
  appeared (transaction form dropdown ×2, category summary ×2), the
  "protected keyword" guard in `handleCreateCategoryMobile()` (now
  blocks creating a category literally named "Other Income" or "Other
  Expenses"), and `fallbackIcons` (added `other income` / `other
  expenses`, kept legacy `others` for old data). Added a one-time
  migration `migrateOthersCategoryRename()` (runs after
  `ensureDefaultCategories()` on every launch, idempotent) that rewrites
  any existing transaction whose `cat` is still the literal string
  `"Others"` to the type-appropriate new name.
- **Opening Balance Setup moved to the bottom.** In the per-account
  ledger view, the "[Opening Balance Setup]" pseudo-entry is now built
  the same way as before but appended to `ledgerHTML` LAST, so it
  renders under every real transaction instead of pinned above them.
- **"Current Value" row.** The "My Financial Accounts" list on the
  dashboard now has a highlighted top row — "💰 Current Value" — showing
  the same total (`globalBaseNetWorth`, converted to base currency)
  as the header's Portfolio Net Worth figure, surfaced again at the top
  of the account list itself.
- **Fixed Deposit: optional manual Description.** The FD placement
  terms block (shown when depositing into a Fixed Deposit account) now
  has a "✏️ Manually fill Description" toggle, off by default. Off:
  the Description field is hidden and not required; on submit it's
  auto-filled from `buildAutoFdDescription()` — "Fixed Deposit Placement
  (<reference no.>)" if a reference was given, else just "Fixed Deposit
  Placement" — since the placement already has its own Account/Reference
  No. field. On: the Description field behaves as before (shown,
  required, free text). Editing an existing FD transaction always
  defaults the toggle to "manual" so an already-saved description stays
  visible rather than being hidden.
- **Net Savings Statement: own Year filter, hidden zero rows, totals.**
  The statement page now has its own "All Years / Year" dropdown
  (`#savingsYearFilter`, `populateSavingsYearFilterOptions()`) — fully
  independent of the dashboard's month+year filter, so switching the
  dashboard filter no longer affects this page and vice versa. Rendering
  moved into a dedicated `renderSavingsStatement()` (called at the end
  of `renderApp()` and whenever the new Year select changes). Category
  rows whose total is within `SAVINGS_ZERO_EPS` (0.005) of zero are
  hidden — this also absorbs FX-conversion rounding noise that could
  otherwise surface as a stray "-0.00" expense line. Added a "Total
  Income" / "Total Expenses" row under each category list
  (`#savingsIncomeTotal` / `#savingsExpenseTotal`).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v23 per the deploy checklist above, since both `index.html`
and `ledger.js` changed.

## v24: fixed a stray-account ledger bug, a back-button bug, added
default payment account

- **Bug: an Income/Expense entry could show up in an unrelated
  account's ledger too.** The "To Account" `<select>` is one shared
  element reused every time the transaction modal opens. It's only
  shown for Transfers — for Income/Expense it's hidden, but its value
  was never cleared, so it silently kept whatever account had last
  been picked for an earlier Transfer. That stale value got saved as
  the new Income/Expense record's `dest`, and the per-account ledger
  view matches on `t.src === account OR t.dest === account` — so the
  entry appeared a second time in whichever account happened to be
  left over in that hidden field, even though it had nothing to do
  with that account (and correctly did NOT affect that account's
  actual balance, since only Transfers touch `dest` when balances are
  computed — this is why the ledger list and the balance figure
  stopped matching). Fixed three ways: (1) `openTransactionForm()` now
  clears `destAccount` whenever a non-Transfer type is opened; (2)
  `handleTransactionSubmitMobile()` now forces `record.dest = null`
  for any non-Transfer save, regardless of what's sitting in the
  hidden field, as a second line of defense; (3) a one-time migration
  `migrateStaleDestFieldCleanup()` (runs on every launch, idempotent)
  nulls out `dest` on any already-saved non-Transfer transaction that
  has one, cleaning up historical data created before this fix.
- **Bug: closing a modal (Save/Cancel/X) could bounce you all the way
  back to the workspace instead of back to the page you were on** —
  e.g. editing a transaction from inside an account's ledger view,
  tapping Save, and landing on the dashboard instead of staying on
  that account's ledger. Root cause: `closeModal()` removed the
  modal's `active` class itself and THEN called `history.back()`. The
  `popstate` listener's own job is to look for a still-active modal
  and close it — but by the time it ran, the modal already looked
  closed, so it always concluded "no modal was open" and fell through
  to the page-level back logic instead (`handleLedgerBackClick()`,
  which exits the ledger page entirely). Fixed by having `closeModal()`
  only call `history.back()` — the `popstate` listener remains the
  single place that actually removes the `active` class, so it now
  correctly recognizes the modal it's closing and stops there.
- **Default Payment Account.** Manage Accounts (🧰 Manage) now has a
  "Default Payment Account" dropdown, persisted to the `settings`
  store (`defaultPaymentAccount`) via `saveDefaultPaymentAccount()`.
  `openTransactionForm()` pre-selects it in the Account field on a
  brand-new entry (never when editing), only if the saved default
  still exists.
- Confirmed the "💰 Current Value" row lives only in the dashboard's
  My Financial Accounts list (as added in v23) — it isn't duplicated
  anywhere on the per-account ledger/activity page, so there was
  nothing to remove there.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v24.

## v25: account ledger view no longer silently hides transactions
outside the dashboard's month/year filter

- **Bug: an account's Activity/ledger list could show fewer
  transactions than actually make up its balance.** The dashboard's
  "All Months / [Year]" filter was being applied not just to the
  Total Income/Expenses stat boxes (correct — that's period-based
  reporting), but also to the per-account ledger view opened by
  tapping an account row. If that filter wasn't set to "All Years",
  any transaction dated outside the selected period still counted
  toward the account's balance (which is always computed from the
  FULL unfiltered transaction history) but silently disappeared from
  that account's own Activity list — with the "[Opening Balance
  Setup]" row still shown unconditionally at the bottom regardless.
  So the visible list and the displayed balance could never be
  reconciled by eye, with no indication anything was being hidden.
  Fixed: viewing a specific account's ledger (tapping into e.g. "DBS
  Singapore Activity") now always shows that account's complete
  history regardless of the dashboard's month/year filter. Category
  and Type drill-down views (tapping a category/type breakdown row)
  intentionally keep the previous filtered behaviour, since those are
  launched from a breakdown that was itself computed for the selected
  period — staying scoped there is consistent, not a bug.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v25.

## v26: fixed Transfers silently getting a stray expense category,
and the dashboard losing its scroll position on back navigation

- **Bug: Transfer entries (Income/Expense to another account) could
  show a random expense category like "[Commute]"** even though
  Transfers have no category and that field is hidden on the form.
  Root cause: the Category `<select>` was always populated with the
  expense category list, including for Transfers — the code that
  built it only special-cased `type === "income"`, so `"transfer"`
  fell into the same branch as `"expense"`. A freshly-populated
  `<select>` auto-selects its first option, and "Commute" happens to
  sort alphabetically first among the default expense categories, so
  it silently became every new Transfer's hidden `cat` value — never
  visible in the form, only on the ledger afterward. Fixed three ways,
  matching the pattern used for the earlier stale-`dest` bug: (1)
  `openTransactionForm()` now skips populating the Category `<select>`
  entirely when the type is Transfer; (2)
  `handleTransactionSubmitMobile()` now forces `record.cat = null` for
  Transfers rather than trusting whatever the hidden field holds — with
  one carve-out: editing an existing Transfer that already legitimately
  carries `cat: "Fixed Deposit"` (set by the separate FD
  maturity-resolution flow, which writes its own records directly and
  was never affected by this bug) preserves that tag instead of wiping
  it on a routine edit; (3) a one-time migration
  `migrateStaleCategoryOnTransfersCleanup()` nulls out `cat` on any
  already-saved Transfer that has one, except `"Fixed Deposit"` for the
  same reason. Ledger rows with `cat: null` already correctly fall back
  to showing "[Transfer]" (`t.cat || 'Transfer'`), so no display-code
  change was needed there.
- **Bug: returning to the dashboard always landed at the very top,
  even if you'd scrolled down to "My Financial Accounts" before tapping
  into an account.** The workspace, ledger, and savings pages all share
  the browser's own window-level scroll (none of them has its own
  scrollable container) — entering a sub-page explicitly scrolls to the
  top (correct, so you start at the top of what you just opened), but
  nothing was restoring the dashboard's own previous scroll position
  when you came back to it. Fixed: `navigateToLedgerPage()`,
  `navigateToCategoryPage()` (only when its `backTarget` is the
  workspace, not the Savings statement), `navigateToDirectTypePage()`,
  and `navigateToSavingsPage()` now save `window.scrollY` into
  `workspaceScrollY` right before leaving the dashboard;
  `navigateToWorkspace()` is now `async` and, after `renderApp()`
  finishes rebuilding the dashboard's DOM, restores that saved
  position with `window.scrollTo(0, workspaceScrollY)`.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v26.

## v27: delete moved into the Edit Ledger Entry modal

- **Ledger rows no longer have their own edit-pencil/trash icons.**
  Tapping a transaction row still opens "Edit Ledger Entry" as before
  (that was never icon-dependent — the whole row is the tap target),
  but the row itself now only shows the description/category/amount;
  the `📝` pencil glyph and the per-row `🗑` trash button are gone.
  FD status badges (🟢 Active / ⏰ Due / ✅ Closed) are unaffected.
- **Delete now lives inside the Edit Ledger Entry modal.** A "🗑 Delete
  Entry" button appears under "Save Changes" — only when editing an
  existing entry (`openTransactionForm()` shows/hides `#txDeleteBtn`
  depending on whether an id was passed in; it's hidden for a
  brand-new entry, since there's nothing yet to delete). Wired to a
  new `deleteTxFromEditModal()`, which confirms, deletes by the id in
  the hidden `#txId` field, closes the modal, and re-renders — the
  same confirm-then-delete flow the old per-row button used, just
  relocated. The old `deleteTx(id, event)` (used only by the per-row
  button) was removed along with the button.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v27.

## v28: every ledger row now states which account it belongs to

- **Ledger rows show a 🏦 account line.** Added a third line under
  each ledger row's date/category, resolving `t.src`
  (Income/Expense — "🏦 Maybank Malaysia") or both legs of a Transfer
  ("🏦 Maybank Malaysia → DBS Singapore") by looking the id(s) up in
  `accounts`. Shown everywhere a ledger row renders — a single
  account's own Activity page (where a Transfer's *other* leg wasn't
  previously named at all, only "[Transfer]"), and combined views like
  a category or type breakdown (where multiple accounts can appear
  side by side with no way to tell them apart before this). Falls back
  to "(deleted account)" / "(unknown)" if an id no longer resolves,
  rather than showing a blank.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v28.

## v29: sidebar navigation drawer

- **Added a hamburger-menu sidebar.** A ☰ button now sits at the top
  of the dashboard header, opening a slide-in left drawer (with a
  dimmed backdrop, tap-outside-to-close) styled with a colored header
  block and grouped, icon-led nav items — modeled loosely after
  common finance-app patterns (a colored brand header, sectioned list,
  active-item highlight).
- **Drawer sections:** *Overview* (Dashboard, All Transactions, Net
  Savings Statement), *Manage* (Accounts, Categories, Currency & FX
  Rates), *Data & Security* (Backup & Restore, Lock App Now). These
  consolidate navigation and settings entry points that previously
  only lived as scattered buttons inside the dashboard page.
  "All Transactions" opens the existing ledger page unfiltered
  (`navigateToLedgerPage("all")`); Accounts/Categories/Currency open
  their existing modals directly, no page navigation required;
  Backup & Restore returns to the dashboard (if needed) and scrolls
  the existing export/import controls into view.
  **(Superseded by v30 below — Accounts/Categories/Backup became
  full pages, and Currency & FX Rates was removed from the drawer.)**
- **Active-item highlighting.** `updateSidebarActiveState()` marks
  whichever nav item matches the page currently on screen (Dashboard
  / All Transactions / Net Savings) each time the drawer opens, so it
  stays in sync even when a page switch happens from outside the
  sidebar (e.g. tapping a stat box on the dashboard).
- No storage schema, export/import, or CSP changes — purely additive
  UI (new CSS block, drawer markup, and 3 new CLICK_ACTIONS entries:
  `openSidebar`, `closeSidebar`, `sidebarGo`).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v29.

## v30: Accounts / Categories / Backup are now full pages

Follow-up to v29 — the sidebar's Accounts, Categories, and Backup &
Restore entries opened modals, not pages, so they didn't feel like
the rest of the app. They're now full pages built on the same
`showPage()` navigation pipeline as the dashboard/ledger/savings
pages (added centrally so future pages can't accidentally leave a
stale one visible underneath — every nav function now routes through
it, including `popstate`/back-button handling).

- **Accounts page** (`page-accounts`): the Default Payment Account
  selector plus a plain, tap-to-open list of every account — no
  inline add form. A floating **+** button (bottom-right) opens the
  account form in a modal, now titled "Add / Edit Account" instead
  of "Manage Accounts" since it's no longer where the list lives.
  Tapping an account name goes straight to that account's Activity
  page (`navigateToLedgerPage`, unchanged).
- **Account Activity page**: added a ✏️ icon beside the account name
  — shown only when viewing one specific account, not the "All
  Transactions"/category/type views — that reopens the Add/Edit
  Account modal pre-filled with that account's details. Added a
  **🗑 Delete Account** button inside that modal (only visible in
  edit mode) so deleting no longer requires going back to a list.
  Deleting the account currently being viewed now returns to the
  dashboard rather than leaving a stale/blank account page open.
- **Categories page** (`page-categories`): Default Income/Expense
  Category selectors, then every category split into 🟢 Income and
  🔴 Spending sections, each with its own 🗑 delete. A floating **+**
  button opens the "Add Category" modal (unchanged form/emoji
  picker), now stripped down to just that form.
- **Backup & Restore page** (`page-backup`): now holds the App Local
  Database footprint meter, Auto-lock setting (moved out of the
  dashboard header — it no longer needs its own compact header
  widget now that it has a page), Export/Import JSON, the backup
  encryption toggle, and the biometric quick-unlock toggle. All of
  these were removed from the dashboard page; auto-lock also removed
  from the header entirely.
- **Removed the sidebar's "Currency & FX Rates" item** — redundant
  with the header's currency pill, which already opens the same
  settings.
- Refactored account/category CRUD helpers (`removeAccount`,
  `removeCategory`, `handleCreateAccountMobile`,
  `handleCreateCategoryMobile`) to refresh whichever view is actually
  on screen (`refreshAfterAccountChange` / `refreshAfterCategoryChange`)
  instead of assuming the old single-modal-with-list layout.
- No storage schema or export/import format changes — this is UI
  restructuring only. Verified with `node --check` plus id/data-click/
  data-change cross-reference scripts (no missing ids, no unbound
  click/change handlers, no duplicate ids) after every edit.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v30.

## v31: persistent sidebar on tablet/desktop, dashboard net worth rework

- **Responsive sidebar.** Below 768px (phones) the sidebar is still
  the mobile slide-in drawer from v29 — hamburger button, dimmed
  backdrop, tap-outside-to-close. At 768px and up (tablet/desktop)
  it's pinned open as a permanent left column instead: hamburger and
  backdrop are hidden via a `@media (min-width: 768px)` block, the
  drawer's transform is forced off, and the page content shifts
  right (`body { margin-left: 336px }`) to sit beside it. No JS
  branching needed — it's the same drawer element and the same
  `.open` class logic underneath, CSS just overrides how it's shown.
  `updateSidebarActiveState()` is now called from `showPage()` itself
  (not only on drawer-open), since the desktop sidebar is never
  "opened" in the JS sense — this keeps the active-item highlight
  correct on every device either way.
- **Accounts → Activity now remembers where you came from.**
  `navigateToLedgerPage(accountId, backTarget)` takes an optional
  second argument; the Accounts page's rows pass `data-back="accounts"`
  so tapping ← Back from an account's Activity page returns to the
  Accounts list, not the dashboard. `handleLedgerBackClick()` grew a
  matching `"accounts"` branch alongside its existing `"savings"` one.
  Deleting an account from its Activity page's edit modal now also
  lands back on the Accounts page instead of the dashboard.
- **Sidebar restructuring:** "Categories" removed from the sidebar
  (the dashboard's own "🏷 Categories" quick-button already reaches
  the same page). "Accounts" renamed to "Financial Accounts" and
  moved out of the (now-empty, removed) "Manage" section into
  "Overview", directly under Dashboard.
- **Dashboard's "My Financial Accounts" list removed.** It's now
  redundant with the Financial Accounts page, which is one tap away
  in the sidebar on every device (and always visible on
  tablet/desktop). Its per-account balance computation didn't just
  disappear, though — pulled out into a shared `computeAccountBalances()`
  helper so both `renderApp()` (dashboard) and `renderAccountsPage()`
  use the same live, transaction-derived numbers. This also fixed a
  latent bug from v30: the Accounts page had been showing each
  account's `initialBalance` (opening balance) rather than its actual
  current balance after transactions.
- **Dashboard net worth is now two rows, not one.** Row 1 (unchanged,
  in the header) is the existing "Portfolio Net Worth" — everything
  converted into the selected base currency. Row 2 is new: "Net Worth
  by Currency Held" — the same total accounts, but summed *natively*
  per currency with no conversion (e.g. "USD $12,345" / "MYR
  RM45,000" as separate figures), so it's clear what's actually held
  in each currency versus what it's all worth blended together.
- No storage schema or export/import changes. Verified with
  `node --check` plus the id/data-click/data-change cross-reference
  script (0 missing, 0 dupes, 0 unbound handlers) after every edit.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v31.

## v32: Spending/Income Breakdown moved to sidebar with chart types, sidebar
restructuring, Auto-Lock/Database split out of Backup & Restore, manual FX
rate entry per transaction

- **Spending Breakdown moved off the dashboard.** The "Spending Breakdown"
  section (category list with % bars) is no longer on the main
  dashboard page. It's now its own page reached via the sidebar
  (**Reports → Spending Breakdown**), with its own independent
  Month/Year filter (doesn't affect or get affected by the
  dashboard's filter, same pattern as the Net Savings Statement).
- **New: Income Breakdown page.** Same treatment as Spending
  Breakdown, but for income categories — **Reports → Income
  Breakdown** in the sidebar.
- **Chart type selector.** Both breakdown pages have a "Chart Type"
  dropdown — *List* (the original bars + % rows), *Bar Chart* (a
  plain SVG vertical bar chart, no external library), or *Donut
  Chart* (SVG donut with a color-coded legend). Selection isn't
  persisted between visits (defaults to List each time) — this can
  be wired to `localStorage` in a follow-up if it turns out people
  want a sticky preference.
- **Sidebar restructuring:**
  - "Net Savings Statement" moved up to sit directly under
    "Dashboard" in the *Overview* section (was previously last).
  - New *Reports* section holding Spending Breakdown and Income
    Breakdown.
  - *Data & Security* section grew two entries — **Auto-Lock** and
    **App Local Database** — both split out of the Backup & Restore
    page into their own dedicated pages/sidebar items (see below).
    Order is now: Backup & Restore, Auto-Lock, App Local Database,
    Lock App Now.
- **Auto-Lock is now its own page** (`page-autolock`), holding just
  the "⏱️ Auto-lock after inactivity" selector that used to live in
  Backup & Restore's "Security" section. Functionally unchanged —
  same `<select id="autoLockSelect">`, same `handleAutoLockChange()`,
  same `localStorage` key.
- **App Local Database is now its own page** (`page-database`),
  holding the storage-footprint meter that used to live in Backup &
  Restore. Functionally unchanged — same `calculateStorageMetrics()`,
  now also called on navigating to this page directly (previously
  only ever triggered from `renderApp()`/`navigateToBackupPage()`).
  Backup & Restore's own "Security" section now holds only the
  biometric quick-unlock toggle; Export/Import is unchanged.
- **Manual FX rate entry per transaction.** Previously, spending or
  receiving a currency different from an account's own currency
  (e.g. logging an SGD expense against a MYR account) always
  silently converted using whatever the *live* Currency & FX Rates
  table says **at render time** — never a rate captured when the
  transaction was entered. That has two consequences worth being
  explicit about, since this shipped without a way to opt out of it
  until now: (1) the account balance contribution from that entry
  recalculates every time the app renders, using today's rate, not
  the rate on the transaction's date; (2) editing the global FX
  rate table later — for *any* reason — retroactively changes what
  every past cross-currency transaction is computed to have done to
  the account balance and to base-currency reports (Spending/Income
  Breakdown, Net Savings Statement, Portfolio Net Worth). Nothing
  was ever stored per-transaction to freeze this.
  This version adds an opt-in fix, scoped to Income/Expense entries
  against a single-currency ("normal") account, when the entry's
  currency differs from the account's currency (Transfers and
  Multi-Currency/Fixed-Deposit accounts are out of scope — see the
  comment on `updateTxManualFxVisibility()` for why). A new
  "✏️ Manually enter FX rate" toggle appears in the transaction form
  in that situation, off by default (auto: unchanged live-rate
  behaviour). Turning it on reveals a rate input (pre-filled with
  today's live rate as a starting point, editable), with a live
  preview of the converted amount that will hit the account. The
  rate is stored on the transaction as `manualFxRate` and, once
  saved, permanently overrides the live table for that specific
  entry's effect on the account balance — future changes to Currency
  & FX Rates no longer touch it. It also feeds into base-currency
  reporting (`convertTxAmountToBase()`): the tx-currency→account-
  currency leg uses the locked rate, then account-currency→base-
  currency still converts at the live rate (base-currency valuation
  remains a live snapshot; only the leg the user actually pinned —
  what the account itself received/paid — is frozen). Ledger rows
  for entries using this show a small "✏️ Manual FX" badge for
  transparency. Editing an existing entry preserves and pre-fills
  its manual rate if it has one.
- No IndexedDB schema/version changes (`manualFxRate` is just a new
  optional field on transaction records, `undefined`/`null` for all
  existing data — treated identically to "auto" throughout). No
  export/import format changes. Verified with `node --check` plus
  the id/data-click/data-change cross-reference script (0 missing,
  0 dupes, 0 unbound handlers) after every edit.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v32.

## v33: Manual conversion for cross-currency Transfers, Account Activity
year navigation with Balance B/F & C/F

- **Transfer conversion (S$ ⇄ MYR etc.).** Transfers between two
  single-currency accounts of different currencies previously always
  converted the sent amount into the destination account's currency
  using the *live* Currency & FX Rates table, recalculated on every
  render — nothing was stored. A new "🔁 Currency Conversion" block
  appears in the transaction form for exactly this situation (Transfer
  type, source and destination both "normal" accounts, currencies
  differ). Off by default (auto, unchanged live-rate behaviour).
  Turning it on offers two entry modes:
  - **Exchange Rate** — key in the rate; the amount received in the
    destination account's currency is calculated and previewed
    automatically.
  - **Amount Received** — key in the actual MYR (or other) amount
    that landed in the destination account; the effective rate is
    derived and previewed automatically.
  Whichever mode is used, the resulting received amount is stored on
  the transaction as `destAmount` and, once saved, is used directly
  for that transfer's effect on the destination account's balance —
  no further conversion, and immune to later changes in the FX rate
  table. `computeAccountBalances()`'s `applyToAccountBalance()` now
  takes an optional `directAmountOverride` for exactly this. Editing
  an existing transfer pre-fills from its stored `destAmount`. Ledger
  rows for the destination account now show the actual destination-
  currency figure (locked `destAmount`, or a live-converted "≈"
  estimate when auto) instead of the source-currency amount, which
  was confusing to read on the receiving account's own Activity page.
  A "✏️ Manual FX" badge marks transfers using a locked `destAmount`,
  same badge as the existing per-transaction manual FX feature.
- **Account Activity now pages by year.** Viewing a specific account
  (Financial Accounts → an account → its Activity page) now shows a
  "< YEAR >" control at the top. The `<`/`>` buttons only step between
  years that actually contain a transaction for that account — years
  with nothing logged are skipped entirely (e.g. from 2026 back to
  2020 in one click, if 2021–2025 are empty for that account).
  Defaults to the account's most recent year with data on first
  visit; the selection persists while editing entries and returning,
  and resets to "most recent" the next time the account is opened
  fresh via the sidebar/Financial Accounts list.
- **Balance B/F and Balance C/F rows.** For any year besides the
  account's very first year with data, a "↩️ Balance B/F" row now
  appears at the bottom of the list (below every real transaction for
  that year) showing the balance brought forward from the prior year
  with data. For any year besides the most recent, a "↪️ Balance C/F"
  row appears at the top showing the balance carried forward into the
  next year with data. The original "[Opening Balance Setup]" row
  still appears (bottom position) on the account's very first year
  with data — B/F and Opening Balance Setup never both show on the
  same year. Both new rows are computed with the same per-transaction
  conversion rules as the running balance itself (manual FX rate,
  transfer `destAmount`), via a new `computeAccountBalanceAsOf()`
  helper, so they always tie out exactly.
- No IndexedDB schema/version changes (`destAmount` is a new optional
  field on transfer records, `undefined`/`null` for all existing data
  and non-transfer types). No export/import format changes. Verified
  with `node --check` plus the id/data-click/data-change cross-
  reference script (0 missing, 0 dupes, 0 unbound handlers).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v33.

## v34: Lock screen Enter-key fix, "+" quick-add on Account Activity,
Current Balance banner, simplified two-way Transfer conversion fields

- **Lock screen: Enter key now always submits.** Neither the passcode
  setup fields nor the unlock field were ever wired to a keyboard
  Enter/Return — there's no `<form>` around them for the browser to
  submit implicitly, and no `keydown` listener existed anywhere in the
  app to catch it. That's why it could seem to work once and then stop:
  it never reliably worked at all. A single `keydown` listener,
  registered once at script load (so it survives the full page reload
  `lockAppNow()` does on every lock), now calls the same submit
  handler as the on-screen button whenever Enter is pressed in any of
  the three passcode fields (setup, confirm, unlock).
- **"+" quick-add on Account Activity.** A floating "+" button now
  appears on an account's own Activity page (only there — not on "All
  Transactions" or a category/type drill-down) and opens a small
  Income / Expense / Transfer picker. Whichever type is chosen opens
  the usual entry form with that account pre-selected as the source,
  via a new optional third argument on `openTransactionForm(type,
  existingTxId, presetSrcAccountId)`. Deliberately built as a plain
  show/hide popover rather than routed through the app's history-
  backed modal system (`openModal()`/`closeModal()`), since it only
  ever leads into `openTransactionForm()`, which already pushes its
  own history entry for `txModal` — avoiding a doubled-up back-button
  step.
- **Current Balance banner.** Account Activity now shows the
  account's actual up-to-date balance in a banner just below the nav
  header, visible regardless of which year is currently selected —
  distinct from Balance B/F and Balance C/F (v33), which are specific
  to the selected year's boundaries and only appear on some years.
  Multi-Currency/Fixed Deposit accounts show their per-currency
  basket totals here the same way the Financial Accounts list does.
- **Transfer currency conversion, simplified.** The "Enter By"
  mode dropdown from v33 is gone. Both fields — **Exchange Rate** and
  **Amount Received** — are now shown together whenever "✏️ Manually
  set conversion" is on; typing in either one recalculates the other
  automatically (`recalcTransferFxFromRate()` /
  `recalcTransferFxFromDestAmount()`), so entering the actual received
  amount (e.g. the real MYR credited for an S$ transfer) derives the
  effective rate on its own, with no mode to pick first. Changing the
  transaction's own Amount field while manual conversion is on also
  re-syncs Amount Received from whatever Rate is currently entered
  (`syncTransferFxOnAmountChange()`). Storage format (`destAmount` on
  the transaction) and everything downstream of it — account balance
  calculation, base-currency reporting, the ledger row display, the
  "✏️ Manual FX" badge — is unchanged from v33.
- No IndexedDB schema/version changes. No export/import format
  changes. Verified with `node --check` plus the id/data-click/data-
  change cross-reference script (0 missing, 0 dupes, 0 unbound
  handlers) after every edit.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v34.

## v35→v36: bug fix, EPF categories, deficit formatting, account groups,
## recent-transactions widget, sidebar reorg

- **Fixed: "X" close button on Edit Member did nothing.** Root cause —
  the app's modal-close mechanism (`closeModal()`) works by calling
  `history.back()` and letting the single `popstate` listener remove
  the `active` class; that listener only does this for modals listed
  in its `activeModals` array, and `memberModal` was never added to
  that list. So clicking X called `history.back()`, `popstate` fired,
  found nothing it recognized as an open modal, and fell through to
  page-level back navigation — leaving the modal visibly stuck open.
  Fixed by adding `memberModal` to `activeModals`. Also found (and
  fixed) two other spots — `handleCreateMemberMobile()` and
  `removeMember()` — that bypassed this mechanism entirely by calling
  `classList.remove("active")` directly instead of `closeModal()`,
  which left a stale, never-popped history entry behind (a latent bug
  that wouldn't misbehave immediately but could desync history on a
  later modal open/close). Same bypass fixed in `removeAccount()` for
  `accountsModal`. `imports/exports`/schema unaffected.
- **New income categories.** `EPF Contrib.(ER)` and `EPF Contrib.(EE)`
  added to `DEFAULT_CATEGORIES` (auto-provisioned for existing users
  via the existing idempotent `ensureDefaultCategories()`) and to
  `fallbackIcons`.
- **Deficit amounts shown in red brackets.** New `formatBalanceHTML()`
  helper: renders a negative balance as `(S$1,234.56)` in red
  (accounting convention) instead of `-S$1,234.56`, for any
  HTML-rendered balance-style figure. Applied to: dashboard Portfolio
  Net Worth, Net Worth by Member rows (solo/joint/unassigned), the
  member detail page's net worth figure and per-currency chips, the
  Financial Accounts list, a member's account list, and the Account
  Activity "Current Balance" banner. Plain transaction amounts
  (which already carry their own explicit +/− sign) are untouched —
  `formatCurrency()` itself is unchanged.
- **Account owner tag + quick "+ Add Account".** Every row in the
  Financial Accounts list now shows a small colored "● Name" tag per
  owner underneath it (or "Unassigned" in muted gray) via
  `accountOwnerTagHTML()`. A member's own Accounts page (Sidebar ▸ a
  member) gained a "+ Add Account" button that opens the Add Account
  modal with that member pre-checked as owner
  (`openAddAccountForMember()`).
- **Account Groups.** New `ACCOUNT_GROUPS` = Bank/Cash, Credit Card,
  Investment, Real Estate (`DEFAULT_ACCOUNT_GROUP` = Bank/Cash for
  older accounts saved before this existed). A Group selector was
  added to the Add/Edit Account modal and is persisted on the account
  record (`account.group`). Both the Financial Accounts page (now
  with group section headers) and a member's account list are sorted
  via the shared `sortAccountsByGroupThenName()` — group order first
  (per `ACCOUNT_GROUPS`), then name.
- **Dashboard "Recent Transactions" widget.** New section between
  Financial Report Card and "More": a short list of recent Income/
  Expense entries (Transfers are intentionally excluded — the filter
  is Expense/Income/Both, not Transfer), with a collapsible settings
  panel (⚙) controlling: Show (Income + Expense / Income Only /
  Expense Only), Account (All Accounts or one specific account), and
  Number of items (1–14). Settings persist across sessions via the
  SETTINGS store (`recentTxTypeFilter`, `recentTxAccountFilter`,
  `recentTxCount`, loaded in `bootstrap()`, default Both / All / 5).
- **Dashboard "More" row → icon-only, one row.** The three buttons
  (Financial Accounts, All Transactions, Data Security) dropped their
  text labels and now sit side-by-side as icon-only buttons
  (`title`/`aria-label` kept for accessibility/tooltips).
- **Sidebar reorganized.** "Financial Accounts" added under Dashboard
  in the Overview section; "Data Security" added as its own item at
  the very bottom of the sidebar (below Manage Members). Both remain
  reachable from the dashboard's "More" row too — this is additive,
  not a replacement. Both new sidebar entries close the sidebar drawer
  on tap, matching the existing "Manage Members" behavior.
- No IndexedDB schema/version changes (accounts simply gain an
  optional `group` field, defaulted wherever absent — no migration
  needed). No export/import format changes. Verified with
  `node --check` plus an id/data-click/data-change cross-reference
  (0 missing handlers, 0 duplicate ids) after every edit.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v36.

## v37: security fix — closed remaining unescaped-HTML gaps

- **Fixed: `a.currency` and `.id` fields could reach `innerHTML`
  unescaped.** A security review found four spots where an account's
  `currency` code was interpolated straight into `innerHTML` without
  `escapeHtml()` — the Financial Accounts page currency badge, the
  same badge on a member's account list, and the `currLabel` used in
  both the Transaction form's source/destination dropdowns and the
  FD-resolution dropdown. Thirteen more spots did the same with an
  account/transaction/member/category `.id` inside a `data-id="..."`
  or `<option value="...">` attribute. In normal use these fields are
  only ever set via fixed dropdowns or generated internally, so this
  wasn't reachable through the UI — but `importBackup()` writes
  parsed backup JSON straight into IndexedDB with no field
  validation, so a tampered `.json` backup could have set one of
  these fields to break out of an HTML attribute or inject markup
  (e.g. a `<style>` block, since `style-src` allows
  `'unsafe-inline'`). The CSP's `script-src 'self'` (no inline
  scripts/handlers) already blocked this from becoming actual JS
  execution, but it's now fixed properly: every one of those 17
  interpolations is wrapped in `escapeHtml()`, matching the pattern
  already used everywhere else `innerHTML` is built from data.
- No IndexedDB schema/import-export format changes — this is a
  rendering-only fix. Verified with `node --check` after every edit.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v37.

## v38: fixed installed-shortcut launch failure on Cloudflare Pages
(net::ERR_FAILED)

- **Root cause.** Cloudflare Pages 301/308-redirects `/index.html` →
  `/` by default (GitHub Pages doesn't do this). `manifest.json` had
  `start_url: "./index.html"`, so an installed desktop/mobile
  shortcut always relaunched at the literal `/index.html` URL. The
  service worker's install step ran `cache.addAll([..., "./index.html",
  ...])`, which silently followed Cloudflare's redirect and cached
  the result — but that cached `Response` has `redirected: true`
  baked in. Chrome refuses to answer a navigation with a redirected
  `Response`; it fails the whole load with exactly `net::ERR_FAILED`.
  The very first-ever load (before the service worker existed)
  followed the redirect normally at the network level and landed on
  `/`, so reloads in that same tab worked fine — but the installed
  shortcut always relaunches fresh at `/index.html`, hitting the
  poisoned cache entry every time.
- **Fix 1 — `manifest.json`:** `start_url` changed from
  `"./index.html"` to `"./"`, so installed shortcuts launch at the
  URL that doesn't get redirected.
- **Fix 2 — `sw.js`:** removed the redirect-vulnerable
  `"./index.html"` entry from `ASSETS_TO_CACHE`. The `fetch` handler
  now special-cases navigation requests (`event.request.mode ===
  "navigate"`) so they *always* resolve through the canonical `"./"`
  cache entry regardless of the exact URL requested — covers `/`,
  `/index.html`, or any other in-scope path an old bookmark/shortcut
  might still hit. If `"./"` itself isn't cached yet, it's fetched
  fresh; if that fetch's response ever comes back `redirected` (host
  misconfiguration), the handler falls back to cache instead of
  handing Chrome a redirected `Response`. Non-navigation requests
  (JS, JSON, icons) are unaffected — same cache-first-then-network
  logic as before.
- No IndexedDB schema/import-export format changes. Verified with
  `node --check` after every edit.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v38.

## v39: app rename, currency setup, member labels everywhere, year picker,
account sub-groups + totals, and a full Unit Trust account type

- **Renamed** "Enterprise Multi-Currency Ledger" → **"My Ledger"**
  (manifest.json `name`/`short_name`, `<title>`,
  `apple-mobile-web-app-title`).
- **Currency setup:** default `fxRates`/`baseCurrency` now cover the
  10 currencies actually held (MYR, SGD, USD, HKD, CNY, TWD, THB,
  KRW, JPY, BND), MYR as base. `mergeInDefaultCurrencies()` runs on
  every load and additively fills in any of these 10 an *existing*
  install doesn't already have — never touches a currency the user
  already customised. The base-currency `<select>` is now populated
  dynamically from `fxRates` (was a hardcoded 5-currency list).
- **Member names on every account picker**, not just the list
  screens: transfer source/destination, Default Payment Account,
  Recent Transactions account filter, FD-resolve destination, and
  the new fund-transaction transfer-account picker all now show
  `AccountName (Member1, Member2)` / `(Unassigned)` via new
  `accountOwnerNamesText()`/`accountOptionLabel()` helpers — fixes
  same-name accounts (e.g. two "KWSP (MYR)") being indistinguishable
  in a dropdown.
- **Year picker on account Activity pages:** the old plain
  "&lt; 2019 &gt;" label is now a `<select>` (`#ledgerYearLabel`)
  listing every year with data plus an **"All Years"** option
  (`accountLedgerYear = null`) showing the account's complete
  history on one page. Re-plumbed the "fresh view" vs "explicit
  All Years" state — was a `null` sentinel for both, now `"__fresh__"`
  vs `null` respectively, so picking "All Years" doesn't get
  silently reset back to the latest year on the next render.
- **Account Sub-Groups:** new `ACCOUNT_SUBGROUPS` config
  (`Investment` → Fixed Deposit / KWSP / ASNB / Unit Trust by
  default, easily extended) — Add/Edit Account gained a Sub-Group
  select that only appears for a Group with sub-groups configured.
  Financial Accounts page now shows a Sub-Total row per sub-group
  and a Group Total row per group (via new `accountBaseValue()`
  helper, base-currency-converted).
- **New account type: Unit Trust** (4th button next to
  Normal/Multi-Currency/Fixed Deposit). Holds one or more **funds**
  (new `FUNDS` IndexedDB store, `DB_VERSION` bumped 3→4) — Add/Edit
  Fund modal (name, code, category, currency, owner member(s),
  Current NAV). Add Transaction modal covers **Buy, Sell, Dividend
  (Reinvest), Dividend (Cheque Payout), Contribution**, each
  showing/hiding the Units/Price row and a "transfer from/to
  account" field appropriately for that type — this was the field
  missing from the reference screenshots. New income category
  **"Dividend Unit Trust"** added to `DEFAULT_CATEGORIES`.
  - Design: every fund transaction is a REAL row in the existing
    `TRANSACTIONS` store (tagged `fundId`/`fundTxType`), not a
    parallel ledger — so they inherit year filtering, member
    ownership, category reporting, and backup/restore for free.
    Buy/Sell are ordinary Transfers between a cash account and the
    Unit Trust account (account's currency-basket balance =
    cash actually invested/withdrawn). Dividend (Reinvest) and
    Contribution are ordinary Income transactions credited to the
    Unit Trust account itself (mirrors how this app already treats
    KWSP-style dividends/employer contributions). Dividend (Cheque
    Payout) is an ordinary Income transaction on whichever cash
    account the user names, since that money leaves the fund
    entirely. `fund.units` is adjusted directly alongside each
    linked transaction's save/delete.
  - Editing a fund-linked row through the normal Edit Transaction
    modal is blocked (would silently desync `fund.units`); tapping
    one instead offers delete-with-unwind (reverses the unit delta),
    via new `handleFundTxRowTap()`.
  - **Fund Holdings report** (account's own Activity page, Unit
    Trust accounts only): Units / NAV / Value / Invested / P&L /
    Return / Annualised / Holding per fund, each row tagged with its
    owner member name(s). "Invested" = net cash basis (buy +
    reinvest + contribution − sell); "Annualised" uses
    `((Value/Invested)^(1/years) - 1) × 100`, guarded for very new
    holdings.
  - `unittrust` treated as a basket-type account (same as
    multi/fd) everywhere `computeAccountBalances()`, the dashboard
    net-worth rollups, the Accounts page, and account-picker labels
    branch on account type — swept every `type === "multi" ||
    type === "fd"` check in `ledger.js` to confirm/add `unittrust`.
  - Account deletion now cascades to delete any funds filed under
    it. Export/import backup bundle, and the encrypted-store
    migration loop (`Object.values(STORES)`), extended to cover the
    new `FUNDS` store.
- **Passcode screen mistouch fix:** "Forgot passcode? Reset app
  data" moved well clear of the Unlock button, separated by a
  divider — was 16px below Unlock and easy to hit by accident
  (destructive: wipes the whole app).
- No breaking changes to existing accounts/transactions/categories/
  members — `DB_VERSION` bump only adds the new `funds` object
  store, doesn't touch existing ones. Verified with `node --check`
  on both JS files plus the usual `getElementById` /
  `data-click`/`data-change`/`data-input` cross-reference scripts
  before packaging.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v39.

## v40: fixed Add/Edit Fund and Add Transaction modals not closing
properly (mistaken for "not working" / could quit the app / could
double-submit)

- **Root cause.** The `popstate` handler that actually closes modals
  (`closeModal()` just calls `history.back()`; a single `popstate`
  listener does the real work of removing each modal's `active`
  class) checks a **hardcoded whitelist** of modal ids
  (`activeModals`). The two new v39 modals — `fundModal` (Add/Edit
  Fund) and `fundTxModal` (Add Transaction) — were never added to
  that list.
- **Effect.** Tapping [x], Save Fund, Delete Fund, or Save
  Transaction called `closeModal()` → `history.back()` → the
  listener didn't recognize either modal as open, so it never
  removed `active` (modal visibly stuck on screen) and instead fell
  through to the underlying ledger page's own back-navigation —
  which, with a thin mobile history stack, could consume the app's
  last "back" step and exit it entirely. Because the modal never
  visually closed, a user re-tapping Save (thinking the first tap
  did nothing) fired the save handler again — hence the occasional
  duplicate transactions.
- **Fix:** added `"fundModal"` and `"fundTxModal"` to the
  `activeModals` whitelist. One-line fix; every other part of the
  Unit Trust save/delete logic was already correct.
- Verified with `node --check` on both JS files plus the usual
  cross-reference scripts before packaging.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v40.

## v41: fund transactions can now be edited (not just deleted), Fund
Holdings table always tallies against the account balance, unified
Owner(s) picker design

- **Fund-linked ledger rows can now be edited.** Tapping a Buy / Sell /
  Dividend (Reinvest) / Dividend (Cheque Payout) / Contribution row
  used to jump straight to a delete confirmation — editing was
  blocked because doing it through the plain Edit Transaction modal
  would silently desync the fund's running unit balance. A dedicated
  editor (`openEditFundTxModal()`, reusing the same "Add Transaction"
  form under a new "Edit Transaction" title) now opens instead, fully
  pre-filled. Saving (`handleSaveFundTx()`) unwinds the *original*
  entry's unit effect first — on whichever fund it was originally
  tagged to, even if the fund picker is changed mid-edit — before
  applying the new one, so `fund.units` stays correct either way. A
  "🗑 Delete Transaction" button inside the same modal
  (`handleDeleteFundTxFromModal()`) replaces the old immediate-tap
  deletion for the normal case. The original delete-with-unwind
  behaviour (`handleFundTxRowTap()`) is kept only as a fallback for
  when a row's fund has since been deleted — there's no fund/account
  context left to build an editor around in that case.
- **Fund Holdings table no longer silently drops a fund's history.**
  Deleting a fund (`handleDeleteFund()`) always intentionally left its
  past transactions in the ledger, un-linked — but the Fund Holdings
  report only ever read from *live* fund records, so those orphaned
  transactions kept affecting the account's real Current Balance while
  disappearing from the table entirely, with nothing showing the two
  had drifted apart. `renderFundHoldingsTable()` now also groups any
  transaction whose `fundId` doesn't match a live fund under this
  account and renders it as its own "⚠️ fund deleted" row (name
  recovered from the transaction's saved description, valued at cost
  since there's no live NAV left for it), and a **Totals row**
  (Value / Invested / P/L / Return, summed across every row including
  orphaned ones) now sits at the bottom of the table so it can be
  checked at a glance against the Current Balance banner above it —
  flags mixed currencies rather than presenting a misleading blended
  total if a Unit Trust account holds funds in more than one currency.
- **Owner(s) picker is now one consistent design everywhere.** The
  Add/Edit Account modal's "Owner(s)" control
  (`renderAccountMemberCheckboxes()`) was a plain stacked checkbox
  list with a colour dot; the Add/Edit Fund modal's was already the
  rounded-pill chip row (`renderFundOwnerCheckboxes()`). Restyled the
  account version to match the fund version exactly (same pill markup,
  same `accent-color` tinting from the member's own colour) — this is
  the single shared control behind every Owner(s) picker in the app
  (Accounts modal, and the member-filter pre-check on the Member
  page), so the fix applies everywhere it's used, not just one screen.
- No IndexedDB schema/export-import format changes. Verified with
  `node --check` plus the id/data-click/data-change cross-reference
  script (0 missing, 0 dupes, 0 unbound handlers) after every edit.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v41.

## v42: Add Transaction total→price auto-calc, Invested no longer
counts Dividend (Reinvest) / Contribution as principal

- **Total Amount → Price per Unit auto-calculates too.** The Add/Edit
  Transaction form for funds already derived Total from Units × Price
  as you typed either one. Typing straight into Total Amount (once
  Units is filled in) now derives Price per Unit the same way
  (`recalcFundTxPriceFromTotal()`, Total ÷ Units) — so either entry
  order works, matching how a contract note is read (some state the
  price, some just the total consideration).
- **Fixed: "Invested" on the Fund Holdings table was counting
  Dividend (Reinvest) and Contribution as new principal, inflating it
  and making P/L look artificially small.** Example that motivated
  this: RM100 Buy + RM100 Dividend (Reinvest) + RM100 Contribution (at
  NAV 1.00, 100 units each) previously showed Invested RM300 / P/L
  RM0 — even though only the RM100 Buy was actual new cash the owner
  put in; the other RM200 was a return on the holding (a reinvested
  dividend / an employer-style contribution), which a user reasonably
  reads as profit, not principal. `computeInvested()` (used by both
  live and orphaned-fund rows in `renderFundHoldingsTable()`) now only
  counts Buy (+) and Sell (−) toward Invested — the same example now
  correctly shows Invested RM100 / P/L +RM200. This only changes how
  the Fund Holdings report presents existing data; no stored
  transaction fields, IndexedDB schema, or the underlying account
  balance calculation changed.
- No IndexedDB schema/export-import format changes. Verified with
  `node --check` plus the id/data-click/data-change/data-input
  cross-reference script (0 missing, 0 dupes, 0 unbound handlers)
  after every edit.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v42.

## v43: fixed Return % spiking after a partial Sell — Sell proceeds no
longer subtracted from Invested

- **Bug:** `computeInvested()` treated a Sell's entire proceeds as
  "cost recovered" (`invested -= sell.amount`), but a sale's proceeds
  are a mix of returned principal *and* realised profit. Subtracting
  the whole amount shrank the Invested denominator by more than the
  real cost sold, so Return % jumped right after a partial sell for
  no economic reason — e.g. RM200 invested, +RM1,015.28 P/L (507.64%)
  became +RM1,011.68 P/L but 778.21% after selling just RM70 worth of
  units, even though almost nothing had actually changed. On a
  near-full sell this could even push Invested negative.
- **Fix:** switched to a total-cost-basis method. `computeInvested()`
  now returns `{ invested, recovered }` — Invested only accumulates
  Buy amounts and is never reduced by a Sell; Sell proceeds accumulate
  separately as `recovered`. P/L is now `value + recovered - invested`
  (current value, plus everything already sold off and taken out,
  minus principal ever put in) and `Return % = P/L / invested`. Same
  worked example: after the RM70 sell, P/L is now +RM709.66 and Return
  % is 354.83% — matching a plain total-cost-method calculation by
  hand — instead of spiking. Applied to both the live-fund rows and
  the orphaned/deleted-fund rows in `renderFundHoldingsTable()`; the
  orphan rows' displayed "Value" (no live NAV survives fund deletion)
  is now approximated as remaining cost basis (`invested - recovered`,
  floored at 0) so they still contribute ~0 to total P/L rather than
  skewing the Totals row.
- Buying back into a fund after selling it will now add to Invested
  again on top of whatever was bought before — Invested is a running
  total of principal ever contributed, not a live "money still in the
  fund" figure. That's a deliberate trade-off for the total-cost
  method's simplicity and stability; it does mean Invested can now
  read higher than the fund's live value for a fund that's been mostly
  sold down and not replaced.
- No IndexedDB schema/export-import format changes — this only
  changes how the Fund Holdings report computes and presents derived
  figures from existing transaction data. Verified with `node --check`.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v43.

## v44: new "Daily NAV Update" page — update every held fund's price
in one place, with a History log

- **New sidebar page (📊 Daily NAV Update)** that auto-lists every
  fund you currently hold (units > 0) across all Unit Trust accounts,
  with three views (toggle top-right, matching the requested Card /
  Table / History design):
  - **Card**: one card per fund — name, "Current: $X.XXXX", and an
    editable price field.
  - **Table**: same data as a compact FUND / CURRENT NAV / NEW NAV
    table.
  - **History**: a read-only log, one row per NAV Date, one column
    per fund that's ever been updated — a plain historical record,
    not editable.
  A NAV Date picker sits above Card/Table (hidden in History). Typing
  into a price field updates both the Card and Table input for that
  fund at once (`handleNavPriceInput()`), so switching views mid-edit
  never shows a stale value — Card/Table share state without either
  view re-rendering.
- **"Update All Prices"** writes every typed price straight to that
  fund's own record (`fund.currentNav` — the same field the Fund
  Holdings table on each Unit Trust account page reads for live
  valuation), then snapshots the whole batch into a new `navHistory`
  store keyed by NAV Date. Re-running it on the same date overwrites
  that date's History row instead of duplicating it, so correcting a
  mistyped price same-day just fixes it in place. Only fields actually
  changed trigger a save; if nothing changed it says so instead of
  writing a no-op History row.
- **New `navHistory` object store** (keyPath `"date"`), added via a
  `DB_VERSION` bump (4 → 5) — each record snapshots
  `{ date, entries: [{ fundId, name, currency, nav }, ...] }`. Storing
  each fund's name/currency *in* the snapshot (not looked up live at
  render time) means a later fund rename or deletion doesn't blank out
  or reshuffle its historical column — same "keep showing it, mark
  it's gone" approach as the existing orphaned-fund rows in the Fund
  Holdings table. Included in Backup export/import (`bundle.navHistory`)
  alongside the other stores.
- Verified with `node --check` plus the same data-click/data-change/
  data-input cross-reference script used for prior releases — 0
  missing handlers, all new element ids resolve.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v44.

## v48: fund now has its own Activity page; Owner(s) chip styling
unified; Fund Holdings visible from the Accounts page; Total Amount
optional for Dividend (Reinvest)/Contribution; Settings reorganized

- **New Fund Activity page** — tapping a fund (in the Fund Holdings
  table on its Unit Trust account's own Activity page, or now also
  directly from the Accounts page list) opens a dedicated page for
  that one fund, mirroring an account's own Activity page: a Current
  Value banner, an ✏️ edit-fund button in the header, and a
  transaction list scoped to just that fund's Buy/Sell/Dividend/
  Contribution rows. The `[+]` FAB opens the existing fund-transaction
  form pre-set to this fund (`openAddFundTxModal()` now takes optional
  `accountId`/`presetFundId` overrides instead of always reading
  `activeLedgerAccountView`). Wired into the popstate back-button
  handler and `APP_PAGE_IDS` like every other page; while at it, also
  added the pre-existing Members/Data-Security pages to that same
  back-button whitelist (they were reachable but not previously
  covered by the hardware/gesture back button).
- Since each fund now has its own Activity page, the Unit Trust
  account's own Activity page no longer also shows the mixed Buy/
  Sell/Dividend transaction log below the Fund Holdings table (it
  only duplicated, and across multiple funds jumbled together, what's
  now broken out per-fund). Other account types are unaffected.
- **Accounts page** now lists each fund directly under its Unit Trust
  account row (e.g. "HLBB Value Fund — RM147.20" under "HLAM"), so
  holdings are visible without drilling into the account first —
  tapping a fund jumps straight to its new Activity page.
- **Owner(s) chip styling** (account form and fund form) unified under
  one `.owner-chip` CSS class — explicit `flex-direction: row`,
  `white-space: nowrap`, and fixed checkbox sizing so every member's
  chip renders as the same flat "checkbox + name" pill, instead of one
  member's chip occasionally rendering oversized/stacked.
- **Add Transaction (fund)**: Total Amount is no longer required for
  Dividend (Reinvest) or Contribution — those add units with no cash
  leg, so it can be left blank/0. Still required (must be > 0) for
  Buy, Sell, and Dividend (Cheque Payout), which do move real cash.
- **Settings reorganized**: sidebar's standalone "Manage Members" item
  removed; it now lives as the first row inside the settings hub,
  which is renamed "Setting" everywhere (sidebar button, page header,
  dashboard bottom button) — was "Data Security".
- **Dashboard "More" row**: "All Transactions" button removed;
  "Export & Import" (jumps straight to Backup & Restore) added in its
  place alongside Financial Accounts and Setting. All three icons
  enlarged (1.3rem → 1.7rem, more button padding) per feedback that
  they read too small.
- Verified with `node --check` plus the same data-click/data-change/
  data-input cross-reference script used for prior releases — 0
  missing handlers, all new element ids resolve.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v48.

## v55: FD maturity dates on Activity rows, Multi-Currency accounts
reworked (Base total + per-currency Activity pages), "(deleted
account)" mislabel fixed for Opening Balance entries

- **Fixed Deposit placements** now show their maturity date inline on
  every FD row in an account's own Activity list (e.g. "2026-07-27
  [Transfer] · Ref: 3-65019-0008812-0 · Matures 2027-07-27"), not just
  inside the maturity-reminder banner.
- **Multi-Currency accounts** (e.g. "Foreign Cash") reworked on both
  the Accounts page and their own Activity page:
  - The account row headline is now a single converted **Base total**
    ("Base MYR: RM103,xxx.xx") instead of a long "+"-joined string of
    every currency held — same for the **Current Balance** banner on
    the account's own Activity page.
  - Each currency basket now lists as its own subrow directly under
    the account (Accounts page) or as its own row on the account's
    Activity page — same one-per-line pattern Unit Trust already uses
    for its fund holdings — instead of everything squashed onto one
    wrapping line.
  - Tapping a currency opens a new **Currency Activity page**
    (mirrors the existing Fund Activity page) showing just that
    currency's own transactions, including its Opening Balance entry.
    The account's own Activity page no longer lists raw transactions
    directly — only the currency rows — since every transaction now
    lives on its currency's dedicated page.
- Fixed accounts group total/subtotal and net worth calculations are
  unaffected — only the display changed, `accountBaseValue()` still
  drives every total exactly as before.
- **"(deleted account)" mislabel fixed**: Opening Balance / Opening FD
  Placement entries deliberately leave `src` blank ("") since those
  funds originate outside the app — they were being shown as
  "(deleted account) → X" (indistinguishable from an actually-deleted
  account reference). Now shown as "(Opening Balance)" instead,
  wherever an account name is resolved from a transaction leg.
- Reminder: the Accounts page's sidebar shortcuts (Financial Accounts
  → Fixed Deposit, etc.) already list every account filed under that
  group/sub-group together in one place (with group/sub-group
  subtotals) — this was unchanged by v55, just confirmed still
  working as the way to see every FD placement across every account
  at a glance.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v55.

## v56: Fixed Deposit accounts now list active placements directly on
the Accounts page

- **Accounts page**: each Fixed Deposit account row now lists its own
  still-open placement tranches directly underneath — e.g. "Fixed
  Deposit Placement (3-65019-0008812-0) 🟢 Active / RM50,000.00 ·
  Matures 2027-07-27" — same subrow pattern already used for Unit
  Trust funds and Multi-Currency currency baskets. This means the
  sidebar's "Financial Accounts → Fixed Deposit" shortcut (which
  already listed every FD account together, unchanged since v55) now
  also surfaces every individual placement across every FD account in
  that same one screen, instead of just each account's running total.
- Only still-open placements show here (fdMaturityDate set, not yet
  fdResolved) — a placement that's been renewed or withdrawn drops off
  once resolved, exactly like the maturity-reminder banner's own
  filter. Tapping a placement opens it straight in the transaction
  editor.
- Purely additive to the FD account row — the account's own Base/
  currency total, the maturity-reminder banner, and the FD Activity
  page (with its per-row maturity date, from v55) are all unchanged.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v56.

## v65: Preferences (default payment account, collapse/expand state,
etc.) now travel with backup/restore

Previously, `exportBackup()` only bundled financial data (accounts,
transactions, categories, members, funds, navHistory) plus
`baseCurrency`/`fxRates`. Everything else in the `settings` object
store — Default Payment Account, Default Income/Expense Category, the
dashboard "Recent Transactions" widget filters — lived on-device only
and was silently dropped on import to a new device.

- **Backup export**: `exportBackup()` now also includes a `settings`
  array (a full dump of the `settings` object store's `{key, value}`
  rows). `baseCurrency`/`fxRates` remain as their own top-level bundle
  fields too, for backward compatibility with anything reading them
  directly off older-style bundles — they're just duplicated into the
  `settings` dump as well, harmlessly.
- **Backup import**: `importBackup()` now applies each row in
  `bundle.settings` back into the `settings` store and the matching
  in-memory variable (`defaultPaymentAccount`,
  `defaultIncomeCategory`, `defaultExpenseCategory`,
  `recentTxTypeFilter`, `recentTxAccountFilter`, `recentTxCount`,
  `expandedAccountSubrows`). Older backups without a `settings` field
  still import fine — this block is simply skipped, exactly as before.
- **Collapse/expand toggle state** (`expandedAccountSubrows`, the
  ▸/▾ caret on Accounts-page fund/currency/FD-placement subrows,
  since v62/v64): this used to be in-memory only and reset on every
  page reload, even on the same device. It's now persisted to the
  `settings` store on every toggle (key `expandedAccountSubrows`,
  value: array of composite `<filter>__<accountId>` keys), loaded back
  in `bootstrap()`, and included in the `settings` backup dump above —
  so it now survives a reload *and* carries over to a new device.
- No IndexedDB schema/version changes (`settings` store already
  existed) and no changes to the encrypted-backup wrapper format —
  just a larger plaintext bundle inside it. Verified with `node
  --check`.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v65.

## v66: Real Estate Type & Holding Period, Bank Loan Redraw Facility,
floating "back to top" button

- **Real Estate — Type**: a new dropdown (Residential / Commercial /
  Land / Industrial) on any account grouped under "Real Estate".
  Purely informational — doesn't affect any calculation. Stored as
  `account.propertyType`.
- **Real Estate — Holding Period Start Date**: a new date field, also
  Real-Estate-only. The app computes "how long held" from this date to
  today (e.g. "15y 10m") rather than storing a duration directly, so
  it stays correct as time passes. Stored as `account.holdingStartDate`.
- **Bank Loan — Redraw / Bank Withdrawal Facility**: a new checkbox on
  any account grouped under "Bank Loan"; when ticked, reveals a manual
  "Current Redraw Amount" + "As of Date" pair to key in straight off a
  bank statement. This is manual-entry only — there's no automatic
  calculation of an available redraw amount from transaction history,
  since this app has no existing concept of which transactions count
  as an over-payment vs. a redraw. Stored as `account.hasRedrawFacility`
  / `account.redrawAmount` / `account.redrawAsOfDate`.
- **Shown under the account name**: all of the above now appears as a
  small line under the account name on the Accounts page, on a
  member's own Accounts list, and on the account's own Activity page
  (new banner, same spot as the existing "Related Account" banner).
  One shared helper, `accountExtraInfoLine()`, builds this line so all
  three surfaces stay in sync.
- **New fields are ordinary account fields** — no IndexedDB schema
  change, and they ride along automatically in backup export/import
  (v65's `settings` addition was separate; these are on the account
  record itself, in the `accounts` array that was already backed up).
  A field is blanked out if the account is later re-grouped away from
  Real Estate / Bank Loan, or (for the redraw fields) if the facility
  checkbox is unticked while still a Bank Loan — so stale values don't
  linger silently.
- **Floating "back to top" button**: a small circular button, fixed
  above the existing "+" FAB on the right edge, appears once a page
  is scrolled down more than ~300px and smooth-scrolls back to the
  top on tap. Global — lives outside every `.page` div, so it works
  the same on every page (Ledger, Accounts, Dashboard, etc.) without
  being wired up per-page.
- Verified with `node --check` on both changed JS files.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v66.

## v67: "Fetch Live Rates" button — same source as Wealth Planner

Previously, Ledger's Currency Settings had no way to pull live
exchange rates — every rate had to be typed in by hand, which drifts
out of accuracy over time and (more to the point) doesn't match
whatever the companion Wealth Planner app shows, since that app *does*
fetch live rates.

- **New "🔄 Fetch Live Rates" button** in the Global Currency Settings
  modal, right above the rate input fields. Calls the exact same
  `https://open.er-api.com/v6/latest/{base}` endpoint the Wealth
  Planner app's own "Fetch Live Rates" button already uses — so when
  both are fetched around the same time, the two apps' rates agree
  instead of drifting apart. No API key required.
- Only fills the visible input fields (same UX as Wealth Planner's
  version) — nothing is written to storage until "Save FX Values" is
  tapped, so a bad fetch can't silently overwrite good manual rates.
- **No inversion needed** in this app's fetch code (unlike Wealth
  Planner's own, which stores rates the opposite way round): this
  app's `fxRates[c]` already means "units of `c` per 1 base", which is
  exactly what the API returns directly for the requested base — see
  the comment on `fetchLiveFxRates()` for the arithmetic that confirms
  this against `convertCurrency()`'s formula.
- **CSP updated**: `connect-src` was `'self'` only (this app was fully
  offline-first — no fetch/XHR calls at all until now). It's now
  `'self' https://open.er-api.com`, matching the Wealth Planner app's
  own CSP for the identical reason. This is the one and only outbound
  network call anywhere in the app; everything else remains
  IndexedDB-only.
- Verified with `node --check`.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v67.

## v68: Exchange rate rows now quote in whichever direction reads
naturally

Previously every row in Currency Settings was quoted as "1 {base} =
{rate} {currency}" regardless of which currency was actually worth
more — e.g. with MYR as base, USD showed as "1 MYR = 0.2464 USD",
which is correct but not how anyone actually says it ("1 USD = 4.06
MYR" reads naturally instead).

- **Each row's direction is now decided per-currency**: a currency
  worth MORE than 1 unit of the base (e.g. USD, EUR, GBP against MYR)
  is now quoted as "1 {currency} = {rate} {base}"; a currency worth
  LESS (e.g. KRW, JPY, THB against MYR) stays "1 {base} = {rate}
  {currency}" — matching the screenshot example (1 USD = ** MYR / 1
  MYR = *** KRW).
- Purely a display change — `fxRates[curr]`'s stored convention
  ("units of curr per 1 base") is untouched, and so is
  `convertCurrency()`. Each input now carries a `data-mode` attribute
  ("direct" or "inverted") recording which way that row is currently
  showing its number; `saveFxRates()` reads it back to convert
  whatever's on screen to the stored convention correctly regardless
  of direction.
- **Fetch Live Rates (v67) updated to match**: it now re-renders the
  whole rate list from the freshly-fetched numbers (rather than just
  overwriting each input's value in place), so every row's direction
  is recalculated fresh against the new numbers too — a currency that
  happens to cross the 1.0 threshold since the last fetch won't be
  left showing the wrong direction.
- Verified with `node --check`.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v68.

## v88: Reworked entry form (Category above Account, Notes/To/From,
Checked toggle), Split Expenses, Calculator/Numpad, and a Transaction
Quick View with Duplicate/Edit/Refund/Delete

Requested via a set of reference screenshots from another ledger app;
implemented as follows.

- **Entry form reordered**: Category now sits above Account (previously
  the other way round). Description moved to the bottom of the form,
  and two new optional fields sit next to it: **To/From** (a
  payee/counterparty field — labelled "From" for Income, "To"
  otherwise) and **Notes** (free text). Both save as `t.payee`/
  `t.notes`, `null` when left blank so existing code checking either
  field for truthiness is unaffected.
- **Checked toggle**: every transaction now carries `t.checked`
  (default `false` for a new entry). A small ✅ badge overlays the
  category icon on any checked row. Meant for reconciling entries
  against a bank/credit-card statement — purely a display flag, no
  effect on any balance or report total.
- **Transaction Quick View**: tapping a ledger row now opens a compact
  summary (amount, account, category, To/From, Notes, a Checked
  toggle button) instead of jumping straight into the full edit form.
  A ⋮ button opens an **Options** menu — Duplicate transaction / Edit
  transaction / Refund / Delete transaction — mirroring the reference
  screenshots. "Edit transaction" opens the same edit form as before;
  nothing about editing itself changed. Fund-linked transactions
  (Buy/Sell/Dividend/Contribution) skip Quick View entirely and go
  straight to their existing dedicated editor, since Checked/Refund/
  Duplicate don't apply to them.
  - New history-stack handling: Options is a layer over Quick View
    sharing its one pushed state rather than pushing a second (see
    `openTxOptionsMenu()`), and a new `closeModalAndThen()` helper
    properly waits for a modal's close to actually complete (its real
    `popstate` event) before pushing the next one — Edit/Duplicate/
    Refund all use it — so the back-button stack never drifts out of
    sync with what's visibly open, which a naive
    `closeModal(); closeModal(); openModal();` chain would have
    caused (each `closeModal()` triggers an async `history.back()`, so
    two in a row plus an immediate `pushState()` would race).
- **Split Expenses**: a "➕ Split into another category" button (shown
  only for a brand-new Income/Expense entry — not Transfers, not while
  editing) adds Category+Amount row pairs with their own `[-]` to
  remove, and a live Split Total. On save, each row becomes its own
  ordinary transaction record (same account/date/desc/payee/notes/
  checked state) sharing a generated `splitGroupId` purely for
  traceability — every existing balance/report calculation already
  handles a normal transaction correctly, so nothing about how they
  aggregate needed to change.
- **Calculator / Numpad**: a 🧮 button beside every Amount field (main
  and split rows) opens a small popup calculator (`+ − × ÷ =`, doubling
  as an on-screen numpad); `inputmode="decimal"` on the fields
  themselves also brings up the OS's own numeric keyboard when tapped
  directly. The popup only evaluates a strictly digit/operator-only
  string (regex-checked before `Function(...)`) — it's a fixed-button
  calculator, not a general expression evaluator.
- **Refund**: "Refund" in Quick View → Options (expense entries only)
  opens a new Income entry pre-filled from the original expense, with
  Category **forced** to the exact same category (the Income category
  dropdown is replaced with a single locked option) — this is what
  lets it "reduce the expense" rather than "count as income": the
  saved record is tagged `isRefund: true, refundOf: <original id>`,
  and:
  - `computeAccountBalances()` needs **no change** — crediting the
    account back is exactly what an ordinary Income record already
    does.
  - The dashboard, Net Savings Statement, and Spending Breakdown pages
    each special-case `isRefund` to subtract it from the matching
    expense category's total instead of adding it to income (see the
    `isRefund` branches added to each — they key strictly off `t.cat`
    matching the original expense's category, which is why the
    category is force-locked on the refund's own entry above).
  - The Income Breakdown page excludes `isRefund` entries outright, so
    they never appear as income there.
  - A refund row displays as an ordinary green Income entry (with a
    small "↩️ Refund" badge) everywhere else, e.g. the dashboard's
    recent-transactions widget — only the aggregation totals above
    treat it specially.
- Verified with `node --check` plus a script cross-referencing every
  `data-click`/`data-change`/`data-input` attribute in `index.html`
  against `CLICK_ACTIONS`/`CHANGE_ACTIONS`/`INPUT_ACTIONS`, and every
  `getElementById(...)` call against actual element ids — all clean.

**Known scope limits, by design** (flagged rather than silently
dropped): Split Expenses is new-entry-only, not available when editing
an existing transaction or for Transfers. The calculator is a plain
arithmetic popup, not a fully custom on-screen numpad widget — mobile's
native numeric keyboard (via `inputmode="decimal"`) handles direct
typing. A refund's "residual/remaining balance" preview shown live
during entry (as in one of the reference screenshots) was not
implemented.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v88.

## v90: Calculator "=" fixed (was silently doing nothing)

Root cause: the calculator's `=` handler used `Function('"use strict";
return (' + sanitized + ')')()` to evaluate the typed expression. This
app's CSP is `script-src 'self'` with no `unsafe-eval`, so the browser
silently blocks any `Function()`/`eval()`-style call — it throws, and the
surrounding `try/catch` swallowed the error, so tapping `=` just did
nothing with no visible sign why. Digits, `C`, and `⌫` all worked fine
since they never went through that code path.

Fixed by replacing the eval-based evaluation with a small hand-written
tokenizer + two-pass evaluator (`evalCalcExpression()` in `ledger.js`) —
standard `* /` before `+ -` precedence, unary minus supported, no
parentheses (the keypad has none). Returns `null` on anything malformed
(trailing operator, divide-by-zero, a stray second decimal point) rather
than `NaN`, so the existing `isFinite()` check in `calcPadPress()` still
cleanly leaves the display untouched on bad input — same visible
behavior as before, just without the eval dependency. **Do not "fix"
this by adding `'unsafe-eval'` to the CSP** — that reopens exactly the
class of risk the CSP hardening on this app family was meant to close;
any future calculator/expression feature here should extend
`evalCalcExpression()` rather than reach for `Function()`/`eval()`.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v90.

## v91: Split Expense entries now display as one merged row

Reported via reference screenshots from another ledger app: a Split
Expense (v88) — e.g. paying McD RM90 split Clothing RM30 / Dining Out
RM60 — was saving correctly (each part is its own ordinary transaction
record sharing a `splitGroupId`, by design, so every balance/report total
was already right) but **displaying** as two separate, unrelated-looking
rows everywhere a transaction list appears, instead of one combined row
like the reference app.

- **Display-only merge**: a new `getSplitGroupInfo()` helper collapses a
  split group back into one row for every list view — dashboard **Recent
  Transactions**, an account's **Currency Activity** page, and the main
  **Ledger/Activity** list — keyed on the group's lowest id (the original
  "main" part, saved first). Categories join with a comma
  ("Clothing, Dining Out"), amounts sum (RM90.00), icons concatenate. The
  other members are skipped when building each list's HTML so they don't
  also show up as their own rows. Nothing about balance or report totals
  changed — those still iterate every individual record exactly as
  before v91.
- **Quick View breakdown**: tapping the merged row shows each
  category+amount part on its own line (matching the reference
  screenshot), followed by the shared Account/To/Notes fields — all
  identical across a group's members by construction.
  - **Checked toggle**: Quick View shows one Checked button for the
    merged row, so tapping it reconciles every part of the group
    together (there's no way to see a "half-checked" split from the
    merged row, so it doesn't leave one behind).
  - **Options menu (Duplicate/Edit/Refund/Delete)**: these each still
    act on exactly one underlying record — there's no split-aware
    editor. On a merged row the ⋮ button now opens a "Which part?"
    picker first (`openTxSplitPicker()`/`txSplitPickerModal`); picking a
    category+amount part repoints Options at that one record, same as
    tapping an ordinary (non-split) row directly.
- **Orphan fallback**: if a group's sibling is ever deleted individually
  (via the picker above) leaving just one part with a `splitGroupId`,
  `getSplitGroupInfo()` returns `null` for it and it renders as a normal
  single-category row rather than disappearing.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v91.

## v104: new sidebar report — Financial Assets vs Real Estate, by owner

- **New Reports page** (Sidebar ▸ Reports ▸ 🏛️ Financial Assets vs Real
  Estate): a table with one row per owner — solo member, joint-owned
  group, and (if any) "Unassigned" — same ownership breakdown as the
  dashboard's existing "Net Worth by Member" section. Each row shows
  **Financial Assets + Real Estate = Total Net Worth, % of Net Worth**
  (that owner's share of everyone's combined total), plus a Grand
  Total footer row.
- **Financial Assets** is every account except those grouped under
  "Real Estate" (Bank/Cash, Credit Card, Investment, Bank Loan,
  Account Payable/Receivable, etc.) — so it's always exactly
  `Total − Real Estate`, guaranteeing the two columns sum to the same
  Total Net Worth this app shows everywhere else. New helper
  `summarizeOwnerAssetSplit()` computes this per subset of accounts,
  reusing the existing `accountBaseValue()` conversion so
  Multi-Currency/FD/Unit Trust basket accounts are handled the same
  way as the rest of the app. Same `includeInNetWorth === false`
  opt-out as the dashboard's Net Worth by Member section — an excluded
  property contributes to neither column.
- Wired into the app's page-navigation pipeline exactly like the
  neighbouring Unit Trust Portfolio report — `showPage()`,
  back-button/`popstate` handling, `updateSidebarActiveState()`, and
  `sidebarGo()` all cover the new `owner-networth-report` target.
- No IndexedDB schema/version changes — read-only report over existing
  account/member/transaction data. No export/import format changes.
  Verified with `node --check` on both JS files plus the
  data-click/data-change/data-input ↔ handler and `getElementById` ↔
  element-id cross-reference scripts (0 missing, 0 dupes).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v104.

## v105: "Salary", "Investments", "Freelance" converted from legacy
fallback names into real, editable category records

Previously these three names only existed as a hardcoded legacy
fallback list inside `buildCategoryOptionsHTML()` (and mirrored in a
couple of report-page category lists) — they appeared in every income
category dropdown so old transactions using them still displayed
correctly, but had no actual record in the Categories store, so the
Categories page had nothing to show, edit, or re-icon for them.

- Added all three to `DEFAULT_CATEGORIES` (`Salary` 💼, `Investments`
  📈, `Freelance` 💻 — same icons the fallback list was already
  showing, so nothing visually changes for existing transactions).
  `ensureDefaultCategories()` (idempotent, runs every launch) will
  auto-create each one as soon as it doesn't find an existing category
  of that name — same mechanism that seeds every other starter
  category, so no manual per-device setup and no schema/version bump.
- Once created, each becomes a normal, manageable entry on the
  Categories page (rename, re-icon, delete) like any other category.
  Old transactions tagged "Salary"/"Investments"/"Freelance" are
  matched by name string, so they line up with the new records
  automatically — no data migration needed.
- The hardcoded legacy-fallback list itself (`legacyFallback` in
  `buildCategoryOptionsHTML()`, and its duplicates in the two
  breakdown-report functions) was deliberately left in place rather
  than removed: it's still what keeps a *renamed-away-from* or
  *deleted* legacy category name from vanishing out of old
  transactions' dropdowns, and the option-builder already de-dupes
  against real records (a name "covered" by a real category record is
  skipped in the leftover-fallback pass), so there's no double entry
  now that real records exist.
- **"Other Income" was intentionally left as-is** — it's the app's
  protected implicit income fallback (`handleCreateCategoryMobile()`
  explicitly blocks creating a category literally named "Other
  Income"/"Other Expenses"), not a legacy leftover like the other
  three, so it stays a placeholder by design.
- No IndexedDB schema/version changes, no export/import format
  changes. Verified with `node --check` plus the data-click/data-change/
  data-input ↔ handler and `getElementById` ↔ element-id
  cross-reference scripts (0 missing, 0 dupes).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v105.

## v106: Salary Entry — 4th quick-entry button, EPF (Malaysia) / CPF
(Singapore) split

- **New "💰 Salary" quick-entry button** on the dashboard, alongside
  Income/Expense/Transfer (`.actions-bar` is now a 4-column grid;
  `.btn-salary` uses a new `--salary-color` (#d97706) CSS variable).
  Opens a dedicated `salaryModal`.
- **Salary Entry modal**: Member (filters both account dropdowns to
  that person's solo-owned accounts — `populateSalaryAccountSelects()`
  mirrors `filterAccountsByOwnership`'s "member" mode, joint accounts
  excluded from a single member's filtered view, same convention as
  the Spending/Income Breakdown member filter), Date, Scheme
  (None / EPF (Malaysia) / CPF (Singapore)), Description (auto-fills
  "<Month> <Year> Salary", editable), Bank Account, an EPF/CPF Account
  row (shown only when a scheme is picked — label switches between
  "EPF / KWSP Account" and "CPF Account"), Gross Salary, and
  Employee (EE) / Employer (ER) amount fields (shown only when a
  scheme is picked). A live preview box mirrors the reference design
  (Gross Salary → Bank Account, → EPF/CPF (EE), → EPF/CPF (ER)),
  recalculating on every keystroke via `recalcSalaryPreview()`.
- **On Save** (`handleSaveSalaryRecord()`), writes 1–3 ordinary Income
  transactions — no new transaction "kind", same philosophy as Split
  Expenses/Fund transactions:
  - Bank leg (Gross − EE) → Bank Account, category "Salary"
  - EE leg (if scheme picked and EE > 0) → EPF/CPF Account, category
    "EPF Contrib.(EE)" / "CPF Contrib.(EE)"
  - ER leg (if scheme picked and ER > 0) → EPF/CPF Account, category
    "EPF Contrib.(ER)" / "CPF Contrib.(ER)" — purely additive, never
    subtracted from the Bank leg, since an employer's contribution
    never touches the employee's actual pay
  All three share a generated `salaryGroupId`, purely for
  traceability (same pattern as Split Expenses' `splitGroupId`) —
  every existing balance/report calculation already handles a plain
  Income record correctly, so nothing downstream needed to change.
- **New categories**: `CPF Contrib.(EE)` / `CPF Contrib.(ER)` added to
  `DEFAULT_CATEGORIES` (auto-provisioned via the existing idempotent
  `ensureDefaultCategories()`) and `fallbackIcons`, alongside the
  pre-existing `EPF Contrib.(EE)` / `EPF Contrib.(ER)`.
- **New account sub-group**: `"CPF"` added to `ACCOUNT_SUBGROUPS`
  under `"Investment"` (next to `"KWSP"`) — this is data-driven, so it
  automatically picks up a matching sidebar shortcut
  (`accountTypeShortcutList()`) and Add/Edit Account Sub-Group option
  with no other code changes.
- CPF is intentionally the "simple" model per user decision — one
  combined CPF account/leg per EE and ER, not a further OA/SA/MA
  split. Both schemes enter EE/ER as exact typed amounts (not
  percentages), matching the reference screenshot.
- No IndexedDB schema/version changes (`salaryGroupId` is just a new
  optional field on transaction records, like `splitGroupId` before
  it — `undefined`/`null` for all existing data). No export/import
  format changes — the new transactions are ordinary rows already
  covered by the existing backup bundle. Verified with `node --check`
  plus the data-click/data-change/data-input ↔ handler and
  `getElementById` ↔ element-id cross-reference scripts (0 missing,
  0 dupes).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v106.

## v107: Salary Entry — fixed account dropdowns being wrongly narrowed
by the Member picker

Reported via screenshots: picking a specific Member (e.g. "LIM VF")
narrowed both the Bank Account and EPF/CPF Account dropdowns down to
only that member's solely-owned accounts — hiding joint accounts they
might legitimately bank their salary into, and in practice sometimes
leaving only one eligible account, so it ended up selected for BOTH
Bank Account and EPF/CPF Account. That meant the EE/ER contribution
legs landed in an ordinary bank account instead of a real KWSP/CPF
investment account — still counted as ordinary Income, but not
reflected as growing the actual EPF/CPF asset the user meant to track.

- **Both dropdowns now always list every account**, regardless of
  which Member is selected — `populateSalaryAccountSelects()` no
  longer takes a member filter at all. A member may legitimately bank
  their salary into a joint account (or one nominally in their
  spouse's name), so the Member picker must never remove options from
  either list.
- **The Member picker is now a smart-default nudge, not a filter.**
  `handleSalaryMemberChange()` no longer rebuilds either dropdown's
  option list; it only pre-selects a sensible default when a specific
  member is picked: the Bank Account defaults to their own
  solely-owned Bank/Cash-group account if one exists, and the EPF/CPF
  Account defaults to any account under the Investment group's KWSP
  or CPF sub-group they're an owner of (solo OR joint — a household's
  EPF/CPF pot is sometimes filed jointly). If no match is found for
  either, the user's own manual pick (or "All Members" state) is left
  untouched rather than being overwritten with something wrong.
- No IndexedDB schema/version changes — display/selection logic only.
  Verified with `node --check` plus the data-click/data-change/
  data-input ↔ handler and `getElementById` ↔ element-id
  cross-reference scripts (0 missing, 0 dupes).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v107.

## v108: Salary Entry — Currency auto-set by Scheme (MYR for EPF,
SGD for CPF)

- **New Currency selector** in the Salary Entry modal header (same
  compact style/position as the main transaction form's own
  `txCurrency` selector) — populated from every currency in
  `fxRates`, defaulting to the app's base currency when the modal
  opens.
- **Auto-set by Scheme**: picking "EPF (Malaysia)" sets Currency to
  MYR; picking "CPF (Singapore)" sets Currency to SGD (only if that
  currency exists in Currency Settings — silently left alone
  otherwise, rather than erroring). Switching to "None" doesn't force
  a currency change, since a plain salary entry has no single natural
  currency to default to. The user can still override the auto-set
  value by hand afterward — it's a default, not a lock.
- **All three legs (Bank / EE / ER) now save using this one selected
  Currency**, not each account's own native currency as before —
  matches how a real payslip is issued in one currency regardless of
  which account it's routed into. No new conversion logic needed:
  `computeAccountBalances()` already converts a transaction's
  currency into its account's own currency at the live FX rate
  whenever they differ (the same mechanism every ordinary Income/
  Expense entry already relies on), so a Salary entry landing in an
  account of a different currency just works, exactly like the main
  transaction form's own currency-vs-account-currency handling.
- **Preview box now shows proper currency symbols** (`RM` for MYR,
  `S$` for SGD, etc. via the existing `formatCurrency()`/
  `currencySymbols` map) instead of bare numbers, and re-renders
  whenever Currency, Scheme, or any amount field changes.
- No IndexedDB schema/version changes — `currency` was already a
  field on every transaction record; this only changes what value the
  Salary Entry form puts there. Verified with `node --check` plus the
  data-click/data-change/data-input ↔ handler and `getElementById` ↔
  element-id cross-reference scripts (0 missing, 0 dupes).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v108.

## v109: Salary Entry — Bank/EPF/CPF Account fields now use the same
custom Account Picker as the Income/Expense/Transfer form

Previously the Salary Entry modal used plain native `<select>` dropdowns
for Bank Account and EPF/CPF Account — inconsistent with the rest of
the app, which replaced native account `<select>`s back in v99
specifically because Android Chrome renders a native `<select>`'s
expanded option list at its own oversized system font size,
illegible on a phone and not controllable from CSS.

- **Both fields are now button + hidden-`<select>` pairs**
  (`account-picker-btn` style, tapping opens `accountPickerModal`),
  exactly like `srcAccount`/`destAccount` on the main transaction
  form — same modal, same `openAccountPicker()`/
  `selectAccountPickerOption()` machinery, just pointed at the
  Salary form's own selects via `data-select="salaryBankAccount"` /
  `"salaryContribAccount"`.
- **Option text now matches the Income/Expense form's own account
  list exactly**: `populateSalaryAccountSelects()` was rewritten to
  build the same "🏦/💱/📊 prefix + name + (currency) + — Owner"
  format `openTransactionForm()` uses, instead of the previous
  `accountOptionLabel()` "Name (Owner)" shorthand.
- **`syncAccountPickerButtonText()` generalized**: previously
  hardcoded to only recognize `srcAccount`/`destAccount` (a ternary),
  it now derives the paired button-text element id as
  `<selectId>BtnText` for any select — a plain string-concat
  generalization that requires no behavior change for the existing
  two ids (`srcAccountBtnText`/`destAccountBtnText` already followed
  that pattern) while making the new `salaryBankAccountBtnText`/
  `salaryContribAccountBtnText` work automatically. Called after
  every place that sets `salaryBankAccount`/`salaryContribAccount`'s
  `.value` directly (`populateSalaryAccountSelects()`,
  `handleSalaryMemberChange()`'s smart-default nudges), so the
  button label never goes stale — same convention already used by
  `openTransactionForm()`.
- The EPF/CPF Account button's title also now updates with the
  Scheme (`handleSalarySchemeChange()` sets its `data-title` to
  "Select EPF / KWSP Account" or "Select CPF Account"), matching the
  row's own label.
- No IndexedDB schema/version changes, no export/import changes —
  UI-only. Verified with `node --check` plus the data-click/data-
  change/data-input ↔ handler and `getElementById` ↔ element-id
  cross-reference scripts (0 missing, 0 dupes).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v109.

## v110: Salary Entry — new Category field (pick a Salary Subcategory
directly, e.g. "Salary -VF")

Reported via screenshots: the Bank leg was always hardcoded to save
under the plain "Salary" category, with no way to pick one of the
user's own Subcategories (e.g. "Salary -VF" / "Salary -RS", created to
track each spouse's salary separately) at entry time — forcing a
manual re-categorize of every saved entry afterward (Ledger →
tap the transaction → Edit → change Category by hand).

- **New "Category" field** in the Salary Entry modal, right after
  Bank Account. Uses the exact same `buildCategoryOptionsHTML()`
  builder the main Income/Expense/Transfer form's own Category select
  uses — so it lists every income category exactly like that form
  does (Main Categories with Subcategories grouped under an
  `<optgroup>`, "Salary (General)" as the parent's own option, plus
  every Subcategory like "Salary -VF"/"Salary -RS" alongside it).
  Defaults to "Salary" when the modal opens, but any income category
  can be picked directly, not just something under Salary.
- **The Bank leg is now saved with whatever Category is selected**,
  instead of the hardcoded literal `"Salary"` string. The EE/ER legs
  are unaffected — those still follow the Scheme selector
  ("EPF Contrib.(EE)"/"(ER)" or "CPF Contrib.(EE)"/"(ER)"), since
  there's no per-member EPF/CPF Subcategory need reported yet.
- Left deliberately manual rather than auto-matched to the selected
  Member — Subcategory naming conventions vary too much (initials vs.
  full name vs. nicknames) for a safe automatic guess, so this
  mirrors how the ordinary Income form's own Category field already
  behaves: always a plain, explicit pick.
- No IndexedDB schema/version changes — `cat` was already a plain
  string field on every transaction record; this only changes what
  value the Salary Entry form puts there, and only for the Bank leg.
  Verified with `node --check` plus the data-click/data-change/
  data-input ↔ handler and `getElementById` ↔ element-id
  cross-reference scripts (0 missing, 0 dupes).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v110.

## v111: fixed — Salary Entry's Category field wasn't showing "Salary"'s
Subcategories (e.g. "Salary -VF"/"Salary -RS")

Root cause, confirmed against `buildCategoryOptionsHTML()`: it only
groups a Subcategory under its Main Category when the Subcategory's
own name is present in the caller-supplied `namesToInclude` list (this
is what lets a renamed/deleted category still show up correctly on
its own existing transaction elsewhere in the app). v110 passed a
literal `["Salary"]` as that list — covering the Main Category itself,
but not any of its Subcategories — so every Subcategory got silently
filtered out of the dropdown, leaving "Salary" rendered as a single
flat option with nothing nested under it (see screenshot: the same
dropdown that correctly showed "Salary" → "Salary (General)"/
"Salary -RS"/"Salary -VF" on the ordinary Edit Ledger Entry form
showed no Subcategories at all here).

- **Fix**: `openSalaryEntryForm()` now passes every existing income
  category name (`dynamicCategories.filter(c => c.type === "income")
  .map(c => c.name)`) as `namesToInclude` — the exact same convention
  the main transaction form's own Category select already uses via
  its `currentCats` variable — so `buildCategoryOptionsHTML()` now
  correctly includes every Subcategory that exists, not just Main
  Categories.
- No IndexedDB schema/version changes — one-line fix to which names
  get passed into an existing, unchanged builder function. Verified
  with `node --check` plus the data-click/data-change/data-input ↔
  handler and `getElementById` ↔ element-id cross-reference scripts
  (0 missing, 0 dupes).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v111.

## v112: new "Default Receive Account" setting — applies to both the
ordinary Income form and Salary Entry's Bank Account

Previously "Default Payment Account" pre-selected the account field
on every new transaction type (Income, Expense, and Transfer's "from"
side) — not just Expenses, despite the name. That meant incoming
money (Income entries, and Salary Entry's Bank Account) always
defaulted to whatever account was set up for outgoing spending, which
often isn't the same account a household actually receives salary
into.

- **New "Default Receive Account" selector** on the Accounts page,
  right below Default Payment Account — same style/behavior
  (`populateDefaultReceiveAccountSelect()`/`saveDefaultReceiveAccount()`
  mirror the existing Default Payment Account functions exactly), and
  hidden alongside it whenever a sidebar shortcut narrows the Accounts
  list to one group/sub-group (same convention as v62's
  `defaultPaymentAccountSection`/`Row` hiding).
- **Ordinary Income form**: `openTransactionForm()`'s pre-select logic
  now picks Default Receive Account for `type === "income"`, and keeps
  using Default Payment Account for Expense and Transfer's "from"
  side — a one-line branch (`type === "income" ? defaultReceiveAccount
  : defaultPaymentAccount`) instead of always using the payment one.
- **Salary Entry's Bank Account** now defaults to Default Receive
  Account when the modal opens (Member starts on "All Members", so
  this is the only default in play at that point) — picking a
  specific Member afterward can still nudge it further via the
  existing member-specific smart-default from v107.
- **New setting persisted** as `defaultReceiveAccount` in the SETTINGS
  store (same `{key, value}` shape as every other preference here) —
  loaded on bootstrap, and already covered by the full-SETTINGS-store
  backup/restore dump from v65 with no format change; only the
  restore-side switch needed a new `case` to update the in-memory
  variable when importing an older backup that predates this setting
  (harmlessly absent — restores fine without it, just no default).
- No IndexedDB schema/version bump — a new key in an existing
  key/value store. Verified with `node --check` plus the data-click/
  data-change/data-input ↔ handler and `getElementById` ↔ element-id
  cross-reference scripts (0 missing, 0 dupes).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v112.

## v113: fixed — Salary Entry's Default Receive Account was getting
overwritten the moment a specific Member was picked

Reported via screenshots: with Member = "All Members", Bank Account
correctly defaulted to the configured Default Receive Account (PBB
Current A/c). But switching Member to "LIM VF" immediately overwrote
it with that member's own solo Bank/Cash account (RHB Current A/c) —
silently discarding the explicit Default Receive Account setting.

- **Root cause**: `handleSalaryMemberChange()`'s per-member
  smart-default (added in v107, to help someone bank into their own
  solo account when no shared default was configured) ran
  unconditionally, with no awareness of Default Receive Account
  (added later, in v112) — so it always overwrote whatever
  `openSalaryEntryForm()` had just defaulted Bank Account to.
- **Fix**: the per-member solo-account guess is now only applied
  when Default Receive Account is NOT configured (or points at an
  account that no longer exists). Default Receive Account — an
  explicit, deliberate setting on the Accounts page — now always
  wins over the member-specific guess, exactly matching how it
  already behaves with Member left on "All Members". The EPF/CPF
  Account per-member default is unaffected — that one has no
  Default-Account-style setting to defer to.
- No IndexedDB schema/version changes — pure default-selection logic
  fix. Verified with `node --check` plus the data-click/data-change/
  data-input ↔ handler and `getElementById` ↔ element-id
  cross-reference scripts (0 missing, 0 dupes).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v113.

## v114: fixed a latent bug — renaming a seeded default category (e.g.
"Rental Income" → "Rental Income -Warehouse") would have silently
recreated a duplicate under the old name on next launch

Reported via screenshot: "Rental Income" appeared in the Default
Income Category dropdown but not on the Categories management page.
Explanation, same underlying mechanism as the original Freelance/
Investments/Salary case earlier in this project: "Rental Income" is
one of the literal names baked into `DEFAULT_CATEGORIES`, and
`buildCategoryOptionsHTML()`'s dropdown always includes every
`DEFAULT_CATEGORIES` name as a legacy/fallback option even when no
real category record matches it by that exact name anymore — which,
here, is exactly what happened: the user's real category (still the
very same record, same id) had been renamed to "Rental Income
-Warehouse", so nothing in Categories is literally named "Rental
Income" anymore, yet the dropdown still shows it as an unmatched
leftover option (harmless on its own — it's just there so any old
transaction still filed under the literal string "Rental Income"
keeps a dropdown entry to display against).

- **The actually risky part, now fixed**: `ensureDefaultCategories()`
  (idempotent, runs every launch) previously matched an existing
  category purely by **current name** — so the moment "Rental Income"
  no longer matched by name (because the user renamed it), the next
  launch would treat it as "missing" and silently insert a brand-new
  duplicate `cat_rental_income` category, re-fragmenting the user's
  transaction history across two "Rental Income"-ish categories they
  never asked for.
- **Fix**: the missing-category check now also matches by the
  **deterministic id** a `DEFAULT_CATEGORIES` entry would have been
  seeded with (`slugify(c.name)`) — since renaming a category via Edit
  Category keeps its original `id`, checking the id (not just the
  current name) correctly recognizes "this default was already seeded
  once, just renamed since" and skips re-inserting it. This
  generalizes the same protection the existing one-off
  `legacyBeting`/`legacyRentingExpenses` migrations already used
  (matching by id, not name) to **every** `DEFAULT_CATEGORIES` entry,
  present or future — no new one-time migration needed each time a
  user renames a starter category.
- No IndexedDB schema/version changes — matching-logic fix only, and
  nothing to undo: since the duplicate hadn't actually been created
  yet (this instance was caught before a reload), there's no cleanup
  needed for existing data. Verified with `node --check` plus the
  data-click/data-change/data-input ↔ handler and `getElementById` ↔
  element-id cross-reference scripts (0 missing, 0 dupes).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v114.

## v341: new "Companion" mascot on the Portfolio Net Worth card

- **New Setting (Setting > 🐾 Companion)**: pick a small optional mascot
  — None (default), Cat, Dog, Hamster, or Rabbit — shown in the Portfolio
  Net Worth card's own right-hand gutter (`.net-worth-container` is
  already `display:flex; justify-content:space-between`, so the new
  `#netWorthCompanion` slot lands there for free, no layout change
  needed). Tapping the mascot on the dashboard jumps straight into
  Setting > Companion, expanded.
- Every pet is original hand-built line-art (`COMPANIONS` in
  `ledger.js`, viewBox 0 0 48 48, stroke=currentColor) drawn in the
  same translucent-white treatment the card's Financial Assets/Real
  Estate chips already use — one asset per pet reads correctly against
  every Net Worth Card Style gradient (Classic/Sunset/Ocean/etc.),
  with no separate light/dark artwork to maintain. Each Settings
  swatch previews the mascot exactly as it renders on the card.
- Persisted to `localStorage` (`ledgerCompanionPetId`), same pattern as
  Net Worth Card Style — applied once on script parse via
  `applyCompanionPet()`, no `renderApp()` involvement needed since the
  slot is static markup like `#netWorthDisplay`.
- No IndexedDB schema/export-import changes (this is a device-local
  display preference, same category as Net Worth Card Style — not
  bundled into Backup & Restore). Verified with `node --check` plus
  the data-click/`getElementById` cross-reference script (0 missing).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v341.

## v342: Companion — added the 12 Chinese zodiac animals

- **Setting > 🐾 Companion** now lists 15 options total: None, then an
  "Other" group (Cat, Hamster — carried over from v341), then a new
  "Chinese Zodiac" (十二生肖) group — Rat, Ox, Tiger, Rabbit, Dragon,
  Snake, Horse, Goat, Monkey, Rooster, Dog, Pig, in the traditional
  cycle order. Dog and Rabbit moved out of the old flat list into this
  zodiac group rather than being listed twice.
- Same original hand-drawn line-art approach as v341 (`COMPANIONS` in
  `ledger.js`, stroke=currentColor) — each animal gets a distinguishing
  ear/horn/snout shape so they read apart at swatch size; Snake is the
  one exception to the "circular head" template (a coiled body + small
  head, since a zodiac snake with cat/dog-style ears wouldn't read as
  a snake).
- **Settings panel now groups the list** under small section labels
  instead of one flat 15-icon grid — `buildCompanionSwatchGrid()`
  reads each entry's new optional `group` field (`"Other"` /
  `"Chinese Zodiac"`; ungrouped = just "None", shown on its own row
  with no heading) and renders one `.companion-swatch-grid` row per
  group under a `.companion-group-label` heading. `#companionSwatchGrid`
  itself is now a plain block wrapper (was itself flex before) so the
  group rows stack vertically instead of wrapping together.
- No storage/behavior change to how a pick is saved or rendered on the
  dashboard (`ledgerCompanionPetId` / `applyCompanionPet()` unchanged)
  — this release only adds more options and a grouped picker UI.
  Verified with `node --check`, the data-click/`getElementById`
  cross-reference script (0 missing), and an XML well-formedness check
  on all 14 new/carried-over SVGs (0 malformed).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v342.

## v343: Companion — upload your own custom image

- **Setting > 🐾 Companion** now has a "＋" tile at the front of the
  "Other" group. Tap it (no image uploaded yet) to open the file
  picker (camera or gallery — same `accept="image/*"` pattern the
  transaction-attachment inputs already use, no `capture` attribute
  since a companion photo is as likely to come from the gallery as
  the camera). Once uploaded, that tile shows the photo itself and
  behaves like any other swatch — tap to select/deselect it as the
  active companion.
- **"🔄 Change photo" / "🗑 Remove"** links appear below the grid once
  an image has been uploaded (hidden entirely before that, so a
  never-used install sees just the "＋" tile). Remove clears the
  stored image and, if Custom was the active companion, falls back to
  None automatically rather than leaving the hero card's slot pointing
  at a deleted image.
- **Reused this app's existing image pipeline** —
  `readFileAsDataUrl()` + `compressImage()` (both already built for
  receipt attachments) — resized to 160px / quality 0.82, small enough
  to comfortably live in `localStorage`
  (`ledgerCompanionCustomImageDataUrl`) alongside every other
  Companion/theme preference on this panel. No CSP change needed —
  `img-src 'self' data:` already covers a data-URL `<img>` (it's the
  same policy that already lets receipt attachments render).
- **Device-local, like the rest of Companion/theme settings** — not
  bundled into the Backup & Restore JSON export (same category as Net
  Worth Card Style, Background Theme, etc.), so a custom photo doesn't
  travel with a backup restored onto a different device.
- No IndexedDB schema/export-import changes. Verified with
  `node --check` plus the data-click/data-change/`getElementById`
  cross-reference script (0 missing).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v343.

## v344: Companion custom image now stretches to fill its box completely

- **Reported via screenshot**: a non-square custom upload left visible
  gaps in the swatch/hero-card box instead of filling it edge to edge.
- **Fix**: both places the custom image renders (the hero card's
  `#netWorthCompanion` slot and its Settings swatch preview) switched
  from `object-fit:cover` to `object-fit:fill` — the image now
  stretches non-uniformly to exactly fill the fixed square box, no
  cropping and no leftover space, at the cost of some distortion on a
  very long/wide source photo. Deliberate trade-off: at this box's
  small size (34px on the dashboard, 48px in Settings), a slightly
  stretched mascot reads better than one with empty corners.
- No change to how the image is read/compressed/stored
  (`readFileAsDataUrl()`/`compressImage()`, `ledgerCompanionCustomImageDataUrl`)
  — display-only fix. Verified with `node --check`.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v344.

## v345: Companion custom image — crop-to-square at upload time (not
stretch at display time)

- **New `cropImageToSquare()`** (`ledger.js`, next to the existing
  `compressImage()`): center-crops the source photo to a square (crops
  the longer axis, centered — a wide photo loses its left/right
  edges, a tall one loses top/bottom) and resizes to 160×160, output
  as PNG (not JPEG like `compressImage()`) so a source image with real
  transparency stays transparent instead of being flattened to black.
- **`handleCompanionCustomImageSelected()`** now calls this instead of
  the aspect-preserving `compressImage()` — every upload is squared up
  once, at upload time, rather than distorted every time it's
  rendered.
- **v344's `object-fit:fill` reverted back to `object-fit:cover`** on
  both render sites (hero-card slot, Settings swatch preview) — the
  stored image is already a perfect square now, so cover/fill produce
  an identical result with zero distortion either way; cover is the
  more correct choice going forward.
- **Note on a reported screenshot**: a checkerboard pattern appearing
  *behind* the uploaded icon (rather than the app's own card
  background showing through) means that checkerboard is baked into
  the source image's own pixels, not real alpha transparency — this
  usually happens when a file was exported, or a screenshot taken,
  from a design tool with its "show transparency grid" preview left
  on. Cropping/PNG-output can't remove pixels that are already opaque
  gray/white squares in the file; re-exporting that source image with
  a genuinely transparent or solid background (then re-uploading)
  is the fix on the content side.
- No IndexedDB schema/export-import changes — still a `localStorage`-
  only device preference. Verified with `node --check`.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v345.

## v346: Companion custom photo now fills its dashboard chip completely

- **Reported via screenshot**: the uploaded photo rendered at a fixed
  34x34 inside the 52x52 chip — same inset sizing as the SVG mascot
  icons — leaving a visible ring of the chip's translucent background
  around it instead of filling the box.
- **Fix**: the custom-image branch of `applyCompanionPet()` now
  renders the `<img>` at `width:100%; height:100%` (border-radius 13px,
  matching the chip's own 14px minus its 1px border) instead of a
  fixed 34px — so a photo now fills the chip edge-to-edge. The SVG
  zodiac/pet icons are untouched (still 34px inset via the existing
  `.net-worth-companion svg` rule) — this only changes how an uploaded
  photo renders, not the built-in icon set.
- The Settings swatch preview already filled its box this way since
  v341 — this brings the dashboard's own chip in line with it.
- Purely a display fix — no change to upload/crop/storage
  (`cropImageToSquare()`, `ledgerCompanionCustomImageDataUrl`).
  Verified with `node --check`.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v346.

## v347: Companion (pet pick + custom image) now travels with Backup &
Restore

Previously Companion was deliberately device-local, like Background
Theme and Net Worth Card Style — stored in `localStorage`
(`ledgerCompanionPetId` / `ledgerCompanionCustomImageDataUrl`), excluded
from the export bundle. Requested: make it carry over to a new device.

- **Moved into the IndexedDB `settings` store** — the same store
  `defaultPaymentAccount`/`recentTxTypeFilter`/etc. already live in —
  under new keys `companionPetId` / `companionCustomImage`.
  `exportBackup()` already dumps this entire store
  (`settings: await readAllDB(STORES.SETTINGS)`, since v65), so both
  values are now included in every export automatically — no bundle
  format change needed.
- **`importBackup()`** writes every `bundle.settings` row back via the
  existing generic `writeDB(STORES.SETTINGS, rec)` call (unchanged),
  then — after every row has been written — calls
  `applyCompanionPet(await getSavedCompanionId(), { save: false })`
  once to repaint the dashboard's mascot slot immediately, instead of
  only taking effect on the next launch. This is a single reapply
  after the whole settings loop, not a per-key `switch` case like most
  other settings here, specifically so it's order-independent: if
  `companionCustomImage` happens to appear after `companionPetId` in
  the bundle array, a per-key case could try to paint "custom" before
  its image was actually in the store yet.
- **One-time migration** (`migrateCompanionPrefsFromLocalStorage()`,
  called from `bootstrap()`): copies a v341-v346 install's existing
  `localStorage` pick/custom image into the new IndexedDB keys once,
  then clears the old `localStorage` entries. No-op on a fresh v347+
  install or once already migrated.
- **Every Companion getter/setter is now `async`** (`getSavedCompanionId()`,
  `getCompanionCustomImage()`, `applyCompanionPet()`,
  `buildCompanionSwatchGrid()`, `selectCompanion()`,
  `toggleCompanionSettings()`, `removeCompanionCustomImage()`,
  `handleCompanionCustomImageSelected()`) — IndexedDB, unlike
  `localStorage`, has no synchronous read. The one-time "apply the
  saved pick" call also moved out of the top-level script-parse code
  (where it ran synchronously before v347, alongside Background Theme/
  Net Worth Card Style) into `bootstrap()`, since it now needs
  `initDB()` to have already run — timing-safe here because the
  mascot slot only ever appears after unlock anyway, never on the lock
  screen itself.
- Background Theme and Net Worth Card Style remain `localStorage`-only
  and still do **not** travel with a backup — that's an intentional,
  unchanged distinction: those are built-in presets already available
  on any install, whereas a custom photo has nowhere else to come
  from.
- Verified with `node --check` plus the data-click/data-change/
  `getElementById` cross-reference script (0 missing).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v347.

## v348: Companion custom photo — save up to 20, pick between them,
remove individually

Previously "Custom" was one fixed slot — uploading a new photo
silently replaced whatever was there before. Requested: save several,
switch between them later, and remove one at a time.

- **New "My Photos" group** in Setting > 🐾 Companion, below the
  built-in Chinese Zodiac/Other icons — shows every photo you've
  saved (up to 20), each as its own selectable swatch, with an
  "＋ Add" tile at the end for as long as there's room. The group
  heading shows a running count, e.g. "My Photos (3/20)".
- **Tap a saved photo** to make it the active companion — switching
  back and forth between saved photos no longer means re-uploading.
- **Each photo has its own "×" badge** (top-right corner of its
  thumbnail) to remove just that one, with a confirmation prompt
  first. If the one you remove was the active companion, it falls
  back to None.
- **At 20 saved photos**, the "＋ Add" tile disappears and tapping an
  already-full library's upload path (shouldn't be reachable, but
  guarded anyway) shows an alert asking you to remove one first.
- **Storage**: replaced the single `companionCustomImage` settings row
  with `companionCustomImages` — one settings row holding an array of
  `{id, dataUrl}`, still in the same IndexedDB `settings` store as
  before, so the whole library continues to travel with Backup &
  Restore (v347) with no further changes needed there. A saved photo's
  Companion pick is now the string `"custom:<photoId>"` instead of the
  old flat `"custom"`.
- **Migration** (`migrateCompanionSingleImageToLibrary()`, called from
  `bootstrap()` right after v347's localStorage migration): anyone
  upgrading from v343-v347 has their one existing custom photo carried
  over automatically as the first "My Photos" entry, with their pick
  remapped from `"custom"` to `"custom:<newId>"` to match. No-op on a
  fresh v348+ install.
- Verified with `node --check` plus the data-click/data-change/
  `getElementById` cross-reference script (0 missing).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v348.

## v349: dropped the "Other" icon group, redrew Snake

- **Removed Cat and Hamster** (the "Other" group) from `COMPANIONS` —
  requested directly. Chinese Zodiac is now the only built-in icon
  group; "My Photos" is unaffected. Anyone who had Cat or Hamster
  selected falls back to None automatically (`getSavedCompanionId()`'s
  existing "unknown id → none" guard, unchanged) — no crash, no
  special-case needed for the removal itself.
- **Redrew the Snake icon** — reported as reading like a squiggly
  string with a blob rather than a snake. Was a single 2px-stroke
  S-curve + a plain circle "head"; now a thick coiled body
  (stroke-width 4.5, vs. the thin 2px outline every other icon's body
  uses) feeding into a distinctly wider head with a visible eye and a
  forked tongue. Still the one exception to the shared "circular head"
  template the other 11 zodiac icons use (noted since v342) — just a
  clearer version of that same exception.
- Verified with `node --check`, the data-click/`getElementById`
  cross-reference script (0 missing), and an XML well-formedness check
  on all 12 remaining zodiac SVGs (0 malformed).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v349.

## v355: Planned Payments (one-off) — key in a bill now, confirm it as
paid later

New feature, requested directly: a way to enter a bill's details the
moment it's in hand, without it posting as a real transaction (and
touching your balance) until you actually pay it.

- **New "🕒 Save as Planned" button** on the ordinary Income/Expense
  entry form, next to Commit Entry — only shown for a brand-new
  Income/Expense entry (hidden for Transfers, Fixed Deposits, Fund
  transactions, and when editing an existing record; one-off only, no
  recurrence for now). Saves everything you typed — amount, category,
  account, due date, notes, attachments — into a new, separate
  `plannedPayments` store instead of posting a transaction, so it has
  zero effect on any account balance or your net worth.
- **New "Planned Payments" dashboard widget** (same visual style as
  Warranty Reminders), listing every saved one sorted by due date,
  with "Xd left" or "Overdue Xd" shown in red. Hidden entirely when
  there's nothing planned. Tapping a row opens a small action sheet:
  **"✅ Mark as Paid"** or **"🗑 Delete"**.
- **Mark as Paid** reopens the *exact same* Income/Expense entry form,
  pre-filled with everything already saved (description, amount,
  currency, account, category, notes, attachments) and the date reset
  to today (adjustable) — review/adjust, then tap the normal Commit
  Entry. It goes through the exact same, already-tested transaction
  save pipeline (`handleTransactionSubmitMobile()`) as any other
  entry; only once that save actually succeeds does the source
  Planned Payment record get deleted
  (`currentPlannedPaymentIdBeingConfirmed`, reset at the top of every
  `openTransactionForm()` call so a cancelled confirm can never
  bleed into some later, unrelated Save).
- **New IndexedDB store** `plannedPayments` (`STORES.PLANNED_PAYMENTS`,
  keyPath `id`, app-generated via `makePlannedPaymentId()`) —
  `DB_VERSION` bumped 10 → 11. Shape: `{ id, type ("income"|"expense"),
  desc, amount, currency, accountId, cat, dueDate, notes, attachments:
  [{id,name,mime,thumb,size}] (same shape/store as transaction
  attachments), createdAt }`.
- **Travels with Backup & Restore** — added to both `exportBackup()`'s
  bundle and `importBackup()`'s restore/clear-before-restore logic,
  same "absent on older backups → skip" pattern every other store
  here already follows.
- Verified with `node --check` plus the data-click/data-change/
  `getElementById` cross-reference script (0 missing).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v355.

## v356: fixed "Save as Planned" crash, blocked Split Expenses on
Planned Payments

- **Fixed crash** — "Save as Planned" failed with `Failed to execute
  'put' on 'IDBObjectStore': Evaluating the object store's key path
  did not yield a value" (reported via screenshot). Cause: v355 added
  the new `plannedPayments` store to `STORES` and to
  `createObjectStore()`'s keyPath setup, but missed a second, separate
  map — `STORE_KEYPATHS`, used only by `encryptRecord()`/
  `decryptRecord()` to know which field is each store's key before
  encrypting everything else. Without an entry there, `encryptRecord()`
  silently dropped the `id` field entirely before the `put()`, which
  is what IndexedDB was actually complaining about. Added
  `plannedPayments: "id"` to `STORE_KEYPATHS` — every store this app
  encrypts needs an entry in *both* places now, not just one.
- **Split Expenses now blocked on Planned Payments** — the screenshot
  that surfaced the crash also had Split Expense rows open on the
  form. A Planned Payment record only has one {cat, amount} pair, so
  saving would have silently dropped every split row beyond the main
  one. "Save as Planned" now checks for split rows first and refuses
  with an explanation, rather than quietly losing data — remove the
  split rows first, or use Commit Entry instead for a split entry.
- Verified with `node --check`.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v356.

## v357: Planned Payments — added recurring

Requested directly, after v355 shipped one-off only. Added on top
without changing anything about how a plain one-off entry behaves.

- **New "🔁 Repeat" toggle** next to "Save as Planned" on the
  Income/Expense entry form — unchecked by default (so nothing about
  a plain one-off entry changes). Checking it reveals "Every [N]
  [Week(s)/Month(s)/Year(s)]" (defaults to 1 month).
- **Storage**: each Planned Payment record gained a `recur` field —
  `null` for one-off (unchanged from v355/v356), or
  `{ freq: "weekly"|"monthly"|"yearly", interval: N }` for recurring.
- **What happens when a recurring one is paid**: same "Mark as Paid"
  flow as before — reopens the entry form prefilled, you review and
  tap Commit Entry. Once that save actually succeeds, instead of
  being deleted (like a one-off), the Planned Payment's `dueDate` is
  advanced by one cycle (`computeNextDueDate()`, via
  `advanceOrDeletePlannedPaymentAfterConfirm()`) and the same record
  is kept — so it reappears in the dashboard widget as the next
  occurrence, rather than needing to be re-entered every time.
- **Deliberately only one record per recurring series** (the next
  occurrence due), not a whole future schedule pre-generated. This
  keeps Delete unambiguous — for a recurring pick, it always means
  "stop the whole series" (the confirmation prompt says so
  explicitly), never "which occurrence?".
- **Dashboard widget**: a recurring entry shows a 🔁 icon (instead of
  🕒) and its cadence, e.g. "(Repeats every month)".
- **Known quirk, not fixed**: monthly/yearly recurrence advances the
  calendar date via JavaScript's own `Date` month/year math, not
  manual day-counting — so e.g. 31 Jan + 1 month lands on 2 or 3 Mar
  in a non-leap year (there's no single "correct" answer for "the
  month you're adding to doesn't have that day"; every calendar-math
  library has some version of this same quirk).
- Verified with `node --check` plus the data-click/data-change/
  `getElementById` cross-reference script (0 missing).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v357.

## v358: recurrence now clamps to month-end (not overflow), and syncs
edited amounts forward

Two changes requested together, both to how a recurring Planned
Payment advances after "Mark as Paid" — no change to one-off behavior.

- **Clamp instead of overflow**: 31 Jan + 1 month now lands on 28/29
  Feb, not 2/3 Mar. `computeNextDueDate()` rewritten — for
  monthly/yearly, it now finds the target month's actual last day
  (`new Date(year, month, 0).getDate()`, the standard "day 0 of next
  month" trick, which handles leap Februaries for free) and clamps the
  day to it, rather than letting the `Date` object roll the overflow
  into the following month. Only days 29-31 are affected — every due
  date on the 1st-28th advances identically either way, so this is a
  pure fix for the month-end case, not a behavior change for most
  bills. Weekly is untouched (exact day-arithmetic, nothing to clamp).
  Matches how Google Calendar and Apple Reminders both handle a
  recurring monthly/yearly event.
- **Edited fields now carry forward, not just the date**: previously,
  advancing a recurring payment only touched `dueDate` — every other
  field stayed frozen at whatever it was when first created, even if
  you'd just edited the amount (rent went up) on the Mark as Paid
  form before confirming. `advanceOrDeletePlannedPaymentAfterConfirm()`
  now re-syncs desc/amount/currency/accountId/cat/notes from what was
  actually just posted, since Mark as Paid already shows every field
  for review right before confirming — that review *is* the "edit this
  series" action, rather than needing a separate one. Attachments are
  deliberately NOT carried forward (this occurrence's receipt is
  already on the transaction that just posted; the next one starts
  with none, like any other future Planned Payment).
- Verified with `node --check`, the data-click/data-change/
  `getElementById` cross-reference script (0 missing), and a standalone
  unit test of `computeNextDueDate()` against 8 cases (leap years,
  year-boundary rollover, month-end clamping, plain mid-month dates,
  weekly) — all passing.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v358.

## v359: fixed anchor-drift in month-end clamping (recurring Planned
Payments)

v358's clamp-to-month-end fix had a bug of its own, caught before it
reached most users: it clamped using the day from the *previous
step's already-clamped result*, not the originally-intended day — so
after one clamp, the "31st" (or "29th", etc.) intent was gone for
good: `1/31 → 2/28 → 3/28 → 4/28...`, permanently stuck on 28 instead
of `1/31 → 2/28 → 3/31 → 4/30 → 5/31 → 6/30`. Same *category* of bug
as the original overflow issue, just relocated.

- **New `recur.anchorDay`** (1-31), set once at creation
  (`savePlannedPaymentFromTxForm()`) from the due date's own
  day-of-month, and never touched by clamping — only a genuine future
  "edit this series' schedule" action should ever change it (no such
  action exists yet; Mark as Paid's date field only sets the
  just-posted transaction's date, it doesn't reschedule the series).
  `computeNextDueDate()` now clamps against this fixed anchor every
  step, not against whatever the previous step landed on.
- **Semantics**: a clamp is a one-off calendar accommodation, not a
  change of intent — so 1/29 monthly correctly goes `1/29 → 2/28 (clamped)
  → 3/29 (back to the real anchor)`, not stuck at 28 forever.
- **Backward-compatible**: a v357/v358 recurring payment (predates
  this field) gets `anchorDay` backfilled once, the first time it's
  advanced post-upgrade, from its current `dueDate`'s day — the best
  reconstruction available, since there's no record of what day it
  was originally created on.
- Verified with `node --check`, the data-click/data-change/
  `getElementById` cross-reference script (0 missing), and two new
  standalone tests: a 6-step chain from 1/31 (asserts the full
  sequence, not just one hop) and the 1/29 re-anchor case — both
  passing.
- **Worth knowing, not changed**: v358 already made every edited field
  (not just the date) carry forward to the next occurrence when
  confirming a recurring payment — e.g. rent going up. That's a
  deliberate design choice, not an oversight: the model is "whatever
  you confirmed with = the series' new normal." If a one-off anomaly
  (a late fee, a one-time surcharge) gets edited in at confirm time,
  it'll carry forward the same way a genuine rent increase would —
  there's no separate prompt distinguishing the two, since asking
  every time would undercut the "just glance and confirm" speed this
  whole feature is for.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v359.

## v360: Planned Payments — Edit Series, Pause/Resume (closes the
feature's lifecycle)

Requested directly, to close a gap in v359: a recurring payment's rule
(frequency/interval/anchor day) was fixed at creation with no way to
change it afterward, and there was no way to temporarily suspend a
series without deleting it outright.

- **New "✏️ Edit Series"** action (recurring payments only) — a
  dedicated small modal for the recurrence RULE itself: frequency,
  interval, and Next Due Date. Deliberately separate from the full
  Income/Expense form Mark as Paid uses — this is about rescheduling
  the series, not any one occurrence's amount/category/account.
  Editing "Next Due Date" here is a genuine manual reschedule, so
  (per this feature's own anchoring rule — clamping never moves the
  anchor, only a real manual edit should) it re-anchors the series to
  that new day, and clears any earlier auto-guessed `anchorDayBackfilled`
  flag since it's now a value the person actually set.
- **`anchorDayBackfilled` flag** — v359's one-time backfill for a
  pre-v359 record now sets this alongside the guessed `anchorDay`.
  Edit Series shows a warning banner when it's set ("this was
  estimated automatically — double-check Next Due Date"), since a
  guessed anchor had no correction path before this version except
  deleting and re-creating the whole payment.
- **New "⏸ Pause" / "▶️ Resume"** (recurring payments only) — for a
  temporary hold (a trip, a paused subscription) without losing the
  series. A paused entry sorts to the bottom of the widget, dimmed,
  labeled "⏸ Paused" instead of a due-date countdown, and "Mark as
  Paid" is hidden for it (nothing's actually due right now). Resuming
  fast-forwards a dueDate that fell into the past while paused up to
  the next occurrence from today (capped at 1000 steps as a pure
  runaway-loop safety net), rather than surfacing a false "Overdue
  180d" the moment it's unpaused.
- One-off payments are unaffected — Edit Series and Pause both only
  ever apply to a recurring payment; a one-off simply doesn't show
  those buttons in the action sheet (`plannedPaymentRowTap()` now
  computes each button's visibility per-payment, every time it opens).
- Verified with `node --check`, the data-click/data-change/
  `getElementById` cross-reference script (0 missing), and a
  standalone test of the resume fast-forward loop.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v360.

## v361: Planned Payments — moved to its own sidebar page; Dashboard
now only shows what's due within 3 days

Requested directly: narrow the Dashboard widget to near-term items
only, and give everything else (further out, or paused) a proper home
instead of just disappearing.

- **New sidebar entry "🕒 Planned Payments"** — a full list page
  showing every saved payment, however far off, including paused ones
  (`getAllPlannedPayments()` already sorts paused to the bottom; this
  page just doesn't filter by date at all). No "+" button on this
  page — a Planned Payment is still only ever created from the
  Income/Expense entry form's "🕒 Save as Planned" button. Rows reuse
  the exact same tap → action-sheet flow as the Dashboard widget
  (`renderPlannedPaymentRowHtml()`, now shared by both instead of
  duplicated).
- **Dashboard widget narrowed**: only shows an entry that's due within
  3 days or already overdue — anything further out, and anything
  paused (regardless of date), no longer appears there at all. The
  widget's title is now a link to the new full page (same pattern as
  Warranty Reminders → Inventory).
- **New `refreshPlannedPaymentsViews()`** — every action that changes
  a Planned Payment (save, pause, resume, edit series, delete, mark
  as paid) now calls this instead of refreshing the Dashboard widget
  directly, so the full list page stays in sync too on the occasions
  it's the one actually on screen when the change happens.
- Verified with `node --check` plus the data-click/data-change/
  `getElementById` cross-reference script (0 missing).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v361.

## v362: fixed blank Planned Payments page

- **Fixed**: opening Planned Payments from the sidebar showed a
  completely blank screen (reported via screenshot). Cause:
  `showPage(id)` only toggles visibility for pages listed in a
  hardcoded `APP_PAGE_IDS` array — v361 added the new
  `page-plannedpayments` container and its sidebar entry, but never
  added it to this array. The practical effect was worse than "does
  nothing": `showPage()` still hid every *other* known page (since
  none of them equal `"page-plannedpayments"`), while never revealing
  the new one (since it isn't in the array `forEach` iterates), so
  the result was every page hidden and nothing shown at all.
- **Also fixed**: the hardware/browser Back button handler has its
  own separate hardcoded "which page is currently open" check (a
  second, independent list from `APP_PAGE_IDS`) — same gap, same fix.
  Pressing Back from Planned Payments would previously have matched
  no branch and done nothing.
- Also added the missing case to `getActivePageTitle()` (used for the
  printed-document header and PDF filename while printing) —
  cosmetic, not the cause of the blank screen, but the same category
  of "forgot to add the new page id to an existing hardcoded list."
- Takeaway for future new pages in this codebase: adding a page needs
  updating at least 3 separate hardcoded lists (`APP_PAGE_IDS`, the
  popstate Back handler's page-detection block, `getActivePageTitle()`)
  — not just the sidebar button + page container + navigate function.
  Verified this time by grepping every existing reference to a sibling
  page id (`"page-inventory"`) and confirming each one now has a
  matching Planned Payments entry.
- Verified with `node --check` plus the data-click/`getElementById`
  cross-reference script (0 missing).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v362.

## v363: fixed Mark as Paid / Edit Series / Delete opening behind the
Planned Payment action sheet

- **Fixed** (reported via screenshot): tapping "✅ Mark as Paid" opened
  the transaction entry form, but the action sheet (Mark as Paid /
  Pause / Edit Series / Delete / Cancel) stayed stuck on top of it
  instead of closing. Root cause: `closeModal()` doesn't actually
  remove a modal's "active" class immediately — it triggers
  `history.back()` and waits for that `popstate` event to do the
  actual removal, one tick later (this is documented on `closeModal()`
  itself, and there's an existing helper — `closeModalAndThen()` —
  built specifically for this: "closing a modal, then handing off to
  a freshly-opened one"). `confirmPlannedPaymentFromActionsModal()`
  used a plain `closeModal()` immediately followed by
  `openTransactionForm()` instead of that helper, so the new form
  opened underneath a still-visually-active action sheet.
- Same fix applied to **"✏️ Edit Series"** (`openEditPlannedSeriesModal()`)
  and **"🗑 Delete"**'s confirmation prompt
  (`deletePlannedPaymentFromActionsModal()`) — both had the identical
  pattern and the identical latent bug, just not yet reported.
  Pause/Resume were already safe — neither opens another modal
  right after closing this one, so there was nothing for them to race
  against.
- Verified with `node --check` plus the data-click/`getElementById`
  cross-reference script (0 missing).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v363.

## v369: fixed "Split Total" showing the previous entry's amount right
after opening a new transaction form

- **Fixed** (reported via screenshot): committing a plain (non-split)
  Income/Expense entry, then opening a fresh "+" entry form right
  after, briefly showed the *previous* entry's amount in the
  "Split Total: RMxx.xx" line even though `#txAmount` itself was
  correctly blank and nothing about the actual split rows/save logic
  was affected.
- **Cause**: `openTransactionForm()` calls `resetTxSplitRows()` (which
  clears the split rows AND recalculates the Split Total display) near
  the very top of the function — *before* `#txAmount` is cleared (new
  entry) or set to the record's own amount (editing), further down in
  the same function. So the recalculation baked in whatever amount was
  still sitting in the field from the previous time the form was open.
- **Fix**: added one more `recalcTxSplitTotal()` call at the end of
  `openTransactionForm()`, once `#txAmount` holds its final value for
  this open, so the displayed Split Total always reflects the current
  entry rather than a stale leftover.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v369.

## v370: added Vietnamese Dong (VND) as a held currency

- **Added** `VND` to the default currency set: `fxRates`,
  `HELD_CURRENCIES`, and `DEFAULT_FX_RATES_BY_CURRENCY` (placeholder
  ≈6,440 VND per 1 MYR — edit the real value any time via Sidebar →
  Settings → Global Currency Settings → Save FX Values, or "🔄 Fetch
  Live Rates"). `mergeInDefaultCurrencies()` picks it up automatically
  on next load for existing installs, same as every other held
  currency — no separate migration needed.
- Also added a `₫` symbol entry for VND to both `currencySymbols`
  (amount formatting) and `CURRENCY_ICON_GLYPHS` (the round coin icon
  used on Multi-Currency account rows), plus a dedicated red/gold
  `CURRENCY_BADGE_COLORS` entry so its flat badge/coin never falls
  back to the generic hash-based palette.
- The "Add Account" currency `<select>`, per-transaction Currency
  field, and the Currency Settings FX-rate form are all populated
  dynamically from `fxRates`/`HELD_CURRENCIES` already, so VND appears
  in every one of them automatically — no additional hardcoded
  `<option>` lists needed.
- Left the small 5-currency "Main Base Currency" `<select>` (USD/EUR/
  GBP/SGD/MYR) as-is — that's a deliberately short curated shortlist
  and already doesn't include most other held currencies (HKD, CNY,
  TWD, THB, KRW, JPY, BND) either, so VND not being offered as a base
  currency matches existing behavior rather than being an oversight.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v370.

## v371: added a third dark Background Theme, "尊爵黑金" (Black & Gold)

- **Added** a new full-override dark preset to `BG_THEMES` (ledger.js),
  id `"noir"`, name `"尊爵黑金"` — sits between 暗夜描边/midnight and
  蠟筆小新/crayon in the Background Theme swatch grid. Warm near-black
  page/card background (not midnight's cool blue-black), off-white
  text with a gold tint, and an antique-gold `primary` color
  (`#d4af37`) carried through borders, hover/active states, chips, and
  the settings-page hardware slider fill/track — so the gold reads as
  the preset's identity rather than a single accent bolted onto
  midnight. `incomeColor`/`expenseColor`/`transferColor`/`salaryColor`
  keep the same hues used by every other dark preset, so category
  meaning stays consistent across themes.
- **Auto (day/night) support**: added `"noir"` to `BG_THEME_DARK_IDS`,
  so it's picked up automatically everywhere that array already gates
  dark-preset behavior (`isDarkBgThemeId()`, `applyBgTheme()`'s
  auto-dark-id bookkeeping) — tapping the new swatch, any time, sets
  it as Auto's dark side exactly like 暗夜描边/Slate already did, no
  separate wiring needed.
- **Pre-first-paint mirror**: added a matching `NOIR_THEME` object to
  `theme-init.js` (which can't reach `ledger.js`'s `BG_THEMES` — it
  runs before that file loads) and extended its Auto-dark resolution
  from a 2-way `slate`-or-`midnight` check to a 3-way check including
  `noir`, so Auto correctly no-flash-applies Black & Gold on relaunch
  when it's the remembered dark pick.
- Updated the Setting page's Background Theme helper text
  (index.html) to name all three dark presets instead of just the
  first two.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v371.

## v372–v377: Monthly Trend detail table under the Dashboard chart

- **Added** a Month/Income/Expense/Balance detail table under the Dashboard's
  Monthly Trend chart, with a bold Total row and a small Companion avatar
  next to the title (v372).
- **Fixed**: the table's expanded/collapsed state now persists across
  sessions instead of silently re-collapsing every time the page is
  revisited (v373).
- Default state now depends on device: collapsed on first visit on phone,
  expanded on tablet/desktop — once manually toggled anywhere, that choice
  is remembered on every device from then on (v374).
- Narrow-phone layout iterated twice: first switched to a stacked-by-month
  layout to stop the Balance column being clipped (v375), then to a
  middle-ground layout — Month/Income/Expense on one row, Balance dropped to
  its own row (v376) — before v377 settled on the final fix: keep all four
  columns on one row, drop the "RM" text from each cell, and add a single
  "Figures in RM" caption under the table. That fully resolved the
  narrow-screen clipping without sacrificing at-a-glance comparison.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v377.

## v378: Total Bill Summary — frozen Period column

- **Changed**: the Total Bill Summary report's "Period" (year) column is now
  frozen to the left with a solid background and shadow divider, so it
  stays visible while scrolling horizontally through Income/Expense/Balance
  — no more losing track of which year a row belongs to.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v378.

## v379: account logos

- **Added** a "Logo" field (Upload/Remove + preview) to Add/Edit Account —
  upload a real bank/institution icon, auto-cropped to a square. Anywhere
  an account previously showed a letter-gradient badge (e.g. "H", "P",
  "R"), it now shows the uploaded logo instead once set; accounts without a
  logo keep the existing letter badge unchanged. Logos travel with
  encrypted Backup & Restore export/import.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v379.

## v380: new Background Theme — "Liquid Glass"

- **Added** a new preset to the Background Theme swatch grid, right after
  蠟筆小新/Crayon: a static (non-animated) soft blue/pink/mint gradient
  background (`background-attachment: fixed`, so scrolling adds no extra
  rendering cost). The glass blur/saturation effect is applied only at the
  container level — report cards, statement cards, stat boxes, and the
  existing frosted nav/sidebar/modals — deliberately not on repeating
  per-row elements like transaction rows or settings list rows, to avoid
  jank from too many blurred elements at once. Modals keep a relatively
  high opacity (0.90) rather than full transparency, to avoid
  reintroducing the "stacked semi-transparent modals" contrast problem
  fixed earlier.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v380.

## v381: fixed the transaction modal overflowing the screen when Repeat +
Save as Planned both show

- **Fixed**: adding a new Income/Expense entry, once both the "🔁 Repeat"
  and "🕒 Save as Planned" buttons appeared, pushed the modal's action area
  tall enough that the whole modal overflowed the screen height, with the
  extra content rendering wherever and overlapping the date row.
- **Cause**: the modal had no `max-height` at all.
- **Fix**: matched the existing template-picker modal's pattern (75vh) —
  added `max-height: calc(100vh - 32px)`, so the middle content area now
  shrinks and scrolls independently while the bottom action bar stays
  pinned and is never pushed off-screen.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v381.

## v382–v385: Monthly Trend Mascot (independent of Companion)

- **Added** a new "Monthly Trend Mascot" picker under Setting → Companion,
  defaulting to "Match Companion" (🔗 — keeps the existing behavior of
  mirroring the Net Worth card's mascot). Picking a different zodiac
  animal/photo/None lets the icon next to the "Monthly Trend" title differ
  from the Net Worth card's. Both pickers share the same up-to-20-photo
  library; the "+ Add" upload entry point stays only on the Companion panel
  to avoid a duplicate entry point, but a photo uploaded from either panel
  is selectable from both (v382).
- **Fixed**: the two new buttons were never registered in the
  `CLICK_ACTIONS` dispatch table, so they did nothing at all (v383).
- **Fixed**: the Monthly Trend Mascot panel was missing its "×" delete
  button, and having both panels open at once meant uploading a photo only
  refreshed the Companion side's count, leaving the two panels showing
  different totals ("12/20" vs "11/20") (v384).
- v385 merged Companion and Monthly Trend Mascot into a single settings
  page with a top Tab switch (Net Worth Card / Monthly Trend) — still two
  independent settings underneath, just sharing one photo-library editor;
  the two Dashboard shortcut links each land on their own matching tab.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v385.

## v386–v387: Monthly Trend gets its own Reports page

- **Added** a "Monthly Trend" entry to the sidebar's Reports section, next
  to Total Bill Summary. Rather than duplicating a second chart, navigating
  there physically moves the existing Dashboard Monthly Trend block (year
  picker, auto-scaling, Companion avatar, collapsible detail table, and all
  of its state) into the report page, and moves it back on the way out —
  avoiding two independently-drifting render paths. The chart is
  re-measured and redrawn against the report page's own width on entry.
  Setting → Dashboard Widgets gained a "Show on Dashboard" toggle for
  Monthly Trend (on by default) — turning it off only affects whether it
  shows on the Dashboard; the report page itself is always reachable. This
  setting is included in Backup & Restore.
- v387 reordered the Dashboard Widgets panel sections to Monthly Trend →
  Budget Widget → Order on Dashboard → Recent Transactions Widget →
  Accounts Widget, per a screenshot — display order only, no change to any
  section's id/logic/saved settings.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v387.

## v388: fixed misaligned columns across Unit Trust fund-group tables

- **Fixed**: each fund group (ASNB/HLAM/HSBC/PUBLIC MUTUAL etc.) rendered
  as its own separate `<table>`, so the browser computed column widths
  independently per table — identical headers ended up different pixel
  widths across groups and didn't line up vertically.
- **Fix**: every fund detail table now shares `table-layout: fixed` and a
  common `<colgroup>` (34/18/18/18/12%), so Fund/Value/Invested/P&L/Return
  line up across every group. Side effect to watch for: combined with the
  existing `white-space: nowrap`, an unusually long fund name or number may
  now clip instead of auto-widening the column.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v388.

## v389–v407: Setting page navigation — the icon-rail rebuild

19 versions of continuous iteration on how the Setting page navigates —
the abridged sequence:
- v389: Setting's home screen becomes a 4×4 grid of icon-only buttons (no
  more text rows); the six items that used to expand inline (Background
  Theme/Net Worth Card Style/Companion/Monthly Trend Mascot/Dashboard
  Widgets/Default Accounts) each became their own full page.
- v390: fixed the inner "‹ Back" wrongly jumping to the Dashboard instead
  of back to the icon grid.
- v391–v392: icon grid replaced with a persistent single-column left rail;
  tapping any icon swaps the detail pane on the right without needing to
  back out first.
- v393: added the long-missing explicit `<link rel="icon">` declaration,
  fixing an intermittently-missing browser tab icon.
- v394–v395: folded Manage Members/Categories/Templates/Tags/Backup/
  Auto-Lock/Database and the rest into the same left-rail system — all 13
  Setting sub-pages' "← Back" now goes straight to the Dashboard in one
  step (no more stopping at a Setting landing page first); hardware/gesture
  back updated to match.
- v396: icon rail and detail pane now scroll independently of each other.
- v397: merged Companion and Monthly Trend Mascot into one page behind a
  single icon entry.
- v398: gave each Dashboard Widgets section its own card styling.
- v399–v402: folded Default Accounts, Lock App Now/Reset App Data, and
  Manage Members/Backup & Restore/Auto-Lock into the Setting home page or
  other pages' inline sections, steadily trimming the number of icon-rail
  entries.
- v403–v404: merged Net Worth Card Style and Companion into one "Net Worth
  Card" page; gave Default Accounts/Default Category their own card
  styling.
- v405: converted the last remaining popup-style setting (Currency
  Setting, previously a modal) into a full page matching everything else.
- v406–v407: added a "current page" highlight to the icon rail (first a
  highlight ring, then unified into the same left color-bar + fill
  treatment used elsewhere, so the "where am I" language matches across
  the app) — the Setting home page itself is deliberately left with
  nothing highlighted, since no single icon represents "you're on the home
  screen."

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v407.

## v408–v411: narrow-screen layout fixes across the settings pages

A chain of fixes for phone-width layout problems on settings-style pages
(Categories/Templates/Accounts, etc.).
- v408: added `min-width: 0` to every two-column form row to stop a long
  account name from breaking the two-column layout; Default Accounts card
  switched to a single full-width stacked style so long account names no
  longer got truncated.
- v409: found the actual root cause of "one page's content getting
  unexpectedly wide drags every row on the page sideways, and the offset
  carries over to the next settings page visited" — several settings
  sub-pages share a `.settings-page-content` container that only
  explicitly set `overflow-y: auto`, letting the browser silently treat
  the horizontal axis as scrollable too. Fixed by explicitly adding
  `overflow-x: hidden`, closing off that scroll axis entirely.
- v410: in "label + action buttons" rows, the text label can now
  shrink/wrap freely while the button group (✏️📊🗑️ etc.) never shrinks, so
  a long category/template name can't squeeze the buttons out.
- v411: when the label and button group still don't fit on one line, the
  button group now wraps to its own line, right-aligned
  (`flex-wrap: wrap`), so neither element crowds the other when space is
  tight — rows with enough room are unaffected and stay single-line.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v411.

## v412: fixed credit card "due soon" reminders using the wrong billing
cycle

- **Fixed**: the Dashboard's "due soon / due today" credit card reminder
  was showing the card's total current balance instead of the amount
  actually due for that billing cycle — only the "overdue" banner was
  doing the correct per-cycle calculation; "due soon" had quietly
  regressed to using the total balance. Now both reminders share the same
  billing-cycle calculation as the overdue banner, so spending in a
  different cycle no longer gets miscounted into the wrong due-date
  reminder. The dateless "💳 Amount due" line on the Accounts/Member pages
  is unaffected and still shows the total balance, as intended.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v412.

## v413: shared credit limits across linked cards

- **Added** "🔗 Shares Credit Limit With" for credit card accounts —
  editing a card lets you point it at another existing card to share one
  limit pool. Only the primary card (e.g. Visa) has a real Credit Limit
  entered; the secondary card (e.g. Mastercard) selects "Shares Credit
  Limit With" pointing at the primary, and its own limit field is
  cleared/ignored. Both cards display the primary card's limit, labeled
  "(shared)"; Available is computed as limit minus the combined current
  balance of every card in the group, so paying down either card updates
  both cards' Available figure. Each card's own "💳 Amount due" billing
  balance is unaffected and still shown separately.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v413.

## v414: Gold investment accounts

- **Added** support for gold holdings — bank gold accounts (e.g. Maybank
  GIA, PBB GIA) and physical gold (916, 999, etc.), tracked in **grams** at
  a **manually updated** price per gram; buys use the bank's sell price,
  valuation uses the bank's buy price (the buy/sell spread shows up as a
  real unrealized loss on day one — that's expected, not a bug).
- **Implementation**: gold is not a separate system — a gold holding is
  just a Fund record with `category: "Gold"` (`units` repurposed as grams,
  `currentNav` repurposed as price/gram in RM), so it inherits every
  existing Fund mechanism for free: Net Worth rollups, the Activity page,
  Portfolio Report, backup export/import, auto-generated buy/sell
  transfers, and the existing total-cost-basis Invested/Recovered/P&L
  formula. Each bank/purity combination (Maybank GIA, PBB GIA, 916
  physical, 999 physical, etc.) gets its own independent Fund record with
  its own buy price — never mixed together.
- Four gold-specific pieces: (1) new gold holdings get a `gold_`-prefixed
  id instead of `fund_` (namespace only, makes it easy to tell gold and
  real funds apart later); (2) new `fund.priceUpdatedAt` field, stamped
  whenever `currentNav` changes (recorded for every fund, but only shown
  for gold) driving a "priced Xd ago" staleness badge (turns red after 2+
  days) on the Fund Holdings table, Fund Activity page, and Edit Fund
  modal; (3) selecting Category "🪙 Gold" reshapes the form
  (`handleFundCategoryChange()`): Fund Code → "Purity / Source", Current
  NAV → "Today's Price (RM / gram)"; the fund-transaction modal
  (`handleFundTxFundChange()`) drops Type down to just Buy/Sell (no
  Dividend/Contribution), and relabels Units → Grams, Price per Unit →
  Price per Gram; (4) gold transactions are deliberately **not editable in
  place** (a clear v1 rule, to avoid silently drifting from what was
  actually paid at the bank/shop) — `openTransactionForm()`'s `tx.fundId`
  branch routes through the existing `handleFundTxRowTap()` "delete and
  re-enter" confirmation via `isGoldFund()`, for gold only.
- **Deliberately not done yet** (discussed and deferred): live price
  fetching (kept manual, since valuation here means "what the bank/shop
  will pay today," which an online spot price can't substitute for — also
  avoids touching the CSP); splitting out a separate fee field (annual
  fees are just recorded as an ordinary ledger expense for now, doesn't
  affect holding P/L); price-trend sparkline / multi-holding summary card
  (manually-entered data is too sparse right now; `NAV_HISTORY` already has
  what a trend view would need, revisit later); a separate realized-P/L
  figure (uses the same total-cost-basis formula, realized + unrealized
  combined into one P/L number — acceptable for v1).

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v414.

## v415: three follow-up display fixes for Gold accounts

- **Fixed**: after actually creating Public Gold / PBB Gold accounts,
  three problems turned up:
  1. The accounts list still showed the yellow "Unit Trust" badge — added
     a "Gold" sub-group to `ACCOUNT_SUBGROUPS["Investment"]`, unified the
     two rendering call sites into one `accountTypeBadgeHTML(a)` that
     shows 🪙 Gold whenever `account.subgroup === "Gold"` (the underlying
     `account.type` stays `unittrust`, no other logic affected).
  2. Add/Edit Account's Sub-Group dropdown had no Gold option — added (the
     sidebar's type-shortcut entries, generated from `ACCOUNT_SUBGROUPS`,
     picked it up automatically); Net Worth Statement also gained its own
     "Gold" row (`sumGroup("Investment", ["Gold"])` + `nwsRow`) instead of
     being folded into Unit Trust.
  3. The Fund Activity page's individual transaction rows still said
     "units" (v414 only updated the holdings table and the top summary
     strip) — now uses `isGoldFund(fund)` the same way, and shows grams.
- **Manual step needed**: gold accounts created back during v414 (before
  the Gold sub-group existed) are still filed under Unit Trust — open Edit
  Account and change Sub-Group to Gold to get the new badge and have it
  counted in the Net Worth Statement's Gold row; no data is lost in the
  meantime.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v415.

## v416: Daily NAV Update — separate Gold from Unit Trust

- **Added** an All / 📊 Unit Trust / 🪙 Gold filter to the top of the Daily
  NAV Update page (`navUpdateCategoryFilter` +
  `setNavUpdateCategoryFilter()`), since gold and fund prices get updated
  on different schedules and mixing them into one batch update made it
  easy to accidentally re-save a price that wasn't meant to be touched. The
  filter row only appears when both types are actually held — no point
  showing it otherwise. Selecting Gold limits the Card/Table view to gold
  holdings only, and "Update All Prices" only saves those records —
  `handleSaveAllNav()` itself didn't need to change, since it already just
  iterates whatever list got filtered.
- **Fixed** a v414 carryover bug along the way: `handleSaveAllNav()` — the
  button actually used day to day to update gold prices — never wrote
  `fund.priceUpdatedAt`; only the Add/Edit Fund modal's save path did, so
  the "priced Xd ago" badge never moved during normal day-to-day price
  updates from this page. Now saving a price here stamps the timestamp
  too, for any fund whose price actually changed.
- The History view was deliberately left unfiltered at this point
  (read-only, seemed low-risk) — v417 revisited that call.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v416.

## v417: Daily NAV History follows the filter + fund-name abbreviations

- **Fixed**: v416 filtered the Card/Table view but not History — selecting
  Gold there still showed fund columns. History now follows
  `navUpdateCategoryFilter` too: columns are limited to the matching
  category (by `fund.category`; a deleted fund with no live record falls
  back to checking its `gold_`/`fund_` id prefix), and any date with no
  updates at all for that category is dropped from the table entirely
  (instead of leaving a row of all dashes).
- **Added** `fundHistoryAcronym()` for long Unit Trust fund names in the
  History column headers (e.g. "Asia Pacific Equity Income" → "APEI"),
  since full names made the table too wide; name collisions get a numeric
  suffix ("HGF"/"HGF2"); the full name is kept in the column header's
  `title` attribute for hover/long-press. Gold fund names are left as-is —
  names like "PBB Gold" are already short, and abbreviating them would
  make it harder to tell which bank they belong to.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v417.

## v418: Reminders

- **Added** a Reminders feature for tracking recurring renewal dates —
  passport, driving license, PR renewal, credit card expiry, insurance,
  etc. New `REMINDERS` object store, going through the same
  PBKDF2+AES-GCM encryption, backup export/import, and Service Worker
  cache-version bump as every other store.
- **Entry point / scope**: new "🔔 Reminders" sidebar item, alongside
  Inventory and Planned Payments. All reminders share one unified list —
  deliberately not split by family member (unlike accounts/funds), a
  conscious choice.
- **Fields per reminder**: Name (required), Category, Issue Date
  (optional), Due/Expiry Date (required), "Remind Me" lead time
  (`leadDays`, set per reminder, default 90), a "This renews / repeats"
  toggle plus Renews Every (months, `recurMonths`, default 12 — commonly
  adjusted per document type: passport ~60–120, driving license ~72–120,
  credit card ~36, insurance ~12), and Notes.
- **Dashboard widget** (`renderRemindersWidget()`): only shows a reminder
  once it enters *its own* `leadDays` window or is overdue (archived ones
  never show); sorted by due date; the whole block hides itself when
  nothing qualifies; the title is tappable through to the full list.
- **Full list page** (`renderRemindersPage()`): Active/Archived tabs, a
  floating "+" to add directly (unlike Planned Payments, a reminder isn't
  derived from another form). Dashboard and the list page share one
  `renderReminderRowHtml()`, differing only in which reminders get passed
  in; every change goes through `refreshRemindersViews()` to keep both in
  sync.
- **Tapping a row** opens an action menu: ✅ Mark as Renewed (recurring
  only) / 📦 Archive (one-off only) / ↩️ Restore (archived only) / ✏️ Edit /
  🗑 Delete (double-confirm).
- **Renewal flow**: Mark as Renewed opens a confirmation screen rather
  than silently changing the date — it shows the old due date, defaults
  Renewal Date to today, and pre-fills New Due Date as "renewal date +
  `recurMonths`" (`computeReminderNextDueDate()`); both dates are still
  editable before saving. The calculation anchors on the **renewal date**,
  not the old due date, so renewing late (or a document whose cycle starts
  from its issue date) doesn't skew the next due date. On save, Issue Date
  becomes the renewal date, Due Date becomes the new due date, and (old
  due date → new due date → renewal date) is appended to that reminder's
  `history` array rather than overwriting anything — currently stored but
  not yet surfaced in any UI.
- One-off reminders (unchecked repeat — visas, event registrations) have
  no "Renewed" action; once handled, they're Archived, and can be Restored
  later.
- Tested end-to-end in a headless browser (add, dashboard filtering,
  renewal date math, archive/restore, and that data survives
  lock/reload/unlock still encrypted) — caught and fixed one real bug
  along the way: the new store was missing from `STORE_KEYPATHS`, which
  broke saving entirely.
- **Known limitation**: the app is fully offline with no backend, so
  reminders only ever surface as a dashboard widget/badge *while the app
  is open* — there's no way to push a notification while the app is
  closed.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v418.

## v419: Unit Trust Portfolio — added Current Invested / Recovered

- **Added** Current Invested and Recovered figures to the Portfolio
  report, after user confusion that "Total Invested + P/L ≠ Portfolio
  Value." The math was never wrong — P/L is a **total-return** figure
  (`P/L = current value + recovered − invested`, the same total-cost-basis
  method from v43), and Total Invested only ever accumulates Buys and
  never shrinks on a Sell, so it still includes money that's already been
  taken back out.
- `renderPortfolioReportPage()` now also accumulates `totalRecoveredBase`
  alongside `totalInvestedBase` while summing per-fund (also run through
  `convertCurrency(..., f.currency, baseCurrency)`, so the identity still
  holds exactly under multiple currencies), and displays **Current
  Invested = Total Invested − Recovered** (`portfolioCurrentInvestedTotal`
  / `portfolioRecoveredTotal`). With this, `Current Invested + P/L =
  Portfolio Value` holds exactly. Return is still P/L ÷ Total Invested,
  unchanged. The page now spells out both identities directly. Known edge
  case, left as-is: once a fund's principal is fully recovered with a
  profit, Current Invested can go negative — mathematically correct, not
  specially handled.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v419.

## v420: Fund Detail / Fund Holdings — added a Current Inv. column

- **Added** the same fix at the per-fund level: the Fund Detail table
  (Portfolio page) and `renderFundHoldingsTable()` (account page) both
  gained a **Current Inv.** column between Invested and P/L (= invested −
  recovered, so a single fund now satisfies `Current Inv. + P/L = Value`),
  covering live fund rows, deleted-fund ("fund deleted") orphan rows, and
  the Total row; the header carries a `title` tooltip explaining it.
- Fund Detail's `<colgroup>` changed from v388's 34/18/18/18/12% to
  24/17/17/17/15/10% (kept `table-layout: fixed` so per-account-group
  columns still align) and gained `min-width: 680px`, so on narrow screens
  the outer container scrolls horizontally instead of squeezing numbers
  into clipped cells.
- A deleted fund has no real live price, so its Value was already
  cost-estimated; its Current Inv. equals that same estimated Value, and
  P/L still shows "-".

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v420.

## v421: Unit Trust Portfolio header redesign (fully theme-aware)

- **Redesigned** the six flat stat boxes at the top of the Portfolio
  report into a "lead with the conclusion" layout: a large **Portfolio
  Value** with a return-rate badge in the top-right corner
  (`portfolioReturnBadge`, ▲ green when positive, `.down`/▼ red when
  negative), the equation `= Current Invested + Profit / Loss` spelled out
  directly in the card (`.pf-eq`), then a segmented bar splitting **Total
  Invested** into Current Invested vs. Recovered (`#portfolioSplitBar`,
  segment widths = Recovered ÷ Total Invested, clamped to 0–100%; a
  `portfolioBarNote` explains when Recovered exceeds 100%; the whole bar
  hides when Total Invested ≤ 0), with a two-line legend of amounts and
  percentages underneath.
- **All colors now come from existing theme tokens** (`--card-bg`,
  `--text-main`/`--text-muted`, `--primary`, `--income-color`/
  `--expense-color` and their chip variants, `--chip-bg`, `--border-color`,
  `--primary-chip-bg`) — styles live in `.pf-*` classes, so light mode,
  midnight/noir/slate, crayon, and glass all render correctly
  automatically. The old P/L and Return boxes hardcoded light-mode colors
  that would have looked wrong in dark themes, so they're removed
  (`portfolioPlBox`/`portfolioReturnBox` deleted). Green/red is reserved
  for profit/loss only; Current Invested uses the theme's primary color,
  Recovered uses neutral gray.
- The badge is labeled "return on total invested" — calculating return
  against Current Invested instead would read noticeably higher (roughly
  67% vs. 34% on the reference data), because P/L already includes booked
  profit while the denominator shrinks — deliberately **not** used for
  that reason.
- Reviewed an externally-supplied "dark glassmorphism" design as a
  reference and deliberately did **not** adopt a hardcoded dark background
  (would break the multi-theme system) or a mini trend sparkline (would
  require replaying historical NAV, unrelated to the actual confusion
  being fixed). That reference design's progress bar, labeled "68.1% cost
  recovered (109,450 / 221,598)," turns out to actually be P/L ÷ Current
  Invested — which doesn't match Recovered ÷ Total Invested = 49.4% — and
  has been redone here with the correct basis.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v421.

## v422: segmented-bar header row, hover explanations, and removed a
duplicate Total Invested row

- **Fixed**: user pointed out the segmented bar had no explanation of what
  the purple segment meant, or what the whole bar represented — sitting
  directly under the purple Current Invested equation, it was easy to
  misread as representing Portfolio Value.
- Added a header row above the bar (`.pf-bar-head`): "BAR = TOTAL
  INVESTED" on the left, the Total Invested amount on the right
  (originally "Whole bar = Total Invested," shortened after it wrapped to
  two lines at 360px width); increased the gap between the bar and the
  equation above it from 16px to 22px; both bar segments now get a
  JS-written `title` tooltip with the amount, percentage of Total
  Invested, and what it means (desktop hover only — phones rely on the
  legend below).
- Removed a redundant Total Invested row further down the page once it
  was pointed out it duplicated the new header row — the header row
  reuses the original `portfolioInvestedTotal` element, no second
  calculation was added.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v422.

## v423: collapse fully-closed funds + fixed the Current Invested subtitle
wording

- **Added** `isClosedFund(f, invested)` — true when `units < 1e-6 &&
  invested > 0` (requiring a prior buy avoids misclassifying a brand-new,
  not-yet-bought fund as closed; the 1e-6 threshold absorbs
  floating-point remainder from repeated unit additions/subtractions) —
  for funds that have been fully redeemed (zero units) but were still
  taking up permanent space in the tables.
- On Fund Holdings (`colspan=11`) and the Portfolio report's per-account
  Fund Detail tables (`colspan=6`; the account list is now the union of
  accounts with live funds and accounts with only closed funds, so an
  account with nothing left but closed funds still appears), closed funds
  are now collapsed into one summary row — `▸ N closed fund(s) · Realized
  P/L … · tap to show` (`closedFundsSummaryRow()`, rendered as `<tr
  data-click="toggleClosedFunds">`) — that expands/collapses on tap.
- **One shared toggle app-wide**: `SHOW_CLOSED_FUNDS_KEY =
  "ledger.showClosedFunds"` in localStorage (per-device, collapsed by
  default); `toggleClosedFunds()` flips it and calls `renderApp()`, plus
  `renderPortfolioReportPage()` if that page is currently visible;
  registered in `CLICK_ACTIONS`. Collapsing only affects which rows are
  listed — closed funds are still included in every total.
- **Fixed** the Current Invested subtitle wording from "still invested" to
  **"invested − taken out"**, and updated the matching bar-hover text to
  match.
- Tested locally in headless Chromium: set a passcode, used the app's own
  `writeDB()` to write encrypted test data (one live fund, one closed
  fund, one not-yet-bought fund), and verified both tables' collapse/
  expand, persisted preference, and unchanged totals, with no console
  errors.
- **Known open question, left unresolved**: Current Invested is "net
  invested" (Invested − Recovered), not "cost basis of what you currently
  hold" — a closed, profitable fund can offset another fund's principal
  with a negative value (example: Fund A invested 1,000, still held; Fund
  B invested 5,000, recovered 6,000, closed; combined Current Invested =
  0). Switching to a true holding-cost basis would require splitting each
  sale by average cost, and the identity would become `holding cost +
  unrealized P/L = value` instead — no longer tying directly back to total
  P/L. Not yet decided whether to change this.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v423.

## v424: speed-dial icon fixes — Lend/Claim icon + off-center × button

- **Fixed**: the Lend/Claim speed-dial icon was a 🧾 emoji, rendered by the
  system emoji font while the other four speed-dial icons are stroke-style
  SVGs — replaced with a matching receipt icon in the same style (2px
  round stroke, 20×20), on both the Dashboard and Account Activity page
  speed-dial sheets.
- **Fixed**: the × close button wasn't centred on the main FAB.
  - Horizontal offset: the main button is 56px wide, the speed-dial
    circles are 48px, and both were pinned `right: 20px` — that put the
    circles' centre 4px right of the button's centre. Moved
    `.speed-dial-sheet` to `right: 24px` so all five circles share the
    exact same centre x as the button.
  - The × glyph itself was a text "+" rotated 45°, so its exact centre
    depended on font metrics — replaced with an inline SVG "+" that
    rotates around its precise centre.
  - The 45° rotation now applies to the icon only, not the whole disc, so
    the glossy highlight on the disc stays fixed instead of spinning with
    it.
- Verified in a headless browser: the icon is dead-centre in both
  open/closed states, tapping the icon still opens/closes the menu, no
  console errors. Not tested in-browser on the Account Activity page's
  copy of the button — same markup/CSS as the Dashboard one, so expected
  to match.
- Other "+" buttons across the app (Accounts, Categories, Tags, etc.)
  still use the old text glyph at this point — see v425.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v424.

## v425: every "+" button now uses the same SVG glyph

- **Changed**: all ten "+" buttons in the app now render the same inline
  SVG "+" instead of a mix of text glyphs and (as of v424) SVG — covers
  the 8 that were still text glyphs (Fund transaction, Accounts,
  Categories, Templates, Tags, Category Budget, Inventory, Reminders)
  plus the two speed-dial toggles already converted in v424.
- Stroke weight and size tuned to match the previous bold text glyph, so
  buttons look about the same at rest — just precisely centred now,
  matching v424's fix.
- Verified all ten in a headless browser: each SVG sits exactly centred
  in its button, no text glyph remains, no console errors. Only
  `index.html` changed — same click handlers/styling on every button, no
  behavior changes.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v425.

## v426: fixed print/PDF title falling back to "Ledger" on 5 Settings
sub-pages

- **Fixed**: `getActivePageTitle()` was missing `case` entries for
  `page-bgtheme`, `page-networthcardstyle`, `page-dashboardwidgets`,
  `page-currencyconfig`, and `page-reminders` — the five pages split out
  of the old Settings page across v394–v418. Printing (or "Save as
  PDF"-ing) while on any of them fell through to the `default: "Ledger"`
  branch instead of showing the actual page name/filename. Added the five
  matching cases; verified against `APP_PAGE_IDS` (all 31 pages now
  covered) with `node --check` and the same page-id cross-reference
  approach used for prior fixes — 0 missing.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v426.

## v437: optional Fee field on fund Buy / Sell transactions

Groundwork for tracking a stock/ETF brokerage account (e.g. Moomoo) with the
existing Unit Trust machinery. Only this one piece has a real deadline — it
must exist **before the first real trade**, because a fee folded into Total
Amount can't be separated out afterward. Everything else discussed (Stock/ETF
category, stock-dividend category, price-staleness badge for stocks) is
deliberately deferred until there are real trades to design against.

- **Added**: optional "Fees included in Total" input on the fund-transaction
  form (relabelled "Fees already deducted from Total" for a Sell). Shown only
  for Buy/Sell.
- **Stored** as `fee` on the transaction record: a positive number, or `null`
  when blank / not a Buy or Sell. Purely informational — Total Amount is still
  the real cash figure, and nothing in Invested / Recovered / P&L / balances
  reads `fee`. Pre-v437 rows simply have no `fee`.
- **Validation**: must be ≥ 0; for a Buy it can't exceed Total (a Buy's total
  already includes it). Not enforced for a Sell, whose total is net of the fee.
- **Bug-class checks**: fee is nulled on save for non-Buy/Sell types (no
  hidden-field save); it round-trips through the edit form; export/import keep
  whole transaction records (no per-field whitelist for transactions), so it
  survives backup → restore.
- **Shown** in the fund's Activity rows as "· fee RM x.xx" when present.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v437.

**Also fixed in v437 (pre-existing since the fund editor was added, found
while testing the fee field)**: editing a Buy/Dividend/Contribution row after
a partial Sell could silently inflate the fund's unit balance. The edit path
reversed the old entry's units and floored the running total at 0 *before*
adding the new units, so whenever the units still held were fewer than that
entry's own units (buy 10, sell 5, then just change the note on the Buy) the
position jumped 5 → 10. The reversal and the new delta are now applied as one
net change with a single floor at the end. Only unit balances were affected
(cash transfers and transaction amounts were always correct); a fund whose
units look too high after such an edit in an earlier version should be
checked against its statement.

## v438: new "Stocks/ETF" sub-group under Investment

- **Added**: "Stocks/ETF" in the Investment Sub-Group dropdown (between Unit
  Trust and Gold), for a brokerage's holdings account (e.g. Moomoo). It's
  filing only — the account is still a normal Unit Trust-type account, and
  existing accounts are untouched. The sidebar type shortcut appears
  automatically once an account is filed under it.
- **Net Worth Statement**: gets its own "Stocks/ETF" row and total. This part
  isn't optional: that page hard-codes one row per sub-group, so a sub-group
  added to `ACCOUNT_SUBGROUPS` alone would silently drop those accounts from
  the statement (it would stop matching the Dashboard headline). A control
  build with only the list change showed RM5,000 instead of RM6,000 on a
  RM5,000 savings + RM1,000 holdings setup; the real build ties out.
- **Reminder for any future sub-group**: add it in both `ACCOUNT_SUBGROUPS`
  and `renderNetWorthStatementPage()` (row + `totalAssets` term).
- A brokerage's *cash* wallet belongs in a Multi-Currency account (counted
  under "Foreign Money Account"); only the holdings account uses Stocks/ETF.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v438.

## v439: "Paying from / Receiving into <currency> balance" hint (Log Ledger Item)

- A Multi-Currency account has no single currency, so the currency dropdown in the
  modal header alone decides which balance an entry hits, and nothing next to the
  Account field said so.
- New hint under Account (and To Account when a Transfer goes into a Multi-Currency
  account): the selected currency's current balance, the balance after this entry,
  and a red warning when an outgoing amount would take it negative (or the account
  holds none of that currency).
- Balances come from `computeAccountBalances()`, fetched once per form open (memo reset
  in `openTransactionForm`); amount/currency/split edits only re-render. Editing an
  existing entry backs out its own effect first. Hooked via `syncTransactionCurrency()`
  and `recalcTxSplitTotal()`, so no new action-map entries or modal ids.

Bumped `APP_VERSION` (ledger.js) and `CACHE_NAME` (sw.js) to v439.

## v440: Dashboard Accounts widget shows a Multi-Currency account's own-currency holdings

- The pinned Accounts widget only showed the base-currency total for a Multi-Currency
  account, hiding which currencies it actually holds. A second small line under the
  name now lists them (e.g. `RM120.00 · S$20.00`), largest by base value first, zero
  baskets dropped, max 3 then `+N more`, negatives in red.
- Hidden when it adds nothing: not a Multi-Currency account, nothing held, or only the
  base currency. New helper `multiBasketLineHTML()`; only the dashboard widget uses it.
  (Accounts page and member pages already list every currency as subrows.)

Bumped `APP_VERSION` (ledger.js) and `CACHE_NAME` (sw.js) to v440.

## v441: Dashboard Accounts widget also shows the original currency of single-currency accounts

- A normal account held in a non-base currency (e.g. CIMB EcoSave in MYR while base is
  SGD) only showed the converted base total. It now gets the same small line under the
  name with its own-currency balance (e.g. `RM1,850.00`). Hidden when the account's
  currency is the base currency; Fixed Deposit / Unit Trust still not covered.
- Helper renamed `multiBasketLineHTML()` -> `accountNativeLineHTML()` (now covers both cases).

Bumped `APP_VERSION` (ledger.js) and `CACHE_NAME` (sw.js) to v441.

## v442: Insights button + fold/unfold Recent Transactions (dashboard)

- **Insights button**: below 1400px the Insights panel (Spending Breakdown / Top Categories /
  Recent Large Transactions) was only reachable by a right-edge swipe, which some phones'
  gesture settings intercept. New icon button in the header cluster (before Quick export)
  calls the existing `openInsightsDrawer` action; hidden at 1400px+ where the rail is docked.
- **Recent Transactions fold**: a chevron beside the title hides/shows the list, header and
  Calendar button stay. Class `recent-tx-collapsed` on `#dashboardRecentTxWidget` (CSS hides
  `#recentTxList`), state saved as SETTINGS `recentTxCollapsed` (loaded at startup, restored
  on backup import). Default expanded. Separate from Setting > Dashboard Widgets "None", which
  still hides the whole widget.

Bumped `APP_VERSION` (ledger.js) and `CACHE_NAME` (sw.js) to v442.

## v443: header icon order

- Swapped the Insights button and the Lock button in the dashboard header cluster:
  now Lock, Quick export, Privacy eye, Insights (was Insights, Quick export, eye, Lock).
  Markup order only; no behaviour change.

Bumped `APP_VERSION` (ledger.js) and `CACHE_NAME` (sw.js) to v443.

## v444: added Philippine Peso (PHP) and Indonesian Rupiah (IDR)

- Added `PHP` and `IDR` to `HELD_CURRENCIES`, `fxRates` and
  `DEFAULT_FX_RATES_BY_CURRENCY` (ledger.js) with placeholder rates of
  ~12.8 PHP and ~3,720 IDR per 1 MYR. `mergeInDefaultCurrencies()` adds
  them additively on load, so existing installs get both without any
  custom rate being overwritten. Use Currency Settings ▸ Fetch Live
  Rates for real values.
- `PHP` gets a `CURRENCY_BADGE_COLORS` entry (sky blue) and a `₱` coin
  glyph; `IDR` already had a badge colour and `Rp` glyph. Both added to
  `currencySymbols` (`₱`, `Rp`).
- Account currency `<select>`, transaction Currency field and the FX
  rate form are populated dynamically, so no other lists needed changes.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME`
(sw.js) to v444.

## v446: Google Drive sync — busy spinner on manual buttons + flush-on-background

- **Busy state on "Upload to Drive" / "Restore Latest"**: both buttons now show a spinner
  and disable themselves while the request is in flight (new `.btn-util.btn-busy` CSS +
  `setButtonBusy()` helper), instead of looking identical to idle for however long the
  round-trip to Drive takes.
- **Flush pending auto-sync when the app is backgrounded**: auto-sync debounces uploads
  4s after a write (`scheduleDriveAutoSync()`) so a burst of edits uploads once. If the
  app was closed/backgrounded inside that 4s window, the timer never got to fire and the
  last write never reached Drive — the reported "last entry from mobile missing after
  Restore Latest on PC". New `driveAutoSyncPending` flag + `flushPendingDriveAutoSync()`,
  wired to `visibilitychange` (tab/app hidden) and `pagehide` (actual close/reload): the
  moment the app is about to disappear with a sync still pending, it's kicked off
  immediately instead of waiting out the rest of the debounce. Best-effort, not a
  guarantee — the OS can still kill the page mid-request on a hard close — but it covers
  the common case of switching apps or locking the phone right after adding something.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME` (sw.js) to v446.

## v447: locking the app no longer drops a still-pending Drive auto-sync

- `lockAppNow()` (header lock icon, and the auto-lock idle timer) used to null out
  `currentPasscode`/`appKey` and reload immediately. If a debounced auto-sync write from
  v446 was still waiting out its 4s window when the app got locked, the reload cancelled
  it — and the v446 pagehide flush couldn't rescue it either, since `uploadBackupToDrive()`
  needs `currentPasscode` to encrypt, and it was already wiped by then.
- `lockAppNow()` is now `async` and awaits a new `flushPendingDriveAutoSyncAsync()` (the
  same debounce-flushing logic as v446's `flushPendingDriveAutoSync()`, split out so this
  caller can wait for the actual upload instead of firing and moving on) before clearing
  the passcode and reloading. Adds a brief delay only when a sync was actually pending.

Bumped `APP_VERSION`/`APP_VERSION_DATE` (ledger.js) and `CACHE_NAME` (sw.js) to v447.

## v465: pdf.js updated to 6.4.299, and scanner PDFs no longer open blank

**Update.** `lib/pdf.min.mjs` and `lib/pdf.worker.min.mjs` are now the official `pdfjs-dist` **6.4.299** build files (was 6.2.108; 6.4.299 was the latest release on 2026-10-05). Same file names and API, so the PDF viewer's `getPage` / `getViewport` / `render` calls did not change. `isEvalSupported: false` is kept.

**Fix.** A PDF saved by a flat-bed scanner (1-bit black-and-white pages, CCITT/JBIG2 — for example EPSON Scan) opened in the attachment viewer as blank white pages, while ordinary PDFs looked fine. Since pdf.js 5 the decoders for those pages and for JPEG2000 images are WebAssembly files that must be given to `getDocument()` as `wasmUrl`; the app never did, so pdf.js logged "JBig2 failed to initialize" and drew nothing. This was already true with 6.2.108 — it is not caused by the update.

- New folder `lib/wasm/`: `jbig2.wasm`, `openjpeg.wasm`, `qcms_bg.wasm`, **and** `jbig2_nowasm_fallback.js`, `openjpeg_nowasm_fallback.js` (plus the licence files), all from the same 6.4.299 package.
- `ledger.js`: `getDocument({ …, wasmUrl })`, with `wasmUrl = new URL("lib/wasm/", document.baseURI).href`.
- **Why the JavaScript fallbacks matter:** the CSP has no `'wasm-unsafe-eval'` and is not changed. A CSP delivered as an HTTP header (as some hosts add) also binds pdf.js's worker, so the worker may not compile `.wasm`; pdf.js then loads the plain-JavaScript decoder from the same folder, which is allowed by `script-src 'self'`. Without those two `.js` files the page stays blank. (Found in the companion Shelfmark app, where v1.65.2 with only the `.wasm` files did not fix the blank pages on the live site.)
- `sw.js`: the five decoder files are in `ASSETS_TO_CACHE` so scanner PDFs also open offline. `CACHE_NAME` and `APP_VERSION` are v465.
- The `quickjs-eval.*` files that ship in the same `wasm/` folder (pdf.js's PDF-form scripting sandbox) are deliberately **not** included.

## v466: scanner PDFs sometimes still blank — large page images are now shrunk first

Symptom (owner's DevTools console on the live site): after v465 a scanner PDF page sometimes still showed blank, with `Unable to decode image "img_p0_1": UnknownError: Failed to execute 'transferToImageBitmap' on 'OffscreenCanvas': ImageBitmap construction failed` and `Dependent image isn't ready yet`. The pages that failed were the big ones: a 600 dpi scan page is one ~28-megapixel 1-bit image, and turning it into a bitmap needs a canvas of that size. By default pdf.js *guesses* the largest canvas the browser can make and does not shrink anything below that guess; when the guess or the allocation fails (memory / GPU pressure, so it happens only sometimes) the image is dropped and the page stays white.

Fix: `getDocument()` now also gets `canvasMaxAreaInBytes: 32 * 1024 * 1024` (`ledger.js`). With a fixed limit pdf.js reduces any image larger than ~8.4 megapixels before building the bitmap — a 6618×4234 scan page becomes about 3309×2117, still much sharper than the viewer's ~800 px page width. Ordinary PDFs and photos are far below the limit and are not touched. `APP_VERSION` / `CACHE_NAME` → v466.

Tested in headless Chromium 153 with the same 5-page scan (`EXP2609.pdf`) and Ledger's CSP as an HTTP header, with the worker patched so that bitmaps over 16 megapixels fail the way they do on the owner's browser: default options → pages 1–4 blank (same console error); with the limit → all 5 pages show text; without the simulated failure the limit gives the same result. Not tested on the owner's real device, where the failure is memory-dependent.

## v467: PDF viewer stuck on "Loading PDF…" — pdf.js files are now version-named

Symptom (owner's screenshot + DevTools on the live site, after v466): opening a PDF attachment (`SV.pdf`) stayed on "Loading PDF…" forever; the console showed `Uncaught Error: Unknown action from worker: test` from `pdf.worker.min.mjs`. That message means the page was running the **old pdf.js main file (6.2.108)** together with the **new worker (6.4.299)**: the old main file sends a `test` message that the new worker no longer understands, so the worker never answers. Reproduced exactly in headless Chromium by pairing the two.

How the old file can still be handed out: pdf.js's files were cache-first under fixed names (`lib/pdf.min.mjs`, `lib/pdf.worker.min.mjs`). During a service-worker switch (or from the browser's own HTTP cache — GitHub Pages sends `max-age=600`), one of the pair can come from the old cache and the other from the new one. v465 also introduced this risk by changing the contents of two files without changing their names.

Fix:
- **Version-named folder.** pdf.js now lives in `lib/pdfjs-6.4.299/` (`pdf.min.mjs`, `pdf.worker.min.mjs`, `wasm/`). `ledger.js` builds all three paths from one constant, `PDFJS_DIR`; `sw.js` precaches the same paths. Main file, worker and decoders can no longer come from different releases, because a different release has a different path. Old cached copies under the old names are simply never asked for again.
- **No infinite spinner.** If the PDF does not open within 30 s, the viewer now shows "Could not preview this PDF: the PDF viewer did not respond (close and reopen the app once, then try again)" with the Download hint, instead of "Loading PDF…" forever. (The 30 s covers opening the document only; page images are decoded afterwards and are not time-limited.)
- **Fresh precache.** The service worker's install step now fetches every file with `cache: "reload"`, so it never copies a stale file out of the browser's HTTP cache.
- `APP_VERSION` / `CACHE_NAME` → v467. The pdf.js release itself (6.4.299), the decoders, `wasmUrl` and `canvasMaxAreaInBytes` are unchanged.

Tested in headless Chromium 153 against the real app (`index.html` + `ledger.js`, CSP also sent as an HTTP header): `openAttachment()` with the 5-page scanner PDF → all 5 pages show; then with the old 6.2.108 main file forced in at the new path → the clear message after 30 s (no spinner, no crash). Not tested on the owner's device or through a real GitHub Pages deploy / service-worker upgrade.

## v468: Insurance — policies, premiums paid and latest surrender value

New sidebar entry **Insurance** (next to Reminders). One record per policy, in a new `insurance` IndexedDB store (`DB_VERSION` 13 → 14; the store is created on upgrade, nothing existing is touched).

What a policy holds: insurer / plan / policy number / type / status / insured person / start & maturity dates / premium & frequency / optional policy loan, a **coverage** list (benefit + sum assured), the **premium payments made before this ledger started** (typed in by hand — date, amount, note), and a **dated surrender-value history** (Guaranteed + Total, copied from the insurer's statements — never calculated).

How premiums stay correct:
- **Premiums paid = typed-in earlier payments + ledger Expense transactions linked to the policy.** It is computed live every time, never stored, so editing/deleting a transaction can't leave a stale total.
- A transaction links to a policy through a new optional field `policyId`. The Add/Edit Transaction form shows a **🛡️ Policy** row only on an Expense whose category looks like insurance (or one already linked) and only when at least one policy exists. The field is carried through edits (the record is built field-by-field, same trap as `splitGroupId`/`isRefund`); split legs never carry it.
- A **Planned Payment** links to a policy through its own optional `policyId` (one planned payment per policy; link it from the policy's detail sheet). A recurring planned payment keeps the link across "Mark as Paid", which pre-selects the policy on the form, so each year's premium is linked automatically. The policy's "Next premium" is read from that planned payment — the date is stored once, not twice.
- **💳 Record premium** on a policy opens the Expense form pre-filled; when a planned payment is linked it goes through the same confirm path as "Mark as Paid", so the planned payment advances instead of being left to be paid twice.
- "Ledger tracking starts" (defaults to the day before the earliest transaction) marks where typed-in history ends; a linked ledger transaction dated on/before it is flagged as a possible duplicate. An optional "Insurer's total paid" is compared against the typed-in payments while typing (✅ / ⚠️ with the difference).
- A surrender value older than 12 months is flagged ⚠️ (insurers issue a fresh statement yearly).
- A policy that still has linked transactions / a planned payment can't be deleted — set Status to Lapsed / Surrendered / Matured instead.

Backup: `insurance` is included in export, restore and the Drive snapshot bundle (absent on older backups → skipped). Records are encrypted like every other store (keyPath `id` stays plain). No new files, no `sw.js` asset list change.

Not in this version (planned): policy attachments, net-worth toggle, per-member coverage report, premiums-paid-vs-surrender-value report, investment-linked ↔ Funds link.

- `APP_VERSION` / `CACHE_NAME` → v468.

## v469: Insurance — surrender value split into Guaranteed + Bonuses, Total auto-calculated

An insurer's statement splits the surrender value into a **guaranteed** cash value and several **non-guaranteed** parts (accumulated dividend, reversionary bonus, terminal dividend/bonus), so a "Guaranteed + Total" pair let the bonuses be left out of Total without anyone noticing. Each surrender-value entry is now **Date + Guaranteed + Bonuses + Total**:
- **Total follows Guaranteed + Bonuses** until it is typed over. Typing the statement's Total with only Guaranteed filled works out Bonuses as the difference (kept in step if the Total is corrected later). So any one, two or three boxes can be entered.
- **Bonuses accepts a sum** (`20389.58 + 11580.50`) — the statement lists the bonus parts on separate lines. Leaving the box replaces the sum with its result (31970.08), so what is shown is what is saved.
- Entries saved by v468 (Guaranteed + Total only) load with Bonuses shown as Total − Guaranteed; nothing is migrated or rewritten until the policy is saved again. New optional field on each entry: `bonus`.
- The policy detail shows the guaranteed share of the surrender value ("the rest is bonuses, not guaranteed") and "Guaranteed … · Bonuses …" on every history line.
- The policy-level loan box is relabelled "Policy loan not yet deducted": a statement's own total (H = A+C+D+E+F+G − loan) is already net of the loan, so fill the box only when the entered values are gross, otherwise the loan would be deducted twice.

- `APP_VERSION` / `CACHE_NAME` → v469.
