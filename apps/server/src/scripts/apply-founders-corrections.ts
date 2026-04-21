/**
 * One-off data correction for founders-league, bundling four changes:
 *
 *  1. Flip the Luka Doncic `roster_remove` action's amount from -48 to +48.
 *     The reveal-UI maxBid replay uses `prevBudget + action.amount` for
 *     `roster_remove`, so the refund has to be a positive number. With -48 the
 *     replay was silently debiting Robin instead of refunding him, causing his
 *     legitimate round-4 $1 bids to render as strike-through "invalid".
 *
 *  2. Swap Robin Jiang's round-4 acquisitions from {Alex Caruso, Adem Bona,
 *     Andre Drummond} to {Tim Hardaway Jr., Rui Hachimura, Marcus Smart}. This
 *     corresponds to the outcome of the main bid loop once the new
 *     `totalPoints DESC` tiebreak is applied — verified by
 *     _simulate-r4-tiebreak.ts to affect only Robin.
 *
 *  3. Update the corresponding R4 `draft_award` leagueAction rows so the action
 *     log matches the new rosterEntry state.
 *
 *  4. Backfill a `draft_priority_seed` leagueAction at sequence 1 with the
 *     original (derived) draft priority order for the league:
 *       [Jon, Santhosh, Sudhin, Robin, Vijay, Nithin, Mike, Krishna]
 *     Going forward, new leagues will emit this action automatically via
 *     `ensureDraftPriorityOrder` in routes/app.ts.
 *
 * Run:  bash -c 'set -a; source ./.env; set +a; cd apps/server && pnpm exec tsx src/scripts/apply-founders-corrections.ts'
 *       Add `--dry` to skip DB writes.
 */
import { randomUUID } from "node:crypto";
import { db, closeDb } from "@repo/db";
import {
  leagueAction,
  rosterEntry,
  user,
  leagueMember,
} from "@repo/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";

const LEAGUE_ID = "founders-league";
const ROBIN_NAME = "Robin Jiang";
const LUKA_ID = "3945274";

// Derived from forward-simulating 7 R1–R3 tiebreak wins against the current
// draftPriority snapshot — see _simulate-r4-tiebreak.ts.
const DERIVED_P0 = [
  "Jon Sobilo",
  "Santhosh Narayan",
  "Sudhin Krishnan",
  "Robin Jiang",
  "Vijay Narayan",
  "Nithin Krishnan",
  "Mike Pudlow",
  "Krishna Hegde",
];

type Swap = {
  from: { id: string; name: string; team: string };
  to: { id: string; name: string; team: string };
};

// Caruso/Bona/Drummond → Hardaway Jr./Hachimura/Smart, bids unchanged.
const ROBIN_SWAPS: Swap[] = [
  {
    from: { id: "2991350", name: "Alex Caruso", team: "OKC" },
    to: { id: "2528210", name: "Tim Hardaway Jr.", team: "DEN" },
  },
  {
    from: { id: "5105637", name: "Adem Bona", team: "PHI" },
    to: { id: "4066648", name: "Rui Hachimura", team: "LAL" },
  },
  {
    from: { id: "6585", name: "Andre Drummond", team: "PHI" },
    to: { id: "2990992", name: "Marcus Smart", team: "LAL" },
  },
];

