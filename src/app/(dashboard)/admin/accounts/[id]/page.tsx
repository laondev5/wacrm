"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowLeft, Ban, ExternalLink, Loader2, Play, Trash2 } from "lucide-react";
import { api } from "@/lib/client/api";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { PageHeader, Panel, inputCls, timeAgo } from "@/components/sales/kit";

interface Detail {
  account: {
    id: string;
    name: string;
    business: { displayName: string; phone: string | null; email: string | null; address: string | null };
    currency: string;
    createdAt: string;
    suspendedAt: string | null;
    suspendedReason: string | null;
    salesAgent: { enabled: boolean; mode: "ai" | "rules"; name: string; agentsOn: string[] };
  };
  users: Array<{ id: string; email: string; fullName: string | null; role: string; lastLoginAt: string | null; temporaryPassword?: boolean }>;
  recentRuns: Array<{
    _id: string;
    ok: boolean;
    model: string;
    latencyMs: number;
    tokens?: { total: number } | null;
    error: string | null;
    attempts?: Array<{ ok: boolean }>;
    createdAt: string;
  }>;
}

export default function AdminAccountPage() {
  const { platformAdmin, loading } = useAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const [d, setD] = useState<Detail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [reset, setReset] = useState<{ email: string; password: string | null } | null>(null);

  const load = () =>
    api<Detail>(`/api/admin/accounts/${id}`)
      .then(setD)
      .catch((e) => toast.error(e.message));

  useEffect(() => {
    if (platformAdmin && id) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platformAdmin, id]);

  if (loading) return <div className="h-64 animate-pulse rounded-xl bg-slate-900/50" />;
  if (!platformAdmin) return <p className="text-sm text-slate-400">This area is for the platform operator.</p>;
  if (!d) return <div className="h-64 animate-pulse rounded-xl bg-slate-900/50" />;

  const suspended = !!d.account.suspendedAt;

  const setSuspended = async (next: boolean) => {
    const reason = next ? prompt("Why is this merchant being suspended? (shown to nobody but you)") : null;
    if (next && reason === null) return;
    setBusy("suspend");
    try {
      await api(`/api/admin/accounts/${id}`, { method: "PATCH", body: { suspended: next, reason } });
      toast.success(next ? "Merchant suspended" : "Merchant restored");
      void load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const resetPassword = async () => {
    if (!confirm("Issue the owner a new password? They will be signed out everywhere.")) return;
    setBusy("reset");
    try {
      const r = await api<{ email: string; temporaryPassword: string | null }>(`/api/admin/accounts/${id}/reset-password`, { body: {} });
      setReset({ email: r.email, password: r.temporaryPassword });
      toast.success("Password reset");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("delete");
    try {
      await api(`/api/admin/accounts/${id}?confirm=${encodeURIComponent(confirmName)}`, { method: "DELETE" });
      toast.success("Account deleted");
      router.push("/admin");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const open = async () => {
    setBusy("open");
    try {
      await api("/api/admin/open", { body: { accountId: id } });
      window.location.assign("/settings?tab=whatsapp");
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/admin" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white">
        <ArrowLeft className="size-4" /> All merchants
      </Link>
      <PageHeader
        title={d.account.business.displayName}
        description={`Joined ${timeAgo(d.account.createdAt)} · ${d.account.currency}`}
        actions={
          <Button variant="outline" className="border-slate-700 bg-slate-900 text-slate-200" onClick={() => void open()} disabled={busy === "open"}>
            {busy === "open" ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />} Open their workspace
          </Button>
        }
      />

      {suspended && (
        <p className="mb-4 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-2.5 text-sm text-red-200">
          Suspended {timeAgo(d.account.suspendedAt!)}
          {d.account.suspendedReason ? ` — ${d.account.suspendedReason}` : ""}. Their team cannot sign in and the sales rep
          does not answer.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="People" description="The owner signs in with the email below.">
          <ul className="space-y-2 text-sm">
            {d.users.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate text-white">{u.fullName ?? u.email}</span>
                  <span className="block truncate text-xs text-slate-400">{u.email}</span>
                </span>
                <span className="shrink-0 text-right text-xs text-slate-400">
                  <span className="block capitalize">{u.role}</span>
                  <span className="block">{u.lastLoginAt ? `seen ${timeAgo(u.lastLoginAt)}` : "never signed in"}</span>
                  {u.temporaryPassword && <span className="block text-amber-300">temporary password</span>}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3 border-t border-slate-800 pt-3">
            <Button variant="outline" className="border-slate-700 bg-slate-900 text-slate-200" onClick={() => void resetPassword()} disabled={busy === "reset"}>
              {busy === "reset" ? <Loader2 className="size-4 animate-spin" /> : null} Reset owner&apos;s password
            </Button>
            {reset && (
              <div className="mt-2 rounded-lg bg-slate-950/60 p-3 text-xs text-slate-200">
                <p>Email: {reset.email}</p>
                <p>New password: <span className="font-mono">{reset.password}</span></p>
                <p className="mt-1 text-slate-400">Shown once. It is stored only as a hash.</p>
              </div>
            )}
          </div>
        </Panel>

        <Panel title="AI agents">
          <p className="text-sm text-slate-300">
            {d.account.salesAgent.agentsOn.length
              ? `${d.account.salesAgent.agentsOn.join(", ")} (${d.account.salesAgent.mode === "ai" ? "AI" : "keyword rules"})`
              : "No agent switched on"}{" "}
            · answers as {d.account.salesAgent.name}
          </p>
          <p className="mt-2 text-xs text-slate-400">
            The AI model is the platform&apos;s own — change it under <Link href="/admin/ai" className="text-primary hover:underline">System AI</Link>.
            Customer conversations, orders and stock are not visible from here.
          </p>
        </Panel>

        <Panel title="Recent AI replies">
          {d.recentRuns.length === 0 ? (
            <p className="text-sm text-slate-400">No AI replies yet.</p>
          ) : (
            <ul className="space-y-1.5 text-xs">
              {d.recentRuns.slice(0, 10).map((r) => (
                <li key={r._id} className="flex items-start justify-between gap-2">
                  <span className={r.ok ? "text-slate-300" : "text-red-300"}>
                    {r.ok ? "ok" : "failed"} · {r.model}
                    {r.ok && (r.attempts?.length ?? 0) > 1 ? " · via fallback" : ""}
                    {r.error ? ` — ${r.error.slice(0, 70)}` : ""}
                  </span>
                  <span className="shrink-0 text-slate-500">
                    {(r.latencyMs / 1000).toFixed(1)}s{r.tokens?.total ? ` · ${r.tokens.total} tok` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

      </div>

      <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/[0.03] p-4">
        <p className="text-sm font-medium text-white">Danger zone</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            className="border-slate-700 bg-slate-900 text-slate-200"
            onClick={() => void setSuspended(!suspended)}
            disabled={busy === "suspend"}
          >
            {busy === "suspend" ? <Loader2 className="size-4 animate-spin" /> : suspended ? <Play className="size-4" /> : <Ban className="size-4" />}
            {suspended ? "Restore access" : "Suspend merchant"}
          </Button>
        </div>
        <p className="mt-4 text-xs text-slate-400">
          Deleting removes their orders, conversations, receipts and users. It cannot be undone — type{" "}
          <b className="text-slate-200">{d.account.name}</b> to confirm.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input className={`${inputCls} max-w-xs`} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={d.account.name} />
          <Button
            variant="outline"
            className="border-red-500/40 bg-red-500/10 text-red-200 hover:bg-red-500/20"
            disabled={busy === "delete" || confirmName.trim().toLowerCase() !== d.account.name.trim().toLowerCase()}
            onClick={() => void remove()}
          >
            {busy === "delete" ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />} Delete for good
          </Button>
        </div>
      </div>
    </div>
  );
}
