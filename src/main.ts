import "./styles/fonts.css";
import "./styles/reset.css";
import "./styles/tokens.css";
import "./styles/app.css";

import type {
  Bookmark,
  BookmarkGroup,
  ContainersAllResponse,
  HomieConfig,
  PingResult,
  SystemStatus,
  UnifiedContainer,
} from "../shared/types.ts";
import {
  fetchAllContainers,
  fetchConfig,
  fetchFeeds,
  fetchPings,
  fetchSystems,
  fetchWeather,
} from "./api.ts";
import { FeedController, feedRowsHtml, feedStatusText } from "./feeds.ts";
import {
  loadCachedConfig,
  renderedConfig,
  saveCachedConfig,
  type RenderedConfig,
} from "./config-cache.ts";
import { formatContainerMetrics } from "./container-metrics.ts";
import { containerStatus } from "./container-status.ts";
import {
  initialContainersView,
  initialSystemsView,
  nextContainersView,
  nextSystemsView,
  type ContainersView,
  type SystemsView,
} from "./monitoring.ts";
import { summarizeChecks } from "./readout.ts";
import { scheduleRefresh, singleFlight } from "./refresh.ts";
import { escapeHtml, safeIconUrl, safeNavigationUrl } from "./safety.ts";
import { initThemeSwitcher, loadThemeStyles } from "./theme.ts";
import { weatherHtml } from "./weather.ts";

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("/sw.js")
    .then((registration) => {
      console.log("service worker registered:", registration.scope);
    })
    .catch((err) => {
      console.error("service worker registration failed:", err);
    });
}

const REFRESH_INTERVAL_MS = 60_000;
const HIDDEN_SECTIONS_KEY = "homie:hidden-sections";

let systemsView: SystemsView = initialSystemsView;
let containersView: ContainersView = initialContainersView;
let selectedContainerMachine = "";
let linkOpenInNewTab = true;
const feedController = new FeedController(fetchFeeds, (results, warning) => {
  const section = document.querySelector<HTMLElement>("#feeds");
  const list = document.querySelector<HTMLElement>("#feeds-list");
  const status = document.querySelector<HTMLElement>("#feeds-status");
  if (!section || !list || !status) return;
  section.hidden = results.length === 0;
  const html = feedRowsHtml(results, linkOpenInNewTab);
  if (list.innerHTML !== html) list.innerHTML = html;
  status.textContent = feedStatusText(results, warning);
  status.hidden = !status.textContent;
});

function configureFeeds(config: RenderedConfig) {
  linkOpenInNewTab = config.openInNewTab ?? true;
  feedController.configure(config.feeds);
}

/* --- Weather --- */

// JSON of the configured weather block, so a config sync can tell when it changed.
let weatherJson = "";
let weatherRequest: AbortController | undefined;
let weatherReportShown = false;

/** Shows or hides the Weather section for `config` and resets it when the location or unit changed. */
function configureWeather(config: RenderedConfig) {
  const json = JSON.stringify(config.weather ?? null);
  if (json === weatherJson) return;
  weatherJson = json;
  weatherRequest?.abort();
  weatherReportShown = false;
  const section = document.querySelector<HTMLElement>("#weather");
  const location = document.querySelector<HTMLElement>("#weather-location");
  const body = document.querySelector<HTMLElement>("#weather-body");
  if (!section || !location || !body) return;
  section.hidden = !config.weather;
  location.textContent = config.weather?.location ?? "";
  location.title = "";
  body.innerHTML = weatherHtml({ configured: true }, linkOpenInNewTab);
}

/**
 * Fetches the weather when it is configured. A newer call cancels an older one;
 * a failed request keeps the report already on screen.
 */
async function loadWeather() {
  if (weatherJson === "null" || weatherJson === "") return;
  weatherRequest?.abort();
  const request = new AbortController();
  weatherRequest = request;
  let html: string;
  let place: string | undefined;
  try {
    const response = await fetchWeather(request.signal);
    if (request.signal.aborted) return;
    if (!response.configured) return;
    html = weatherHtml(response, linkOpenInNewTab);
    place = response.report?.place;
    weatherReportShown = !!response.report;
  } catch {
    if (request.signal.aborted || weatherReportShown) return;
    html = weatherHtml({ configured: true, error: "unavailable" });
  }
  const body = document.querySelector<HTMLElement>("#weather-body");
  const location = document.querySelector<HTMLElement>("#weather-location");
  if (body && body.innerHTML !== html) body.innerHTML = html;
  if (location) location.title = place ?? "";
}

