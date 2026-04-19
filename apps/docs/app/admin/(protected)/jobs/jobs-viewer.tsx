"use client";

import { useCallback, useEffect, useState } from "react";

type Job = {
  id: string;
  name: string;
  description: string | null;
  schedule: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
  nextRunAt: string | null;
  runCount: number;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
};

function relTime(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "in the future";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function statusBadge(job: Job): { label: string; className: string } {
  if (!job.enabled) return { label: "paused", className: "bg-gray-200 text-gray-700" };
  if (job.lastStatus === "running")
    return { label: "running", className: "bg-blue-100 text-blue-800" };
  if (job.lastStatus === "failure")
    return { label: "failed", className: "bg-red-100 text-red-800" };
  if (job.lastStatus === "success")
    return { label: "ok", className: "bg-emerald-100 text-emerald-800" };
  return { label: "idle", className: "bg-gray-100 text-gray-600" };
}

export function JobsViewer() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/jobs", { credentials: "include" });
      if (!res.ok) {
        setError(`Failed to load jobs (${res.status})`);
        return;
      }
      const payload = (await res.json()) as { jobs: Job[] };
      setJobs(payload.jobs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load jobs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const post = useCallback(
    async (path: string, body?: unknown) => {
      const res = await fetch(path, {
        method: "POST",
        credentials: "include",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Request failed (${res.status})`);
      }
    },
    [],
  );

  const withBusy = useCallback(
    async (id: string, fn: () => Promise<void>) => {
      setBusyId(id);
      setError(null);
      try {
        await fn();
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Action failed");
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Cron jobs</h1>
          <p className="text-xs text-gray-500">
            Schedules from the <code>cron_job</code> table. Edits apply on save —
            no redeploy needed.
          </p>
        </div>
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

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase tracking-wider text-gray-500">
            <tr>
              <th className="px-3 py-2">Job</th>
              <th className="px-3 py-2">Schedule</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Last run</th>
              <th className="px-3 py-2">Runs</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {jobs.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-gray-400">
                  No jobs found.
                </td>
              </tr>
            )}
            {jobs.map((job) => {
              const badge = statusBadge(job);
              const busy = busyId === job.id;
              const scheduleValue = editing[job.id] ?? job.schedule;
              const dirty = scheduleValue !== job.schedule;
              return (
                <tr key={job.id} className="align-top">
                  <td className="px-3 py-2">
                    <div className="font-medium text-gray-900">{job.name}</div>
                    {job.description && (
                      <div className="text-xs text-gray-500">{job.description}</div>
                    )}
                    <div className="text-[10px] text-gray-400 font-mono">{job.id}</div>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      value={scheduleValue}
                      onChange={(e) =>
                        setEditing((prev) => ({ ...prev, [job.id]: e.target.value }))
                      }
                      className="w-36 rounded-md border border-gray-300 bg-white px-2 py-1 font-mono text-xs focus:border-gray-900 focus:outline-none"
                      placeholder="* * * * *"
                    />
                    {dirty && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          withBusy(job.id, async () => {
                            await post(`/api/admin/jobs/${job.id}/update`, {
                              schedule: scheduleValue,
                            });
                            setEditing((prev) => {
                              const next = { ...prev };
                              delete next[job.id];
                              return next;
                            });
                          })
                        }
                        className="ml-1 rounded-md border border-gray-900 bg-gray-900 px-2 py-1 text-xs text-white hover:bg-gray-800 disabled:opacity-50"
                      >
                        Save
                      </button>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${badge.className}`}
                    >
                      {badge.label}
                    </span>
                    {job.lastError && (
                      <div
                        className="mt-1 max-w-xs truncate text-[10px] text-red-700"
                        title={job.lastError}
                      >
                        {job.lastError}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600">
                    <div>{relTime(job.lastRunAt)}</div>
                    {job.lastDurationMs != null && (
                      <div className="text-[10px] text-gray-400">
                        {job.lastDurationMs}ms
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs tabular-nums text-gray-600">
                    <div>{job.runCount}</div>
                    {job.failureCount > 0 && (
                      <div className="text-[10px] text-red-600">
                        {job.failureCount} failed
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex gap-1">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          withBusy(job.id, () => post(`/api/admin/jobs/${job.id}/run`))
                        }
                        className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50"
                      >
                        Run now
                      </button>
                      {job.enabled ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            withBusy(job.id, () =>
                              post(`/api/admin/jobs/${job.id}/pause`),
                            )
                          }
                          className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                        >
                          Pause
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            withBusy(job.id, () =>
                              post(`/api/admin/jobs/${job.id}/resume`),
                            )
                          }
                          className="rounded-md border border-emerald-300 bg-emerald-50 px-2 py-1 text-xs text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          Resume
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
