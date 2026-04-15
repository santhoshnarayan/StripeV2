"use client";

import { useState } from "react";
import Link from "next/link";
import { changePassword, useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function AccountPage() {
  const { data: session, isPending } = useSession();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setSuccess(false);

    if (newPassword.length < 8) {
      setError("New password must be at least 8 characters");
      return;
    }

    setLoading(true);
    const { error: changeError } = await changePassword({
      currentPassword,
      newPassword,
    });

    setLoading(false);

    if (changeError) {
      setError(changeError.message || "Failed to change password");
      return;
    }

    setSuccess(true);
    setCurrentPassword("");
    setNewPassword("");
  }

  if (isPending) {
    return (
      <main className="mx-auto flex w-full max-w-xl px-4 py-12 sm:px-6 lg:px-8">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="mx-auto flex w-full max-w-xl px-4 py-12 sm:px-6 lg:px-8">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Account</CardTitle>
            <CardDescription>
              You need to be signed in to manage your account.
            </CardDescription>
          </CardHeader>
          <CardFooter>
            <Link href="/auth/sign-in" className="text-sm text-primary underline">
              Sign In
            </Link>
          </CardFooter>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-4 py-12 sm:px-6 lg:px-8">
      <section className="space-y-2">
        <p className="text-xs font-semibold tracking-[0.25em] text-muted-foreground uppercase">
          Account
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          {session.user.name}
        </h1>
        <p className="text-sm text-muted-foreground">{session.user.email}</p>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Change Password</CardTitle>
          <CardDescription>
            Enter your current password and pick a new one. You&apos;ll stay signed
            in on this device.
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="current-password">Current Password</Label>
              <Input
                id="current-password"
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-password">New Password</Label>
              <Input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                required
                minLength={8}
              />
            </div>
            {error ? (
              <p className="text-sm text-destructive">{error}</p>
            ) : null}
            {success ? (
              <p className="text-sm text-emerald-600">Password updated.</p>
            ) : null}
          </CardContent>
          <CardFooter>
            <Button type="submit" disabled={loading}>
              {loading ? "Saving..." : "Update Password"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </main>
  );
}
