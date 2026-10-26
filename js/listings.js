// CTT Lite — Listings Overview, phase 1 (see ctt-listings-overview-plan.md)
//
// Read-only view of what's live on eBay and what sold recently, straight
// from eBay's Trading API through the existing ebay-proxy:
//   - GetMyeBaySelling ActiveList → every active listing, tool-made or listed
//     directly on eBay.
//   - GetOrders → sales from the last 7/30/90 days (eBay won't return orders
//     older than 90 days).
// Uses the eBay token saved in the eBay tab's ⚙ Settings. Nothing here writes
// anything — Mercari/Whatnot/FB, Inventory matching and "Pull these" come in
// later phases.

const LST_DAYS_KEY = "ctt-lite-listings-days";
const LST_MAX_PAGES = 10; // sanity cap: 2000 active listings / 1000 orders

let lstActive = [];
let lstSold = [];
let lstLoading = false;

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
  return out.sort((a, b) => b.created.localeCompare(a.created));
}

function lstDays() {
  return parseInt(document.getElementById("lst-days").value, 10) || 30;
}

async function loadListingsOverview() {
  if (lstLoading) return;
  const token = (getEbaySettings().authToken || "").trim();
  if (!token) {
    lstBanner("Add your eBay token in the eBay tab's ⚙ Settings first — this page reads your listings with it.", "info");
    return;
  }
  lstLoading = true;
  lstBanner("Loading from eBay…", "info");
  try {
    [lstActive, lstSold] = await Promise.all([lstFetchActive(token), lstFetchSold(token, lstDays())]);
    lstBanner("");
  } catch (err) {
    lstBanner(`Couldn't load from eBay: ${err.message}`);
  } finally {
    lstLoading = false;
  }
  renderListingsOverview();
}

function lstDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function lstMoney(n) {
  return `$${n.toFixed(2)}`;
}

function lstItemLink(itemId, text) {
  return itemId
    ? `<a class="ebay-item-link" href="https://www.ebay.com/itm/${encodeURIComponent(itemId)}" target="_blank" rel="noopener">${text}</a>`
    : text;
}

function lstMatches(entry, q) {
  return !q || entry.title.toLowerCase().includes(q) || entry.itemId.includes(q);
}

function renderListingsOverview() {
  const q = document.getElementById("lst-search").value.trim().toLowerCase();
  const activeIds = new Set(lstActive.map((a) => a.itemId));
  const sold = lstSold.filter((s) => lstMatches(s, q));
  const active = lstActive.filter((a) => lstMatches(a, q));

  document.getElementById("lst-count").textContent = `${lstActive.length} active · ${lstSold.length} sold in ${lstDays()} days`;

  const soldEl = document.getElementById("lst-sold");
  soldEl.innerHTML = sold.length
    ? sold
        .map((s) => {
          // A multi-quantity listing that sold one unit is still live — worth seeing.
          const stillLive = activeIds.has(s.itemId) ? `<span class="bl-badge lst-badge-live">still live on eBay</span>` : "";
          return `<div class="bl-row">
  <div class="bl-row-main">
    <div class="bl-row-title">${lstItemLink(s.itemId, escapeHtml(s.title || "(no title)"))}</div>
    <div class="bl-row-sub">${lstDate(s.created)} · ${s.qty} × ${lstMoney(s.price)} · ${escapeHtml(s.buyer)}${s.status && s.status !== "Completed" ? " · " + escapeHtml(s.status) : ""}</div>
  </div>
  <div class="bl-row-actions"><span class="bl-badge">eBay</span>${stillLive}</div>
</div>`;
        })
        .join("")
    : `<div class="bl-empty">${lstSold.length ? "No sales match the search." : "No eBay sales in this period."}</div>`;

  const activeEl = document.getElementById("lst-active");
  activeEl.innerHTML = active.length
    ? active
        .map(
          (a) => `<div class="bl-row">
  ${a.photo ? `<img class="lst-thumb" src="${escapeHtml(a.photo)}" alt="" loading="lazy" />` : `<div class="lst-thumb"></div>`}
  <div class="bl-row-main">
    <div class="bl-row-title">${lstItemLink(a.itemId, escapeHtml(a.title))}</div>
    <div class="bl-row-sub">${a.type === "Auction" ? "Auction · " : ""}${lstMoney(a.price)} · Qty ${a.qty}${a.startTime ? " · listed " + lstDate(a.startTime) : ""}</div>
  </div>
  <div class="bl-row-actions"><span class="bl-badge">eBay</span></div>
</div>`
        )
        .join("")
    : `<div class="bl-empty">${lstActive.length ? "No listings match the search." : "No active eBay listings loaded."}</div>`;
}

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

  // Loads the first time the tab is opened, not on every page load.
  let loaded = false;
  document.querySelector('.tab-btn[data-tab="listings"]').addEventListener("click", () => {
    if (loaded) return;
    loaded = true;
    loadListingsOverview();
  });
}
