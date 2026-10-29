(function () {
  const root = document.documentElement;
  const body = document.body;
  const themeKey = "pi-studio-theme";
  const themeToggle = document.getElementById("themeToggle");
  const menuToggle = document.getElementById("menuToggle");
  const sidebarScrim = document.getElementById("sidebarScrim");
  const searchInput = document.getElementById("docsSearch");
  const searchEmpty = document.getElementById("searchEmpty");
  const navItems = Array.from(document.querySelectorAll(".nav-group li[data-search]"));
  const sections = Array.from(document.querySelectorAll(".doc-section[id]"));
  const navLinks = Array.from(document.querySelectorAll('.nav-group a[href^="#"]'));
  const progress = document.getElementById("readingProgress");
  const backTop = document.getElementById("backTop");

  function applyTheme(theme) {
    root.dataset.theme = theme;
    if (themeToggle) {
      themeToggle.textContent = theme === "dark" ? "◑" : "◐";
      themeToggle.title = theme === "dark" ? "切换到浅色" : "切换到深色";
      themeToggle.setAttribute("aria-label", themeToggle.title);
    }
    try {
      localStorage.setItem(themeKey, theme);
    } catch (_) {
      // Local storage can be unavailable in hardened browser contexts.
    }
  }

  let savedTheme = null;
  try {
    savedTheme = localStorage.getItem(themeKey);
  } catch (_) {
    // Fall back to light when storage is unavailable.
  }
  applyTheme(savedTheme === "dark" ? "dark" : "light");
  themeToggle?.addEventListener("click", () => {
    applyTheme(root.dataset.theme === "dark" ? "light" : "dark");
  });

  function closeSidebar() {
    body.classList.remove("sidebar-open");
    menuToggle?.setAttribute("aria-expanded", "false");
  }

  menuToggle?.addEventListener("click", () => {
    const open = !body.classList.contains("sidebar-open");
    body.classList.toggle("sidebar-open", open);
    menuToggle.setAttribute("aria-expanded", String(open));
  });
  sidebarScrim?.addEventListener("click", closeSidebar);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeSidebar();
    }
    const target = event.target;
    const typing = target instanceof HTMLElement
      && (target.matches("input, textarea, select") || target.isContentEditable);
    if (!typing && (event.key === "/" || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k"))) {
      event.preventDefault();
      searchInput?.focus();
      body.classList.add("sidebar-open");
      menuToggle?.setAttribute("aria-expanded", "true");
    }
  });

  function normalize(value) {
    return String(value || "").trim().toLocaleLowerCase("zh-CN");
  }

  searchInput?.addEventListener("input", () => {
    const query = normalize(searchInput.value);
    let visible = 0;
    navItems.forEach((item) => {
      const matched = !query || normalize(item.dataset.search).includes(query);
      item.classList.toggle("is-filtered", !matched);
      if (matched) visible += 1;
    });
    searchEmpty?.classList.toggle("is-visible", visible === 0);
    document.querySelectorAll(".nav-group").forEach((group) => {
      const hasVisibleItem = Array.from(group.querySelectorAll("li[data-search]"))
        .some((item) => !item.classList.contains("is-filtered"));
      group.hidden = !hasVisibleItem;
    });
  });

  function setActive(id) {
    navLinks.forEach((link) => {
      link.classList.toggle("is-active", link.getAttribute("href") === `#${id}`);
      if (link.classList.contains("is-active")) {
        link.setAttribute("aria-current", "location");
      } else {
        link.removeAttribute("aria-current");
      }
    });
  }

  const sectionObserver = new IntersectionObserver((entries) => {
    const visible = entries
      .filter((entry) => entry.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
    if (visible[0]) setActive(visible[0].target.id);
  }, {
    rootMargin: "-15% 0px -68% 0px",
    threshold: [0, 0.2, 0.55],
  });
  sections.forEach((section) => sectionObserver.observe(section));

  function updateScrollUi() {
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    const percent = scrollable <= 0 ? 0 : Math.min(100, Math.max(0, (scrollTop / scrollable) * 100));
    if (progress) progress.style.setProperty("--reading-progress", `${percent}%`);
    backTop?.classList.toggle("is-visible", scrollTop > 700);
  }
  window.addEventListener("scroll", updateScrollUi, { passive: true });
  window.addEventListener("resize", updateScrollUi);
  updateScrollUi();

  backTop?.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  navLinks.forEach((link) => link.addEventListener("click", closeSidebar));

  document.querySelectorAll(".code-copy").forEach((button) => {
    button.addEventListener("click", async () => {
      const code = button.closest(".code-block")?.querySelector("code")?.textContent || "";
      const original = button.textContent;
      try {
        await navigator.clipboard.writeText(code);
        button.textContent = "已复制";
      } catch (_) {
        const range = document.createRange();
        const selection = window.getSelection();
        const target = button.closest(".code-block")?.querySelector("code");
        if (target && selection) {
          range.selectNodeContents(target);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        button.textContent = "请复制";
      }
      window.setTimeout(() => {
        button.textContent = original;
      }, 1400);
    });
  });

  document.querySelectorAll(".section-heading h2[id]").forEach((heading) => {
    const label = heading.textContent?.trim();
    heading.insertAdjacentHTML(
      "beforeend",
      ` <a class="heading-anchor" href="#${heading.id}" aria-label="复制“${label}”章节链接">#</a>`,
    );
  });

  document.querySelectorAll(".heading-anchor").forEach((anchor) => {
    anchor.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(anchor.href);
      } catch (_) {
        // Setting the fragment in the URL still provides a stable fallback.
      }
    });
  });
})();
