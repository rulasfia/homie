import { expect, it } from "vite-plus/test";
import { containerStatus } from "./container-status.ts";

it.each([
  ["healthy", "running", "Up 3 hours (healthy)", "up", "running"],
  ["unhealthy", "running", "Up 3 hours (unhealthy)", "warn", "running, unhealthy"],
  ["starting", "running", "Up 5 seconds (health: starting)", "pending", "running, starting"],
  ["no healthcheck", "running", "Up 3 hours", "up", "running"],
  ["exited", "exited", "Exited (0) 2 hours ago", "down", "exited"],
  ["dead", "dead", "Dead", "down", "dead"],
  ["paused", "paused", "Up 3 hours (Paused)", "pending", "paused"],
  ["restarting", "restarting", "Restarting (1) 5 seconds ago", "pending", "restarting"],
  ["unknown", "created", "Created", "unknown", "created"],
  ["remote, no status", "running", undefined, "up", "running"],
])("%s", (_name, state, status, led, label) => {
  expect(containerStatus(state, status)).toEqual({ led, label });
});
