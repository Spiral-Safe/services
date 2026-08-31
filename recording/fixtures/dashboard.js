const panels = [...document.querySelectorAll("[data-panel]")];
const navigation = [...document.querySelectorAll("[data-show]")];
const toast = document.querySelector(".toast");

for (const button of navigation) {
  button.addEventListener("click", () => {
    const selected = button.dataset.show;
    for (const panel of panels) panel.hidden = panel.dataset.panel !== selected;
    for (const candidate of navigation) {
      if (candidate.dataset.show === selected)
        candidate.setAttribute("aria-current", "page");
      else candidate.removeAttribute("aria-current");
    }
  });
}

for (const button of document.querySelectorAll("[data-fixture-action]")) {
  button.addEventListener("click", () => {
    toast.textContent = button.dataset.fixtureAction;
    toast.classList.add("visible");
    window.setTimeout(() => toast.classList.remove("visible"), 2200);
  });
}

window.__SPIRAL_RECORDING_FIXTURE__ = true;
