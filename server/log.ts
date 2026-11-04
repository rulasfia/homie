type LogFields = Record<string, string | number | boolean | null | undefined>;

const failures = new Map<string, { signature: string; loggedAt: number; since: number }>();
const reportedErrors = new WeakSet<Error>();
const REPEAT_INTERVAL_MS = 5 * 60_000;
const MAX_FAILURES = 1000;

export function logEvent(level: "info" | "warn" | "error", event: string, fields: LogFields = {}) {
  console[level](JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields }));
}

/** Never include URL credentials, query parameters, or fragments in logs. */
export function safeTarget(target: string | undefined) {
  if (!target) return undefined;
  try {
    const url = new URL(target);
    if (!["http:", "https:", "tcp:", "unix:"].includes(url.protocol)) return "[unsupported URL]";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return target.startsWith("/") ? target.split(/[?#]/, 1)[0] : "[invalid URL]";
  }
}

/** Error messages/stacks can contain credentials or response bodies. Log only diagnostic metadata. */
export function errorDetails(error: unknown) {
  const details: LogFields = {};
  const causes: string[] = [];
  function visit(value: unknown, depth: number) {
    if (!(value instanceof Error) || depth > 4) return;
    const code = "code" in value && typeof value.code === "string" ? value.code : undefined;
    causes.push(code ?? value.name);
    if ("httpStatus" in value && typeof value.httpStatus === "number") {
      details.httpStatus = value.httpStatus;
    }
    if ("operation" in value && typeof value.operation === "string") {
      details.operation = value.operation;
    }
    if (value instanceof AggregateError) {
      for (const child of value.errors.slice(0, 5)) visit(child, depth + 1);
    }
    visit(value.cause, depth + 1);
  }
  visit(error, 0);
  return { ...details, error: [...new Set(causes)].join(" -> ") || "UnknownError" };
}

/** Keep unexpected API errors visible without repeating failures already logged upstream. */
export function logError(event: string, error: unknown, fields: LogFields = {}) {
  if (error instanceof Error) {
    if (reportedErrors.has(error)) return;
    reportedErrors.add(error);
  }
  logEvent("error", event, { ...fields, ...errorDetails(error) });
}

/** Log failures, changes, five-minute reminders, and recovery. Successful polls stay quiet. */
export function reportHealth(resource: string, healthy: boolean, event: string, fields: LogFields) {
  const previous = failures.get(resource);
  const now = Date.now();
  if (healthy) {
    if (previous) {
      failures.delete(resource);
      logEvent("info", `${event}.recovered`, { ...fields, outageMs: now - previous.since });
    }
    return;
  }

  // Timing varies on every request and must not defeat duplicate suppression.
  const { latencyMs: _, ...stableFields } = fields;
  const signature = JSON.stringify(stableFields);
  if (previous?.signature === signature && now - previous.loggedAt < REPEAT_INTERVAL_MS) return;

  if (!previous && failures.size >= MAX_FAILURES) {
    // Config is hot-reloaded; bound memory when targets are removed or renamed.
    const oldest = failures.keys().next().value;
    if (oldest !== undefined) failures.delete(oldest);
  }
  failures.set(resource, { signature, loggedAt: now, since: previous?.since ?? now });
  logEvent("warn", `${event}.failed`, fields);
}

/** Observe actual upstream calls, not cache hits, without changing their result. */
export async function monitor<T>(
  resource: string,
  event: string,
  fields: LogFields,
  request: () => Promise<T>,
) {
  try {
    const result = await request();
    reportHealth(resource, true, event, fields);
    return result;
  } catch (error) {
    reportHealth(resource, false, event, { ...fields, ...errorDetails(error) });
    if (error instanceof Error) reportedErrors.add(error);
    throw error;
  }
}
