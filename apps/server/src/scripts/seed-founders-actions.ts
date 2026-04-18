/**
 * One-off seed: back-fill the leagueAction log for founders-league so the
 * current roster state can be rebuilt from actions alone.
 *
 * Rounds 1-3 picks happened before the action system existed, so only round 4
 * and a single Luka removal are currently logged. This script inserts the
 * missing `round_closed` + `draft_award` rows for rounds 1-3 (including the
 * original Luka pick in round 2), preserves the existing Luka `roster_remove`
 * and round-4 actions, and renumbers everything in timeline order.
 *
 * Safe to re-run: it wipes only the founders-league's own action rows before
 * re-inserting. Actions in other leagues are untouched.
 *
 * Run:  bash -c 'set -a; source ./.env; set +a; cd apps/server && pnpm exec tsx src/scripts/seed-founders-actions.ts'
 */
import { randomUUID } from "node:crypto";
import { db } from "@repo/db";
import {
  draftRound,
  leagueAction,
  rosterEntry,
} from "@repo/db/schema";
import { and, asc, eq, inArray } from "drizzle-orm";

const LEAGUE_ID = "founders-league";
const LUKA_ID = "3945274";
const ROBIN_USER_ID = "c41bd1d1-6e53-46b0-b302-8588288ebc3a";
const LUKA_BID = 48;
const LUKA_REMOVAL_AT = new Date("2026-04-17T17:30:00.000Z");

type NewAction = typeof leagueAction.$inferInsert;

