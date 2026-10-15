"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Shown instead of the whole app while a login still has the password
 * someone else chose for it (an administrator created or reset the
 * account). The server refuses every other request until this is done,
 * so this screen is a courtesy, not the enforcement.
 */
export function ForcePasswordChange({ email, onDone }: { email: string; onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next.length < 8) return setError("Use at least 8 characters.");
    if (next !== confirm) return setError("The two new passwords do not match.");
    if (next === current) return setError("Choose a different password from the temporary one.");
    setBusy(true);
    const res = await fetch("/api/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    }).catch(() => null);
    if (!res || !res.ok) {
      const body = res ? await res.json().catch(() => null) : null;
      setError(body?.error ?? "Could not change your password. Please try again.");
      setBusy(false);
      return;
    }
    onDone();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4 py-10">
      <Card className="w-full max-w-md border-slate-800 bg-slate-900">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <KeyRound className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl text-white">Choose your own password</CardTitle>
          <CardDescription className="text-slate-400">
            {email}{" "}
            was set up with a temporary password. Pick one only you know — it protects your customers&apos; conversations.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="flex flex-col gap-4">
            {error && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">{error}</div>
            )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="current" className="text-slate-300">Temporary password</Label>
              <PasswordInput id="current" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="next" className="text-slate-300">New password</Label>
              <PasswordInput id="next" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="confirm" className="text-slate-300">Confirm new password</Label>
              <PasswordInput id="confirm" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </div>
            <Button type="submit" disabled={busy || !current || !next || !confirm}>
              {busy ? "Saving…" : "Save and continue"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
