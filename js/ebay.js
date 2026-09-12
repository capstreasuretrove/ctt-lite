// CTT Lite — eBay Listings module
//
// Mimics the Tauri desktop app's "Listings" module UX (per the port guide):
// a two-stage grid-then-cards flow. The grid (Stage 1) is for fast bulk
// entry of the core fields, one row per listing. Opening a row's card
// (Stage 2) is where template-specific fields, photos, title/description
// generation, and posting to eBay actually happen.
//
// ARCHITECTURE NOTES:
//   - No backend of its own — listing records live in this browser's
//     localStorage (per the port guide's own porting considerations: a
//     single-user/single-browser "lite" tool has no Sheet to store these
//     in, unlike Inventory/Consignment). A page reload keeps saved fields
//     and any already-uploaded photo URLs, but loses not-yet-uploaded
//     local photo Files (browsers can't persist File objects) — upload
//     photos before closing the tab if you're not done with a listing.
//   - eBay's Trading API doesn't answer browser CORS, so AddItem/
//     VerifyAddItem/GetOrders/GetMyeBaySelling all go through
//     netlify/functions/ebay-proxy.js — the exact proxy Brody supplied
//     from the already-working standalone listing tool (2026-09-12),
//     redeployed here byte-for-byte. It's a dumb passthrough: all eBay
//     auth travels inside the XML body (RequesterCredentials/eBayAuthToken)
//     built client-side, not as server-side secrets — so the auth token
//     and imgBB key live in THIS browser's localStorage (Settings panel
//     below), matching the port guide's own recommendation.
//   - IMPORTANT — UNLIKE INVENTORY/CONSIGNMENT, THIS WAS NOT LIVE-TESTED.
//     Every prior module's live probing was safe because a bad guess just
//     touched a Sheet row that could be added/edited/deleted freely.
//     Actually posting a listing is real and public — it can't be tested
//     that way. The XML shape below is rebuilt from the port guide's
//     documented fields/constants, not the literal source (which wasn't
//     available), and there's no eBay auth token available in this
//     environment to test with anyway. **Use the Verify button (which
//     calls eBay's VerifyAddItem — validates without publishing) before
//     ever using Post**, and expect to debug real eBay XML-schema
//     complaints on the first few tries. This is flagged clearly in the
//     UI too (see the banner note once a token is saved).
//   - Reconciled against Brody's CURRENT stated eBay preferences (which
//     postdate the port guide) rather than the guide's literal template
//     strings:
//       - Title: appends " - IN HAND - SHIPS FAST!" when the base title is
//         under 80 chars (confirmed current preference), not the guide's
//         separate not-yet-reconciled length-meter description.
//       - Description: the port guide's default Signed-template closer
//         mentioned a "Popshield Soft Protector" — dropped, since Brody's
//         current preference is to never mention protectors unless
//         explicitly included, and there's no "protector included" field
//         in this schema to key that off of. Mention one by hand-editing
//         the generated description if a specific listing includes one.
//       - Added a `multiQuantity` checkbox per listing so the "Multiple
//         units available" disclaimer is only ever explicit per item,
//         never guessed — matching the stated preference for that line.
//   - Added beyond the documented spec (not from the port guide): the
//     title-only manual-edit lock is documented; a matching lock for the
//     description was added too (same UX, own "regenerate" button) so
//     hand-edits to a description can't be silently clobbered by a later
//     Generate click. Easy to remove if unwanted.

const EBAY_TEMPLATES = ["Common", "Exclusive", "Limited Edition", "Signed"];
const EBAY_CONDITIONS = [
  { label: "New", id: 1000 },
  { label: "Like New", id: 3000 },
  { label: "Very Good", id: 4000 },
  { label: "Good", id: 5000 },
  { label: "Acceptable", id: 6000 },
];

const EBAY_GRID_COLUMNS = [
  { key: "templateStyle", label: "Template", width: "1fr", type: "select", options: EBAY_TEMPLATES },
  { key: "name", label: "Name", width: "1.5fr" },
  { key: "number", label: "#", width: "0.6fr" },
  { key: "line", label: "Line", width: "0.9fr" },
  { key: "license", label: "License", width: "0.9fr" },
  { key: "price", label: "Price", width: "0.6fr" },
  { key: "qty", label: "Qty", width: "0.5fr" },
  { key: "condition", label: "Condition", width: "0.9fr", type: "select", options: EBAY_CONDITIONS.map((c) => c.label) },
];

const EBAY_STORAGE_KEY = "ctt-lite-ebay-listings";
const EBAY_SETTINGS_KEY = "ctt-lite-ebay-settings";
const EBAY_TITLE_MAX = 80;
const EBAY_MAX_PHOTOS = 12;

let listings = [];
let openListingId = null; // which listing's card is currently shown, if any

function isEmptyEbay(v) {
  return v === undefined || v === null || String(v).trim() === "";
}

