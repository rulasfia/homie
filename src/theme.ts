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

export function initThemeSwitcher(button: HTMLButtonElement) {
  let theme = loadTheme();
  const systemTheme = matchMedia("(prefers-color-scheme: light)");

  function applyTheme() {
    const resolved = theme === "auto" ? (systemTheme.matches ? "light" : "dark") : theme;
    document.documentElement.dataset.theme = resolved;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", resolved === "light" ? "#f4f5f7" : "#0d1117");

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
