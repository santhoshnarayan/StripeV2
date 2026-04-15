"use client";

import { useEffect, useState } from "react";
import { signUp, useSession } from "@/lib/auth-client";
import { signUpSchema } from "@repo/validators";
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

export default function SignUpPage() {
  const router = useRouter();
  const { data: session } = useSession();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (session) {
      router.replace("/");
    }
  }, [router, session]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    const result = signUpSchema.safeParse({ name, email, password });

    if (!result.success) {
      setError(result.error.errors[0].message);
      return;
    }

    setLoading(true);
    const { error: authError } = await signUp.email({ name, email, password });

    if (authError) {
      setError(authError.message || "Sign up failed");
      setLoading(false);
      return;
    }

    router.replace("/");
  }

  if (session) {
    return (
      <main className="mx-auto flex w-full max-w-md px-4 py-12 sm:px-6 lg:px-0">
        <p className="text-sm text-muted-foreground">Redirecting to leagues...</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md px-4 py-12 sm:px-6 lg:px-0">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl">Sign Up</CardTitle>
          <CardDescription>
            Create your account first. League invitations will match by email later.
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                type="text"
                placeholder="Your name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                placeholder="At least 5 characters"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </CardContent>
          <CardFooter className="flex flex-col gap-4">
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? "Signing up..." : "Sign Up"}
            </Button>
            <p className="text-center text-sm text-muted-foreground">
              Already have an account?{" "}
              <Link href="/auth/sign-in" className="text-primary underline">
                Sign In
              </Link>
            </p>
          </CardFooter>
        </form>
      </Card>
    </main>
  );
}