function showEbayError(msg) {
  const el = document.getElementById("ebay-banner");
  el.textContent = msg;
  el.hidden = false;
  el.className = "banner banner-error";
}

function showEbayInfo(msg) {
  const el = document.getElementById("ebay-banner");
  el.textContent = msg;
  el.hidden = false;
  el.className = "banner banner-info";
}

function hideEbayBanner() {
  document.getElementById("ebay-banner").hidden = true;
}

// ---------- Data model ----------

function blankListingDraft() {
  return {
    id: null,
    status: "Draft", // Draft -> Generated -> Listed
    templateStyle: "Common",
    name: "",
    number: "",
    line: "",
    license: "",
    price: "",
    qty: "1",
    condition: "New",
    variant: "",
    exclusive: "",
    pieceCount: "",
    signedBy: "",
    authCompany: "",
    coaNumber: "",
    multiQuantity: false,
    photos: [], // [{ id, uploadedUrl }] — Files only ever live in a separate in-memory map, see photoFilesById
    generatedTitle: "",
    generatedDescription: "",
    titleManuallyEdited: false,
    descriptionManuallyEdited: false,
    ebayItemId: "",
  };
}

// In-memory only — File objects can't survive localStorage, so pending
// (not-yet-uploaded) photo files are tracked separately by photo id and
// lost on reload, same as the note at the top of this file.
const photoFilesById = new Map();

