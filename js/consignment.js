// CTT Lite — Consignment module
//
// Two read paths, confirmed live against the real backend (2026-09-12):
//   - Summary tab (all conventions at a glance): read via the Sheets `gviz`
//     endpoint directly from the browser — no Apps Script involved, no auth
//     needed, since the sheet is link-shared. Columns confirmed by live probe
//     (positional, since gviz mangles the labels — see loadConventions()):
//       0 Date Attending, 1 Due Date, 2 Convention, 3 Tab Name,
//       4 Total Profit, 5 Total Consignments, 6 Total Cost, 7 Admission Cost
//   - Per-convention detail (the actual order rows): Apps Script
//     (CONFIG.CONSIGNMENT_SCRIPT_URL), read AND write, actions:
//       getConsignmentOrders / addConsignmentOrders /
//       updateConsignmentOrders / deleteConsignmentOrders  (all take
//       `{ tab, ... }` to target the right per-convention sheet tab)
//
// CONFIRMED LIVE (2026-09-12, disposable test row on the MM66-26 tab,
// cleaned up afterward — same technique used to find/fix the Inventory
// edit-persistence bug):
//   - getConsignmentOrders returns { ok, data: { items, columns,
//     summaryLines, totals, isStandardSchema } }. `columns` is the list of
//     { key, label } actually relevant to THIS tab — e.g. a standard tab
//     has consignment/autograph/addOns/auth, the SWAU tab has fee/price
//     instead. Render columns from this list, not a hardcoded schema.
//   - updateConsignmentOrders needs the SAME { id, fields: {...} } wrapper
//     as Inventory's updateInventoryItems — a flat { id, item: "x" } still
//     returns { ok: true } but silently writes nothing.
//   - addConsignmentOrders takes { tab, items: [ {flat fields, no id} ] }
//     and returns { ok, ids: [...] }.
//   - deleteConsignmentOrders takes { tab, ids: [...] }.
//   - IMPORTANT DIFFERENCE FROM INVENTORY: ids here are row-position based,
//     NOT stable UUIDs — adding or deleting a row renumbers every other
//     row's id (confirmed: inserting at the top gave the new row the
//     lowest id and shifted every existing id up by one). Edits alone
//     don't move rows, so an optimistic single-field edit is safe, but
//     add/delete must be followed by a full loadTab() reload rather than
//     a local splice/push, or the ids the UI holds for other rows go stale.
//   - CONFIRMED STILL BROKEN: writing a "shipped" field does nothing, no
//     matter the key casing or value type tried (shipped/Shipped, true,
//     "TRUE", "Yes" all returned { ok: true } with no actual change). This
//     matches the desktop app's own tooltip noting Shipped was never wired
//     up to write back. Per Brody (2026-09-12): skip it — the Shipped
//     column is left out of this UI entirely rather than shown disabled.
//   - createConvention needs a NESTED object under a `convention` key —
//     confirmed live 2026-09-12: `{ action: "createConvention", tabName }`
//     (and other flat/differently-keyed variants) all failed with "Cannot
//     read properties of undefined (reading 'tabName')"; the working shape
//     is `{ action: "createConvention", convention: { tabName, convention,
//     dateAttending, dueDate } }` → `{ ok: true, tabName }`. It creates a
//     brand-new sheet tab (always the standard 9-column schema) AND adds
//     the matching row to the summary tab in one call. A duplicate tab name
//     comes back as `{ ok: false, error: 'A tab named "X" already exists' }`
//     — friendly enough to surface directly. Verified live with two
//     disposable test conventions (ZZZ-TEST-26, ZZZ-TEST2-26) — Brody is
//     deleting those two tabs by hand from the Sheet since there's no
//     delete-convention action to clean them up through the API.

let conventions = [];
let currentTabName = "";
let currentColumns = []; // [{key,label}] — only the columns relevant to this tab
let currentIsStandard = true;
let currentSummaryLines = [];
let currentTotals = null;
let currentOrders = [];
let addOrderDraft = {};
let addOrderSaving = false;

