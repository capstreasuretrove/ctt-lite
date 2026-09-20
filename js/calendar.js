// CTT Lite — Calendar module
//
// Read-only month-grid viewer over the Calendar Google Sheet's "Schedule"
// tab (link-shared, reached via a plain gviz fetch — no Apps Script and no
// write path, same technique already used for the Consignment summary
// tab). Brody asked for "a simple calendar viewer that shows all items" —
// unlike the public website (which only shows rows with Public? checked
// and hides Type=Personal entirely), this shows every row regardless of
// Public?/Type, since this is his own private password-gated tool.
//
// SHEET SCHEMA (confirmed live 2026-09-20, matches the project doc's
// "Revision round 6" notes for the public-site Schedule-tab rework):
//   A: Event Name   B: Public?   C: Type (Vending / Send-In / Personal)
//   D: Attending Starting Date   E: Attending Ending Date (optional)
//   F: Send-In Deadline Date (optional)   G: Vending Location
//   H: Additional Notes and/or Notable Guests   I: Website
//
// Each sheet row can put up to TWO things on the calendar:
//   1. An "attend" entry spanning Attending Starting Date..Ending Date
//      (or just the start day if no end) — shown on every day in range.
//   2. A "deadline" entry on Send-In Deadline Date alone, when present —
//      this is the actual actionable date (mail items in by then), so it
//      gets its own marker rather than being folded into the show date.
// A Send-In row typically produces both; Vending/Personal rows usually
// just the one "attend" entry (though Personal can have a deadline too,
// per the live data — e.g. a personal NYCC entry with its own deadline).

const CAL_TYPE_LABELS = { Vending: "Vending", "Send-In": "Send-In", Personal: "Personal" };
const CAL_WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

let calItems = []; // raw rows from the sheet, one per row with a name
let calEntries = []; // derived calendar-day entries (attend + deadline), see above
let calMonthCursor = null; // Date, always day 1 of the displayed month
let calSelectedEntryKey = null; // "<isoDate>|<rowIndex>|<kind>" of the clicked pill, if any

function calSlugType(type) {
  if (type === "Vending") return "vending";
  if (type === "Send-In") return "sendin";
  if (type === "Personal") return "personal";
  return "other";
}

/** yyyy-mm-dd string from local Y/M/D — never toISOString(), which is UTC
 * and can shift the date by a day depending on the browser's timezone. */
function calDateToIso(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Local midnight Date from a "yyyy-mm-dd" string — deliberately not
 * `new Date(iso)`, which parses as UTC and can land on the wrong local
 * day near midnight. */
function calIsoToDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** A gviz date cell's `.f` is already "yyyy-mm-dd" (the sheet's own date
 * format, confirmed live) — fall back to parsing the `Date(y,m,d)` literal
 * in `.v` (month is 0-indexed there) if `.f` is ever missing. */
function calDateCellToIso(cell) {
  if (!cell) return null;
  if (cell.f) return cell.f;
  if (typeof cell.v === "string") {
    const m = cell.v.match(/^Date\((\d+),(\d+),(\d+)\)/);
    if (m) {
      const y = m[1];
      const mo = String(Number(m[2]) + 1).padStart(2, "0");
      const d = String(Number(m[3])).padStart(2, "0");
      return `${y}-${mo}-${d}`;
    }
  }
  return null;
}

