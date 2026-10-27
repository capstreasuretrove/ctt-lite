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
// Signed Pops live on the Autographs tab, whose IDs are separate from
// Inventory's, so every lookup is keyed by source + id (lstKey).
// Nothing here changes Inventory Qty — that's the later "Commit" button.

const LST_DAYS_KEY = "ctt-lite-listings-days";
const LST_MAX_PAGES = 10; // sanity cap: 2000 active listings / 1000 orders
// Tier order (Primary → Secondary → Tertiary) — display order everywhere.
const LST_PLATFORMS = [
  { key: "ebay", label: "eBay" },
  { key: "mercari", label: "Mercari" },
  { key: "whatnot", label: "Whatnot" },
  { key: "fb", label: "FB" },
];
const LST_MANUAL_PLATFORMS = LST_PLATFORMS.filter((p) => p.key !== "ebay");
const LST_STOPWORDS = new Set([
  "funko", "pop", "pops", "vinyl", "figure", "the", "and", "of", "with", "new", "in", "box", "exclusive",
]);

let lstActive = [];
let lstSold = [];
let lstCross = []; // CrossListings rows from the sheet
let lstMatches = new Map(); // eBay ItemID → Matches row
let lstInv = [];
let lstInvById = new Map(); // lstKey(source, id) → item
let lstSheetReady = false;
let lstLoading = false;
let lstBusy = false;
let lstModal = null; // { kind: "match" | "add", ... } while the overlay is open
let lstToastTimer = null;

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

// Pops (reusing the Inventory tab's copy when it has already loaded) plus
// signed items from the Autographs tab. Copies, tagged with source + key.
async function lstLoadInventory() {
  const popsP =
    typeof items !== "undefined" && items.length
      ? Promise.resolve(items)
      : postToAppsScript(CONFIG.INVENTORY_SCRIPT_URL, { action: "getInventory" }).then((res) => (res.items || []).map(normalizeItem));
  const [pops, agRes] = await Promise.all([popsP, postToAppsScript(CONFIG.INVENTORY_SCRIPT_URL, { action: "getAutographs" })]);
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

function lstInvFor(row) {
  return lstInvById.get(lstKey(row.inventorySource, row.inventoryId)) || null;
}

function lstDays() {
  return parseInt(document.getElementById("lst-days").value, 10) || 30;
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
      .then((list) => {
        lstInv = list;
        lstInvById = new Map(list.map((i) => [i.key, i]));
      })
      .catch(fail("Couldn't load Inventory")),
  ];

  const token = (getEbaySettings().authToken || "").trim();
  if (token) {
    tasks.push(
      Promise.all([lstFetchActive(token), lstFetchSold(token, lstDays())])
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
          lstMatches = new Map((res.matches || []).filter((m) => m.source === "ebay").map((m) => [m.sourceKey, m]));
          lstSheetReady = true;
        })
        .catch(fail("Couldn't load the Listings sheet"))
    );
  } else {
    problems.push("The Listings sheet isn't set up yet — Mercari/Whatnot/FB and Inventory matching need it (see README → Listings).");
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
    if (lstIsLive(c)) add(c.inventoryId ? lstKey(c.inventorySource, c.inventoryId) : `title:${c.title}`, { platform: c.platform, cross: c });
  }
  const list = Array.from(groups.values());
  for (const g of list) {
    g.listings.sort((x, y) => lstTier(x.platform) - lstTier(y.platform));
    const first = g.listings[0];
    g.name = g.item ? lstItemName(g.item) : (first.ebay || first.cross).title || "(no title)";
  }
  list.sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true, sensitivity: "base" }));
  return { groups: list, unmatched, ignored };
}

