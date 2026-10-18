#!/usr/bin/env node
// Launches the `mcp-server` package from a checkout, building it first when
// `dist` is missing or older than its sources. Build output goes to stderr
// because stdout carries the MCP protocol.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "mcp-server");
const entry = join(pkg, "dist", "index.js");

function newestMtime(dir) {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    newest = Math.max(
      newest,
      e.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs,
    );
  }
  return newest;
}

const stale =
  !existsSync(entry) || newestMtime(join(pkg, "src")) > statSync(entry).mtimeMs;

if (stale) {
  const { status, error } = spawnSync(
    "pnpm",
    ["--dir", root, "--filter", "mcp-server", "build"],
    { stdio: ["ignore", process.stderr, process.stderr] },
  );
  if (status !== 0) {
    console.error(
      `phone-claude: building mcp-server failed${error ? `: ${error.message}` : ""}. Run \`pnpm install\` in ${root}.`,
    );
    process.exit(status ?? 1);
  }
}

await import(pathToFileURL(entry).href);
