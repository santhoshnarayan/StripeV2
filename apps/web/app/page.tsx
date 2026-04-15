"use client";

import Link from "next/link";
import { HomeDashboard } from "@/components/home-dashboard";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useSession } from "@/lib/auth-client";

export default function Home() {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return (
      <main className="mx-auto flex w-full max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-12 sm:px-6 lg:px-8">
        <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <Card className="py-8">
            <CardHeader>
              <CardTitle className="text-4xl leading-tight">
                Blind playoff auctions for NBA player pools.
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <p className="max-w-2xl text-base text-muted-foreground">
                Sign in or create an account to join a league, accept invitations, bid on
                playoff players, and track automatic scoring through invite, draft, and
                scoring phases.
              </p>
              <div className="flex flex-wrap gap-3">
                <Link href="/auth/sign-in" className={buttonVariants()}>
                  Sign In
                </Link>
                <Link href="/auth/sign-up" className={buttonVariants({ variant: "outline" })}>
                  Sign Up
                </Link>
              </div>
            </CardContent>
          </Card>

          <Card className="py-8">
            <CardHeader>
              <CardTitle>How It Works</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-muted-foreground">
              <p>1. Commissioners create leagues and invite managers by email.</p>
              <p>2. Draft rounds open with selected players or the full remaining pool.</p>
              <p>3. Blind bids stay sealed until the commissioner closes the round.</p>
              <p>4. Ties resolve by the public priority order, which rotates after each tiebreak win.</p>
              <p>5. Scoring locks automatically once every roster is full.</p>
            </CardContent>
          </Card>
        </section>
      </main>
    );
  }

  return <HomeDashboard />;
}
