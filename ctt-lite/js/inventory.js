// CTT Lite — Inventory module (Pops only)
//
// Talks directly to the same Apps Script Web App the desktop app and the
// original site use (see CONFIG.INVENTORY_SCRIPT_URL). Column shape, per
// the port guide:
//   name, number, line, license, qty, owner, dateAdded, ebayListed,
//   size, chase, pieceCount, featured, id
//
// NOTE ON UNVERIFIED ASSUMPTIONS (flagging clearly since this hasn't been
// tested against the live Apps Script endpoint yet — there was no URL
// available while building this):
//   - normalizeItem() assumes getInventory's response is `{ ok, items: [...] }`
//     with items already keyed by the field names above (possibly `id` or
//     `ID`). If the real response differs, adjust normalizeItem() and the
//     `items:` line in loadInventory() — everything downstream works off
//     the normalized shape so that's the only place a mismatch would need
//     fixing.
//   - addInventoryItems / updateInventoryItems are assumed to accept a
//     partial item object (id + only the changed fields) for updates, and
//     to echo back saved items (with a server-assigned id) for adds. If
//     updates need the full row instead, change buildUpdatePayload() to
//     send the whole item.
//   - Owner defaulting to "BL" when blank is documented as a backend
//     behavior (Apps Script fills it in) — normalizeItem() also defaults
//     it client-side so filtering/display are consistent even before a
//     save round-trip confirms it.

const COLUMNS = [
  { key: "name", label: "Name", width: "1.7fr" },
  { key: "number", label: "#", width: "0.6fr" },
  { key: "line", label: "Line", width: "1fr" },
  { key: "license", label: "License", width: "1fr" },
  { key: "qty", label: "Qty", width: "0.5fr", type: "number" },
  { key: "owner", label: "Owner", width: "0.7fr" },
  { key: "dateAdded", label: "Added", width: "0.9fr" },
  { key: "ebayListed", label: "eBay", width: "0.5fr", type: "checkbox" },
  { key: "size", label: "Size", width: "0.6fr" },
  { key: "chase", label: "Chase", width: "0.8fr" },
  { key: "pieceCount", label: "Pcs", width: "0.5fr" },
  { key: "featured", label: "★", width: "0.45fr", type: "checkbox" },
];

const ROW_HEIGHT_ESTIMATE = 40;
const OVERSCAN = 8;

let items = [];
let filteredSorted = [];
let sortState = []; // [{key, dir}] — index 0 primary, index 1 secondary
let filters = { search: "", owner: "", line: "", zeroQty: false, notListed: false };
let rowHeight = ROW_HEIGHT_ESTIMATE;
let rowHeightMeasured = false;
let addRowDraft = blankDraft();
let addRowSaving = false;

/** Today's date as YYYY-MM-DD in the browser's local time (matches the
 * Sheet's plain-text dateAdded format, e.g. "2026-08-05"). */
function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function blankDraft() {
  const d = { owner: "BL", qty: "1", dateAdded: todayIso() };
  for (const col of COLUMNS) if (!(col.key in d)) d[col.key] = col.type === "checkbox" ? false : "";
  return d;
}

function isEmpty(v) {
  return v === undefined || v === null || String(v).trim() === "";
}

function valueCompare(x, y) {
  const xNum = parseFloat(x);
  const yNum = parseFloat(y);
  const xIsNum = !isEmpty(x) && !isNaN(xNum) && String(x).trim() !== "" && /^-?\d+(\.\d+)?$/.test(String(x).trim());
  const yIsNum = !isEmpty(y) && !isNaN(yNum) && /^-?\d+(\.\d+)?$/.test(String(y).trim());
  if (xIsNum && yIsNum) return xNum - yNum;
  return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
}

function compareSingle(x, y, dir) {
  const xEmpty = isEmpty(x);
  const yEmpty = isEmpty(y);
  if (xEmpty && yEmpty) return 0;
  if (xEmpty) return 1; // missing always sorts last, regardless of direction
  if (yEmpty) return -1;
  const cmp = valueCompare(x, y);
  return dir === "desc" ? -cmp : cmp;
}

function compareByKey(a, b, key, dir) {
  if (key === "line") {
    // Line alone rarely discriminates — License is what varies within a Line,
    // so sorting by Line always drags License along as a tiebreaker.
    const r1 = compareSingle(a.line, b.line, dir);
    if (r1 !== 0) return r1;
    return compareSingle(a.license, b.license, dir);
  }
  return compareSingle(a[key], b[key], dir);
}