function loadListings() {
  try {
    const raw = localStorage.getItem(EBAY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    listings = parsed.map((l) => ({
      ...blankListingDraft(),
      ...l,
      photos: (l.photos || []).filter((p) => p.uploadedUrl),
    }));
  } catch (err) {
    listings = [];
  }
}

function saveListings() {
  try {
    localStorage.setItem(EBAY_STORAGE_KEY, JSON.stringify(listings));
  } catch (err) {
    showEbayError(`Couldn't save to this browser's storage: ${err.message}`);
  }
}

function getEbaySettings() {
  try {
    return JSON.parse(localStorage.getItem(EBAY_SETTINGS_KEY) || "{}");
  } catch (err) {
    return {};
  }
}

function saveEbaySettings(settings) {
  try {
    localStorage.setItem(EBAY_SETTINGS_KEY, JSON.stringify(settings));
  } catch (err) {
    showEbayError(`Couldn't save settings: ${err.message}`);
  }
}

// ---------- Field visibility per template ----------

function fieldVisibleForTemplate(key, templateStyle) {
  switch (key) {
    case "variant":
      return templateStyle !== "Signed";
    case "exclusive":
      return templateStyle === "Exclusive" || templateStyle === "Limited Edition";
    case "pieceCount":
      return templateStyle === "Limited Edition";
    case "signedBy":
    case "authCompany":
    case "coaNumber":
      return templateStyle === "Signed";
    default:
      return true;
  }
}

// ---------- Title / description generation ----------

/** Appends the "- IN HAND - SHIPS FAST!" suffix per Brody's current stated
 * preference when it fits within the 80-char eBay title cap; otherwise
 * leaves the base title as-is (truncating only if the base itself is
 * already over the cap). */
function applyInHandSuffix(base) {
  const SUFFIX = " - IN HAND - SHIPS FAST!";
  if (base.length >= EBAY_TITLE_MAX) return base.slice(0, EBAY_TITLE_MAX);
  const withSuffix = base + SUFFIX;
  return withSuffix.length <= EBAY_TITLE_MAX ? withSuffix : base;
}

function generateTitle(listing) {
  const line = listing.line || "";
  const license = listing.license || "";
  const name = listing.name || "";
  const number = listing.number || "";
  const variantPart = listing.variant ? `[${listing.variant}] ` : "";
  let base;

  if (listing.templateStyle === "Signed") {
    base = `SIGNED Funko Pop! ${line} ${license}: ${name} [#${number}] - ${listing.signedBy || ""} ${listing.authCompany || ""} COA`;
  } else {
    const exclPart = listing.exclusive && fieldVisibleForTemplate("exclusive", listing.templateStyle) ? `[${listing.exclusive} Excl] ` : "";
    let pcsPart = "";
    if (listing.templateStyle === "Limited Edition" && !isEmptyEbay(listing.pieceCount)) {
      const pc = String(listing.pieceCount).trim();
      pcsPart = /^\d+$/.test(pc) ? `[${pc}pcs] ` : `[${pc}] `;
    }
    base = `Funko Pop! ${line} ${license}: ${name} ${variantPart}${exclPart}${pcsPart}[#${number}]`;
  }

  base = base.replace(/\s+/g, " ").trim();
  return applyInHandSuffix(base);
}

function generateDescription(listing) {
  const lines = [];
  lines.push(listing.name || "");
  lines.push("");
  if (listing.line) lines.push(`• Line: ${listing.line}`);
  if (listing.license) lines.push(`• License: ${listing.license}`);
  if (listing.number) lines.push(`• Funko Pop #: ${listing.number}`);
  if (listing.variant && fieldVisibleForTemplate("variant", listing.templateStyle)) lines.push(`• Variant: ${listing.variant}`);
  if (listing.exclusive && fieldVisibleForTemplate("exclusive", listing.templateStyle)) lines.push(`• Exclusive: ${listing.exclusive}`);
  if (listing.templateStyle === "Limited Edition" && !isEmptyEbay(listing.pieceCount)) {
    const pc = String(listing.pieceCount).trim();
    lines.push(`• Limited Edition: ${pc}${/^\d+$/.test(pc) ? " pieces" : ""}`);
  }
  if (listing.templateStyle === "Signed") {
    const who = [listing.signedBy, listing.authCompany ? `authenticated by ${listing.authCompany}` : ""].filter(Boolean).join(", ");
    if (who) lines.push(`• Signed by: ${who}${listing.coaNumber ? ` (COA #${listing.coaNumber})` : ""}`);
  }
  if (listing.condition) lines.push(`• Condition: ${listing.condition}`);
  if (listing.multiQuantity) {
    lines.push("");
    lines.push("Multiple units available — all near mint condition.");
  }
  lines.push("");
  lines.push("Ships fast and is packed carefully — thanks for looking, and happy collecting!");
  return lines.join("\n");
}

/** Runs generation, respecting each field's manual-edit lock — call this
 * from the main "Generate" button. Force-regenerate a single field with
 * generateTitle()/generateDescription() directly (see the card's ↻
 * buttons), which ignore the lock and reset it. */
function runGeneration(listing) {
  if (!listing.titleManuallyEdited) listing.generatedTitle = generateTitle(listing);
  if (!listing.descriptionManuallyEdited) listing.generatedDescription = generateDescription(listing);
  if (listing.status === "Draft") listing.status = "Generated";
}

// ---------- eBay XML + proxy calls ----------

function xmlEscape(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildPictureUrlsXml(urls) {
  return urls.map((u) => `<PictureURL>${xmlEscape(u)}</PictureURL>`).join("");
}

/** Builds the AddItem/VerifyAddItem request XML. NOT verified against a
 * real eBay response yet — see the file header notes. Uses the fixed
 * business constants already confirmed from the desktop app / standalone
 * tool (category, policy IDs, postal code, box dimensions). */
function buildEbayXml(listing, photoUrls, authToken, rootElement) {
  const conditionId = (EBAY_CONDITIONS.find((c) => c.label === listing.condition) || EBAY_CONDITIONS[0]).id;
  const descriptionHtml = xmlEscape(listing.generatedDescription || "").replace(/\n/g, "<br>");
  return `<?xml version="1.0" encoding="utf-8"?>
<${rootElement} xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials>
    <eBayAuthToken>${xmlEscape(authToken)}</eBayAuthToken>
  </RequesterCredentials>
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  <Item>
    <Title>${xmlEscape(listing.generatedTitle)}</Title>
    <Description><![CDATA[${descriptionHtml}]]></Description>
    <PrimaryCategory><CategoryID>149372</CategoryID></PrimaryCategory>
    <StartPrice>${xmlEscape(listing.price || "0")}</StartPrice>
    <ConditionID>${conditionId}</ConditionID>
    <Country>US</Country>
    <Currency>USD</Currency>
    <DispatchTimeMax>3</DispatchTimeMax>
    <ListingDuration>GTC</ListingDuration>
    <ListingType>FixedPriceItem</ListingType>
    <PostalCode>08724</PostalCode>
    <Quantity>${xmlEscape(listing.qty || "1")}</Quantity>
    <SellerProfiles>
      <SellerShippingProfile><ShippingProfileID>250736863013</ShippingProfileID></SellerShippingProfile>
      <SellerPaymentProfile><PaymentProfileID>250736864013</PaymentProfileID></SellerPaymentProfile>
      <SellerReturnProfile><ReturnProfileID>250285724013</ReturnProfileID></SellerReturnProfile>
    </SellerProfiles>
    <PictureDetails>${buildPictureUrlsXml(photoUrls)}</PictureDetails>
    <ItemSpecifics>
      <NameValueList><Name>Type</Name><Value>Vinyl Figure</Value></NameValueList>
      <NameValueList><Name>Brand</Name><Value>Funko</Value></NameValueList>
      <NameValueList><Name>Product Line</Name><Value>Pop! Vinyl</Value></NameValueList>
      <NameValueList><Name>Character Family</Name><Value>${xmlEscape(listing.license)}</Value></NameValueList>
      <NameValueList><Name>Character</Name><Value>${xmlEscape(listing.name)}</Value></NameValueList>
      <NameValueList><Name>Funko Pop Number</Name><Value>${xmlEscape(listing.number)}</Value></NameValueList>
    </ItemSpecifics>
    <ShippingPackageDetails>
      <ShippingIrregular>false</ShippingIrregular>
      <ShippingPackage>PackageThickEnvelope</ShippingPackage>
      <WeightMajor unit="lbs">1</WeightMajor>
      <WeightMinor unit="oz">0</WeightMinor>
      <PackageDepth unit="inches">5</PackageDepth>
      <PackageLength unit="inches">8</PackageLength>
      <PackageWidth unit="inches">6</PackageWidth>
    </ShippingPackageDetails>
  </Item>
</${rootElement}>`;
}

/** Parses an eBay Trading API XML response per the port guide's rule:
 * success = Ack is Success/Warning AND an ItemID is present. Otherwise,
 * every LongMessage whose sibling SeverityCode is Error, joined with
 * " | "; falling back to any LongMessage, then to a raw-body snippet. */
function parseEbayResponse(xmlText, httpStatus) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(xmlText, "text/xml");
    if (doc.querySelector("parsererror")) throw new Error("parse error");
  } catch (err) {
    return { success: false, message: `Unrecognized response (HTTP ${httpStatus}): ${xmlText.slice(0, 300)}` };
  }
  const ack = doc.querySelector("Ack")?.textContent;
  const itemId = doc.querySelector("ItemID")?.textContent;
  if ((ack === "Success" || ack === "Warning") && itemId) {
    return { success: true, itemId, ack };
  }
  const allErrors = Array.from(doc.querySelectorAll("Errors"));
  const severe = allErrors.filter((el) => el.querySelector("SeverityCode")?.textContent === "Error");
  const pool = severe.length ? severe : allErrors;
  const messages = pool.map((el) => el.querySelector("LongMessage")?.textContent).filter(Boolean);
  if (messages.length) return { success: false, message: messages.join(" | ") };
  return { success: false, message: `Unrecognized response (HTTP ${httpStatus}): ${xmlText.slice(0, 300)}` };
}

async function callEbayProxy(xml, callName) {
  const res = await fetch(CONFIG.EBAY_PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ xml, callName }),
  });
  const text = await res.text();
  return parseEbayResponse(text, res.status);
}

