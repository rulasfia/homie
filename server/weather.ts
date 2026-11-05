import type {
  WeatherConfig,
  WeatherDay,
  WeatherError,
  WeatherReport,
  WeatherResponse,
} from "../shared/types.ts";

/** Open-Meteo refreshes its current conditions every 15 minutes. */
export const WEATHER_FRESH_MS = 15 * 60_000;
const RETRY_MS = 60_000;
const TIMEOUT_MS = 5000;
const FORECAST_DAYS = 5;

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

class WeatherFailure extends Error {
  code: WeatherError;
  constructor(code: WeatherError) {
    super(code);
    this.code = code;
  }
}

interface Place {
  latitude: number;
  longitude: number;
  name?: string;
}

interface WeatherEntry {
  key: string;
  place?: Place;
  report?: WeatherReport;
  fetchedAt?: number;
  retryAt: number;
  error?: WeatherError;
  pending?: Promise<void>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function number(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new WeatherFailure("unavailable");
  return value;
}

function series(value: unknown, length: number) {
  if (!Array.isArray(value) || value.length < length) throw new WeatherFailure("unavailable");
  return value.slice(0, length);
}

/**
 * Keeps one report for the configured location. The first request waits for
 * it; later ones get the cached report at once while a stale one is renewed in
 * the background. A failed update keeps the last good report.
 */
export class WeatherCache {
  private entry: WeatherEntry | undefined;
  private fetcher: typeof fetch;
  private now: () => number;

  constructor(fetcher: typeof fetch = fetch, now: () => number = Date.now) {
    this.fetcher = fetcher;
    this.now = now;
  }

  async get(config: WeatherConfig | undefined): Promise<WeatherResponse> {
    if (!config) {
      this.entry = undefined;
      return { configured: false };
    }
    const key = JSON.stringify(config);
    if (this.entry?.key !== key) this.entry = { key, retryAt: 0 };
    const entry = this.entry;
    if (!entry.pending && this.now() >= entry.retryAt) {
      entry.pending = this.refresh(entry, config).finally(() => (entry.pending = undefined));
    }
    if (!entry.report && entry.pending) await entry.pending;
    return {
      configured: true,
      report: entry.report,
      // A report renewing on schedule is not stale; only one whose last update failed.
      stale: entry.report && entry.error ? true : undefined,
      error: entry.error,
    };
  }

  private async refresh(entry: WeatherEntry, config: WeatherConfig) {
    try {
      entry.place ??= await this.place(config);
      entry.report = await this.forecast(entry.place, config);
      entry.fetchedAt = this.now();
      entry.retryAt = entry.fetchedAt + WEATHER_FRESH_MS;
      entry.error = undefined;
    } catch (error) {
      entry.error = error instanceof WeatherFailure ? error.code : "unavailable";
      // A missing place stays missing until the config changes; check it rarely.
      entry.retryAt = this.now() + (entry.error === "not-found" ? WEATHER_FRESH_MS : RETRY_MS);
    }
  }

  private async getJson(url: URL) {
    const response = await this.fetcher(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      credentials: "omit",
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new WeatherFailure("unavailable");
    }
    const body: unknown = await response.json();
    if (!isRecord(body)) throw new WeatherFailure("unavailable");
    return body;
  }

  /** Configured coordinates, or the best match Open-Meteo finds for the location name. */
  private async place(config: WeatherConfig): Promise<Place> {
    if (config.latitude !== undefined && config.longitude !== undefined)
      return { latitude: config.latitude, longitude: config.longitude };
    const url = new URL(GEOCODING_URL);
    url.search = new URLSearchParams({
      name: config.location,
      count: "1",
      format: "json",
    }).toString();
    const body = await this.getJson(url);
    const match = Array.isArray(body.results) ? body.results[0] : undefined;
    if (!isRecord(match)) throw new WeatherFailure("not-found");
    const name = [match.name, match.admin1, match.country]
      .filter((part, index, parts) => typeof part === "string" && parts.indexOf(part) === index)
      .join(", ");
    return {
      latitude: number(match.latitude),
      longitude: number(match.longitude),
      name: name || undefined,
    };
  }

  private async forecast(place: Place, config: WeatherConfig): Promise<WeatherReport> {
    const unit = config.unit ?? "c";
    const url = new URL(FORECAST_URL);
    url.search = new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      current:
        "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,is_day,wind_speed_10m",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
      timezone: "auto",
      forecast_days: String(FORECAST_DAYS),
      ...(unit === "f" ? { temperature_unit: "fahrenheit", wind_speed_unit: "mph" } : {}),
    }).toString();
    const body = await this.getJson(url);
    const { current, daily } = body;
    if (!isRecord(current) || !isRecord(daily)) throw new WeatherFailure("unavailable");

    const dates = series(daily.time, FORECAST_DAYS);
    const codes = series(daily.weather_code, FORECAST_DAYS);
    const maxima = series(daily.temperature_2m_max, FORECAST_DAYS);
    const minima = series(daily.temperature_2m_min, FORECAST_DAYS);
    const chances = Array.isArray(daily.precipitation_probability_max)
      ? daily.precipitation_probability_max
      : [];
    const days = dates.map((date, index): WeatherDay => {
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date))
        throw new WeatherFailure("unavailable");
      const chance = chances[index];
      return {
        date,
        code: number(codes[index]),
        max: number(maxima[index]),
        min: number(minima[index]),
        precipChance: typeof chance === "number" && Number.isFinite(chance) ? chance : undefined,
      };
    });

    return {
      location: config.location,
      place: place.name,
      unit,
      fetchedAt: new Date(this.now()).toISOString(),
      current: {
        temp: number(current.temperature_2m),
        feelsLike: number(current.apparent_temperature),
        humidity: number(current.relative_humidity_2m),
        wind: number(current.wind_speed_10m),
        code: number(current.weather_code),
        isDay: current.is_day !== 0,
      },
      days,
    };
  }
}
