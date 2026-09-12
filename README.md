# CTT Lite

A lean, browser-based companion to the CTT desktop app — Inventory (Pops), Consignment, and eBay listing creation, for use on the road. No install, no native toolchain.

**Status:** Inventory module built and smoke-tested (against a mocked backend — see caveat below). `js/config.js` is already filled in with your Inventory Apps Script URL and password `4141`. Consignment and eBay are stubbed as "coming soon."

Live at: https://ctt-lite.netlify.app/

## Setup

Already done for this build — `js/config.js` has your real `INVENTORY_SCRIPT_URL` and `AUTH_PASSWORD` baked in. Just redeploy: drag this folder onto Netlify again (or push to your GitHub repo if you connected one) to update the live site.

If you ever need to change either value later: `js/config.js` is a plain text file — on a Mac, right-click it → Open With → TextEdit (avoid double-clicking, which can try to run it instead of opening it as text).

## Important caveat

This was built from a detailed write-up of the desktop app's source (field names, Apps Script action names, response shapes) rather than the live endpoint itself — there was no Apps Script Web App URL available while building it, and this sandbox can't reach `script.google.com` anyway. It's been tested end-to-end against a **mocked** version of that backend (load, sort, filter, add, edit, delete all round-trip correctly), but not against the real one yet.

The one place a mismatch is most likely: `normalizeItem()` in `js/inventory.js` assumes `getInventory` returns `{ ok: true, items: [...] }` with each item already keyed by `name/number/line/license/qty/owner/dateAdded/ebayListed/size/chase/pieceCount/featured/id`. If the real response shape differs, that function (and the `res.items` lines in `loadInventory`/`saveAddRow`) are the only places that need adjusting — everything else works off the normalized shape. Worth doing a first real test with your actual URL before trusting it with live data.

## What's here vs. not

Included: Pops inventory only (no Autographs), full grid with virtualization/search/filters/multi-sort, add-as-you-type row, inline edit, delete.

Deliberately dropped: restock alerts (and the Peak Qty tracking behind them), Autographs tab, Calendar, Dashboard, Show Sales Viewer, Settings — none of these are part of the lite scope.

## Next up

Consignment module, then eBay listing creation — see the project's `ctt-lite-app-plan.md` doc for the full architecture and build order.
