import { expect, it } from "vite-plus/test";
import { formatByteRate, formatByteSize, formatContainerMetrics } from "./container-metrics.ts";

it("formats byte amounts with binary units", () => {
  expect(formatByteSize(0)).toBe("0 B");
  expect(formatByteSize(1024)).toBe("1 KiB");
  expect(formatByteSize(1536)).toBe("1.5 KiB");
  expect(formatByteSize(512 * 1024 * 1024)).toBe("512 MiB");
  expect(formatByteSize(5 * 1024 ** 3)).toBe("5 GiB");
});

it("formats network rates separately from absolute byte totals", () => {
  expect(formatByteRate(1536)).toBe("1.5 KiB/s");
  expect(formatByteRate(2.5 * 1024 ** 2)).toBe("2.5 MiB/s");
  expect(formatByteRate(undefined)).toBeUndefined();
});

it("renders the full remote container metric line", () => {
  expect(
    formatContainerMetrics({
      cpuPct: 12.5,
      memBytes: 512 * 1024 * 1024,
      netSentBps: 1536,
      netRecvBps: 2.5 * 1024 ** 2,
    }),
  ).toBe("cpu 13% · mem 512 MiB · net ↑ 1.5 KiB/s ↓ 2.5 MiB/s");
});

it("keeps real zero metrics visible", () => {
  expect(formatContainerMetrics({ cpuPct: 0, memBytes: 0, netSentBps: 0, netRecvBps: 0 })).toBe(
    "cpu 0% · mem 0 B · net ↑ 0 B/s ↓ 0 B/s",
  );
});

it("omits unknown or malformed metrics instead of showing zero", () => {
  expect(formatContainerMetrics({})).toBe("");
  expect(
    formatContainerMetrics({
      cpuPct: Number.NaN,
      memBytes: -1,
      netSentBps: Number.POSITIVE_INFINITY,
      netRecvBps: -5,
    }),
  ).toBe("");
  expect(formatContainerMetrics({ netSentBps: 100 })).toBe("net ↑ 100 B/s");
});