function loadHiddenSections(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HIDDEN_SECTIONS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

const hiddenSections = loadHiddenSections();

function applySectionVisibility(sectionId: string): void {
  const section = document.getElementById(sectionId);
  if (!section) return;

  const hidden = hiddenSections.has(sectionId);
  section.classList.toggle("section-hidden", hidden);

  const toggle = section.querySelector<HTMLButtonElement>(".section-toggle");
  if (toggle) {
    toggle.setAttribute("aria-expanded", String(!hidden));
    toggle.title = hidden ? "show section" : "hide section";
  }
}

function toggleSection(sectionId: string): void {
  if (hiddenSections.has(sectionId)) hiddenSections.delete(sectionId);
  else hiddenSections.add(sectionId);
  try {
    localStorage.setItem(HIDDEN_SECTIONS_KEY, JSON.stringify([...hiddenSections]));
  } catch {
    // Storage is blocked (e.g. Safari private mode): the toggle still works for this page view.
  }
  applySectionVisibility(sectionId);
}

function iconHtml(bookmark: Bookmark): string {
  const fallback = bookmark.name.charAt(0).toUpperCase();
  const icon = bookmark.icon?.trim() || fallback;
  const iconUrl = safeIconUrl(icon);
  if (iconUrl) {
    return `
      <img class="service-icon-img" src="${escapeHtml(iconUrl)}" alt="" loading="lazy" />
      <span class="service-icon-fallback" aria-hidden="true">${escapeHtml(fallback)}</span>`;
  }
  return escapeHtml(icon);
}

function serviceHtml(bookmark: Bookmark, openInNewTab = true): string {
  const url = safeNavigationUrl(bookmark.url);
  const ping =
    bookmark.ping && url
      ? `<span class="ping service-health" data-ping-url="${escapeHtml(url)}">
         <span class="status-dot" data-status="pending"></span>
         <span class="ping-latency" hidden></span>
       </span>`
      : "";

  const description = bookmark.description ? ` title="${escapeHtml(bookmark.description)}"` : "";
  const tag = url ? "a" : "div";
  const linkAttributes = url
    ? ` href="${escapeHtml(url)}" target="${openInNewTab ? "_blank" : "_self"}" rel="noopener noreferrer"`
    : "";

  return `
    <${tag} class="service"${linkAttributes}${description}>
      <span class="service-icon">${iconHtml(bookmark)}</span>
      <span class="service-name">${escapeHtml(bookmark.name)}</span>
      ${ping}
    </${tag}>`;
}

function sectionToggleHtml(sectionId: string): string {
  const hidden = hiddenSections.has(sectionId);
  return `
    <button class="section-toggle" type="button" data-section-toggle="${sectionId}"
            aria-expanded="${String(!hidden)}" title="${hidden ? "show section" : "hide section"}">
      <svg class="icon-hide" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
      <svg class="icon-show" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
        <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.16 3.19" />
        <path d="M6.61 6.61A17.54 17.54 0 0 0 2 12s3.5 7 10 7a10.43 10.43 0 0 0 5.39-1.61" />
        <line x1="2" y1="2" x2="22" y2="22" />
      </svg>
    </button>`;
}

function sectionClass(sectionId: string): string {
  return hiddenSections.has(sectionId) ? "group section-hidden" : "group";
}

/** One config group: its name and up count beside a grid of its tiles. updateReadout fills the count. */
function serviceGroupHtml(group: BookmarkGroup, openInNewTab?: boolean) {
  return `
    <div class="service-group">
      <h3 class="service-group-name">
        ${escapeHtml(group.name)}
        <span class="service-group-count" data-group-count></span>
      </h3>
      <div class="service-grid">
        ${group.bookmarks.map((bookmark) => serviceHtml(bookmark, openInNewTab)).join("")}
      </div>
    </div>`;
}

/**
 * The Services section, or a notice when no bookmarks are configured. Both carry
 * `data-services` so a config change can swap them in place (see applyConfig).
 */
function servicesHtml(config: RenderedConfig) {
  const groups = config.groups.filter((group) => group.bookmarks.length > 0);

  return groups.length > 0
    ? `<section class="${sectionClass("services")}" id="services" data-services>
           <div class="section-header">
             <h2 class="group-name">Services</h2>
             <span class="section-count" id="services-count"></span>
             <span class="section-groove" aria-hidden="true"></span>
             ${sectionToggleHtml("services")}
           </div>
           <div class="section-body">
             <div class="service-groups">
               ${groups.map((group) => serviceGroupHtml(group, config.openInNewTab)).join("")}
             </div>
           </div>
         </section>`
    : `<p class="app-notice" data-services>no bookmarks configured</p>`;
}

function render(config: RenderedConfig): string {
  return `
    <header class="app-header">
      <div class="app-brand">
        <span class="app-power" aria-hidden="true"></span>
        <h1 class="app-title">${escapeHtml(config.title)}</h1>
      </div>
      <div class="app-actions">
        <button class="app-theme" type="button">auto</button>
        <button class="app-refresh" type="button" title="re-run checks">refresh</button>
      </div>
    </header>
    <main>
      <div class="app-columns">
        <div class="app-column">
          <section class="${sectionClass("systems")}" id="systems">
            <div class="section-header">
              <h2 class="group-name">Machines</h2>
              <span class="section-count" id="systems-count"></span>
              <span class="section-groove" aria-hidden="true"></span>
              ${sectionToggleHtml("systems")}
            </div>
            <div class="section-body">
              <div class="section-status" id="systems-status" role="status" aria-live="polite">
                <p class="section-note">Loading machines…</p>
              </div>
              <div class="card-grid" id="systems-grid" aria-busy="true">
                ${[1, 2, 3].map(systemSkeletonCardHtml).join("")}
              </div>
            </div>
          </section>
          ${servicesHtml(config)}
          ${containersSectionHtml()}
        </div>
        <aside class="app-column app-column-side">
          <section class="${sectionClass("weather")}" id="weather" ${config.weather ? "" : "hidden"}>
            <div class="section-header">
              <h2 class="group-name">Weather</h2>
              <span class="section-count" id="weather-location">${escapeHtml(config.weather?.location ?? "")}</span>
              <span class="section-groove" aria-hidden="true"></span>
              ${sectionToggleHtml("weather")}
            </div>
            <div class="section-body">
              <div class="weather" id="weather-body"></div>
            </div>
          </section>
          <section class="${sectionClass("feeds")}" id="feeds" ${config.feeds?.length ? "" : "hidden"}>
            <div class="section-header">
              <h2 class="group-name">Headlines</h2>
              <span class="section-groove" aria-hidden="true"></span>
              ${sectionToggleHtml("feeds")}
            </div>
            <div class="section-body">
              <p class="section-note" id="feeds-status" role="status" aria-live="polite" hidden></p>
              <ul class="feed-list" id="feeds-list"></ul>
            </div>
          </section>
        </aside>
      </div>
    </main>`;
}

function containersSectionHtml() {
  return `
    <section class="${sectionClass("containers")}" id="containers">
      <div class="section-header">
        <h2 class="group-name">Containers</h2>
        <span class="section-count" id="containers-count"></span>
        <span class="section-groove" aria-hidden="true"></span>
        <div class="section-actions">
          <div class="container-filter">
            <label for="container-machine-filter" class="visually-hidden">Filter by machine</label>
            <select id="container-machine-filter" disabled>
              <option value="">All machines</option>
            </select>
          </div>
          ${sectionToggleHtml("containers")}
        </div>
      </div>
      <div class="section-body">
        <div class="section-status" id="containers-status" role="status" aria-live="polite">
          <p class="section-note">Loading containers…</p>
        </div>
        <div class="container-wrapper" id="containers-content" aria-busy="true">
          <table class="container-table" id="containers-table">
            ${containerHeaderHtml()}
            <tbody>${[1, 2, 3, 4, 5].map(containerSkeletonRowHtml).join("")}</tbody>
          </table>
        </div>
      </div>
    </section>`;
}

/* --- Machines (Beszel) --- */

function meterLevel(pct: number): "ok" | "warn" | "crit" {
  if (pct >= 90) return "crit";
  if (pct >= 75) return "warn";
  return "ok";
}

/** One meter row; `pct` is undefined for machines that are not up, which renders an empty meter. */
function meterHtml(label: string, pct: number | undefined): string {
  if (pct === undefined) {
    return `
    <div class="meter-row">
      <span class="meter-label">${label} —</span>
      <span class="meter-track"></span>
    </div>`;
  }
  const rounded = Math.round(pct);
  return `
    <div class="meter-row">
      <span class="meter-label">${label} ${rounded}%</span>
      <span class="meter-track">
        <span class="meter-fill" data-level="${meterLevel(pct)}" style="width: ${Math.min(100, rounded)}%"></span>
      </span>
    </div>`;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** One line: uptime, temperature and the 1-minute load; all three load averages are in the tooltip. */
function systemMeta(system: SystemStatus): string {
  const up = system.status === "up";
  const load = up ? system.loadAvg?.map((n) => n.toFixed(2)) : undefined;
  const meta = [
    up && system.uptime > 0 ? `up ${formatUptime(system.uptime)}` : system.status,
    up && system.temp !== undefined ? `${Math.round(system.temp)}°C` : null,
    load ? `load ${load[0]}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const title = load ? ` title="load ${escapeHtml(load.join(" · "))} (1, 5, 15 min)"` : "";
  return meta ? `<div class="system-meta"${title}>${escapeHtml(meta)}</div>` : "";
}

function copyAddressButtonHtml(address: string | undefined): string {
  if (!address?.trim()) return "";

  return `
    <button class="system-copy" type="button" data-copy-address="${encodeURIComponent(address)}"
            aria-label="Copy machine address" title="Copy machine address">
      <svg class="icon-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
        <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
      </svg>
      <svg class="icon-copied" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="m5 12 4 4L19 6" />
      </svg>
    </button>`;
}

/** `paused` and `pending` get the unlit neutral dot rather than the red "down" one. */
function dotStatus(status: SystemStatus["status"]): string {
  return status === "up" || status === "down" ? status : "unknown";
}

function systemCardHtml(system: SystemStatus): string {
  const up = system.status === "up";

  return `
    <div class="system-card">
      <div class="system-header">
        <span class="status-dot" data-status="${dotStatus(system.status)}" title="${escapeHtml(system.status)}"></span>
        <span class="system-name">${escapeHtml(system.name)}</span>
        ${copyAddressButtonHtml(system.address)}
      </div>
      ${systemMeta(system)}
      <div class="system-meters">
        ${meterHtml("cpu", up ? system.cpu : undefined)}
        ${meterHtml("mem", up ? system.memPct : undefined)}
        ${meterHtml("disk", up ? system.diskPct : undefined)}
      </div>
    </div>`;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Clipboard access can be rejected when the dashboard is served over plain HTTP.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  try {
    textarea.select();
    if (!document.execCommand("copy")) throw new Error("copy failed");
  } finally {
    textarea.remove();
  }
}

async function copyMachineAddress(button: HTMLButtonElement): Promise<void> {
  const encodedAddress = button.dataset.copyAddress;
  if (!encodedAddress) return;

  try {
    await copyText(decodeURIComponent(encodedAddress));
    button.dataset.copied = "true";
    button.title = "address copied";
    button.setAttribute("aria-label", "Address copied");
    setTimeout(() => {
      delete button.dataset.copied;
      button.title = "Copy machine address";
      button.setAttribute("aria-label", "Copy machine address");
    }, 1500);
  } catch {
    button.title = "failed to copy address";
  }
}

function systemSkeletonCardHtml(): string {
  return `
    <div class="system-card skeleton-card">
      <div class="system-header">
        <span class="status-dot" data-status="pending"></span>
        <span class="skeleton-line" style="width: 45%"></span>
      </div>
      <div class="system-meta"><span class="skeleton-line" style="width: 55%"></span></div>
      <div class="system-meters">
        ${[1, 2, 3]
          .map(
            () => `
          <div class="meter-row">
            <span class="meter-label skeleton-label"></span>
            <span class="meter-track skeleton-track"></span>
          </div>`,
          )
          .join("")}
      </div>
    </div>`;
}

function statusHtml(warning: string | undefined, note: string): string {
  const warningHtml = warning
    ? `<p class="section-note" data-tone="warning">${escapeHtml(warning)}</p>`
    : "";
  return warningHtml + note;
}

function applySystemsView(view: SystemsView): void {
  const section = document.querySelector<HTMLElement>("#systems");
  const grid = document.querySelector<HTMLElement>("#systems-grid");
  const status = document.querySelector<HTMLElement>("#systems-status");
  if (!section || !grid || !status) return;

  const count = document.querySelector<HTMLElement>("#systems-count");
  if (count) {
    const up = view.systems.filter((system) => system.status === "up").length;
    count.textContent = view.kind === "ready" ? `${up}/${view.systems.length} up` : "";
  }

  section.hidden = view.kind === "hidden";
  grid.setAttribute("aria-busy", String(view.kind === "loading"));

  if (view.kind === "hidden") {
    grid.hidden = true;
    status.hidden = true;
    status.innerHTML = "";
    return;
  }

  let note = "";
  if (view.kind === "loading") {
    grid.hidden = false;
    grid.innerHTML = [1, 2, 3].map(systemSkeletonCardHtml).join("");
    note = `<p class="section-note">Loading machines…</p>`;
  } else if (view.kind === "ready") {
    grid.hidden = false;
    grid.innerHTML = view.systems.map(systemCardHtml).join("");
  } else {
    grid.hidden = true;
    grid.innerHTML = "";
    note =
      view.kind === "empty"
        ? `<p class="app-notice">No machines are reporting.</p>`
        : `<p class="app-notice"><strong>Machines unavailable</strong><br />Could not load machine status.</p>`;
  }

  status.innerHTML = statusHtml(view.warning, note);
  status.hidden = status.innerHTML === "";
}

async function loadSystems(): Promise<void> {
  try {
    systemsView = nextSystemsView(systemsView, { ok: true, value: await fetchSystems() });
  } catch {
    systemsView = nextSystemsView(systemsView, { ok: false });
  }
  applySystemsView(systemsView);
}

const loadSystemsOnce = singleFlight(loadSystems);

/* --- Containers (Docker) --- */

function containerHeaderHtml(): string {
  return `
    <thead>
      <tr>
        <th class="container-col-status" scope="col"></th>
        <th class="container-col-name" scope="col">Name</th>
        <th class="container-col-image" scope="col">Image</th>
        <th class="container-col-uptime" scope="col">Status</th>
        <th class="container-col-ports" scope="col">Ports</th>
      </tr>
    </thead>`;
}

function containerRowHtml(container: UnifiedContainer): string {
  const isRemote = container.source === "remote";
  const title = isRemote ? container.systemName : (container.id ?? "");
  const statusText = isRemote
    ? formatContainerMetrics(container) || "—"
    : (container.status ?? "—");
  const imageText = container.image ?? "—";
  const portsText =
    !isRemote && container.ports && container.ports.length > 0
      ? escapeHtml(container.ports.join("  "))
      : "—";

  const dot = containerStatus(container.state, container.status);

  return `
    <tr class="container-row">
      <td class="container-col-status">
        <span class="status-dot" data-status="${dot.led}" title="${escapeHtml(dot.label)}"></span>
      </td>
      <td class="container-col-name" title="${escapeHtml(title)}">${escapeHtml(container.name)}</td>
      <td class="container-col-image">${escapeHtml(imageText)}</td>
      <td class="container-col-uptime">${escapeHtml(statusText)}</td>
      <td class="container-col-ports">${portsText}</td>
    </tr>`;
}

function containerSkeletonRowHtml(): string {
  return `
    <tr class="container-row skeleton-row">
      <td class="container-col-status"><span class="status-dot" data-status="pending"></span></td>
      <td class="container-col-name"><span class="skeleton-cell" style="width: 70%"></span></td>
      <td class="container-col-image"><span class="skeleton-cell" style="width: 80%"></span></td>
      <td class="container-col-uptime"><span class="skeleton-cell" style="width: 60%"></span></td>
      <td class="container-col-ports"><span class="skeleton-cell" style="width: 75%"></span></td>
    </tr>`;
}

function containerEmptyRowHtml(message: string): string {
  return `<tbody><tr><td class="container-empty" colspan="5">${escapeHtml(message)}</td></tr></tbody>`;
}

const isRunning = (container: UnifiedContainer) => container.state === "running";

/** One tbody per machine, in response order, headed by its name and running count. */
function containerGroupsHtml(containers: UnifiedContainer[]): string {
  const byMachine = new Map<string, UnifiedContainer[]>();
  for (const container of containers) {
    const key = container.systemId ?? container.source;
    byMachine.set(key, [...(byMachine.get(key) ?? []), container]);
  }
  return [...byMachine.values()]
    .map(
      (group) => `
    <tbody>
      <tr class="container-group">
        <th colspan="5" scope="rowgroup">
          ${escapeHtml(group[0].systemName)}
          <span class="container-group-count">${group.filter(isRunning).length}/${group.length} running</span>
        </th>
      </tr>
      ${group.map(containerRowHtml).join("")}
    </tbody>`,
    )
    .join("");
}

function containerTableHtml(response: ContainersAllResponse): string {
  const containers = filterContainers(response);
  const body =
    containers.length > 0
      ? containerGroupsHtml(containers)
      : containerEmptyRowHtml(
          selectedContainerMachine ? "No containers on this machine." : "No containers found.",
        );
  return containerHeaderHtml() + body;
}

function renderContainerFilter(sources: Array<{ id: string; name: string }>): void {
  const select = document.querySelector<HTMLSelectElement>("#container-machine-filter");
  if (!select) return;

  if (
    selectedContainerMachine &&
    !sources.some((source) => source.id === selectedContainerMachine)
  ) {
    selectedContainerMachine = "";
  }

  const hasMultiple = sources.length > 1;
  select.disabled = !hasMultiple;
  select.innerHTML = [
    `<option value="">All machines</option>`,
    ...sources.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`),
  ].join("");
  select.value = selectedContainerMachine;
}

function filterContainers(response: ContainersAllResponse): UnifiedContainer[] {
  if (!selectedContainerMachine) return response.containers;
  return response.containers.filter((c) =>
    selectedContainerMachine === "local"
      ? c.source === "local"
      : c.systemId === selectedContainerMachine,
  );
}

function applyContainerFilter(): void {
  const table = document.querySelector<HTMLElement>("#containers-table");
  const response = containersView.response;
  if (!table || !response) return;
  table.innerHTML = containerTableHtml(response);
}

function applyContainersView(view: ContainersView): void {
  const section = document.querySelector<HTMLElement>("#containers");
  const content = document.querySelector<HTMLElement>("#containers-content");
  const table = document.querySelector<HTMLElement>("#containers-table");
  const status = document.querySelector<HTMLElement>("#containers-status");
  const select = document.querySelector<HTMLSelectElement>("#container-machine-filter");
  if (!section || !content || !table || !status || !select) return;

  section.hidden = view.kind === "hidden";
  content.setAttribute("aria-busy", String(view.kind === "loading"));

  const count = document.querySelector<HTMLElement>("#containers-count");
  if (count) {
    const all = view.response?.containers ?? [];
    count.textContent =
      view.kind === "ready" ? `${all.filter(isRunning).length}/${all.length} running` : "";
  }

  if (view.kind === "hidden") {
    content.hidden = true;
    status.hidden = true;
    status.innerHTML = "";
    select.disabled = true;
    return;
  }

  if (view.kind === "loading") {
    content.hidden = false;
    table.innerHTML =
      containerHeaderHtml() +
      `<tbody>${[1, 2, 3, 4, 5].map(containerSkeletonRowHtml).join("")}</tbody>`;
    select.disabled = true;
    status.innerHTML = statusHtml(undefined, `<p class="section-note">Loading containers…</p>`);
    status.hidden = false;
    return;
  }

  if (view.kind === "unavailable") {
    content.hidden = true;
    table.innerHTML = "";
    select.disabled = true;
    status.innerHTML = statusHtml(
      view.warning,
      `<p class="app-notice"><strong>Containers unavailable</strong><br />Could not load container status.</p>`,
    );
    status.hidden = false;
    return;
  }

  if (!view.response) return;
  content.hidden = false;
  renderContainerFilter(view.response.sources);
  select.onchange = (event) => {
    selectedContainerMachine = (event.target as HTMLSelectElement).value;
    applyContainerFilter();
  };
  table.innerHTML = containerTableHtml(view.response);
  status.innerHTML = statusHtml(view.warning, "");
  status.hidden = status.innerHTML === "";
}

async function loadContainers(): Promise<void> {
  try {
    containersView = nextContainersView(containersView, {
      ok: true,
      value: await fetchAllContainers(),
    });
  } catch {
    containersView = nextContainersView(containersView, { ok: false });
  }
  applyContainersView(containersView);
}

const loadContainersOnce = singleFlight(loadContainers);

/* --- Service counts and header LED --- */

function updateReadout(): void {
  const count = document.querySelector<HTMLElement>("#services-count");
  const power = document.querySelector<HTMLElement>(".app-power");

  const byUrl = new Map<string, string | undefined>();
  for (const el of document.querySelectorAll<HTMLElement>("[data-ping-url]")) {
    const dot = el.querySelector<HTMLElement>(".status-dot");
    byUrl.set(el.dataset.pingUrl ?? "", dot?.dataset.status);
  }

  // Each group's own "3/4 up", left empty while any of its checks is still running.
  for (const group of document.querySelectorAll<HTMLElement>(".service-group")) {
    const count = group.querySelector<HTMLElement>("[data-group-count]");
    if (!count) continue;
    const statuses = [...group.querySelectorAll<HTMLElement>("[data-ping-url] .status-dot")].map(
      (dot) => dot.dataset.status,
    );
    const { status, text } = summarizeChecks(statuses);
    count.textContent = status && status !== "pending" ? text.replace(" services", "") : "";
  }

  const summary = summarizeChecks(byUrl.values());
  if (count) {
    count.textContent =
      summary.status && summary.status !== "pending" ? summary.text.replace(" services", "") : "";
  }
  if (!power) return;
  if (summary.status) power.dataset.status = summary.status;
  else delete power.dataset.status;
  power.title = summary.text || "no service checks configured";
}

/* --- Ping checks --- */

function applyPingResult(el: Element, result: PingResult): void {
  const dot = el.querySelector(".status-dot");
  const latency = el.querySelector(".ping-latency");
  if (!(dot instanceof HTMLElement) || !(latency instanceof HTMLElement)) return;

  dot.dataset.status = result.ok ? "up" : "down";
  dot.title = result.ok
    ? `up — HTTP ${result.status ?? "?"}`
    : (result.error ?? `HTTP ${result.status ?? "unreachable"}`);

  latency.hidden = false;
  latency.textContent = `${result.latencyMs}ms`;
}

function markPingPending(el: Element): void {
  const dot = el.querySelector(".status-dot");
  const latency = el.querySelector(".ping-latency");
  if (dot instanceof HTMLElement) {
    dot.dataset.status = "pending";
    dot.title = "checking";
  }
  if (latency instanceof HTMLElement) {
    latency.hidden = true;
    latency.textContent = "";
  }
}

function markPingFailed(el: Element): void {
  const dot = el.querySelector(".status-dot");
  if (dot instanceof HTMLElement) {
    dot.dataset.status = "down";
    dot.title = "ping request failed";
  }
}

/** Results received so far by the pings stream in flight, for checks that join it. */
let streamedPings: Map<string, PingResult> | undefined;

/**
 * Runs one `/api/pings` stream at a time. Each result updates every tile with
 * its URL as it arrives; tiles still without a result when the stream ends or
 * fails are marked failed.
 */
const fetchPingOnce = singleFlight(async () => {
  const results = new Map<string, PingResult>();
  streamedPings = results;
  await fetchPings((result) => {
    results.set(result.url, result);
    for (const el of document.querySelectorAll<HTMLElement>("[data-ping-url]")) {
      if (el.dataset.pingUrl === result.url) applyPingResult(el, result);
    }
    updateReadout();
  }).catch(() => {
    // Tiles without a result are marked failed below.
  });
  streamedPings = undefined;
  for (const el of document.querySelectorAll<HTMLElement>("[data-ping-url]")) {
    if (el.dataset.pingUrl && !results.has(el.dataset.pingUrl)) markPingFailed(el);
  }
  updateReadout();
});

/**
 * Marks ping tiles pending and starts the pings stream. A call while a stream
 * is in flight joins it and keeps the results it has already received. Resolves
 * when the stream ends.
 */
function runPingChecks() {
  for (const el of document.querySelectorAll<HTMLElement>("[data-ping-url]")) {
    const url = el.dataset.pingUrl;
    if (!url) continue;
    const result = streamedPings?.get(url);
    if (result) applyPingResult(el, result);
    else markPingPending(el);
  }
  updateReadout();
  return fetchPingOnce();
}

/* --- Icon image fallback --- */

function initIconErrorHandling(): void {
  document.querySelector("#app")?.addEventListener(
    "error",
    (event) => {
      const img = event.target;
      if (!(img instanceof HTMLImageElement) || !img.classList.contains("service-icon-img")) return;
      img.closest(".service-icon")?.classList.add("has-error");
    },
    true,
  );
}

/* --- Init --- */

// JSON of the rendered config the page shows, so a refresh can tell when it changed.
let appliedConfigJson = "";

/** Puts the first render of `config` on the page and remembers it for later change checks. Load its theme first. */
function showConfig(app: HTMLElement, config: RenderedConfig) {
  document.title = config.title;
  app.innerHTML = render(config);
  appliedConfigJson = JSON.stringify(config);
  configureFeeds(config);
  configureWeather(config);
}

/**
 * Updates the parts of the page that come from the config: the title, the
 * Services section, and the feed and weather configuration. Machines, containers and listeners
 * stay as is; hidden sections survive because servicesHtml reads hiddenSections.
 */
function applyConfig(config: RenderedConfig) {
  document.title = config.title;
  const title = document.querySelector(".app-title");
  if (title) title.textContent = config.title;
  const services = document.querySelector("[data-services]");
  if (services) services.outerHTML = servicesHtml(config);
  configureFeeds(config);
  configureWeather(config);
}

/**
 * Re-fetches the config and applies it if what the page renders changed, then
 * saves it for the next first paint. A failed fetch keeps the page.
 */
async function syncConfig() {
  let config: HomieConfig;
  try {
    config = await fetchConfig();
  } catch {
    return;
  }
  const rendered = renderedConfig(config);
  const json = JSON.stringify(rendered);
  if (json === appliedConfigJson) return;
  appliedConfigJson = json;
  applyConfig(rendered);
  saveCachedConfig(rendered);
  // Reloads the page when the config switched themes.
  void loadThemeStyles(rendered.theme);
}

/**
 * Re-runs every check. Machines and containers start at once; pings and the
 * weather wait for the config sync so they use the current config. `withConfig = false`
 * skips the sync when the config was just loaded. Resolves once every check has
 * settled; the weather is not a check and does not hold it up.
 */
async function refreshAll(withConfig = true) {
  const sections = Promise.allSettled([loadSystemsOnce(), loadContainersOnce()]);
  if (withConfig) await syncConfig();
  void loadWeather();
  await Promise.allSettled([sections, runPingChecks()]);
}

const refreshAllOnce = singleFlight(refreshAll);

const CONFIG_RETRY_BASE_MS = 2_000;
const CONFIG_RETRY_MAX_MS = 60_000;

/** One-time page setup: theme, icon fallback, refresh schedule and click handlers. */
function setUpDashboard(app: HTMLElement) {
  initThemeSwitcher(app.querySelector<HTMLButtonElement>(".app-theme")!);
  initIconErrorHandling();
  const refreshNow = scheduleRefresh(refreshAllOnce, REFRESH_INTERVAL_MS);
  app.querySelector(".app-refresh")!.addEventListener("click", () => {
    refreshNow();
    feedController.refresh();
  });
  app.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const toggle = event.target.closest<HTMLButtonElement>("[data-section-toggle]");
    if (toggle?.dataset.sectionToggle) toggleSection(toggle.dataset.sectionToggle);
    const copyButton = event.target.closest<HTMLButtonElement>("[data-copy-address]");
    if (copyButton) void copyMachineAddress(copyButton);
  });
}