const CONSIGNMENT_COLUMN_WIDTHS = {
  name: "1.3fr",
  guestName: "1.2fr",
  item: "1.2fr",
  color: "0.7fr",
  total: "0.7fr",
  consignment: "0.8fr",
  autograph: "0.8fr",
  addOns: "0.8fr",
  auth: "0.7fr",
  fee: "0.7fr",
  price: "0.7fr",
};

function isEmptyCon(v) {
  return v === undefined || v === null || String(v).trim() === "";
}

function showConsignmentError(msg) {
  const el = document.getElementById("con-banner");
  el.textContent = msg;
  el.hidden = false;
  el.className = "banner banner-error";
}

function showConsignmentLoading(isLoading, msg) {
  const el = document.getElementById("con-banner");
  if (isLoading) {
    el.textContent = msg || "Loading…";
    el.hidden = false;
    el.className = "banner banner-info";
  } else if (el.className === "banner banner-info") {
    el.hidden = true;
  }
}

/**
 * Fetch a Google Sheet's gviz JSON directly from the browser (no Apps
 * Script needed — the sheet is link-shared and gviz answers CORS reads).
 * Returns rows as plain arrays of cell values, preferring the formatted
 * display string (`.f`) over the raw value (`.v`) per the project's gviz
 * notes (dates and currency otherwise arrive as awkward raw forms).
 */
async function fetchGvizRows(sheetId, opts = {}) {
  const params = new URLSearchParams({ tqx: "out:json" });
  if (opts.sheetName) params.set("sheet", opts.sheetName);
  if (opts.headers) params.set("headers", String(opts.headers));
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheet fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  const start = text.indexOf("(");
  const end = text.lastIndexOf(")");
  if (start === -1 || end === -1) throw new Error("Unexpected response reading the sheet.");
  const json = JSON.parse(text.slice(start + 1, end));
  if (json.status === "error") {
    const msg = (json.errors && json.errors[0] && json.errors[0].detailed_message) || "Unknown sheet error";
    throw new Error(msg);
  }
  return (json.table.rows || []).map((r) =>
    (r.c || []).map((cell) => (cell ? (cell.f !== undefined && cell.f !== null ? cell.f : cell.v) : null))
  );
}

/** Parse the sheet's M/D/YYYY display string into a sortable timestamp.
 * Falls back to 0 (sorts last among newest-first) for anything unparseable
 * so a blank/odd date never throws off the rest of the list. */
function parseConventionDate(str) {
  if (!str) return 0;
  const t = new Date(str).getTime();
  return isNaN(t) ? 0 : t;
}

async function loadConventions() {
  showConsignmentLoading(true, "Loading conventions…");
  try {
    const rows = await fetchGvizRows(CONFIG.CONSIGNMENT_SUMMARY_SHEET_ID, { headers: 2 });
    // Positional — see the column-order note at the top of this file.
    conventions = rows
      .map((r) => ({
        dateAttending: r[0] || "",
        dueDate: r[1] || "",
        convention: r[2] || "",
        tabName: r[3] || "",
        totalProfit: r[4] || "",
        totalConsignments: r[5] || "",
        totalCost: r[6] || "",
        admissionCost: r[7] || "",
      }))
      .filter((c) => c.convention && c.tabName)
      // Newest to oldest by Date Attending, per Brody's request (2026-09-12).
      .sort((a, b) => parseConventionDate(b.dateAttending) - parseConventionDate(a.dateAttending));
    populateConventionPicker();
    showConsignmentLoading(false);
  } catch (err) {
    showConsignmentError(`Couldn't load the convention list: ${err.message}`);
  }
}

function populateConventionPicker() {
  const sel = document.getElementById("con-picker");
  const prev = sel.value;
  sel.innerHTML =
    `<option value="">Choose a convention…</option>` +
    conventions
      .map((c) => `<option value="${escapeHtml(c.tabName)}">${escapeHtml(c.convention)} — ${escapeHtml(c.dateAttending)}</option>`)
      .join("");
  if (prev && conventions.some((c) => c.tabName === prev)) sel.value = prev;
}

