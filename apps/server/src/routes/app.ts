import { randomInt, randomUUID } from "node:crypto";
import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  draftBid,
  draftRound,
  draftRoundPlayer,
  draftSubmission,
  league,
  leagueInvite,
  leagueMember,
  rosterEntry,
  user,
} from "@repo/db";
import { auth } from "../auth.js";
import { decryptBidAmount, encryptBidAmount } from "../lib/bid-crypto.js";
import {
  getDefaultBidFromSuggestedValue,
  getPlayerPool,
  getPlayerPoolMap,
  type PlayerPoolEntry,
} from "../lib/player-pool.js";

const LEAGUE_CREATOR_EMAIL = "santhoshnarayan@gmail.com";
const MAX_ACTIVE_MEMBERS = 16;

type AppSession = Awaited<ReturnType<typeof auth.api.getSession>>;
type TransactionClient = Parameters<Parameters<typeof db.transaction>[0]>[0];

type MemberRow = Awaited<ReturnType<typeof getLeagueMembers>>[number];

type MemberState = {
  userId: string;
  rosterCount: number;
  remainingBudget: number;
  remainingRosterSlots: number;
  totalPoints: number;
};

const createLeagueSchema = z.object({
  name: z.string().min(2).max(120),
  rosterSize: z.number().int().min(8).max(12).default(10),
});

const inviteSchema = z.object({
  emails: z.array(z.string().email()).min(1),
});

const openRoundSchema = z.object({
  mode: z.enum(["selected", "all_remaining"]),
  playerIds: z.array(z.string()).optional(),
  deadlineAt: z.string().datetime().nullable().optional(),
});

const submitBidsSchema = z.object({
  bids: z.record(z.string(), z.number().int().min(1)).default({}),
});

const updateLeagueSettingsSchema = z.object({
  rosterSize: z.number().int().min(8).max(12),
});

export const appRouter = new Hono<{
  Variables: {
    session: AppSession;
  };
}>();

appRouter.use("*", async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  c.set("session", session);
  await next();
});

function getRequiredSession(c: { get: (key: "session") => AppSession }) {
  return c.get("session");
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function computeMaxBid(
  remainingBudget: number,
  remainingRosterSlots: number,
  minBid: number,
) {
  if (remainingRosterSlots <= 0) {
    return 0;
  }

  return Math.max(0, remainingBudget - (remainingRosterSlots - 1) * minBid);
}

function shuffle<T>(values: T[]) {
  const copy = [...values];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const nextIndex = randomInt(index + 1);
    const current = copy[index];
    copy[index] = copy[nextIndex];
    copy[nextIndex] = current;
  }

  return copy;
}

function moveWinnerToEnd(priorityOrder: string[], winnerUserId: string) {
  return [
    ...priorityOrder.filter((userId) => userId !== winnerUserId),
    winnerUserId,
  ];
}

async function getLeagueAccess(userId: string, leagueId: string) {
  const membershipRows = await db
    .select()
    .from(leagueMember)
    .where(
      and(
        eq(leagueMember.leagueId, leagueId),
        eq(leagueMember.userId, userId),
        eq(leagueMember.status, "active"),
      ),
    )
    .limit(1);

  const membership = membershipRows[0];

  if (!membership) {
    return null;
  }

  const leagueRows = await db.select().from(league).where(eq(league.id, leagueId)).limit(1);
  const leagueRow = leagueRows[0];

  if (!leagueRow) {
    return null;
  }

  return {
    league: leagueRow,
    membership,
    isCommissioner: leagueRow.commissionerUserId === userId,
  };
}

async function getLeagueMembers(leagueId: string) {
  return db
    .select({
      membershipId: leagueMember.id,
      userId: user.id,
      name: user.name,
      email: user.email,
      role: leagueMember.role,
      status: leagueMember.status,
      draftPriority: leagueMember.draftPriority,
      createdAt: leagueMember.createdAt,
      updatedAt: leagueMember.updatedAt,
    })
    .from(leagueMember)
    .innerJoin(user, eq(leagueMember.userId, user.id))
    .where(
      and(eq(leagueMember.leagueId, leagueId), eq(leagueMember.status, "active")),
    );
}

async function getPendingLeagueInvites(leagueId: string) {
  const invites = await db
    .select()
    .from(leagueInvite)
    .where(
      and(eq(leagueInvite.leagueId, leagueId), eq(leagueInvite.status, "pending")),
    );

  const inviterIds = Array.from(new Set(invites.map((invite) => invite.invitedByUserId)));
  const inviters = inviterIds.length
    ? await db.select().from(user).where(inArray(user.id, inviterIds))
    : [];
  const inviterMap = new Map(inviters.map((inviter) => [inviter.id, inviter]));

  return invites.map((invite) => ({
    ...invite,
    invitedByName: inviterMap.get(invite.invitedByUserId)?.name ?? "Unknown",
  }));
}

function buildMemberStates(
  leagueRow: typeof league.$inferSelect,
  members: MemberRow[],
  rosterRows: Array<typeof rosterEntry.$inferSelect>,
  playerMap: Map<string, PlayerPoolEntry>,
) {
  return new Map<string, MemberState>(
    members.map((member) => {
      const roster = rosterRows.filter((entry) => entry.userId === member.userId);
      const rosterCount = roster.length;
      const spentBudget = roster.reduce((sum, entry) => sum + entry.acquisitionBid, 0);
      const totalPoints = roster.reduce((sum, entry) => {
        return sum + (playerMap.get(entry.playerId)?.totalPoints ?? 0);
      }, 0);

      return [
        member.userId,
        {
          userId: member.userId,
          rosterCount,
          remainingBudget: leagueRow.budgetPerTeam - spentBudget,
          remainingRosterSlots: leagueRow.rosterSize - rosterCount,
          totalPoints,
        },
      ];
    }),
  );
}

