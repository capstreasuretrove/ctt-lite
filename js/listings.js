// CTT Lite — Listings Overview (see ctt-listings-overview-plan.md)
//
// Phase 1: what's live on eBay and what sold recently, straight from eBay's
// Trading API through the existing ebay-proxy:
//   - GetMyeBaySelling ActiveList → every active listing, tool-made or listed
//     directly on eBay.
//   - GetOrders → sales from the last 7/30/90 days (eBay won't return orders
//     older than 90 days).
// Phase 2: the shared "CTT - Listings Overview" sheet (CONFIG.LISTINGS_SCRIPT_URL,
// script source in listings-overview-apps-script.txt):
//   - CrossListings: Mercari / Whatnot / FB listings, added here with
//     "+ Add listings" and marked sold with one tap. A sold row is one sale.
//   - Matches: which Inventory item each eBay listing is. Every eBay listing is
//     confirmed by hand once (Brody's call — no silent auto-linking); the
//     suggestions just put the likely item first. Same Pop under several
//     Owners shows as separate choices.
// Phase 3: the desktop app's FB/Whatnot exports log a batch (ExportBatches)
// of "exported" rows. "I uploaded this file" (confirmBatch) flips the rows that
// made it to live and deletes the ones that didn't. Exported cards that weren't
// filled from the Inventory lookup have no inventoryId — "Match" links them.
// Phase 4: "Pull these" — an item that sold somewhere and is still listed
// somewhere else for more than Inventory can cover. Stock left = Inventory Qty
// minus sales Inventory doesn't reflect yet (uncommitted online sales, show
// sales whose stock wasn't removed in the Sales Log).
// Phase 5: show sales, read through the Sales Log Apps Script's read-only
// getSummary / getShowTab (SALES_LOG_SCRIPT_URL in config.js). A show sale's
// Inventory item is the one Pop with that name under its Tag's Owner, or a
// confirmed "show" match (keyed Tag + name, so it's asked once per name).
// Show stock is still removed with the Sales Log's own button, never here.
// Phase 6: "Commit sales" lowers Inventory Qty for online sales (eBay,
// Mercari, Whatnot, FB) from LST_COMMIT_FROM on, after a review list. The
// Committed tab is the double-count guard: addCommitted only accepts sale
// keys it hasn't seen, and only those get subtracted.
// Phase 7: sales snapshot — what sold where, by week or month, by tier.
// Signed Pops live on the Autographs tab, whose IDs are separate from
// Inventory's, so every lookup is keyed by source + id (lstKey).

const LST_DAYS_KEY = "ctt-lite-listings-days";
const LST_SORT_KEY = "ctt-lite-listings-sort";
const LST_SNAP_KEY = "ctt-lite-listings-snapshot";
const LST_MAX_PAGES = 10; // sanity cap: 2000 active listings / 1000 orders
// Commit only counts online sales from this day on — anything that sold
// before it was already taken off Inventory by hand (Brody, 2026-10-28).
const LST_COMMIT_FROM = "2026-10-28";
// Tier order (Primary → Secondary → Tertiary) — display order everywhere.
const LST_PLATFORMS = [
  { key: "ebay", label: "eBay", tier: "Primary" },
  { key: "show", label: "Shows", tier: "Primary" },
  { key: "mercari", label: "Mercari", tier: "Secondary" },
  { key: "whatnot", label: "Whatnot", tier: "Secondary" },
  { key: "fb", label: "FB", tier: "Tertiary" },
];
const LST_MANUAL_PLATFORMS = LST_PLATFORMS.filter((p) => p.key !== "ebay" && p.key !== "show");
const LST_STOPWORDS = new Set([
  "funko", "pop", "pops", "vinyl", "figure", "the", "and", "of", "with", "new", "in", "box", "exclusive",
]);

let lstActive = [];
let lstSold = [];
let lstCross = []; // CrossListings rows from the sheet
let lstBatches = []; // ExportBatches rows
let lstMatches = new Map(); // eBay ItemID → Matches row
let lstShowMatches = new Map(); // "TAG|name" → Matches row (source "show")
let lstShowSales = []; // parsed show-tab sales inside the window
let lstCommitted = null; // Set of committed sale keys; null = sheet script older than v3
let lstInv = [];
let lstInvById = new Map(); // lstKey(source, id) → item
let lstByOwner = new Map(); // Owner tag (upper case) → Pops
let lstSheetReady = false;
let lstLoading = false;
let lstBusy = false;
let lstModal = null; // { kind: "match" | "add", ... } while the overlay is open
let lstToastTimer = null;
let lstLastPlatform = "whatnot"; // Add dialog reopens on the platform used last

function lstBanner(message, kind) {
  const el = document.getElementById("lst-banner");
  if (!message) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.className = `banner banner-${kind || "error"}`;
  el.textContent = message;
}

function lstText(el, selector) {
  const found = el.querySelector(selector);
  return found ? found.textContent.trim() : "";
}

function lstPlatformLabel(key) {
  const p = LST_PLATFORMS.find((x) => x.key === key);
  return p ? p.label : key;
}

function lstTier(key) {
  return LST_PLATFORMS.findIndex((p) => p.key === key);
}

function lstSheetConfigured() {
  const url = CONFIG.LISTINGS_SCRIPT_URL;
  return Boolean(url) && !url.startsWith("PASTE_");
}

function lstApi(body) {
  return postToAppsScript(CONFIG.LISTINGS_SCRIPT_URL, body);
}

// ---------- eBay ----------

// Posts one Trading API call through the proxy; returns the parsed XML doc or
// throws with eBay's own error text.
async function lstEbayCall(callName, xml) {
  const res = await fetch(CONFIG.EBAY_PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ xml, callName }),
  });
  const text = await res.text();
  const doc = new DOMParser().parseFromString(text, "text/xml");
  const ack = lstText(doc, "Ack");
  if (ack === "Success" || ack === "Warning") return doc;
  const messages = Array.from(doc.querySelectorAll("Errors LongMessage")).map((m) => m.textContent);
  throw new Error(messages.join(" | ") || `eBay ${callName} failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
}

function lstCredentials(token) {
  return `<RequesterCredentials><eBayAuthToken>${escapeHtml(token)}</eBayAuthToken></RequesterCredentials>`;
}

async function lstFetchActive(token) {
  const out = [];
  for (let page = 1; page <= LST_MAX_PAGES; page++) {
    const doc = await lstEbayCall(
      "GetMyeBaySelling",
      `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  ${lstCredentials(token)}
  <ActiveList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></ActiveList>
  <DetailLevel>ReturnAll</DetailLevel>
</GetMyeBaySellingRequest>`
    );
    const list = doc.querySelector("ActiveList");
    if (!list) break;
    for (const item of list.querySelectorAll("ItemArray > Item")) {
      out.push({
        itemId: lstText(item, "ItemID"),
        title: lstText(item, "Title"),
        price: parseFloat(lstText(item, "SellingStatus > CurrentPrice") || lstText(item, "BuyItNowPrice")) || 0,
        qty: parseInt(lstText(item, "QuantityAvailable") || lstText(item, "Quantity"), 10) || 0,
        type: lstText(item, "ListingType") === "Chinese" ? "Auction" : "Buy It Now",
        startTime: lstText(item, "ListingDetails > StartTime"),
        photo: lstText(item, "PictureDetails > GalleryURL"),
      });
    }
    const pages = parseInt(lstText(list, "PaginationResult > TotalNumberOfPages"), 10) || 1;
    if (page >= pages) break;
  }
  return out;
}

async function lstFetchSold(token, days) {
  const now = new Date();
  const from = new Date(now.getTime() - days * 86400000);
  const out = [];
  for (let page = 1; page <= LST_MAX_PAGES; page++) {
    const doc = await lstEbayCall(
      "GetOrders",
      `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  ${lstCredentials(token)}
  <CreateTimeFrom>${from.toISOString()}</CreateTimeFrom>
  <CreateTimeTo>${now.toISOString()}</CreateTimeTo>
  <OrderStatus>All</OrderStatus>
  <OrderRole>Seller</OrderRole>
  <Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
</GetOrdersRequest>`
    );
    for (const order of doc.querySelectorAll("OrderArray > Order")) {
      const base = {
        orderId: lstText(order, "OrderID"),
        status: lstText(order, "OrderStatus"),
        created: lstText(order, "CreatedTime"),
        buyer: lstText(order, "BuyerUserID"),
      };
      for (const txn of order.querySelectorAll("TransactionArray > Transaction")) {
        out.push({
          ...base,
          lineItemId: lstText(txn, "OrderLineItemID"),
          itemId: lstText(txn, "Item > ItemID"),
          title: lstText(txn, "Item > Title"),
          price: parseFloat(lstText(txn, "TransactionPrice")) || 0,
          qty: parseInt(lstText(txn, "QuantityPurchased"), 10) || 1,
        });
      }
    }
    const pages = parseInt(lstText(doc, "PaginationResult > TotalNumberOfPages"), 10) || 1;
    if (page >= pages) break;
  }
  return out;
}

// ---------- loading ----------

function lstKey(source, id) {
  return `${source || "inventory"}:${id}`;
}

function lstInvApi(body) {
  return postToAppsScript(CONFIG.INVENTORY_SCRIPT_URL, body);
}

// Pops — the Inventory tab's copy when it has already loaded, unless fresh.
async function lstLoadPops(fresh) {
  if (!fresh && typeof items !== "undefined" && items.length) return items;
  const res = await lstInvApi({ action: "getInventory" });
  return (res.items || []).map(normalizeItem);
}

// Keeps the Inventory tab's copy in step after a commit.
function lstSyncInventoryTab(item, qty) {
  if (item.source !== "inventory" || typeof items === "undefined") return;
  const it = items.find((x) => String(x.id) === String(item.id));
  if (it) it.qty = qty;
}

// Pops plus signed items from the Autographs tab. Copies, tagged with
// source + key. fresh: skip the Inventory tab's copy (Commit reads current Qty).
async function lstLoadInventory(fresh) {
  const [pops, agRes] = await Promise.all([lstLoadPops(fresh), lstInvApi({ action: "getAutographs" })]);
  const signed = (agRes.items || []).map((a) => ({
    id: String(a.id || ""),
    name: a.name || "",
    number: a.number || "",
    line: a.line || "",
    license: a.license || "",
    qty: a.qty,
    owner: "",
    signedBy: a.signedBy || "",
    authCoa: a.authCoa || "",
  }));
  return [
    ...pops.map((p) => ({ ...p, source: "inventory", key: lstKey("inventory", p.id) })),
    ...signed.filter((a) => a.id).map((a) => ({ ...a, source: "autograph", key: lstKey("autograph", a.id) })),
  ];
}

function lstSetInventory(list) {
  lstInv = list;
  lstInvById = new Map(list.map((i) => [i.key, i]));
  lstByOwner = new Map();
  for (const i of list) {
    if (i.source !== "inventory") continue;
    const tag = String(i.owner || "").trim().toUpperCase();
    if (!lstByOwner.has(tag)) lstByOwner.set(tag, []);
    lstByOwner.get(tag).push(i);
  }
}

function lstInvFor(row) {
  return lstInvById.get(lstKey(row.inventorySource, row.inventoryId)) || null;
}

// Bundles: one listing that's several Inventory items sold together. Stored
// as inventorySource "bundle" + inventoryId = the items' keys joined by ","
// (an item listed twice = 2 of it), so its key is "bundle:<keys>".
function lstIsBundleKey(key) {
  return String(key || "").startsWith("bundle:");
}

function lstBundleKey(itemKeys) {
  return lstKey("bundle", itemKeys.join(","));
}

// [{ key, count }] — what one unit of a link uses up. A plain item is itself ×1.
function lstParts(key) {
  if (!lstIsBundleKey(key)) return [{ key, count: 1 }];
  const counts = new Map();
  for (const k of key.slice("bundle:".length).split(",").filter(Boolean)) counts.set(k, (counts.get(k) || 0) + 1);
  return Array.from(counts, ([k, count]) => ({ key: k, count }));
}

// Display name for an item or bundle key ("" when the item is gone).
function lstKeyName(key) {
  if (lstIsBundleKey(key)) {
    return (
      "Bundle: " +
      lstParts(key)
        .map((p) => {
          const item = lstInvById.get(p.key);
          return `${p.count > 1 ? p.count + "× " : ""}${item ? lstItemName(item) : "(missing item)"}`;
        })
        .join(" + ")
    );
  }
  const item = lstInvById.get(key);
  return item ? lstItemName(item) : "";
}

// Sheet / Matches fields for a link: an item key, a bundle key, or "ignore".
function lstLinkFields(key) {
  if (key === "ignore") return { inventoryId: "ignore", inventorySource: "" };
  if (lstIsBundleKey(key)) return { inventoryId: key.slice("bundle:".length), inventorySource: "bundle" };
  const item = lstInvById.get(key);
  return { inventoryId: String(item.id), inventorySource: item.source };
}

function lstDays() {
  return parseInt(document.getElementById("lst-days").value, 10) || 30;
}

// First calendar day inside the sold window, as "yyyy-mm-dd".
function lstCutoffDay() {
  return lstIsoOf(new Date(Date.now() - lstDays() * 86400000));
}

// ---------- show sales (Sales Log, read-only) ----------

function lstSalesLogConfigured() {
  const url = CONFIG.SALES_LOG_SCRIPT_URL;
  return Boolean(url) && !url.startsWith("PASTE_");
}

function lstSalesLogApi(body) {
  return postToAppsScript(CONFIG.SALES_LOG_SCRIPT_URL, body);
}

function lstNorm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function lstParseMoney(v) {
  const n = parseFloat(String(v || "").replace(/[$,\s]/g, ""));
  return isFinite(n) ? n : 0;
}

// The row (within the first 15) whose cells include every label — exact or
// as the start of the cell ("Sold Price" also finds "Sold Price:").
function lstHeaderRow(values, labels) {
  for (let r = 0; r < Math.min(values.length, 15); r++) {
    const cells = values[r].map((v) => String(v).replace(/\s+/g, " ").trim().toLowerCase());
    if (labels.every((l) => cells.some((c) => c === l || c.startsWith(l)))) return { row: r, cells };
  }
  return null;
}

function lstCol(cells, label) {
  const exact = cells.indexOf(label);
  return exact >= 0 ? exact : cells.findIndex((c) => c.startsWith(label));
}

// Summary rows whose show overlaps the sold window.
function lstShowsInWindow(values) {
  const h = lstHeaderRow(values, ["starting date", "tab name"]);
  if (!h) throw new Error("couldn't find the Summary tab's headers");
  const col = { date: lstCol(h.cells, "starting date"), days: lstCol(h.cells, "# of days"), name: lstCol(h.cells, "convention"), tab: lstCol(h.cells, "tab name") };
  const cutoff = lstCutoffDay();
  const today = todayIso();
  const out = [];
  for (const row of values.slice(h.row + 1)) {
    const tab = String(row[col.tab] || "").trim();
    const start = lstSheetDate(row[col.date]);
    if (!tab || !start) continue;
    const daysText = String(row[col.days] || "").trim();
    const len = /^\d+$/.test(daysText) ? Math.max(1, parseInt(daysText, 10)) : 1;
    const end = lstIsoOf(new Date(start.getFullYear(), start.getMonth(), start.getDate() + len - 1));
    if (end >= cutoff && lstIsoOf(start) <= today) out.push({ tab, name: String(row[col.name] || "").trim() || tab, start });
  }
  return out;
}

// One show tab's sales. Tabs have drifted over time, so columns are found by
// header label; sales end at the first row with a Name but no Tag (the
// C.O.G.S. / dues / totals blocks). Duplicate rows are real sales — the
// occurrence count keeps their keys apart. stockOut is null on older tabs
// that have no "Stock Removed" column.
function lstParseShowTab(show, values) {
  const h = lstHeaderRow(values, ["name", "sold price"]);
  if (!h) return [];
  const col = {};
  for (const [k, label] of Object.entries({ day: "day", tag: "tag", name: "name", line: "line", license: "license", price: "sold price", pos: "pos", stock: "stock removed" })) {
    col[k] = lstCol(h.cells, label);
  }
  const get = (row, i) => (i >= 0 ? String(row[i] || "").trim() : "");
  const seen = new Map();
  const out = [];
  for (const row of values.slice(h.row + 1)) {
    const tag = get(row, col.tag).toUpperCase();
    const name = get(row, col.name);
    if (!tag && !name) continue;
    if (!tag || /:$/.test(name)) break;
    if (!name) continue;
    const price = get(row, col.price);
    const base = `show:${show.tab}:${tag}:${name}:${price}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    const day = parseInt(get(row, col.day), 10);
    const date = new Date(show.start.getFullYear(), show.start.getMonth(), show.start.getDate() + (day >= 1 && day <= 10 ? day - 1 : 0));
    out.push({
      key: `${base}:${n}`,
      show,
      tag,
      name,
      line: get(row, col.line),
      license: get(row, col.license),
      price,
      pos: get(row, col.pos),
      date: lstIsoOf(date),
      stockOut: col.stock >= 0 ? Boolean(get(row, col.stock)) : null,
    });
  }
  return out;
}

