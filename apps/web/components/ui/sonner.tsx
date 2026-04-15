"use client";

import { Toaster as SonnerToaster } from "sonner";

export function Toaster() {
  return (
    <SonnerToaster
      position="top-right"
      toastOptions={{
        classNames: {
          toast:
            "rounded-lg border border-border bg-background text-foreground shadow-sm",
          description: "text-muted-foreground",
        },
      }}
    />
  );
}
