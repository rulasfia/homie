import { expect, it, vi } from "vite-plus/test";
import { WEATHER_FRESH_MS, WeatherCache } from "./weather.ts";

const forecast = {
  current: {
    temperature_2m: 30.6,
    apparent_temperature: 35.2,
    relative_humidity_2m: 70,
    weather_code: 2,
    is_day: 1,
    wind_speed_10m: 11.8,
  },
  daily: {
    time: ["2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09"],
    weather_code: [2, 61, 61, 3, 0],
    temperature_2m_max: [32, 31, 30, 31, 33],
    temperature_2m_min: [25, 24, 24, 25, 25],
    precipitation_probability_max: [40, 80, 70, 20, null],
  },
};
const geocoded = {
  results: [
    { name: "Jakarta", admin1: "Jakarta", country: "Indonesia", latitude: -6.2, longitude: 106.8 },
  ],
};

const href = (input: string | URL | Request) =>
  input instanceof Request ? input.url : input.toString();

function stubOpenMeteo(forecastResponse: () => Response = () => Response.json(forecast)) {
  return vi.fn<typeof fetch>(async (input) =>
    href(input).startsWith("https://geocoding-api.open-meteo.com/")
      ? Response.json(geocoded)
      : forecastResponse(),
  );
}

it("finds the place once, then serves the cached report until it goes stale", async () => {
  let now = Date.parse("2026-11-05T12:00:00Z");
  const fetcher = stubOpenMeteo();
  const cache = new WeatherCache(fetcher, () => now);
  const config = { location: "Jakarta" };

  const first = await cache.get(config);
  expect(first.report).toMatchObject({
    location: "Jakarta",
    place: "Jakarta, Indonesia",
    unit: "c",
    current: { temp: 30.6, isDay: true },
  });
  expect(first.report?.days[4]).toEqual({ date: "2026-11-09", code: 0, max: 33, min: 25 });
  await cache.get(config);
  expect(fetcher).toHaveBeenCalledTimes(2);

  now += WEATHER_FRESH_MS;
  expect((await cache.get(config)).stale).toBeUndefined();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  expect(href(fetcher.mock.calls[2][0])).toContain("api.open-meteo.com/v1/forecast");
});

it("asks for Fahrenheit and mph and skips the search when coordinates are set", async () => {
  const fetcher = stubOpenMeteo();
  const { report } = await new WeatherCache(fetcher).get({
    location: "Home",
    latitude: 40.7,
    longitude: -74,
    unit: "f",
  });
  expect(report).toMatchObject({ location: "Home", unit: "f" });
  expect(report?.place).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
  const url = new URL(href(fetcher.mock.calls[0][0]));
  expect(url.searchParams.get("latitude")).toBe("40.7");
  expect(url.searchParams.get("temperature_unit")).toBe("fahrenheit");
  expect(url.searchParams.get("wind_speed_unit")).toBe("mph");
});

it("keeps the last report when an update fails, and backs off before retrying", async () => {
  let now = Date.parse("2026-11-05T12:00:00Z");
  let fail = false;
  const fetcher = stubOpenMeteo(() =>
    fail ? new Response(null, { status: 503 }) : Response.json(forecast),
  );
  const cache = new WeatherCache(fetcher, () => now);
  const config = { location: "Jakarta" };
  await cache.get(config);

  fail = true;
  now += WEATHER_FRESH_MS;
  await cache.get(config);
  await vi.waitFor(async () =>
    expect(await cache.get(config)).toMatchObject({
      stale: true,
      error: "unavailable",
      report: { current: { temp: 30.6 } },
    }),
  );
  const calls = fetcher.mock.calls.length;
  now += 30_000;
  await cache.get(config);
  expect(fetcher).toHaveBeenCalledTimes(calls);
});

it("reports a location the search cannot find", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({}));
  expect(await new WeatherCache(fetcher).get({ location: "Nowhere" })).toEqual({
    configured: true,
    error: "not-found",
  });
  expect(await new WeatherCache(fetcher).get(undefined)).toEqual({ configured: false });
});