async function uploadLocalPhotoToImgbb(file, imgbbKey) {
  const formData = new FormData();
  formData.append("key", imgbbKey);
  formData.append("image", file);
  const res = await fetch("https://api.imgbb.com/1/upload", { method: "POST", body: formData });
  const data = await res.json();
  if (!data.success) throw new Error((data.error && data.error.message) || "imgBB upload failed");
  return data.data.url;
}

async function uploadStorePhoto(imgbbKey) {
  const driveUrl = toDriveThumbnail(`https://drive.google.com/file/d/${CONFIG.CTT_STORE_PHOTO_DRIVE_ID}/view`);
  const res = await fetch(CONFIG.EBAY_PROXY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "upload_photo", driveUrl, imgbbKey }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || "Store photo upload failed");
  return data.url;
}

/** Uploads any not-yet-uploaded local photos, then returns up to
 * EBAY_MAX_PHOTOS URLs with the CTT store photo appended last (best-effort
 * — if the store photo fails, the listing still proceeds without it, per
 * the port guide). */
async function resolvePhotoUrls(listing, imgbbKey) {
  for (const photo of listing.photos) {
    if (!photo.uploadedUrl && photoFilesById.has(photo.id)) {
      photo.uploadedUrl = await uploadLocalPhotoToImgbb(photoFilesById.get(photo.id), imgbbKey);
    }
  }
  const urls = listing.photos.map((p) => p.uploadedUrl).filter(Boolean).slice(0, EBAY_MAX_PHOTOS - 1);
  try {
    const storeUrl = await uploadStorePhoto(imgbbKey);
    urls.push(storeUrl);
  } catch (err) {
    // Best-effort — the store photo is a nice-to-have, not required.
  }
  return urls.slice(0, EBAY_MAX_PHOTOS);
}

// ---------- Grid (Stage 1) ----------

function updateEbayCount() {
  document.getElementById("ebay-count").textContent = `${listings.length} listing${listings.length === 1 ? "" : "s"}`;
}

function buildEbayHeaderEl() {
  const header = document.getElementById("ebay-header");
  header.innerHTML = "";
  header.style.gridTemplateColumns = EBAY_GRID_COLUMNS.map((c) => c.width).join(" ") + " 5rem 5rem";
  for (const col of EBAY_GRID_COLUMNS) {
    const cell = document.createElement("div");
    cell.className = "inv-th con-th-static";
    cell.textContent = col.label;
    header.appendChild(cell);
  }
  header.appendChild(document.createElement("div")).className = "inv-th";
  header.appendChild(document.createElement("div")).className = "inv-th";
}

function buildFieldInput(col, value, onChange) {
  if (col.type === "select") {
    const select = document.createElement("select");
    select.className = "inv-input";
    for (const opt of col.options) {
      const optEl = document.createElement("option");
      optEl.value = opt;
      optEl.textContent = opt;
      select.appendChild(optEl);
    }
    select.value = value || col.options[0];
    select.addEventListener("change", () => onChange(select.value));
    return select;
  }
  const input = document.createElement("input");
  input.type = "text";
  input.value = value ?? "";
  input.className = "inv-input";
  input.addEventListener("change", () => onChange(input.value));
  return input;
}

