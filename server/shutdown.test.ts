import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";

// Runs the real server as a child process, the way `docker stop` sees it.
it("exits with code 0 on SIGTERM", async () => {
  const child = spawn(process.execPath, [join(import.meta.dirname, "index.ts")], {
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  await new Promise<void>((resolve) => {
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("server.listening")) resolve();
    });
  });

  child.kill("SIGTERM");
  const [code, signal] = await once(child, "exit");

  expect({ code, signal }).toEqual({ code: 0, signal: null });
  expect(stdout).toContain('"event":"server.stopping","signal":"SIGTERM"');
});
