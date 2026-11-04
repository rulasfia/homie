export type ContainerLed = "up" | "warn" | "down" | "pending" | "unknown";

/**
 * Maps a container's Docker state plus optional status text (e.g. "Up 3 hours (unhealthy)")
 * to a status LED and a short tooltip label. Remote containers have no status text and
 * are judged by state alone.
 */
export function containerStatus(state: string, status?: string) {
  if (state === "running") {
    if (status?.includes("(unhealthy)"))
      return { led: "warn", label: "running, unhealthy" } as const;
    if (status?.includes("(health: starting)")) {
      return { led: "pending", label: "running, starting" } as const;
    }
    return { led: "up", label: state } as const;
  }
  if (state === "paused" || state === "restarting")
    return { led: "pending", label: state } as const;
  if (state === "exited" || state === "dead") return { led: "down", label: state } as const;
  return { led: "unknown", label: state } as const;
}
