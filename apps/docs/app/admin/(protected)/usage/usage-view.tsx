"use client";

import { useEffect, useState } from "react";

type UsageUnit = {
  label: string;
  value: string | number;
  unit?: string;
  limit?: number | string;
  rate?: string;
};

type UsageResponse =
  | { configured: false; needsEnv: string[] }
  | {
      configured: true;
      project?: string;
      units: UsageUnit[];
      projectedCost?: { amount: number; currency: string; period?: string };
      notes?: string[];
      error?: string;
    };

const SERVICES = [
  { id: "vercel", label: "Vercel" },
  { id: "railway", label: "Railway" },
  { id: "planetscale", label: "PlanetScale" },
] as const;

type ServiceId = (typeof SERVICES)[number]["id"];

export function UsageView() {
  const [service, setService] = useState<ServiceId>("vercel");
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      setData(null);
      try {
        const res = await fetch(`/api/admin/usage/${service}`, {
          credentials: "include",
        });
        const payload = (await res.json().catch(() => ({}))) as UsageResponse;
        if (!cancelled) setData(payload);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [service]);

  const active = SERVICES.find((s) => s.id === service);

  return (
    <div className="flex flex-col gap-4 md:flex-row">
      <aside className="md:w-48 md:shrink-0">
        <nav className="flex gap-1 md:flex-col">
          {SERVICES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setService(s.id)}
              className={`rounded-md px-3 py-2 text-left text-sm transition-colors ${
                service === s.id
                  ? "bg-gray-900 text-white"
                  : "text-gray-700 hover:bg-gray-100"
              }`}
            >
              {s.label}
            </button>
          ))}
        </nav>
      </aside>

      <section className="min-w-0 flex-1">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">
          {active?.label} usage
        </h2>

        {loading && <p className="text-sm text-gray-500">Loading…</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}

        {data && data.configured === false && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
            <p className="font-medium">Not configured</p>
            <p className="mt-1">Set these env vars on the server:</p>
            <ul className="mt-2 list-disc pl-5 text-xs">
              {data.needsEnv.map((e) => (
                <li key={e}>
                  <code>{e}</code>
                </li>
              ))}
            </ul>
          </div>
        )}

        {data && data.configured === true && (
          <div className="space-y-4">
            {data.project && (
              <p className="text-sm text-gray-500">
                Project:{" "}
                <span className="font-mono text-gray-900">{data.project}</span>
              </p>
            )}
            {data.error && (
              <p className="rounded-md bg-red-50 p-2 text-xs text-red-700">
                {data.error}
              </p>
            )}
            {data.units.length > 0 && (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
                {data.units.map((u) => (
                  <div
                    key={u.label}
                    className="rounded-lg border border-gray-200 bg-white p-3"
                  >
                    <div className="text-xs text-gray-500">{u.label}</div>
                    <div className="mt-1 text-xl font-semibold text-gray-900 tabular-nums">
                      {u.value}
                      {u.unit ? (
                        <span className="ml-1 text-xs font-normal text-gray-500">
                          {u.unit}
                        </span>
                      ) : null}
                    </div>
                    {u.limit != null && (
                      <div className="mt-1 text-xs text-gray-500">
                        of {u.limit}
                        {u.unit ? ` ${u.unit}` : ""}
                      </div>
                    )}
                    {u.rate && (
                      <div className="mt-1 text-xs text-gray-400">{u.rate}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {data.projectedCost && (
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm">
                <span className="text-gray-500">Projected this cycle:</span>{" "}
                <span className="font-semibold">
                  ${data.projectedCost.amount.toFixed(2)}{" "}
                  {data.projectedCost.currency}
                </span>
              </div>
            )}
            {data.notes && data.notes.length > 0 && (
              <div className="space-y-1 rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
                {data.notes.map((n, i) => (
                  <p key={i}>{n}</p>
                ))}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
