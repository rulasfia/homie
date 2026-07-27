import "./styles/reset.css";
import "./styles/tokens.css";
import "./styles/app.css";

import type {
  Bookmark,
  ContainersAllResponse,
  HomieConfig,
  PingResult,
  SystemStatus,
  UnifiedContainer,
} from "../shared/types.ts";
import { fetchAllContainers, fetchConfig, fetchPing, fetchSystems } from "./api.ts";

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

let lastContainersResponse: ContainersAllResponse | null = null;
let selectedContainerMachine = "";

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
  localStorage.setItem(HIDDEN_SECTIONS_KEY, JSON.stringify([...hiddenSections]));
  applySectionVisibility(sectionId);
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function iconHtml(bookmark: Bookmark): string {
  const fallback = bookmark.name.charAt(0).toUpperCase();
  const icon = bookmark.icon?.trim() ?? fallback;
  if (icon.startsWith("http://") || icon.startsWith("https://") || icon.startsWith("/")) {
    return `
      <img class="service-icon-img" src="${escapeHtml(icon)}" alt="" loading="lazy" />
      <span class="service-icon-fallback" aria-hidden="true">${escapeHtml(fallback)}</span>`;
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

function render(config: HomieConfig): string {
  const services = config.groups.flatMap((group) =>
    group.bookmarks.map((bookmark) => serviceHtml(bookmark, group.name)),
  );

  const servicesSection =
    services.length > 0
      ? `<section class="${sectionClass("services")}" id="services">
           <div class="section-header">
             <h2 class="group-name">Services</h2>
             ${sectionToggleHtml("services")}
           </div>
           <div class="section-body">
             <div class="service-grid">${services.join("")}</div>
           </div>
         </section>`
      : `<p class="app-notice">no bookmarks configured</p>`;

  return `
    <header class="app-header">
      <h1 class="app-title">${escapeHtml(config.title)}</h1>
      <button class="app-refresh" type="button" title="re-run checks">refresh</button>
    </header>
    <main>
      <section class="${sectionClass("systems")}" id="systems">
        <div class="section-header">
          <h2 class="group-name">Machines</h2>
          ${sectionToggleHtml("systems")}
        </div>
        <div class="section-body">
          <div class="card-grid" id="systems-grid">
            ${[1, 2, 3].map(systemSkeletonCardHtml).join("")}
          </div>
        </div>
      </section>
      ${servicesSection}
      <section class="${sectionClass("containers")}" id="containers">
        <div class="section-header">
          <h2 class="group-name">Containers</h2>
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
          <div class="container-wrapper">
            <table class="container-table" id="containers-table">
              ${containerHeaderHtml()}
              <tbody>${[1, 2, 3, 4, 5].map(containerSkeletonRowHtml).join("")}</tbody>
            </table>
          </div>
        </div>
      </section>
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

function copyAddressButtonHtml(address: string | undefined): string {
  if (!address?.trim()) return "";

  return `
    <button class="system-copy" type="button" data-copy-address="${encodeURIComponent(address)}"
            aria-label="Copy address" title="copy address">
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

function systemCardHtml(system: SystemStatus): string {
  const up = system.status === "up";

  return `
    <div class="system-card">
      <div class="system-header">
        <span class="status-dot" data-status="${up ? "up" : "down"}" title="${escapeHtml(system.status)}"></span>
        <span class="system-name">${escapeHtml(system.name)}</span>
        ${copyAddressButtonHtml(system.address)}
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
      button.title = "copy address";
      button.setAttribute("aria-label", "Copy address");
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
        <th class="container-col-machine" scope="col">Machine</th>
        <th class="container-col-image" scope="col">Image</th>
        <th class="container-col-uptime" scope="col">Status</th>
        <th class="container-col-ports" scope="col">Ports</th>
      </tr>
    </thead>`;
}

function formatRemoteStats(container: UnifiedContainer): string {
  const parts: string[] = [];
  if (container.cpuPct !== undefined) parts.push(`cpu ${Math.round(container.cpuPct)}%`);
  if (container.memPct !== undefined) parts.push(`mem ${Math.round(container.memPct)}%`);
  return parts.join(" · ");
}

function containerRowHtml(container: UnifiedContainer): string {
  const isRemote = container.source === "remote";
  const title = isRemote ? container.systemName : (container.id ?? "");
  const statusText = isRemote ? formatRemoteStats(container) || "—" : (container.status ?? "—");
  const imageText = container.image ?? "—";
  const portsText =
    !isRemote && container.ports && container.ports.length > 0
      ? escapeHtml(container.ports.join("  "))
      : "—";

  return `
    <tr class="container-row">
      <td class="container-col-status">
        <span class="status-dot" data-status="${containerDotStatus(container.state)}" title="${escapeHtml(container.state)}"></span>
      </td>
      <td class="container-col-name" title="${escapeHtml(title)}">${escapeHtml(container.name)}</td>
      <td class="container-col-machine">${escapeHtml(container.systemName)}</td>
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
      <td class="container-col-machine"><span class="skeleton-cell" style="width: 60%"></span></td>
      <td class="container-col-image"><span class="skeleton-cell" style="width: 80%"></span></td>
      <td class="container-col-uptime"><span class="skeleton-cell" style="width: 60%"></span></td>
      <td class="container-col-ports"><span class="skeleton-cell" style="width: 75%"></span></td>
    </tr>`;
}

function renderContainerFilter(sources: Array<{ id: string; name: string }>): void {
  const select = document.querySelector<HTMLSelectElement>("#container-machine-filter");
  if (!select) return;

  const hasMultiple = sources.length > 1;
  select.disabled = !hasMultiple;
  select.innerHTML = [
    `<option value="">All machines</option>`,
    ...sources.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`),
  ].join("");

  if (selectedContainerMachine) {
    select.value = selectedContainerMachine;
  }
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
  const table = document.querySelector("#containers-table");
  if (!table || !lastContainersResponse) return;

  const containers = filterContainers(lastContainersResponse);
  table.innerHTML =
    containerHeaderHtml() + `<tbody>${containers.map(containerRowHtml).join("")}</tbody>`;
}

async function loadContainers(): Promise<void> {
  const section = document.querySelector("#containers");
  const table = document.querySelector("#containers-table");
  const select = document.querySelector<HTMLSelectElement>("#container-machine-filter");
  if (!section || !table) return;

  try {
    const response = await fetchAllContainers();
    lastContainersResponse = response;
    if (!response.configured || response.containers.length === 0) {
      (section as HTMLElement).hidden = true;
      return;
    }

    renderContainerFilter(response.sources);
    if (select) {
      select.onchange = (event) => {
        selectedContainerMachine = (event.target as HTMLSelectElement).value;
        applyContainerFilter();
      };
    }

    const containers = filterContainers(response);
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
    initIconErrorHandling();
    app.querySelector(".app-refresh")!.addEventListener("click", refreshAll);
    app.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;
      const toggle = event.target.closest<HTMLButtonElement>("[data-section-toggle]");
      if (toggle?.dataset.sectionToggle) toggleSection(toggle.dataset.sectionToggle);
      const copyButton = event.target.closest<HTMLButtonElement>("[data-copy-address]");
      if (copyButton) void copyMachineAddress(copyButton);
    });
    refreshAll();
    setInterval(refreshAll, REFRESH_INTERVAL_MS);
  } catch (err) {
    app.innerHTML = `<p class="app-notice"><strong>failed to load config</strong><br />${
      err instanceof Error ? escapeHtml(err.message) : "unknown error"
    }</p>`;
  }
}

void init();
