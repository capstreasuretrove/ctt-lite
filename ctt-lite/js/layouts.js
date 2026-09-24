// CTT Lite — Booth Layouts module
//
// Plan/decisions live in the project doc `ctt-booth-layout-manager-plan.md`.
// Backend: its own Apps Script Web App (CONFIG.LAYOUTS_SCRIPT_URL) over the
// "CTT - Booth Layouts" sheet. Actions (all confirmed live 2026-09-19):
//   getTemplates, getLayouts, getLayout {layoutId}, saveLayout {layout, regions},
//   deleteLayout {layoutId}.
//
// Important backend behaviors this module relies on:
//   - saveLayout REPLACES the layout row and ALL of its regions in one call.
//     Never call it with a partial region list — toggling a star from the list
//     therefore loads the layout first and saves it back unchanged.
//   - The script rejects overlapping blocks, blocks crossing a shelf divider,
//     and cells outside a section's shape. This module never produces those:
//     it edits a per-cell grid and derives non-overlapping, shelf-respecting
//     rectangles from it only when saving.
//
// Model: each section is a grid of cells; a cell is either empty or holds a
// label. "Merged" blocks are just runs of identically-labeled cells drawn
// without inner lines, so painting over part of a block splits it for free.
//
// Everything is wrapped in an IIFE; only initBoothLayouts is exposed.