async function loadTab(tabName) {
  if (!tabName) {
    currentTabName = "";
    currentOrders = [];
    currentColumns = [];
    currentSummaryLines = [];
    currentTotals = null;
    renderConsignmentDetail();
    return;
  }
  showConsignmentLoading(true, "Loading orders…");
  try {
    const res = await postToAppsScript(CONFIG.CONSIGNMENT_SCRIPT_URL, { action: "getConsignmentOrders", tab: tabName });
    currentTabName = tabName;
    currentColumns = (res.data && res.data.columns) || [];
    currentIsStandard = res.data ? res.data.isStandardSchema !== false : true;
    currentSummaryLines = (res.data && res.data.summaryLines) || [];
    currentTotals = (res.data && res.data.totals) || null;
    currentOrders = (res.data && res.data.items) || [];
    addOrderDraft = blankOrderDraft();
    renderConsignmentDetail();
    showConsignmentLoading(false);
  } catch (err) {
    showConsignmentError(`Couldn't load "${tabName}": ${err.message}`);
  }
}

function blankOrderDraft() {
  const d = {};
  for (const col of currentColumns) d[col.key] = "";
  return d;
}

function renderConsignmentSummary() {
  const el = document.getElementById("con-summary");
  if (!currentTabName) {
    el.innerHTML = "";
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const conv = conventions.find((c) => c.tabName === currentTabName);
  const title = conv ? `${escapeHtml(conv.convention)} (${escapeHtml(conv.dateAttending)})` : escapeHtml(currentTabName);
  const lines = currentSummaryLines
    .map((l) => `<span class="con-summary-item"><strong>${escapeHtml(l.label)}:</strong> $${escapeHtml(l.value)}</span>`)
    .join("");
  const schemaNote = currentIsStandard
    ? ""
    : `<span class="con-summary-note">Non-standard column layout for this tab — showing exactly what's in the sheet.</span>`;
  el.innerHTML = `<div class="con-summary-title">${title}</div><div class="con-summary-lines">${lines}</div>${schemaNote}`;
}

function gridTemplate() {
  return currentColumns.map((c) => CONSIGNMENT_COLUMN_WIDTHS[c.key] || "1fr").join(" ") + " 2.2rem";
}

function buildConsignmentHeaderEl() {
  const header = document.getElementById("con-header");
  header.innerHTML = "";
  if (!currentTabName) return;
  header.style.gridTemplateColumns = gridTemplate();
  for (const col of currentColumns) {
    const cell = document.createElement("div");
    cell.className = "inv-th con-th-static";
    cell.textContent = col.label;
    header.appendChild(cell);
  }
  header.appendChild(document.createElement("div")).className = "inv-th";
}

function buildOrderRowEl(item) {
  const row = document.createElement("div");
  row.className = "inv-row";
  row.style.gridTemplateColumns = gridTemplate();

  for (const col of currentColumns) {
    const cell = document.createElement("div");
    cell.className = "inv-td";
    const input = document.createElement("input");
    input.type = "text";
    input.value = item[col.key] ?? "";
    input.className = "inv-input";
    input.addEventListener("change", () => handleOrderFieldEdit(item, col.key, input.value));
    cell.appendChild(input);
    row.appendChild(cell);
  }

  const actionsCell = document.createElement("div");
  actionsCell.className = "inv-td inv-actions";
  const delBtn = document.createElement("button");
  delBtn.className = "icon-btn";
  delBtn.textContent = "✕";
  delBtn.title = "Delete";
  delBtn.addEventListener("click", () => handleDeleteOrder(item));
  actionsCell.appendChild(delBtn);
  row.appendChild(actionsCell);

  return row;
}

async function handleOrderFieldEdit(item, key, value) {
  const previous = item[key];
  item[key] = value;
  try {
    // Same { id, fields: {...} } wrapper confirmed for updateInventoryItems —
    // confirmed here too, live, on 2026-09-12 (see file header notes).
    await postToAppsScript(CONFIG.CONSIGNMENT_SCRIPT_URL, {
      action: "updateConsignmentOrders",
      tab: currentTabName,
      items: [{ id: item.id, fields: { [key]: value } }],
    });
  } catch (err) {
    item[key] = previous;
    showConsignmentError(`Couldn't save "${key}": ${err.message}`);
    renderOrderRows();
  }
}

async function handleDeleteOrder(item) {
  if (!confirm(`Delete this order (${item.name || "unnamed"} — ${item.item || "item"})? This can't be undone here.`)) return;
  try {
    await postToAppsScript(CONFIG.CONSIGNMENT_SCRIPT_URL, {
      action: "deleteConsignmentOrders",
      tab: currentTabName,
      ids: [item.id],
    });
    // Ids are row-position based here (unlike Inventory's stable UUIDs) —
    // deleting one shifts every other row's id, so reload the whole tab
    // rather than just splicing the local list.
    await loadTab(currentTabName);
  } catch (err) {
    showConsignmentError(`Couldn't delete: ${err.message}`);
  }
}

function buildAddOrderRowEl() {
  const container = document.getElementById("con-add-row");
  container.innerHTML = "";
  if (!currentTabName) return;
  container.style.gridTemplateColumns = gridTemplate();

  const handleEnter = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveAddOrder();
    }
  };

  for (const col of currentColumns) {
    const cell = document.createElement("div");
    cell.className = "inv-td";
    const input = document.createElement("input");
    input.type = "text";
    input.value = addOrderDraft[col.key] ?? "";
    input.placeholder = col.label;
    input.className = "inv-input";
    input.addEventListener("input", () => {
      addOrderDraft[col.key] = input.value;
    });
    input.addEventListener("keydown", handleEnter);
    cell.appendChild(input);
    container.appendChild(cell);
  }

  const actionsCell = document.createElement("div");
  actionsCell.className = "inv-td inv-actions";
  const addBtn = document.createElement("button");
  addBtn.className = "icon-btn add-btn";
  addBtn.textContent = "+";
  addBtn.title = "Add order (or press Enter in any field)";
  addBtn.addEventListener("click", () => saveAddOrder());
  actionsCell.appendChild(addBtn);
  container.appendChild(actionsCell);
}

