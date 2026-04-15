"use client";

import { Toaster as SonnerToaster } from "sonner";

import { useTheme } from "@/lib/theme";

export function Toaster() {
  const { resolvedTheme } = useTheme();

  return (
    <SonnerToaster
      theme={resolvedTheme}
      position="top-center"
      visibleToasts={4}
      toastOptions={{
        classNames: {
          toast:
            "group toast pointer-events-auto flex items-center gap-3 rounded-xl border border-border/80 bg-card px-4 py-3 text-sm font-medium text-foreground shadow-md",
          title: "text-foreground",
          description: "text-muted-foreground",
          actionButton:
            "rounded-md border border-border/80 bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted",
          cancelButton:
            "rounded-md border border-transparent px-2 py-1 text-xs font-medium text-muted-foreground hover:text-foreground",
          success: "text-foreground",
          error: "text-destructive",
          info: "text-foreground",
          warning: "text-foreground",
          icon: "text-muted-foreground",
        },
      }}
    />
  );
}