async function ensureDraftPriorityOrder(
  tx: TransactionClient,
  leagueId: string,
  members: MemberRow[],
  now: Date,
) {
  const hasMissingPriority = members.some((member) => member.draftPriority === null);

  if (!hasMissingPriority) {
    return [...members].sort(
      (left, right) => (left.draftPriority ?? 0) - (right.draftPriority ?? 0),
    );
  }

  const shuffledMembers = shuffle(members);

  for (const [index, member] of shuffledMembers.entries()) {
    await tx
      .update(leagueMember)
      .set({
        draftPriority: index + 1,
        updatedAt: now,
      })
      .where(eq(leagueMember.id, member.membershipId));
  }

  return shuffledMembers.map((member, index) => ({
    ...member,
    draftPriority: index + 1,
  }));
}

async function persistPriorityOrder(
  tx: TransactionClient,
  members: MemberRow[],
  orderedUserIds: string[],
  now: Date,
) {
  const membershipIdByUser = new Map(
    members.map((member) => [member.userId, member.membershipId]),
  );

  for (const [index, userId] of orderedUserIds.entries()) {
    const membershipId = membershipIdByUser.get(userId);

    if (!membershipId) {
      continue;
    }

    await tx
      .update(leagueMember)
      .set({
        draftPriority: index + 1,
        updatedAt: now,
      })
      .where(eq(leagueMember.id, membershipId));
  }
}