async function saveAddOrder() {
  if (addOrderSaving || !currentTabName) return;
  const hasAnyValue = Object.values(addOrderDraft).some((v) => !isEmptyCon(v));
  if (!hasAnyValue) {
    showConsignmentError("Enter at least one field before adding the order.");
    return;
  }
  addOrderSaving = true;
  const draftCopy = { ...addOrderDraft };
  try {
    await postToAppsScript(CONFIG.CONSIGNMENT_SCRIPT_URL, {
      action: "addConsignmentOrders",
      tab: currentTabName,
      items: [draftCopy],
    });
    // Ids shift on insert (see file header notes) — reload the whole tab
    // rather than guessing where the new row landed.
    addOrderDraft = blankOrderDraft();
    await loadTab(currentTabName);
  } catch (err) {
    showConsignmentError(`Couldn't add the order: ${err.message}`);
  } finally {
    addOrderSaving = false;
  }
}

function renderOrderRows() {
  const rowsEl = document.getElementById("con-rows");
  rowsEl.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const item of currentOrders) frag.appendChild(buildOrderRowEl(item));
  rowsEl.appendChild(frag);
  const countEl = document.getElementById("con-count");
  countEl.textContent = currentTabName ? `${currentOrders.length} order${currentOrders.length === 1 ? "" : "s"}` : "";
}

function renderConsignmentDetail() {
  renderConsignmentSummary();
  buildConsignmentHeaderEl();
  buildAddOrderRowEl();
  renderOrderRows();
  document.getElementById("con-grid").hidden = !currentTabName;
}

function bindConsignmentToolbar() {
  document.getElementById("con-picker").addEventListener("change", (e) => loadTab(e.target.value));
  document.getElementById("con-refresh").addEventListener("click", async () => {
    await loadConventions();
    if (currentTabName) await loadTab(currentTabName);
  });
}

// ---------- New Convention ----------
//
// Tab-name suggestion algorithm per the port guide: initials of the
// convention name (skipping small connector words), capped at 6 chars,
// plus the last 2 digits of the year in Date Attending if present.
// Editable — the suggestion stops updating the moment the user types into
// the Tab Name field themselves.

