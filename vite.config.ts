import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import type { Plugin } from "vite-plus";
import { defineConfig } from "vite-plus";

function getCacheVersion(): string {
  if (process.env.HOMIE_VERSION) return process.env.HOMIE_VERSION;
  try {
    return execSync("git describe --tags --always", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
  } catch {
    // not a git repo or no tags
  }
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as { version?: string };
    if (pkg.version && pkg.version !== "0.0.0") return `v${pkg.version}`;
  } catch {
    // package.json unreadable
  }
  return "dev";
}

function swCacheVersionPlugin(): Plugin {
  return {
    name: "homie-sw-cache-version",
    apply: "build",
    closeBundle() {
      const swPath = "dist/sw.js";
      const sw = readFileSync(swPath, "utf-8");
      writeFileSync(swPath, sw.replace("__HOMIE_CACHE_VERSION__", getCacheVersion()));
    },
  };
}

export default defineConfig({
  plugins: [swCacheVersionPlugin()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    ignorePatterns: [".agents/**", ".claude/**"],
  },
  lint: {
    ignorePatterns: [".agents/**", ".claude/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    passWithNoTests: true,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,github,gitlab}/**",
      "**/.nuxt/**",
      "**/playwright/**",
      "**/.svelte-kit/**",
      "**/.agents/**",
      "**/.claude/**",
    ],
  },
});
