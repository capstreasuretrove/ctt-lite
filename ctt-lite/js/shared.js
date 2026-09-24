// CTT Lite — shared helpers used by every module

/**
 * POST a JSON action body to a Google Apps Script Web App.
 *
 * Sent as text/plain;charset=utf-8 (not application/json) deliberately —
 * this avoids a CORS preflight OPTIONS request, which Apps Script Web Apps
 * generally don't answer. The script itself still parses the body as JSON
 * (e.new JSON.parse(e.postData.contents)).
 *
 * @param {string} url - the deployed Apps Script Web App URL
 * @param {object} body - e.g. { action: "getInventory" }
 * @returns {Promise<object>} the parsed { ok, ... } response
 */
async function postToAppsScript(url, body) {
  if (!url || url.startsWith("PASTE_")) {
    throw new Error(
      "This Apps Script Web App URL hasn't been configured yet — fill it in in js/config.js."
    );
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Apps Script call failed: HTTP ${res.status}`);
  }
  let json;
  try {
    json = await res.json();
  } catch (err) {
    throw new Error("Apps Script response wasn't valid JSON — check the deployed script.");
  }
  if (json && json.ok === false) {
    throw new Error(json.error || "Apps Script reported an error with no message.");
  }
  return json;
}

/**
 * Rewrite a Google Drive "view" URL (https://drive.google.com/file/d/{id}/view...)
 * into a directly-renderable thumbnail URL. Raw Drive view-page URLs are an
 * HTML viewer, not image bytes, and won't work in an <img src>.
 */
function toDriveThumbnail(url) {
  if (!url) return url;
  const match = url.match(/\/file\/d\/([^/]+)\//);
  if (!match) return url;
  return `https://drive.google.com/thumbnail?id=${match[1]}&sz=w800`;
}

/** Small debounce helper — used for the add-row "save as you type" behavior. */
function debounce(fn, wait) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

/** Escape text for safe insertion into innerHTML. */
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Distinct, sorted, non-empty values for a given key across a list of objects. */
function distinctValues(items, key) {
  const set = new Set();
  for (const item of items) {
    const v = item[key];
    if (v !== undefined && v !== null && String(v).trim() !== "") set.add(String(v));
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}