function buildEbayRowEl(listing) {
  const row = document.createElement("div");
  row.className = "inv-row";
  row.style.gridTemplateColumns = EBAY_GRID_COLUMNS.map((c) => c.width).join(" ") + " 5rem 5rem";

  for (const col of EBAY_GRID_COLUMNS) {
    const cell = document.createElement("div");
    cell.className = "inv-td";
    cell.appendChild(buildFieldInput(col, listing[col.key], (val) => handleGridFieldEdit(listing, col.key, val)));
    row.appendChild(cell);
  }

  const statusCell = document.createElement("div");
  statusCell.className = "inv-td";
  const badge = document.createElement("span");
  badge.className = `ebay-status-badge ebay-status-${listing.status}`;
  badge.textContent = listing.status;
  statusCell.appendChild(badge);
  row.appendChild(statusCell);

  const actionsCell = document.createElement("div");
  actionsCell.className = "inv-td inv-actions";
  const openBtn = document.createElement("button");
  openBtn.className = "ebay-open-btn";
  openBtn.textContent = "Open";
  openBtn.addEventListener("click", () => openListingCard(listing.id));
  actionsCell.appendChild(openBtn);
  if (listing.status !== "Listed") {
    const delBtn = document.createElement("button");
    delBtn.className = "icon-btn";
    delBtn.textContent = "✕";
    delBtn.title = "Delete";
    delBtn.style.marginLeft = "0.3rem";
    delBtn.addEventListener("click", () => handleDeleteListing(listing));
    actionsCell.appendChild(delBtn);
  }
  row.appendChild(actionsCell);

  return row;
}

function handleGridFieldEdit(listing, key, value) {
  listing[key] = value;
  saveListings();
  renderEbayRows();
}

function handleDeleteListing(listing) {
  if (!confirm(`Delete this draft listing (${listing.name || "unnamed"})? This can't be undone here.`)) return;
  listings = listings.filter((l) => l.id !== listing.id);
  saveListings();
  renderEbayRows();
}

function renderEbayRows() {
  const rowsEl = document.getElementById("ebay-rows");
  rowsEl.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const listing of listings) frag.appendChild(buildEbayRowEl(listing));
  rowsEl.appendChild(frag);
  updateEbayCount();
  populateEbayNameDatalist();
}

function buildEbayAddRowEl() {
  const container = document.getElementById("ebay-add-row");
  container.innerHTML = "";
  container.style.gridTemplateColumns = EBAY_GRID_COLUMNS.map((c) => c.width).join(" ") + " 5rem 5rem";

  const draft = blankListingDraft();

  const handleEnter = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitAddRow(draft);
    }
  };

  for (const col of EBAY_GRID_COLUMNS) {
    const cell = document.createElement("div");
    cell.className = "inv-td";
    const input = buildFieldInput(col, draft[col.key], (val) => {
      draft[col.key] = val;
    });
    if (input.tagName === "INPUT") {
      input.placeholder = col.label;
      input.addEventListener("keydown", handleEnter);
    }
    cell.appendChild(input);
    container.appendChild(cell);
  }

  container.appendChild(document.createElement("div")).className = "inv-td";

  const actionsCell = document.createElement("div");
  actionsCell.className = "inv-td inv-actions";
  const addBtn = document.createElement("button");
  addBtn.className = "icon-btn add-btn";
  addBtn.textContent = "+";
  addBtn.title = "Add listing draft (or press Enter in any field)";
  addBtn.addEventListener("click", () => commitAddRow(draft));
  actionsCell.appendChild(addBtn);
  container.appendChild(actionsCell);
}