async function main() {
  const dry = process.argv.includes("--dry");

  const members = await db
    .select({ userId: user.id, name: user.name })
    .from(leagueMember)
    .innerJoin(user, eq(user.id, leagueMember.userId))
    .where(and(eq(leagueMember.leagueId, LEAGUE_ID), eq(leagueMember.status, "active")));
  const idByName = new Map(members.map((m) => [m.name, m.userId]));
  const nameById = new Map(members.map((m) => [m.userId, m.name]));
  const robinId = idByName.get(ROBIN_NAME);
  if (!robinId) throw new Error("Robin not found");

  const derivedOrder = DERIVED_P0.map((name) => {
    const id = idByName.get(name);
    if (!id) throw new Error(`Member not found: ${name}`);
    return id;
  });

  // ------------------------------------------------------------------
  // 1. Luka sign flip
  // ------------------------------------------------------------------
  const [lukaAction] = await db
    .select()
    .from(leagueAction)
    .where(
      and(
        eq(leagueAction.leagueId, LEAGUE_ID),
        eq(leagueAction.type, "roster_remove"),
        eq(leagueAction.playerId, LUKA_ID),
      ),
    );
  if (!lukaAction) throw new Error("Luka roster_remove action not found");
  console.log(
    `Luka action: id=${lukaAction.id} amount=${lukaAction.amount} → will become +48`,
  );

  // ------------------------------------------------------------------
  // 2. Robin roster swap (in-place rosterEntry updates)
  // ------------------------------------------------------------------
  const robinRoster = await db
    .select()
    .from(rosterEntry)
    .where(
      and(eq(rosterEntry.leagueId, LEAGUE_ID), eq(rosterEntry.userId, robinId)),
    );
  const rosterByPlayerId = new Map(robinRoster.map((r) => [r.playerId, r]));

  console.log(`\nRobin's rosterEntries to swap:`);
  for (const swap of ROBIN_SWAPS) {
    const current = rosterByPlayerId.get(swap.from.id);
    if (!current) {
      throw new Error(
        `Expected Robin to own ${swap.from.name} (id=${swap.from.id}); not found.`,
      );
    }
    const dupe = rosterByPlayerId.get(swap.to.id);
    if (dupe) {
      throw new Error(
        `Cannot swap to ${swap.to.name}; Robin already owns id=${swap.to.id}.`,
      );
    }
    console.log(
      `  ord=${current.acquisitionOrder} ${swap.from.name} $${current.acquisitionBid} → ${swap.to.name}`,
    );
  }

  // ------------------------------------------------------------------
  // 3. Matching draft_award leagueAction updates
  // ------------------------------------------------------------------
  const robinAwards = await db
    .select()
    .from(leagueAction)
    .where(
      and(
        eq(leagueAction.leagueId, LEAGUE_ID),
        eq(leagueAction.userId, robinId),
        eq(leagueAction.type, "draft_award"),
      ),
    );
  const awardByPlayerId = new Map(robinAwards.map((a) => [a.playerId, a]));
  const awardUpdates: { id: string; swap: Swap }[] = [];
  for (const swap of ROBIN_SWAPS) {
    const award = awardByPlayerId.get(swap.from.id);
    if (!award) {
      throw new Error(
        `Expected draft_award for ${swap.from.name}; not found.`,
      );
    }
    awardUpdates.push({ id: award.id, swap });
  }

  // ------------------------------------------------------------------
  // 4. Draft priority seed at sequence 1 (re-number everything else +1)
  // ------------------------------------------------------------------
  const existingSeed = await db
    .select()
    .from(leagueAction)
    .where(
      and(
        eq(leagueAction.leagueId, LEAGUE_ID),
        eq(leagueAction.type, "draft_priority_seed"),
      ),
    );

  console.log(
    `\nDraft priority seed: existing=${existingSeed.length}. Target order:`,
  );
  for (let i = 0; i < derivedOrder.length; i++) {
    console.log(`  ${i + 1}. ${nameById.get(derivedOrder[i])}`);
  }

  if (dry) {
    console.log("\n--dry flag passed; no DB writes.");
    await closeDb();
    return;
  }

  await db.transaction(async (tx) => {
    // 1. Luka amount flip (-48 → +48)
    await tx
      .update(leagueAction)
      .set({ amount: 48 })
      .where(eq(leagueAction.id, lukaAction.id));

    // 2. Robin roster swaps
    for (const swap of ROBIN_SWAPS) {
      await tx
        .update(rosterEntry)
        .set({
          playerId: swap.to.id,
          playerName: swap.to.name,
          playerTeam: swap.to.team,
        })
        .where(
          and(
            eq(rosterEntry.leagueId, LEAGUE_ID),
            eq(rosterEntry.userId, robinId),
            eq(rosterEntry.playerId, swap.from.id),
          ),
        );
    }

    // 3. Matching draft_award action updates
    for (const { id, swap } of awardUpdates) {
      const oldAward = robinAwards.find((a) => a.id === id)!;
      const oldMeta =
        (oldAward.metadata as Record<string, unknown> | null) ?? {};
      await tx
        .update(leagueAction)
        .set({
          playerId: swap.to.id,
          metadata: {
            ...oldMeta,
            playerName: swap.to.name,
            playerTeam: swap.to.team,
            correctedFrom: {
              playerId: swap.from.id,
              playerName: swap.from.name,
              playerTeam: swap.from.team,
              reason:
                "totalPoints DESC tiebreak added 2026-04-20; resimulated R4 swapped Robin's 3 picks",
            },
          },
        })
        .where(eq(leagueAction.id, id));
    }

    // 4. Insert draft_priority_seed (shift all other seq by +1 to keep it first).
    // Bump to a high offset first to dodge the (league_id, sequence_number)
    // unique constraint during the +1 shift.
    if (existingSeed.length === 0) {
      await tx.execute(
        sql`UPDATE league_action SET sequence_number = sequence_number + 100000 WHERE league_id = ${LEAGUE_ID}`,
      );
      await tx.execute(
        sql`UPDATE league_action SET sequence_number = sequence_number - 99999 WHERE league_id = ${LEAGUE_ID}`,
      );
      await tx.insert(leagueAction).values({
        id: randomUUID(),
        leagueId: LEAGUE_ID,
        type: "draft_priority_seed",
        userId: null,
        playerId: null,
        amount: null,
        actorUserId: null,
        roundId: null,
        sequenceNumber: 1,
        metadata: {
          order: derivedOrder,
          derivedBy: "apply-founders-corrections",
          note:
            "Derived by forward-simulating R1–R3 tiebreak-win rotations against current leagueMember.draftPriority",
          seeded: true,
        },
        createdAt: new Date("2026-04-16T23:18:36.087Z"),
      });
    }
  });

  console.log("\n✓ Corrections applied.");

  // Verify
  const verified = await db
    .select({
      playerId: rosterEntry.playerId,
      name: rosterEntry.playerName,
      bid: rosterEntry.acquisitionBid,
      ord: rosterEntry.acquisitionOrder,
    })
    .from(rosterEntry)
    .where(and(eq(rosterEntry.leagueId, LEAGUE_ID), eq(rosterEntry.userId, robinId)))
    .orderBy(asc(rosterEntry.acquisitionOrder));
  const total = verified.reduce((s, r) => s + r.bid, 0);
  console.log(`\nRobin's roster now (${verified.length} players, $${total} spent):`);
  for (const r of verified) {
    console.log(`  ord=${r.ord} ${r.name} $${r.bid}`);
  }

  const seedCount = await db
    .select({ id: leagueAction.id })
    .from(leagueAction)
    .where(
      and(
        eq(leagueAction.leagueId, LEAGUE_ID),
        eq(leagueAction.type, "draft_priority_seed"),
      ),
    );
  console.log(`\ndraft_priority_seed rows: ${seedCount.length}`);

  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
