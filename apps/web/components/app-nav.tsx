"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ComponentProps } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Logo } from "@/components/logo";
import { signOut, useSession } from "@/lib/auth-client";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

type IconProps = ComponentProps<"svg">;

function TrophyIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M6 4h12v3a6 6 0 0 1-12 0V4Z" />
      <path d="M6 6H4a2 2 0 0 0 2 4" />
      <path d="M18 6h2a2 2 0 0 1-2 4" />
      <path d="M10 14h4" />
      <path d="M12 14v4" />
      <path d="M8 20h8" />
    </svg>
  );
}

function PlayersIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <circle cx="9" cy="8" r="3.25" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <circle cx="16.5" cy="9" r="2.5" />
      <path d="M15 13.2a4.5 4.5 0 0 1 6 4.3" />
    </svg>
  );
}

function UserIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </svg>
  );
}

function LogInIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5" />
      <path d="M10 8l4 4-4 4" />
      <path d="M14 12H4" />
    </svg>
  );
}

function SunIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m4.93 19.07 1.41-1.41" />
      <path d="m17.66 6.34 1.41-1.41" />
    </svg>
  );
}

function MoonIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  );
}

type NavItem = {
  href: string;
  label: string;
  icon: (props: IconProps) => React.ReactElement;
  isActive: (pathname: string) => boolean;
};

const leaguesItem: NavItem = {
  href: "/",
  label: "Leagues",
  icon: TrophyIcon,
  isActive: (pathname) => pathname === "/" || pathname.startsWith("/leagues"),
};

const playersItem: NavItem = {
  href: "/players",
  label: "Players",
  icon: PlayersIcon,
  isActive: (pathname) => pathname.startsWith("/players"),
};

function BracketIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M3 5v4h4" />
      <path d="M3 19v-4h4" />
      <path d="M7 9h3v6H7" />
      <path d="M14 9h3v6h-3" />
      <path d="M17 5v4h4" />
      <path d="M17 19v-4h4" />
      <path d="M10 12h4" />
    </svg>
  );
}

const bracketItem: NavItem = {
  href: "/bracket",
  label: "Bracket",
  icon: BracketIcon,
  isActive: (pathname) => pathname.startsWith("/bracket"),
};

const accountItem: NavItem = {
  href: "/account",
  label: "Account",
  icon: UserIcon,
  isActive: (pathname) => pathname.startsWith("/account"),
};

const signInItem: NavItem = {
  href: "/auth/sign-in",
  label: "Sign In",
  icon: LogInIcon,
  isActive: (pathname) => pathname.startsWith("/auth/"),
};

export function AppNav() {
  const pathname = usePathname();
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const { resolvedTheme, toggleTheme } = useTheme();

  async function handleSignOut() {
    await signOut();
    router.push("/");
    router.refresh();
  }

  const isSignedIn = !isPending && !!session;
  const showAuthNav = !isPending;

  const mobileItems: NavItem[] = [
    leaguesItem,
    playersItem,
    bracketItem,
    isSignedIn ? accountItem : signInItem,
  ];

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-border/80 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70 pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex max-w-[96rem] items-center justify-between gap-4 px-4 py-2 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <Logo />
            {/* Desktop primary nav */}
            <nav className="hidden items-center gap-2 md:flex">
              <Link
                href="/"
                className={buttonVariants({
                  variant: leaguesItem.isActive(pathname) ? "default" : "ghost",
                  size: "sm",
                })}
              >
                Leagues
              </Link>
              <Link
                href="/players"
                className={buttonVariants({
                  variant: playersItem.isActive(pathname) ? "default" : "ghost",
                  size: "sm",
                })}
              >
                Players
              </Link>
              <Link
                href="/bracket"
                className={buttonVariants({
                  variant: bracketItem.isActive(pathname) ? "default" : "ghost",
                  size: "sm",
                })}
              >
                Bracket
              </Link>
              {showAuthNav && !isSignedIn ? (
                <>
                  <Link
                    href="/auth/sign-in"
                    className={buttonVariants({
                      variant: pathname.startsWith("/auth/sign-in") ? "default" : "ghost",
                      size: "sm",
                    })}
                  >
                    Sign In
                  </Link>
                  <Link
                    href="/auth/sign-up"
                    className={buttonVariants({
                      variant: pathname.startsWith("/auth/sign-up") ? "default" : "ghost",
                      size: "sm",
                    })}
                  >
                    Sign Up
                  </Link>
                </>
              ) : null}
            </nav>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} mode`}
              onClick={toggleTheme}
            >
              {resolvedTheme === "dark" ? (
                <SunIcon className="size-4" />
              ) : (
                <MoonIcon className="size-4" />
              )}
            </Button>
            {isSignedIn ? (
              <>
                <Link
                  href="/account"
                  className={cn(
                    buttonVariants({
                      variant: accountItem.isActive(pathname) ? "default" : "ghost",
                      size: "sm",
                    }),
                    "hidden md:inline-flex",
                  )}
                >
                  {session!.user.name}
                </Link>
                <Button variant="outline" size="sm" onClick={() => void handleSignOut()}>
                  Sign Out
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </header>

      {/* Mobile bottom tab bar (PWA-style) */}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-50 border-t border-border/80 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <ul className="mx-auto flex max-w-md items-stretch justify-around px-2">
          {mobileItems.map((item) => {
            const active = item.isActive(pathname);
            const Icon = item.icon;
            return (
              <li key={item.href} className="flex-1">
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "relative flex h-full min-h-14 flex-col items-center justify-center gap-1 px-2 pt-2 pb-1.5 text-[11px] font-medium transition-colors",
                    "text-muted-foreground hover:text-foreground active:bg-muted/60",
                    active && "text-foreground",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute top-0 left-1/2 h-[2px] w-8 -translate-x-1/2 rounded-full bg-foreground transition-opacity",
                      active ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <Icon className="size-5" />
                  <span className="leading-none">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