function normalizeItem(raw) {
  const get = (...keys) => {
    for (const k of keys) if (raw[k] !== undefined) return raw[k];
    return "";
  };
  return {
    id: get("id", "ID"),
    name: get("name", "Name"),
    number: get("number", "Number"),
    line: get("line", "Line"),
    license: get("license", "License"),
    qty: get("qty", "Qty"),
    owner: get("owner", "Owner") || "BL",
    dateAdded: get("dateAdded", "DateAdded", "date_added"),
    ebayListed: Boolean(get("ebayListed", "EbayListed")),
    size: get("size", "Size"),
    chase: get("chase", "Chase"),
    pieceCount: get("pieceCount", "PieceCount"),
    featured: Boolean(get("featured", "Featured")),
  };
}

function passesFilters(item) {
  const q = filters.search.trim().toLowerCase();
  if (q) {
    const hay = `${item.name} ${item.number} ${item.line} ${item.license}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  if (filters.owner === "__CONSIGNMENT__") {
    if (!(item.owner && item.owner !== "BL")) return false;
  } else if (filters.owner && item.owner !== filters.owner) {
    return false;
  }
  if (filters.line && item.line !== filters.line) return false;
  if (filters.zeroQty && !(Number(item.qty) <= 0)) return false;
  if (filters.notListed && item.ebayListed) return false;
  return true;
}

function applyFiltersAndSort() {
  let list = items.filter(passesFilters);
  if (sortState.length) {
    list = list.slice().sort((a, b) => {
      for (const { key, dir } of sortState) {
        const r = compareByKey(a, b, key, dir);
        if (r !== 0) return r;
      }
      return 0;
    });
  }
  filteredSorted = list;
  updateCountLabel();
  renderVirtualRows();
}

function updateCountLabel() {
  const el = document.getElementById("inv-count");
  if (el) el.textContent = `${filteredSorted.length} of ${items.length} item${items.length === 1 ? "" : "s"}`;
}

function showError(msg) {
  const el = document.getElementById("inv-banner");
  el.textContent = msg;
  el.hidden = false;
  el.className = "banner banner-error";
}

function showLoading(isLoading) {
  const el = document.getElementById("inv-banner");
  if (isLoading) {
    el.textContent = "Loading inventory…";
    el.hidden = false;
    el.className = "banner banner-info";
  } else if (el.className === "banner banner-info") {
    el.hidden = true;
  }
}

async function loadInventory() {
  showLoading(true);
  try {
    const res = await postToAppsScript(CONFIG.INVENTORY_SCRIPT_URL, { action: "getInventory" });
    items = (res.items || []).map(normalizeItem);
    populateFilterOptions();
    applyFiltersAndSort();
  } catch (err) {
    showError(`Couldn't load inventory: ${err.message}`);
  } finally {
    showLoading(false);
  }
}

function populateFilterOptions() {
  const ownerSel = document.getElementById("inv-filter-owner");
  const lineSel = document.getElementById("inv-filter-line");
  const owners = distinctValues(items, "owner");
  const lines = distinctValues(items, "line");

  ownerSel.innerHTML =
    `<option value="">All owners</option>` +
    `<option value="__CONSIGNMENT__">Consignment (not BL)</option>` +
    owners.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");
  ownerSel.value = filters.owner;

  lineSel.innerHTML = `<option value="">All lines</option>` + lines.map((l) => `<option value="${escapeHtml(l)}">${escapeHtml(l)}</option>`).join("");
  lineSel.value = filters.line;

  const nameList = document.getElementById("line-datalist");
  const licenseList = document.getElementById("license-datalist");
  nameList.innerHTML = lines.map((l) => `<option value="${escapeHtml(l)}">`).join("");
  licenseList.innerHTML = distinctValues(items, "license").map((l) => `<option value="${escapeHtml(l)}">`).join("");
}

function buildHeaderEl() {
  const header = document.getElementById("inv-header");
  header.innerHTML = "";
  header.style.gridTemplateColumns = COLUMNS.map((c) => c.width).join(" ") + " 2.2rem";
  for (const col of COLUMNS) {
    const cell = document.createElement("div");
    cell.className = "inv-th";
    cell.textContent = col.label;
    const sortIdx = sortState.findIndex((s) => s.key === col.key);
    if (sortIdx !== -1) {
      const arrow = sortState[sortIdx].dir === "asc" ? "▲" : "▼";
      cell.textContent += ` ${arrow}${sortIdx === 1 ? "₂" : ""}`;
      cell.classList.add("sorted");
    }
    cell.addEventListener("click", (e) => handleHeaderClick(col.key, e.shiftKey));
    header.appendChild(cell);
  }
  const actionsCell = document.createElement("div");
  actionsCell.className = "inv-th";
  header.appendChild(actionsCell);
}

