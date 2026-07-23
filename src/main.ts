import "./styles/reset.css";
import "./styles/tokens.css";
import "./styles/app.css";

import type {
  Bookmark,
  ContainerInfo,
  HomieConfig,
  PingResult,
  SystemStatus,
} from "../shared/types.ts";
import { fetchConfig, fetchContainers, fetchPing, fetchSystems } from "./api.ts";

const REFRESH_INTERVAL_MS = 60_000;

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function iconHtml(bookmark: Bookmark): string {
  const icon = bookmark.icon ?? bookmark.name.charAt(0).toUpperCase();
  if (icon.startsWith("http://") || icon.startsWith("https://") || icon.startsWith("/")) {
    return `<img src="${escapeHtml(icon)}" alt="" loading="lazy" />`;
  }
  return escapeHtml(icon);
}

function serviceHtml(bookmark: Bookmark, category: string): string {
  const ping = bookmark.ping
    ? `<span class="ping service-health" data-ping-url="${escapeHtml(bookmark.url)}">
         <span class="status-dot" data-status="pending"></span>
         <span class="ping-latency" hidden></span>
       </span>`
    : "";

  const description = bookmark.description ? ` title="${escapeHtml(bookmark.description)}"` : "";

  return `
    <a class="service" href="${escapeHtml(bookmark.url)}" target="_blank" rel="noopener noreferrer"${description}>
      <span class="service-icon">${iconHtml(bookmark)}</span>
      <span class="service-body">
        <span class="service-name">${escapeHtml(bookmark.name)}</span>
        <span class="service-category">${escapeHtml(category)}</span>
      </span>
      ${ping}
    </a>`;
}

function render(config: HomieConfig): string {
  const services = config.groups.flatMap((group) =>
    group.bookmarks.map((bookmark) => serviceHtml(bookmark, group.name)),
  );

  const servicesSection =
    services.length > 0
      ? `<section class="group" id="services">
           <h2 class="group-name">Services</h2>
           <div class="service-grid">${services.join("")}</div>
         </section>`
      : `<p class="app-notice">no bookmarks configured</p>`;

  return `
    <header class="app-header">
      <h1 class="app-title">${escapeHtml(config.title)}</h1>
      <button class="app-refresh" type="button" title="re-run checks">refresh</button>
    </header>
    <main>
      <section class="group" id="systems">
        <h2 class="group-name">Machines</h2>
        <div class="card-grid" id="systems-grid">
          ${[1, 2, 3].map(systemSkeletonCardHtml).join("")}
        </div>
      </section>
      <section class="group" id="containers">
        <h2 class="group-name">Containers</h2>
        <div class="container-wrapper">
          <table class="container-table" id="containers-table">
            ${containerHeaderHtml()}
            <tbody>${[1, 2, 3, 4, 5].map(containerSkeletonRowHtml).join("")}</tbody>
          </table>
        </div>
      </section>
      ${servicesSection}
    </main>`;
}

/* --- Machines (Beszel) --- */

function meterLevel(pct: number): "ok" | "warn" | "crit" {
  if (pct >= 90) return "crit";
  if (pct >= 75) return "warn";
  return "ok";
}