async function buildLeagueDetailResponse(leagueId: string, viewerUserId: string) {
  const access = await getLeagueAccess(viewerUserId, leagueId);

  if (!access) {
    return null;
  }

  const players = await getPlayerPool();
  const playerMap = new Map(players.map((player) => [player.id, player]));
  const members = await getLeagueMembers(leagueId);
  const pendingInvites = await getPendingLeagueInvites(leagueId);
  const rosterRows = await db
    .select()
    .from(rosterEntry)
    .where(eq(rosterEntry.leagueId, leagueId));
  const memberStates = buildMemberStates(access.league, members, rosterRows, playerMap);
  const rosteredPlayerIds = new Set(rosterRows.map((entry) => entry.playerId));
  const availablePlayers = players.filter((player) => !rosteredPlayerIds.has(player.id));

  const openRound = (
    await db
      .select()
      .from(draftRound)
      .where(and(eq(draftRound.leagueId, leagueId), eq(draftRound.status, "open")))
      .orderBy(desc(draftRound.roundNumber))
      .limit(1)
  )[0] ?? null;

  const latestResolvedRound = (
    await db
      .select()
      .from(draftRound)
      .where(and(eq(draftRound.leagueId, leagueId), eq(draftRound.status, "resolved")))
      .orderBy(desc(draftRound.roundNumber))
      .limit(1)
  )[0] ?? null;

  let currentRound: null | {
    id: string;
    roundNumber: number;
    status: string;
    eligiblePlayerMode: string;
    openedAt: Date;
    deadlineAt: Date | null;
    submissionStatuses: Array<{
      userId: string;
      name: string;
      submittedAt: Date | null;
    }>;
    myMaxBid: number;
    players: Array<{
      id: string;
      name: string;
      team: string;
      conference: string;
      suggestedValue: number;
      totalPoints: number | null;
      defaultBid: number;
      myExplicitBid: number | null;
      myEffectiveBid: number;
    }>;
  } = null;

  if (openRound) {
    const roundPlayers = await db
      .select()
      .from(draftRoundPlayer)
      .where(eq(draftRoundPlayer.roundId, openRound.id));
    const submissions = await db
      .select()
      .from(draftSubmission)
      .where(eq(draftSubmission.roundId, openRound.id));
    const viewerSubmission = submissions.find((submission) => submission.userId === viewerUserId);
    const explicitBidRows = viewerSubmission
      ? await db
          .select()
          .from(draftBid)
          .where(eq(draftBid.submissionId, viewerSubmission.id))
      : [];
    const explicitBidMap = new Map(
      explicitBidRows
        .filter((bid) => !bid.isAutoDefault)
        .map((bid) => [bid.playerId, decryptBidAmount(bid.encryptedAmount)]),
    );
    const viewerState = memberStates.get(viewerUserId);
    const myMaxBid = viewerState
      ? computeMaxBid(
          viewerState.remainingBudget,
          viewerState.remainingRosterSlots,
          access.league.minBid,
        )
      : 0;

    currentRound = {
      id: openRound.id,
      roundNumber: openRound.roundNumber,
      status: openRound.status,
      eligiblePlayerMode: openRound.eligiblePlayerMode,
      openedAt: openRound.openedAt,
      deadlineAt: openRound.deadlineAt,
      submissionStatuses: members
        .map((member) => {
          const submission = submissions.find((entry) => entry.userId === member.userId);
          return {
            userId: member.userId,
            name: member.name,
            submittedAt: submission?.submittedAt ?? null,
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name)),
      myMaxBid,
      players: roundPlayers
        .map((roundPlayer) => playerMap.get(roundPlayer.playerId))
        .filter((player): player is NonNullable<typeof player> => Boolean(player))
        .map((player) => {
          const defaultBid = myMaxBid
            ? Math.min(getDefaultBidFromSuggestedValue(player.suggestedValue), myMaxBid)
            : 0;
          const myExplicitBid = explicitBidMap.get(player.id) ?? null;

          return {
            id: player.id,
            name: player.name,
            team: player.team,
            conference: player.conference,
            suggestedValue: player.suggestedValue,
            totalPoints: player.totalPoints,
            defaultBid,
            myExplicitBid,
            myEffectiveBid: myExplicitBid ?? defaultBid,
          };
        }),
    };
  }

  const memberNameMap = new Map(members.map((member) => [member.userId, member.name]));
  const priorityOrder = members.every((member) => member.draftPriority !== null)
    ? [...members]
        .sort((left, right) => (left.draftPriority ?? 0) - (right.draftPriority ?? 0))
        .map((member) => ({
          userId: member.userId,
          name: member.name,
          draftPriority: member.draftPriority,
        }))
    : [];

  const maxRosterCount = Math.max(
    0,
    ...Array.from(memberStates.values()).map((state) => state.rosterCount),
  );

  return {
    league: {
      ...access.league,
      commissionerName: memberNameMap.get(access.league.commissionerUserId) ?? "Unknown",
      isCommissioner: access.isCommissioner,
      canEditRosterSize:
        access.isCommissioner &&
        access.league.phase !== "scoring" &&
        !openRound &&
        maxRosterCount <= access.league.rosterSize,
    },
    members: members
      .map((member) => {
        const state = memberStates.get(member.userId)!;
        return {
          ...member,
          ...state,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name)),
    priorityOrder,
    pendingInvites: pendingInvites.sort((left, right) =>
      left.email.localeCompare(right.email),
    ),
    availablePlayers,
    currentRound,
    lastResolvedRound: latestResolvedRound
      ? {
          id: latestResolvedRound.id,
          roundNumber: latestResolvedRound.roundNumber,
          resolvedAt: latestResolvedRound.resolvedAt,
          results: rosterRows
            .filter((entry) => entry.acquisitionRoundId === latestResolvedRound.id)
            .sort((left, right) => left.acquisitionOrder - right.acquisitionOrder)
            .map((entry) => ({
              order: entry.acquisitionOrder,
              playerId: entry.playerId,
              playerName: entry.playerName,
              playerTeam: entry.playerTeam,
              winnerUserId: entry.userId,
              winnerName: memberNameMap.get(entry.userId) ?? "Unknown",
              winningBid: entry.acquisitionBid,
              wonByTiebreak: entry.wonByTiebreak,
            })),
        }
      : null,
    rosters: members
      .map((member) => {
        const state = memberStates.get(member.userId)!;
        const playersForMember = rosterRows
          .filter((entry) => entry.userId === member.userId)
          .sort((left, right) => left.acquisitionOrder - right.acquisitionOrder)
          .map((entry) => ({
            playerId: entry.playerId,
            playerName: entry.playerName,
            playerTeam: entry.playerTeam,
            acquisitionBid: entry.acquisitionBid,
            acquisitionOrder: entry.acquisitionOrder,
            acquiredInRoundId: entry.acquisitionRoundId,
            totalPoints: playerMap.get(entry.playerId)?.totalPoints ?? 0,
          }));

        return {
          userId: member.userId,
          name: member.name,
          totalPoints: state.totalPoints,
          players: playersForMember,
        };
      })
      .sort((left, right) => right.totalPoints - left.totalPoints || left.name.localeCompare(right.name)),
  };
}

appRouter.get("/dashboard", async (c) => {
  const session = getRequiredSession(c);

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const memberships = await db
    .select({
      leagueId: league.id,
      leagueName: league.name,
      phase: league.phase,
      rosterSize: league.rosterSize,
      commissionerUserId: league.commissionerUserId,
      role: leagueMember.role,
      updatedAt: league.updatedAt,
    })
    .from(leagueMember)
    .innerJoin(league, eq(leagueMember.leagueId, league.id))
    .where(
      and(
        eq(leagueMember.userId, session.user.id),
        eq(leagueMember.status, "active"),
      ),
    )
    .orderBy(desc(league.updatedAt));

  const leagueIds = memberships.map((membership) => membership.leagueId);
  const commissionerIds = Array.from(
    new Set(memberships.map((membership) => membership.commissionerUserId)),
  );
  const activeMembers = leagueIds.length
    ? await db
        .select()
        .from(leagueMember)
        .where(
          and(
            inArray(leagueMember.leagueId, leagueIds),
            eq(leagueMember.status, "active"),
          ),
        )
    : [];
  const commissioners = commissionerIds.length
    ? await db.select().from(user).where(inArray(user.id, commissionerIds))
    : [];
  const commissionerMap = new Map(
    commissioners.map((commissioner) => [commissioner.id, commissioner]),
  );
  const memberCountMap = new Map<string, number>();

  for (const member of activeMembers) {
    memberCountMap.set(member.leagueId, (memberCountMap.get(member.leagueId) ?? 0) + 1);
  }

  const invites = await db
    .select()
    .from(leagueInvite)
    .where(
      and(
        eq(leagueInvite.email, normalizeEmail(session.user.email)),
        eq(leagueInvite.status, "pending"),
      ),
    );

  const inviteLeagueIds = Array.from(new Set(invites.map((invite) => invite.leagueId)));
  const inviteLeagues = inviteLeagueIds.length
    ? await db.select().from(league).where(inArray(league.id, inviteLeagueIds))
    : [];
  const inviteLeagueMap = new Map(inviteLeagues.map((leagueRow) => [leagueRow.id, leagueRow]));
  const inviteUserIds = Array.from(new Set(invites.map((invite) => invite.invitedByUserId)));
  const inviteUsers = inviteUserIds.length
    ? await db.select().from(user).where(inArray(user.id, inviteUserIds))
    : [];
  const inviteUserMap = new Map(inviteUsers.map((inviteUser) => [inviteUser.id, inviteUser]));

  return c.json({
    currentUser: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      canCreateLeague:
        normalizeEmail(session.user.email) === LEAGUE_CREATOR_EMAIL,
    },
    leagues: memberships.map((membership) => ({
      id: membership.leagueId,
      name: membership.leagueName,
      phase: membership.phase,
      rosterSize: membership.rosterSize,
      memberCount: memberCountMap.get(membership.leagueId) ?? 0,
      role: membership.role,
      isCommissioner: membership.commissionerUserId === session.user.id,
      commissionerName:
        commissionerMap.get(membership.commissionerUserId)?.name ?? "Unknown",
    })),
    pendingInvites: invites.map((invite) => ({
      id: invite.id,
      leagueId: invite.leagueId,
      leagueName: inviteLeagueMap.get(invite.leagueId)?.name ?? "Unknown League",
      invitedByName: inviteUserMap.get(invite.invitedByUserId)?.name ?? "Unknown",
      createdAt: invite.createdAt,
    })),
  });
});

appRouter.post("/leagues", async (c) => {
  const session = getRequiredSession(c);

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  if (normalizeEmail(session.user.email) !== LEAGUE_CREATOR_EMAIL) {
    return c.json({ error: "League creation is limited to the commissioner account" }, 403);
  }

  const body = createLeagueSchema.safeParse(await c.req.json().catch(() => null));

  if (!body.success) {
    return c.json({ error: body.error.errors[0]?.message ?? "Invalid request" }, 400);
  }

  const now = new Date();
  const leagueId = randomUUID();

  await db.transaction(async (tx) => {
    await tx.insert(league).values({
      id: leagueId,
      name: body.data.name,
      commissionerUserId: session.user.id,
      phase: "invite",
      rosterSize: body.data.rosterSize,
      budgetPerTeam: 200,
      minBid: 1,
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(leagueMember).values({
      id: randomUUID(),
      leagueId,
      userId: session.user.id,
      role: "commissioner",
      status: "active",
      draftPriority: null,
      createdAt: now,
      updatedAt: now,
    });
  });

  return c.json({ ok: true, leagueId });
});

appRouter.post("/invites/:inviteId/accept", async (c) => {
  const session = getRequiredSession(c);

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const inviteId = c.req.param("inviteId");
  const inviteRows = await db
    .select()
    .from(leagueInvite)
    .where(eq(leagueInvite.id, inviteId))
    .limit(1);
  const invite = inviteRows[0];

  if (!invite || invite.status !== "pending") {
    return c.json({ error: "Invite not found" }, 404);
  }

  if (normalizeEmail(invite.email) !== normalizeEmail(session.user.email)) {
    return c.json({ error: "Invite email does not match your account" }, 403);
  }

  const activeMembers = await getLeagueMembers(invite.leagueId);
  const existingMembership = activeMembers.find((member) => member.userId === session.user.id);

  if (!existingMembership && activeMembers.length >= MAX_ACTIVE_MEMBERS) {
    return c.json({ error: "This league is already full" }, 400);
  }

  const now = new Date();

  await db.transaction(async (tx) => {
    if (!existingMembership) {
      await tx.insert(leagueMember).values({
        id: randomUUID(),
        leagueId: invite.leagueId,
        userId: session.user.id,
        role: "member",
        status: "active",
        draftPriority: null,
        createdAt: now,
        updatedAt: now,
      });
    }

    await tx
      .update(leagueInvite)
      .set({
        status: "accepted",
        acceptedAt: now,
        acceptedByUserId: session.user.id,
        updatedAt: now,
      })
      .where(eq(leagueInvite.id, invite.id));
  });

  return c.json({ ok: true, leagueId: invite.leagueId });
});

appRouter.get("/leagues/:leagueId", async (c) => {
  const session = getRequiredSession(c);

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const detail = await buildLeagueDetailResponse(c.req.param("leagueId"), session.user.id);

  if (!detail) {
    return c.json({ error: "League not found" }, 404);
  }

  return c.json(detail);
});

appRouter.post("/leagues/:leagueId/settings", async (c) => {
  const session = getRequiredSession(c);

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const access = await getLeagueAccess(session.user.id, c.req.param("leagueId"));

  if (!access) {
    return c.json({ error: "League not found" }, 404);
  }

  if (!access.isCommissioner) {
    return c.json({ error: "Only the commissioner can update league settings" }, 403);
  }

  const body = updateLeagueSettingsSchema.safeParse(await c.req.json().catch(() => null));

  if (!body.success) {
    return c.json({ error: body.error.errors[0]?.message ?? "Invalid request" }, 400);
  }

  const openRound = await db
    .select()
    .from(draftRound)
    .where(and(eq(draftRound.leagueId, access.league.id), eq(draftRound.status, "open")))
    .limit(1);

  if (openRound[0]) {
    return c.json({ error: "Close the active round before changing roster size" }, 400);
  }

  if (access.league.phase === "scoring") {
    return c.json({ error: "League settings are locked once scoring begins" }, 400);
  }

  const members = await getLeagueMembers(access.league.id);
  const rosterRows = await db
    .select()
    .from(rosterEntry)
    .where(eq(rosterEntry.leagueId, access.league.id));
  const rosterCountByUser = new Map<string, number>();

  for (const entry of rosterRows) {
    rosterCountByUser.set(entry.userId, (rosterCountByUser.get(entry.userId) ?? 0) + 1);
  }

  const maxRosterCount = Math.max(
    0,
    ...members.map((member) => rosterCountByUser.get(member.userId) ?? 0),
  );

  if (body.data.rosterSize < maxRosterCount) {
    return c.json({
      error: `Roster size cannot be smaller than the current largest roster (${maxRosterCount})`,
    }, 400);
  }

  await db
    .update(league)
    .set({
      rosterSize: body.data.rosterSize,
      updatedAt: new Date(),
    })
    .where(eq(league.id, access.league.id));

  return c.json({ ok: true });
});

appRouter.post("/leagues/:leagueId/members/:userId/remove", async (c) => {
  const session = getRequiredSession(c);

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const access = await getLeagueAccess(session.user.id, c.req.param("leagueId"));

  if (!access) {
    return c.json({ error: "League not found" }, 404);
  }

  if (!access.isCommissioner) {
    return c.json({ error: "Only the commissioner can remove members" }, 403);
  }

  const memberUserId = c.req.param("userId");

  if (memberUserId === access.league.commissionerUserId) {
    return c.json({ error: "The commissioner cannot be removed" }, 400);
  }

  const members = await getLeagueMembers(access.league.id);
  const targetMember = members.find((member) => member.userId === memberUserId);

  if (!targetMember) {
    return c.json({ error: "Member not found" }, 404);
  }

  const playerMap = await getPlayerPoolMap();
  const rosterRows = await db
    .select()
    .from(rosterEntry)
    .where(eq(rosterEntry.leagueId, access.league.id));
  const now = new Date();
  const remainingMembers = members.filter((member) => member.userId !== memberUserId);
  const remainingRosterRows = rosterRows.filter((entry) => entry.userId !== memberUserId);
  const remainingStates = buildMemberStates(
    access.league,
    remainingMembers,
    remainingRosterRows,
    playerMap,
  );
  const nextPriorityOrder = remainingMembers
    .sort((left, right) => (left.draftPriority ?? 999) - (right.draftPriority ?? 999))
    .map((member) => member.userId)
    .filter((userId) => userId !== memberUserId);
  const hasDraftActivity =
    remainingRosterRows.length > 0 ||
    (
      await db
        .select()
        .from(draftRound)
        .where(eq(draftRound.leagueId, access.league.id))
        .limit(1)
    )[0] !== undefined;
  const leaguePhase = hasDraftActivity
    ? Array.from(remainingStates.values()).every((state) => state.remainingRosterSlots === 0)
      ? "scoring"
      : "draft"
    : "invite";

  await db.transaction(async (tx) => {
    await tx
      .delete(draftSubmission)
      .where(
        and(
          eq(draftSubmission.leagueId, access.league.id),
          eq(draftSubmission.userId, memberUserId),
        ),
      );

    await tx
      .delete(rosterEntry)
      .where(
        and(eq(rosterEntry.leagueId, access.league.id), eq(rosterEntry.userId, memberUserId)),
      );

    await tx
      .update(leagueMember)
      .set({
        status: "removed",
        draftPriority: null,
        updatedAt: now,
      })
      .where(eq(leagueMember.id, targetMember.membershipId));

    await persistPriorityOrder(tx, remainingMembers, nextPriorityOrder, now);

    await tx
      .update(league)
      .set({
        phase: leaguePhase,
        updatedAt: now,
      })
      .where(eq(league.id, access.league.id));
  });

  return c.json({ ok: true });
});

appRouter.post("/leagues/:leagueId/invites", async (c) => {
  const session = getRequiredSession(c);

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const access = await getLeagueAccess(session.user.id, c.req.param("leagueId"));

  if (!access) {
    return c.json({ error: "League not found" }, 404);
  }

  if (!access.isCommissioner) {
    return c.json({ error: "Only the commissioner can invite members" }, 403);
  }

  const body = inviteSchema.safeParse(await c.req.json().catch(() => null));

  if (!body.success) {
    return c.json({ error: body.error.errors[0]?.message ?? "Invalid request" }, 400);
  }

  const members = await getLeagueMembers(access.league.id);
  const memberEmails = new Set(members.map((member) => normalizeEmail(member.email)));
  const pendingInvites = await getPendingLeagueInvites(access.league.id);
  const pendingEmails = new Set(pendingInvites.map((invite) => normalizeEmail(invite.email)));
  const now = new Date();
  const created: string[] = [];
  const skipped: string[] = [];
  let capacityRemaining =
    MAX_ACTIVE_MEMBERS - members.length - pendingInvites.length;

  for (const rawEmail of body.data.emails) {
    const email = normalizeEmail(rawEmail);

    if (memberEmails.has(email) || pendingEmails.has(email)) {
      skipped.push(email);
      continue;
    }

    if (capacityRemaining <= 0) {
      skipped.push(email);
      continue;
    }

    const existingInvite = await db
      .select()
      .from(leagueInvite)
      .where(and(eq(leagueInvite.leagueId, access.league.id), eq(leagueInvite.email, email)))
      .limit(1);

    if (existingInvite[0]) {
      await db
        .update(leagueInvite)
        .set({
          status: "pending",
          invitedByUserId: session.user.id,
          acceptedAt: null,
          acceptedByUserId: null,
          updatedAt: now,
        })
        .where(eq(leagueInvite.id, existingInvite[0].id));
    } else {
      await db.insert(leagueInvite).values({
        id: randomUUID(),
        leagueId: access.league.id,
        email,
        invitedByUserId: session.user.id,
        status: "pending",
        acceptedByUserId: null,
        createdAt: now,
        updatedAt: now,
        acceptedAt: null,
      });
    }

    created.push(email);
    pendingEmails.add(email);
    capacityRemaining -= 1;
  }

  await db
    .update(league)
    .set({
      updatedAt: now,
    })
    .where(eq(league.id, access.league.id));

  return c.json({ ok: true, created, skipped });
});

appRouter.post("/leagues/:leagueId/draft/rounds", async (c) => {
  const session = getRequiredSession(c);

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const access = await getLeagueAccess(session.user.id, c.req.param("leagueId"));

  if (!access) {
    return c.json({ error: "League not found" }, 404);
  }

  if (!access.isCommissioner) {
    return c.json({ error: "Only the commissioner can open a round" }, 403);
  }

  if (access.league.phase === "scoring") {
    return c.json({ error: "Draft is already complete" }, 400);
  }

  const existingOpenRound = await db
    .select()
    .from(draftRound)
    .where(and(eq(draftRound.leagueId, access.league.id), eq(draftRound.status, "open")))
    .limit(1);

  if (existingOpenRound[0]) {
    return c.json({ error: "There is already an open round" }, 400);
  }

  const body = openRoundSchema.safeParse(await c.req.json().catch(() => null));

  if (!body.success) {
    return c.json({ error: body.error.errors[0]?.message ?? "Invalid request" }, 400);
  }

  const members = await getLeagueMembers(access.league.id);

  if (members.length < 2) {
    return c.json({ error: "Add at least one other manager before drafting" }, 400);
  }

  const players = await getPlayerPool();
  const rosterRows = await db
    .select()
    .from(rosterEntry)
    .where(eq(rosterEntry.leagueId, access.league.id));
  const rosteredPlayerIds = new Set(rosterRows.map((entry) => entry.playerId));
  const availablePlayers = players.filter((player) => !rosteredPlayerIds.has(player.id));

  if (!availablePlayers.length) {
    return c.json({ error: "No players remain to be drafted" }, 400);
  }

  const availablePlayerIds = new Set(availablePlayers.map((player) => player.id));
  const selectedPlayerIds =
    body.data.mode === "all_remaining"
      ? availablePlayers.map((player) => player.id)
      : (body.data.playerIds ?? []).filter((playerId) => availablePlayerIds.has(playerId));

  if (!selectedPlayerIds.length) {
    return c.json({ error: "Select at least one eligible player" }, 400);
  }

  const latestRound = await db
    .select()
    .from(draftRound)
    .where(eq(draftRound.leagueId, access.league.id))
    .orderBy(desc(draftRound.roundNumber))
    .limit(1);

  const now = new Date();
  const roundId = randomUUID();
  const roundNumber = (latestRound[0]?.roundNumber ?? 0) + 1;
  const deadlineAt = body.data.deadlineAt ? new Date(body.data.deadlineAt) : null;

  await db.transaction(async (tx) => {
    await ensureDraftPriorityOrder(tx, access.league.id, members, now);

    await tx.insert(draftRound).values({
      id: roundId,
      leagueId: access.league.id,
      roundNumber,
      status: "open",
      eligiblePlayerMode: body.data.mode,
      openedByUserId: session.user.id,
      closedByUserId: null,
      createdAt: now,
      updatedAt: now,
      openedAt: now,
      deadlineAt,
      closedAt: null,
      resolvedAt: null,
    });

    await tx.insert(draftRoundPlayer).values(
      selectedPlayerIds.map((playerId) => ({
        id: randomUUID(),
        roundId,
        leagueId: access.league.id,
        playerId,
        createdAt: now,
      })),
    );

    await tx
      .update(league)
      .set({
        phase: "draft",
        updatedAt: now,
      })
      .where(eq(league.id, access.league.id));
  });

  return c.json({ ok: true, roundId });
});

appRouter.post("/leagues/:leagueId/draft/rounds/:roundId/submission", async (c) => {
  const session = getRequiredSession(c);

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const access = await getLeagueAccess(session.user.id, c.req.param("leagueId"));

  if (!access) {
    return c.json({ error: "League not found" }, 404);
  }

  const roundRows = await db
    .select()
    .from(draftRound)
    .where(
      and(
        eq(draftRound.id, c.req.param("roundId")),
        eq(draftRound.leagueId, access.league.id),
        eq(draftRound.status, "open"),
      ),
    )
    .limit(1);
  const round = roundRows[0];

  if (!round) {
    return c.json({ error: "Open round not found" }, 404);
  }

  const body = submitBidsSchema.safeParse(await c.req.json().catch(() => null));

  if (!body.success) {
    return c.json({ error: body.error.errors[0]?.message ?? "Invalid request" }, 400);
  }

  const playerMap = await getPlayerPoolMap();
  const eligiblePlayers = await db
    .select()
    .from(draftRoundPlayer)
    .where(eq(draftRoundPlayer.roundId, round.id));
  const eligiblePlayerIds = new Set(eligiblePlayers.map((player) => player.playerId));
  const rosterRows = await db
    .select()
    .from(rosterEntry)
    .where(eq(rosterEntry.leagueId, access.league.id));
  const members = await getLeagueMembers(access.league.id);
  const memberStates = buildMemberStates(access.league, members, rosterRows, playerMap);
  const viewerState = memberStates.get(session.user.id);

  if (!viewerState || viewerState.remainingRosterSlots <= 0) {
    return c.json({ error: "Your roster is already full" }, 400);
  }

  const maxAllowed = computeMaxBid(
    viewerState.remainingBudget,
    viewerState.remainingRosterSlots,
    access.league.minBid,
  );

  for (const [playerId, amount] of Object.entries(body.data.bids)) {
    if (!eligiblePlayerIds.has(playerId)) {
      return c.json({ error: "You can only bid on players in the active round" }, 400);
    }

    if (amount < access.league.minBid) {
      return c.json({ error: "Bids must be at least the league minimum" }, 400);
    }

    if (amount > maxAllowed) {
      const playerName = playerMap.get(playerId)?.name ?? "player";
      return c.json({
        error: `Bid for ${playerName} exceeds your max allowed bid of $${maxAllowed}`,
      }, 400);
    }
  }

  const now = new Date();
  const existingSubmission = await db
    .select()
    .from(draftSubmission)
    .where(and(eq(draftSubmission.roundId, round.id), eq(draftSubmission.userId, session.user.id)))
    .limit(1);

  const submissionId = existingSubmission[0]?.id ?? randomUUID();

  await db.transaction(async (tx) => {
    if (existingSubmission[0]) {
      await tx
        .update(draftSubmission)
        .set({
          updatedAt: now,
          submittedAt: now,
        })
        .where(eq(draftSubmission.id, submissionId));

      await tx.delete(draftBid).where(eq(draftBid.submissionId, submissionId));
    } else {
      await tx.insert(draftSubmission).values({
        id: submissionId,
        roundId: round.id,
        leagueId: access.league.id,
        userId: session.user.id,
        createdAt: now,
        updatedAt: now,
        submittedAt: now,
      });
    }

    const bidEntries = Object.entries(body.data.bids);

    if (bidEntries.length) {
      await tx.insert(draftBid).values(
        bidEntries.map(([playerId, amount]) => ({
          id: randomUUID(),
          submissionId,
          playerId,
          encryptedAmount: encryptBidAmount(amount),
          isAutoDefault: false,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }
  });

  return c.json({ ok: true });
});

appRouter.post("/leagues/:leagueId/draft/rounds/:roundId/close", async (c) => {
  const session = getRequiredSession(c);

  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const access = await getLeagueAccess(session.user.id, c.req.param("leagueId"));

  if (!access) {
    return c.json({ error: "League not found" }, 404);
  }

  if (!access.isCommissioner) {
    return c.json({ error: "Only the commissioner can close a round" }, 403);
  }

  const roundRows = await db
    .select()
    .from(draftRound)
    .where(
      and(
        eq(draftRound.id, c.req.param("roundId")),
        eq(draftRound.leagueId, access.league.id),
        eq(draftRound.status, "open"),
      ),
    )
    .limit(1);
  const round = roundRows[0];

  if (!round) {
    return c.json({ error: "Open round not found" }, 404);
  }

  const playerMap = await getPlayerPoolMap();
  const members = await getLeagueMembers(access.league.id);
  const rosterRows = await db
    .select()
    .from(rosterEntry)
    .where(eq(rosterEntry.leagueId, access.league.id));
  const startingStates = buildMemberStates(access.league, members, rosterRows, playerMap);
  const roundPlayers = await db
    .select()
    .from(draftRoundPlayer)
    .where(eq(draftRoundPlayer.roundId, round.id));
  const eligiblePlayers = roundPlayers
    .map((roundPlayer) => playerMap.get(roundPlayer.playerId))
    .filter((player): player is NonNullable<typeof player> => Boolean(player));

  const submissions = await db
    .select()
    .from(draftSubmission)
    .where(eq(draftSubmission.roundId, round.id));
  const bids = submissions.length
    ? await db
        .select()
        .from(draftBid)
        .where(inArray(draftBid.submissionId, submissions.map((submission) => submission.id)))
    : [];

  const membersWithPriority = members.every((member) => member.draftPriority !== null)
    ? [...members].sort((left, right) => (left.draftPriority ?? 0) - (right.draftPriority ?? 0))
    : shuffle(members).map((member, index) => ({
        ...member,
        draftPriority: index + 1,
      }));

  let priorityOrder = membersWithPriority.map((member) => member.userId);
  const explicitBidMapByUser = new Map<string, Map<string, number>>();
  const submissionIdByUser = new Map<string, string>();

  for (const submission of submissions) {
    submissionIdByUser.set(submission.userId, submission.id);
    explicitBidMapByUser.set(
      submission.userId,
      new Map(
        bids
          .filter((bid) => bid.submissionId === submission.id && !bid.isAutoDefault)
          .map((bid) => [bid.playerId, decryptBidAmount(bid.encryptedAmount)]),
      ),
    );
  }

  const now = new Date();
  const mutableStates = new Map(
    Array.from(startingStates.entries()).map(([userId, state]) => [
      userId,
      {
        ...state,
      },
    ]),
  );
  const autoBidsToInsert: Array<typeof draftBid.$inferInsert> = [];
  const effectiveBidMapByUser = new Map<string, Map<string, number>>();

  for (const member of membersWithPriority) {
    const state = mutableStates.get(member.userId)!;
    const maxAllowed = computeMaxBid(
      state.remainingBudget,
      state.remainingRosterSlots,
      access.league.minBid,
    );
    const submissionId = submissionIdByUser.get(member.userId) ?? randomUUID();
    const explicitBidMap = explicitBidMapByUser.get(member.userId) ?? new Map<string, number>();
    const effectiveBidMap = new Map<string, number>();

    for (const player of eligiblePlayers) {
      if (maxAllowed < access.league.minBid || state.remainingRosterSlots <= 0) {
        continue;
      }

      const explicitBid = explicitBidMap.get(player.id);
      const effectiveBid = Math.max(
        access.league.minBid,
        Math.min(
          explicitBid ?? getDefaultBidFromSuggestedValue(player.suggestedValue),
          maxAllowed,
        ),
      );
      effectiveBidMap.set(player.id, effectiveBid);

      if (!explicitBidMap.has(player.id)) {
        autoBidsToInsert.push({
          id: randomUUID(),
          submissionId,
          playerId: player.id,
          encryptedAmount: encryptBidAmount(effectiveBid),
          isAutoDefault: true,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    effectiveBidMapByUser.set(member.userId, effectiveBidMap);
    submissionIdByUser.set(member.userId, submissionId);
  }

  const remainingPlayerIds = new Set(
    eligiblePlayers
      .map((player) => player.id)
      .filter((playerId) => !rosterRows.some((entry) => entry.playerId === playerId)),
  );

  const awards: Array<{
    playerId: string;
    playerName: string;
    playerTeam: string;
    winnerUserId: string;
    acquisitionBid: number;
    acquisitionOrder: number;
    wonByTiebreak: boolean;
  }> = [];

  let acquisitionOrder = 1;

  while (remainingPlayerIds.size) {
    let bestCandidate:
      | {
          playerId: string;
          topBid: number;
          suggestedValue: number;
          contenders: string[];
        }
      | null = null;

    for (const playerId of remainingPlayerIds) {
      const player = playerMap.get(playerId);

      if (!player) {
        continue;
      }

      let topBid = 0;
      let contenders: string[] = [];

      for (const member of membersWithPriority) {
        const state = mutableStates.get(member.userId)!;

        if (state.remainingRosterSlots <= 0) {
          continue;
        }

        const currentMaxBid = computeMaxBid(
          state.remainingBudget,
          state.remainingRosterSlots,
          access.league.minBid,
        );
        const bidAmount = effectiveBidMapByUser.get(member.userId)?.get(playerId) ?? 0;

        if (
          bidAmount < access.league.minBid ||
          bidAmount > currentMaxBid ||
          bidAmount > state.remainingBudget
        ) {
          continue;
        }

        if (bidAmount > topBid) {
          topBid = bidAmount;
          contenders = [member.userId];
        } else if (bidAmount === topBid) {
          contenders.push(member.userId);
        }
      }

      if (topBid < access.league.minBid || !contenders.length) {
        continue;
      }

      if (
        !bestCandidate ||
        topBid > bestCandidate.topBid ||
        (topBid === bestCandidate.topBid &&
          player.suggestedValue > bestCandidate.suggestedValue) ||
        (topBid === bestCandidate.topBid &&
          player.suggestedValue === bestCandidate.suggestedValue &&
          player.name.localeCompare(playerMap.get(bestCandidate.playerId)?.name ?? "") < 0)
      ) {
        bestCandidate = {
          playerId,
          topBid,
          suggestedValue: player.suggestedValue,
          contenders,
        };
      }
    }

    if (!bestCandidate) {
      break;
    }

    const sortedContenders = [...bestCandidate.contenders].sort(
      (left, right) => priorityOrder.indexOf(left) - priorityOrder.indexOf(right),
    );
    const winnerUserId = sortedContenders[0];
    const player = playerMap.get(bestCandidate.playerId)!;
    const winnerState = mutableStates.get(winnerUserId)!;

    awards.push({
      playerId: bestCandidate.playerId,
      playerName: player.name,
      playerTeam: player.team,
      winnerUserId,
      acquisitionBid: bestCandidate.topBid,
      acquisitionOrder,
      wonByTiebreak: sortedContenders.length > 1,
    });

    acquisitionOrder += 1;
    winnerState.remainingBudget -= bestCandidate.topBid;
    winnerState.remainingRosterSlots -= 1;
    remainingPlayerIds.delete(bestCandidate.playerId);

    if (sortedContenders.length > 1) {
      priorityOrder = moveWinnerToEnd(priorityOrder, winnerUserId);
    }
  }

  await db.transaction(async (tx) => {
    await persistPriorityOrder(tx, membersWithPriority, priorityOrder, now);

    for (const member of membersWithPriority) {
      const submissionId = submissionIdByUser.get(member.userId)!;
      const existingSubmission = submissions.find((submission) => submission.userId === member.userId);

      if (!existingSubmission) {
        await tx.insert(draftSubmission).values({
          id: submissionId,
          roundId: round.id,
          leagueId: access.league.id,
          userId: member.userId,
          createdAt: now,
          updatedAt: now,
          submittedAt: now,
        });
      }
    }

    if (autoBidsToInsert.length) {
      await tx.insert(draftBid).values(autoBidsToInsert);
    }

    if (awards.length) {
      await tx.insert(rosterEntry).values(
        awards.map((award) => ({
          id: randomUUID(),
          leagueId: access.league.id,
          userId: award.winnerUserId,
          playerId: award.playerId,
          playerName: award.playerName,
          playerTeam: award.playerTeam,
          acquisitionRoundId: round.id,
          acquisitionOrder: award.acquisitionOrder,
          acquisitionBid: award.acquisitionBid,
          wonByTiebreak: award.wonByTiebreak,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }

    const draftComplete = Array.from(mutableStates.values()).every(
      (state) => state.remainingRosterSlots === 0,
    );

    await tx
      .update(draftRound)
      .set({
        status: "resolved",
        closedByUserId: session.user.id,
        closedAt: now,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(eq(draftRound.id, round.id));

    await tx
      .update(league)
      .set({
        phase: draftComplete ? "scoring" : "draft",
        updatedAt: now,
      })
      .where(eq(league.id, access.league.id));
  });

  return c.json({
    ok: true,
    awards: awards.length,
    leaguePhase:
      Array.from(mutableStates.values()).every((state) => state.remainingRosterSlots === 0)
        ? "scoring"
        : "draft",
  });
});
