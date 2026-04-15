"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Button, buttonVariants } from "@/components/ui/button";
import { signOut, useSession } from "@/lib/auth-client";
import { Logo } from "@/components/logo";

export function AppNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, isPending } = useSession();

  async function handleSignOut() {
    await signOut();
    router.push("/");
    router.refresh();
  }
  const isSignInPage = pathname.startsWith("/auth/sign-in");
  const isSignUpPage = pathname.startsWith("/auth/sign-up");
  const isPlayersPage = pathname.startsWith("/players");
  const isAccountPage = pathname.startsWith("/account");
  const isLeaguesPage = pathname === "/" || pathname.startsWith("/leagues/");

  return (
    <header className="sticky top-0 z-50 border-b border-border/80 bg-background/85 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-2 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <Logo />
          <nav className="flex items-center gap-2">
            <Link
              href="/players"
              className={buttonVariants({
                variant: isPlayersPage ? "default" : "ghost",
                size: "sm",
              })}
            >
              Players
            </Link>
            <Link
              href="/"
              className={buttonVariants({
                variant: isLeaguesPage ? "default" : "ghost",
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
          <div className="flex items-center gap-2">
            <Link
              href="/account"
              className={buttonVariants({
                variant: isAccountPage ? "default" : "ghost",
                size: "sm",
              })}
            >
              <span className="hidden sm:inline">{session.user.name}</span>
              <span className="sm:hidden">Account</span>
            </Link>
            <Button variant="outline" size="sm" onClick={() => void handleSignOut()}>
              Sign Out
            </Button>
          </div>
        ) : null}
      </div>
    </header>
  );
}
