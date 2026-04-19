#!/usr/bin/env node
// Runs the TypeScript engine (`packages/sim/src/tournament.ts`) using `tsx`
// and writes a compact JSON summary that the parity test can compare against.
//
// Usage:  node scripts/run_ts_engine.mjs <sim-data.json> <out.json> [sims=2000]
//
// We use child_process.spawn so we can rely on the prebuilt `tsx` from the
// main repo (worktrees don't have node_modules).

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const worktreeRoot = resolve(here, "..", "..", "..");
// Worktrees nest under <repo>/.claude/worktrees/<name>/, so the main repo
// root is four levels up from a script in packages/sim-engine-rs/scripts.
const mainRepoRoot = resolve(worktreeRoot, "..", "..", "..");

// Resolve tsx — first try worktree node_modules, then several main-repo paths.
const tsxCandidates = [
  resolve(worktreeRoot, "node_modules/.bin/tsx"),
  resolve(mainRepoRoot, "node_modules/.bin/tsx"),
  resolve(mainRepoRoot, "node_modules/.pnpm/node_modules/.bin/tsx"),
  resolve(mainRepoRoot, "apps/server/node_modules/.bin/tsx"),
];
const tsx = tsxCandidates.find((p) => existsSync(p));
if (!tsx) {
  console.error("Could not find tsx binary in either:");
  for (const c of tsxCandidates) console.error("  -", c);
  process.exit(2);
}

const [inputPath, outPath, simsArg] = process.argv.slice(2);
if (!inputPath || !outPath) {
  console.error("usage: run_ts_engine.mjs <sim-data.json> <out.json> [sims]");
  process.exit(2);
}
const sims = Number.parseInt(simsArg ?? "2000", 10);
const driver = resolve(here, "ts_engine_driver.ts");

const child = spawn(tsx, [driver, inputPath, outPath, String(sims)], {
  stdio: "inherit",
  env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" },
});
child.on("exit", (code) => process.exit(code ?? 1));
