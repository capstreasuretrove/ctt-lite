# CTT Lite

A lean, browser-based companion to the CTT desktop app — Inventory (Pops), Consignment, eBay listing creation, and Booth Layouts, for use on the road. No install, no native toolchain.

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

## eBay flow (matches the desktop app)

1. **Add items** in the grid — name, price, template, etc., one row per listing.
2. **⚡ Generate Listings** (toolbar) — generates a title and description for every listing at once. Re-run it anytime; it skips anything already Listed and respects any title/description you've hand-edited (won't clobber those).
3. Open a listing's card to **add photos** and review/tweak the generated text, template-specific fields, price, condition, etc. There's also a plain **Name** field right in the card now, for a quick edit without leaving it.
4. **Post it** either individually (the card's own **Verify with eBay** / **Post Live** buttons — one listing at a time) or all together (toolbar's **📤 Upload All Listings** — posts every not-yet-Listed listing in one pass and reports how many succeeded/failed).

## Before you trust the eBay module with a real listing

Every other module in this app was confirmed against your live data before being handed off. eBay is the one exception — posting a real listing is public and can't be tested the same safe, reversible way a Sheet row can. So:

1. Build a test listing in the grid, open its card, add a photo, hit **Generate**.
2. Click **Verify with eBay** first (calls eBay's `VerifyAddItem` — validates without publishing anything). If it comes back with an error, that's expected on a first try — eBay's XML schema is strict, and the XML builder here was reconstructed from documented field names/constants, not your literal source code. Paste me the error and I'll fix it.
3. Only use **Post Live** (or **Upload All Listings** once you trust it) after Verify succeeds on at least one listing. Posting always asks for confirmation first since it's real and public.

## Booth Layouts (new)

A fourth tab, **Booth Layouts**, for planning how the booth is set up per show. Data lives in its own Google Sheet ("CTT - Booth Layouts") behind its own Apps Script Web App — nothing to do with the Inventory/Consignment scripts. `js/config.js` already has the URL.

- **+ New Layout** — give it a show name/date, pick a booth template (Woodbridge Toy Show for now), and optionally **Start from** a past layout to reuse it.
- **Painting** — in Edit mode, drag across cells to select them, type a label (free text; suggestions come from your Inventory lines/licenses and labels you've used), press Enter. Same label = same color. Click a labeled block to relabel/recolor it, or pick "This cell only". Painting over part of a block splits it. Blocks always stop at shelf edges (a drag across several shelves just paints each shelf). The dashed outline is the open top shelf.
- **Save** is explicit (button) — nothing saves as you paint. **Undo** steps back through recent edits.
- **Lock (view)** — existing layouts open locked so you can't nudge them by accident while setting up the booth; hit **Edit layout** to change them.
- **★ Favorites** and the **Start new from this** button on each row are for finding and reusing layouts you liked.
- On a phone the diagram scrolls sideways.

Not built yet (see the project's `ctt-booth-layout-manager-plan.md`): creating new booth templates in-app, and the overview map.

## What's here vs. not

**Inventory**: Pops only (no Autographs), full grid with virtualization/search/filters/multi-sort, add-as-you-type row, inline edit, delete.

**Consignment**: convention picker (newest-to-oldest), per-convention summary, dynamic order grid (adapts to each tab's actual columns), inline edit/add/delete, **+ New Convention**. Shipped-toggle write-back is left out — confirmed the backend doesn't support it yet, and you asked to skip it for now.

**eBay**: grid of listing drafts → bulk **Generate Listings** → open a card per listing for template-specific fields (including a plain Name field for quick edits), photos (drag-and-drop, up to 11 + your CTT store photo auto-appended) → Verify/Post individually or **Upload All Listings** in bulk, via your real proxy. Title/description wording for all 4 templates (Common/Exclusive/Limited Edition/Signed) now matches `CTT_ebay_listing_templates.txt` exactly (2026-09-12) — **note**: Signed's description mentions a "Popshield Soft Protector" by name again, straight from that file, which reverses the earlier "never mention protectors unless included" preference — say the word if you want that dropped again. The "- IN HAND - SHIPS FAST!" title suffix and the per-listing multi-quantity disclaimer checkbox are still layered on top, same as before. Listings live in this browser's storage only (no Sheet involved, per the original design). Not included: Mercari/Facebook Marketplace exports (scoped out — just eBay for now).

**New**: a "🔍 Look up from Inventory" search bar above the eBay grid — type a partial name (e.g. "Venompool"), pick the match, and it creates a new listing pre-filled with Name/#/Line/License and opens its card right away. The same search box also appears inside each listing's card, so you can re-search and overwrite those fields on a listing you already started (handy if you picked the wrong item or need to fix a typo). This is separate from the quieter autofill that already ran in the background during Generate — that one only fills in blank fields; this one is the deliberate "grab the whole record" version.

Deliberately dropped throughout: restock alerts (and Peak Qty tracking), Autographs tab, Calendar, Dashboard, Show Sales Viewer, Settings page, barcode scanning — none of these are part of the lite scope.

## Housekeeping owed

Two disposable test tabs from confirming the Consignment `createConvention` behavior are still sitting in your live Consignment sheet: **`ZZZ-TEST-26`** and **`ZZZ-TEST2-26`**. Delete those two tabs (and their rows on the summary tab) whenever you're in there next — there's no API-side way to clean them up.

## Reference

See the project's `ctt-lite-app-plan.md` doc for the full architecture, confirmed backend behaviors, and build history.