function meterHtml(label: string, pct: number): string {
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

function formatMemory(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return `${gb >= 10 ? gb.toFixed(1) : gb.toFixed(2)} GB`;
}

function specHtml(system: SystemStatus): string {
  const specs = system.specs ?? {};
  const cpu = specs.cpuModel;
  const cores = specs.cores;
  const threads = specs.threads;
  const memory = specs.memoryTotalBytes;
  const osName = specs.osName;

  const parts: string[] = [];
  if (cores && threads) parts.push(`${cores}c / ${threads}t`);
  else if (cores) parts.push(`${cores} cores`);
  else if (threads) parts.push(`${threads} threads`);
  if (memory) parts.push(formatMemory(memory));
  if (osName) parts.push(osName);

  const cpuLine = cpu ? `<div class="system-specs">${escapeHtml(cpu)}</div>` : "";
  const specLine =
    parts.length > 0
      ? `<div class="system-specs" title="${escapeHtml(parts.join(" · "))}">${escapeHtml(parts.join(" · "))}</div>`
      : "";

  if (!cpuLine && !specLine) return "";
  return `${cpuLine}${specLine}`;
}

function systemMeta(system: SystemStatus): string {
  const up = system.status === "up";
  const load = system.loadAvg?.map((n) => n.toFixed(2)).join(" · ");
  const meta = [
    up && system.uptime > 0 ? `up ${formatUptime(system.uptime)}` : system.status,
    system.temp !== undefined ? `${Math.round(system.temp)}°C` : null,
    load ? `load ${load}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return meta ? `<div class="system-meta">${escapeHtml(meta)}</div>` : "";
}

function systemCardHtml(system: SystemStatus): string {
  const up = system.status === "up";

  return `
    <div class="system-card">
      <div class="system-header">
        <span class="status-dot" data-status="${up ? "up" : "down"}" title="${escapeHtml(system.status)}"></span>
        <span class="system-name">${escapeHtml(system.name)}</span>
      </div>
      ${systemMeta(system)}
      <div class="system-meters">
        ${meterHtml("cpu", system.cpu)}
        ${meterHtml("mem", system.memPct)}
        ${meterHtml("disk", system.diskPct)}
      </div>
      ${specHtml(system)}
    </div>`;
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
      <div class="system-specs"><span class="skeleton-line" style="width: 70%"></span></div>
    </div>`;
}

async function loadSystems(): Promise<void> {
  const section = document.querySelector("#systems");
  const grid = document.querySelector("#systems-grid");
  if (!section || !grid) return;

  try {
    const { configured, systems } = await fetchSystems();
    if (!configured || systems.length === 0) {
      (section as HTMLElement).hidden = true;
      return;
    }
    grid.innerHTML = systems.map(systemCardHtml).join("");
    (section as HTMLElement).hidden = false;
  } catch {
    // Keep showing the last known state on transient failures.
  }
}

/* --- Containers (Docker) --- */

function containerDotStatus(state: string): "up" | "down" | "pending" | "unknown" {
  if (state === "running") return "up";
  if (state === "paused" || state === "restarting") return "pending";
  if (state === "exited" || state === "dead") return "down";
  return "unknown";
}

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

function containerRowHtml(container: ContainerInfo): string {
  return `
    <tr class="container-row">
      <td class="container-col-status">
        <span class="status-dot" data-status="${containerDotStatus(container.state)}" title="${escapeHtml(container.state)}"></span>
      </td>
      <td class="container-col-name" title="${escapeHtml(container.id)}">${escapeHtml(container.name)}</td>
      <td class="container-col-image">${escapeHtml(container.image)}</td>
      <td class="container-col-uptime">${escapeHtml(container.status)}</td>
      <td class="container-col-ports">${container.ports.length > 0 ? escapeHtml(container.ports.join("  ")) : "—"}</td>
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

async function loadContainers(): Promise<void> {
  const section = document.querySelector("#containers");
  const table = document.querySelector("#containers-table");
  if (!section || !table) return;

  try {
    const { configured, containers } = await fetchContainers();
    if (!configured || containers.length === 0) {
      (section as HTMLElement).hidden = true;
      return;
    }
    table.innerHTML =
      containerHeaderHtml() + `<tbody>${containers.map(containerRowHtml).join("")}</tbody>`;
    (section as HTMLElement).hidden = false;
  } catch {
    // Keep showing the last known state on transient failures.
  }
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

function runPingChecks(): void {
  for (const el of document.querySelectorAll("[data-ping-url]")) {
    const dot = el.querySelector(".status-dot");
    if (dot instanceof HTMLElement) dot.dataset.status = "pending";

    const url = (el as HTMLElement).dataset.pingUrl!;
    fetchPing(url)
      .then((result) => applyPingResult(el, result))
      .catch(() => {
        if (dot instanceof HTMLElement) {
          dot.dataset.status = "down";
          dot.title = "ping request failed";
        }
      });
  }
}

/* --- Init --- */

function refreshAll(): void {
  runPingChecks();
  void loadSystems();
  void loadContainers();
}

async function init(): Promise<void> {
  const app = document.querySelector<HTMLDivElement>("#app")!;
  app.className = "app";

  try {
    const config = await fetchConfig();
    document.title = config.title;
    app.innerHTML = render(config);
    app.querySelector(".app-refresh")!.addEventListener("click", refreshAll);
    refreshAll();
    setInterval(refreshAll, REFRESH_INTERVAL_MS);
  } catch (err) {
    app.innerHTML = `<p class="app-notice"><strong>failed to load config</strong><br />${
      err instanceof Error ? escapeHtml(err.message) : "unknown error"
    }</p>`;
  }
}

void init();
