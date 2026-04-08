import { builder } from "../builder.js";
import { db, user } from "@repo/db";
import { eq } from "drizzle-orm";

const UserType = builder.objectRef<{
  id: string;
  name: string;
  email: string;
  image: string | null;
  createdAt: Date;
}>("User");

UserType.implement({
  fields: (t) => ({
    id: t.exposeString("id"),
    name: t.exposeString("name"),
    email: t.exposeString("email"),
    image: t.exposeString("image", { nullable: true }),
    createdAt: t.field({
      type: "String",
      resolve: (u) => u.createdAt.toISOString(),
    }),
  }),
});

builder.queryField("me", (t) =>
  t.field({
    type: UserType,
    nullable: true,
    resolve: async (_root, _args, ctx) => {
      if (!ctx.userId) return null;
      const result = await db
        .select()
        .from(user)
        .where(eq(user.id, ctx.userId))
        .limit(1);
      return result[0] ?? null;
    },
  })
);

builder.queryField("users", (t) =>
  t.field({
    type: [UserType],
    resolve: async () => {
      return db.select().from(user);
    },
  })
);
