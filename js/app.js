// CTT Lite — app shell: tab switching + boot sequence

function initTabs() {
  const buttons = document.querySelectorAll(".tab-btn");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      buttons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });
}

// Called once, right after a successful password entry (or immediately on
// load if already authed this browser). This is where each module's real
// init/data-load happens — deliberately not run before auth passes.
function onAuthed() {
  initTabs();
  initInventory();
}

document.addEventListener("DOMContentLoaded", () => {
  initAuthGate();
  if (isAuthed()) onAuthed();
});
