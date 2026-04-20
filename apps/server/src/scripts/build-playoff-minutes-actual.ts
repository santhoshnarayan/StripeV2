/**
 * Emit per-game playoff minutes so the engine can build cumulative snapshots
 * without leaking game G's own actuals into sim(G).
 *
 * Output file: src/data/nba-playoff-minutes-actual-2026.json
 * Shape:
 *   { team: { nba_id: { availIdx: minutes } } }
 *
 * availIdx layout (30 slots, same as injury availability arrays):
 *     0..1    play-in P1, P2        (not emitted — playoffs only)
 *     2..8    R1G1..R1G7
 *     9..15   R2G1..R2G7
 *    16..22   CFG1..CFG7
 *    23..29   FG1..FG7
 *
 * The engine aggregates cumulatively at prepare time: when simulating the
 * game at availIdx G, it uses actuals from all slots < G. G=2 (R1G1) has
 * no prior actuals → pure pre-projection. G=3 (R1G2) gets R1G1's data, etc.
 * A player absent from a slot means they didn't play that game (or DNP'd).
 *
 * Run:
 *   pnpm --filter @repo/server tsx src/scripts/build-playoff-minutes-actual.ts
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { db } from "@repo/db";
import { nbaGame, nbaPlayerGameStats } from "@repo/db/schema";
import { and, eq, isNotNull, sql } from "drizzle-orm";

interface Player {
  espn_id: string;
  nba_id: string;
  name: string;
  team: string;
}

const ROUND_OFFSET: Record<string, number> = {
  r1: 2,
  r2: 9,
  cf: 16,
  finals: 23,
};

/** Map `seriesKey` + `gameNum` to the 0..29 availability slot. */
function availIdx(seriesKey: string, gameNum: number): number | null {
  // seriesKey examples: "r1.east.1v8", "r2.west.top", "cf.east", "finals".
  const round = seriesKey.split(".")[0];
  const offset = ROUND_OFFSET[round];
  if (offset == null) return null;
  if (gameNum < 1 || gameNum > 7) return null;
  return offset + (gameNum - 1);
}

async function main() {
  const dataDir = path.resolve(process.cwd(), "src/data");
  const players = JSON.parse(
    await readFile(path.join(dataDir, "nba-players-2026.json"), "utf8"),
  ) as Player[];

  const byEspnId = new Map<string, { nba_id: string; team: string; name: string }>();
  for (const p of players) {
    byEspnId.set(p.espn_id, { nba_id: p.nba_id, team: p.team, name: p.name });
  }

  // One row per (game, player). Completed playoff games only — seriesKey
  // covers R1/R2/CF/Finals; play-in has seriesKey=null and is excluded.
  const rows = await db
    .select({
      playerId: nbaPlayerGameStats.playerId,
      teamAbbrev: nbaPlayerGameStats.teamAbbrev,
      playerName: nbaPlayerGameStats.playerName,
      mins: nbaPlayerGameStats.minutes,
      seriesKey: nbaGame.seriesKey,
      gameNum: nbaGame.gameNum,
      gameId: nbaGame.id,
    })
    .from(nbaPlayerGameStats)
    .innerJoin(nbaGame, eq(nbaPlayerGameStats.gameId, nbaGame.id))
    .where(and(isNotNull(nbaGame.seriesKey), eq(nbaGame.status, "post")));

  const result: Record<string, Record<string, Record<number, number>>> = {};
  let unmapped = 0;
  let kept = 0;
  let badSlot = 0;

  for (const r of rows) {
    const mins = Number(r.mins) || 0;
    if (mins <= 0) continue; // filter DNPs and 0-min games

    const slot = r.seriesKey && r.gameNum ? availIdx(r.seriesKey, r.gameNum) : null;
    if (slot == null) {
      badSlot++;
      continue;
    }

    const mapped = byEspnId.get(r.playerId);
    const team = mapped?.team ?? r.teamAbbrev;
    let nbaId: string;
    if (mapped) {
      nbaId = mapped.nba_id;
    } else {
      nbaId = `espn:${r.playerId}`;
      unmapped++;
    }

    if (!result[team]) result[team] = {};
    if (!result[team][nbaId]) result[team][nbaId] = {};
    result[team][nbaId][slot] = Math.round(mins * 10) / 10;
    kept++;
  }

  // Summary: list per-team top actuals for the latest completed game.
  const teams = Object.keys(result).sort();
  process.stderr.write(`Teams with actuals: ${teams.length}\n`);
  for (const team of teams) {
    const perPlayer = result[team];
    // Find the most recent avail slot any player in this team has data for.
    let maxSlot = -1;
    for (const m of Object.values(perPlayer)) {
      for (const k of Object.keys(m)) maxSlot = Math.max(maxSlot, Number(k));
    }
    const entries = Object.entries(perPlayer)
      .map(([id, m]) => {
        const mapped = players.find((p) => p.nba_id === id);
        const mpgAt = m[maxSlot] ?? 0;
        const games = Object.keys(m).length;
        return { id, name: mapped?.name ?? id, mins: mpgAt, games };
      })
      .filter((e) => e.mins > 0)
      .sort((a, b) => b.mins - a.mins)
      .slice(0, 5);
    const top = entries.map((e) => `${e.name}=${e.mins.toFixed(1)}m(${e.games}g)`);
    process.stderr.write(`  ${team.padEnd(4)} slot=${maxSlot}: ${top.join(", ")}\n`);
  }
  process.stderr.write(`\nTotal kept rows: ${kept} (unmapped fringe: ${unmapped}, bad slot: ${badSlot})\n`);

  const outPath = path.join(dataDir, "nba-playoff-minutes-actual-2026.json");
  await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stderr.write(`Wrote ${outPath}\n`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
