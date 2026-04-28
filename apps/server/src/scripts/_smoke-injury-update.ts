// Smoke test for the injury_update event flow. Run with:
//   cd apps/server && pnpm exec tsx src/scripts/_smoke-injury-update.ts
//
// Verifies, against the production nba-injury-updates-2026.json:
//   1. buildEventSnapshots merges every JSON entry into the chronological
//      event stream as an `injury_update` snapshot (one per entry).
//   2. Each snapshot carries the full payload in event.injuryUpdate.
//   3. The cumulative hash advances at every event (no collisions).
//   4. Past-slots-locked invariant: every player named in an update whose
//      payload's availability vector is compared against any prior entry
//      for the same player must echo that prior entry's value at all
//      slot indexes < the team's future-cutoff.
//   5. Stats accrued before the update remain folded into the snapshot
//      (already-completed minutes count).

import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildEventSnapshots, type InjuryUpdate, type PlayEvent } from "@repo/sim";

// Same series-state map as scripts/generate-injury-updates.py — duplicated
// here intentionally so the test catches drift between the two.
const FUTURE_CUTOFF: Record<string, number> = {
  ATL: 6, BOS: 6, CLE: 6, DEN: 7, DET: 6, HOU: 6, LAL: 6, MIN: 7,
  NY: 6, OKC: 9, ORL: 6, PHI: 6, POR: 6, SA: 6, TOR: 6,
};

async function main() {
  const dataDir = path.resolve(process.cwd(), "src/data");
  const updatesRaw = JSON.parse(
    await readFile(path.join(dataDir, "nba-injury-updates-2026.json"), "utf8"),
  ) as Array<{
    id: string;
    wallclock: string;
    gameId: string | null;
    updates: InjuryUpdate["updates"];
    note?: string | null;
  }>;
  const baseInjuries = JSON.parse(
    await readFile(path.join(dataDir, "nba-injuries-2026.json"), "utf8"),
  ) as Record<string, { team: string; availability: number[] } | { source?: string }>;

  const injuryUpdates: InjuryUpdate[] = updatesRaw.map((u) => ({
    id: u.id,
    wallclock: new Date(u.wallclock),
    gameId: u.gameId,
    updates: u.updates,
    note: u.note ?? null,
  }));

  // Past-slots-locked check: walk every update; for any player with a prior
  // entry, verify slots 0..cutoff-1 echo verbatim.
  let locked = 0;
  let newEntries = 0;
  for (const u of updatesRaw) {
    for (const [name, entry] of Object.entries(u.updates)) {
      if (!entry) continue;
      const cutoff = FUTURE_CUTOFF[entry.team];
      if (cutoff == null) {
        throw new Error(
          `${u.id}: no FUTURE_CUTOFF for team ${entry.team} (player ${name})`,
        );
      }
      const prior = baseInjuries[name];
      if (prior && "availability" in prior) {
        for (let i = 0; i < cutoff; i++) {
          if (entry.availability[i] !== prior.availability[i]) {
            throw new Error(
              `${u.id}/${name}: past slot ${i} changed from ${prior.availability[i]} to ${entry.availability[i]} (cutoff=${cutoff})`,
            );
          }
        }
        locked++;
      } else {
        // New entry — past slots must be the default 1.0 (no implicit
        // back-dating of an injury that didn't exist).
        for (let i = 0; i < cutoff; i++) {
          if (entry.availability[i] !== 1) {
            throw new Error(
              `${u.id}/${name}: new entry past slot ${i} must be 1.0, got ${entry.availability[i]}`,
            );
          }
        }
        newEntries++;
      }
    }
  }
  console.log(
    `past-slots-locked OK — ${locked} player revisions, ${newEntries} new entries, all past slots verified`,
  );

  // Drive buildEventSnapshots with a small synthetic play stream. The plays
  // here only matter to confirm the chronological merge interleaves correctly
  // — the per-event injury propagation is what the assertions cover.
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
      gameId: "g1", sequence: 1, period: 1, clock: "10:00",
      updatedAt: new Date("2026-04-28T13:00:00Z"),
      wallclock: new Date("2026-04-28T13:00:00Z"),
      scoringPlay: true, scoreValue: 3,
      homeScore: 3, awayScore: 0,
      teamAbbrev: "LAL", playerIds: ["lebron"], text: "LeBron 3pt",
    },
    {
      gameId: "g1", sequence: 2, period: 1, clock: "8:30",
      updatedAt: new Date("2026-04-28T20:00:00Z"),
      wallclock: new Date("2026-04-28T20:00:00Z"),
      scoringPlay: true, scoreValue: 3,
      homeScore: 6, awayScore: 0,
      teamAbbrev: "LAL", playerIds: ["lebron"], text: "LeBron 3pt",
    },
  ];

  const snapshots = buildEventSnapshots({ games, plays, injuryUpdates });

  const injurySnaps = snapshots.filter((s) => s.event.kind === "injury_update");
  if (injurySnaps.length !== injuryUpdates.length) {
    throw new Error(
      `expected ${injuryUpdates.length} injury snapshots, got ${injurySnaps.length}`,
    );
  }

  // Each injury snapshot must carry its full update payload.
  for (let i = 0; i < injuryUpdates.length; i++) {
    const expected = injuryUpdates[i];
    const got = injurySnaps[i];
    if (got.event.injuryUpdate?.id !== expected.id) {
      throw new Error(
        `snapshot ${i} payload mismatch: expected id=${expected.id}, got=${got.event.injuryUpdate?.id}`,
      );
    }
  }

  // Cumulative hash must shift at every snapshot.
  const hashes = snapshots.map((s) => s.cumulativeHash);
  if (new Set(hashes).size !== hashes.length) {
    throw new Error(`cumulative hash collision: ${hashes.join(", ")}`);
  }

  // Stats from the first scoring play (LeBron 3pt at 13:00Z) must be present
  // in every injury snapshot that fires after it.
  for (const s of injurySnaps) {
    if (s.event.wallclock! < new Date("2026-04-28T13:00:00Z")) continue;
    if ((s.cumulativePointsByPlayer["lebron"] ?? 0) < 3) {
      throw new Error(
        `injury snapshot ${s.event.injuryUpdate?.id} missing pre-update lebron pts`,
      );
    }
  }

  console.log(`emitted ${snapshots.length} snapshots (${injurySnaps.length} injury_updates)`);
  console.log("first 3 snapshots:");
  for (const s of snapshots.slice(0, 3)) {
    const tag = s.event.kind === "injury_update"
      ? `[INJURY] ${s.event.injuryUpdate?.id}`
      : `[${s.event.kind}] ${s.event.text ?? ""}`;
    console.log(`  ${s.event.wallclock?.toISOString()} ${tag}`);
  }
  console.log("last 3 snapshots:");
  for (const s of snapshots.slice(-3)) {
    const tag = s.event.kind === "injury_update"
      ? `[INJURY] ${s.event.injuryUpdate?.id}`
      : `[${s.event.kind}] ${s.event.text ?? ""}`;
    console.log(`  ${s.event.wallclock?.toISOString()} ${tag}`);
  }
  console.log("OK — injury_update events flow through buildEventSnapshots.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
