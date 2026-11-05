import type { WeatherResponse } from "../shared/types.ts";
import { escapeHtml } from "./safety.ts";

/** WMO weather interpretation codes, as Open-Meteo reports them. */
function condition(code: number, isDay = true) {
  if (code === 0) return { label: "Clear", icon: isDay ? "☀️" : "🌙" };
  if (code === 1) return { label: "Mostly clear", icon: isDay ? "🌤️" : "🌙" };
  if (code === 2) return { label: "Partly cloudy", icon: isDay ? "⛅" : "☁️" };
  if (code === 3) return { label: "Overcast", icon: "☁️" };
  if (code === 45 || code === 48) return { label: "Fog", icon: "🌫️" };
  if (code >= 51 && code <= 57) return { label: "Drizzle", icon: "🌦️" };
  if (code >= 61 && code <= 67) return { label: code >= 65 ? "Heavy rain" : "Rain", icon: "🌧️" };
  if (code >= 71 && code <= 77) return { label: "Snow", icon: "🌨️" };
  if (code >= 80 && code <= 82) return { label: "Showers", icon: "🌦️" };
  if (code === 85 || code === 86) return { label: "Snow showers", icon: "🌨️" };
  if (code >= 95) return { label: "Thunderstorm", icon: "⛈️" };
  return { label: "Unknown", icon: "🌡️" };
}

const degrees = (value: number) => `${Math.round(value)}°`;

function dayName(date: string, index: number) {
  if (index === 0) return { short: "Today", long: "Today" };
  // Midday keeps the date on the same calendar day in every browser time zone.
  const day = new Date(`${date}T12:00:00`);
  return {
    short: day.toLocaleDateString(undefined, { weekday: "short" }),
    long: day.toLocaleDateString(undefined, { weekday: "long" }),
  };
}

function time(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : "";
}

function creditHtml(openInNewTab: boolean) {
  return `<p class="weather-credit">Data from <a href="https://open-meteo.com/" target="${openInNewTab ? "_blank" : "_self"}" rel="noopener noreferrer">Open-Meteo</a></p>`;
}

/**
 * Placeholders inside the real layout classes, so the loaded report takes the
 * same space. Each bar sits in a span with its final font size and line height.
 */
function skeletonHtml(openInNewTab: boolean) {
  const bar = (width: string) => `<span class="skeleton-text" style="width: ${width}"></span>`;
  const day = `
        <li class="weather-day">
          <span class="weather-day-name">${bar("2rem")}</span>
          <span class="weather-day-icon">${bar("1.25rem")}</span>
          <span class="weather-day-max">${bar("1.5rem")}</span>
          <span class="weather-day-min">${bar("1.5rem")}</span>
        </li>`;
  return `<span class="visually-hidden">Loading weather…</span>
    <div class="weather-layout" aria-hidden="true">
    <div class="weather-now">
      <span class="weather-icon">${bar("1.875rem")}</span>
      <span class="weather-temp">${bar("2.75rem")}</span>
      <span class="weather-summary">
        <span class="weather-condition">${bar("6rem")}</span>
        <span class="weather-feels">${bar("5rem")}</span>
      </span>
    </div>
    <div class="weather-stats">${bar("75%")}</div>
    <ol class="weather-days">${day.repeat(5)}</ol>
    </div>
    ${creditHtml(openInNewTab)}`;
}

/**
 * The Weather section body: current conditions, then a row of daily highs and
 * lows, then the Open-Meteo credit its terms ask for.
 */
export function weatherHtml(response: WeatherResponse, openInNewTab = true) {
  const { report } = response;
  if (!report) {
    return response.error === "not-found"
      ? `<p class="section-note" data-tone="warning">Location not found. Set latitude and longitude in the config.</p>`
      : response.error
        ? `<p class="app-notice"><strong>Weather unavailable</strong><br />Could not load the forecast.</p>`
        : skeletonHtml(openInNewTab);
  }
  const { current, days, unit } = report;
  const now = condition(current.code, current.isDay);
  const today = days[0];
  const stale = response.stale
    ? `<p class="section-note" data-tone="warning">Update failed. Last updated ${escapeHtml(time(report.fetchedAt))}.</p>`
    : "";
  const stats: Array<[string, string]> = [
    ["Humidity", `${Math.round(current.humidity)}%`],
    ["Wind", `${Math.round(current.wind)} ${unit === "f" ? "mph" : "km/h"}`],
  ];
  if (today?.precipChance !== undefined) stats.push(["Rain", `${today.precipChance}%`]);

  return `${stale}
    <div class="weather-layout">
    <div class="weather-now">
      <span class="weather-icon" role="img" aria-label="${escapeHtml(now.label)}">${now.icon}</span>
      <span class="weather-temp">${Math.round(current.temp)}<span class="weather-unit">°${unit.toUpperCase()}</span></span>
      <span class="weather-summary">
        <span class="weather-condition">${escapeHtml(now.label)}</span>
        <span class="weather-feels">Feels like ${degrees(current.feelsLike)}</span>
      </span>
    </div>
    <dl class="weather-stats">
      ${stats.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}
    </dl>
    <ol class="weather-days">
      ${days
        .map((day, index) => {
          const { label, icon } = condition(day.code);
          const name = dayName(day.date, index);
          const rain = day.precipChance ? `, ${day.precipChance}% chance of rain` : "";
          return `
        <li class="weather-day" title="${escapeHtml(`${name.long}: ${label}, high ${degrees(day.max)}, low ${degrees(day.min)}${rain}`)}">
          <span class="weather-day-name">${escapeHtml(name.short)}</span>
          <span class="weather-day-icon" role="img" aria-label="${escapeHtml(label)}">${icon}</span>
          <span class="weather-day-max">${degrees(day.max)}</span>
          <span class="weather-day-min">${degrees(day.min)}</span>
        </li>`;
        })
        .join("")}
    </ol>
    </div>
    ${creditHtml(openInNewTab)}`;
}
