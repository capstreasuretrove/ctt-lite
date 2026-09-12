# CTT Lite

A lean, browser-based companion to the CTT desktop app — Inventory (Pops), Consignment, and eBay listing creation, for use on the road. No install, no native toolchain.

**Status:** All three modules built. Inventory and Consignment are confirmed working against your real live backend. eBay Listings is built against your real, already-working `ebay-proxy.js` but has **not** been live-tested (no eBay token available while building it) — verify it yourself before trusting it with a real listing (see below).

Live at: https://ctt-lite.netlify.app/

## Setup

Already done for this build — `js/config.js` has your real Inventory and Consignment Apps Script URLs and password `4141` baked in. Just redeploy: drag this folder onto Netlify again to update the live site.

**New for eBay**: this build adds a Netlify Function (`netlify/functions/ebay-proxy.js` — your own already-working proxy, redeployed here). Dragging the whole `ctt-lite` folder (with `netlify.toml` and the `netlify/` folder inside it) onto Netlify is enough — Netlify's manual deploy picks up functions automatically, no extra steps or build command needed.

Once it's live, open the **eBay** tab → **⚙ Settings** and enter:
- Your eBay Auth'n'Auth token
- Your imgBB API key

Both are saved only in your browser's local storage and sent only to eBay/imgBB when you actually generate or post a listing — never anywhere else, and never through this chat. (You do **not** need an eBay Dev ID/App ID/Cert ID — the proxy doesn't use them, only the token.)

If you ever need to change a config value later: `js/config.js` is a plain text file — on a Mac, right-click it → Open With → TextEdit (avoid double-clicking, which can try to run it instead of opening it as text).

## Before you trust the eBay module with a real listing

Every other module in this app was confirmed against your live data before being handed off. eBay is the one exception — posting a real listing is public and can't be tested the same safe, reversible way a Sheet row can. So:

1. Build a test listing in the grid, open its card, add a photo, hit **Generate**.
2. Click **Verify with eBay** first (calls eBay's `VerifyAddItem` — validates without publishing anything). If it comes back with an error, that's expected on a first try — eBay's XML schema is strict, and the XML builder here was reconstructed from documented field names/constants, not your literal source code. Paste me the error and I'll fix it.
3. Only use **Post Live** once Verify succeeds. It asks for confirmation every time since it's real and public.

## What's here vs. not

**Inventory**: Pops only (no Autographs), full grid with virtualization/search/filters/multi-sort, add-as-you-type row, inline edit, delete.

**Consignment**: convention picker (newest-to-oldest), per-convention summary, dynamic order grid (adapts to each tab's actual columns), inline edit/add/delete, **+ New Convention**. Shipped-toggle write-back is left out — confirmed the backend doesn't support it yet, and you asked to skip it for now.

**eBay**: grid of listing drafts → open a card per listing for template-specific fields, photos (drag-and-drop, up to 11 + your CTT store photo auto-appended), title/description generation (Common/Exclusive/Limited Edition/Signed templates, matching your current title-suffix/protector/multi-quantity preferences), Verify/Post via your real proxy. Listings live in this browser's storage only (no Sheet involved, per the original design). Not included: Mercari/Facebook Marketplace exports (scoped out — just eBay for now).

**New**: a "🔍 Look up from Inventory" search bar above the eBay grid — type a partial name (e.g. "Venompool"), pick the match, and it creates a new listing pre-filled with Name/#/Line/License and opens its card right away. The same search box also appears inside each listing's card, so you can re-search and overwrite those fields on a listing you already started (handy if you picked the wrong item or need to fix a typo). This is separate from the quieter autofill that already ran in the background during Generate — that one only fills in blank fields; this one is the deliberate "grab the whole record" version.

Deliberately dropped throughout: restock alerts (and Peak Qty tracking), Autographs tab, Calendar, Dashboard, Show Sales Viewer, Settings page, barcode scanning — none of these are part of the lite scope.

## Housekeeping owed

Two disposable test tabs from confirming the Consignment `createConvention` behavior are still sitting in your live Consignment sheet: **`ZZZ-TEST-26`** and **`ZZZ-TEST2-26`**. Delete those two tabs (and their rows on the summary tab) whenever you're in there next — there's no API-side way to clean them up.

## Reference

See the project's `ctt-lite-app-plan.md` doc for the full architecture, confirmed backend behaviors, and build history.
