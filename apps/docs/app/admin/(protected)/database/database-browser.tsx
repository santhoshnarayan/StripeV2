"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

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

type TableData = {
  table: string;
  columns: ColumnInfo[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  items: Record<string, unknown>[];
};

export function DatabaseBrowser() {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState<TableData | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/db/tables", { credentials: "include" });
        if (!res.ok) {
          setTablesError(`Failed to load tables (${res.status})`);
          return;
        }
        const payload = (await res.json()) as { tables: TableInfo[] };
        setTables(payload.tables);
      } catch (err) {
        setTablesError(err instanceof Error ? err.message : "Failed to load tables");
      }
    })();
  }, []);

  const load = useCallback(async (table: string, p: number, ps: number) => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/admin/db/tables/${encodeURIComponent(table)}?page=${p}&pageSize=${ps}`,
        { credentials: "include" },
      );
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        setData(null);
        setTablesError(payload.error ?? `Failed to load rows (${res.status})`);
        return;
      }
      setTablesError(null);
      const payload = (await res.json()) as TableData;
      setData(payload);
    } finally {
      setLoading(false);
    }
  }, []);

  const onSelect = useCallback(
    (table: string) => {
      setSelected(table);
      setPage(1);
      load(table, 1, pageSize);
    },
    [load, pageSize],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tables;
    return tables.filter((t) => t.name.toLowerCase().includes(q));
  }, [tables, query]);

  return (
    <div className="flex min-h-[calc(100vh-4rem)] gap-4">
      <aside className="w-64 shrink-0 rounded-lg border border-gray-200 bg-white">
        <div className="border-b border-gray-200 p-2">
          <input
            type="search"
            placeholder="Filter tables..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-gray-900 focus:outline-none"
          />
        </div>
        <ul className="max-h-[calc(100vh-9rem)] overflow-y-auto p-1 text-sm">
          {tablesError && (
            <li className="px-2 py-2 text-xs text-red-600">{tablesError}</li>
          )}
          {filtered.map((t) => (
            <li key={t.name}>
              <button
                type="button"
                onClick={() => onSelect(t.name)}
                className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left hover:bg-gray-100 ${
                  selected === t.name ? "bg-gray-900 text-white hover:bg-gray-900" : ""
                }`}
              >
                <span className="truncate">{t.name}</span>
                {t.rowCount !== null && (
                  <span
                    className={`ml-2 text-xs ${
                      selected === t.name ? "text-gray-300" : "text-gray-500"
                    }`}
                  >
                    {formatCount(t.rowCount)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex-1 min-w-0 rounded-lg border border-gray-200 bg-white">
        {!selected ? (
          <div className="flex h-full items-center justify-center p-12 text-gray-500">
            <div className="text-center">
              <p className="text-base font-medium">Select a table</p>
              <p className="mt-1 text-sm">Choose a table from the sidebar to browse its rows.</p>
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-4 py-2">
              <div>
                <h2 className="text-sm font-semibold">{selected}</h2>
                {data && (
                  <p className="text-xs text-gray-500">
                    {data.columns.length} columns · page {data.page} · {data.items.length}{" "}
                    row{data.items.length === 1 ? "" : "s"}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 text-xs">
                <label className="flex items-center gap-1">
                  <span className="text-gray-500">Page size</span>
                  <select
                    value={pageSize}
                    onChange={(e) => {
                      const ps = Number.parseInt(e.target.value, 10);
                      setPageSize(ps);
                      setPage(1);
                      load(selected, 1, ps);
                    }}
                    className="rounded-md border border-gray-300 bg-white px-2 py-1"
                  >
                    {[10, 25, 50, 100, 200].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={() => load(selected, page, pageSize)}
                  className="rounded-md border border-gray-300 px-2 py-1 hover:bg-gray-50"
                >
                  Refresh
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto">
              {loading && (
                <div className="p-4 text-sm text-gray-500">Loading…</div>
              )}
              {!loading && data && (
                <table className="min-w-full border-collapse text-xs font-mono">
                  <thead className="sticky top-0 bg-gray-50 text-gray-600">
                    <tr>
                      {data.columns.map((col) => (
                        <th
                          key={col.name}
                          className="border-b border-gray-200 px-3 py-2 text-left font-medium"
                        >
                          <div className="flex flex-col">
                            <span>{col.name}</span>
                            <span className="text-[10px] font-normal text-gray-400">
                              {col.dataType}
                            </span>
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((row, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        {data.columns.map((col) => (
                          <td
                            key={col.name}
                            className="border-b border-gray-100 px-3 py-1.5 align-top"
                          >
                            <Cell value={row[col.name]} />
                          </td>
                        ))}
                      </tr>
                    ))}
                    {data.items.length === 0 && (
                      <tr>
                        <td
                          colSpan={data.columns.length || 1}
                          className="px-3 py-6 text-center text-gray-500"
                        >
                          No rows
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>

            {data && (
              <div className="flex items-center justify-between border-t border-gray-200 px-4 py-2 text-xs">
                <div className="text-gray-500">
                  Page {data.page}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={data.page <= 1 || loading}
                    onClick={() => {
                      const p = Math.max(1, data.page - 1);
                      setPage(p);
                      load(selected, p, pageSize);
                    }}
                    className="rounded-md border border-gray-300 px-3 py-1 hover:bg-gray-50 disabled:opacity-40"
                  >
                    Prev
                  </button>
                  <button
                    type="button"
                    disabled={!data.hasMore || loading}
                    onClick={() => {
                      const p = data.page + 1;
                      setPage(p);
                      load(selected, p, pageSize);
                    }}
                    className="rounded-md border border-gray-300 px-3 py-1 hover:bg-gray-50 disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function Cell({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="text-gray-400">null</span>;
  }
  if (typeof value === "boolean") {
    return <span>{value ? "true" : "false"}</span>;
  }
  if (value instanceof Date) {
    return <span>{value.toISOString()}</span>;
  }
  if (typeof value === "object") {
    return (
      <pre className="max-w-xs whitespace-pre-wrap break-all text-[11px] text-gray-700">
        {JSON.stringify(value)}
      </pre>
    );
  }
  const str = String(value);
  if (str.length > 120) {
    return (
      <span title={str} className="block max-w-xs truncate">
        {str}
      </span>
    );
  }
  return <span>{str}</span>;
}

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}m`;
}
