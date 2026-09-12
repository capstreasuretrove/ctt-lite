# CTT Lite

A lean, browser-based companion to the CTT desktop app — Inventory (Pops), Consignment, and eBay listing creation, for use on the road. No install, no native toolchain.

**Status:** Inventory module built and smoke-tested (against a mocked backend — see caveat below). Consignment and eBay are stubbed as "coming soon."

## Setup

1. Open `js/config.js` and fill in:
   - `INVENTORY_SCRIPT_URL` — the deployed Google Apps Script Web App URL that already serves `getInventory` / `addInventoryItems` / `updateInventoryItems` / `deleteInventoryItems` (the same one the desktop app and original site use). Looks like `https://script.google.com/macros/s/AKfycb.../exec`.
   - `AUTH_PASSWORD` — whatever you want this gated behind. It's a simple client-side check (like the existing `?admin=1` pattern on the main site), not real security — the actual protection is that nobody else has your Apps Script URLs.
2. Deploy: this is plain static files (no build step) — push to a new GitHub repo and connect a **new, separate** Netlify site to it (per your call to keep this disconnected from the public site's repo/deploys), or just drag-and-drop the folder into Netlify.

## Important caveat

This was built from a detailed write-up of the desktop app's source (field names, Apps Script action names, response shapes) rather than the live endpoint itself — there was no Apps Script Web App URL available while building it, and this sandbox can't reach `script.google.com` anyway. It's been tested end-to-end against a **mocked** version of that backend (load, sort, filter, add, edit, delete all round-trip correctly), but not against the real one yet.

The one place a mismatch is most likely: `normalizeItem()` in `js/inventory.js` assumes `getInventory` returns `{ ok: true, items: [...] }` with each item already keyed by `name/number/line/license/qty/owner/dateAdded/ebayListed/size/chase/pieceCount/featured/id`. If the real response shape differs, that function (and the `res.items` lines in `loadInventory`/`saveAddRow`) are the only places that need adjusting — everything else works off the normalized shape. Worth doing a first real test with your actual URL before trusting it with live data.

## What's here vs. not

Included: Pops inventory only (no Autographs), full grid with virtualization/search/filters/multi-sort, add-as-you-type row, inline edit, delete.

Deliberately dropped: restock alerts (and the Peak Qty tracking behind them), Autographs tab, Calendar, Dashboard, Show Sales Viewer, Settings — none of these are part of the lite scope.

## Next up

Consignment module, then eBay listing creation — see the project's `ctt-lite-app-plan.md` doc for the full architecture and build order.
