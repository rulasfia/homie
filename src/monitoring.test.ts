import { expect, it } from "vite-plus/test";
import type { SystemStatus } from "../shared/types.ts";
import { initialSystemsView, nextSystemsView } from "./monitoring.ts";

it("sorts machines by name", () => {
  const systems = ["nas", "Alpha", "beta"].map((name) => ({ name }) as SystemStatus);
  const view = nextSystemsView(initialSystemsView, {
    ok: true,
    value: { configured: true, systems },
  });
  expect(view.systems.map((s) => s.name)).toEqual(["Alpha", "beta", "nas"]);
});
