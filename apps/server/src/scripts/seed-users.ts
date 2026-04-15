import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import {
  account,
  closeDb,
  db,
  league,
  leagueMember,
  user,
} from "@repo/db";

type SeedUser = {
  name: string;
  email: string;
  password: string;
};

const INITIAL_LEAGUE_ID = "founders-league";
const INITIAL_LEAGUE_NAME = "Founders League";
const COMMISSIONER_EMAIL = "santhoshnarayan@gmail.com";

const seedUsers: SeedUser[] = [
  {
    name: "Santhosh Narayan",
    email: "santhoshnarayan@gmail.com",
    password: "Santhosh31",
  },
  {
    name: "Krishna Hegde",
    email: "kheg8152@gmail.com",
    password: "Krishna42",
  },
  {
    name: "Jon Sobilo",
    email: "jon.sobilo@gmail.com",
    password: "Jon17",
  },
  {
    name: "Vijay Narayan",
    email: "vijaynarayan@gmail.com",
    password: "Vijay58",
  },
  {
    name: "Nithin Krishnan",
    email: "nithink23@gmail.com",
    password: "Nithin24",
  },
  {
    name: "Sudhin Krishnan",
    email: "ceramiccornfields@gmail.com",
    password: "Sudhin63",
  },
  {
    name: "Mike Pudlow",
    email: "mikepudlow@gmail.com",
    password: "Mike11",
  },
  {
    name: "Abhinav Ravi",
    email: "abhi2791@gmail.com",
    password: "Abhinav77",
  },
  {
    name: "Robin Jiang",
    email: "robdawg@gmail.com",
    password: "Robin35",
  },
  {
    name: "Kody Thompson",
    email: "kdy922@gmail.com",
    password: "Kody90",
  },
];

async function upsertUser(seedUser: SeedUser) {
  const now = new Date();
  const normalizedEmail = seedUser.email.toLowerCase();
  const passwordHash = await hashPassword(seedUser.password);

  const existingUsers = await db
    .select()
    .from(user)
    .where(eq(user.email, normalizedEmail))
    .limit(1);

  const existingUser = existingUsers[0];
  const userId = existingUser?.id ?? randomUUID();

  if (existingUser) {
    await db
      .update(user)
      .set({
        name: seedUser.name,
        emailVerified: true,
        updatedAt: now,
      })
      .where(eq(user.id, userId));
  } else {
    await db.insert(user).values({
      id: userId,
      name: seedUser.name,
      email: normalizedEmail,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  const existingAccounts = await db
    .select()
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "credential")))
    .limit(1);

  const existingAccount = existingAccounts[0];

  if (existingAccount) {
    await db
      .update(account)
      .set({
        accountId: userId,
        password: passwordHash,
        updatedAt: now,
      })
      .where(eq(account.id, existingAccount.id));
  } else {
    await db.insert(account).values({
      id: randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      scope: null,
      password: passwordHash,
      createdAt: now,
      updatedAt: now,
    });
  }

  return {
    ...seedUser,
    existed: Boolean(existingUser),
  };
}

async function main() {
  const results: Array<Awaited<ReturnType<typeof upsertUser>>> = [];

  for (const seedUser of seedUsers) {
    results.push(await upsertUser(seedUser));
  }

  const seededUserRows = await db
    .select()
    .from(user)
    .where(eq(user.email, COMMISSIONER_EMAIL));
  const commissioner = seededUserRows[0];

  if (!commissioner) {
    throw new Error("Commissioner account was not created");
  }

  const leagueRows = await db
    .select()
    .from(league)
    .where(eq(league.id, INITIAL_LEAGUE_ID))
    .limit(1);
  const existingLeague = leagueRows[0];
  const now = new Date();

  if (existingLeague) {
    await db
      .update(league)
      .set({
        name: INITIAL_LEAGUE_NAME,
        commissionerUserId: commissioner.id,
        phase: "invite",
        rosterSize: 10,
        budgetPerTeam: 200,
        minBid: 1,
        updatedAt: now,
      })
      .where(eq(league.id, INITIAL_LEAGUE_ID));
  } else {
    await db.insert(league).values({
      id: INITIAL_LEAGUE_ID,
      name: INITIAL_LEAGUE_NAME,
      commissionerUserId: commissioner.id,
      phase: "invite",
      rosterSize: 10,
      budgetPerTeam: 200,
      minBid: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  for (const seededUser of results) {
    const matchingUsers = await db
      .select()
      .from(user)
      .where(eq(user.email, seededUser.email.toLowerCase()))
      .limit(1);
    const matchedUser = matchingUsers[0];

    if (!matchedUser) {
      continue;
    }

    const existingMembership = await db
      .select()
      .from(leagueMember)
      .where(
        and(
          eq(leagueMember.leagueId, INITIAL_LEAGUE_ID),
          eq(leagueMember.userId, matchedUser.id),
        ),
      )
      .limit(1);

    const role = seededUser.email.toLowerCase() === COMMISSIONER_EMAIL ? "commissioner" : "member";

    if (existingMembership[0]) {
      await db
        .update(leagueMember)
        .set({
          role,
          status: "active",
          draftPriority: null,
          updatedAt: now,
        })
        .where(eq(leagueMember.id, existingMembership[0].id));
    } else {
      await db.insert(leagueMember).values({
        id: randomUUID(),
        leagueId: INITIAL_LEAGUE_ID,
        userId: matchedUser.id,
        role,
        status: "active",
        draftPriority: null,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  console.log("Seeded users:");

  for (const result of results) {
    const status = result.existed ? "updated" : "created";
    console.log(`- ${result.name} <${result.email}> | ${result.password} | ${status}`);
  }

  console.log("");
  console.log(`Seeded league: ${INITIAL_LEAGUE_NAME} (${INITIAL_LEAGUE_ID})`);
  console.log(`- Commissioner: Santhosh Narayan <${COMMISSIONER_EMAIL}>`);
  console.log(`- Members: ${results.length}`);
}

try {
  await main();
} finally {
  await closeDb();
}