async function fetchCalendarRows() {
  const params = new URLSearchParams({ tqx: "out:json", gid: CONFIG.CALENDAR_TAB_GID });
  const url = `https://docs.google.com/spreadsheets/d/${CONFIG.CALENDAR_SHEET_ID}/gviz/tq?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Calendar sheet fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  const start = text.indexOf("(");
  const end = text.lastIndexOf(")");
  if (start === -1 || end === -1) throw new Error("Unexpected response reading the calendar sheet.");
  const json = JSON.parse(text.slice(start + 1, end));
  if (json.status === "error") {
    const msg = (json.errors && json.errors[0] && json.errors[0].detailed_message) || "Unknown sheet error";
    throw new Error(msg);
  }
  const rows = json.table.rows || [];
  const items = [];
  rows.forEach((r, idx) => {
    const c = r.c || [];
    const name = c[0] && c[0].v ? String(c[0].v).trim() : "";
    if (!name) return; // the sheet is padded with thousands of blank rows past the real data
    items.push({
      rowIndex: idx,
      name,
      isPublic: Boolean(c[1] && c[1].v === true),
      type: c[2] && c[2].v ? String(c[2].v).trim() : "",
      start: calDateCellToIso(c[3]),
      end: calDateCellToIso(c[4]),
      deadline: calDateCellToIso(c[5]),
      location: c[6] && c[6].v ? String(c[6].v).trim() : "",
      notes: c[7] && c[7].v ? String(c[7].v).trim() : "",
      website: c[8] && c[8].v ? String(c[8].v).trim() : "",
    });
  });
  return items;
}

function buildCalendarEntries(items) {
  const entries = [];
  for (const item of items) {
    if (item.start) {
      entries.push({ date: item.start, endDate: item.end || item.start, kind: "attend", item });
    }
    if (item.deadline) {
      entries.push({ date: item.deadline, endDate: item.deadline, kind: "deadline", item });
    }
  }
  return entries;
}

function calEntryKey(entry) {
  return `${entry.item.rowIndex}|${entry.kind}`;
}

function entriesForDate(iso) {
  return calEntries
    .filter((e) => e.date <= iso && iso <= e.endDate)
    .sort((a, b) => (a.kind === b.kind ? a.item.name.localeCompare(b.item.name) : a.kind === "deadline" ? 1 : -1));
}

// ---------- Rendering ----------

function calMonthLabel(date) {
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function calPillLabel(entry) {
  return entry.kind === "deadline" ? `📬 ${entry.item.name}` : entry.item.name;
}

function renderCalendarGrid() {
  const grid = document.getElementById("cal-grid");
  grid.innerHTML = "";

  const weekdayRow = document.createElement("div");
  weekdayRow.className = "cal-weekday-row";
  for (const label of CAL_WEEKDAY_LABELS) {
    const cell = document.createElement("div");
    cell.className = "cal-weekday";
    cell.textContent = label;
    weekdayRow.appendChild(cell);
  }
  grid.appendChild(weekdayRow);

  const year = calMonthCursor.getFullYear();
  const month = calMonthCursor.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startOffset = firstOfMonth.getDay(); // 0=Sun
  const totalCells = Math.ceil((daysInMonth + startOffset) / 7) * 7;
  const todayIso = calDateToIso(new Date());

  const weeksEl = document.createElement("div");
  weeksEl.className = "cal-weeks";

  for (let i = 0; i < totalCells; i++) {
    const cellDate = new Date(year, month, 1 - startOffset + i);
    const iso = calDateToIso(cellDate);
    const inMonth = cellDate.getMonth() === month;

    const cellEl = document.createElement("div");
    cellEl.className = "cal-cell" + (inMonth ? "" : " cal-cell-outside") + (iso === todayIso ? " cal-cell-today" : "");

    const dayNum = document.createElement("div");
    dayNum.className = "cal-daynum";
    dayNum.textContent = String(cellDate.getDate());
    cellEl.appendChild(dayNum);

    const dayEntries = entriesForDate(iso);
    for (const entry of dayEntries) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = `cal-pill cal-pill-${calSlugType(entry.item.type)}` + (entry.kind === "deadline" ? " cal-pill-deadline" : "");
      pill.textContent = calPillLabel(entry);
      pill.title = calPillLabel(entry);
      if (calEntryKey(entry) === calSelectedEntryKey) pill.classList.add("cal-pill-selected");
      pill.addEventListener("click", () => {
        calSelectedEntryKey = calEntryKey(entry);
        renderCalendarGrid();
        renderCalendarDetail(entry);
      });
      cellEl.appendChild(pill);
    }

    weeksEl.appendChild(cellEl);
  }

  grid.appendChild(weeksEl);
  document.getElementById("cal-month-label").textContent = calMonthLabel(calMonthCursor);
}

function calFormatDateRange(entry) {
  const opts = { weekday: "short", month: "short", day: "numeric", year: "numeric" };
  const startLabel = calIsoToDate(entry.date).toLocaleDateString(undefined, opts);
  if (entry.date === entry.endDate) return startLabel;
  const endLabel = calIsoToDate(entry.endDate).toLocaleDateString(undefined, opts);
  return `${startLabel} – ${endLabel}`;
}

function renderCalendarDetail(entry) {
  const panel = document.getElementById("cal-detail");
  if (!entry) {
    panel.innerHTML = '<p class="cal-detail-empty">Click an event on the calendar to see its details here.</p>';
    return;
  }
  const item = entry.item;
  const rows = [];
  rows.push(`<h3>${escapeHtml(item.name)}</h3>`);
  rows.push(`<span class="cal-detail-badge cal-pill-${calSlugType(item.type)}">${escapeHtml(CAL_TYPE_LABELS[item.type] || item.type || "—")}</span>`);
  if (entry.kind === "deadline") {
    rows.push(`<p><strong>📬 Send-In deadline:</strong> ${escapeHtml(calIsoToDate(item.deadline).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }))}</p>`);
    if (item.start) rows.push(`<p><strong>Show date:</strong> ${escapeHtml(calFormatDateRange({ date: item.start, endDate: item.end || item.start }))}</p>`);
  } else {
    rows.push(`<p><strong>Date:</strong> ${escapeHtml(calFormatDateRange(entry))}</p>`);
    if (item.deadline) rows.push(`<p><strong>📬 Send-in deadline:</strong> ${escapeHtml(calIsoToDate(item.deadline).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }))}</p>`);
  }
  if (item.location) rows.push(`<p><strong>Location:</strong> ${escapeHtml(item.location)}</p>`);
  if (item.notes) rows.push(`<p><strong>Notes:</strong> ${escapeHtml(item.notes)}</p>`);
  if (item.website) {
    const href = /^https?:\/\//i.test(item.website) ? item.website : `https://${item.website}`;
    rows.push(`<p><strong>Website:</strong> <a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(item.website)}</a></p>`);
  }
  if (!item.isPublic) rows.push('<p class="cal-detail-note">Not marked Public? on the sheet — hidden from the public site, still shown here.</p>');
  panel.innerHTML = rows.join("\n");
}

