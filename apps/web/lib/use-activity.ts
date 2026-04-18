"use client";

import { useEffect, useState } from "react";

// Singleton user-activity tracker. Any component that wants "poll while active,
// slow down when idle" should use this instead of re-implementing the
// pointerdown/keydown/visibilitychange listeners.
//
// Two ways to consume:
//   - `getLastActivity()` / `isUserActive(idleMs)` — imperative, read inside
//     an interval callback to decide whether to fetch.
//   - `useActivity()` — subscribes and re-renders when active/idle flips.

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart"] as const;

let lastActivity = Date.now();
let installed = false;
const listeners = new Set<() => void>();

function bump(): void {
  lastActivity = Date.now();
  for (const fn of listeners) fn();
}

function install(): void {
  if (installed) return;
  if (typeof window === "undefined") return;
  installed = true;
  for (const ev of ACTIVITY_EVENTS) {
    window.addEventListener(ev, bump, { passive: true });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") bump();
  });
}

export function getLastActivity(): number {
  install();
  return lastActivity;
}

export function isUserActive(idleMs = 3 * 60_000): boolean {
  install();
  if (typeof document !== "undefined" && document.hidden) return false;
  return Date.now() - lastActivity <= idleMs;
}

export function markUserActive(): void {
  install();
  bump();
}

export function useActivity(idleMs = 3 * 60_000): {
  active: boolean;
  lastActivityAt: number;
} {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    install();
    const fn = () => setTick((t) => t + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  void tick;
  return { active: isUserActive(idleMs), lastActivityAt: lastActivity };
}
