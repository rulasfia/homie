import type {
  ContainerSource,
  ContainersAllResponse,
  SystemStatus,
  SystemsResponse,
} from "../shared/types.ts";

/** Shared shape for a monitored section's visible state. */
export type MonitoringKind = "loading" | "hidden" | "empty" | "ready" | "unavailable";

export interface SystemsView {
  kind: MonitoringKind;
  systems: SystemStatus[];
  warning?: string;
}

export interface ContainersView {
  kind: MonitoringKind;
  response: ContainersAllResponse | null;
  warning?: string;
}

export type LoadOutcome<T> = { ok: true; value: T } | { ok: false };

export const initialSystemsView: SystemsView = { kind: "loading", systems: [] };
export const initialContainersView: ContainersView = { kind: "loading", response: null };

const STALE_WARNING = "Refresh failed; showing the last update.";

function staleWarning(previous?: string): string {
  if (!previous) return STALE_WARNING;
  return previous.endsWith(STALE_WARNING) ? previous : `${previous} ${STALE_WARNING}`;
}

/** Names configured sources that failed, so healthy data is not mistaken for complete data. */
export function sourceWarning(sources: ContainerSource[]): string | undefined {
  const failed = sources.filter((source) => source.error);
  if (failed.length === 0) return undefined;

  const labels = failed.map((source) =>
    source.error ? `${source.name} (${source.error})` : source.name,
  );
  return `Sources unavailable: ${labels.join(", ")}.`;
}

/**
 * Resolves a systems response against the previous view. Failures after a
 * successful load keep the prior data and mark it stale; failures before any
 * data show an unavailable state instead of leaving skeletons up forever.
 */
export function nextSystemsView(
  previous: SystemsView,
  outcome: LoadOutcome<SystemsResponse>,
): SystemsView {
  if (outcome.ok) {
    const { configured, systems } = outcome.value;
    if (!configured) return { kind: "hidden", systems: [] };
    if (systems.length === 0) return { kind: "empty", systems: [] };
    return { kind: "ready", systems };
  }

  if (previous.kind === "hidden") return previous;
  if (previous.kind === "ready" || previous.kind === "empty") {
    return { ...previous, warning: staleWarning(previous.warning) };
  }
  return { kind: "unavailable", systems: [] };
}

/**
 * Resolves a containers response against the previous view. Source errors stay
 * visible alongside the healthy rows, and a successful response clears any
 * stale or partial warning from the previous load.
 */
export function nextContainersView(
  previous: ContainersView,
  outcome: LoadOutcome<ContainersAllResponse>,
): ContainersView {
  if (outcome.ok) {
    const response = outcome.value;
    if (!response.configured) return { kind: "hidden", response: null };
    const warning =
      sourceWarning(response.sources) ??
      (response.partial ? "Some sources are unavailable." : undefined);
    if (response.containers.length === 0) return { kind: "empty", response, warning };
    return { kind: "ready", response, warning };
  }

  if (previous.kind === "hidden") return previous;
  if ((previous.kind === "ready" || previous.kind === "empty") && previous.response) {
    return { ...previous, warning: staleWarning(previous.warning) };
  }
  return { kind: "unavailable", response: null };
}