function commitAddRow(draft) {
  if (isEmptyEbay(draft.name)) {
    showEbayError("Enter a name before adding the listing.");
    return;
  }
  draft.id = `ebay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  listings.push(draft);
  saveListings();
  buildEbayAddRowEl();
  renderEbayRows();
  hideEbayBanner();
}

function populateEbayNameDatalist() {
  // Reuses Inventory's already-loaded `items` global (see inventory.js) —
  // both modules share the page's plain-script global scope. Falls back
  // to nothing if Inventory hasn't loaded yet.
  const list = document.getElementById("ebay-name-datalist");
  if (typeof items === "undefined" || !Array.isArray(items)) {
    list.innerHTML = "";
    return;
  }
  list.innerHTML = distinctValues(items, "name")
    .map((n) => `<option value="${escapeHtml(n)}">`)
    .join("");
}

/** On the card, picking a Name that matches an Inventory item autofills
 * #/line/license — but only into fields that are still blank, so it never
 * clobbers something already typed. */
function autofillFromInventory(listing) {
  if (typeof items === "undefined" || !Array.isArray(items)) return;
  const match = items.find((it) => it.name && it.name.toLowerCase() === (listing.name || "").toLowerCase());
  if (!match) return;
  if (isEmptyEbay(listing.number)) listing.number = match.number || "";
  if (isEmptyEbay(listing.line)) listing.line = match.line || "";
  if (isEmptyEbay(listing.license)) listing.license = match.license || "";
}

// ---------- Card (Stage 2) ----------

function getListingById(id) {
  return listings.find((l) => l.id === id);
}

function openListingCard(id) {
  openListingId = id;
  const listing = getListingById(id);
  if (listing && !listing.generatedTitle && !listing.generatedDescription) {
    runGeneration(listing);
    saveListings();
    renderEbayRows();
  }
  renderCard();
  document.getElementById("ebay-card-overlay").hidden = false;
}

function closeListingCard() {
  openListingId = null;
  document.getElementById("ebay-card-overlay").hidden = true;
}

const EBAY_EXTRA_FIELDS = [
  { key: "variant", label: "Variant" },
  { key: "exclusive", label: "Exclusive" },
  { key: "pieceCount", label: "Piece Count" },
  { key: "signedBy", label: "Signed By" },
  { key: "authCompany", label: "Auth Company" },
  { key: "coaNumber", label: "COA #" },
];

function titleMeterClass(len) {
  if (len === 0) return "";
  if (len <= 60) return "bad";
  if (len <= 80) return "ok";
  return "bad";
}

function renderCard() {
  const listing = getListingById(openListingId);
  const body = document.getElementById("ebay-card-body");
  if (!listing) {
    body.innerHTML = "";
    return;
  }

  body.innerHTML = "";

  const heading = document.createElement("h2");
  heading.style.marginTop = "0";
  heading.textContent = listing.name || "Untitled listing";
  body.appendChild(heading);

  // --- Details section ---
  const detailsSection = document.createElement("div");
  detailsSection.className = "ebay-card-section";
  const detailsHeading = document.createElement("h3");
  detailsHeading.textContent = "Details";
  detailsSection.appendChild(detailsHeading);
  const fieldsEl = document.createElement("div");
  fieldsEl.className = "ebay-card-fields";

  const templateLabel = document.createElement("label");
  templateLabel.textContent = "Template";
  const templateSelect = document.createElement("select");
  for (const t of EBAY_TEMPLATES) {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    templateSelect.appendChild(opt);
  }
  templateSelect.value = listing.templateStyle;
  templateSelect.addEventListener("change", () => {
    listing.templateStyle = templateSelect.value;
    saveListings();
    renderEbayRows();
    renderCard();
  });
  templateLabel.appendChild(templateSelect);
  fieldsEl.appendChild(templateLabel);

  const multiLabel = document.createElement("label");
  multiLabel.textContent = "Multiple units (disclaimer)";
  const multiCheckbox = document.createElement("input");
  multiCheckbox.type = "checkbox";
  multiCheckbox.checked = Boolean(listing.multiQuantity);
  multiCheckbox.addEventListener("change", () => {
    listing.multiQuantity = multiCheckbox.checked;
    saveListings();
  });
  multiLabel.appendChild(multiCheckbox);
  fieldsEl.appendChild(multiLabel);

  for (const field of EBAY_EXTRA_FIELDS) {
    const label = document.createElement("label");
    label.textContent = field.label;
    const visible = fieldVisibleForTemplate(field.key, listing.templateStyle);
    if (!visible) label.classList.add("ebay-field-hidden");
    const input = document.createElement("input");
    input.type = "text";
    input.value = listing[field.key] ?? "";
    input.disabled = !visible;
    input.addEventListener("change", () => {
      listing[field.key] = input.value;
      saveListings();
    });
    label.appendChild(input);
    fieldsEl.appendChild(label);
  }

  detailsSection.appendChild(fieldsEl);
  body.appendChild(detailsSection);

  // --- Photos section ---
  const photosSection = document.createElement("div");
  photosSection.className = "ebay-card-section";
  const photosHeading = document.createElement("h3");
  photosHeading.textContent = `Photos (${listing.photos.length}/${EBAY_MAX_PHOTOS - 1} + CTT store photo)`;
  photosSection.appendChild(photosHeading);

  const dropZone = document.createElement("div");
  dropZone.className = "ebay-photo-drop";
  dropZone.textContent = "Drag photos here, or click to choose files";
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.multiple = true;
  fileInput.hidden = true;
  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    addPhotoFiles(listing, Array.from(e.dataTransfer.files || []));
  });
  fileInput.addEventListener("change", () => {
    addPhotoFiles(listing, Array.from(fileInput.files || []));
    fileInput.value = "";
  });
  photosSection.appendChild(dropZone);
  photosSection.appendChild(fileInput);

  const photoGrid = document.createElement("div");
  photoGrid.className = "ebay-photo-grid";
  for (const photo of listing.photos) {
    const thumb = document.createElement("div");
    thumb.className = "ebay-photo-thumb";
    const img = document.createElement("img");
    img.src = photo.uploadedUrl || (photoFilesById.has(photo.id) ? URL.createObjectURL(photoFilesById.get(photo.id)) : "");
    thumb.appendChild(img);
    if (!photo.uploadedUrl) {
      const pending = document.createElement("div");
      pending.className = "ebay-photo-pending";
      pending.textContent = "Not uploaded";
      thumb.appendChild(pending);
    }
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "✕";
    removeBtn.title = "Remove photo";
    removeBtn.addEventListener("click", () => {
      listing.photos = listing.photos.filter((p) => p.id !== photo.id);
      photoFilesById.delete(photo.id);
      saveListings();
      renderCard();
    });
    thumb.appendChild(removeBtn);
    photoGrid.appendChild(thumb);
  }
  photosSection.appendChild(photoGrid);
  body.appendChild(photosSection);

  // --- Generation section ---
  const genSection = document.createElement("div");
  genSection.className = "ebay-card-section";
  const genHeading = document.createElement("h3");
  genHeading.textContent = "Title & Description";
  genSection.appendChild(genHeading);

  const generateBtn = document.createElement("button");
  generateBtn.className = "secondary-btn";
  generateBtn.textContent = "↻ Generate";
  generateBtn.title = "Regenerates the title and description, unless you've hand-edited them (use the field's own ↻ to force that one)";
  generateBtn.addEventListener("click", () => {
    autofillFromInventory(listing);
    runGeneration(listing);
    saveListings();
    renderEbayRows();
    renderCard();
  });
  genSection.appendChild(generateBtn);

  const titleRow = document.createElement("div");
  titleRow.className = "ebay-title-row";
  titleRow.style.marginTop = "0.6rem";
  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "toolbar-input";
  titleInput.value = listing.generatedTitle || "";
  titleInput.addEventListener("input", () => {
    listing.generatedTitle = titleInput.value;
    listing.titleManuallyEdited = true;
    saveListings();
    meterEl.textContent = `${titleInput.value.length}/${EBAY_TITLE_MAX} characters`;
    meterEl.className = `ebay-title-meter ${titleMeterClass(titleInput.value.length)}`;
  });
  const titleRegenBtn = document.createElement("button");
  titleRegenBtn.className = "ebay-regen-btn";
  titleRegenBtn.textContent = "↻";
  titleRegenBtn.title = "Force-regenerate the title, overwriting any hand edits";
  titleRegenBtn.addEventListener("click", () => {
    listing.titleManuallyEdited = false;
    listing.generatedTitle = generateTitle(listing);
    saveListings();
    renderCard();
  });
  titleRow.appendChild(titleInput);
  titleRow.appendChild(titleRegenBtn);
  genSection.appendChild(titleRow);

  const meterEl = document.createElement("div");
  const tlen = (listing.generatedTitle || "").length;
  meterEl.className = `ebay-title-meter ${titleMeterClass(tlen)}`;
  meterEl.textContent = `${tlen}/${EBAY_TITLE_MAX} characters`;
  genSection.appendChild(meterEl);

  const descRow = document.createElement("div");
  descRow.className = "ebay-desc-row";
  descRow.style.marginTop = "0.6rem";
  const descArea = document.createElement("textarea");
  descArea.value = listing.generatedDescription || "";
  descArea.addEventListener("input", () => {
    listing.generatedDescription = descArea.value;
    listing.descriptionManuallyEdited = true;
    saveListings();
  });
  const descRegenBtn = document.createElement("button");
  descRegenBtn.className = "ebay-regen-btn";
  descRegenBtn.textContent = "↻";
  descRegenBtn.title = "Force-regenerate the description, overwriting any hand edits";
  descRegenBtn.addEventListener("click", () => {
    listing.descriptionManuallyEdited = false;
    listing.generatedDescription = generateDescription(listing);
    saveListings();
    renderCard();
  });
  descRow.appendChild(descArea);
  descRow.appendChild(descRegenBtn);
  genSection.appendChild(descRow);

  body.appendChild(genSection);

  // --- Post section ---
  const postSection = document.createElement("div");
  postSection.className = "ebay-card-section";
  const postHeading = document.createElement("h3");
  postHeading.textContent = "Post to eBay";
  postSection.appendChild(postHeading);

  if (listing.status === "Listed") {
    const listedNote = document.createElement("p");
    listedNote.innerHTML = `Already posted — <a class="ebay-item-link" href="https://www.ebay.com/itm/${encodeURIComponent(listing.ebayItemId)}" target="_blank" rel="noopener">Item ${escapeHtml(listing.ebayItemId)}</a>`;
    postSection.appendChild(listedNote);
  } else {
    const settings = getEbaySettings();
    if (!settings.authToken) {
      const warn = document.createElement("p");
      warn.className = "con-summary-note";
      warn.textContent = "Add your eBay auth token in Settings before verifying or posting.";
      postSection.appendChild(warn);
    }
    const actions = document.createElement("div");
    actions.className = "ebay-card-actions";

    const verifyBtn = document.createElement("button");
    verifyBtn.className = "ebay-verify-btn";
    verifyBtn.textContent = "Verify with eBay";
    verifyBtn.title = "Validates the listing with eBay's VerifyAddItem call — does NOT publish anything";
    verifyBtn.addEventListener("click", () => handlePostOrVerify(listing, false));
    actions.appendChild(verifyBtn);

    const postBtn = document.createElement("button");
    postBtn.className = "ebay-post-btn";
    postBtn.textContent = "Post Live";
    postBtn.title = "Publishes a real, public eBay listing";
    postBtn.addEventListener("click", () => handlePostOrVerify(listing, true));
    actions.appendChild(postBtn);

    postSection.appendChild(actions);
  }
  body.appendChild(postSection);
}

function addPhotoFiles(listing, files) {
  const room = EBAY_MAX_PHOTOS - 1 - listing.photos.length;
  if (room <= 0) {
    showEbayError(`Already at the ${EBAY_MAX_PHOTOS - 1}-photo limit (the CTT store photo takes the last slot).`);
    return;
  }
  for (const file of files.slice(0, room)) {
    const id = `photo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    photoFilesById.set(id, file);
    listing.photos.push({ id, uploadedUrl: "" });
  }
  saveListings();
  renderCard();
}

