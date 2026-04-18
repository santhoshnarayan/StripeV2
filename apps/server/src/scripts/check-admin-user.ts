import { db, user } from "@repo/db";
import { eq } from "drizzle-orm";

const rows = await db
  .select({ id: user.id, email: user.email, name: user.name })
  .from(user)
  .where(eq(user.email, "santhoshnarayan@gmail.com"));

console.log(rows.length ? "FOUND: " + JSON.stringify(rows[0]) : "MISSING");
process.exit(0);
