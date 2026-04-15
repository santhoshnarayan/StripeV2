"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button, buttonVariants } from "@/components/ui/button";
import { signOut, useSession } from "@/lib/auth-client";

export function AppNav() {
  const pathname = usePathname();
  const { data: session, isPending } = useSession();
  const isSignInPage = pathname.startsWith("/auth/sign-in");
  const isSignUpPage = pathname.startsWith("/auth/sign-up");

  return (
    <header className="sticky top-0 z-50 border-b border-border/80 bg-background/85 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-2 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/"
            className="shrink-0 leading-none"
          >
            <span className="block text-xl font-bold tracking-tight text-foreground">
              Player Pool
            </span>
            <span className="block pt-0.5 text-[0.55rem] font-semibold tracking-[0.3em] text-[#ff5a00] uppercase">
              NBA PLAYOFFS
            </span>
          </Link>
          <nav className="flex items-center gap-2">
            <Link
              href="/"
              className={buttonVariants({
                variant: pathname === "/" ? "default" : "ghost",
                size: "sm",
              })}
            >
              Leagues
            </Link>
            {!isPending && !session ? (
              <>
                <Link
                  href="/auth/sign-in"
                  className={buttonVariants({
                    variant: isSignInPage ? "default" : "ghost",
                    size: "sm",
                  })}
                >
                  Sign In
                </Link>
                <Link
                  href="/auth/sign-up"
                  className={buttonVariants({
                    variant: isSignUpPage ? "default" : "ghost",
                    size: "sm",
                  })}
                >
                  Sign Up
                </Link>
              </>
            ) : null}
          </nav>
        </div>

        {!isPending && session ? (
          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-medium text-foreground">{session.user.name}</p>
              <p className="text-xs text-muted-foreground">{session.user.email}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => signOut()}>
              Sign Out
            </Button>
          </div>
        ) : null}
      </div>
    </header>
  );
}
