// CTT Lite — configuration
//
// Fill these in before deploying. Nothing else in the app needs editing to
// get Inventory working — just these two values.
//
// INVENTORY_SCRIPT_URL: the deployed Google Apps Script Web App URL that
// already serves the desktop app / original site's Inventory actions
// (getInventory / addInventoryItems / updateInventoryItems / deleteInventoryItems).
// It looks like: https://script.google.com/macros/s/AKfycb.../exec
//
// AUTH_PASSWORD: whatever you want this private tool gated behind. Stored
// only in your browser's localStorage after a correct entry — this is a
// simple gate, not real security, matching the existing admin-mode pattern.

const CONFIG = {
  INVENTORY_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbxtNC4c1MOI0hzNXk81fd6zFelyVuDtqhRlC9aOpaIZ_iMqwDjjP1bZGYJILoEMmIPv/exec",
  CONSIGNMENT_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbzAi6H8glGOGq0-y9DJS8tMj6umtp1hJLDxqZ3TRUeRHJaBBxttijcYJ6B_upywHqsi/exec",
  CONSIGNMENT_SUMMARY_SHEET_ID: "1gMnjS1cCvc_Rv_mZrK3JdMxLHnc5byV4EJ1zqgIZGf8",
  AUTH_PASSWORD: "4141",
  // eBay's Trading API needs an auth token and imgBB needs an API key —
  // both entered via the eBay tab's Settings panel and kept only in this
  // browser's localStorage (see js/ebay.js). Nothing to fill in here.
  EBAY_PROXY_URL: "/.netlify/functions/ebay-proxy",
  CTT_STORE_PHOTO_DRIVE_ID: "1RxxPvmVJ4bQlGtG3TWkaqx22VFAYOOwZ",
  // Calendar tab — read-only, no Apps Script needed (same link-shared gviz
  // technique as the Consignment summary tab). CALENDAR_TAB_GID picks the
  // "Schedule" tab specifically, in case this spreadsheet ever grows more
  // tabs (gid is stable even if the tab is renamed; a sheet name isn't).
  CALENDAR_SHEET_ID: "1mb8i23IzL-6dYh3Qz3roJaz5_0pLtiw7cFGCVLzqyPU",
  CALENDAR_TAB_GID: "1533121598",
};
