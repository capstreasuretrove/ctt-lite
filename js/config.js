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
  // Booth Layouts — its own Apps Script Web App over the "CTT - Booth Layouts" sheet.
  LAYOUTS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbzh8HIVjbnqnPD87WYmSSUwXEn6bfF21PzNB4GMe_YLLbmM3ALsGMh28VsMAsmUdHPY/exec",
  LAYOUTS_SHEET_ID: "1a61_luAQjK9Wsy-NbJisdFA-P_5YLYaIxL_r4paFm6o",
  AUTH_PASSWORD: "4141",
  // eBay's Trading API needs an auth token and imgBB needs an API key —
  // both entered via the eBay tab's Settings panel and kept only in this
  // browser's localStorage (see js/ebay.js). Nothing to fill in here.
  EBAY_PROXY_URL: "/.netlify/functions/ebay-proxy",
  CTT_STORE_PHOTO_DRIVE_ID: "1RxxPvmVJ4bQlGtG3TWkaqx22VFAYOOwZ",
};
