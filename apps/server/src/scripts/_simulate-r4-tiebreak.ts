/**
 * Replay ONLY Round 4 of founders-league under old vs new tiebreak.
 * Starting state is taken directly from DB (actual post-R3 roster + actual budget
 * adjustments + actual budget_adjust actions applied up to R4 open).
 *
 * DOES NOT MUTATE — pure read-only.
 */
import {
  db,
  closeDb,
  draftRound,
  draftRoundPlayer,
  draftSubmission,
  draftBid,
  rosterEntry,
  leagueMember,
  leagueAction,
  league as leagueTable,
  user,
} from "@repo/db";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { decryptBidAmount } from "../lib/bid-crypto.js";
import {
  auctionConfigFromLeague,
  computeAuctionValues,
  getPlayerPool,
  getPlayerPoolMapForAuction,
} from "../lib/player-pool.js";

const LEAGUE_ID = "founders-league";

function computeMaxBid(budget: number, slots: number, minBid: number) {
  if (slots <= 0) return 0;
  return Math.max(0, budget - (slots - 1) * minBid);
}

function moveWinnerToEnd(order: string[], winnerId: string) {
  return [...order.filter((u) => u !== winnerId), winnerId];
}

type Award = {
  playerId: string;
  playerName: string;
  winnerUserId: string;
  acquisitionBid: number;
  acquisitionOrder: number;
  wonByTiebreak: boolean;
  isAutoAssigned: boolean;
};

function resolveRound(opts: {
  eligiblePlayers: { id: string; name: string; suggestedValue: number; totalPoints: number | null }[];
  effectiveBids: Map<string, Map<string, number>>;
  states: Map<string, { remainingBudget: number; remainingRosterSlots: number }>;
  priorityOrder: string[];
  minBid: number;
  isAllRemaining: boolean;
  playerMap: Map<string, { id: string; name: string; suggestedValue: number; totalPoints: number | null }>;
  useTotalPointsTiebreak: boolean;
}) {
  const { eligiblePlayers, effectiveBids, states, minBid, isAllRemaining, playerMap, useTotalPointsTiebreak } = opts;
  let priority = [...opts.priorityOrder];
  let order = 1;
  const remaining = new Set(eligiblePlayers.map((p) => p.id));
  const awards: Award[] = [];

  while (remaining.size) {
    let best: { playerId: string; topBid: number; sv: number; tp: number; contenders: string[] } | null = null;
    for (const playerId of remaining) {
      const player = playerMap.get(playerId);
      if (!player) continue;
      let topBid = 0;
      let contenders: string[] = [];
      for (const uid of priority) {
        const state = states.get(uid);
        if (!state || state.remainingRosterSlots <= 0) continue;
        const maxAllowed = computeMaxBid(state.remainingBudget, state.remainingRosterSlots, minBid);
        const bid = effectiveBids.get(uid)?.get(playerId) ?? 0;
        if (bid <= 0 || bid < minBid || bid > maxAllowed || bid > state.remainingBudget) continue;
        if (bid > topBid) { topBid = bid; contenders = [uid]; }
        else if (bid === topBid) contenders.push(uid);
      }
      if (topBid < minBid || !contenders.length) continue;
      const tp = player.totalPoints ?? 0;
      const leftBetter = (() => {
        if (!best) return true;
        if (topBid !== best.topBid) return topBid > best.topBid;
        if (player.suggestedValue !== best.sv) return player.suggestedValue > best.sv;
        if (useTotalPointsTiebreak && tp !== best.tp) return tp > best.tp;
        return player.name.localeCompare(playerMap.get(best.playerId)!.name) < 0;
      })();
      if (leftBetter) best = { playerId, topBid, sv: player.suggestedValue, tp, contenders };
    }
    if (!best) break;
    const sortedContenders = [...best.contenders].sort((a, b) => priority.indexOf(a) - priority.indexOf(b));
    const winnerUserId = sortedContenders[0];
    const player = playerMap.get(best.playerId)!;
    const s = states.get(winnerUserId)!;
    awards.push({
      playerId: best.playerId,
      playerName: player.name,
      winnerUserId,
      acquisitionBid: best.topBid,
      acquisitionOrder: order++,
      wonByTiebreak: sortedContenders.length > 1,
      isAutoAssigned: false,
    });
    s.remainingBudget -= best.topBid;
    s.remainingRosterSlots -= 1;
    remaining.delete(best.playerId);
    if (sortedContenders.length > 1) priority = moveWinnerToEnd(priority, winnerUserId);
  }

  if (isAllRemaining && remaining.size) {
    const leftover = Array.from(remaining)
      .map((id) => playerMap.get(id)!)
      .sort((a, b) => {
        const ap = a.totalPoints ?? 0;
        const bp = b.totalPoints ?? 0;
        if (ap !== bp) return bp - ap;
        return a.name.localeCompare(b.name);
      });
    let keep = true;
    while (keep && leftover.length) {
      keep = false;
      for (const uid of priority) {
        const s = states.get(uid);
        if (!s || s.remainingRosterSlots <= 0) continue;
        if (!leftover.length) break;
        const next = leftover.shift()!;
        awards.push({
          playerId: next.id,
          playerName: next.name,
          winnerUserId: uid,
          acquisitionBid: 1,
          acquisitionOrder: order++,
          wonByTiebreak: false,
          isAutoAssigned: true,
        });
        s.remainingBudget = Math.max(0, s.remainingBudget - 1);
        s.remainingRosterSlots -= 1;
        remaining.delete(next.id);
        keep = true;
      }
    }
  }
  return awards;
}

