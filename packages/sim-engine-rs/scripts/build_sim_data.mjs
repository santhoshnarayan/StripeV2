#!/usr/bin/env node
// Combines the apps/server static JSON files into a single SimData blob the
// Rust crate can deserialize. Mirrors the shape consumed by `runTournamentSim`
// in `packages/sim/src/tournament.ts`.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const dataDir = resolve(repoRoot, "apps/server/src/data");

const bracket = JSON.parse(readFileSync(resolve(dataDir, "nba-bracket-2026.json"), "utf8"));
const netRatings = JSON.parse(readFileSync(resolve(dataDir, "nba-net-ratings-2026.json"), "utf8"));
const simPlayers = JSON.parse(readFileSync(resolve(dataDir, "nba-players-2026.json"), "utf8"));
const playoffMinutes = JSON.parse(readFileSync(resolve(dataDir, "nba-playoff-minutes-2026.json"), "utf8"));
const adjustments = JSON.parse(readFileSync(resolve(dataDir, "nba-adjustments-2026.json"), "utf8"));
const injuries = JSON.parse(readFileSync(resolve(dataDir, "nba-injuries-2026.json"), "utf8"));
let actualsByGame = {};
try {
  actualsByGame = JSON.parse(
    readFileSync(resolve(dataDir, "nba-playoff-minutes-actual-2026.json"), "utf8"),
  );
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}

// Inject default availability arrays on adjustments — TS treats missing as all 1s.
for (const a of adjustments) {
  if (!a.availability) a.availability = Array(30).fill(1.0);
}

// Drop fields the Rust deserializer doesn't understand (extra `_note`s, etc.).
// `bracket` has `playinR1`, `playinR2`, `eliminatedTeams` — keep them as the
// Rust serde struct ignores unknown fields by default. Done.

const out = {
  bracket,
  netRatings,
  simPlayers,
  playoffMinutes,
  adjustments,
  injuries,
  liveGames: [],
  actualsByGame,
};

const target = process.argv[2] ?? resolve(here, "..", "fixtures", "sim-data.json");
const dir = dirname(target);
try {
  // ensureDir
  writeFileSync(target, JSON.stringify(out));
} catch (e) {
  if (e.code === "ENOENT") {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, JSON.stringify(out));
  } else {
    throw e;
  }
}
console.error(`wrote ${target} (${(JSON.stringify(out).length / 1024).toFixed(1)} KB)`);