// A tab that can't be read (renamed, deleted) is skipped and named in missing.
async function lstLoadShowSales() {
  const summary = await lstSalesLogApi({ action: "getSummary" });
  const shows = lstShowsInWindow(summary.values || []);
  const missing = [];
  const tabs = await Promise.all(
    shows.map((s) =>
      lstSalesLogApi({ action: "getShowTab", tab: s.tab })
        .then((res) => lstParseShowTab(s, res.values || []))
        .catch(() => {
          missing.push(s.tab);
          return [];
        })
    )
  );
  return { sales: tabs.flat(), missing };
}

function lstShowMatchKey(s) {
  return `${s.tag}|${lstNorm(s.name)}`;
}

// Inventory item for a show sale: a confirmed match first; otherwise the one
// Pop with that exact name under the sale's Owner tag (narrowed by Line /
// License when there are several). A Tag with no Inventory rows at all (e.g.
// posters) isn't inventory. Returns an lstKey, "ignore", or null (needs a match).
function lstShowItemKey(s) {
  const m = lstShowMatches.get(lstShowMatchKey(s));
  if (m) return m.inventoryId === "ignore" ? "ignore" : lstKey(m.inventorySource, m.inventoryId);
  const owned = lstByOwner.get(s.tag);
  if (!owned) return "ignore";
  let hits = owned.filter((i) => lstNorm(i.name) === lstNorm(s.name));
  if (hits.length > 1) {
    const narrowed = hits.filter((i) => (!s.line || lstNorm(i.line) === lstNorm(s.line)) && (!s.license || lstNorm(i.license) === lstNorm(s.license)));
    if (narrowed.length) hits = narrowed;
  }
  return hits.length === 1 ? hits[0].key : null;
}

// ---------- every sale, one shape ----------

function lstEbayItemKey(itemId) {
  const m = lstMatches.get(itemId);
  if (!m) return null;
  return m.inventoryId === "ignore" ? "ignore" : lstKey(m.inventorySource, m.inventoryId);
}

// key is the sale key Committed uses; day is the local "yyyy-mm-dd";
// item is an lstKey, "ignore" (not an inventory item) or null (needs a match).
function lstAllSales() {
  const out = [];
  for (const s of lstSold) {
    out.push({
      key: `ebay:${s.lineItemId || s.orderId + ":" + s.itemId}`,
      platform: "ebay",
      day: lstIsoOf(lstParseDate(s.created) || new Date(0)),
      qty: s.qty,
      amount: s.price * s.qty,
      item: lstEbayItemKey(s.itemId),
      cancelled: /cancel/i.test(s.status),
      ebay: s,
    });
  }
  for (const c of lstCross) {
    if (c.status !== "sold") continue;
    const qty = parseInt(c.qty, 10) || 1;
    out.push({
      key: `${c.platform}:${c.id}`,
      platform: c.platform,
      day: c.soldDate,
      qty,
      amount: (Number(c.price) || 0) * qty,
      item: c.inventoryId === "ignore" ? "ignore" : c.inventoryId ? lstKey(c.inventorySource, c.inventoryId) : null,
      cross: c,
    });
  }
  for (const s of lstShowSales) {
    out.push({ key: s.key, platform: "show", day: s.date, qty: 1, amount: lstParseMoney(s.price), item: lstShowItemKey(s), show: s });
  }
  return out;
}

// Online sales Commit can still subtract.
function lstCommitCandidates() {
  if (!lstCommitted) return [];
  return lstAllSales().filter((e) => e.platform !== "show" && !e.cancelled && e.day >= LST_COMMIT_FROM && !lstCommitted.has(e.key));
}

// Sold units Inventory Qty doesn't reflect yet, per item: uncommitted online
// sales, and show sales whose stock wasn't removed in the Sales Log. Older
// show tabs have no Stock Removed column — those count as already removed.
function lstPendingQty() {
  const pending = new Map();
  const add = (key, n) => pending.set(key, (pending.get(key) || 0) + n);
  for (const e of lstCommitCandidates()) {
    if (e.item && e.item !== "ignore") for (const p of lstParts(e.item)) add(p.key, e.qty * p.count);
  }
  for (const s of lstShowSales) {
    if (s.stockOut !== false) continue;
    const key = lstShowItemKey(s);
    if (key && key !== "ignore") for (const p of lstParts(key)) add(p.key, p.count);
  }
  return pending;
}

async function loadListingsOverview() {
  if (lstLoading) return;
  lstLoading = true;
  lstBanner("Loading…", "info");
  const problems = [];
  let anyError = false;
  const fail = (what) => (err) => {
    anyError = true;
    problems.push(`${what}: ${err.message}`);
  };
  const tasks = [
    lstLoadInventory()
      .then(lstSetInventory)
      .catch(fail("Couldn't load Inventory")),
  ];

  const token = (getEbaySettings().authToken || "").trim();
  if (token) {
    // Far enough back to cover every sale Commit could still need (eBay's cap is 90 days).
    const sinceCommitFrom = Math.ceil((Date.now() - lstParseDate(LST_COMMIT_FROM).getTime()) / 86400000) + 1;
    const fetchDays = Math.max(lstDays(), Math.min(90, sinceCommitFrom));
    tasks.push(
      Promise.all([lstFetchActive(token), lstFetchSold(token, fetchDays)])
        .then(([active, sold]) => {
          lstActive = active;
          lstSold = sold;
        })
        .catch(fail("Couldn't load from eBay"))
    );
  } else {
    problems.push("Add your eBay token in the eBay tab's ⚙ Settings to see eBay listings.");
  }

  if (lstSheetConfigured()) {
    tasks.push(
      lstApi({ action: "getAll" })
        .then((res) => {
          lstCross = res.crossListings || [];
          lstBatches = res.batches || [];
          lstMatches = new Map((res.matches || []).filter((m) => m.source === "ebay").map((m) => [m.sourceKey, m]));
          lstShowMatches = new Map((res.matches || []).filter((m) => m.source === "show").map((m) => [m.sourceKey, m]));
          lstCommitted = Array.isArray(res.committed) ? new Set(res.committed.map((c) => c.saleKey)) : null;
          if (!lstCommitted) problems.push("Commit sales needs the Listings Apps Script updated to v3 (listings-overview-apps-script.txt).");
          lstSheetReady = true;
        })
        .catch(fail("Couldn't load the Listings sheet"))
    );
  } else {
    problems.push("The Listings sheet isn't set up yet — Mercari/Whatnot/FB and Inventory matching need it (see README → Listings).");
  }

  if (lstSalesLogConfigured()) {
    tasks.push(
      lstLoadShowSales()
        .then(({ sales, missing }) => {
          lstShowSales = sales;
          if (missing.length) problems.push(`Couldn't read show tab${missing.length === 1 ? "" : "s"} ${missing.join(", ")} (check the Summary's Tab Name).`);
        })
        .catch((err) => {
          lstShowSales = [];
          if (/unknown action/i.test(err.message)) problems.push("Show sales need the Sales Log Apps Script updated to v3 (sales-log-apps-script.txt).");
          else fail("Couldn't load show sales")(err);
        })
    );
  }

  await Promise.all(tasks);
  lstLoading = false;
  lstBanner(problems.join("  ·  "), anyError ? "error" : "info");
  renderListingsOverview();
}

