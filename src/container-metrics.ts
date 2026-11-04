import type { UnifiedContainer } from "../shared/types.ts";

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

type ContainerMetrics = Pick<UnifiedContainer, "cpuPct" | "memBytes" | "netSentBps" | "netRecvBps">;

function formatQuantity(value: number | undefined, perSecond: boolean): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;

  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < BYTE_UNITS.length - 1) {
    scaled /= 1024;
    unit++;
  }

  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  const rounded = Number(scaled.toFixed(digits));
  return `${rounded} ${BYTE_UNITS[unit]}${perSecond ? "/s" : ""}`;
}

/** Formats a byte amount with binary units, or undefined when the value is unknown/invalid. */
export function formatByteSize(value: number | undefined): string | undefined {
  return formatQuantity(value, false);
}

/** Formats a bytes-per-second rate, or undefined when the value is unknown/invalid. */
export function formatByteRate(value: number | undefined): string | undefined {
  return formatQuantity(value, true);
}

/**
 * Formats the remote container metrics shown in the container table. Missing or
 * malformed values are omitted rather than rendered as a misleading zero.
 */
export function formatContainerMetrics(container: ContainerMetrics): string {
  const parts: string[] = [];
  if (
    container.cpuPct !== undefined &&
    Number.isFinite(container.cpuPct) &&
    container.cpuPct >= 0
  ) {
    parts.push(`cpu ${Math.round(container.cpuPct)}%`);
  }

  const memory = formatByteSize(container.memBytes);
  if (memory !== undefined) parts.push(`mem ${memory}`);

  const sent = formatByteRate(container.netSentBps);
  const recv = formatByteRate(container.netRecvBps);
  const directions = [
    ...(sent !== undefined ? [`↑ ${sent}`] : []),
    ...(recv !== undefined ? [`↓ ${recv}`] : []),
  ];
  if (directions.length > 0) parts.push(`net ${directions.join(" ")}`);

  return parts.join(" · ");
}
