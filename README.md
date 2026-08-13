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