// ---------- Load / toolbar ----------

async function loadCalendar() {
  const banner = document.getElementById("cal-banner");
  banner.hidden = true;
  try {
    calItems = await fetchCalendarRows();
    calEntries = buildCalendarEntries(calItems);
    renderCalendarGrid();
    renderCalendarDetail(null);
  } catch (err) {
    banner.textContent = `Couldn't load the calendar: ${err.message}`;
    banner.hidden = false;
    banner.className = "banner banner-error";
  }
}

function bindCalendarToolbar() {
  document.getElementById("cal-prev-btn").addEventListener("click", () => {
    calMonthCursor.setMonth(calMonthCursor.getMonth() - 1);
    renderCalendarGrid();
  });
  document.getElementById("cal-next-btn").addEventListener("click", () => {
    calMonthCursor.setMonth(calMonthCursor.getMonth() + 1);
    renderCalendarGrid();
  });
  document.getElementById("cal-today-btn").addEventListener("click", () => {
    calMonthCursor = new Date();
    calMonthCursor.setDate(1);
    renderCalendarGrid();
  });
  document.getElementById("cal-refresh-btn").addEventListener("click", loadCalendar);
}

function initCalendar() {
  calMonthCursor = new Date();
  calMonthCursor.setDate(1);
  bindCalendarToolbar();
  renderCalendarDetail(null);
  loadCalendar();
}
