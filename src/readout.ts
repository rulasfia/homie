type ReadoutStatus = "up" | "down" | "pending";

/** Rolls one check status per pinged URL up into the service counts and header's power LED. */
export function summarizeChecks(statuses: Iterable<string | undefined>): {
  status: ReadoutStatus | null;
  text: string;
} {
  const list = [...statuses];
  if (list.length === 0) return { status: null, text: "" };
  const up = list.filter((s) => s === "up").length;
  if (list.some((s) => s === "pending")) {
    return { status: "pending", text: `checking ${list.length} services` };
  }
  return { status: up === list.length ? "up" : "down", text: `${up}/${list.length} services up` };
}