async function main() {
  const [leagueRow] = await db.select().from(leagueTable).where(eq(leagueTable.id, LEAGUE_ID));
  if (!leagueRow) throw new Error("no league");
  const members = await db
    .select({ userId: user.id, name: user.name })
    .from(leagueMember)
    .innerJoin(user, eq(user.id, leagueMember.userId))
    .where(and(eq(leagueMember.leagueId, LEAGUE_ID), eq(leagueMember.status, "active")));
  const nameById = new Map(members.map((m) => [m.userId, m.name]));
  const idByName = new Map(members.map((m) => [m.name, m.userId]));
  const playerMap = await getPlayerPoolMapForAuction(auctionConfigFromLeague(leagueRow, members.length));

  // Pre-tournament projections: raw CSV totalPoints, NO injury discount, NO
  // eliminations. Used only for the NEW-simulation totalPoints tiebreak.
  const preTournamentPool = await getPlayerPool();
  const preTotalById = new Map(preTournamentPool.map((p) => [p.id, p.totalPoints ?? 0]));
  const newPlayerMap = new Map(
    Array.from(playerMap.entries()).map(([id, p]) => [
      id,
      { ...p, totalPoints: preTotalById.get(id) ?? p.totalPoints ?? 0 },
    ]),
  );

  const [r4] = await db
    .select()
    .from(draftRound)
    .where(and(eq(draftRound.leagueId, LEAGUE_ID), eq(draftRound.roundNumber, 4)));
  if (!r4) throw new Error("no r4");

  console.log(`R4 ${r4.id.slice(0, 8)} mode=${r4.eligiblePlayerMode} opened=${r4.openedAt.toISOString()} closed=${r4.closedAt?.toISOString()}`);

  // Prior rosterEntries: those with acquisitionRoundId in R1-R3 (NOT including R4).
  const priorRounds = await db
    .select({ id: draftRound.id, roundNumber: draftRound.roundNumber })
    .from(draftRound)
    .where(and(eq(draftRound.leagueId, LEAGUE_ID), lt(draftRound.roundNumber, 4)));
  const priorRoundIds = new Set(priorRounds.map((r) => r.id));

  const allRoster = await db.select().from(rosterEntry).where(eq(rosterEntry.leagueId, LEAGUE_ID));
  const priorRoster = allRoster.filter((r) => r.acquisitionRoundId && priorRoundIds.has(r.acquisitionRoundId));

  // All budget_adjust / roster_remove / auction_undo_award / roster_add actions up to R4 open
  const actions = await db
    .select()
    .from(leagueAction)
    .where(and(eq(leagueAction.leagueId, LEAGUE_ID), lt(leagueAction.createdAt, r4.openedAt)))
    .orderBy(asc(leagueAction.sequenceNumber));

  // Build per-member starting state for R4
  const states = new Map<string, { remainingBudget: number; remainingRosterSlots: number }>();
  for (const m of members) {
    const owned = priorRoster.filter((r) => r.userId === m.userId);
    const spent = owned.reduce((s, e) => s + e.acquisitionBid, 0);
    states.set(m.userId, {
      remainingBudget: leagueRow.budgetPerTeam - spent,
      remainingRosterSlots: leagueRow.rosterSize - owned.length,
    });
  }
  for (const a of actions) {
    if (!a.userId) continue;
    // Only apply budget_adjust; roster_remove/auction_undo_award are already
    // reflected in the rosterEntry sum (the removed row isn't counted).
    if (a.type === "budget_adjust" && a.amount != null) {
      const s = states.get(a.userId);
      if (s) s.remainingBudget += a.amount;
    }
  }

  console.log("\nR4 starting states (from DB):");
  for (const [uid, s] of states) {
    console.log(`  ${nameById.get(uid)!.padEnd(22)} budget=$${s.remainingBudget} slots=${s.remainingRosterSlots}`);
  }

  // Derived P0
  const P0 = [
    "Jon Sobilo",
    "Santhosh Narayan",
    "Sudhin Krishnan",
    "Robin Jiang",
    "Vijay Narayan",
    "Nithin Krishnan",
    "Mike Pudlow",
    "Krishna Hegde",
  ].map((n) => idByName.get(n)!);

  // Apply priority rotations from tiebreak wins in R1-R3 (to get R4 starting priority)
  const priorTiebreakWins = priorRoster
    .filter((r) => r.wonByTiebreak)
    .sort((a, b) => a.acquisitionOrder - b.acquisitionOrder)
    .map((r) => r.userId);
  let priority = [...P0];
  for (const uid of priorTiebreakWins) priority = moveWinnerToEnd(priority, uid);
  console.log("\nR4 starting priority:");
  priority.forEach((uid, i) => console.log(`  ${i + 1}. ${nameById.get(uid)}`));

  // Load R4 eligible players + submissions/bids
  const eligibleRows = await db.select().from(draftRoundPlayer).where(eq(draftRoundPlayer.roundId, r4.id));
  const eligible = eligibleRows.map((r) => playerMap.get(r.playerId)).filter((p): p is NonNullable<typeof p> => Boolean(p));
  // Exclude players already rostered (they shouldn't be eligible, but just in case)
  const rosteredIds = new Set(priorRoster.map((r) => r.playerId));
  const remainingEligible = eligible.filter((p) => !rosteredIds.has(p.id));

  const subs = await db.select().from(draftSubmission).where(eq(draftSubmission.roundId, r4.id));
  const bids = subs.length ? await db.select().from(draftBid).where(inArray(draftBid.submissionId, subs.map((s) => s.id))) : [];

  const effective = new Map<string, Map<string, number>>();
  for (const s of subs) {
    const map = new Map<string, number>();
    for (const b of bids.filter((b) => b.submissionId === s.id)) {
      map.set(b.playerId, decryptBidAmount(b.encryptedAmount));
    }
    effective.set(s.userId, map);
  }

  // Run old and new
  const clone = (m: Map<string, { remainingBudget: number; remainingRosterSlots: number }>) =>
    new Map(Array.from(m.entries()).map(([k, v]) => [k, { ...v }] as const));

  const oldAwards = resolveRound({
    eligiblePlayers: remainingEligible,
    effectiveBids: effective,
    states: clone(states),
    priorityOrder: [...priority],
    minBid: leagueRow.minBid,
    isAllRemaining: r4.eligiblePlayerMode === "all_remaining",
    playerMap,
    useTotalPointsTiebreak: false,
  });
  const newAwards = resolveRound({
    eligiblePlayers: remainingEligible,
    effectiveBids: effective,
    states: clone(states),
    priorityOrder: [...priority],
    minBid: leagueRow.minBid,
    isAllRemaining: r4.eligiblePlayerMode === "all_remaining",
    playerMap: newPlayerMap,
    useTotalPointsTiebreak: true,
  });

  const actualR4 = allRoster
    .filter((r) => r.acquisitionRoundId === r4.id)
    .sort((a, b) => a.acquisitionOrder - b.acquisitionOrder);

  console.log("\n=== DB actual vs OLD replay (sanity) ===");
  const actualByPid = new Map(actualR4.map((r) => [r.playerId, r]));
  const oldByPid = new Map(oldAwards.map((a) => [a.playerId, a]));
  let sanityOk = true;
  for (const [pid, a] of actualByPid) {
    const r = oldByPid.get(pid);
    if (!r) {
      console.log(`  DB had ${a.playerName} (${nameById.get(a.userId)} $${a.acquisitionBid}) — OLD replay skipped`);
      sanityOk = false;
    } else if (r.winnerUserId !== a.userId) {
      console.log(`  ${a.playerName}: DB→${nameById.get(a.userId)} OLD→${nameById.get(r.winnerUserId)}`);
      sanityOk = false;
    } else if (r.acquisitionBid !== a.acquisitionBid) {
      console.log(`  ${a.playerName}: DB bid $${a.acquisitionBid} OLD bid $${r.acquisitionBid}`);
      sanityOk = false;
    }
  }
  for (const [pid, r] of oldByPid) {
    if (!actualByPid.has(pid)) {
      console.log(`  OLD replay had ${r.playerName} (${nameById.get(r.winnerUserId)}) — DB skipped`);
      sanityOk = false;
    }
  }
  if (sanityOk) console.log("  ✓ OLD replay matches DB exactly");

  console.log("\n=== NEW replay vs OLD replay (what totalPoints DESC tiebreak changes) ===");
  const rosterOld = new Map<string, string[]>();
  const rosterNew = new Map<string, string[]>();
  for (const a of oldAwards) {
    (rosterOld.get(a.winnerUserId) ?? rosterOld.set(a.winnerUserId, []).get(a.winnerUserId)!).push(a.playerName);
  }
  for (const a of newAwards) {
    (rosterNew.get(a.winnerUserId) ?? rosterNew.set(a.winnerUserId, []).get(a.winnerUserId)!).push(a.playerName);
  }
  const affected = new Set<string>();
  for (const uid of new Set([...rosterOld.keys(), ...rosterNew.keys()])) {
    const oldSet = new Set(rosterOld.get(uid) ?? []);
    const newSet = new Set(rosterNew.get(uid) ?? []);
    const lost = [...oldSet].filter((n) => !newSet.has(n));
    const gained = [...newSet].filter((n) => !oldSet.has(n));
    if (lost.length || gained.length) {
      affected.add(uid);
      console.log(`\n  ${nameById.get(uid)}:`);
      for (const l of lost) console.log(`    − ${l}`);
      for (const g of gained) console.log(`    + ${g}`);
    }
  }
  if (!affected.size) console.log("  (no changes)");
  else console.log(`\n  Affected members: ${[...affected].map((u) => nameById.get(u)).join(", ")}`);

  // Print all NEW awards for affected members with full details.
  console.log("\n=== NEW awards (detailed) for affected members ===");
  for (const uid of affected) {
    const awardsForUser = newAwards.filter((a) => a.winnerUserId === uid);
    console.log(`\n  ${nameById.get(uid)}:`);
    for (const a of awardsForUser) {
      console.log(
        `    pid=${a.playerId.padEnd(10)} ord=${String(a.acquisitionOrder).padStart(3)} ${a.playerName.padEnd(28)} $${a.acquisitionBid} tiebreak=${a.wonByTiebreak} auto=${a.isAutoAssigned}`,
      );
    }
  }

  // Also print OLD awards for same members, for reference.
  console.log("\n=== OLD awards (detailed) for affected members ===");
  for (const uid of affected) {
    const awardsForUser = oldAwards.filter((a) => a.winnerUserId === uid);
    console.log(`\n  ${nameById.get(uid)}:`);
    for (const a of awardsForUser) {
      console.log(
        `    pid=${a.playerId.padEnd(10)} ord=${String(a.acquisitionOrder).padStart(3)} ${a.playerName.padEnd(28)} $${a.acquisitionBid} tiebreak=${a.wonByTiebreak} auto=${a.isAutoAssigned}`,
      );
    }
  }

  await closeDb();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