/**
 * Starts the dashboard. Every first paint waits for the configured theme's
 * stylesheet. With a config saved by the last visit it paints that at
 * once, sets up, and lets the first refresh fetch the real config: a change is
 * swapped in and only then are the pings run, so they hit the current tiles. A
 * failed fetch keeps the saved page; the normal refresh schedule retries.
 *
 * Without a saved config it loads the config and sets up exactly once. While loading
 * fails, the error stays on screen and the load is retried with exponential
 * backoff (2s, 4s ... capped at 60s), on `online`, when the page becomes
 * visible again, and from the notice's retry button. Every trigger goes through
 * one singleFlight, so overlapping triggers share a single load and setup.
 */
async function init() {
  const app = document.querySelector<HTMLDivElement>("#app")!;
  app.className = "app";

  const cached = loadCachedConfig();
  if (cached) {
    await loadThemeStyles(cached.theme);
    showConfig(app, cached);
    setUpDashboard(app);
    void refreshAllOnce();
    return;
  }

  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Aborted on success; removes the retry listeners.
  const retryTriggers = new AbortController();
  const { signal } = retryTriggers;

  const loadOnce = singleFlight(async () => {
    clearTimeout(timer);
    try {
      const rendered = renderedConfig(await fetchConfig());
      saveCachedConfig(rendered);
      await loadThemeStyles(rendered.theme);
      showConfig(app, rendered);
    } catch (err) {
      // The error needs some theme; a different configured one reloads the page once it loads.
      await loadThemeStyles();
      const delay = Math.min(CONFIG_RETRY_BASE_MS * 2 ** failures++, CONFIG_RETRY_MAX_MS);
      app.innerHTML = `<p class="app-notice"><strong>failed to load config</strong><br />${
        err instanceof Error ? escapeHtml(err.message) : "unknown error"
      }<br />retrying in ${delay / 1000}s<br /><button type="button" class="app-refresh app-retry">retry</button></p>`;
      app.querySelector(".app-retry")?.addEventListener("click", retry, { signal });
      timer = setTimeout(retry, delay);
      return;
    }

    retryTriggers.abort();
    setUpDashboard(app);
    void refreshAll(false);
  });
  function retry() {
    void loadOnce();
  }

  window.addEventListener("online", retry, { signal });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.visibilityState === "visible") retry();
    },
    { signal },
  );
  retry();
}

void init();
