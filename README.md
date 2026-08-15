# Enterprise Multi-Currency Ledger

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
