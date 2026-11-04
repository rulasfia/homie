import { expect, it } from "vite-plus/test";

import { summarizeChecks } from "./readout.ts";

it("stays blank when no services are pinged", () => {
  expect(summarizeChecks([])).toEqual({ status: null, text: "" });
});

it("reports checking while any result is outstanding", () => {
  expect(summarizeChecks(["up", "pending", "down"])).toEqual({
    status: "pending",
    text: "checking 3 services",
  });
});

it("is up only when every check answers", () => {
  expect(summarizeChecks(["up", "up"])).toEqual({ status: "up", text: "2/2 services up" });
});

it("is down when any check fails", () => {
  expect(summarizeChecks(["up", "down", undefined])).toEqual({
    status: "down",
    text: "1/3 services up",
  });
});
