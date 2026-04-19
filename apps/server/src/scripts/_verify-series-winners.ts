/**
 * Slice 1 sense-check: emit `seriesWinners` + `playinSeeds` from the TS engine
 * and verify the reconstructed counts match the existing per-team aggregates.
 *
 *   pnpm --filter @repo/server tsx src/scripts/_verify-series-winners.ts
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_SIM_CONFIG,
  PLAYIN_KEYS,
  SERIES_KEYS,
  runTournamentSim,
  type SimData,
} from "@repo/sim";

async function loadStaticSimData() {
  const dataDir = path.resolve(process.cwd(), "src/data");
  const [bracket, netRatings, simPlayers, playoffMinutes, adjustments, injuries] =
    await Promise.all([
      readFile(path.join(dataDir, "nba-bracket-2026.json"), "utf8"),
      readFile(path.join(dataDir, "nba-net-ratings-2026.json"), "utf8"),
      readFile(path.join(dataDir, "nba-players-2026.json"), "utf8"),
      readFile(path.join(dataDir, "nba-playoff-minutes-2026.json"), "utf8"),
      readFile(path.join(dataDir, "nba-adjustments-2026.json"), "utf8"),
      readFile(path.join(dataDir, "nba-injuries-2026.json"), "utf8"),
    ]);
  return {
    bracket: JSON.parse(bracket),
    netRatings: JSON.parse(netRatings),
    simPlayers: JSON.parse(simPlayers),
    playoffMinutes: JSON.parse(playoffMinutes),
    adjustments: JSON.parse(adjustments),
    injuries: JSON.parse(injuries),
  };
}

function pct(n: number, total: number) {
  return ((n / total) * 100).toFixed(2);
}

async function main() {
  const N = 500;
  const base = await loadStaticSimData();
  const simData: SimData = { ...base };
  const results = await runTournamentSim(simData, { ...DEFAULT_SIM_CONFIG, sims: N });

  const { teams, teamNames, teamIndex, seriesWinners, playinSeeds, numSims } = results;

  console.log(`Sims: ${numSims}`);
  console.log(`teamNames (${teamNames.length}):`, teamNames.join(", "));

  // ── 1. No unset entries ───────────────────────────────────────────────
  let unsetSeries = 0;
  let unsetPlayin = 0;
  for (const k of SERIES_KEYS) {
    const arr = seriesWinners[k];
    for (let i = 0; i < arr.length; i++) if (arr[i] === 0xff) unsetSeries++;
  }
  for (const k of PLAYIN_KEYS) {
    const arr = playinSeeds[k];
    for (let i = 0; i < arr.length; i++) if (arr[i] === 0xff) unsetPlayin++;
  }
  console.log(`Unset series winner entries: ${unsetSeries} (must be 0)`);
  console.log(`Unset play-in seed entries: ${unsetPlayin} (must be 0)`);

  // ── 2. Reconstruct team aggregates from seriesWinners and compare ────
  const r1ByIdx = new Uint32Array(teamNames.length);
  const r2ByIdx = new Uint32Array(teamNames.length);
  const cfByIdx = new Uint32Array(teamNames.length);
  const finalsByIdx = new Uint32Array(teamNames.length);
  const champByIdx = new Uint32Array(teamNames.length);

  const r1Keys = SERIES_KEYS.filter((k) => k.startsWith("r1."));
  const r2Keys = SERIES_KEYS.filter((k) => k.startsWith("r2."));
  const cfKeys = SERIES_KEYS.filter((k) => k.startsWith("cf."));

  for (const k of r1Keys) {
    const arr = seriesWinners[k];
    for (let i = 0; i < N; i++) r1ByIdx[arr[i]]++;
  }
  for (const k of r2Keys) {
    const arr = seriesWinners[k];
    for (let i = 0; i < N; i++) r2ByIdx[arr[i]]++;
  }
  for (const k of cfKeys) {
    const arr = seriesWinners[k];
    for (let i = 0; i < N; i++) cfByIdx[arr[i]]++;
  }
  // Note: in the existing engine `teams[].finals` and `teams[].champ` both
  // count finals winners (existing oddity — `finalsCounts` and `champCounts`
  // are written by the same line). So both reconstruct from `seriesWinners.finals`.
  {
    const arr = seriesWinners.finals;
    for (let i = 0; i < N; i++) {
      finalsByIdx[arr[i]]++;
      champByIdx[arr[i]]++;
    }
  }

  // ── 3. Compare with teams[] aggregates ────────────────────────────────
  let mismatches = 0;
  console.log("\n  team   | seed |  r1%  reconst |  r2%  reconst |  cf%  reconst |  fin%  reconst | champ% reconst");
  console.log("  -------+------+---------------+---------------+---------------+----------------+----------------");
  for (const t of teams) {
    const idx = teamIndex.get(t.team);
    if (idx == null) continue;
    const recR1 = (r1ByIdx[idx] / N) * 100;
    const recR2 = (r2ByIdx[idx] / N) * 100;
    const recCf = (cfByIdx[idx] / N) * 100;
    const recFin = (finalsByIdx[idx] / N) * 100;
    const recCh = (champByIdx[idx] / N) * 100;
    const ok = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    if (!ok(t.r1, recR1) || !ok(t.r2, recR2) || !ok(t.cf, recCf) || !ok(t.finals, recFin) || !ok(t.champ, recCh)) {
      mismatches++;
    }
    if (t.champ > 0 || t.finals > 0) {
      console.log(
        `  ${t.team.padEnd(6)} | ${(t.seed ?? "").toString().padStart(4)} | ${t.r1.toFixed(2).padStart(6)} ${recR1.toFixed(2).padStart(6)} | ${t.r2.toFixed(2).padStart(6)} ${recR2.toFixed(2).padStart(6)} | ${t.cf.toFixed(2).padStart(6)} ${recCf.toFixed(2).padStart(6)} | ${t.finals.toFixed(2).padStart(6)} ${recFin.toFixed(2).padStart(6)}  | ${t.champ.toFixed(2).padStart(6)} ${recCh.toFixed(2).padStart(6)}`,
      );
    }
  }
  console.log(`\nMismatches between teams[] and reconstruction from seriesWinners: ${mismatches} (must be 0)`);

  // ── 4. Sanity: play-in seed assignments are play-in teams ────────────
  console.log("\nPlay-in seed assignments (sim 0..3):");
  for (const k of PLAYIN_KEYS) {
    const arr = playinSeeds[k];
    const sample = [arr[0], arr[1], arr[2], arr[3]].map((i) => teamNames[i] ?? `idx=${i}`);
    console.log(`  ${k}: ${sample.join(", ")}`);
  }

  // ── 5. Sanity: every series key has the correct champion-of-finals → champ ───
  // For sims where finals[sim] = X, X reached round 5 (champion).
  let trrConsistent = true;
  for (let sim = 0; sim < N; sim++) {
    const champIdx = seriesWinners.finals[sim];
    const champTeam = teamNames[champIdx];
    const arr = results.teamRoundReached[champTeam];
    if (!arr || arr[sim] !== 5) {
      trrConsistent = false;
      console.log(`  sim ${sim}: champ=${champTeam} but teamRoundReached=${arr?.[sim]}`);
      break;
    }
  }
  console.log(`teamRoundReached consistent with finals winner: ${trrConsistent}`);

  // ── 6. Bracket conditioning preview: if user forces "EAST 1v8 winner = X",
  //      what fraction of sims survive, and recompute champ% over the survivors?
  const e1v8 = seriesWinners["r1.east.1v8"];
  // Pick the most common winner of that series
  const counts: Record<number, number> = {};
  for (let i = 0; i < N; i++) counts[e1v8[i]] = (counts[e1v8[i]] ?? 0) + 1;
  const forcedIdx = Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
  const forcedTeam = teamNames[forcedIdx];
  let surviving = 0;
  const condChamp = new Uint32Array(teamNames.length);
  for (let i = 0; i < N; i++) {
    if (e1v8[i] !== forcedIdx) continue;
    surviving++;
    condChamp[seriesWinners.finals[i]]++;
  }
  console.log(`\nForce r1.east.1v8 winner = ${forcedTeam}: ${surviving}/${N} sims survive (${pct(surviving, N)}%)`);
  console.log("Top 5 conditional champ% under that constraint:");
  const ranked = Array.from(condChamp)
    .map((c, i) => ({ team: teamNames[i], pct: surviving > 0 ? (c / surviving) * 100 : 0 }))
    .filter((r) => r.team)
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 5);
  for (const r of ranked) console.log(`  ${r.team.padEnd(6)} ${r.pct.toFixed(2)}%`);

  process.exit(mismatches === 0 && unsetSeries === 0 && unsetPlayin === 0 && trrConsistent ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
