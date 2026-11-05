import { afterEach, expect, it, vi } from "vite-plus/test";
import { initThemeSwitcher } from "./theme.ts";

vi.mock("./styles/themes/aqua.css", () => ({}));
vi.mock("./styles/themes/metal.css", () => ({}));

afterEach(() => vi.unstubAllGlobals());

function setup(saved: string | null = null, light = false) {
  const root = { dataset: { theme: "" } };
  const meta = { setAttribute: vi.fn() };
  const storage = { getItem: vi.fn(() => saved), setItem: vi.fn() };
  const system = Object.assign(new EventTarget(), { matches: light });
  const button = Object.assign(new EventTarget(), {
    textContent: "",
    title: "",
    setAttribute: vi.fn(),
  });
  vi.stubGlobal("document", { documentElement: root, querySelector: () => meta });
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("matchMedia", () => system);
  // The loaded theme's chassis color per mode, as the browser chrome color.
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: () => (root.dataset.theme === "light" ? " #d6e3f1" : " #041021"),
  }));

  const init = () => initThemeSwitcher(button as unknown as HTMLButtonElement);
  const click = () => button.dispatchEvent(new Event("click"));
  return { root, meta, storage, system, button, init, click };
}

it.each([null, "auto", "invalid", "light", "dark"])("restores saved preference %s", (saved) => {
  const { init, root, button } = setup(saved, true);
  init();
  expect(button.textContent).toBe(saved === "light" || saved === "dark" ? saved : "auto");
  expect(root.dataset.theme).toBe(saved === "dark" ? "dark" : "light");
});

it("cycles auto → light → dark → auto and persists each selection", () => {
  const { init, click, root, button, storage, meta } = setup();
  init();
  expect(root.dataset.theme).toBe("dark");

  for (const [theme, resolved, next] of [
    ["light", "light", "dark"],
    ["dark", "dark", "auto"],
    ["auto", "dark", "light"],
  ]) {
    click();
    expect(button.textContent).toBe(theme);
    expect(root.dataset.theme).toBe(resolved);
    expect(storage.setItem).toHaveBeenLastCalledWith("homie:theme", theme);
    expect(button.setAttribute).toHaveBeenLastCalledWith(
      "aria-label",
      `Theme: ${theme}. Switch to ${next} theme`,
    );
    expect(meta.setAttribute).toHaveBeenLastCalledWith(
      "content",
      resolved === "light" ? "#d6e3f1" : "#041021",
    );
  }
});

it("follows system changes only in auto mode", () => {
  const { init, click, root, system } = setup();
  init();
  system.matches = true;
  system.dispatchEvent(new Event("change"));
  expect(root.dataset.theme).toBe("light");

  click();
  system.matches = false;
  system.dispatchEvent(new Event("change"));
  expect(root.dataset.theme).toBe("light");

  click();
  system.matches = true;
  system.dispatchEvent(new Event("change"));
  expect(root.dataset.theme).toBe("dark");

  click();
  expect(root.dataset.theme).toBe("light");
});

it("works when browser storage is unavailable", () => {
  const { init, click, root, button, storage } = setup();
  storage.getItem.mockImplementation(() => {
    throw new Error("Storage blocked");
  });
  storage.setItem.mockImplementation(() => {
    throw new Error("Storage blocked");
  });
  init();
  expect(button.textContent).toBe("auto");
  click();
  expect(button.textContent).toBe("light");
  expect(root.dataset.theme).toBe("light");
});

it("loads one theme stylesheet and reloads when the config switches to another", async () => {
  vi.resetModules();
  const { loadThemeStyles } = await import("./theme.ts");
  const reload = vi.fn();
  vi.stubGlobal("location", { reload });

  await loadThemeStyles("metal");
  await loadThemeStyles("metal");
  expect(reload).not.toHaveBeenCalled();

  await loadThemeStyles("aqua");
  expect(reload).toHaveBeenCalledOnce();
});
