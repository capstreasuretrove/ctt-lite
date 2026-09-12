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
  CONSIGNMENT_SCRIPT_URL: "PASTE_CONSIGNMENT_APPS_SCRIPT_WEB_APP_URL_HERE",
  CONSIGNMENT_SUMMARY_SHEET_ID: "1gMnjS1cCvc_Rv_mZrK3JdMxLHnc5byV4EJ1zqgIZGf8",
  AUTH_PASSWORD: "4141",
};
