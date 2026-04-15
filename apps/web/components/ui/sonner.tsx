"use client";

import { Toaster as SonnerToaster } from "sonner";

export function Toaster() {
  return (
    <SonnerToaster
      position="top-center"
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
