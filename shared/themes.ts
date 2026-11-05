/** Dashboard themes, picked with `theme` in the config. Each one is a stylesheet in src/styles/themes/. */
export const THEMES = ["aqua", "metal"] as const;

export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = "aqua";

export function isTheme(value: unknown): value is Theme {
  return THEMES.some((theme) => theme === value);
}
