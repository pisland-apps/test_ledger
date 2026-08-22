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
```

## Deploy checklist

- [ ] Push **`index.html` and `ledger.js` together** — the CSP requires app
      logic to live in the external `ledger.js`; if only `index.html` goes
      up, the page loads to a blank screen (it requests a file that isn't there).
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

**If the badge shows a version that doesn't match what you just deployed,
that's the signal to hard-refresh (Ctrl/Cmd+Shift+R) or clear the site's
Service Worker/cache in devtools — not a signal that the deploy itself
failed.** The Service Worker is deliberately cache-first for offline
support, so a browser tab that was already open (or opened again quickly)
can keep serving the old `ledger.js` until the new `CACHE_NAME` causes the
old cache to be dropped and re-fetched.

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
