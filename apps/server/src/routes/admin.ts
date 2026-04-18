import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "@repo/db";
import { auth } from "../auth.js";

const ADMIN_EMAIL = "santhoshnarayan@gmail.com";

type AdminSession = Awaited<ReturnType<typeof auth.api.getSession>>;

export const adminRouter = new Hono<{
  Variables: { session: AdminSession };
}>();

adminRouter.use("*", async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  if (session.user.email?.toLowerCase() !== ADMIN_EMAIL) {
    return c.json({ error: "Forbidden" }, 403);
  }
  c.set("session", session);
  await next();
});

// ---------- DB inspection ----------

type ColumnInfo = {
  name: string;
  dataType: string;
  isNullable: boolean;
  columnDefault: string | null;
};

type TableInfo = {
  name: string;
  rowCount: number | null;
  columns: ColumnInfo[];
};

async function listTables(): Promise<TableInfo[]> {
  const columnsResult = await db.execute(sql`
    select table_name, column_name, data_type, is_nullable, column_default, ordinal_position
    from information_schema.columns
    where table_schema = 'public'
    order by table_name, ordinal_position
  `);

  const rows = columnsResult as unknown as Array<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>;

  const byTable = new Map<string, ColumnInfo[]>();
  for (const row of rows) {
    const list = byTable.get(row.table_name) ?? [];
    list.push({
      name: row.column_name,
      dataType: row.data_type,
      isNullable: row.is_nullable === "YES",
      columnDefault: row.column_default,
    });
    byTable.set(row.table_name, list);
  }

  const countsResult = await db.execute(sql`
    select relname as table_name, reltuples::bigint as estimate
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  `);
  const counts = new Map<string, number>();
  for (const r of countsResult as unknown as Array<{ table_name: string; estimate: string | number }>) {
    counts.set(r.table_name, Number(r.estimate));
  }

  return [...byTable.entries()]
    .map(([name, columns]) => ({
      name,
      rowCount: counts.get(name) ?? null,
      columns,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

adminRouter.get("/db/tables", async (c) => {
  try {
    const tables = await listTables();
    return c.json({ tables });
  } catch (err) {
    console.error("[admin] listTables failed", err);
    return c.json({ error: "Failed to inspect schema" }, 500);
  }
});

const MAX_PAGE_SIZE = 200;

adminRouter.get("/db/tables/:table", async (c) => {
  const tableParam = c.req.param("table");
  const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.parseInt(c.req.query("pageSize") ?? "25", 10) || 25),
  );

  // Validate table name against live schema to prevent injection.
  const tables = await listTables();
  const match = tables.find((t) => t.name === tableParam);
  if (!match) {
    return c.json({ error: "Unknown table" }, 404);
  }

  const offset = (page - 1) * pageSize;

  // Order by first column ascending for stable pagination.
  const orderCol = match.columns[0]?.name ?? "";
  const orderClause = orderCol
    ? sql`order by ${sql.identifier(orderCol)} asc`
    : sql``;

  const rowsResult = await db.execute(sql`
    select * from ${sql.identifier(match.name)}
    ${orderClause}
    limit ${pageSize + 1}
    offset ${offset}
  `);
  const rows = rowsResult as unknown as Record<string, unknown>[];
  const hasMore = rows.length > pageSize;
  const items = hasMore ? rows.slice(0, pageSize) : rows;

  return c.json({
    table: match.name,
    columns: match.columns,
    page,
    pageSize,
    hasMore,
    items,
  });
});

// ---------- Railway logs proxy ----------

const RAILWAY_GRAPHQL = "https://backboard.railway.com/graphql/v2";

type RailwayLogEntry = {
  timestamp: string;
  message: string;
  severity: string | null;
  attributes?: Array<{ key: string; value: string }>;
};

adminRouter.get("/logs/services", async (c) => {
  const token = process.env.RAILWAY_API_TOKEN;
  const projectId = process.env.RAILWAY_PROJECT_ID;
  if (!token || !projectId) {
    return c.json(
      { error: "Railway proxy not configured", needsEnv: ["RAILWAY_API_TOKEN", "RAILWAY_PROJECT_ID"] },
      503,
    );
  }

  const query = `
    query Project($id: String!) {
      project(id: $id) {
        name
        environments { edges { node { id name } } }
        services { edges { node { id name } } }
      }
    }
  `;

  const res = await fetch(RAILWAY_GRAPHQL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables: { id: projectId } }),
  });

  if (!res.ok) {
    const text = await res.text();
    return c.json({ error: "Railway request failed", status: res.status, body: text }, 502);
  }

  const body = (await res.json()) as {
    data?: {
      project?: {
        name: string;
        environments: { edges: Array<{ node: { id: string; name: string } }> };
        services: { edges: Array<{ node: { id: string; name: string } }> };
      };
    };
    errors?: unknown;
  };

  if (!body.data?.project) {
    return c.json({ error: "Railway project not found", details: body.errors }, 502);
  }

  return c.json({
    project: body.data.project.name,
    environments: body.data.project.environments.edges.map((e) => e.node),
    services: body.data.project.services.edges.map((e) => e.node),
  });
});

adminRouter.get("/logs", async (c) => {
  const token = process.env.RAILWAY_API_TOKEN;
  const projectId = process.env.RAILWAY_PROJECT_ID;
  const defaultEnvId = process.env.RAILWAY_ENVIRONMENT_ID;
  if (!token || !projectId) {
    return c.json(
      { error: "Railway proxy not configured", needsEnv: ["RAILWAY_API_TOKEN", "RAILWAY_PROJECT_ID"] },
      503,
    );
  }

  const environmentId = c.req.query("environmentId") || defaultEnvId;
  const serviceId = c.req.query("serviceId");
  const filter = c.req.query("filter") ?? "";
  const limit = Math.min(
    1000,
    Math.max(1, Number.parseInt(c.req.query("limit") ?? "200", 10) || 200),
  );
  const beforeDate = c.req.query("before");

  if (!environmentId) {
    return c.json({ error: "environmentId is required (or set RAILWAY_ENVIRONMENT_ID)" }, 400);
  }

  const query = `
    query EnvLogs($environmentId: String!, $filter: String, $beforeLimit: Int, $beforeDate: String) {
      environmentLogs(
        environmentId: $environmentId,
        filter: $filter,
        beforeLimit: $beforeLimit,
        beforeDate: $beforeDate
      ) {
        timestamp
        message
        severity
        attributes { key value }
      }
    }
  `;

  const effectiveFilter = serviceId
    ? `@service:${serviceId}${filter ? ` ${filter}` : ""}`
    : filter;

  const res = await fetch(RAILWAY_GRAPHQL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      query,
      variables: {
        environmentId,
        filter: effectiveFilter || null,
        beforeLimit: limit,
        beforeDate: beforeDate || null,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return c.json({ error: "Railway request failed", status: res.status, body: text }, 502);
  }

  const body = (await res.json()) as {
    data?: { environmentLogs?: RailwayLogEntry[] };
    errors?: unknown;
  };

  if (!body.data?.environmentLogs) {
    return c.json({ error: "Railway logs unavailable", details: body.errors }, 502);
  }

  // Railway returns ascending timestamps (oldest first). Flip so the admin UI
  // shows newest entries at the top.
  const entries = [...body.data.environmentLogs].sort((a, b) =>
    b.timestamp.localeCompare(a.timestamp),
  );
  return c.json({ entries });
});