// ---------- formatting ----------

// "2026-10-26" is a local calendar date; full ISO strings are real instants.
function lstParseDate(s) {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(s);
  return isNaN(d) ? null : d;
}

function lstIsoOf(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Sheet display dates: "10/18/2026", "2026-10-18" or "Oct 18, 2026".
function lstSheetDate(s) {
  const t = String(s || "").trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t);
  if (m) return new Date(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[1] - 1, +m[2]);
  return t ? lstParseDate(t) : null;
}

function lstDate(s) {
  const d = lstParseDate(s);
  return d ? d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
}

function lstMoney(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

function lstItemLink(itemId, text) {
  return itemId
    ? `<a class="ebay-item-link" href="https://www.ebay.com/itm/${encodeURIComponent(itemId)}" target="_blank" rel="noopener">${text}</a>`
    : text;
}

function lstItemName(item) {
  return `${item.name}${item.number ? " #" + item.number : ""}${item.source === "autograph" ? " ✍ SIGNED" : ""}`;
}

function lstItemSub(item) {
  const who = item.source === "autograph" ? (item.signedBy ? `Signed by ${item.signedBy}` : "Autographs tab") : `Owner ${item.owner}`;
  return [item.line, who, item.authCoa, `${item.qty || 0} in stock`].filter(Boolean).join(" · ");
}

// ---------- grouping ----------

function lstIsLive(c) {
  return c.status === "live" || c.status === "exported";
}

// Live listings grouped by Inventory item, plus eBay listings that still need
// a match and ones confirmed as "not an inventory item".
function lstBuildGroups() {
  const groups = new Map();
  const unmatched = [];
  const ignored = [];
  const add = (key, entry) => {
    if (!groups.has(key)) groups.set(key, { key, item: lstInvById.get(key) || null, listings: [] });
    groups.get(key).listings.push(entry);
  };
  for (const a of lstActive) {
    const m = lstMatches.get(a.itemId);
    if (!m) unmatched.push(a);
    else if (m.inventoryId === "ignore") ignored.push(a);
    else add(lstKey(m.inventorySource, m.inventoryId), { platform: "ebay", ebay: a });
  }
  for (const c of lstCross) {
    if (!lstIsLive(c)) continue;
    const key =
      c.inventoryId === "ignore" ? `ignore:${c.title}` : c.inventoryId ? lstKey(c.inventorySource, c.inventoryId) : `title:${c.title}`;
    add(key, { platform: c.platform, cross: c });
  }
  const all = Array.from(groups.values());
  // Sheet listings marked "not an inventory item" (bundles etc.) are shown
  // with the ignored eBay listings, not in the live list.
  const ignoredGroups = all.filter((g) => g.key.startsWith("ignore:"));
  const list = all.filter((g) => !g.key.startsWith("ignore:"));
  for (const g of all) {
    g.listings.sort((x, y) => lstTier(x.platform) - lstTier(y.platform));
    const first = g.listings[0];
    g.name = g.item ? lstItemName(g.item) : lstIsBundleKey(g.key) ? lstKeyName(g.key) : (first.ebay || first.cross).title || "(no title)";
  }
  list.sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true, sensitivity: "base" }));
  return { groups: list, unmatched, ignored, ignoredGroups };
}

function lstGroupMatches(g, q) {
  if (!q) return true;
  const parts = [g.name];
  if (g.item) parts.push(g.item.line, g.item.license, g.item.owner, g.item.signedBy);
  if (lstIsBundleKey(g.key)) parts.push("bundle");
  for (const l of g.listings) {
    if (l.ebay) parts.push(l.ebay.title, l.ebay.itemId);
    if (l.cross) parts.push(l.cross.title, lstPlatformLabel(l.cross.platform));
  }
  return parts.join(" ").toLowerCase().includes(q);
}

function lstEbayMatches(a, q) {
  return !q || a.title.toLowerCase().includes(q) || a.itemId.includes(q);
}

// ---------- sorting (live listings) ----------

// price = the highest price the item is listed at on any platform;
// platforms = how many different platforms it's live on.
function lstSortInfo(listings) {
  const prices = listings.map((l) => (l.ebay ? l.ebay.price : Number(l.cross.price) || 0));
  return { price: Math.max(0, ...prices), platforms: new Set(listings.map((l) => l.platform)).size };
}

function lstSortEntries(entries) {
  const mode = document.getElementById("lst-sort").value;
  const byName = (x, y) => x.name.localeCompare(y.name, undefined, { numeric: true, sensitivity: "base" });
  const cmp = {
    "price-desc": (x, y) => y.price - x.price,
    "price-asc": (x, y) => x.price - y.price,
    "platforms-desc": (x, y) => y.platforms - x.platforms,
    "platforms-asc": (x, y) => x.platforms - y.platforms,
  }[mode];
  return entries.slice().sort((x, y) => (cmp && cmp(x, y)) || byName(x, y));
}

// ---------- render ----------

function lstEbayChip(a) {
  const detail = `${a.type === "Auction" ? "auction " : ""}${lstMoney(a.price)}${a.qty > 1 ? " ×" + a.qty : ""}`;
  return `<span class="lst-chip lst-chip-ebay">${lstItemLink(a.itemId, `eBay ${detail}`)}<button class="lst-chip-btn" data-act="rematch" data-item="${escapeHtml(a.itemId)}" title="Change Inventory match">⇄</button></span>`;
}

function lstCrossChip(c) {
  const qty = parseInt(c.qty, 10) || 1;
  const detail = [c.price ? lstMoney(c.price) : "", qty > 1 ? "×" + qty : "", c.status === "exported" ? "(exported, not confirmed live)" : ""]
    .filter(Boolean)
    .join(" ");
  return `<span class="lst-chip lst-chip-${escapeHtml(c.platform)}">${escapeHtml(lstPlatformLabel(c.platform))} ${escapeHtml(detail)}<button class="lst-chip-sold" data-act="sold" data-id="${escapeHtml(c.id)}" title="Sold one">Sold</button><button class="lst-chip-btn" data-act="end" data-id="${escapeHtml(c.id)}" title="Taken down (not sold)">✕</button></span>`;
}

function lstUnlinkedCross(g) {
  return g.listings.filter((l) => l.cross && !l.cross.inventoryId).map((l) => l.cross);
}

// Sheet rows whose link can be (re)set from the Match dialog: unlinked,
// marked not-an-inventory-item, or a bundle.
function lstRelinkableCross(g) {
  return g.listings
    .filter((l) => l.cross && (!l.cross.inventoryId || l.cross.inventoryId === "ignore" || l.cross.inventorySource === "bundle"))
    .map((l) => l.cross);
}

// "Bundle of 3 items · stock for 2" — how many whole bundles Inventory covers.
function lstBundleSub(key) {
  const parts = lstParts(key);
  const stock = Math.min(...parts.map((p) => Math.floor((parseInt((lstInvById.get(p.key) || {}).qty, 10) || 0) / p.count)));
  const n = parts.reduce((sum, p) => sum + p.count, 0);
  return `Bundle of ${n} Inventory items · stock for ${stock}`;
}

// Match-dialog entry for exported listings with no Inventory link — one entry
// per title group, and the match is applied to every unlinked row in it.
function lstCrossMatchEntry(g) {
  const rows = lstRelinkableCross(g);
  const c = rows[0];
  return { itemId: "", title: c.title || "(no title)", price: Number(c.price) || 0, qty: rows.reduce((n, r) => n + (parseInt(r.qty, 10) || 1), 0), photo: "", crossRows: rows };
}

function lstGroupRow(g) {
  const ebay = g.listings.find((l) => l.ebay);
  const photo = ebay && ebay.ebay.photo;
  return `<div class="bl-row lst-row">
  ${photo ? `<img class="lst-thumb" src="${escapeHtml(photo)}" alt="" loading="lazy" />` : `<div class="lst-thumb"></div>`}
  <div class="lst-row-main">
    <div class="bl-row-title">${escapeHtml(g.name)}</div>
    <div class="bl-row-sub">${
      g.item ? escapeHtml(lstItemSub(g.item)) : lstIsBundleKey(g.key) ? escapeHtml(lstBundleSub(g.key)) : g.key.startsWith("ignore:") ? "Not an inventory item" : "Not linked to Inventory"
    }${
      !g.item && lstRelinkableCross(g).length
        ? ` <button class="secondary-btn lst-small" data-act="match-cross" data-key="${escapeHtml(g.key)}"${lstSheetReady ? "" : " disabled"}>${lstIsBundleKey(g.key) ? "Edit bundle" : "Match"}</button>`
        : ""
    }</div>
    <div class="lst-chips">${g.listings.map((l) => (l.ebay ? lstEbayChip(l.ebay) : lstCrossChip(l.cross))).join("")}</div>
  </div>
</div>`;
}

function lstEbayRow(a, buttonLabel) {
  return `<div class="bl-row lst-row">
  ${a.photo ? `<img class="lst-thumb" src="${escapeHtml(a.photo)}" alt="" loading="lazy" />` : `<div class="lst-thumb"></div>`}
  <div class="lst-row-main">
    <div class="bl-row-title">${lstItemLink(a.itemId, escapeHtml(a.title))}</div>
    <div class="bl-row-sub">${a.type === "Auction" ? "Auction · " : ""}${lstMoney(a.price)} · Qty ${a.qty}${a.startTime ? " · listed " + lstDate(a.startTime) : ""}</div>
  </div>
  <div class="bl-row-actions"><button class="secondary-btn lst-small" data-act="rematch" data-item="${escapeHtml(a.itemId)}"${lstSheetReady ? "" : " disabled"}>${buttonLabel}</button></div>
</div>`;
}

// Every sale (eBay, sheet, show) inside the chosen window, newest first.
function lstSoldEntries() {
  const cutoff = lstCutoffDay();
  const time = (e) => (e.ebay ? (lstParseDate(e.ebay.created) || new Date(0)).getTime() : (lstParseDate(e.day) || new Date(0)).getTime());
  return lstAllSales()
    .filter((e) => e.day >= cutoff)
    .sort((x, y) => time(y) - time(x));
}

function lstCommittedBadge(e) {
  return lstCommitted && lstCommitted.has(e.key) && e.item !== "ignore" ? `<span class="bl-badge lst-badge-live" title="Already taken off Inventory Qty">stock lowered</span>` : "";
}

