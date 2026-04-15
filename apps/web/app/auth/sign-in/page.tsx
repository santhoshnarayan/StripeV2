"use client";

import { useEffect, useState } from "react";
import { signIn, useSession } from "@/lib/auth-client";
import { signInSchema } from "@repo/validators";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function SignInPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (session) {
      router.replace("/");
    }
  }, [router, session]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    const result = signInSchema.safeParse({ email, password });
    if (!result.success) {
      setError(result.error.errors[0].message);
      return;
    }

    setLoading(true);
    const { error: authError } = await signIn.email({ email, password });

    if (authError) {
      setError(authError.message || "Sign in failed");
      setLoading(false);
      return;
    }

    router.replace("/");
  }

  if (session) {
    return (
      <main className="mx-auto flex w-full max-w-md px-4 py-12 sm:px-6 lg:px-0">
        <p className="text-sm text-muted-foreground">Redirecting to players...</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md px-4 py-12 sm:px-6 lg:px-0">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl">Sign In</CardTitle>
          <CardDescription>Access your leagues, bids, and scoring dashboard.</CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Link href="/auth/forgot-password" className="text-sm text-primary underline">
              Forgot password?
            </Link>
          </CardContent>
          <CardFooter className="flex flex-col gap-4">
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Signing in..." : "Sign In"}
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              Need an account?{" "}
              <Link href="/auth/sign-up" className="text-primary underline">
                Sign Up
              </Link>
            </p>
          </CardFooter>
        </form>
      </Card>
    </main>
  );
}