function lstGroupMatches(g, q) {
  if (!q) return true;
  const parts = [g.name];
  if (g.item) parts.push(g.item.line, g.item.license, g.item.owner, g.item.signedBy);
  for (const l of g.listings) {
    if (l.ebay) parts.push(l.ebay.title, l.ebay.itemId);
    if (l.cross) parts.push(l.cross.title, lstPlatformLabel(l.cross.platform));
  }
  return parts.join(" ").toLowerCase().includes(q);
}

function lstEbayMatches(a, q) {
  return !q || a.title.toLowerCase().includes(q) || a.itemId.includes(q);
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

function lstGroupRow(g) {
  const ebay = g.listings.find((l) => l.ebay);
  const photo = ebay && ebay.ebay.photo;
  return `<div class="bl-row lst-row">
  ${photo ? `<img class="lst-thumb" src="${escapeHtml(photo)}" alt="" loading="lazy" />` : `<div class="lst-thumb"></div>`}
  <div class="lst-row-main">
    <div class="bl-row-title">${escapeHtml(g.name)}</div>
    <div class="bl-row-sub">${g.item ? escapeHtml(lstItemSub(g.item)) : "Not found in Inventory"}</div>
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

// eBay orders + sold sheet rows inside the chosen window, newest first.
function lstSoldEntries() {
  const cutoff = Date.now() - lstDays() * 86400000;
  const out = lstSold.map((s) => ({ platform: "ebay", date: s.created, ebay: s }));
  for (const c of lstCross) {
    if (c.status !== "sold") continue;
    const d = lstParseDate(c.soldDate);
    // Whole days: anything sold on/after the cutoff's calendar day counts.
    if (d && d.getTime() >= cutoff - 86400000) out.push({ platform: c.platform, date: c.soldDate, cross: c });
  }
  const value = (e) => (lstParseDate(e.date) || new Date(0)).getTime();
  return out.sort((x, y) => value(y) - value(x));
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
  <div class="bl-row-actions"><span class="bl-badge">eBay</span>${stillLive}</div>
</div>`;
  }
  const c = e.cross;
  const item = lstInvFor(c);
  return `<div class="bl-row">
  <div class="bl-row-main">
    <div class="bl-row-title">${escapeHtml(item ? lstItemName(item) : c.title || "(no title)")}</div>
    <div class="bl-row-sub">${lstDate(c.soldDate)} · ${parseInt(c.qty, 10) || 1} × ${c.price ? lstMoney(c.price) : "no price"}${item && item.owner ? " · Owner " + escapeHtml(item.owner) : ""}</div>
  </div>
  <div class="bl-row-actions"><span class="bl-badge lst-badge-${escapeHtml(c.platform)}">${escapeHtml(lstPlatformLabel(c.platform))}</span><button class="secondary-btn lst-small" data-act="unsell" data-id="${escapeHtml(c.id)}" title="Wasn't sold — put it back to live">Undo</button></div>
</div>`;
}

function lstSoldMatches(e, q) {
  if (!q) return true;
  if (e.ebay) return e.ebay.title.toLowerCase().includes(q) || e.ebay.itemId.includes(q);
  const item = lstInvFor(e.cross);
  return `${e.cross.title} ${item ? lstItemName(item) : ""} ${lstPlatformLabel(e.platform)}`.toLowerCase().includes(q);
}

