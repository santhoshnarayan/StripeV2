"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";

const BUILD_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "dev";
const CHECK_INTERVAL_MS = 3 * 60_000;
const TOAST_ID = "app-version-update";

async function fetchRemoteVersion(): Promise<string | null> {
  try {
    const res = await fetch("/api/version", { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return body.version ?? null;
  } catch {
    return null;
  }
}

function showRefreshToast() {
  toast("A new version is available", {
    id: TOAST_ID,
    description: "Refresh to load the latest updates. You'll stay logged in.",
    duration: Number.POSITIVE_INFINITY,
    action: {
      label: "Refresh",
      onClick: () => window.location.reload(),
    },
  });
}

export function VersionWatcher() {
  const shownRef = useRef(false);

  useEffect(() => {
    // Never check during local dev — the build hash is "dev" and the runtime
    // endpoint will return "dev" too. Also skip if somehow empty.
    if (!BUILD_VERSION || BUILD_VERSION === "dev") return;

    let cancelled = false;

    const check = async () => {
      if (cancelled || shownRef.current) return;
      if (document.hidden) return;
      const remote = await fetchRemoteVersion();
      if (cancelled || shownRef.current) return;
      if (remote && remote !== "dev" && remote !== BUILD_VERSION) {
        shownRef.current = true;
        showRefreshToast();
      }
    };

    check();
    const id = window.setInterval(check, CHECK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