let newTabNameManuallyEdited = false;

/** "YYYY-MM-DD" (native <input type=date> value) -> "M/D/YYYY" (no leading
 * zeros), matching the format already used throughout the sheet. */
function formatDateForSheet(isoDate) {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return "";
  return `${m}/${d}/${y}`;
}

function suggestTabName(conventionName, isoDateAttending) {
  const skipWords = new Set(["of", "the", "and", "in", "at", "for", "&"]);
  const words = (conventionName || "").trim().split(/\s+/).filter(Boolean);
  let initials = "";
  for (const w of words) {
    const clean = w.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!clean || skipWords.has(clean)) continue;
    initials += clean[0].toUpperCase();
  }
  initials = initials.slice(0, 6);
  const year = isoDateAttending ? isoDateAttending.slice(0, 4) : "";
  const yearSuffix = /^\d{4}$/.test(year) ? year.slice(-2) : "";
  return yearSuffix ? `${initials}-${yearSuffix}` : initials;
}

function updateTabNameSuggestion() {
  if (newTabNameManuallyEdited) return;
  const name = document.getElementById("con-new-name").value;
  const dateAttending = document.getElementById("con-new-date-attending").value;
  // Programmatic assignment (not user typing), so this doesn't itself
  // trigger the tab-name input's own "manually edited" listener.
  document.getElementById("con-new-tabname").value = suggestTabName(name, dateAttending);
}

function resetNewConventionForm() {
  document.getElementById("con-new-name").value = "";
  document.getElementById("con-new-date-attending").value = "";
  document.getElementById("con-new-due-date").value = "";
  document.getElementById("con-new-tabname").value = "";
  newTabNameManuallyEdited = false;
}

async function saveNewConvention() {
  const name = document.getElementById("con-new-name").value.trim();
  const tabName = document.getElementById("con-new-tabname").value.trim();
  const dateAttendingIso = document.getElementById("con-new-date-attending").value;
  const dueDateIso = document.getElementById("con-new-due-date").value;
  if (!name || !tabName) {
    showConsignmentError("Enter a convention name and a tab name before creating.");
    return;
  }
  try {
    // Confirmed live 2026-09-12 — see the createConvention notes at the top
    // of this file: the payload must be nested under a `convention` key.
    await postToAppsScript(CONFIG.CONSIGNMENT_SCRIPT_URL, {
      action: "createConvention",
      convention: {
        tabName,
        convention: name,
        dateAttending: formatDateForSheet(dateAttendingIso),
        dueDate: formatDateForSheet(dueDateIso),
      },
    });
    document.getElementById("con-new-form").hidden = true;
    resetNewConventionForm();
    await loadConventions();
    document.getElementById("con-picker").value = tabName;
    await loadTab(tabName);
  } catch (err) {
    // Duplicate-tab-name errors from the backend read fine as-is, e.g.
    // `A tab named "X" already exists` — no need to reword them.
    showConsignmentError(`Couldn't create the convention: ${err.message}`);
  }
}

function bindNewConventionForm() {
  const nameInput = document.getElementById("con-new-name");
  const dateInput = document.getElementById("con-new-date-attending");
  const tabNameInput = document.getElementById("con-new-tabname");

  nameInput.addEventListener("input", updateTabNameSuggestion);
  dateInput.addEventListener("input", updateTabNameSuggestion);
  tabNameInput.addEventListener("input", () => {
    newTabNameManuallyEdited = true;
  });

  document.getElementById("con-new-btn").addEventListener("click", () => {
    document.getElementById("con-new-form").hidden = false;
    nameInput.focus();
  });
  document.getElementById("con-new-cancel").addEventListener("click", () => {
    document.getElementById("con-new-form").hidden = true;
    resetNewConventionForm();
  });
  document.getElementById("con-new-save").addEventListener("click", saveNewConvention);
}

function initConsignment() {
  bindConsignmentToolbar();
  bindNewConventionForm();
  loadConventions();
}
