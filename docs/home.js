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

  for (const atlas of document.querySelectorAll(".atlas[data-gallery]")) {
    const tabs = atlas.querySelector(".atlas-tabs");
    const buttons = [...tabs.querySelectorAll("button[data-pane]")];
    const panes = buttons.map((button) => document.getElementById(button.dataset.pane));
    if (!buttons.length || !panes.every((pane) => pane && atlas.contains(pane))) continue;
    tabs.setAttribute("role", "tablist");
    buttons.forEach((button, index) => {
      const pane = panes[index];
      button.id ||= pane.id + "-tab";
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", pane.id);
      pane.setAttribute("role", "tabpanel");
      pane.setAttribute("aria-labelledby", button.id);
      pane.tabIndex = 0;
      button.addEventListener("click", () => select(index));
      button.addEventListener("keydown", (event) => {
        let target;
        if (event.key === "ArrowLeft") target = (index + buttons.length - 1) % buttons.length;
        else if (event.key === "ArrowRight") target = (index + 1) % buttons.length;
        else if (event.key === "Home") target = 0;
        else if (event.key === "End") target = buttons.length - 1;
        else return;
        event.preventDefault();
        select(target);
        buttons[target].focus();
      });
    });
    function select(current) {
      buttons.forEach((button, i) => {
        const selected = i === current;
        button.tabIndex = selected ? 0 : -1;
        button.setAttribute("aria-selected", String(selected));
        panes[i].hidden = !selected;
        panes[i].classList.toggle("is-current", selected);
      });
    }
    function selectFragment() {
      const index = panes.findIndex((pane) => "#" + pane.id === location.hash);
      if (index >= 0) select(index);
    }
    select(0);
    selectFragment();
    window.addEventListener("hashchange", selectFragment);
    tabs.hidden = false;
  }

  for (const comparison of document.querySelectorAll(".appearance-compare[data-compare]")) {
    const slider = comparison.querySelector('input[type="range"]');
    if (!slider) continue;
    function updateSplit() {
      const percent = slider.valueAsNumber;
      comparison.style.setProperty("--split", percent + "%");
      slider.setAttribute("aria-valuetext", "浅色画面占 " + percent + "%");
    }
    slider.addEventListener("input", updateSplit);
    updateSplit();
    comparison.classList.add("is-interactive");
    slider.hidden = false;
  }

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (typeof IntersectionObserver === "function" && typeof reduced.addEventListener === "function") {
    const targets = [...document.querySelectorAll("[data-reveal]")];
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    }, { rootMargin: "0px 0px -3% 0px" });
    function setReveals() {
      root.classList.toggle("reveal-on", !reduced.matches);
      observer.disconnect();
      for (const element of targets) {
        if (reduced.matches) element.classList.add("is-visible");
        else if (!element.classList.contains("is-visible")) observer.observe(element);
      }
    }
    reduced.addEventListener("change", setReveals);
    setReveals();
  }

  const motion = window.matchMedia("(min-width: 900px) and (min-height: 580px) and (prefers-reduced-motion: no-preference)");
  const precisePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
  const hero = document.querySelector(".hero");
  const heroScreen = hero.querySelector(".hero-screen");
  const tour = document.querySelector(".tour-stage");
  const stack = tour.querySelector(".stage-stack");
  const indexLinks = [...tour.querySelectorAll(".scene-index a")];
  const scenes = [...document.querySelectorAll(".scene")];
  const meter = document.querySelector(".reading-meter i");
  let pageLength;
  let readingProgress = "";
  let shots = [];
  let activeScene = -1;
  let heroProgress = "";
  let sceneProgress = "";
  let geometry;
  let pointer;
  let aim = "";
  let frame = 0;

  const clamp = (number) => Math.min(1, Math.max(0, number));

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

  // Cache document-space positions. Scrolling only needs the current offset.
  function measure(scroll) {
    const heroRect = hero.getBoundingClientRect();
    const screenRect = heroScreen.parentElement.getBoundingClientRect();
    const rows = scenes.map((scene) => {
      const rect = scene.getBoundingClientRect();
      return { top: rect.top + scroll, height: rect.height };
    });
    return {
      heroTop: heroRect.top + scroll,
      heroHeight: heroRect.height,
      screenTop: screenRect.top + scroll,
      screenLeft: screenRect.left,
      screenWidth: screenRect.width,
      screenHeight: screenRect.height,
      threshold: window.innerHeight * .55,
      rows,
    };
  }

  function draw() {
    frame = 0;
    const scroll = window.scrollY;
    if (motion.matches) geometry ??= measure(scroll);
    if (meter) {
      pageLength ??= Math.max(1, root.scrollHeight - window.innerHeight);
      const value = clamp(scroll / pageLength).toFixed(4);
      if (value !== readingProgress) {
        readingProgress = value;
        meter.style.transform = "scaleX(" + value + ")";
      }
    }
    if (!motion.matches) return;
    const progress = clamp((scroll - geometry.heroTop) / geometry.heroHeight);
    const rounded = progress.toFixed(4);
    if (rounded !== heroProgress) {
      heroProgress = rounded;
      hero.style.setProperty("--hero-progress", rounded);
      hero.style.setProperty("--shot-y", (-36 * progress).toFixed(2) + "px");
      hero.style.setProperty("--shot-angle", (-7 * (1 - progress)).toFixed(2) + "deg");
      hero.style.setProperty("--shot-pitch", (6 * (1 - progress)).toFixed(2) + "deg");
    }

    let yaw = 0;
    let pitch = 0;
    if (pointer && progress < 1) {
      yaw = (clamp((pointer.x - geometry.screenLeft) / geometry.screenWidth) * 2 - 1) * 2;
      pitch = (1 - clamp((pointer.y + scroll - geometry.screenTop) / geometry.screenHeight) * 2) * 1.4;
    }
    const tilt = yaw.toFixed(2) + "/" + pitch.toFixed(2);
    if (tilt !== aim) {
      aim = tilt;
      heroScreen.style.setProperty("--aim-x", pitch.toFixed(2) + "deg");
      heroScreen.style.setProperty("--aim-y", yaw.toFixed(2) + "deg");
    }

    const cursor = scroll + geometry.threshold;
    const next = geometry.rows.findIndex((row) => row.top > cursor);
    const index = next < 0 ? scenes.length - 1 : Math.max(0, next - 1);
    selectScene(index);
    const row = geometry.rows[index];
    const end = geometry.rows[index + 1]?.top ?? row.top + row.height;
    const value = clamp((cursor - row.top) / Math.max(1, end - row.top)).toFixed(4);
    if (value !== sceneProgress) {
      sceneProgress = value;
      tour.style.setProperty("--scene-progress", value);
    }
  }

  function schedule() {
    if ((meter || motion.matches) && !frame) frame = requestAnimationFrame(draw);
  }
  function invalidate() {
    geometry = null;
    pageLength = null;
    schedule();
  }
  function movePointer(event) {
    if (event.pointerType === "touch" || !precisePointer.matches) return;
    pointer = { x: event.clientX, y: event.clientY };
    schedule();
  }
  function resetPointer() {
    pointer = null;
    schedule();
  }

  const dimensions = typeof ResizeObserver === "function" ? new ResizeObserver(invalidate) : null;
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
      for (const element of [hero, ...scenes]) dimensions?.observe(element);
      window.addEventListener("blur", resetPointer);
      heroScreen.addEventListener("pointermove", movePointer, { passive: true });
      heroScreen.addEventListener("pointerleave", resetPointer);
      heroScreen.addEventListener("pointercancel", resetPointer);
      invalidate();
    } else {
      for (const element of [hero, ...scenes]) dimensions?.unobserve(element);
      window.removeEventListener("blur", resetPointer);
      heroScreen.removeEventListener("pointermove", movePointer);
      heroScreen.removeEventListener("pointerleave", resetPointer);
      heroScreen.removeEventListener("pointercancel", resetPointer);
      cancelAnimationFrame(frame);
      frame = 0;
      pointer = null;
      aim = "";
      heroScreen.style.removeProperty("--aim-x");
      heroScreen.style.removeProperty("--aim-y");
      invalidate();
    }
  }

  dimensions?.observe(document.body);
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", invalidate);
  schedule();
  if (typeof motion.addEventListener === "function") {
    motion.addEventListener("change", setMotion);
    setMotion();
  }
})();
