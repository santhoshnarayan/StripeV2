"use client";

import { useEffect, useRef } from "react";
import { getLastActivity } from "@/lib/use-activity";

// Poll a fetch function while the user is active. Skips ticks when the page is
// hidden or the user has been idle past `idleMs`. Pauses entirely when
// `enabled=false`. When the tab becomes visible again, the caller can bump the
// activity clock via `markUserActive()` and we'll resume on the next tick.
export function usePolling(
  fn: () => void | Promise<void>,
  {
    activeMs,
    idleMs = 3 * 60_000,
    enabled = true,
  }: { activeMs: number; idleMs?: number; enabled?: boolean },
): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;

    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      if (document.hidden) return;
      if (Date.now() - getLastActivity() > idleMs) return;
      try {
        await fnRef.current();
      } catch {
        // swallow — caller is responsible for surfacing errors
      }
    };

    const t = window.setInterval(() => void tick(), activeMs);

    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [activeMs, idleMs, enabled]);
}