function lstSoldRow(e, activeIds) {
  if (e.ebay) {
    const s = e.ebay;
    // A multi-quantity listing that sold one unit is still live — worth seeing.
    const stillLive = activeIds.has(s.itemId) ? `<span class="bl-badge lst-badge-live">still live on eBay</span>` : "";
    return `<div class="bl-row">
  <div class="bl-row-main">
    <div class="bl-row-title">${lstItemLink(s.itemId, escapeHtml(s.title || "(no title)"))}</div>
    <div class="bl-row-sub">${lstDate(s.created)} · ${s.qty} × ${lstMoney(s.price)} · ${escapeHtml(s.buyer)}${s.status && s.status !== "Completed" ? " · " + escapeHtml(s.status) : ""}</div>
  </div>
  <div class="bl-row-actions"><span class="bl-badge">eBay</span>${stillLive}${lstCommittedBadge(e)}</div>
</div>`;
  }
  if (e.show) {
    const s = e.show;
    const item = e.item && e.item !== "ignore" ? lstInvById.get(e.item) : null;
    const stock =
      s.stockOut === true
        ? `<span class="bl-badge lst-badge-live" title="Removed with the Sales Log's button">stock removed</span>`
        : s.stockOut === false
          ? `<span class="bl-badge" title="Use Remove sold stock in the app's Sales Log">stock not removed yet</span>`
          : "";
    return `<div class="bl-row">
  <div class="bl-row-main">
    <div class="bl-row-title">${escapeHtml(s.name)}${item ? ` <span class="lst-muted">→ ${escapeHtml(lstItemName(item))}</span>` : ""}</div>
    <div class="bl-row-sub">${lstDate(s.date)} · ${escapeHtml(s.show.name)} · ${escapeHtml(s.tag)} · ${escapeHtml(s.price || "no price")}${s.pos ? " · " + escapeHtml(s.pos) : ""}${
      e.item === "ignore" ? " · not an inventory item" : e.item ? "" : " · not matched to Inventory"
    }</div>
  </div>
  <div class="bl-row-actions"><span class="bl-badge lst-badge-show">Show</span>${stock}<button class="secondary-btn lst-small" data-act="match-show" data-key="${escapeHtml(s.key)}" title="Change Inventory match"${lstSheetReady ? "" : " disabled"}>${e.item ? "⇄" : "Match"}</button></div>
</div>`;
  }
  const c = e.cross;
  const item = lstInvFor(c);
  return `<div class="bl-row">
  <div class="bl-row-main">
    <div class="bl-row-title">${escapeHtml((e.item && e.item !== "ignore" && lstKeyName(e.item)) || c.title || "(no title)")}</div>
    <div class="bl-row-sub">${lstDate(c.soldDate)} · ${parseInt(c.qty, 10) || 1} × ${c.price ? lstMoney(c.price) : "no price"}${item && item.owner ? " · Owner " + escapeHtml(item.owner) : ""}</div>
  </div>
  <div class="bl-row-actions"><span class="bl-badge lst-badge-${escapeHtml(c.platform)}">${escapeHtml(lstPlatformLabel(c.platform))}</span>${lstCommittedBadge(e)}${
    lstCommitted && lstCommitted.has(e.key) ? "" : `<button class="secondary-btn lst-small" data-act="unsell" data-id="${escapeHtml(c.id)}" title="Wasn't sold — put it back to live">Undo</button>`
  }</div>
</div>`;
}

function lstSoldMatches(e, q) {
  if (!q) return true;
  if (e.ebay) return e.ebay.title.toLowerCase().includes(q) || e.ebay.itemId.includes(q);
  if (e.show) return `${e.show.name} ${e.show.show.name} ${e.show.tag} show`.toLowerCase().includes(q);
  const item = lstInvFor(e.cross);
  return `${e.cross.title} ${item ? lstItemName(item) : ""} ${lstPlatformLabel(e.platform)}`.toLowerCase().includes(q);
}

// ---------- Pull these ----------

function lstListingQty(l) {
  return l.ebay ? l.ebay.qty || 1 : parseInt(l.cross.qty, 10) || 1;
}

// Items that sold in the window (or have sales Inventory doesn't reflect yet)
// and are still listed somewhere for more than the stock left. A bundle sale
// counts as a sale of each item in it; a bundle listing is flagged when an
// item in it sold and there's no longer stock for that many whole bundles.
function lstPullList(groups) {
  const cutoff = lstCutoffDay();
  const recent = new Map();
  for (const e of lstAllSales()) {
    if (e.cancelled || !e.item || e.item === "ignore" || e.day < cutoff) continue;
    for (const p of lstParts(e.item)) {
      if (!recent.has(p.key)) recent.set(p.key, []);
      recent.get(p.key).push(e);
    }
  }
  const pending = lstPendingQty();
  const leftOf = (key) => {
    const item = lstInvById.get(key);
    return item ? Math.max(0, (parseInt(item.qty, 10) || 0) - (pending.get(key) || 0)) : null;
  };
  const touched = (key) => recent.has(key) || pending.has(key);
  const out = [];
  for (const g of groups) {
    let left;
    let sold;
    if (g.item) {
      if (!touched(g.key)) continue;
      left = leftOf(g.key);
      sold = recent.get(g.key) || [];
    } else if (lstIsBundleKey(g.key)) {
      const parts = lstParts(g.key);
      if (!parts.some((p) => touched(p.key)) || parts.some((p) => leftOf(p.key) === null)) continue;
      left = Math.min(...parts.map((p) => Math.floor(leftOf(p.key) / p.count)));
      sold = Array.from(new Set(parts.flatMap((p) => recent.get(p.key) || [])));
    } else {
      continue;
    }
    const flagged = g.listings.filter((l) => lstListingQty(l) > left);
    if (flagged.length) out.push({ g, sold, left, flagged });
  }
  return out;
}

function lstPullChip(l, left) {
  const what = left ? `Lower to ${left}` : "Pull";
  if (l.ebay) {
    const a = l.ebay;
    return `<span class="lst-chip lst-chip-ebay">${lstItemLink(a.itemId, `eBay ${lstMoney(a.price)}${a.qty > 1 ? " ×" + a.qty : ""} · <strong>${what}</strong>`)}</span>`;
  }
  const c = l.cross;
  const qty = parseInt(c.qty, 10) || 1;
  return `<span class="lst-chip lst-chip-${escapeHtml(c.platform)}">${escapeHtml(lstPlatformLabel(c.platform))}${qty > 1 ? " ×" + qty : ""} · <strong>${what}</strong>${
    left ? `<button class="lst-chip-sold" data-act="set-qty" data-id="${escapeHtml(c.id)}" data-qty="${left}" title="Lowered it on ${escapeHtml(lstPlatformLabel(c.platform))}">Qty now ${left}</button>` : ""
  }<button class="lst-chip-sold" data-act="pulled" data-id="${escapeHtml(c.id)}" title="Taken down on ${escapeHtml(lstPlatformLabel(c.platform))}">Taken down</button></span>`;
}

function lstRenderPull(groups) {
  const list = lstPullList(groups);
  const el = document.getElementById("lst-pull");
  el.hidden = !list.length;
  el.innerHTML = list.length
    ? `<h3 class="lst-heading">Pull these (${list.length})</h3>
<div class="lst-pull-note">Sold somewhere and still listed for more than what's left. eBay ones: end or lower them on eBay, then ↻ Refresh.</div>
<div class="bl-list">${list
        .map((p) => {
          const sold = p.sold.map((e) => `${e.show ? e.show.show.name : lstPlatformLabel(e.platform)} ${lstDate(e.day)}${e.qty > 1 ? " ×" + e.qty : ""}`).join(", ");
          return `<div class="bl-row lst-row">
  <div class="lst-row-main">
    <div class="bl-row-title">${escapeHtml(p.g.name)}</div>
    <div class="bl-row-sub">${sold ? "Sold: " + escapeHtml(sold) + " · " : ""}${p.left} left${p.g.item ? (p.g.item.owner ? " · Owner " + escapeHtml(p.g.item.owner) : "") : " (whole bundles)"}</div>
    <div class="lst-chips">${p.flagged.map((l) => lstPullChip(l, p.left)).join("")}</div>
  </div>
</div>`;
        })
        .join("")}</div>`
    : "";
}

// ---------- sales snapshot ----------

let lstSnap = "week"; // "week" | "month", remembered per browser

function lstSnapMode() {
  return lstSnap === "month" ? "month" : "week";
}

// Week = Monday–Sunday.
function lstPeriodOf(day, mode) {
  const d = lstParseDate(day);
  if (!d) return null;
  if (mode === "month") return { key: day.slice(0, 7), label: d.toLocaleDateString(undefined, { month: "long", year: "numeric" }) };
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return { key: lstIsoOf(monday), label: `Week of ${monday.toLocaleDateString(undefined, { month: "short", day: "numeric" })}` };
}

function lstRenderSnapshot(sales) {
  const mode = lstSnapMode();
  const periods = new Map();
  const totals = new Map();
  const bump = (map, platform, e) => {
    const cell = map.get(platform) || { n: 0, amount: 0 };
    cell.n += e.qty;
    cell.amount += e.amount;
    map.set(platform, cell);
  };
  for (const e of sales) {
    if (e.cancelled) continue;
    const p = lstPeriodOf(e.day, mode);
    if (!p) continue;
    if (!periods.has(p.key)) periods.set(p.key, { label: p.label, cells: new Map() });
    bump(periods.get(p.key).cells, e.platform, e);
    bump(periods.get(p.key).cells, "all", e);
    bump(totals, e.platform, e);
    bump(totals, "all", e);
  }
  const cell = (c) => (c ? `<strong>${c.n}</strong> · ${lstMoney(c.amount)}` : `<span class="lst-muted">—</span>`);
  const tiers = [];
  for (const p of LST_PLATFORMS) {
    const last = tiers[tiers.length - 1];
    if (last && last.tier === p.tier) last.span++;
    else tiers.push({ tier: p.tier, span: 1 });
  }
  const rows = Array.from(periods.entries())
    .sort((x, y) => y[0].localeCompare(x[0]))
    .map(([, p]) => `<tr><th>${escapeHtml(p.label)}</th>${LST_PLATFORMS.map((x) => `<td>${cell(p.cells.get(x.key))}</td>`).join("")}<td>${cell(p.cells.get("all"))}</td></tr>`)
    .join("");
  document.getElementById("lst-snapshot").innerHTML = `
<div class="lst-seg lst-snap-seg">
  <button class="lst-seg-btn${mode === "week" ? " active" : ""}" data-act="snap-mode" data-mode="week">By week</button>
  <button class="lst-seg-btn${mode === "month" ? " active" : ""}" data-act="snap-mode" data-mode="month">By month</button>
</div>
${
  periods.size
    ? `<div class="lst-snap-wrap"><table class="lst-snap">
<thead>
  <tr><th></th>${tiers.map((t) => `<th colspan="${t.span}" class="lst-snap-tier">${t.tier}</th>`).join("")}<th></th></tr>
  <tr><th></th>${LST_PLATFORMS.map((p) => `<th>${p.label}</th>`).join("")}<th>Total</th></tr>
</thead>
<tbody>${rows}</tbody>
<tfoot><tr><th>Last ${lstDays()} days</th>${LST_PLATFORMS.map((p) => `<td>${cell(totals.get(p.key))}</td>`).join("")}<td>${cell(totals.get("all"))}</td></tr></tfoot>
</table></div>`
    : `<div class="bl-empty">No sales in this period.</div>`
}
<div class="lst-pick-heading">Items sold · $ total. Mercari / Whatnot / FB use the listed price; show trades count as $0. Uses the Sold window above.</div>`;
}