function handleHeaderClick(key, shiftKey) {
  if (!shiftKey) {
    if (sortState[0] && sortState[0].key === key) {
      if (sortState[0].dir === "asc") {
        sortState[0].dir = "desc";
      } else {
        sortState = [];
      }
    } else {
      sortState = [{ key, dir: "asc" }];
    }
  } else {
    const idx = sortState.findIndex((s) => s.key === key);
    if (idx === 0) return; // already primary — shift-click on primary is a no-op
    if (idx === 1) {
      if (sortState[1].dir === "asc") {
        sortState[1].dir = "desc";
      } else {
        sortState.splice(1, 1);
      }
    } else {
      sortState[1] = { key, dir: "asc" };
    }
  }
  buildHeaderEl();
  applyFiltersAndSort();
}

function buildRowEl(item) {
  const row = document.createElement("div");
  row.className = "inv-row";
  row.style.gridTemplateColumns = COLUMNS.map((c) => c.width).join(" ") + " 2.2rem";

  for (const col of COLUMNS) {
    const cell = document.createElement("div");
    cell.className = "inv-td";
    if (col.type === "checkbox") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = Boolean(item[col.key]);
      input.addEventListener("change", () => handleFieldEdit(item, col.key, input.checked));
      cell.appendChild(input);
    } else {
      const input = document.createElement("input");
      input.type = col.type === "number" ? "number" : "text";
      input.value = item[col.key] ?? "";
      input.className = "inv-input";
      if (col.key === "line") input.setAttribute("list", "line-datalist");
      if (col.key === "license") input.setAttribute("list", "license-datalist");
      input.addEventListener("change", () => handleFieldEdit(item, col.key, input.value));
      cell.appendChild(input);
    }
    row.appendChild(cell);
  }

  const actionsCell = document.createElement("div");
  actionsCell.className = "inv-td inv-actions";
  const delBtn = document.createElement("button");
  delBtn.className = "icon-btn";
  delBtn.textContent = "✕";
  delBtn.title = "Delete";
  delBtn.addEventListener("click", () => handleDelete(item));
  actionsCell.appendChild(delBtn);
  row.appendChild(actionsCell);

  return row;
}

async function handleFieldEdit(item, key, value) {
  const previous = item[key];
  item[key] = value;
  if (key === "owner" || key === "line") populateFilterOptions();
  try {
    // Confirmed against the live Apps Script (2026-09-12): updateInventoryItems
    // reads each item as { id, fields: {...} } — changed fields must be nested
    // under `fields`, not sent flat. A flat payload still matches the row by
    // id (so the script reports success) but writes nothing, which is exactly
    // the silent-failure bug this fixes.
    await postToAppsScript(CONFIG.INVENTORY_SCRIPT_URL, {
      action: "updateInventoryItems",
      items: [{ id: item.id, fields: { [key]: value } }],
    });
  } catch (err) {
    item[key] = previous; // roll back optimistic edit
    showError(`Couldn't save "${key}": ${err.message}`);
    applyFiltersAndSort();
  }
}

async function handleDelete(item) {
  if (!confirm(`Delete "${item.name || "this item"}"? This can't be undone here.`)) return;
  const idx = items.indexOf(item);
  if (idx !== -1) items.splice(idx, 1);
  applyFiltersAndSort();
  try {
    await postToAppsScript(CONFIG.INVENTORY_SCRIPT_URL, { action: "deleteInventoryItems", ids: [item.id] });
  } catch (err) {
    if (idx !== -1) items.splice(idx, 0, item); // put it back
    showError(`Couldn't delete: ${err.message}`);
    applyFiltersAndSort();
  }
}

function renderVirtualRows() {
  const scrollEl = document.getElementById("inv-scroll");
  const spacerTop = document.getElementById("inv-spacer-top");
  const spacerBottom = document.getElementById("inv-spacer-bottom");
  const rowsEl = document.getElementById("inv-rows");

  const total = filteredSorted.length;
  const scrollTop = scrollEl.scrollTop;
  const viewportHeight = scrollEl.clientHeight || 400;

  const startIdx = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + OVERSCAN * 2;
  const endIdx = Math.min(total, startIdx + visibleCount);

  spacerTop.style.height = `${startIdx * rowHeight}px`;
  spacerBottom.style.height = `${Math.max(0, (total - endIdx) * rowHeight)}px`;

  rowsEl.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (let i = startIdx; i < endIdx; i++) frag.appendChild(buildRowEl(filteredSorted[i]));
  rowsEl.appendChild(frag);

  if (!rowHeightMeasured && rowsEl.firstElementChild) {
    const measured = rowsEl.firstElementChild.getBoundingClientRect().height;
    rowHeightMeasured = true;
    if (measured && Math.abs(measured - rowHeight) > 1) {
      rowHeight = measured;
      renderVirtualRows();
    }
  }
}