function renderListingsOverview() {
  const q = document.getElementById("lst-search").value.trim().toLowerCase();
  const { groups, unmatched, ignored } = lstBuildGroups();
  const activeIds = new Set(lstActive.map((a) => a.itemId));
  const soldAll = lstSoldEntries();

  const liveCounts = LST_MANUAL_PLATFORMS.map((p) => {
    const n = lstCross.filter((c) => c.platform === p.key && lstIsLive(c)).length;
    return `${n} ${p.label}`;
  });
  document.getElementById("lst-count").textContent =
    `${lstActive.length} eBay · ${liveCounts.join(" · ")} · ${soldAll.length} sold in ${lstDays()} days`;
  document.getElementById("lst-add").disabled = !lstSheetReady;

  const sold = soldAll.filter((e) => lstSoldMatches(e, q));
  document.getElementById("lst-sold").innerHTML = sold.length
    ? sold.map((e) => lstSoldRow(e, activeIds)).join("")
    : `<div class="bl-empty">${soldAll.length ? "No sales match the search." : "No sales in this period."}</div>`;

  const matchBar = document.getElementById("lst-match-bar");
  matchBar.hidden = !unmatched.length;
  matchBar.innerHTML = unmatched.length
    ? `<span><strong>${unmatched.length}</strong> eBay listing${unmatched.length === 1 ? "" : "s"} not matched to Inventory yet.</span>
       <button class="primary-btn lst-small" data-act="match-all"${lstSheetReady ? "" : " disabled"}>Match them</button>`
    : "";

  const live = groups.filter((g) => lstGroupMatches(g, q));
  const unmatchedShown = unmatched.filter((a) => lstEbayMatches(a, q));
  const liveHtml = live.map(lstGroupRow).join("") + unmatchedShown.map((a) => lstEbayRow(a, "Match")).join("");
  document.getElementById("lst-live").innerHTML =
    liveHtml || `<div class="bl-empty">${groups.length || unmatched.length ? "No listings match the search." : "No live listings loaded."}</div>`;

  const ignoredShown = ignored.filter((a) => lstEbayMatches(a, q));
  const ignoredWrap = document.getElementById("lst-ignored-wrap");
  ignoredWrap.hidden = !ignored.length;
  document.getElementById("lst-ignored-count").textContent = ignored.length;
  document.getElementById("lst-ignored").innerHTML = ignoredShown.map((a) => lstEbayRow(a, "Match")).join("");
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
    lstOpenMatch(lstBuildGroups().unmatched);
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
function lstSuggest(title) {
  const titleTokens = new Set(lstTokens(title));
  const titleSigned = LST_SIGNED_WORDS.some((w) => titleTokens.has(w));
  const hashNums = new Set((title.match(/#\s?\d+[a-z]?/gi) || []).map((n) => n.replace(/[#\s]/g, "").toLowerCase()));
  return lstInv
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
      return score >= 2.5 ? { item, score } : null;
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
  const current = lstMatches.get(a.itemId);
  const currentText = !current
    ? ""
    : current.inventoryId === "ignore"
      ? "Currently: not an inventory item"
      : `Currently: ${lstInvFor(current) ? lstItemName(lstInvFor(current)) : "an Inventory item that no longer exists"}`;
  document.getElementById("lst-modal-body").innerHTML = `
<h3 class="lst-modal-title">Match to Inventory${queue.length > 1 ? ` <span class="lst-muted">${index + 1} of ${queue.length}</span>` : ""}</h3>
<div class="lst-match-src">
  ${a.photo ? `<img class="lst-thumb" src="${escapeHtml(a.photo)}" alt="" />` : `<div class="lst-thumb"></div>`}
  <div>
    <div class="bl-row-title">${lstItemLink(a.itemId, escapeHtml(a.title))}</div>
    <div class="bl-row-sub">${lstMoney(a.price)} · Qty ${a.qty}${currentText ? " · " + escapeHtml(currentText) : ""}</div>
  </div>
</div>
<input type="text" id="lst-match-search" class="toolbar-input lst-modal-search" placeholder="Search Inventory (name, #, line, owner)…" value="${escapeHtml(lstModal.search)}" />
<div id="lst-match-results" class="lst-pick-list"></div>
<div class="lst-modal-actions">
  <button class="secondary-btn" data-act="ignore">Not an inventory item</button>
  ${queue.length > 1 ? `<button class="secondary-btn" data-act="skip">Skip for now</button>` : ""}
</div>`;
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
  const list = q ? lstSearchInventory(q) : lstSuggest(a.title);
  const heading = q ? "" : `<div class="lst-pick-heading">${list.length ? "Suggestions" : "No likely matches — search above."}</div>`;
  document.getElementById("lst-match-results").innerHTML =
    heading + (list.length ? list.map((i) => lstPickButton(i)).join("") : q ? `<div class="lst-pick-heading">Nothing in Inventory matches.</div>` : "");
}

// key: an item's lstKey, or "ignore" for "not an inventory item".
async function lstSaveMatch(key) {
  const a = lstModal.queue[lstModal.index];
  const item = key === "ignore" ? null : lstInvById.get(key);
  if (key !== "ignore" && !item) return;
  const match = {
    source: "ebay",
    sourceKey: a.itemId,
    inventoryId: item ? String(item.id) : "ignore",
    inventorySource: item ? item.source : "",
    title: a.title,
  };
  await lstApi({ action: "saveMatches", matches: [match] });
  lstMatches.set(a.itemId, match);
  lstNextMatch();
}

function lstNextMatch() {
  lstModal.index += 1;
  lstModal.search = "";
  if (lstModal.index >= lstModal.queue.length) {
    lstCloseModal();
    return;
  }
  lstRenderModal();
}

// Add: search Inventory, tap items into a list, one Save.
function lstOpenAdd() {
  lstOpenModal({ kind: "add", platform: "whatnot", search: "", pending: [] });
}

function lstRenderAdd() {
  const m = lstModal;
  document.getElementById("lst-modal-body").innerHTML = `
<h3 class="lst-modal-title">Add listings</h3>
<div class="lst-seg">
  ${LST_MANUAL_PLATFORMS.map((p) => `<button class="lst-seg-btn${p.key === m.platform ? " active" : ""}" data-act="platform" data-p="${p.key}">${p.label}</button>`).join("")}
</div>
<input type="text" id="lst-add-search" class="toolbar-input lst-modal-search" placeholder="Search Inventory to add (name, #, line, owner)…" value="${escapeHtml(m.search)}" />
<div id="lst-add-results" class="lst-pick-list"></div>
<div id="lst-add-pending"></div>`;
  const input = document.getElementById("lst-add-search");
  input.addEventListener("input", () => {
    m.search = input.value;
    lstRenderAddResults();
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
  const label = lstPlatformLabel(m.platform);
  m.pending = [];
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
    if (act === "pick") lstRun(() => lstSaveMatch(btn.dataset.inv));
    else if (act === "ignore") lstRun(() => lstSaveMatch("ignore"));
    else if (act === "skip") lstNextMatch();
    return;
  }
  const m = lstModal;
  if (act === "platform") {
    m.platform = btn.dataset.p;
    lstRenderAdd();
  } else if (act === "pick") {
    const item = lstInvById.get(btn.dataset.inv);
    if (item && !m.pending.some((p) => p.item.key === item.key)) m.pending.push({ item, price: "", qty: "1" });
    lstRenderAddResults();
    lstRenderAddPending();
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
  if (!lstModal || lstModal.kind !== "add" || !el.classList.contains("lst-pending-input")) return;
  const p = lstModal.pending[Number(el.dataset.idx)];
  if (p) p[el.dataset.field] = el.value;
}

// ---------- init ----------

function initListingsOverview() {
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
  document.getElementById("lst-add").addEventListener("click", lstOpenAdd);
  for (const id of ["lst-sold", "lst-live", "lst-ignored", "lst-match-bar"]) {
    document.getElementById(id).addEventListener("click", lstOnListClick);
  }
  const overlay = document.getElementById("lst-overlay");
  overlay.addEventListener("click", lstOnModalClick);
  overlay.addEventListener("input", lstOnModalInput);
  document.getElementById("lst-modal-close").addEventListener("click", lstCloseModal);

  // Loads the first time the tab is opened, not on every page load.
  let loaded = false;
  document.querySelector('.tab-btn[data-tab="listings"]').addEventListener("click", () => {
    if (loaded) return;
    loaded = true;
    loadListingsOverview();
  });
}
