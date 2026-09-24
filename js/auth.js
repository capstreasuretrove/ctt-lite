// CTT Lite — simple password gate
//
// Not real security (the password check runs client-side and the "secret"
// ships in config.js) — this exists only to keep the tool from being
// stumbled into, matching the existing admin-mode pattern on the main site.
// The actual write protection is that nobody else has these Apps Script URLs.

const AUTH_STORAGE_KEY = "ctt-lite-authed";

function isAuthed() {
  return localStorage.getItem(AUTH_STORAGE_KEY) === "yes";
}

function setAuthed() {
  localStorage.setItem(AUTH_STORAGE_KEY, "yes");
}

function initAuthGate() {
  const gate = document.getElementById("auth-gate");
  const app = document.getElementById("app");
  const form = document.getElementById("auth-form");
  const input = document.getElementById("auth-password");
  const error = document.getElementById("auth-error");

  if (isAuthed()) {
    gate.hidden = true;
    app.hidden = false;
    return;
  }

  gate.hidden = false;
  app.hidden = true;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (input.value === CONFIG.AUTH_PASSWORD) {
      setAuthed();
      gate.hidden = true;
      app.hidden = false;
      onAuthed();
    } else {
      error.hidden = false;
      input.value = "";
      input.focus();
    }
  });
}
