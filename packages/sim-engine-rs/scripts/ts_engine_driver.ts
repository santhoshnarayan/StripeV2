// Runs the TS engine over a SimData JSON file and writes a compact summary
// (per-team R1/R2/CF/Finals/Champ %, per-player mean fantasy points) to disk
// for parity comparison with the Rust engine.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const worktreeRoot = resolve(here, "..", "..", "..");

  const { runTournamentSim } = await import(
    resolve(worktreeRoot, "packages/sim/src/tournament.ts")
  );

  const [inputPath, outPath, simsArg] = process.argv.slice(2);
  const sims = Number.parseInt(simsArg ?? "2000", 10);

  const data = JSON.parse(readFileSync(inputPath, "utf8"));

  const config = {
    model: "lebron",
    sims,
    stdev: 10,
    hca: 3,
    blendWeight: 0.5,
  };

  const t0 = Date.now();
  const results = await runTournamentSim(data, config);
  const elapsed = (Date.now() - t0) / 1000;

  const summary = {
    num_sims: results.numSims,
    elapsed_sec: elapsed,
    sims_per_sec: results.numSims / Math.max(elapsed, 1e-9),
    teams: results.teams.map((t: any) => ({
      team: t.team,
      seed: t.seed,
      conference: t.conference,
      rating: t.rating,
      r1: t.r1,
      r2: t.r2,
      cf: t.cf,
      finals: t.finals,
      champ: t.champ,
    })),
    players: results.players.map((p: any) => ({
      espn_id: p.espnId,
      name: p.name,
      team: p.team,
      projected_points: p.projectedPoints,
      projected_games: p.projectedGames,
      stddev: p.stddev,
    })),
  };

  writeFileSync(outPath, JSON.stringify(summary));
  console.error(
    `TS engine: ${results.numSims} sims in ${elapsed.toFixed(2)}s (${summary.sims_per_sec.toFixed(0)} sims/sec) → ${outPath}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
