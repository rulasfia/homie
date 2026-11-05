import { expect, it } from "vite-plus/test";
import { weatherHtml } from "./weather.ts";

const report = {
  location: "Home",
  unit: "f" as const,
  fetchedAt: "2026-11-05T12:00:00Z",
  current: { temp: 59.4, feelsLike: 61, humidity: 76, wind: 1, code: 0, isDay: false },
  days: [{ date: "2026-11-05", code: 80, max: 73, min: 55 }],
};

it("shows a static placeholder in the loaded layout until the first report", () => {
  const html = weatherHtml({ configured: true });
  expect(html).toContain("Loading weather");
  expect(html).toContain('class="weather-days"');
  expect(html.match(/class="weather-day"/g)).toHaveLength(5);
  expect(html).toContain("Open-Meteo");
});

it("renders the report, a failed update, and a place that was not found", () => {
  const html = weatherHtml({ configured: true, report });
  expect(html).toContain("°F");
  expect(html).toContain("1 mph");
  expect(html).toContain("🌙");
  expect(html).not.toContain("Rain</dt>");
  expect(weatherHtml({ configured: true, report, stale: true, error: "unavailable" })).toContain(
    "Update failed",
  );
  expect(weatherHtml({ configured: true, error: "not-found" })).toContain("Location not found");
});