function buildAddRowEl() {
  const container = document.getElementById("inv-add-row");
  container.innerHTML = "";
  container.style.gridTemplateColumns = COLUMNS.map((c) => c.width).join(" ") + " 2.2rem";

  const handleEnter = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveAddRow();
    }
  };

  for (const col of COLUMNS) {
    const cell = document.createElement("div");
    cell.className = "inv-td";
    if (col.type === "checkbox") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = Boolean(addRowDraft[col.key]);
      input.addEventListener("change", () => {
        addRowDraft[col.key] = input.checked;
      });
      cell.appendChild(input);
    } else {
      const input = document.createElement("input");
      input.type = col.type === "number" ? "number" : "text";
      input.value = addRowDraft[col.key] ?? "";
      input.placeholder = col.label;
      input.className = "inv-input";
      if (col.key === "line") input.setAttribute("list", "line-datalist");
      if (col.key === "license") input.setAttribute("list", "license-datalist");
      // Nothing saves until Enter or the + button — just tracks the draft
      // as you type across as many fields as you want, in any order.
      input.addEventListener("input", () => {
        addRowDraft[col.key] = input.value;
      });
      input.addEventListener("keydown", handleEnter);
      cell.appendChild(input);
    }
    container.appendChild(cell);
  }

  const actionsCell = document.createElement("div");
  actionsCell.className = "inv-td inv-actions";
  const addBtn = document.createElement("button");
  addBtn.className = "icon-btn add-btn";
  addBtn.textContent = "+";
  addBtn.title = "Add item (or press Enter in any field)";
  addBtn.addEventListener("click", () => saveAddRow());
  actionsCell.appendChild(addBtn);
  container.appendChild(actionsCell);
}

async function saveAddRow() {
  if (addRowSaving) return;
  if (isEmpty(addRowDraft.name)) {
    showError("Enter a name before adding the item.");
    return;
  }
  addRowSaving = true;
  const draftCopy = { ...addRowDraft };
  try {
    // Confirmed against the live Apps Script (2026-09-12): addInventoryItems
    // responds with { ok, added, ids: [...] } — NOT an echoed `items` array.
    // Using the real id here matters a lot: any edit made right after adding
    // an item was previously keying off a made-up local id that didn't exist
    // in the Sheet, so it would silently fail exactly like the edit bug.
    const res = await postToAppsScript(CONFIG.INVENTORY_SCRIPT_URL, {
      action: "addInventoryItems",
      items: [draftCopy],
    });
    const realId = res.ids && res.ids[0] ? res.ids[0] : `temp-${Date.now()}`;
    const saved = normalizeItem({ ...draftCopy, id: realId });
    items.push(saved);
    // Only clear the row once the save actually succeeds — on failure the
    // typed data stays put so nothing is lost and you can just retry.
    addRowDraft = blankDraft();
    buildAddRowEl();
    populateFilterOptions();
    applyFiltersAndSort();
  } catch (err) {
    showError(`Couldn't save new item "${draftCopy.name}": ${err.message}`);
  } finally {
    addRowSaving = false;
  }
}

function bindToolbar() {
  document.getElementById("inv-search").addEventListener("input", (e) => {
    filters.search = e.target.value;
    applyFiltersAndSort();
  });
  document.getElementById("inv-filter-owner").addEventListener("change", (e) => {
    filters.owner = e.target.value;
    applyFiltersAndSort();
  });
  document.getElementById("inv-filter-line").addEventListener("change", (e) => {
    filters.line = e.target.value;
    applyFiltersAndSort();
  });
  document.getElementById("inv-filter-zero-qty").addEventListener("change", (e) => {
    filters.zeroQty = e.target.checked;
    applyFiltersAndSort();
  });
  document.getElementById("inv-filter-not-listed").addEventListener("change", (e) => {
    filters.notListed = e.target.checked;
    applyFiltersAndSort();
  });
  document.getElementById("inv-refresh").addEventListener("click", loadInventory);
  document.getElementById("inv-scroll").addEventListener("scroll", renderVirtualRows);
  window.addEventListener("resize", renderVirtualRows);
}

function initInventory() {
  buildHeaderEl();
  buildAddRowEl();
  populateFilterOptions(); // base options (All owners / Consignment) even before/if the load fails
  bindToolbar();
  loadInventory();
}