function renderListingsOverview() {
  const q = document.getElementById("lst-search").value.trim().toLowerCase();
  const { groups, unmatched, ignored, ignoredGroups } = lstBuildGroups();
  const activeIds = new Set(lstActive.map((a) => a.itemId));
  const soldAll = lstSoldEntries();

  const liveCounts = LST_MANUAL_PLATFORMS.map((p) => {
    const n = lstCross.filter((c) => c.platform === p.key && lstIsLive(c)).length;
    return `${n} ${p.label}`;
  });
  document.getElementById("lst-count").textContent =
    `${lstActive.length} eBay · ${liveCounts.join(" · ")} · ${soldAll.length} sold in ${lstDays()} days`;
  document.getElementById("lst-add").disabled = !lstSheetReady;
  const toCommit = lstCommitCandidates().length;
  const commitBtn = document.getElementById("lst-commit");
  commitBtn.disabled = !lstSheetReady || !toCommit;
  commitBtn.textContent = toCommit ? `Commit sales (${toCommit})` : "Commit sales";

  lstRenderPull(groups);

  const sold = soldAll.filter((e) => lstSoldMatches(e, q));
  document.getElementById("lst-sold-count").textContent = q ? `${sold.length} of ${soldAll.length}` : soldAll.length;
  document.getElementById("lst-sold").innerHTML = sold.length
    ? sold.map((e) => lstSoldRow(e, activeIds)).join("")
    : `<div class="bl-empty">${soldAll.length ? "No sales match the search." : "No sales in this period."}</div>`;
  lstRenderSnapshot(soldAll);

  const unlinkedGroups = groups.filter((g) => !g.item && lstUnlinkedCross(g).length);
  const toMatch = unmatched.length + unlinkedGroups.length;
  const showsToMatch = lstUnmatchedShowSales().length;
  const matchBar = document.getElementById("lst-match-bar");
  matchBar.hidden = !toMatch && !showsToMatch;
  matchBar.innerHTML = [
    toMatch
      ? `<span><strong>${toMatch}</strong> listing${toMatch === 1 ? "" : "s"} not matched to Inventory yet.</span>
       <button class="primary-btn lst-small" data-act="match-all"${lstSheetReady ? "" : " disabled"}>Match them</button>`
      : "",
    showsToMatch
      ? `<span><strong>${showsToMatch}</strong> show sale name${showsToMatch === 1 ? "" : "s"} not matched — needed for Pull these.</span>
       <button class="secondary-btn lst-small" data-act="match-shows"${lstSheetReady ? "" : " disabled"}>Match show sales</button>`
      : "",
  ].join("");

  lstRenderBatches();

  const live = groups.filter((g) => lstGroupMatches(g, q));
  const unmatchedShown = unmatched.filter((a) => lstEbayMatches(a, q));
  const entries = [
    ...live.map((g) => ({ ...lstSortInfo(g.listings), name: g.name, html: lstGroupRow(g) })),
    ...unmatchedShown.map((a) => ({ price: a.price || 0, platforms: 1, name: a.title, html: lstEbayRow(a, "Match") })),
  ];
  const liveHtml = lstSortEntries(entries).map((e) => e.html).join("");
  document.getElementById("lst-live").innerHTML =
    liveHtml || `<div class="bl-empty">${groups.length || unmatched.length ? "No listings match the search." : "No live listings loaded."}</div>`;

  const ignoredShown = ignored.filter((a) => lstEbayMatches(a, q));
  const ignoredGroupsShown = ignoredGroups.filter((g) => lstGroupMatches(g, q));
  const ignoredCount = ignored.length + ignoredGroups.length;
  const ignoredWrap = document.getElementById("lst-ignored-wrap");
  ignoredWrap.hidden = !ignoredCount;
  document.getElementById("lst-ignored-count").textContent = ignoredCount;
  document.getElementById("lst-ignored").innerHTML =
    ignoredShown.map((a) => lstEbayRow(a, "Match")).join("") + ignoredGroupsShown.map(lstGroupRow).join("");
}

// Show sales in the window with no Inventory item yet — one per Tag + name,
// since a match covers every sale of that name.
function lstUnmatchedShowSales() {
  const cutoff = lstCutoffDay();
  const seen = new Set();
  return lstShowSales.filter((s) => {
    const k = lstShowMatchKey(s);
    if (s.date < cutoff || seen.has(k) || lstShowItemKey(s) !== null) return false;
    seen.add(k);
    return true;
  });
}

function lstShowMatchEntry(s) {
  return { itemId: "", title: s.name, price: lstParseMoney(s.price), qty: 1, photo: "", show: s };
}

// ---------- export batches ----------

function lstBatchRows(batchId) {
  return lstCross.filter((c) => c.exportBatch === batchId);
}

function lstRenderBatches() {
  const open = lstBatches
    .filter((b) => !b.confirmedLiveAt && lstBatchRows(b.batchId).some((c) => c.status === "exported"))
    .sort((x, y) => String(y.exportedAt).localeCompare(String(x.exportedAt)));
  const el = document.getElementById("lst-batches");
  el.hidden = !open.length;
  el.innerHTML = open.length
    ? `<h3 class="lst-heading">Exported — waiting for you to upload</h3>
<div class="bl-list">${open
        .map((b) => {
          const n = lstBatchRows(b.batchId).filter((c) => c.status === "exported").length;
          return `<div class="bl-row">
  <div class="bl-row-main">
    <div class="bl-row-title">${escapeHtml(lstPlatformLabel(b.platform))} · ${n} listing${n === 1 ? "" : "s"}</div>
    <div class="bl-row-sub">${escapeHtml(b.fileName)} · exported ${lstDate(b.exportedAt)}</div>
  </div>
  <div class="bl-row-actions"><button class="primary-btn lst-small" data-act="confirm-batch" data-batch="${escapeHtml(b.batchId)}">I uploaded this file</button></div>
</div>`;
        })
        .join("")}</div>`
    : "";
}

function lstOpenBatch(batchId) {
  const batch = lstBatches.find((b) => b.batchId === batchId);
  if (!batch) return;
  const rows = lstBatchRows(batchId)
    .filter((c) => c.status === "exported")
    .map((c) => ({ c, checked: true }));
  lstOpenModal({ kind: "batch", batch, rows });
}

function lstRenderBatch() {
  const m = lstModal;
  const label = escapeHtml(lstPlatformLabel(m.batch.platform));
  const n = m.rows.filter((r) => r.checked).length;
  document.getElementById("lst-modal-body").innerHTML = `
<h3 class="lst-modal-title">I uploaded this file</h3>
<div class="lst-pick-heading">${escapeHtml(m.batch.fileName)} · exported ${lstDate(m.batch.exportedAt)}. Ticked listings go live on ${label}; untick any that didn't make it — they're removed from the overview.</div>
<div class="lst-pick-list">
${m.rows
  .map((r, idx) => {
    const item = lstInvFor(r.c);
    return `<label class="lst-copy-row">
  <input type="checkbox" class="lst-copy-check" data-idx="${idx}"${r.checked ? " checked" : ""} />
  <span class="lst-copy-main">
    <span class="lst-pick-name">${escapeHtml(item ? lstItemName(item) : r.c.title || "(no title)")}</span>
    <span class="lst-pick-sub">${r.c.price ? lstMoney(r.c.price) : "no price"}${(parseInt(r.c.qty, 10) || 1) > 1 ? " · Qty " + r.c.qty : ""}${item ? "" : " · not linked to Inventory"}</span>
  </span>
</label>`;
  })
  .join("")}
</div>
<div class="lst-modal-actions">
  <button class="primary-btn" data-act="batch-save">Confirm ${n} live${m.rows.length - n ? `, remove ${m.rows.length - n}` : ""}</button>
</div>`;
}

async function lstSaveBatch() {
  const m = lstModal;
  const liveIds = m.rows.filter((r) => r.checked).map((r) => r.c.id);
  const droppedIds = m.rows.filter((r) => !r.checked).map((r) => r.c.id);
  const res = await lstApi({ action: "confirmBatch", batchId: m.batch.batchId, liveIds, droppedIds });
  m.batch.confirmedLiveAt = res.confirmedLiveAt || new Date().toISOString();
  const live = new Set(liveIds);
  const dropped = new Set(droppedIds);
  lstCross.forEach((c) => {
    if (live.has(c.id)) c.status = "live";
  });
  lstCross = lstCross.filter((c) => !dropped.has(c.id));
  const label = lstPlatformLabel(m.batch.platform);
  lstCloseModal();
  lstToast(`${liveIds.length} listing${liveIds.length === 1 ? "" : "s"} now live on ${label}.`);
}

// ---------- commit sales to inventory ----------

// Every item a sale's link points at still exists in Inventory.
function lstLinkResolved(key) {
  return Boolean(key && key !== "ignore" && lstParts(key).every((p) => lstInvById.has(p.key)));
}

// Match-dialog entry for a sale with no (or a missing) Inventory item.
function lstSaleMatchEntry(e) {
  if (e.ebay) return { itemId: e.ebay.itemId, title: e.ebay.title, price: e.ebay.price, qty: e.ebay.qty, photo: "" };
  const c = e.cross;
  return { itemId: "", title: c.title || "(no title)", price: Number(c.price) || 0, qty: e.qty, photo: "", crossRows: [c] };
}

function lstOpenCommit() {
  const rows = lstCommitCandidates()
    .sort((x, y) => String(x.day).localeCompare(String(y.day)))
    .map((e) => {
      const ready = lstLinkResolved(e.item);
      return { e, ready, checked: ready };
    });
  if (rows.length) lstOpenModal({ kind: "commit", rows });
}

function lstRenderCommit() {
  const m = lstModal;
  const ready = m.rows.filter((r) => r.ready);
  const toMatch = m.rows.filter((r) => !r.ready && r.e.item !== "ignore");
  const ignored = m.rows.filter((r) => r.e.item === "ignore");
  // Running Qty per item, so two sales of one Pop show 3 → 2 → 1.
  const running = new Map();
  const readyHtml = m.rows
    .map((r, idx) => {
      if (!r.ready) return "";
      // One line per item — a bundle lists each item in it.
      const lines = lstParts(r.e.item).map((p) => {
        const item = lstInvById.get(p.key);
        const sold = r.e.qty * p.count;
        const before = running.has(item.key) ? running.get(item.key) : parseInt(item.qty, 10) || 0;
        const after = r.checked ? Math.max(0, before - sold) : before;
        running.set(item.key, after);
        const who = item.source === "autograph" ? "Autographs" : `Owner ${item.owner}`;
        const name = lstIsBundleKey(r.e.item) ? `${lstItemName(item)}${p.count > 1 ? " ×" + p.count : ""} · ` : "";
        return `${escapeHtml(name + who)} · <strong>Qty ${before} → ${after}</strong>${sold > before && r.checked ? " (had less than sold)" : ""}`;
      });
      return `<label class="lst-copy-row">
  <input type="checkbox" class="lst-copy-check" data-idx="${idx}"${r.checked ? " checked" : ""} />
  <span class="lst-copy-main">
    <span class="lst-pick-name">${escapeHtml(lstKeyName(r.e.item))}</span>
    <span class="lst-pick-sub">${escapeHtml(lstPlatformLabel(r.e.platform))} · ${lstDate(r.e.day)} · sold ${r.e.qty}${lines.length > 1 ? "" : " · " + lines[0]}</span>
    ${lines.length > 1 ? lines.map((l) => `<span class="lst-pick-sub">${l}</span>`).join("") : ""}
  </span>
</label>`;
    })
    .join("");
  const n = ready.filter((r) => r.checked).length;
  document.getElementById("lst-modal-body").innerHTML = `
<h3 class="lst-modal-title">Commit sales to inventory</h3>
<div class="lst-pick-heading">Ticked sales lower Inventory Qty — each sale only ever once. Online sales since ${lstDate(LST_COMMIT_FROM)}; show stock stays with the Sales Log's button. Qty is re-read right before saving.</div>
${
  toMatch.length
    ? `<div class="lst-match-bar"><span><strong>${toMatch.length}</strong> sale${toMatch.length === 1 ? "" : "s"} need an Inventory match first.</span><button class="secondary-btn lst-small" data-act="commit-match">Match them</button></div>`
    : ""
}
${ready.length ? `<div class="lst-pick-list">${readyHtml}</div>` : `<div class="bl-empty">Nothing ready to commit yet.</div>`}
${ignored.length ? `<div class="lst-pick-heading">${ignored.length} not-inventory sale${ignored.length === 1 ? "" : "s"} (bundles etc.) will be marked done without changing Qty.</div>` : ""}
<div class="lst-modal-actions">
  <button class="primary-btn" data-act="commit-save"${n || ignored.length ? "" : " disabled"}>Commit ${n} sale${n === 1 ? "" : "s"}</button>
</div>`;
}

