"use client";

import { useState } from "react";
import { requestPasswordReset } from "@/lib/auth-client";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const { error: authError } = await requestPasswordReset({
      email,
      redirectTo: "/auth/reset-password",
    });

    if (authError) {
      setError(authError.message || "Failed to send reset email");
      setLoading(false);
      return;
    }

    setSent(true);
    setLoading(false);
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl">Reset Password</CardTitle>
        </CardHeader>
        {sent ? (
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              If an account with that email exists, we sent a password reset link. Check your inbox.
            </p>
            <Link href="/auth/sign-in" className="text-sm text-primary underline">
              Back to Sign In
            </Link>
          </CardContent>
        ) : (
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
              {error && <p className="text-sm text-destructive">{error}</p>}
            </CardContent>
            <CardFooter className="flex flex-col gap-4">
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Sending..." : "Send Reset Link"}
              </Button>
              <p className="text-sm text-muted-foreground">
                Remember your password?{" "}
                <Link href="/auth/sign-in" className="text-primary underline">
                  Sign In
                </Link>
              </p>
            </CardFooter>
          </form>
        )}
      </Card>
    </main>
  );
}
