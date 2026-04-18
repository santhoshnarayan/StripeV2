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
  sort: string | null;
  dir: "asc" | "desc";
  items: Record<string, unknown>[];
};

type SortState = { col: string; dir: "asc" | "desc" } | null;

export function DatabaseBrowser() {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState<TableData | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});

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

  const load = useCallback(
    async (
      table: string,
      p: number,
      ps: number,
      s: SortState,
      f: Record<string, string>,
    ) => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        params.set("page", String(p));
        params.set("pageSize", String(ps));
        if (s) {
          params.set("sort", s.col);
          params.set("dir", s.dir);
        }
        for (const [col, v] of Object.entries(f)) {
          const trimmed = v.trim();
          if (trimmed) params.set(`f_${col}`, trimmed);
        }
        const res = await fetch(
          `/api/admin/db/tables/${encodeURIComponent(table)}?${params.toString()}`,
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
    },
    [],
  );

  const onSelect = useCallback(
    (table: string) => {
      setSelected(table);
      setPage(1);
      setSort(null);
      setFilters({});
      load(table, 1, pageSize, null, {});
    },
    [load, pageSize],
  );

  const toggleSort = useCallback(
    (col: string) => {
      if (!selected) return;
      const next: SortState =
        !sort || sort.col !== col
          ? { col, dir: "asc" }
          : sort.dir === "asc"
            ? { col, dir: "desc" }
            : null;
      setSort(next);
      setPage(1);
      load(selected, 1, pageSize, next, filters);
    },
    [selected, sort, pageSize, filters, load],
  );

  const setColumnFilter = useCallback(
    (col: string, value: string) => {
      setFilters((prev) => ({ ...prev, [col]: value }));
    },
    [],
  );

  useEffect(() => {
    if (!selected) return;
    const handle = setTimeout(() => {
      setPage(1);
      load(selected, 1, pageSize, sort, filters);
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

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
                      load(selected, 1, ps, sort, filters);
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
                {(sort || Object.values(filters).some((v) => v.trim())) && (
                  <button
                    type="button"
                    onClick={() => {
                      setSort(null);
                      setFilters({});
                      setPage(1);
                      load(selected, 1, pageSize, null, {});
                    }}
                    className="rounded-md border border-gray-300 px-2 py-1 hover:bg-gray-50"
                  >
                    Clear
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => load(selected, page, pageSize, sort, filters)}
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
                      {data.columns.map((col) => {
                        const active = sort?.col === col.name;
                        const arrow = active ? (sort.dir === "asc" ? "▲" : "▼") : "";
                        return (
                          <th
                            key={col.name}
                            className="border-b border-gray-200 px-3 py-2 text-left font-medium"
                          >
                            <button
                              type="button"
                              onClick={() => toggleSort(col.name)}
                              className="flex w-full flex-col items-start text-left hover:text-gray-900"
                              title="Click to sort"
                            >
                              <span className="flex items-center gap-1">
                                {col.name}
                                {arrow && (
                                  <span className="text-gray-500">{arrow}</span>
                                )}
                              </span>
                              <span className="text-[10px] font-normal text-gray-400">
                                {col.dataType}
                              </span>
                            </button>
                          </th>
                        );
                      })}
                    </tr>
                    <tr>
                      {data.columns.map((col) => (
                        <th
                          key={col.name}
                          className="border-b border-gray-200 px-2 py-1 align-top"
                        >
                          <input
                            type="text"
                            value={filters[col.name] ?? ""}
                            onChange={(e) =>
                              setColumnFilter(col.name, e.target.value)
                            }
                            placeholder="filter…"
                            className="w-full rounded border border-gray-200 bg-white px-2 py-0.5 text-xs font-normal font-sans focus:border-gray-400 focus:outline-none"
                          />
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
                      load(selected, p, pageSize, sort, filters);
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
                      load(selected, p, pageSize, sort, filters);
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