async function lstSaveCommit() {
  const m = lstModal;
  const picked = m.rows.filter((r) => r.ready && r.checked).map((r) => r.e);
  const ignored = m.rows.filter((r) => r.e.item === "ignore").map((r) => r.e);
  if (!picked.length && !ignored.length) return;

  // Current Qty, read right before writing — someone may have edited it.
  lstSetInventory(await lstLoadInventory(true));

  const res = await lstApi({
    action: "addCommitted",
    rows: [...picked, ...ignored].map((e) => ({ saleKey: e.key, inventoryId: e.item, qty: String(e.qty) })),
  });
  // Only keys the sheet hadn't seen are subtracted — the double-count guard.
  const added = new Set(res.added || []);
  const sales = picked.filter((e) => added.has(e.key));
  const soldPer = new Map(); // item key → units to subtract (bundles count each item)
  for (const e of sales) for (const p of lstParts(e.item)) soldPer.set(p.key, (soldPer.get(p.key) || 0) + e.qty * p.count);

  const failed = new Set(); // item keys whose Qty wasn't written (gone, or the write failed)
  const updates = { inventory: [], autograph: [] };
  for (const [key, sold] of soldPer) {
    const item = lstInvById.get(key);
    if (!item) failed.add(key);
    else updates[item.source].push({ item, qty: Math.max(0, (parseInt(item.qty, 10) || 0) - sold) });
  }
  const errors = [];
  const done = [];
  for (const [source, action] of [["inventory", "updateInventoryItems"], ["autograph", "updateAutographs"]]) {
    const list = updates[source];
    if (!list.length) continue;
    try {
      await lstInvApi({ action, items: list.map((u) => ({ id: u.item.id, fields: { qty: u.qty } })) });
      done.push(...list);
    } catch (err) {
      errors.push(err.message);
      for (const u of list) failed.add(u.item.key);
    }
  }
  // A sale none of whose items got written is un-recorded so it can be retried.
  // One that was partly written (a bundle across Pops + Autographs) stays
  // recorded — retrying it would subtract the written items twice.
  const undo = [];
  const partial = [];
  for (const e of sales) {
    const parts = lstParts(e.item);
    const bad = parts.filter((p) => failed.has(p.key)).length;
    if (bad === parts.length) undo.push(e.key);
    else if (bad) partial.push(e);
  }
  let undoFailed = false;
  if (undo.length) {
    try {
      await lstApi({ action: "deleteCommitted", saleKeys: undo });
    } catch (err) {
      undoFailed = true;
    }
  }

  for (const k of added) if (!undo.includes(k) || undoFailed) lstCommitted.add(k);
  for (const u of done) {
    u.item.qty = u.qty;
    lstSyncInventoryTab(u.item, u.qty);
  }
  const skipped = picked.length + ignored.length - added.size;
  lstCloseModal();
  if (errors.length || partial.length) {
    const msg =
      (errors.length ? `Inventory Qty didn't save (${errors.join(" | ")}).` : "") +
      (undo.length ? (undoFailed ? ` ${undo.length} sale(s) are still recorded as committed — fix their Qty in Inventory by hand.` : ` ${undo.length} sale(s) weren't committed — try again.`) : "") +
      (partial.length ? ` Partly saved — fix the rest by hand: ${partial.map((e) => lstKeyName(e.item)).join("; ")}.` : "");
    lstBanner(msg.trim());
    alert(msg.trim());
    return;
  }
  lstToast(
    `Inventory updated: ${done.length} item${done.length === 1 ? "" : "s"} lowered.` +
      (skipped ? ` ${skipped} already committed elsewhere, skipped.` : "") +
      (undo.length ? ` ${undo.length} skipped — item no longer in Inventory.` : "")
  );
}

// ---------- actions ----------

function lstToast(message, undo) {
  const el = document.getElementById("lst-toast");
  el.innerHTML = `<span>${escapeHtml(message)}</span>${undo ? `<button class="secondary-btn lst-small" id="lst-toast-undo">Undo</button>` : ""}`;
  el.hidden = false;
  clearTimeout(lstToastTimer);
  lstToastTimer = setTimeout(() => (el.hidden = true), 8000);
  if (undo) {
    document.getElementById("lst-toast-undo").addEventListener("click", () => {
      el.hidden = true;
      lstRun(undo);
    });
  }
}

// Runs one sheet write at a time; errors go to the banner.
async function lstRun(fn) {
  if (lstBusy) return;
  lstBusy = true;
  document.getElementById("tab-listings").classList.add("lst-busy");
  try {
    await fn();
  } catch (err) {
    lstBanner(`Couldn't save to the Listings sheet: ${err.message}`);
    if (lstModal) alert(`Couldn't save to the Listings sheet: ${err.message}`);
  } finally {
    lstBusy = false;
    document.getElementById("tab-listings").classList.remove("lst-busy");
    renderListingsOverview();
  }
}

async function lstUpdate(c, fields) {
  await lstApi({ action: "updateCrossListings", rows: [{ id: c.id, fields }] });
  Object.assign(c, fields);
}

function lstCopyFields(c) {
  const { inventoryId, inventorySource, platform, platformRef, title, price, listedDate, exportBatch } = c;
  return { inventoryId, inventorySource, platform, platformRef, title, price, listedDate, exportBatch };
}

function lstCrossLabel(c) {
  const item = lstInvFor(c);
  return `${item ? lstItemName(item) : c.title} on ${lstPlatformLabel(c.platform)}`;
}

// Qty 1: the row itself becomes the sale. Qty > 1: a new sold row (qty 1) is
// split off and the live row keeps the rest — one sold row per sale.
async function lstMarkSold(c) {
  const qty = parseInt(c.qty, 10) || 1;
  const today = todayIso();
  if (qty > 1) {
    const res = await lstApi({ action: "addCrossListings", rows: [{ ...lstCopyFields(c), qty: "1", status: "sold", soldDate: today }] });
    const soldRow = res.rows[0];
    lstCross.push(soldRow);
    await lstUpdate(c, { qty: String(qty - 1) });
    lstToast(`Sold: ${lstCrossLabel(c)} (${qty - 1} left)`, async () => {
      await lstApi({ action: "deleteCrossListings", ids: [soldRow.id] });
      lstCross = lstCross.filter((x) => x !== soldRow);
      await lstUpdate(c, { qty: String(qty) });
    });
  } else {
    const prev = c.status;
    await lstUpdate(c, { status: "sold", soldDate: today });
    lstToast(`Sold: ${lstCrossLabel(c)}`, () => lstUpdate(c, { status: prev, soldDate: "" }));
  }
}

// Puts a sold row back to live — folded back into its live sibling when the
// sale was split off a multi-quantity listing.
async function lstUnsell(c) {
  const sibling = lstCross.find(
    (x) => x !== c && lstIsLive(x) && x.platform === c.platform && x.inventoryId === c.inventoryId && x.inventorySource === c.inventorySource && x.platformRef === c.platformRef
  );
  if (sibling) {
    await lstUpdate(sibling, { qty: String((parseInt(sibling.qty, 10) || 1) + (parseInt(c.qty, 10) || 1)) });
    await lstApi({ action: "deleteCrossListings", ids: [c.id] });
    lstCross = lstCross.filter((x) => x !== c);
  } else {
    await lstUpdate(c, { status: "live", soldDate: "" });
  }
}

async function lstEnd(c) {
  const prev = c.status;
  await lstUpdate(c, { status: "ended" });
  lstToast(`Taken down: ${lstCrossLabel(c)}`, () => lstUpdate(c, { status: prev }));
}

function lstOnListClick(e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn || btn.disabled) return;
  const act = btn.dataset.act;
  const c = btn.dataset.id ? lstCross.find((x) => x.id === btn.dataset.id) : null;
  if (act === "sold" && c) lstRun(() => lstMarkSold(c));
  else if (act === "unsell" && c) lstRun(() => lstUnsell(c));
  else if (act === "end" && c) {
    if (confirm(`Mark ${lstCrossLabel(c)} as taken down (not sold)?`)) lstRun(() => lstEnd(c));
  } else if (act === "rematch") {
    const a = lstActive.find((x) => x.itemId === btn.dataset.item);
    if (a) lstOpenMatch([a]);
  } else if (act === "match-all") {
    const { groups, unmatched } = lstBuildGroups();
    lstOpenMatch([...unmatched, ...groups.filter((g) => !g.item && lstUnlinkedCross(g).length).map(lstCrossMatchEntry)]);
  } else if (act === "match-cross") {
    const { groups, ignoredGroups } = lstBuildGroups();
    const g = [...groups, ...ignoredGroups].find((x) => x.key === btn.dataset.key);
    if (g && lstRelinkableCross(g).length) lstOpenMatch([lstCrossMatchEntry(g)]);
  } else if (act === "confirm-batch") {
    lstOpenBatch(btn.dataset.batch);
  } else if (act === "pulled" && c) {
    lstRun(() => lstEnd(c));
  } else if (act === "set-qty" && c) {
    const prev = c.qty;
    lstRun(async () => {
      await lstUpdate(c, { qty: btn.dataset.qty });
      lstToast(`${lstCrossLabel(c)}: qty ${btn.dataset.qty}`, () => lstUpdate(c, { qty: prev }));
    });
  } else if (act === "match-show") {
    const s = lstShowSales.find((x) => x.key === btn.dataset.key);
    if (s) lstOpenMatch([lstShowMatchEntry(s)]);
  } else if (act === "match-shows") {
    lstOpenMatch(lstUnmatchedShowSales().map(lstShowMatchEntry));
  } else if (act === "snap-mode") {
    lstSnap = btn.dataset.mode;
    try {
      localStorage.setItem(LST_SNAP_KEY, btn.dataset.mode);
    } catch (err) {
      // ignore — stays on the default
    }
    lstRenderSnapshot(lstSoldEntries());
  }
}

// ---------- Inventory search / suggestions ----------

function lstTokens(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 2 && !LST_STOPWORDS.has(t));
}

const LST_SIGNED_WORDS = ["signed", "autograph", "autographed", "auto", "jsa", "beckett", "psa", "coa"];