(function () {
  "use strict";

  const PALETTE = [
    "#f4b6b0", "#f9d29a", "#fbe8a0", "#c9e6b2", "#b3e2d6", "#b7d6f4",
    "#cdc4ee", "#efc0e2", "#d8c7b0", "#c8ced8", "#f5a97f", "#a6d8e6",
  ];
  const MAX_HISTORY = 40;

  let templates = [];
  let layoutList = [];
  let listFilters = { search: "", starredOnly: false };
  let ed = null; // editor state; null while the list is showing
  let drag = null; // in-progress drag selection
  let selUI = { color: null, colorTouched: false };
  const knownLabels = new Set(); // suggestion pool: labels seen in opened layouts
  const GRID_PREF_KEY = "ctt_bl_show_grid";
  let showGrid = (() => {
    try {
      const v = localStorage.getItem(GRID_PREF_KEY);
      return v === null ? true : v === "1";
    } catch (e) { return true; }
  })();

  const $ = (id) => document.getElementById(id);
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  // ---------- small helpers ----------

  function api(body) {
    return postToAppsScript(CONFIG.LAYOUTS_SCRIPT_URL, body);
  }

  function showBanner(msg, kind) {
    const el = $("bl-banner");
    el.textContent = msg;
    el.className = "banner " + (kind === "info" ? "banner-info" : "banner-error");
    el.hidden = false;
  }
  function clearBanner() {
    $("bl-banner").hidden = true;
  }

  function todayIso() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function labelKey(label) {
    return String(label || "").trim().toLowerCase();
  }

  function textColorFor(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return "#232442";
    const n = parseInt(m[1], 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) < 130 ? "#ffffff" : "#232442";
  }

  function secWidth(sec, r) {
    return sec.rowWidths ? sec.rowWidths[r - 1] : sec.cols;
  }
  function shelfOf(sec, r) {
    return sec.rowsPerShelf ? Math.floor((r - 1) / sec.rowsPerShelf) : 0;
  }
  function cellExists(sec, r, c) {
    return r >= 1 && r <= sec.rows && c >= 1 && c <= secWidth(sec, r);
  }
  function secById(id) {
    return ed.template.sections.find((s) => s.sectionId === id);
  }
  function templateById(id) {
    return templates.find((t) => t.templateId === id);
  }
  function fmtDate(iso) {
    if (!iso) return "No date";
    const [y, m, d] = iso.split("-").map(Number);
    if (!y) return iso;
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  // ---------- grid model ----------

  function emptyGrid(template) {
    const grid = {};
    for (const sec of template.sections) {
      grid[sec.sectionId] = Array.from({ length: sec.rows }, (_, i) => Array(secWidth(sec, i + 1)).fill(null));
    }
    return grid;
  }

  function nextColor() {
    const used = new Set(Object.values(ed.labelInfo).map((v) => v.color.toLowerCase()));
    const free = PALETTE.find((c) => !used.has(c));
    return free || PALETTE[Object.keys(ed.labelInfo).length % PALETTE.length];
  }

  function gridFromRegions(template, regions) {
    const grid = emptyGrid(template);
    const info = {};
    for (const g of regions) {
      const sec = template.sections.find((s) => s.sectionId === g.sectionId);
      if (!sec) continue;
      const key = labelKey(g.label);
      if (!key) continue;
      if (!info[key]) info[key] = { label: g.label, color: g.color || PALETTE[0] };
      for (let r = g.r1; r <= g.r2; r++) {
        for (let c = g.c1; c <= g.c2; c++) {
          if (cellExists(sec, r, c)) grid[sec.sectionId][r - 1][c - 1] = key;
        }
      }
    }
    return { grid, info };
  }

  // Non-overlapping rectangles for one section, never crossing a shelf divider.
  function rectsForSection(sec) {
    const grid = ed.grid[sec.sectionId];
    const out = [];
    let prev = new Map();
    for (let r = 1; r <= sec.rows; r++) {
      const row = grid[r - 1];
      const cur = new Map();
      let c = 1;
      while (c <= row.length) {
        const key = row[c - 1];
        if (!key) { c++; continue; }
        let e = c;
        while (e < row.length && row[e] === key) e++;
        const mk = `${key}|${c}|${e}`;
        const above = prev.get(mk);
        if (above && shelfOf(sec, r - 1) === shelfOf(sec, r)) {
          above.r2 = r;
          cur.set(mk, above);
        } else {
          const rect = { sectionId: sec.sectionId, r1: r, c1: c, r2: r, c2: e, key };
          out.push(rect);
          cur.set(mk, rect);
        }
        c = e + 1;
      }
      prev = cur;
    }
    return out;
  }

  function gridToRegions() {
    const regions = [];
    for (const sec of ed.template.sections) {
      for (const rc of rectsForSection(sec)) {
        const info = ed.labelInfo[rc.key];
        regions.push({
          sectionId: rc.sectionId, r1: rc.r1, c1: rc.c1, r2: rc.r2, c2: rc.c2,
          label: info.label, color: info.color,
        });
      }
    }
    return regions;
  }

  function componentCells(sec, r, c) {
    const grid = ed.grid[sec.sectionId];
    const key = grid[r - 1][c - 1];
    if (!key) return [];
    const seen = new Set([`${r},${c}`]);
    const stack = [[r, c]];
    const cells = [];
    while (stack.length) {
      const [cr, cc] = stack.pop();
      cells.push([cr, cc]);
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nr = cr + dr, nc = cc + dc;
        if (!cellExists(sec, nr, nc)) continue;
        const k = `${nr},${nc}`;
        if (seen.has(k) || grid[nr - 1][nc - 1] !== key) continue;
        seen.add(k);
        stack.push([nr, nc]);
      }
    }
    return cells;
  }

  function rectCells(sec, r1, c1, r2, c2) {
    const cells = [];
    for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
      for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) {
        if (cellExists(sec, r, c)) cells.push([r, c]);
      }
    }
    return cells;
  }

  function pruneLabels() {
    const used = new Set();
    for (const rows of Object.values(ed.grid)) for (const row of rows) for (const k of row) if (k) used.add(k);
    for (const k of Object.keys(ed.labelInfo)) if (!used.has(k)) delete ed.labelInfo[k];
  }

  function snapshot() {
    return JSON.stringify({ grid: ed.grid, labelInfo: ed.labelInfo });
  }
  function pushHistory() {
    ed.history.push(snapshot());
    if (ed.history.length > MAX_HISTORY) ed.history.shift();
  }
  function undo() {
    if (!ed || !ed.history.length) return;
    const s = JSON.parse(ed.history.pop());
    ed.grid = s.grid;
    ed.labelInfo = s.labelInfo;
    ed.sel = null;
    markDirty();
    paintAll();
  }

  function markDirty() {
    ed.dirty = true;
    updateHeaderState();
  }

  // ---------- list view ----------

  async function loadAll() {
    clearBanner();
    if (!CONFIG.LAYOUTS_SCRIPT_URL || CONFIG.LAYOUTS_SCRIPT_URL.startsWith("PASTE_")) {
      showBanner("The Booth Layouts script URL isn't set yet — add LAYOUTS_SCRIPT_URL in js/config.js.");
      return;
    }
    try {
      const [t, l] = await Promise.all([api({ action: "getTemplates" }), api({ action: "getLayouts" })]);
      templates = t.templates || [];
      layoutList = l.layouts || [];
      renderList();
      fillNewFormOptions();
    } catch (err) {
      showBanner(`Couldn't load Booth Layouts: ${err.message}`);
    }
  }

  function renderList() {
    const q = listFilters.search.trim().toLowerCase();
    const rows = layoutList.filter((l) =>
      (!listFilters.starredOnly || l.starred) &&
      (!q || l.showName.toLowerCase().includes(q) || (l.notes || "").toLowerCase().includes(q)));
    $("bl-count").textContent = `${rows.length} layout${rows.length === 1 ? "" : "s"}`;
    const host = $("bl-list");
    if (!rows.length) {
      host.innerHTML = `<div class="bl-empty">${layoutList.length
        ? "No layouts match."
        : "No layouts yet — click <b>+ New Layout</b> to plan your first booth."}</div>`;
      return;
    }
    const today = todayIso();
    host.innerHTML = rows.map((l) => {
      const tpl = templateById(l.templateId);
      const upcoming = l.date && l.date >= today;
      return `<div class="bl-row" data-id="${escapeHtml(l.layoutId)}">
        <button class="bl-star ${l.starred ? "on" : ""}" data-act="star" title="Favorite">${l.starred ? "★" : "☆"}</button>
        <div class="bl-row-main" data-act="open">
          <div class="bl-row-title">${escapeHtml(l.showName)}${upcoming ? ' <span class="bl-badge">Upcoming</span>' : ""}</div>
          <div class="bl-row-sub">${escapeHtml(fmtDate(l.date))} · ${escapeHtml(tpl ? tpl.templateName : l.templateId)}${l.notes ? " · " + escapeHtml(l.notes) : ""}</div>
        </div>
        <div class="bl-row-actions">
          <button class="secondary-btn" data-act="open">Open</button>
          <button class="secondary-btn" data-act="copy" title="Start a new layout from this one">Start new from this</button>
          <button class="icon-btn" data-act="delete" title="Delete">✕</button>
        </div>
      </div>`;
    }).join("");
  }

  function fillNewFormOptions() {
    const tsel = $("bl-new-template");
    const keepT = tsel.value;
    tsel.innerHTML = templates.map((t) => `<option value="${escapeHtml(t.templateId)}">${escapeHtml(t.templateName)}</option>`).join("");
    if (keepT && templateById(keepT)) tsel.value = keepT;
    const fsel = $("bl-new-from");
    const keepF = fsel.value;
    fsel.innerHTML = `<option value="">Blank layout</option>` + layoutList.map((l) =>
      `<option value="${escapeHtml(l.layoutId)}">${escapeHtml(l.showName)} — ${escapeHtml(fmtDate(l.date))}</option>`).join("");
    if (keepF && layoutList.some((l) => l.layoutId === keepF)) fsel.value = keepF;
    syncNewFormTemplateLock();
  }

  function syncNewFormTemplateLock() {
    const from = $("bl-new-from").value;
    const tsel = $("bl-new-template");
    if (from) {
      const src = layoutList.find((l) => l.layoutId === from);
      if (src && templateById(src.templateId)) tsel.value = src.templateId;
      tsel.disabled = true;
    } else {
      tsel.disabled = false;
    }
  }

  function openNewForm(fromId) {
    $("bl-new-form").hidden = false;
    $("bl-new-name").value = "";
    $("bl-new-date").value = "";
    $("bl-new-from").value = fromId || "";
    syncNewFormTemplateLock();
    $("bl-new-name").focus();
  }

  async function submitNewForm() {
    const name = $("bl-new-name").value.trim();
    if (!name) { showBanner("Give the layout a show name first."); return; }
    clearBanner();
    const date = $("bl-new-date").value;
    const from = $("bl-new-from").value;
    const btn = $("bl-new-create");
    btn.disabled = true;
    try {
      let template = templateById($("bl-new-template").value);
      let regions = [];
      if (from) {
        const res = await api({ action: "getLayout", layoutId: from });
        template = templateById(res.layout.templateId);
        regions = res.regions;
      }
      if (!template) throw new Error("That template isn't available.");
      $("bl-new-form").hidden = true;
      openEditor({
        layout: { layoutId: null, showName: name, date, notes: "", starred: false, templateId: template.templateId },
        template, regions, isNew: true,
      });
    } catch (err) {
      showBanner(`Couldn't start the new layout: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  }

  async function openExisting(id) {
    clearBanner();
    try {
      const res = await api({ action: "getLayout", layoutId: id });
      const template = templateById(res.layout.templateId);
      if (!template) throw new Error(`Template "${res.layout.templateId}" isn't available.`);
      openEditor({ layout: res.layout, template, regions: res.regions, isNew: false });
    } catch (err) {
      showBanner(`Couldn't open that layout: ${err.message}`);
    }
  }

  async function toggleStarFromList(id) {
    const l = layoutList.find((x) => x.layoutId === id);
    if (!l) return;
    clearBanner();
    try {
      // saveLayout replaces all regions, so load them and send them back unchanged.
      const cur = await api({ action: "getLayout", layoutId: id });
      const res = await api({
        action: "saveLayout",
        layout: { ...cur.layout, starred: !cur.layout.starred },
        regions: cur.regions,
      });
      l.starred = !cur.layout.starred;
      l.updatedAt = res.updatedAt;
      renderList();
    } catch (err) {
      showBanner(`Couldn't update the favorite: ${err.message}`);
    }
  }

  async function deleteFromList(id) {
    const l = layoutList.find((x) => x.layoutId === id);
    if (!l) return;
    if (!confirm(`Delete the layout "${l.showName}"? This can't be undone here.`)) return;
    clearBanner();
    try {
      await api({ action: "deleteLayout", layoutId: id });
      layoutList = layoutList.filter((x) => x.layoutId !== id);
      renderList();
      fillNewFormOptions();
    } catch (err) {
      showBanner(`Couldn't delete: ${err.message}`);
    }
  }

  // ---------- editor ----------

  function openEditor({ layout, template, regions, isNew }) {
    const { grid, info } = gridFromRegions(template, regions);
    Object.values(info).forEach((v) => knownLabels.add(v.label));
    ed = {
      layoutId: layout.layoutId || null,
      showName: layout.showName || "",
      date: layout.date || "",
      notes: layout.notes || "",
      starred: !!layout.starred,
      templateId: template.templateId,
      template: {
        ...template,
        sections: template.sections.slice().sort((a, b) => a.order - b.order),
      },
      grid,
      labelInfo: info,
      mode: isNew ? "edit" : "view",
      dirty: isNew, // a brand-new layout isn't saved yet
      sel: null,
      history: [],
      saving: false,
      cw: 30,
      ch: 40,
    };
    drag = null;
    selUI = { color: null, colorTouched: false };
    $("bl-list-view").hidden = true;
    $("bl-editor").hidden = false;
    buildEditorShell();
    paintAll();
  }

  function buildEditorShell() {
    const tplName = ed.template.templateName;
    $("bl-editor").innerHTML = `
      <div class="bl-editor-head">
        <button class="secondary-btn" id="bl-back">← Layouts</button>
        <input id="bl-name" class="toolbar-input bl-name-input" placeholder="Show name" />
        <input id="bl-date" type="date" class="toolbar-input" />
        <button id="bl-star" class="secondary-btn" title="Favorite">☆</button>
        <span class="bl-template-name">${escapeHtml(tplName)}</span>
        <span class="bl-status" id="bl-status"></span>
        <button class="secondary-btn" id="bl-undo">↶ Undo</button>
        <button class="secondary-btn" id="bl-grid-toggle" title="Show cell grid lines on the shelves">⊞ Grid</button>
        <button class="secondary-btn" id="bl-mode"></button>
        <button class="primary-btn" id="bl-save">Save</button>
      </div>
      <input id="bl-notes" class="toolbar-input bl-notes-input" placeholder="Notes (optional) — e.g. what worked, what to change next time" />
      <div id="bl-selbar" class="bl-selbar"></div>
      <div class="bl-diagram-scroll" id="bl-diagram-scroll"><div id="bl-diagram"></div></div>
      <div id="bl-legend" class="bl-legend"></div>`;
    $("bl-name").value = ed.showName;
    $("bl-date").value = ed.date;
    $("bl-notes").value = ed.notes;
    $("bl-back").addEventListener("click", backToList);
    $("bl-name").addEventListener("input", (e) => { ed.showName = e.target.value; markDirty(); });
    $("bl-date").addEventListener("input", (e) => { ed.date = e.target.value; markDirty(); });
    $("bl-notes").addEventListener("input", (e) => { ed.notes = e.target.value; markDirty(); });
    $("bl-star").addEventListener("click", () => { ed.starred = !ed.starred; markDirty(); });
    $("bl-undo").addEventListener("click", undo);
    $("bl-grid-toggle").addEventListener("click", () => {
      showGrid = !showGrid;
      try { localStorage.setItem(GRID_PREF_KEY, showGrid ? "1" : "0"); } catch (e) { /* ignore */ }
      updateHeaderState();
      $("bl-diagram").classList.toggle("show-grid", showGrid);
    });
    $("bl-mode").addEventListener("click", () => {
      ed.mode = ed.mode === "edit" ? "view" : "edit";
      ed.sel = null;
      drag = null;
      paintAll();
    });
    $("bl-save").addEventListener("click", save);
  }

  function updateHeaderState() {
    if (!ed) return;
    $("bl-star").textContent = ed.starred ? "★" : "☆";
    $("bl-star").classList.toggle("on", ed.starred);
    $("bl-undo").disabled = !ed.history.length || ed.mode !== "edit";
    $("bl-undo").hidden = ed.mode !== "edit";
    $("bl-grid-toggle").classList.toggle("on", showGrid);
    $("bl-mode").textContent = ed.mode === "edit" ? "🔒 Lock (view)" : "✏ Edit layout";
    const st = $("bl-status");
    if (ed.saving) st.textContent = "Saving…";
    else if (ed.dirty) st.textContent = "Unsaved changes";
    else if (ed.savedAt) st.textContent = `Saved ✓ ${ed.savedAt}`;
    else st.textContent = "";
    st.classList.toggle("dirty", ed.dirty && !ed.saving);
    $("bl-save").disabled = ed.saving || (!ed.dirty && !!ed.layoutId);
  }

  function paintAll() {
    if (!ed) return;
    pruneLabels();
    renderDiagram();
    renderSelBar();
    renderLegend();
    refreshSuggestions();
    updateHeaderState();
  }

  function refreshSuggestions() {
    const pool = new Set(knownLabels);
    Object.values(ed.labelInfo).forEach((v) => pool.add(v.label));
    try {
      if (typeof items !== "undefined" && Array.isArray(items)) {
        items.forEach((it) => {
          if (it.line) pool.add(String(it.line).trim());
          if (it.license) pool.add(String(it.license).trim());
        });
      }
    } catch (e) { /* inventory not loaded — fine */ }
    const sorted = Array.from(pool).filter(Boolean).sort((a, b) => a.localeCompare(b));
    $("bl-suggest").innerHTML = sorted.map((s) => `<option value="${escapeHtml(s)}"></option>`).join("");
  }

  // ----- diagram rendering -----

  function computeCellSize() {
    const groups = {};
    for (const s of ed.template.sections) (groups[s.group] = groups[s.group] || []).push(s);
    let maxUnits = 1;
    for (const g of Object.values(groups)) {
      const units = g.reduce((a, s) => a + s.cols, 0) + (g.length - 1);
      maxUnits = Math.max(maxUnits, units);
    }
    const avail = Math.max(280, $("bl-diagram-scroll").clientWidth - 16);
    const cw = clamp(Math.floor(avail / maxUnits), 22, 44);
    ed.cw = cw;
    ed.ch = Math.round(cw * 1.35);
    return groups;
  }

  function renderDiagram() {
    const host = $("bl-diagram");
    host.innerHTML = "";
    host.className = "bl-diagram " + (ed.mode === "edit" ? "editing" : "viewing") + (showGrid ? " show-grid" : "");
    const groups = computeCellSize();
    ed.els = {};
    Object.keys(groups).sort((a, b) => a - b).forEach((gk) => {
      const gEl = document.createElement("div");
      gEl.className = "bl-group";
      gEl.style.gap = `${ed.cw}px`;
      for (const sec of groups[gk]) gEl.appendChild(buildSection(sec));
      host.appendChild(gEl);
    });
    paintBlocks();
    paintSelection();
  }

  function buildSection(sec) {
    const { cw, ch } = ed;
    const wrap = document.createElement("div");
    wrap.className = "bl-section";
    const W = sec.cols * cw, H = sec.rows * ch;
    const grid = document.createElement("div");
    grid.className = "bl-grid";
    grid.style.width = `${W}px`;
    grid.style.height = `${H}px`;
    grid.dataset.section = sec.sectionId;

    // cell layer
    const cellsEl = document.createElement("div");
    cellsEl.className = "bl-layer";
    let cellHtml = "";
    for (let r = 1; r <= sec.rows; r++) {
      for (let c = 1; c <= secWidth(sec, r); c++) {
        cellHtml += `<div class="bl-cell" style="left:${(c - 1) * cw}px;top:${(r - 1) * ch}px;width:${cw}px;height:${ch}px"></div>`;
      }
    }
    cellsEl.innerHTML = cellHtml;
    grid.appendChild(cellsEl);

    const blocksEl = document.createElement("div");
    blocksEl.className = "bl-layer";
    grid.appendChild(blocksEl);

    // frames: solid for framed shelves, dashed for the open top shelf,
    // an outline polygon for shapes without shelves (tabletop w/ notch).
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "bl-layer bl-frames");
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    const add = (tag, attrs) => {
      const el = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.appendChild(el);
    };
    if (sec.rowsPerShelf) {
      const n = Math.ceil(sec.rows / sec.rowsPerShelf);
      for (let i = 0; i < n; i++) {
        const open = i === 0 && sec.openTopShelf;
        add("rect", {
          x: 1, y: i * sec.rowsPerShelf * ch + 1,
          width: W - 2, height: sec.rowsPerShelf * ch - 2,
          fill: "none",
          stroke: open ? "#8a8fb0" : "#232442",
          "stroke-width": open ? 1.5 : 2,
          "stroke-dasharray": open ? "6 5" : "none",
        });
      }
    } else {
      // stepped outline for left-aligned rows of varying width
      const pts = [];
      let r = 1;
      pts.push([1, 1]);
      let lastX = null;
      for (r = 1; r <= sec.rows; r++) {
        const x = secWidth(sec, r) * cw - 1;
        if (lastX !== null && x !== lastX) pts.push([lastX, (r - 1) * ch + 1]);
        if (lastX === null || x !== lastX) pts.push([x, (r - 1) * ch + 1]);
        lastX = x;
      }
      pts.push([lastX, H - 1], [1, H - 1]);
      add("polygon", {
        points: pts.map((p) => p.join(",")).join(" "),
        fill: "none", stroke: "#232442", "stroke-width": 2, "stroke-linejoin": "round",
      });
    }
    grid.appendChild(svg);

    const selEl = document.createElement("div");
    selEl.className = "bl-layer bl-sel-layer";
    grid.appendChild(selEl);

    grid.addEventListener("pointerdown", onPointerDown);
    grid.addEventListener("pointermove", onPointerMove);
    grid.addEventListener("pointerup", onPointerUp);
    grid.addEventListener("pointercancel", onPointerCancel);

    ed.els[sec.sectionId] = { grid, blocks: blocksEl, sel: selEl };
    wrap.appendChild(grid);
    const title = document.createElement("div");
    title.className = "bl-section-title";
    title.textContent = sec.sectionName;
    wrap.appendChild(title);
    return wrap;
  }

  function wrapText(text, maxChars) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = "";
    for (const w of words) {
      if (!cur) cur = w;
      else if ((cur + " " + w).length <= maxChars) cur += " " + w;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  }

  function fitLabel(label, wPx, hPx) {
    const w = wPx - 8, h = hPx - 6;
    for (let fs = 16; fs >= 8; fs--) {
      const maxChars = Math.max(1, Math.floor(w / (fs * 0.58)));
      const lines = wrapText(label, maxChars);
      if (lines.length * fs * 1.15 <= h && lines.every((l) => l.length <= maxChars)) return { fs, lines };
    }
    // Too small even at the minimum size: truncate with an ellipsis (full text is in the tooltip + legend).
    const fs = 8;
    const maxChars = Math.max(2, Math.floor(w / (fs * 0.58)));
    const maxLines = Math.max(1, Math.floor(h / (fs * 1.15)));
    let lines = wrapText(label, maxChars).map((l) => (l.length > maxChars ? l.slice(0, Math.max(1, maxChars - 1)) + "…" : l));
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      const last = lines[maxLines - 1];
      lines[maxLines - 1] = last.endsWith("…") ? last : last.slice(0, Math.max(1, maxChars - 1)) + "…";
    }
    return { fs, lines };
  }

  function paintBlocks() {
    const { cw, ch } = ed;
    for (const sec of ed.template.sections) {
      const layer = ed.els[sec.sectionId].blocks;
      layer.innerHTML = "";
      const rects = rectsForSection(sec);
      // Sections without shelves (e.g. the tabletop): a connected area that got split into
      // several rectangles (like around the notch) shows its label once, on the largest piece.
      let labelOn = null;
      if (!sec.rowsPerShelf) {
        const compOf = new Map();
        const best = new Map();
        const area = (x) => (x.r2 - x.r1 + 1) * (x.c2 - x.c1 + 1);
        for (const rc of rects) {
          const k0 = `${rc.r1},${rc.c1}`;
          if (!compOf.has(k0)) {
            const comp = componentCells(sec, rc.r1, rc.c1);
            comp.forEach(([r, c]) => compOf.set(`${r},${c}`, k0));
          }
          const id = compOf.get(k0);
          const cur = best.get(id);
          if (!cur || area(rc) > area(cur)) best.set(id, rc);
        }
        labelOn = new Set(best.values());
      }
      for (const rc of rects) {
        const info = ed.labelInfo[rc.key];
        const el = document.createElement("div");
        el.className = "bl-block";
        el.title = info.label;
        const w = (rc.c2 - rc.c1 + 1) * cw, h = (rc.r2 - rc.r1 + 1) * ch;
        el.style.cssText = `left:${(rc.c1 - 1) * cw}px;top:${(rc.r1 - 1) * ch}px;width:${w}px;height:${h}px;background:${info.color};color:${textColorFor(info.color)}`;
        if (!labelOn || labelOn.has(rc)) {
          const fit = fitLabel(info.label, w, h);
          const t = document.createElement("span");
          t.className = "bl-block-label";
          t.style.fontSize = `${fit.fs}px`;
          t.textContent = fit.lines.join("\n");
          el.appendChild(t);
        }
        layer.appendChild(el);
      }
    }
  }

  function paintSelection() {
    for (const e of Object.values(ed.els)) e.sel.innerHTML = "";
    let secId = null, cells = [];
    if (drag) {
      const sec = secById(drag.sectionId);
      secId = sec.sectionId;
      cells = rectCells(sec, drag.a.r, drag.a.c, drag.cur.r, drag.cur.c);
    } else if (ed.sel) {
      secId = ed.sel.sectionId;
      cells = ed.sel.cells;
    }
    if (!secId) return;
    const { cw, ch } = ed;
    ed.els[secId].sel.innerHTML = cells.map(([r, c]) =>
      `<div class="bl-sel-cell" style="left:${(c - 1) * cw}px;top:${(r - 1) * ch}px;width:${cw}px;height:${ch}px"></div>`).join("");
  }

  // ----- pointer handling (edit mode) -----

  function cellFromEvent(grid, sec, e) {
    const rect = grid.getBoundingClientRect();
    return {
      r: clamp(Math.floor((e.clientY - rect.top) / ed.ch) + 1, 1, sec.rows),
      c: clamp(Math.floor((e.clientX - rect.left) / ed.cw) + 1, 1, sec.cols),
    };
  }

  function onPointerDown(e) {
    if (!ed || ed.mode !== "edit" || e.button > 0) return;
    const grid = e.currentTarget;
    const sec = secById(grid.dataset.section);
    const cell = cellFromEvent(grid, sec, e);
    if (!cellExists(sec, cell.r, cell.c)) return;
    grid.setPointerCapture(e.pointerId);
    drag = { sectionId: sec.sectionId, a: cell, cur: cell, moved: false };
    ed.sel = null;
    paintSelection();
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!drag) return;
    const grid = e.currentTarget;
    const sec = secById(drag.sectionId);
    const cell = cellFromEvent(grid, sec, e);
    if (cell.r !== drag.cur.r || cell.c !== drag.cur.c) {
      drag.cur = cell;
      drag.moved = drag.moved || cell.r !== drag.a.r || cell.c !== drag.a.c;
      paintSelection();
    }
  }

  function onPointerUp(e) {
    if (!drag) return;
    const d = drag;
    drag = null;
    const sec = secById(d.sectionId);
    if (!d.moved) {
      const key = ed.grid[sec.sectionId][d.a.r - 1][d.a.c - 1];
      if (key) {
        // click on a labeled cell -> select its whole block (with a "this cell only" option)
        ed.sel = {
          sectionId: sec.sectionId, single: [d.a.r, d.a.c], scope: "block",
          cells: componentCells(sec, d.a.r, d.a.c), key,
        };
      } else {
        ed.sel = { sectionId: sec.sectionId, single: null, scope: "rect", cells: [[d.a.r, d.a.c]], key: null };
      }
    } else {
      const cells = rectCells(sec, d.a.r, d.a.c, d.cur.r, d.cur.c);
      ed.sel = cells.length ? { sectionId: sec.sectionId, single: null, scope: "rect", cells, key: null } : null;
    }
    selUI = { color: null, colorTouched: false };
    paintSelection();
    renderSelBar({ focus: true });
  }

  function onPointerCancel() {
    drag = null;
    if (ed) paintSelection();
  }

  // ----- selection bar -----

  function selectionLabels() {
    // distinct label keys currently inside the selection
    const sec = secById(ed.sel.sectionId);
    const keys = new Set();
    for (const [r, c] of ed.sel.cells) {
      const k = ed.grid[sec.sectionId][r - 1][c - 1];
      if (k) keys.add(k);
    }
    return Array.from(keys);
  }

  function renderSelBar(opts) {
    const focus = !!(opts && opts.focus), keep = !!(opts && opts.keep);
    const bar = $("bl-selbar");
    if (ed.mode !== "edit") { bar.hidden = true; return; }
    bar.hidden = false;
    if (!ed.sel) {
      bar.innerHTML = `<span class="bl-hint">Drag across cells to select them, then type a label and press Enter.
        Click a labeled block to relabel or recolor it. Painting over part of a block splits it.</span>`;
      return;
    }
    const sec = secById(ed.sel.sectionId);
    const keys = selectionLabels();
    const prevInput = $("bl-sel-label");
    const typed = keep && prevInput ? prevInput.value : (keys.length === 1 ? ed.labelInfo[keys[0]].label : "");
    const n = ed.sel.cells.length;
    const rs = ed.sel.cells.map((x) => x[0]), cs = ed.sel.cells.map((x) => x[1]);
    let desc;
    if (ed.sel.scope === "block") {
      desc = `Block “${ed.labelInfo[ed.sel.key].label}” · ${n} cell${n === 1 ? "" : "s"} in ${sec.sectionName}`;
    } else if (ed.sel.scope === "cell") {
      desc = `1 cell in ${sec.sectionName}`;
    } else {
      desc = `${n} cell${n === 1 ? "" : "s"} in ${sec.sectionName} · rows ${Math.min(...rs)}–${Math.max(...rs)}, cols ${Math.min(...cs)}–${Math.max(...cs)}`;
    }
    const scopeHtml = ed.sel.single && ed.sel.key
      ? `<div class="bl-scope">
           <label><input type="radio" name="bl-scope" value="block" ${ed.sel.scope === "block" ? "checked" : ""}/> Whole block</label>
           <label><input type="radio" name="bl-scope" value="cell" ${ed.sel.scope === "cell" ? "checked" : ""}/> This cell only</label>
         </div>` : "";
    bar.innerHTML = `
      <div class="bl-sel-desc">${escapeHtml(desc)}</div>
      ${scopeHtml}
      <div class="bl-sel-controls">
        <input id="bl-sel-label" class="toolbar-input" list="bl-suggest" placeholder="Label (e.g. Marvel)" autocomplete="off" />
        <div class="bl-swatches" id="bl-swatches"></div>
        <button class="primary-btn" id="bl-apply">Apply</button>
        <button class="secondary-btn" id="bl-clear">Clear cells</button>
        <button class="secondary-btn" id="bl-cancel">Cancel</button>
      </div>
      <div class="bl-sel-error" id="bl-sel-error" hidden></div>`;
    const input = $("bl-sel-label");
    input.value = typed;
    syncSwatches();
    input.addEventListener("input", syncSwatches);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); applySelection(); }
    });
    $("bl-apply").addEventListener("click", applySelection);
    $("bl-clear").addEventListener("click", clearSelection);
    $("bl-cancel").addEventListener("click", cancelSelection);
    bar.querySelectorAll('input[name="bl-scope"]').forEach((r) => r.addEventListener("change", (e) => {
      const sec2 = secById(ed.sel.sectionId);
      if (e.target.value === "cell") {
        ed.sel.cells = [ed.sel.single];
        ed.sel.scope = "cell";
      } else {
        ed.sel.cells = componentCells(sec2, ed.sel.single[0], ed.sel.single[1]);
        ed.sel.scope = "block";
      }
      paintSelection();
      renderSelBar({ keep: true });
      $("bl-sel-label").focus();
    }));
    if (focus) { input.focus(); input.select(); }
  }

  function currentSelColor() {
    const input = $("bl-sel-label");
    const key = labelKey(input ? input.value : "");
    if (selUI.colorTouched && selUI.color) return selUI.color;
    if (key && ed.labelInfo[key]) return ed.labelInfo[key].color;
    if (!selUI.color) selUI.color = nextColor();
    return selUI.color;
  }

  function syncSwatches() {
    const host = $("bl-swatches");
    if (!host) return;
    const active = currentSelColor().toLowerCase();
    const colors = PALETTE.slice();
    if (!colors.some((c) => c.toLowerCase() === active)) colors.push(active);
    host.innerHTML = colors.map((c) =>
      `<button type="button" class="bl-swatch ${c.toLowerCase() === active ? "on" : ""}" style="background:${c}" data-color="${c}" title="${c}"></button>`).join("") +
      `<input type="color" id="bl-color-input" value="${/^#[0-9a-f]{6}$/i.test(active) ? active : "#f4b6b0"}" title="Custom color" />`;
    host.querySelectorAll(".bl-swatch").forEach((b) => b.addEventListener("click", () => {
      selUI.color = b.dataset.color;
      selUI.colorTouched = true;
      syncSwatches();
      $("bl-sel-label").focus();
    }));
    $("bl-color-input").addEventListener("input", (e) => {
      selUI.color = e.target.value;
      selUI.colorTouched = true;
      host.querySelectorAll(".bl-swatch").forEach((b) => b.classList.remove("on"));
    });
  }

  function showSelError(msg) {
    const el = $("bl-sel-error");
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
  }

  function applySelection() {
    if (!ed || !ed.sel) return;
    const label = $("bl-sel-label").value.trim();
    if (!label) { showSelError("Type a label first — or use “Clear cells” to unassign them."); return; }
    const key = labelKey(label);
    pushHistory();
    const existing = ed.labelInfo[key];
    const color = currentSelColor();
    if (existing) {
      if (selUI.colorTouched) existing.color = color; // recolors every block with this label
    } else {
      ed.labelInfo[key] = { label, color };
      knownLabels.add(label);
    }
    const sec = secById(ed.sel.sectionId);
    for (const [r, c] of ed.sel.cells) ed.grid[sec.sectionId][r - 1][c - 1] = key;
    ed.sel = null;
    selUI = { color: null, colorTouched: false };
    markDirty();
    paintAll();
  }

  function clearSelection() {
    if (!ed || !ed.sel) return;
    pushHistory();
    const sec = secById(ed.sel.sectionId);
    for (const [r, c] of ed.sel.cells) ed.grid[sec.sectionId][r - 1][c - 1] = null;
    ed.sel = null;
    markDirty();
    paintAll();
  }

  function cancelSelection() {
    if (!ed) return;
    ed.sel = null;
    drag = null;
    paintSelection();
    renderSelBar();
  }

  // ----- legend -----

  function renderLegend() {
    const counts = {};
    let total = 0, filled = 0;
    for (const sec of ed.template.sections) {
      for (const row of ed.grid[sec.sectionId]) {
        for (const k of row) {
          total++;
          if (k) { counts[k] = (counts[k] || 0) + 1; filled++; }
        }
      }
    }
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const chips = entries.map(([k, n]) => {
      const info = ed.labelInfo[k];
      return `<span class="bl-legend-item"><span class="bl-legend-dot" style="background:${info.color}"></span>${escapeHtml(info.label)} <span class="bl-legend-n">${n}</span></span>`;
    }).join("");
    $("bl-legend").innerHTML = `
      <div class="bl-legend-items">${chips || '<span class="bl-hint">No blocks yet.</span>'}</div>
      <div class="bl-legend-foot">${filled} of ${total} cells assigned · dashed outline = open top shelf (no frame)</div>`;
  }

  // ----- save / leave -----

  async function save() {
    if (!ed || ed.saving) return;
    const name = ed.showName.trim();
    if (!name) { showBanner("Give the layout a show name before saving."); $("bl-name").focus(); return; }
    clearBanner();
    ed.saving = true;
    updateHeaderState();
    try {
      const layout = {
        showName: name, date: ed.date || "", templateId: ed.templateId,
        notes: ed.notes || "", starred: ed.starred,
      };
      if (ed.layoutId) layout.layoutId = ed.layoutId;
      const res = await api({ action: "saveLayout", layout, regions: gridToRegions() });
      ed.layoutId = res.layoutId;
      ed.dirty = false;
      ed.savedAt = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    } catch (err) {
      showBanner(`Couldn't save the layout: ${err.message} — your changes are still here, nothing was lost.`);
    } finally {
      ed.saving = false;
      updateHeaderState();
    }
  }

  async function backToList() {
    if (ed && ed.dirty && !confirm("You have unsaved changes to this layout. Leave without saving?")) return;
    ed = null;
    drag = null;
    $("bl-editor").hidden = true;
    $("bl-editor").innerHTML = "";
    $("bl-list-view").hidden = false;
    await loadAll(); // pick up saves / new layouts
  }

  // ---------- boot ----------

  function bindStatic() {
    $("bl-search").addEventListener("input", (e) => { listFilters.search = e.target.value; renderList(); });
    $("bl-starred-only").addEventListener("change", (e) => { listFilters.starredOnly = e.target.checked; renderList(); });
    $("bl-refresh").addEventListener("click", loadAll);
    $("bl-new-btn").addEventListener("click", () => openNewForm(""));
    $("bl-new-cancel").addEventListener("click", () => { $("bl-new-form").hidden = true; });
    $("bl-new-create").addEventListener("click", submitNewForm);
    $("bl-new-from").addEventListener("change", syncNewFormTemplateLock);
    $("bl-new-name").addEventListener("keydown", (e) => { if (e.key === "Enter") submitNewForm(); });

    $("bl-list").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      const row = e.target.closest(".bl-row");
      if (!btn || !row) return;
      const id = row.dataset.id;
      const act = btn.dataset.act;
      if (act === "open") openExisting(id);
      else if (act === "star") toggleStarFromList(id);
      else if (act === "copy") openNewForm(id);
      else if (act === "delete") deleteFromList(id);
    });

    document.addEventListener("keydown", (e) => {
      if (!ed || ed.mode !== "edit" || $("bl-editor").hidden) return;
      if (e.key === "Escape") cancelSelection();
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
        e.preventDefault();
        undo();
      }
    });

    window.addEventListener("beforeunload", (e) => {
      if (ed && ed.dirty) { e.preventDefault(); e.returnValue = ""; }
    });

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (ed && !$("bl-editor").hidden && $("tab-layouts").classList.contains("active")) {
          const keep = ed.sel;
          renderDiagram();
          ed.sel = keep;
          paintSelection();
        }
      }, 150);
    });

    // Tab may be opened while hidden at boot: re-fit the diagram when it becomes visible.
    document.querySelectorAll(".tab-btn").forEach((b) => b.addEventListener("click", () => {
      if (b.dataset.tab === "layouts" && ed && !$("bl-editor").hidden) setTimeout(() => { renderDiagram(); }, 0);
    }));
  }

  window.initBoothLayouts = function initBoothLayouts() {
    bindStatic();
    loadAll();
  };
})();
