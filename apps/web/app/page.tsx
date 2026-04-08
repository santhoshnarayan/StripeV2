"use client";

import { useSession, signOut } from "@/lib/auth-client";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function Home() {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="text-muted-foreground">Loading...</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl">StripeV2</CardTitle>
        </CardHeader>
        <CardContent>
          {session ? (
            <div className="space-y-4">
              <p>Welcome, <span className="font-medium">{session.user.name}</span>!</p>
              <p className="text-sm text-muted-foreground">{session.user.email}</p>
              <Button variant="outline" onClick={() => signOut()}>
                Sign Out
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-muted-foreground">You are not signed in.</p>
              <div className="flex gap-3">
                <Link href="/auth/sign-in" className={buttonVariants()}>
                  Sign In
                </Link>
                <Link href="/auth/sign-up" className={buttonVariants({ variant: "outline" })}>
                  Sign Up
                </Link>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