async function main() {
  const rounds = await db
    .select({
      id: draftRound.id,
      roundNumber: draftRound.roundNumber,
      createdAt: draftRound.createdAt,
    })
    .from(draftRound)
    .where(eq(draftRound.leagueId, LEAGUE_ID))
    .orderBy(asc(draftRound.roundNumber));
  console.log(`Found ${rounds.length} rounds`);

  const entries = await db
    .select({
      userId: rosterEntry.userId,
      playerId: rosterEntry.playerId,
      playerName: rosterEntry.playerName,
      playerTeam: rosterEntry.playerTeam,
      bid: rosterEntry.acquisitionBid,
      roundId: rosterEntry.acquisitionRoundId,
      createdAt: rosterEntry.createdAt,
      isAutoAssigned: rosterEntry.isAutoAssigned,
    })
    .from(rosterEntry)
    .where(eq(rosterEntry.leagueId, LEAGUE_ID));
  console.log(`Found ${entries.length} roster entries`);

  const existingActions = await db
    .select()
    .from(leagueAction)
    .where(eq(leagueAction.leagueId, LEAGUE_ID))
    .orderBy(asc(leagueAction.sequenceNumber));
  console.log(`Existing actions: ${existingActions.length}`);

  // Pre-existing actions we want to preserve (Luka remove + round 4 awards/close).
  const lukaRemove = existingActions.find(
    (a) => a.type === "roster_remove" && a.playerId === LUKA_ID,
  );
  if (!lukaRemove) {
    throw new Error("Existing Luka roster_remove not found — refusing to proceed");
  }

  const r4 = rounds.find((r) => r.roundNumber === 4);
  if (!r4) throw new Error("Round 4 not found");
  const existingR4Actions = existingActions.filter((a) => a.roundId === r4.id);
  console.log(`Existing R4 actions: ${existingR4Actions.length}`);

  // Pick ordering within a round: bid desc, then player name asc for stable output.
  const sortPicks = (xs: typeof entries) =>
    [...xs].sort((a, b) => b.bid - a.bid || a.playerName.localeCompare(b.playerName));

  const build: NewAction[] = [];

  for (const r of rounds) {
    const picks = sortPicks(entries.filter((e) => e.roundId === r.id));
    // For round 2 we have to re-add the original Luka pick (since the roster
    // entry was deleted when he was removed).
    let augmentedPicks = picks;
    if (r.roundNumber === 2) {
      augmentedPicks = sortPicks([
        ...picks,
        {
          userId: ROBIN_USER_ID,
          playerId: LUKA_ID,
          playerName: "Luka Doncic",
          playerTeam: "DAL",
          bid: LUKA_BID,
          roundId: r.id,
          createdAt: lukaRemove.createdAt,
          isAutoAssigned: false,
        },
      ]);
    }

    const roundTimestamp = picks[0]?.createdAt ?? r.createdAt;

    if (r.roundNumber === 4) {
      // Preserve the existing R4 actions verbatim — we only re-number them.
      const r4Close = existingR4Actions.find((a) => a.type === "round_closed");
      if (!r4Close) throw new Error("Existing R4 round_closed not found");
      build.push({ ...r4Close });
      const r4Awards = existingR4Actions
        .filter((a) => a.type === "draft_award")
        .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0) || (a.sequenceNumber ?? 0) - (b.sequenceNumber ?? 0));
      for (const a of r4Awards) build.push({ ...a });
    } else {
      build.push({
        id: randomUUID(),
        leagueId: LEAGUE_ID,
        type: "round_closed",
        userId: null,
        playerId: null,
        amount: null,
        actorUserId: null,
        roundId: r.id,
        sequenceNumber: 0, // renumbered below
        metadata: {
          roundNumber: r.roundNumber,
          awardCount: augmentedPicks.length,
          seeded: true,
        },
        createdAt: roundTimestamp,
      });
      for (const p of augmentedPicks) {
        build.push({
          id: randomUUID(),
          leagueId: LEAGUE_ID,
          type: "draft_award",
          userId: p.userId,
          playerId: p.playerId,
          amount: p.bid,
          actorUserId: null,
          roundId: p.roundId ?? r.id,
          sequenceNumber: 0,
          metadata: {
            playerName: p.playerName,
            playerTeam: p.playerTeam,
            roundNumber: r.roundNumber,
            isAutoAssigned: p.isAutoAssigned,
            seeded: true,
          },
          createdAt: roundTimestamp,
        });
      }
    }

    // After round 2, the Luka removal happens before round 3 starts.
    if (r.roundNumber === 2) {
      build.push({
        ...lukaRemove,
        createdAt: LUKA_REMOVAL_AT,
      });
    }
  }

  // Assign fresh sequence numbers in the order we built them.
  for (let i = 0; i < build.length; i++) {
    build[i].sequenceNumber = i + 1;
  }

  console.log(`\nWill insert ${build.length} actions total.`);
  const typeCounts: Record<string, number> = {};
  for (const a of build) typeCounts[a.type] = (typeCounts[a.type] ?? 0) + 1;
  console.log("Type counts:", typeCounts);

  // Equivalence check — replay the built action log and verify the resulting
  // roster state matches the current rosterEntry table exactly (same owners,
  // same players, same bids).
  //
  // Replay rules:
  //   - draft_award  -> add (userId, playerId, bid) to roster
  //   - roster_add   -> same
  //   - roster_remove-> remove that player from the owner's roster
  //   - round_closed / other -> no-op on roster
  type ReplayKey = string; // `${userId}::${playerId}`
  const replay = new Map<ReplayKey, { userId: string; playerId: string; bid: number }>();
  const key = (u: string, p: string) => `${u}::${p}`;
  for (const a of build) {
    if (a.type === "draft_award" || a.type === "roster_add") {
      if (!a.userId || !a.playerId) continue;
      replay.set(key(a.userId, a.playerId), {
        userId: a.userId,
        playerId: a.playerId,
        bid: a.amount ?? 0,
      });
    } else if (a.type === "roster_remove") {
      if (!a.userId || !a.playerId) continue;
      replay.delete(key(a.userId, a.playerId));
    }
  }

  const actual = new Map<ReplayKey, { userId: string; playerId: string; bid: number }>();
  for (const e of entries) {
    actual.set(key(e.userId, e.playerId), {
      userId: e.userId,
      playerId: e.playerId,
      bid: e.bid,
    });
  }

  const issues: string[] = [];
  for (const [k, v] of replay) {
    const a = actual.get(k);
    if (!a) {
      issues.push(`REPLAY HAS extra entry: user=${v.userId} player=${v.playerId} bid=${v.bid}`);
    } else if (a.bid !== v.bid) {
      issues.push(
        `BID MISMATCH for user=${v.userId} player=${v.playerId}: replay=${v.bid} actual=${a.bid}`,
      );
    }
  }
  for (const [k, v] of actual) {
    if (!replay.has(k)) {
      issues.push(`REPLAY MISSING entry: user=${v.userId} player=${v.playerId} bid=${v.bid}`);
    }
  }

  // Budget-per-user equivalence.
  const sumBy = (m: Map<ReplayKey, { userId: string; bid: number }>) => {
    const out: Record<string, { count: number; spent: number }> = {};
    for (const v of m.values()) {
      const cur = out[v.userId] ?? { count: 0, spent: 0 };
      cur.count += 1;
      cur.spent += v.bid;
      out[v.userId] = cur;
    }
    return out;
  };
  const replaySpend = sumBy(replay);
  const actualSpend = sumBy(actual);
  const allUsers = new Set([...Object.keys(replaySpend), ...Object.keys(actualSpend)]);
  console.log("\nPer-user equivalence (replay vs actual):");
  const perUser: Array<{ user: string; replay: string; actual: string; ok: string }> = [];
  for (const u of allUsers) {
    const r = replaySpend[u] ?? { count: 0, spent: 0 };
    const a = actualSpend[u] ?? { count: 0, spent: 0 };
    const ok = r.count === a.count && r.spent === a.spent;
    perUser.push({
      user: u,
      replay: `${r.count} players / $${r.spent}`,
      actual: `${a.count} players / $${a.spent}`,
      ok: ok ? "ok" : "DIFF",
    });
  }
  console.table(perUser);

  if (issues.length) {
    console.log(`\n⚠️  ${issues.length} equivalence issues:`);
    for (const i of issues) console.log("  -", i);
  } else {
    console.log("\n✅  Replay matches current roster state exactly.");
  }

  if (process.argv.includes("--dry")) {
    console.log("\n--dry flag passed; not writing.");
    return;
  }

  if (issues.length) {
    console.log("\nRefusing to write because equivalence check failed. Re-run with --force to override.");
    if (!process.argv.includes("--force")) return;
  }

  await db.transaction(async (tx) => {
    await tx.delete(leagueAction).where(eq(leagueAction.leagueId, LEAGUE_ID));
    // Chunk to keep the single INSERT reasonably sized.
    const CHUNK = 50;
    for (let i = 0; i < build.length; i += CHUNK) {
      await tx.insert(leagueAction).values(build.slice(i, i + CHUNK));
    }
  });

  console.log(`\nSeeded ${build.length} actions for founders-league.`);

  const checkCount = (
    await db
      .select({ id: leagueAction.id })
      .from(leagueAction)
      .where(eq(leagueAction.leagueId, LEAGUE_ID))
  ).length;
  console.log(`Verification: ${checkCount} actions currently in DB.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
