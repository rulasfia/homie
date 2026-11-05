import { DEFAULT_THEME, type Theme } from "../shared/themes.ts";

// Each theme's stylesheet is its own chunk, so a page downloads only the configured one.
const themeStyles = {
  aqua: () => import("./styles/themes/aqua.css"),
  metal: () => import("./styles/themes/metal.css"),
} satisfies Record<Theme, () => Promise<unknown>>;

let loaded: { theme: Theme; ready: Promise<void> } | undefined;

/**
 * Loads the stylesheet for `theme` (default aqua) and resolves once it applies,
 * so callers can render without a flash of unstyled content. It also resolves
 * when the chunk fails to load, leaving the page usable without styles.
 * Two themes' rules would collide, so once one is on the page a different one
 * reloads the page; save the new config first so the reload boots with it.
 */
export function loadThemeStyles(theme: Theme = DEFAULT_THEME) {
  if (loaded === undefined) {
    loaded = {
      theme,
      ready: themeStyles[theme]().then(
        () => undefined,
        () => undefined,
      ),
    };
    if (theme === "aqua") followPointerOnTiles();
  } else if (loaded.theme !== theme) {
    location.reload();
  }
  return loaded.ready;
}

/** Feeds the pointer position to aqua's tile glow as --x/--y. Only writes while a mouse moves. */
function followPointerOnTiles() {
  document.addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerType !== "mouse" || !(event.target instanceof Element)) return;
      const tile = event.target.closest<HTMLElement>(".service");
      if (!tile) return;
      const box = tile.getBoundingClientRect();
      tile.style.setProperty("--x", `${event.clientX - box.left}px`);
      tile.style.setProperty("--y", `${event.clientY - box.top}px`);
    },
    { passive: true },
  );
}

const THEME_KEY = "homie:theme";
const nextTheme = { auto: "light", light: "dark", dark: "auto" } as const;

function loadTheme(): keyof typeof nextTheme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    // Keep the switcher usable when browser storage is unavailable.
  }
  return "auto";
}

/** Light/dark/auto switcher. Call after loadThemeStyles so the browser chrome color comes from the loaded theme. */
export function initThemeSwitcher(button: HTMLButtonElement) {
  let theme = loadTheme();
  const systemTheme = matchMedia("(prefers-color-scheme: light)");

  function applyTheme() {
    const resolved = theme === "auto" ? (systemTheme.matches ? "light" : "dark") : theme;
    const root = document.documentElement;
    root.dataset.theme = resolved;
    const chrome = getComputedStyle(root).getPropertyValue("--color-chassis").trim();
    if (chrome) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", chrome);

    button.textContent = theme;
    const label = `Theme: ${theme}. Switch to ${nextTheme[theme]} theme`;
    button.setAttribute("aria-label", label);
    button.title = label;
  }

  button.addEventListener("click", () => {
    theme = nextTheme[theme];
    applyTheme();
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // The selected theme still works for this page without persistence.
    }
  });
  systemTheme.addEventListener("change", () => {
    if (theme === "auto") applyTheme();
  });
  applyTheme();
}
