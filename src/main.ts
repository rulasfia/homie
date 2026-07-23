import "./styles/reset.css";
import "./styles/tokens.css";
import "./styles/app.css";

import type { Bookmark, HomieConfig, PingResult } from "../shared/types.ts";
import { fetchConfig, fetchPing } from "./api.ts";

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

function cardHtml(bookmark: Bookmark): string {
  const ping = bookmark.ping
    ? `<span class="ping" data-ping-url="${escapeHtml(bookmark.url)}">
         <span class="ping-latency" hidden></span>
         <span class="status-dot" data-status="pending" title="checking…"></span>
       </span>`
    : "";

  const description = bookmark.description
    ? `<span class="card-description">${escapeHtml(bookmark.description)}</span>`
    : "";

  return `
    <a class="card" href="${escapeHtml(bookmark.url)}" target="_blank" rel="noopener noreferrer">
      <span class="card-icon">${iconHtml(bookmark)}</span>
      <span class="card-body">
        <span class="card-name">${escapeHtml(bookmark.name)}</span>
        ${description}
      </span>
      ${ping}
    </a>`;
}

function render(config: HomieConfig): string {
  const groups = config.groups
    .map(
      (group) => `
      <section class="group">
        <h2 class="group-name">${escapeHtml(group.name)}</h2>
        <div class="card-grid">${group.bookmarks.map(cardHtml).join("")}</div>
      </section>`,
    )
    .join("");

  return `
    <header class="app-header">
      <h1 class="app-title">${escapeHtml(config.title)}</h1>
      <button class="app-refresh" type="button" title="re-run ping checks">refresh</button>
    </header>
    <main>${groups || `<p class="app-notice">no bookmarks configured</p>`}</main>`;
}

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

async function init(): Promise<void> {
  const app = document.querySelector<HTMLDivElement>("#app")!;
  app.className = "app";

  try {
    const config = await fetchConfig();
    document.title = config.title;
    app.innerHTML = render(config);
    app.querySelector(".app-refresh")!.addEventListener("click", runPingChecks);
    runPingChecks();
    setInterval(runPingChecks, REFRESH_INTERVAL_MS);
  } catch (err) {
    app.innerHTML = `<p class="app-notice"><strong>failed to load config</strong><br />${
      err instanceof Error ? escapeHtml(err.message) : "unknown error"
    }</p>`;
  }
}

void init();