async function handlePostOrVerify(listing, isRealPost) {
  const settings = getEbaySettings();
  if (!settings.authToken) {
    showEbayError("Add your eBay auth token in Settings first.");
    return;
  }
  if (isRealPost) {
    const confirmed = confirm(
      `This publishes a REAL, public eBay listing for "${listing.name}" at $${listing.price || "0"}. This can't be undone from here. Continue?`
    );
    if (!confirmed) return;
  }
  hideEbayBanner();
  showEbayInfo(isRealPost ? "Posting to eBay…" : "Verifying with eBay…");
  try {
    autofillFromInventory(listing);
    runGeneration(listing);
    const photoUrls = await resolvePhotoUrls(listing, settings.imgbbKey || "");
    const xml = buildEbayXml(listing, photoUrls, settings.authToken, isRealPost ? "AddItemRequest" : "VerifyAddItemRequest");
    const result = await callEbayProxy(xml, isRealPost ? "AddItem" : "VerifyAddItem");
    if (!result.success) {
      showEbayError(`eBay rejected this ${isRealPost ? "listing" : "verify check"}: ${result.message}`);
      saveListings();
      renderEbayRows();
      renderCard();
      return;
    }
    if (isRealPost) {
      listing.status = "Listed";
      listing.ebayItemId = result.itemId;
      showEbayInfo(`Posted! eBay item ${result.itemId}.`);
    } else {
      showEbayInfo("Verified — eBay accepted this listing as valid. Ready to Post Live when you are.");
    }
    saveListings();
    renderEbayRows();
    renderCard();
  } catch (err) {
    showEbayError(`Couldn't reach eBay: ${err.message}`);
  }
}

