(() => {
  const root = document.documentElement;
  const themeToggle = document.getElementById("themeToggle");
  const themeKey = "pi-studio-theme";
  function applyTheme(theme) {
    root.dataset.theme = theme;
    const dark = theme === "dark";
    themeToggle.textContent = dark ? "◑" : "◐";
    themeToggle.setAttribute("aria-label", dark ? "切换到浅色" : "切换到深色");
  }

  try {
    applyTheme(localStorage.getItem(themeKey) === "dark" ? "dark" : "light");
  } catch {
    applyTheme("light");
  }
  themeToggle.hidden = false;
  themeToggle.addEventListener("click", () => {
    applyTheme(root.dataset.theme === "dark" ? "light" : "dark");
    try {
      localStorage.setItem(themeKey, root.dataset.theme);
    } catch {
      // The current page can still switch themes when storage is unavailable.
    }
  });

  const preview = document.getElementById("preview");
  const previewImage = preview.querySelector("img");
  const previewLabel = document.getElementById("preview-label");
  const originalImage = preview.querySelector(".original-image");
  let returnFocus;
  if (typeof preview.showModal === "function") {
    document.addEventListener("click", (event) => {
      const link = event.target.closest("a.shot-link");
      if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
      event.preventDefault();
      returnFocus = link;
      const sourceImage = link.querySelector("img") || link.closest("figure")?.querySelector("img");
      previewLabel.textContent = sourceImage?.alt || "界面截图";
      previewImage.src = link.href;
      originalImage.href = link.href;
      preview.showModal();
    });
    preview.querySelector("button").addEventListener("click", () => preview.close());
    preview.addEventListener("click", (event) => {
      if (event.target === preview) {
        const rect = preview.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientY < rect.top || event.clientX > rect.right || event.clientY > rect.bottom) preview.close();
      }
    });
    preview.addEventListener("close", () => {
      returnFocus?.focus({ preventScroll: true });
      previewImage.removeAttribute("src");
    });
  }

  const motion = window.matchMedia("(min-width: 900px) and (min-height: 580px) and (prefers-reduced-motion: no-preference)");
  const hero = document.querySelector(".hero");
  const tour = document.querySelector(".tour-stage");
  const stack = tour.querySelector(".stage-stack");
  const indexLinks = [...tour.querySelectorAll(".scene-index a")];
  const scenes = [...document.querySelectorAll(".scene")];
  let shots = [];
  let activeScene = -1;
  let frame = 0;

  function selectScene(index) {
    if (activeScene === index) return;
    activeScene = index;
    shots.forEach((link, i) => {
      link.classList.toggle("is-revealed", i <= index);
      link.inert = i !== index;
      if (i === index) indexLinks[i].setAttribute("aria-current", "step");
      else indexLinks[i].removeAttribute("aria-current");
    });
  }

  function draw() {
    frame = 0;
    const heroRect = hero.getBoundingClientRect();
    const threshold = window.innerHeight * .55;
    const next = scenes.findIndex((scene) => scene.getBoundingClientRect().top > threshold);
    const progress = Math.min(1, Math.max(0, -heroRect.top / heroRect.height));
    hero.style.setProperty("--ambient-y", (progress * 62).toFixed(1) + "px");
    hero.style.setProperty("--shot-y", (progress * -42).toFixed(1) + "px");
    hero.style.setProperty("--shot-angle", ((1 - progress) * -7).toFixed(2) + "deg");
    hero.style.setProperty("--shot-pitch", ((1 - progress) * 2).toFixed(2) + "deg");
    selectScene(next < 0 ? scenes.length - 1 : Math.max(0, next - 1));
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(draw);
  }

  function setMotion() {
    root.classList.toggle("motion-on", motion.matches);
    tour.hidden = !motion.matches;
    if (motion.matches) {
      if (!shots.length) {
        shots = scenes.map((scene) => {
          const link = scene.querySelector(".scene-shot").cloneNode(true);
          link.className = "stage-shot shot-link";
          stack.append(link);
          return link;
        });
      }
      window.addEventListener("scroll", schedule, { passive: true });
      window.addEventListener("resize", schedule);
      draw();
    } else {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
      frame = 0;
    }
  }

  if (typeof motion.addEventListener === "function") {
    motion.addEventListener("change", setMotion);
    setMotion();
  }
})();
