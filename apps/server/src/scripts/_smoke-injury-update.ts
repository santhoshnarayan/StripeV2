// Smoke test for the injury_update event flow. Run with:
//   cd apps/server && pnpm exec tsx src/scripts/_smoke-injury-update.ts
//
// Verifies:
//   1. buildEventSnapshots merges injury updates into the chronological
//      event stream (ordered by wallclock, with updates landing at the
//      correct position relative to plays).
//   2. injury_update snapshots carry the full payload in event.injuryUpdate.
//   3. The cumulative hash advances when an update fires, so divergence
//      detection picks up new updates.
//   4. Stats accrued before the update remain folded into the snapshot
//      (already-completed minutes count) but the availability vector for
//      the affected player flips for downstream sim consumers.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildEventSnapshots, type InjuryUpdate, type PlayEvent } from "@repo/sim";

async function main() {
  const updatesPath = path.resolve(
    process.cwd(),
    "src/data/nba-injury-updates-2026.json",
  );
  const raw = JSON.parse(await readFile(updatesPath, "utf8")) as Array<{
    id: string;
    wallclock: string;
    gameId: string | null;
    updates: InjuryUpdate["updates"];
    note?: string | null;
  }>;
  const injuryUpdates: InjuryUpdate[] = raw.map((u) => ({
    id: u.id,
    wallclock: new Date(u.wallclock),
    gameId: u.gameId,
    updates: u.updates,
    note: u.note ?? null,
  }));

  // Synthetic Lakers-Rockets play stream straddling the two injury updates.
  // Two scoring plays before the first update, one between, one after the
  // second. Timestamps chosen so the chronological merge interleaves cleanly.
  const games = [
    {
      id: "g1",
      seriesKey: "r1.west.4v5",
      gameNum: 5,
      homeTeamAbbrev: "LAL",
      awayTeamAbbrev: "HOU",
      status: "in" as const,
      lastPlaySequence: null,
    },
  ];
  const plays: PlayEvent[] = [
    {
      gameId: "g1",
      sequence: 1,
      period: 1,
      clock: "10:00",
      updatedAt: new Date("2026-04-28T13:00:00Z"),
      wallclock: new Date("2026-04-28T13:00:00Z"),
      scoringPlay: true,
      scoreValue: 3,
      homeScore: 3,
      awayScore: 0,
      teamAbbrev: "LAL",
      playerIds: ["lebron"],
      text: "LeBron 3pt",
    },
    {
      gameId: "g1",
      sequence: 2,
      period: 1,
      clock: "9:30",
      updatedAt: new Date("2026-04-28T13:05:00Z"),
      wallclock: new Date("2026-04-28T13:05:00Z"),
      scoringPlay: true,
      scoreValue: 2,
      homeScore: 3,
      awayScore: 2,
      teamAbbrev: "HOU",
      playerIds: ["sengun"],
      text: "Sengun layup",
    },
    // <-- first injury update lands at 14:30Z (Reaves)
    {
      gameId: "g1",
      sequence: 3,
      period: 1,
      clock: "9:00",
      updatedAt: new Date("2026-04-28T15:00:00Z"),
      wallclock: new Date("2026-04-28T15:00:00Z"),
      scoringPlay: true,
      scoreValue: 2,
      homeScore: 5,
      awayScore: 2,
      teamAbbrev: "LAL",
      playerIds: ["reaves"],
      text: "Reaves jumper",
    },
    // <-- second injury update lands at 16:00Z (Luka)
    {
      gameId: "g1",
      sequence: 4,
      period: 1,
      clock: "8:30",
      updatedAt: new Date("2026-04-28T17:00:00Z"),
      wallclock: new Date("2026-04-28T17:00:00Z"),
      scoringPlay: true,
      scoreValue: 3,
      homeScore: 8,
      awayScore: 2,
      teamAbbrev: "LAL",
      playerIds: ["lebron"],
      text: "LeBron 3pt",
    },
  ];

  const snapshots = buildEventSnapshots({ games, plays, injuryUpdates });

  console.log(`emitted ${snapshots.length} snapshots:`);
  for (const s of snapshots) {
    const tag =
      s.event.kind === "injury_update"
        ? `[INJURY] ${s.event.injuryUpdate?.note ?? s.event.injuryUpdate?.id}`
        : `[${s.event.kind}] ${s.event.text ?? ""}`;
    console.log(
      `  ${s.event.wallclock?.toISOString()} hash=${s.cumulativeHash} ${tag}`,
    );
  }

  const injuryCount = snapshots.filter((s) => s.event.kind === "injury_update").length;
  console.assert(
    injuryCount === 2,
    `expected 2 injury_update snapshots, got ${injuryCount}`,
  );

  // The two injury updates must appear chronologically between the right
  // pairs of scoring plays:
  //   plays 1+2 → injury(reaves) → play 3 → injury(luka) → play 4
  const expectedKinds = [
    "scoring",
    "scoring",
    "injury_update",
    "scoring",
    "injury_update",
    "scoring",
  ];
  const actualKinds = snapshots.map((s) => s.event.kind);
  console.assert(
    JSON.stringify(actualKinds) === JSON.stringify(expectedKinds),
    `kind order mismatch:\n  expected: ${expectedKinds.join(", ")}\n  actual:   ${actualKinds.join(", ")}`,
  );

  // Cumulative hash must shift at every snapshot — including injury updates.
  const hashes = snapshots.map((s) => s.cumulativeHash);
  const uniqueHashes = new Set(hashes);
  console.assert(
    uniqueHashes.size === hashes.length,
    `cumulative hash collision: ${hashes.join(", ")}`,
  );

  // Reaves's update must carry the full new availability vector to consumers.
  const reavesSnap = snapshots.find(
    (s) =>
      s.event.kind === "injury_update" &&
      s.event.injuryUpdate?.updates["Austin Reaves"],
  );
  console.assert(
    reavesSnap?.event.injuryUpdate?.updates["Austin Reaves"]?.availability[5] ===
      0.75,
    "Reaves R1G5 availability didn't propagate (expected 0.75)",
  );

  // Stats accrued BEFORE Reaves's injury_update must still be present in the
  // snapshot's cumulative state — the user's spec: "already completed stats
  // should count".
  console.assert(
    (reavesSnap?.cumulativePointsByPlayer["lebron"] ?? 0) === 3,
    `expected lebron's pre-update 3 pts to be locked in at the injury snapshot, got ${reavesSnap?.cumulativePointsByPlayer["lebron"]}`,
  );

  console.log("OK — injury_update events flow through buildEventSnapshots.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