// Likely Inventory items for an eBay title: name words found in the title,
// boosted when the Pop # appears ("#123" counts more than a bare 123).
// A title that says signed/autographed/JSA… leans to the Autographs tab
// (more so when the signer's name is in it); one that doesn't leans to Pops.
// ownerTag (show sales): only that Owner's Pops, and a looser cut-off since
// show names are shorthand ("Chopper CHASE").
function lstSuggest(title, ownerTag) {
  const titleTokens = new Set(lstTokens(title));
  const titleSigned = LST_SIGNED_WORDS.some((w) => titleTokens.has(w));
  const hashNums = new Set((title.match(/#\s?\d+[a-z]?/gi) || []).map((n) => n.replace(/[#\s]/g, "").toLowerCase()));
  const pool = (ownerTag && lstByOwner.get(ownerTag)) || lstInv;
  const minScore = ownerTag ? 1.5 : 2.5;
  return pool
    .map((item) => {
      const words = lstTokens(item.name).filter((t) => !/^\d+$/.test(t));
      if (!words.length) return null;
      let score = (words.filter((t) => titleTokens.has(t)).length / words.length) * 5;
      const num = String(item.number || "").trim().toLowerCase();
      if (num && hashNums.has(num)) score += 4;
      else if (num && titleTokens.has(num)) score += 2;
      if (item.source === "autograph") {
        score += titleSigned ? 1.5 : -1.5;
        if (lstTokens(item.signedBy).some((t) => titleTokens.has(t))) score += 1.5;
      } else if (titleSigned) {
        score -= 1;
      }
      return score >= minScore ? { item, score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((s) => s.item);
}

function lstSearchInventory(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return lstInv
    .filter((item) => {
      const signed = item.source === "autograph" ? `signed autograph ${item.signedBy} ${item.authCoa}` : "";
      const hay = `${item.name} ${item.number} ${item.line} ${item.license} ${item.owner} ${signed}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .slice(0, 40);
}

function lstPickButton(item, extra) {
  return `<button class="lst-pick" data-act="pick" data-inv="${escapeHtml(item.key)}">
  <span class="lst-pick-name">${escapeHtml(lstItemName(item))}</span>
  <span class="lst-pick-sub">${escapeHtml(lstItemSub(item))}${item.chase ? ` · <strong>Chase: ${escapeHtml(item.chase)}</strong>` : ""}${extra || ""}</span>
</button>`;
}

// ---------- modal ----------

function lstOpenModal(state) {
  lstModal = state;
  document.getElementById("lst-overlay").hidden = false;
  lstRenderModal();
}

function lstCloseModal() {
  if (lstModal && lstModal.kind === "add" && lstModal.pending.length && !confirm("Discard the listings you haven't saved?")) return;
  lstModal = null;
  document.getElementById("lst-overlay").hidden = true;
  renderListingsOverview();
}

function lstRenderModal() {
  if (!lstModal) return;
  if (lstModal.kind === "match") lstRenderMatch();
  else if (lstModal.kind === "copy") lstRenderCopy();
  else if (lstModal.kind === "batch") lstRenderBatch();
  else if (lstModal.kind === "commit") lstRenderCommit();
  else lstRenderAdd();
}

// Match: walks a queue of eBay listings one at a time.
function lstOpenMatch(queue) {
  if (!queue.length) return;
  lstOpenModal({ kind: "match", queue, index: 0, search: "" });
}

function lstRenderMatch() {
  const { queue, index } = lstModal;
  const a = queue[index];
  const current = a.crossRows ? null : a.show ? lstShowMatches.get(lstShowMatchKey(a.show)) : lstMatches.get(a.itemId);
  const where = a.show
    ? `Show · ${a.show.show.name} · Tag ${a.show.tag}${a.show.line ? " · " + a.show.line : ""} · ${a.show.price || "no price"}`
    : `${a.crossRows ? lstPlatformLabel(a.crossRows[0].platform) + " · " : ""}${lstMoney(a.price)} · Qty ${a.qty}`;
  const currentKey = current ? (current.inventoryId === "ignore" ? "ignore" : lstKey(current.inventorySource, current.inventoryId)) : a.crossRows ? lstCrossKey(a.crossRows[0]) : "";
  const currentText = !currentKey
    ? ""
    : currentKey === "ignore"
      ? "Currently: not an inventory item"
      : `Currently: ${lstKeyName(currentKey) || "an Inventory item that no longer exists"}`;
  const m = lstModal;
  const bundleHtml = m.bundle
    ? `<div class="lst-bundle">
  <div class="lst-pick-heading"><strong>Bundle</strong> — tap every Inventory item in this listing (tap one twice if the bundle has 2 of it).</div>
  ${m.bundle.length ? m.bundle.map((k, i) => `<div class="lst-pending-row"><span class="lst-pending-name">${escapeHtml(lstKeyName(k) || "(missing item)")}</span><button class="lst-chip-btn" data-act="bundle-remove" data-idx="${i}" title="Remove">✕</button></div>`).join("") : ""}
  <div class="lst-modal-actions">
    <button class="secondary-btn" data-act="bundle-cancel">Cancel bundle</button>
    <button class="primary-btn" data-act="bundle-save"${m.bundle.length >= 2 ? "" : " disabled"}>Save bundle (${m.bundle.length} item${m.bundle.length === 1 ? "" : "s"})</button>
  </div>
</div>`
    : "";
  document.getElementById("lst-modal-body").innerHTML = `
<h3 class="lst-modal-title">Match to Inventory${queue.length > 1 ? ` <span class="lst-muted">${index + 1} of ${queue.length}</span>` : ""}</h3>
<div class="lst-match-src">
  ${a.photo ? `<img class="lst-thumb" src="${escapeHtml(a.photo)}" alt="" />` : `<div class="lst-thumb"></div>`}
  <div>
    <div class="bl-row-title">${lstItemLink(a.itemId, escapeHtml(a.title))}</div>
    <div class="bl-row-sub">${escapeHtml(where)}${currentText ? " · " + escapeHtml(currentText) : ""}</div>
  </div>
</div>
${bundleHtml}
<input type="text" id="lst-match-search" class="toolbar-input lst-modal-search" placeholder="Search Inventory (name, #, line, owner)…" value="${escapeHtml(lstModal.search)}" />
<div id="lst-match-results" class="lst-pick-list"></div>
${
  m.bundle
    ? ""
    : `<div class="lst-modal-actions">
  <button class="secondary-btn" data-act="bundle-start" title="Several Inventory items sold together in one listing">Bundle…</button>
  <button class="secondary-btn" data-act="ignore">Not an inventory item</button>
  ${queue.length > 1 ? `<button class="secondary-btn" data-act="skip">Skip for now</button>` : ""}
</div>`
}`;
  const input = document.getElementById("lst-match-search");
  input.addEventListener("input", () => {
    lstModal.search = input.value;
    lstRenderMatchResults();
  });
  lstRenderMatchResults();
}

function lstRenderMatchResults() {
  const a = lstModal.queue[lstModal.index];
  const q = lstModal.search.trim();
  const list = q ? lstSearchInventory(q) : lstSuggest(a.title, a.show ? a.show.tag : "");
  const heading = q ? "" : `<div class="lst-pick-heading">${list.length ? "Suggestions" : "No likely matches — search above."}</div>`;
  document.getElementById("lst-match-results").innerHTML =
    heading + (list.length ? list.map((i) => lstPickButton(i)).join("") : q ? `<div class="lst-pick-heading">Nothing in Inventory matches.</div>` : "");
}

function lstCrossKey(c) {
  return c.inventoryId === "ignore" ? "ignore" : c.inventoryId ? lstKey(c.inventorySource, c.inventoryId) : "";
}

// key: an item's lstKey, a bundle key, or "ignore" for "not an inventory item".
async function lstSaveMatch(key) {
  const a = lstModal.queue[lstModal.index];
  if (key !== "ignore" && !lstIsBundleKey(key) && !lstInvById.get(key)) return;
  const fields = lstLinkFields(key);
  if (a.crossRows) {
    await lstApi({ action: "updateCrossListings", rows: a.crossRows.map((c) => ({ id: c.id, fields })) });
    a.crossRows.forEach((c) => Object.assign(c, fields));
    lstNextMatch();
    return;
  }
  if (a.show) {
    const match = { source: "show", sourceKey: lstShowMatchKey(a.show), ...fields, title: `${a.show.tag} ${a.show.name}` };
    await lstApi({ action: "saveMatches", matches: [match] });
    lstShowMatches.set(match.sourceKey, match);
    lstNextMatch();
    return;
  }
  const match = { source: "ebay", sourceKey: a.itemId, ...fields, title: a.title };
  await lstApi({ action: "saveMatches", matches: [match] });
  lstMatches.set(a.itemId, match);
  lstNextMatch();
}

function lstNextMatch() {
  lstModal.index += 1;
  lstModal.search = "";
  lstModal.bundle = null;
  if (lstModal.index >= lstModal.queue.length) {
    lstCloseModal();
    return;
  }
  lstRenderModal();
}

// Add: search Inventory, tap items into a list, one Save.
function lstOpenAdd() {
  lstOpenModal({ kind: "add", platform: lstLastPlatform, search: "", pending: [] });
}

function lstRenderAdd() {
  const m = lstModal;
  document.getElementById("lst-modal-body").innerHTML = `
<h3 class="lst-modal-title">Add listings</h3>
<div class="lst-seg">
  ${LST_MANUAL_PLATFORMS.map((p) => `<button class="lst-seg-btn${p.key === m.platform ? " active" : ""}" data-act="platform" data-p="${p.key}">${p.label}</button>`).join("")}
</div>
<div class="lst-copy-hint">Bulk-imported your eBay listings? <button class="secondary-btn lst-small" data-act="copy-ebay">Copy eBay listings to ${escapeHtml(lstPlatformLabel(m.platform))}…</button></div>
${m.savedNote ? `<div class="lst-saved-note">${escapeHtml(m.savedNote)}</div>` : ""}
<input type="text" id="lst-add-search" class="toolbar-input lst-modal-search" placeholder="Search Inventory to add (name, #, line, owner) — Enter adds the top result" value="${escapeHtml(m.search)}" />
<div id="lst-add-results" class="lst-pick-list"></div>
<div id="lst-add-pending"></div>`;
  const input = document.getElementById("lst-add-search");
  input.addEventListener("input", () => {
    m.search = input.value;
    lstRenderAddResults();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const top = lstSearchInventory(m.search.trim())[0];
    if (top) lstPend(top);
  });
  lstRenderAddResults();
  lstRenderAddPending();
  input.focus();
}

function lstLiveOn(item, platform) {
  return lstCross.some((c) => lstKey(c.inventorySource, c.inventoryId) === item.key && c.platform === platform && lstIsLive(c));
}

function lstRenderAddResults() {
  const m = lstModal;
  const label = lstPlatformLabel(m.platform);
  const list = lstSearchInventory(m.search.trim());
  document.getElementById("lst-add-results").innerHTML = m.search.trim()
    ? list.length
      ? list
          .map((i) => {
            const tags = [];
            if (m.pending.some((p) => p.item.key === i.key)) tags.push("in the list");
            if (lstLiveOn(i, m.platform)) tags.push(`already on ${label}`);
            return lstPickButton(i, tags.length ? ` · <strong>${escapeHtml(tags.join(", "))}</strong>` : "");
          })
          .join("")
      : `<div class="lst-pick-heading">Nothing in Inventory matches.</div>`
    : "";
}

function lstRenderAddPending() {
  const m = lstModal;
  const label = lstPlatformLabel(m.platform);
  document.getElementById("lst-add-pending").innerHTML = m.pending.length
    ? `<h4 class="lst-pick-heading">To add to ${escapeHtml(label)} (${m.pending.length})</h4>
${m.pending
  .map(
    (p, idx) => `<div class="lst-pending-row">
  <span class="lst-pending-name">${escapeHtml(lstItemName(p.item))} <span class="lst-muted">${escapeHtml(p.item.owner || p.item.signedBy)}</span></span>
  <label>$<input type="number" min="0" step="1" class="lst-pending-input" data-field="price" data-idx="${idx}" value="${escapeHtml(p.price)}" placeholder="price" /></label>
  <label>Qty<input type="number" min="1" step="1" class="lst-pending-input" data-field="qty" data-idx="${idx}" value="${escapeHtml(p.qty)}" /></label>
  <button class="lst-chip-btn" data-act="unpend" data-idx="${idx}" title="Remove">✕</button>
</div>`
  )
  .join("")}
<div class="lst-modal-actions"><button class="primary-btn" data-act="save-add">Save ${m.pending.length} to ${escapeHtml(label)}</button></div>`
    : `<div class="lst-pick-heading">Tap items above to add them. Price is optional.</div>`;
}

async function lstSaveAdd() {
  const m = lstModal;
  const today = todayIso();
  const rows = m.pending.map((p) => ({
    inventoryId: String(p.item.id),
    inventorySource: p.item.source,
    platform: m.platform,
    title: lstItemName(p.item),
    price: p.price === "" ? "" : String(Number(p.price) || 0),
    qty: String(Math.max(1, parseInt(p.qty, 10) || 1)),
    listedDate: today,
    status: "live",
  }));
  const res = await lstApi({ action: "addCrossListings", rows });
  lstCross.push(...(res.rows || []));
  // Stays open so the next batch can go straight in.
  m.pending = [];
  m.search = "";
  m.savedNote = `Saved ${rows.length} to ${lstPlatformLabel(m.platform)} ✓ — keep adding, or close when done.`;
  lstRenderAdd();
}

// Tapping (or Enter on) a search result: into the list, search cleared and
// focused again for the next one.
function lstPend(item) {
  const m = lstModal;
  if (item && !m.pending.some((p) => p.item.key === item.key)) m.pending.push({ item, price: "", qty: "1" });
  m.search = "";
  m.savedNote = "";
  const input = document.getElementById("lst-add-search");
  input.value = "";
  lstRenderAddResults();
  lstRenderAddPending();
  input.focus();
}

// Copy: every live eBay listing becomes a listing on another platform with the
// same Inventory link, price and qty — for platforms filled by a bulk import
// of the eBay store. platformRef "ebay:<ItemID>" remembers where it came from,
// and is how already-copied listings are recognised.
function lstOpenCopy(platform) {
  const rows = lstActive.map((a) => {
    const match = lstMatches.get(a.itemId) || null;
    const linked = match && match.inventoryId !== "ignore";
    const copied = lstCross.some((c) => c.platform === platform && lstIsLive(c) && c.platformRef === `ebay:${a.itemId}`);
    return { a, match: linked ? match : null, item: linked ? lstInvFor(match) : null, copied, checked: !copied };
  });
  rows.sort((x, y) => (x.item ? lstItemName(x.item) : x.a.title).localeCompare(y.item ? lstItemName(y.item) : y.a.title, undefined, { numeric: true, sensitivity: "base" }));
  lstModal = { kind: "copy", platform, rows };
  lstRenderModal();
}

function lstRenderCopy() {
  const m = lstModal;
  const label = escapeHtml(lstPlatformLabel(m.platform));
  const n = m.rows.filter((r) => r.checked).length;
  document.getElementById("lst-modal-body").innerHTML = `
<h3 class="lst-modal-title">Copy eBay listings to ${label}</h3>
<div class="lst-pick-heading">Untick anything that isn't on ${label}. Each copy keeps the eBay listing's Inventory link, price and qty.</div>
<div class="lst-copy-tools">
  <button class="secondary-btn lst-small" data-act="copy-all">Tick all</button>
  <button class="secondary-btn lst-small" data-act="copy-none">Untick all</button>
  <span class="lst-muted">${n} of ${m.rows.length} ticked</span>
</div>
<div class="lst-pick-list">
${m.rows
  .map(
    (r, idx) => `<label class="lst-copy-row">
  <input type="checkbox" class="lst-copy-check" data-idx="${idx}"${r.checked ? " checked" : ""} />
  <span class="lst-copy-main">
    <span class="lst-pick-name">${escapeHtml(r.item ? lstItemName(r.item) : r.a.title)}</span>
    <span class="lst-pick-sub">${lstMoney(r.a.price)}${r.a.qty > 1 ? " · Qty " + r.a.qty : ""}${
      r.item ? "" : r.match && r.match.inventorySource === "bundle" ? " · bundle" : r.match === null && lstMatches.has(r.a.itemId) ? " · not an inventory item" : " · no Inventory link"
    }${r.copied ? ` · <strong>already on ${label}</strong>` : ""}</span>
  </span>
</label>`
  )
  .join("")}
</div>
<div class="lst-modal-actions">
  <button class="secondary-btn" data-act="copy-back">Back</button>
  <button class="primary-btn" data-act="copy-save"${n ? "" : " disabled"}>Save ${n} to ${label}</button>
</div>`;
}

async function lstSaveCopy() {
  const m = lstModal;
  const today = todayIso();
  const rows = m.rows
    .filter((r) => r.checked)
    .map((r) => ({
      inventoryId: r.match ? r.match.inventoryId : "",
      inventorySource: r.match ? r.match.inventorySource || "inventory" : "",
      platform: m.platform,
      platformRef: `ebay:${r.a.itemId}`,
      title: r.item ? lstItemName(r.item) : r.a.title,
      price: String(r.a.price || ""),
      qty: String(Math.max(1, r.a.qty || 1)),
      listedDate: today,
      status: "live",
    }));
  const res = await lstApi({ action: "addCrossListings", rows });
  lstCross.push(...(res.rows || []));
  const label = lstPlatformLabel(m.platform);
  lstCloseModal();
  lstToast(`Added ${rows.length} listing${rows.length === 1 ? "" : "s"} on ${label}.`);
}

function lstOnModalClick(e) {
  if (e.target.id === "lst-overlay") {
    lstCloseModal();
    return;
  }
  const btn = e.target.closest("button[data-act]");
  if (!btn || !lstModal || lstBusy) return;
  const act = btn.dataset.act;
  if (lstModal.kind === "match") {
    const m = lstModal;
    if (act === "pick" && m.bundle) {
      m.bundle.push(btn.dataset.inv);
      m.search = "";
      lstRenderMatch();
      document.getElementById("lst-match-search").focus();
    } else if (act === "pick") lstRun(() => lstSaveMatch(btn.dataset.inv));
    else if (act === "ignore") lstRun(() => lstSaveMatch("ignore"));
    else if (act === "skip") lstNextMatch();
    else if (act === "bundle-start") {
      // Editing an existing bundle starts from its items.
      const a = m.queue[m.index];
      const cur = a.crossRows ? lstCrossKey(a.crossRows[0]) : (() => {
        const x = a.show ? lstShowMatches.get(lstShowMatchKey(a.show)) : lstMatches.get(a.itemId);
        return x ? lstKey(x.inventorySource, x.inventoryId) : "";
      })();
      m.bundle = lstIsBundleKey(cur) ? lstParts(cur).flatMap((p) => Array(p.count).fill(p.key)) : [];
      lstRenderMatch();
    } else if (act === "bundle-remove") {
      m.bundle.splice(Number(btn.dataset.idx), 1);
      lstRenderMatch();
    } else if (act === "bundle-cancel") {
      m.bundle = null;
      lstRenderMatch();
    } else if (act === "bundle-save" && m.bundle.length >= 2) {
      const key = lstBundleKey(m.bundle.slice().sort());
      lstRun(() => lstSaveMatch(key));
    }
    return;
  }
  if (lstModal.kind === "batch") {
    if (act === "batch-save") lstRun(lstSaveBatch);
    return;
  }
  if (lstModal.kind === "commit") {
    if (act === "commit-save") lstRun(lstSaveCommit);
    else if (act === "commit-match") lstOpenMatch(lstModal.rows.filter((r) => !r.ready && r.e.item !== "ignore").map((r) => lstSaleMatchEntry(r.e)));
    return;
  }
  if (lstModal.kind === "copy") {
    const m = lstModal;
    if (act === "copy-all" || act === "copy-none") {
      m.rows.forEach((r) => (r.checked = act === "copy-all"));
      lstRenderCopy();
    } else if (act === "copy-back") {
      lstOpenModal({ kind: "add", platform: m.platform, search: "", pending: [] });
    } else if (act === "copy-save") {
      lstRun(lstSaveCopy);
    }
    return;
  }
  const m = lstModal;
  if (act === "copy-ebay") {
    if (m.pending.length && !confirm("Discard the listings you haven't saved?")) return;
    lstOpenCopy(m.platform);
  } else if (act === "platform") {
    m.platform = lstLastPlatform = btn.dataset.p;
    m.savedNote = "";
    lstRenderAdd();
  } else if (act === "pick") {
    lstPend(lstInvById.get(btn.dataset.inv));
  } else if (act === "unpend") {
    m.pending.splice(Number(btn.dataset.idx), 1);
    lstRenderAddResults();
    lstRenderAddPending();
  } else if (act === "save-add") {
    lstRun(lstSaveAdd);
  }
}

function lstOnModalInput(e) {
  const el = e.target;
  if (lstModal && ["copy", "batch", "commit"].includes(lstModal.kind) && el.classList.contains("lst-copy-check")) {
    const r = lstModal.rows[Number(el.dataset.idx)];
    if (r && r.checked !== el.checked) {
      r.checked = el.checked;
      const scroll = el.closest(".lst-pick-list").scrollTop;
      lstRenderModal();
      document.querySelector("#lst-modal-body .lst-pick-list").scrollTop = scroll;
    }
    return;
  }
  if (!lstModal || lstModal.kind !== "add" || !el.classList.contains("lst-pending-input")) return;
  const p = lstModal.pending[Number(el.dataset.idx)];
  if (p) p[el.dataset.field] = el.value;
}

// ---------- init ----------

function initListingsOverview() {
  const sortEl = document.getElementById("lst-sort");
  try {
    const saved = localStorage.getItem(LST_SORT_KEY);
    if (saved && Array.from(sortEl.options).some((o) => o.value === saved)) sortEl.value = saved;
  } catch (err) {
    // ignore — falls back to A–Z
  }
  sortEl.addEventListener("change", () => {
    try {
      localStorage.setItem(LST_SORT_KEY, sortEl.value);
    } catch (err) {
      // ignore
    }
    renderListingsOverview();
  });
  const daysEl = document.getElementById("lst-days");
  try {
    const saved = localStorage.getItem(LST_DAYS_KEY);
    if (saved) daysEl.value = saved;
  } catch (err) {
    // ignore — falls back to 30 days
  }
  daysEl.addEventListener("change", () => {
    try {
      localStorage.setItem(LST_DAYS_KEY, daysEl.value);
    } catch (err) {
      // ignore
    }
    loadListingsOverview();
  });
  document.getElementById("lst-search").addEventListener("input", renderListingsOverview);
  document.getElementById("lst-refresh").addEventListener("click", loadListingsOverview);
  try {
    lstSnap = localStorage.getItem(LST_SNAP_KEY) || "week";
  } catch (err) {
    // ignore — by week
  }
  document.getElementById("lst-add").addEventListener("click", lstOpenAdd);
  document.getElementById("lst-commit").addEventListener("click", lstOpenCommit);
  for (const id of ["lst-sold", "lst-live", "lst-ignored", "lst-match-bar", "lst-batches", "lst-pull", "lst-snapshot"]) {
    document.getElementById(id).addEventListener("click", lstOnListClick);
  }
  const overlay = document.getElementById("lst-overlay");
  overlay.addEventListener("click", lstOnModalClick);
  overlay.addEventListener("input", lstOnModalInput);
  overlay.addEventListener("change", lstOnModalInput);
  document.getElementById("lst-modal-close").addEventListener("click", lstCloseModal);

  // Loads the first time the tab is opened, not on every page load.
  let loaded = false;
  document.querySelector('.tab-btn[data-tab="listings"]').addEventListener("click", () => {
    if (loaded) return;
    loaded = true;
    loadListingsOverview();
  });
}
