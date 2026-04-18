"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type RailwayService = { id: string; name: string };
type RailwayEnvironment = { id: string; name: string };

type LogEntry = {
  timestamp: string;
  message: string;
  severity: string | null;
  attributes?: Array<{ key: string; value: string }>;
};

type ServicesResponse = {
  project: string;
  environments: RailwayEnvironment[];
  services: RailwayService[];
};

const LIMIT_OPTIONS = [100, 200, 500, 1000];

export function LogsViewer() {
  const [services, setServices] = useState<RailwayService[]>([]);
  const [environments, setEnvironments] = useState<RailwayEnvironment[]>([]);
  const [project, setProject] = useState<string | null>(null);
  const [serviceId, setServiceId] = useState<string>("");
  const [environmentId, setEnvironmentId] = useState<string>("");
  const [filter, setFilter] = useState("");
  const [debouncedFilter, setDebouncedFilter] = useState("");
  const [limit, setLimit] = useState(200);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const autoTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/logs/services", { credentials: "include" });
        if (res.status === 503) {
          const payload = (await res.json()) as { needsEnv?: string[] };
          setConfigError(
            `Railway proxy not configured. Set ${payload.needsEnv?.join(", ") ?? "env vars"} on the server.`,
          );
          return;
        }
        if (!res.ok) {
          setConfigError(`Failed to load Railway services (${res.status})`);
          return;
        }
        const payload = (await res.json()) as ServicesResponse;
        setProject(payload.project);
        setServices(payload.services);
        setEnvironments(payload.environments);
        if (payload.environments[0]) setEnvironmentId(payload.environments[0].id);
      } catch (err) {
        setConfigError(err instanceof Error ? err.message : "Failed to load services");
      }
    })();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedFilter(filter), 400);
    return () => clearTimeout(t);
  }, [filter]);

  const load = useCallback(async () => {
    if (!environmentId) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        environmentId,
        limit: String(limit),
      });
      if (serviceId) params.set("serviceId", serviceId);
      if (debouncedFilter) params.set("filter", debouncedFilter);

      const res = await fetch(`/api/admin/logs?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        setError(payload.error ?? `Failed to load logs (${res.status})`);
        return;
      }
      const payload = (await res.json()) as { entries: LogEntry[] };
      setEntries(payload.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load logs");
    } finally {
      setLoading(false);
    }
  }, [environmentId, serviceId, debouncedFilter, limit]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (autoTimer.current) {
      clearInterval(autoTimer.current);
      autoTimer.current = null;
    }
    if (autoRefresh) {
      autoTimer.current = setInterval(load, 5000);
    }
    return () => {
      if (autoTimer.current) clearInterval(autoTimer.current);
    };
  }, [autoRefresh, load]);

  const levelColor = useMemo(
    () => ({
      error: "text-red-600",
      warn: "text-amber-600",
      warning: "text-amber-600",
      info: "text-gray-700",
      debug: "text-gray-400",
      trace: "text-gray-400",
    } as Record<string, string>),
    [],
  );

  if (configError) {
    return (
      <div className="mx-auto max-w-xl rounded-lg border border-amber-300 bg-amber-50 p-6 mt-8 text-sm text-amber-900">
        <p className="font-medium">Logs proxy not configured</p>
        <p className="mt-2">{configError}</p>
        <p className="mt-3 text-xs text-amber-800">
          Required env vars: <code>RAILWAY_API_TOKEN</code>, <code>RAILWAY_PROJECT_ID</code>,
          and optionally <code>RAILWAY_ENVIRONMENT_ID</code> for the default environment.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white p-3 text-sm">
        {project && (
          <span className="rounded-md bg-gray-100 px-2 py-1 text-xs font-medium text-gray-700">
            {project}
          </span>
        )}
        <label className="flex items-center gap-1 text-xs">
          <span className="text-gray-500">Environment</span>
          <select
            value={environmentId}
            onChange={(e) => setEnvironmentId(e.target.value)}
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
          >
            {environments.map((env) => (
              <option key={env.id} value={env.id}>
                {env.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs">
          <span className="text-gray-500">Service</span>
          <select
            value={serviceId}
            onChange={(e) => setServiceId(e.target.value)}
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
          >
            <option value="">All services</option>
            {services.map((svc) => (
              <option key={svc.id} value={svc.id}>
                {svc.name}
              </option>
            ))}
          </select>
        </label>
        <input
          type="search"
          placeholder="Filter (e.g. @level:error auction)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="min-w-[220px] flex-1 rounded-md border border-gray-300 bg-white px-2 py-1 text-sm focus:border-gray-900 focus:outline-none"
        />
        <label className="flex items-center gap-1 text-xs">
          <span className="text-gray-500">Limit</span>
          <select
            value={limit}
            onChange={(e) => setLimit(Number.parseInt(e.target.value, 10))}
            className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm"
          >
            {LIMIT_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          Auto-refresh 5s
        </label>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="rounded-md border border-gray-300 bg-white px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto rounded-lg border border-gray-200 bg-gray-950 font-mono text-xs text-gray-100">
        {entries.length === 0 && !loading && (
          <div className="p-4 text-gray-400">No log entries.</div>
        )}
        <ul className="divide-y divide-gray-800">
          {entries.map((entry, i) => (
            <li key={i} className="flex gap-3 px-3 py-1 hover:bg-gray-900">
              <span className="shrink-0 text-gray-500">
                {new Date(entry.timestamp).toLocaleTimeString(undefined, { hour12: false })}
              </span>
              {entry.severity && (
                <span
                  className={`shrink-0 uppercase ${levelColor[entry.severity.toLowerCase()] ?? "text-gray-400"}`}
                >
                  {entry.severity}
                </span>
              )}
              <span className="whitespace-pre-wrap break-all text-gray-100">
                {entry.message}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
