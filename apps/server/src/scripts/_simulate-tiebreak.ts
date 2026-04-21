/**
 * Replay the founders-league draft under the current tiebreak (topBid → sv → name)
 * and under the proposed new tiebreak (topBid → sv → totalPoints → name).
 * Diff the resulting awards and report which members / players change.
 *
 * DOES NOT MUTATE — pure read-only.
 *
 * Known caveat: we don't have the round-by-round history of draftPriority, so we
 * replay priority starting from a guess and verify the OLD replay matches the
 * actual DB awards. If it does, our priority guess is self-consistent.
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
  user,
} from "@repo/db";
import { and, asc, eq } from "drizzle-orm";
import { decryptBidAmount } from "../lib/bid-crypto.js";
import {
  auctionConfigFromLeague,
  getPlayerPoolMapForAuction,
  type PlayerPoolEntry,
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

type Player = Pick<
  PlayerPoolEntry,
  "id" | "name" | "team" | "suggestedValue" | "totalPoints"
>;

type MemberState = { remainingBudget: number; remainingRosterSlots: number };

function resolveRound(opts: {
  eligiblePlayers: Player[];
  alreadyRosteredIds: Set<string>;
  effectiveBids: Map<string, Map<string, number>>;
  states: Map<string, MemberState>;
  priorityOrder: string[];
  minBid: number;
  isAllRemaining: boolean;
  playerMap: Map<string, Player>;
  useTotalPointsTiebreak: boolean;
  startingOrder: number;
}): { awards: Award[]; newPriority: string[]; endingOrder: number } {
  const {
    eligiblePlayers,
    alreadyRosteredIds,
    effectiveBids,
    states,
    minBid,
    isAllRemaining,
    playerMap,
    useTotalPointsTiebreak,
  } = opts;
  let priority = [...opts.priorityOrder];
  let acquisitionOrder = opts.startingOrder;

  const remaining = new Set(
    eligiblePlayers
      .map((p) => p.id)
      .filter((id) => !alreadyRosteredIds.has(id)),
  );

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
        if (bid > topBid) {
          topBid = bid;
          contenders = [uid];
        } else if (bid === topBid) {
          contenders.push(uid);
        }
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
      if (leftBetter) {
        best = { playerId, topBid, sv: player.suggestedValue, tp, contenders };
      }
    }

    if (!best) break;
    const sortedContenders = [...best.contenders].sort(
      (a, b) => priority.indexOf(a) - priority.indexOf(b),
    );
    const winnerUserId = sortedContenders[0];
    const player = playerMap.get(best.playerId)!;
    const winnerState = states.get(winnerUserId)!;

    awards.push({
      playerId: best.playerId,
      playerName: player.name,
      winnerUserId,
      acquisitionBid: best.topBid,
      acquisitionOrder,
      wonByTiebreak: sortedContenders.length > 1,
      isAutoAssigned: false,
    });
    acquisitionOrder += 1;
    winnerState.remainingBudget -= best.topBid;
    winnerState.remainingRosterSlots -= 1;
    remaining.delete(best.playerId);

    if (sortedContenders.length > 1) {
      priority = moveWinnerToEnd(priority, winnerUserId);
    }
  }

  // All-remaining auto-assign leftover fill
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
        const state = states.get(uid);
        if (!state || state.remainingRosterSlots <= 0) continue;
        if (!leftover.length) break;
        const next = leftover.shift()!;
        awards.push({
          playerId: next.id,
          playerName: next.name,
          winnerUserId: uid,
          acquisitionBid: 1,
          acquisitionOrder,
          wonByTiebreak: false,
          isAutoAssigned: true,
        });
        acquisitionOrder += 1;
        state.remainingBudget = Math.max(0, state.remainingBudget - 1);
        state.remainingRosterSlots -= 1;
        remaining.delete(next.id);
        keep = true;
      }
    }
  }

  return { awards, newPriority: priority, endingOrder: acquisitionOrder };
}

async function main() {
  // Load league
  const [leagueRow] = await db
    .select()
    .from((await import("@repo/db")).league)
    .where(eq((await import("@repo/db")).league.id, LEAGUE_ID));
  if (!leagueRow) throw new Error("no league");

  const members = await db
    .select({
      userId: user.id,
      name: user.name,
      draftPriority: leagueMember.draftPriority,
    })
    .from(leagueMember)
    .innerJoin(user, eq(user.id, leagueMember.userId))
    .where(and(eq(leagueMember.leagueId, LEAGUE_ID), eq(leagueMember.status, "active")));

  const nameById = new Map(members.map((m) => [m.userId, m.name]));

  const playerMap = await getPlayerPoolMapForAuction(auctionConfigFromLeague(leagueRow, members.length));

  const rounds = await db
    .select()
    .from(draftRound)
    .where(and(eq(draftRound.leagueId, LEAGUE_ID), eq(draftRound.status, "resolved")))
    .orderBy(asc(draftRound.roundNumber));

  console.log(`Loaded ${rounds.length} resolved rounds for ${LEAGUE_ID}`);
  console.log(`Members: ${members.length}`);
  console.log(`Player pool size: ${playerMap.size}`);

  // Actual awards from DB (what really happened) via rosterEntry joined to roundId
  const allRosterRows = await db
    .select()
    .from(rosterEntry)
    .where(eq(rosterEntry.leagueId, LEAGUE_ID));

  const actualAwardsByRound = new Map<string, Award[]>();
  for (const entry of allRosterRows) {
    if (!entry.acquisitionRoundId) continue;
    const list = actualAwardsByRound.get(entry.acquisitionRoundId) ?? [];
    const playerName = playerMap.get(entry.playerId)?.name ?? entry.playerName ?? "?";
    list.push({
      playerId: entry.playerId,
      playerName,
      winnerUserId: entry.userId,
      acquisitionBid: entry.acquisitionBid,
      acquisitionOrder: entry.acquisitionOrder ?? 0,
      wonByTiebreak: false,
      isAutoAssigned: false,
    });
    actualAwardsByRound.set(entry.acquisitionRoundId, list);
  }
  for (const list of actualAwardsByRound.values()) {
    list.sort((a, b) => a.acquisitionOrder - b.acquisitionOrder);
  }

  // Budget adjustments (from leagueAction, budget_adjust type, sorted by sequence)
  const allActions = await db
    .select()
    .from(leagueAction)
    .where(eq(leagueAction.leagueId, LEAGUE_ID))
    .orderBy(asc(leagueAction.sequenceNumber));

  // For replay: starting states = budgetPerTeam - 0 (before round 1), will be decremented
  // by our simulated awards
  const stateOld = new Map<string, MemberState>();
  const stateNew = new Map<string, MemberState>();
  for (const m of members) {
    stateOld.set(m.userId, { remainingBudget: leagueRow.budgetPerTeam, remainingRosterSlots: leagueRow.rosterSize });
    stateNew.set(m.userId, { remainingBudget: leagueRow.budgetPerTeam, remainingRosterSlots: leagueRow.rosterSize });
  }

  // Apply non-round-tied budget_adjusts (treat as pre-draft config)
  for (const a of allActions) {
    if (a.type !== "budget_adjust" || !a.userId || a.amount == null) continue;
    const s = stateOld.get(a.userId);
    const sn = stateNew.get(a.userId);
    if (s) s.remainingBudget += a.amount;
    if (sn) sn.remainingBudget += a.amount;
  }

  // Derived P0 from tiebreak-winner reconstruction (see conversation notes):
  // [Jon, Santhosh, Sudhin, Robin, Vijay, Nithin, Mike, Krishna]
  const P0_NAMES = [
    "Jon Sobilo",
    "Santhosh Narayan",
    "Sudhin Krishnan",
    "Robin Jiang",
    "Vijay Narayan",
    "Nithin Krishnan",
    "Mike Pudlow",
    "Krishna Hegde",
  ];
  const idByName = new Map(members.map((m) => [m.name, m.userId]));
  let priorityOld = P0_NAMES.map((n) => {
    const id = idByName.get(n);
    if (!id) throw new Error(`no user named ${n}`);
    return id;
  });
  let priorityNew = [...priorityOld];

  let orderOld = 1;
  let orderNew = 1;

  const oldAwardsByRound = new Map<string, Award[]>();
  const newAwardsByRound = new Map<string, Award[]>();

  for (const round of rounds) {
    const roundPlayerRows = await db
      .select()
      .from(draftRoundPlayer)
      .where(eq(draftRoundPlayer.roundId, round.id));
    const eligible = roundPlayerRows
      .map((rp) => playerMap.get(rp.playerId))
      .filter((p): p is PlayerPoolEntry => Boolean(p));

    const submissions = await db
      .select()
      .from(draftSubmission)
      .where(eq(draftSubmission.roundId, round.id));
    const subIds = submissions.map((s) => s.id);
    const bids = subIds.length
      ? await db.select().from(draftBid).where(
          (await import("drizzle-orm")).inArray(draftBid.submissionId, subIds),
        )
      : [];

    // Effective bids (stored, include both explicit and auto-default)
    const effective = new Map<string, Map<string, number>>();
    for (const s of submissions) {
      const map = new Map<string, number>();
      for (const b of bids.filter((b) => b.submissionId === s.id)) {
        map.set(b.playerId, decryptBidAmount(b.encryptedAmount));
      }
      effective.set(s.userId, map);
    }

    const alreadyRosteredIds = new Set<string>();
    // players rostered BEFORE this round = those awarded in prior rounds
    for (const [rid, awards] of actualAwardsByRound) {
      // include only prior rounds
      const prior = rounds.find((r) => r.id === rid);
      if (prior && prior.roundNumber < round.roundNumber) {
        for (const a of awards) alreadyRosteredIds.add(a.playerId);
      }
    }

    const isAllRemaining = round.eligiblePlayerMode === "all_remaining";

    // Clone states for each replay (to avoid double-draining)
    const sOld = new Map(Array.from(stateOld.entries()).map(([k, v]) => [k, { ...v }]));
    const sNew = new Map(Array.from(stateNew.entries()).map(([k, v]) => [k, { ...v }]));

    const resOld = resolveRound({
      eligiblePlayers: eligible,
      alreadyRosteredIds,
      effectiveBids: effective,
      states: sOld,
      priorityOrder: priorityOld,
      minBid: leagueRow.minBid,
      isAllRemaining,
      playerMap,
      useTotalPointsTiebreak: false,
      startingOrder: orderOld,
    });
    const resNew = resolveRound({
      eligiblePlayers: eligible,
      alreadyRosteredIds,
      effectiveBids: effective,
      states: sNew,
      priorityOrder: priorityNew,
      minBid: leagueRow.minBid,
      isAllRemaining,
      playerMap,
      useTotalPointsTiebreak: true,
      startingOrder: orderNew,
    });

    oldAwardsByRound.set(round.id, resOld.awards);
    newAwardsByRound.set(round.id, resNew.awards);

    // Carry updated states forward
    for (const [k, v] of sOld) stateOld.set(k, v);
    for (const [k, v] of sNew) stateNew.set(k, v);
    priorityOld = resOld.newPriority;
    priorityNew = resNew.newPriority;
    orderOld = resOld.endingOrder;
    orderNew = resNew.endingOrder;
  }

  // Compare
  console.log("\n=== DIFF: OLD replay vs DB actual (sanity) ===");
  for (const round of rounds) {
    const actual = actualAwardsByRound.get(round.id) ?? [];
    const replayed = oldAwardsByRound.get(round.id) ?? [];
    const actualMap = new Map(actual.map((a) => [a.playerId, a]));
    const replayedMap = new Map(replayed.map((a) => [a.playerId, a]));
    const diffs: string[] = [];
    for (const [pid, a] of actualMap) {
      const r = replayedMap.get(pid);
      if (!r) {
        diffs.push(`  DB had ${a.playerName} (${nameById.get(a.winnerUserId)}) — replay skipped`);
      } else if (r.winnerUserId !== a.winnerUserId) {
        diffs.push(
          `  ${a.playerName}: DB→${nameById.get(a.winnerUserId)} replay→${nameById.get(r.winnerUserId)}`,
        );
      } else if (r.acquisitionBid !== a.acquisitionBid) {
        diffs.push(`  ${a.playerName}: DB bid $${a.acquisitionBid} replay bid $${r.acquisitionBid}`);
      }
    }
    for (const [pid, r] of replayedMap) {
      if (!actualMap.has(pid)) {
        diffs.push(`  replay had ${r.playerName} (${nameById.get(r.winnerUserId)}) — DB skipped`);
      }
    }
    if (diffs.length) {
      console.log(`Round ${round.roundNumber} (${round.id}) — ${diffs.length} diffs:`);
      for (const d of diffs) console.log(d);
    }
  }

  console.log("\n=== DIFF: NEW replay vs OLD replay (what totalPoints tiebreak changes) ===");
  const changedMembers = new Map<string, { lost: string[]; gained: string[] }>();
  for (const round of rounds) {
    const oldA = oldAwardsByRound.get(round.id) ?? [];
    const newA = newAwardsByRound.get(round.id) ?? [];
    const oldByPlayer = new Map(oldA.map((a) => [a.playerId, a]));
    const newByPlayer = new Map(newA.map((a) => [a.playerId, a]));

    // Focus on: for each winning member, which players did they win in OLD vs NEW?
    const oldRoster = new Map<string, { playerId: string; name: string }[]>();
    const newRoster = new Map<string, { playerId: string; name: string }[]>();
    for (const a of oldA) {
      const arr = oldRoster.get(a.winnerUserId) ?? [];
      arr.push({ playerId: a.playerId, name: a.playerName });
      oldRoster.set(a.winnerUserId, arr);
    }
    for (const a of newA) {
      const arr = newRoster.get(a.winnerUserId) ?? [];
      arr.push({ playerId: a.playerId, name: a.playerName });
      newRoster.set(a.winnerUserId, arr);
    }
    for (const uid of new Set([...oldRoster.keys(), ...newRoster.keys()])) {
      const oldIds = new Set((oldRoster.get(uid) ?? []).map((p) => p.playerId));
      const newIds = new Set((newRoster.get(uid) ?? []).map((p) => p.playerId));
      const lost = (oldRoster.get(uid) ?? []).filter((p) => !newIds.has(p.playerId));
      const gained = (newRoster.get(uid) ?? []).filter((p) => !oldIds.has(p.playerId));
      if (lost.length || gained.length) {
        const entry = changedMembers.get(uid) ?? { lost: [], gained: [] };
        for (const l of lost) entry.lost.push(`[R${round.roundNumber}] ${l.name}`);
        for (const g of gained) entry.gained.push(`[R${round.roundNumber}] ${g.name}`);
        changedMembers.set(uid, entry);
      }
    }
  }

  if (changedMembers.size === 0) {
    console.log("  NO CHANGES — new tiebreak produces identical awards.");
  } else {
    for (const [uid, diff] of changedMembers) {
      console.log(`\n  ${nameById.get(uid)}:`);
      for (const l of diff.lost) console.log(`    − ${l}`);
      for (const g of diff.gained) console.log(`    + ${g}`);
    }
  }

  await closeDb();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