// ---------- Settings ----------

function bindEbaySettings() {
  const form = document.getElementById("ebay-settings-form");
  document.getElementById("ebay-settings-btn").addEventListener("click", () => {
    const settings = getEbaySettings();
    document.getElementById("ebay-auth-token").value = settings.authToken || "";
    document.getElementById("ebay-imgbb-key").value = settings.imgbbKey || "";
    form.hidden = false;
  });
  document.getElementById("ebay-settings-cancel").addEventListener("click", () => {
    form.hidden = true;
  });
  document.getElementById("ebay-settings-save").addEventListener("click", () => {
    saveEbaySettings({
      authToken: document.getElementById("ebay-auth-token").value.trim(),
      imgbbKey: document.getElementById("ebay-imgbb-key").value.trim(),
    });
    form.hidden = true;
    hideEbayBanner();
  });
}

function bindEbayToolbar() {
  document.getElementById("ebay-clear-posted-btn").addEventListener("click", () => {
    const postedCount = listings.filter((l) => l.status === "Listed").length;
    if (!postedCount) {
      showEbayInfo("No posted listings to clear.");
      return;
    }
    if (!confirm(`Remove ${postedCount} posted listing${postedCount === 1 ? "" : "s"} from this list? Their live eBay listings are untouched.`)) return;
    listings = listings.filter((l) => l.status !== "Listed");
    saveListings();
    renderEbayRows();
  });
  document.getElementById("ebay-card-close").addEventListener("click", closeListingCard);
  document.getElementById("ebay-card-overlay").addEventListener("click", (e) => {
    if (e.target.id === "ebay-card-overlay") closeListingCard();
  });
}

function initEbay() {
  loadListings();
  buildEbayHeaderEl();
  buildEbayAddRowEl();
  bindEbaySettings();
  bindEbayToolbar();
  renderEbayRows();
}
