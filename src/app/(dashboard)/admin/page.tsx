"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Ban, Bot, Check, Copy, ExternalLink, Loader2, Plus, Search, Settings2 } from "lucide-react";
import { api } from "@/lib/client/api";
import { useAuth } from "@/hooks/use-auth";
import { formatMoney } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { Field, PageHeader, Panel, inputCls, timeAgo } from "@/components/sales/kit";

interface Account {
  id: string;
  name: string;
  business: string;
  currency: string;
  createdAt: string;
  suspendedAt: string | null;
  owner: { email: string; fullName: string | null } | null;
  users: number;
  whatsapp: { connected: boolean; number: string | null };
  ai: { mode: "ai" | "rules"; enabled: boolean; agents: string[] };
  telegram: { connected: boolean; chats: number };
  storage: { provider: string | null };
  activity: { orders: number; conversations: number; lastCustomerMessageAt: string | null; paidRevenue: number };
  usage: { runs7d: number; tokens7d: number; failures7d: number };
}

interface SystemAI {
  chat: Array<{ health: { ok: boolean } | null } | null>;
}

interface Created {
  account: { id: string; name: string };
  owner: { email: string };
  temporaryPassword: string | null;
  typedPassword: boolean;
}

const th = "px-3 py-2 text-left text-[11px] font-semibold tracking-wider text-slate-500 uppercase whitespace-nowrap";
const td = "px-3 py-2.5 align-top text-sm";

function Pill({ tone, children }: { tone: "ok" | "off" | "warn" | "bad"; children: React.ReactNode }) {
  const cls = {
    ok: "bg-emerald-500/10 text-emerald-300",
    off: "bg-slate-800 text-slate-400",
    warn: "bg-amber-500/10 text-amber-300",
    bad: "bg-red-500/10 text-red-300",
  }[tone];
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] whitespace-nowrap ${cls}`}>{children}</span>;
}

function loginText(created: Created): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return [
    `Your ${created.account.name} workspace is ready.`,
    `Sign in: ${origin}/login`,
    `Email: ${created.owner.email}`,
    created.temporaryPassword ? `Password: ${created.temporaryPassword}` : "Password: the one we agreed",
    "Please change your password after your first sign-in (Settings → Profile).",
  ].join("\n");
}

export default function AdminPage() {
  const { platformAdmin, loading } = useAuth();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [systemAI, setSystemAI] = useState<SystemAI | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ businessName: "", ownerName: "", email: "", password: "" });
  const [created, setCreated] = useState<Created | null>(null);

  const load = useCallback(() => {
    api<{ accounts: Account[] }>("/api/admin/accounts")
      .then((d) => setAccounts(d.accounts))
      .catch((e) => toast.error(e.message));
    api<SystemAI>("/api/admin/ai").then(setSystemAI).catch(() => {});
  }, []);

  useEffect(() => {
    if (platformAdmin) queueMicrotask(load);
  }, [platformAdmin, load]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle || !accounts) return accounts ?? [];
    return accounts.filter((a) =>
      [a.name, a.business, a.owner?.email, a.owner?.fullName, a.whatsapp.number].some((v) => v?.toLowerCase().includes(needle)),
    );
  }, [accounts, q]);

  const totals = useMemo(() => {
    const list = accounts ?? [];
    return {
      merchants: list.length,
      live: list.filter((a) => a.whatsapp.connected && !a.suspendedAt).length,
      runs: list.reduce((s, a) => s + a.usage.runs7d, 0),
      tokens: list.reduce((s, a) => s + a.usage.tokens7d, 0),
      failing: list.filter((a) => a.usage.failures7d > 0).length,
    };
  }, [accounts]);

  const primary = systemAI?.chat?.[0] ?? null;
  const aiConfigured = !!systemAI && systemAI.chat.some(Boolean);

  const open = async (id: string) => {
    setBusy(id);
    try {
      await api("/api/admin/open", { body: { accountId: id } });
      // A full load, so every server component re-reads the account.
      window.location.assign("/settings?tab=whatsapp");
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(null);
    }
  };

  const create = async () => {
    setBusy("create");
    try {
      const r = await api<Omit<Created, "typedPassword">>("/api/admin/accounts", { body: form });
      setCreated({ ...r, typedPassword: !!form.password });
      setForm({ businessName: "", ownerName: "", email: "", password: "" });
      setAdding(false);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <div className="h-64 animate-pulse rounded-xl bg-slate-900/50" />;
  if (!platformAdmin) return <p className="text-sm text-slate-400">This area is for the platform operator.</p>;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="Merchants"
        description="Every business on the platform: what's connected for them and what their AI is costing."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/admin/ai">
              <Button variant="outline" className="border-slate-700 bg-slate-900 text-slate-200">
                <Bot className="size-4" /> System AI
              </Button>
            </Link>
            <Link href="/admin/usage">
              <Button variant="outline" className="border-slate-700 bg-slate-900 text-slate-200">
                AI usage
              </Button>
            </Link>
            <Button
              onClick={() => {
                setAdding((v) => !v);
                setCreated(null);
              }}
            >
              <Plus className="size-4" /> Add merchant
            </Button>
          </div>
        }
      />

      {systemAI && !aiConfigured && (
        <Link
          href="/admin/ai"
          className="mb-4 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-2.5 text-sm text-red-200 hover:bg-red-500/10"
        >
          <AlertTriangle className="size-4 shrink-0" />
          No AI model is set up. Every merchant&apos;s rep is on keyword rules until you add one under System AI.
        </Link>
      )}
      {systemAI && aiConfigured && primary?.health && !primary.health.ok && (
        <Link
          href="/admin/ai"
          className="mb-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-sm text-amber-200 hover:bg-amber-500/10"
        >
          <AlertTriangle className="size-4 shrink-0" />
          The primary AI model is failing — replies are being served by a fallback. Open System AI to see why.
        </Link>
      )}

      {created && (
        <div className="mb-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
          <p className="flex items-center gap-2 text-sm font-medium text-emerald-200">
            <Check className="size-4" /> {created.account.name} created
          </p>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-950/60 p-3 text-xs whitespace-pre-wrap text-slate-200">
            {loginText(created)}
          </pre>
          <p className="mt-2 text-[11px] text-slate-400">
            {created.temporaryPassword
              ? "This password is shown once — it is stored only as a hash. Copy it now, or use Reset password later."
              : "You chose this password, so it is not shown again."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="border-slate-700 bg-slate-900 text-slate-200"
              onClick={() => navigator.clipboard.writeText(loginText(created)).then(() => toast.success("Copied"))}
            >
              <Copy className="size-4" /> Copy login details
            </Button>
            <Button onClick={() => void open(created.account.id)} disabled={busy === created.account.id}>
              {busy === created.account.id ? <Loader2 className="size-4 animate-spin" /> : <Settings2 className="size-4" />} Set up their
              connections
            </Button>
            <Button variant="ghost" className="text-slate-400" onClick={() => setCreated(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {adding && (
        <Panel
          title="Add a merchant"
          description="Creates their workspace and an owner login. You'll set up WhatsApp, Telegram and storage for them next."
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Business name">
              <input
                className={inputCls}
                value={form.businessName}
                onChange={(e) => setForm((f) => ({ ...f, businessName: e.target.value }))}
                placeholder="Ada's Fabrics"
              />
            </Field>
            <Field label="Owner's name">
              <input
                className={inputCls}
                value={form.ownerName}
                onChange={(e) => setForm((f) => ({ ...f, ownerName: e.target.value }))}
                placeholder="Ada Okafor"
              />
            </Field>
            <Field label="Owner's email" hint="They sign in with this.">
              <input
                className={inputCls}
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value.trim() }))}
                placeholder="ada@example.com"
              />
            </Field>
            <Field label="Password" hint="Leave blank and we'll generate one for you to pass on.">
              <PasswordInput
                autoComplete="new-password"
                className={inputCls}
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              />
            </Field>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" className="text-slate-400" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button onClick={() => void create()} disabled={busy === "create" || !form.businessName.trim() || !form.email}>
              {busy === "create" ? <Loader2 className="size-4 animate-spin" /> : null} Create merchant
            </Button>
          </div>
        </Panel>
      )}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Merchants", value: String(totals.merchants) },
          { label: "Live on WhatsApp", value: String(totals.live) },
          { label: "AI replies, 7 days", value: totals.runs.toLocaleString() },
          { label: "Tokens, 7 days", value: totals.tokens.toLocaleString() },
        ].map((k) => (
          <div key={k.label} className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
            <p className="text-xs text-slate-400">{k.label}</p>
            <p className="mt-1 text-2xl font-semibold text-white">{k.value}</p>
          </div>
        ))}
      </div>

      {totals.failing > 0 && (
        <p className="mb-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 text-sm text-amber-200">
          <AlertTriangle className="size-4 shrink-0" />
          {totals.failing} merchant{totals.failing === 1 ? " has" : "s have"} had AI failures in the last 7 days.
        </p>
      )}

      <Panel title="All merchants">
        <div className="relative mb-3">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-500" />
          <input
            className={`${inputCls} pl-9`}
            placeholder="Search by business, owner or number"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        {accounts === null ? (
          <div className="h-40 animate-pulse rounded-lg bg-slate-800/40" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-400">
            {accounts.length === 0 ? "No merchants yet — add your first one." : "No merchants match that."}
          </p>
        ) : (
          <div className="-mx-4 overflow-x-auto sm:mx-0">
            <table className="w-full min-w-[980px] border-collapse">
              <thead className="border-b border-slate-800">
                <tr>
                  <th className={th}>Merchant</th>
                  <th className={th}>Status</th>
                  <th className={th}>WhatsApp</th>
                  <th className={th}>AI agents</th>
                  <th className={th}>Telegram</th>
                  <th className={`${th} text-right`}>Orders</th>
                  <th className={`${th} text-right`}>Revenue</th>
                  <th className={`${th} text-right`}>AI, 7 days</th>
                  <th className={th}>Last message</th>
                  <th className={th}>Joined</th>
                  <th className={th} />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {rows.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-800/30">
                    <td className={td}>
                      <Link href={`/admin/accounts/${a.id}`} className="font-medium text-white hover:underline">
                        {a.business}
                      </Link>
                      <p className="text-xs text-slate-400">{a.owner?.email ?? "no owner"}</p>
                    </td>
                    <td className={td}>
                      {a.suspendedAt ? (
                        <Pill tone="bad">
                          <Ban className="size-3" /> Suspended
                        </Pill>
                      ) : (
                        <Pill tone="ok">Active</Pill>
                      )}
                    </td>
                    <td className={td}>
                      {a.whatsapp.connected ? <Pill tone="ok">{a.whatsapp.number ?? "Connected"}</Pill> : <Pill tone="warn">Not connected</Pill>}
                    </td>
                    <td className={td}>
                      {!a.ai.enabled ? <Pill tone="off">Off</Pill> : <Pill tone="ok">{a.ai.mode === "ai" ? "AI" : "Rules"}</Pill>}
                      {a.ai.agents.length > 0 && <p className="mt-0.5 text-[11px] text-slate-500">{a.ai.agents.join(" · ")}</p>}
                    </td>
                    <td className={td}>
                      {a.telegram.connected ? (
                        <Pill tone="ok">
                          {a.telegram.chats} chat{a.telegram.chats === 1 ? "" : "s"}
                        </Pill>
                      ) : (
                        <Pill tone="off">No</Pill>
                      )}
                    </td>
                    <td className={`${td} text-right text-slate-300`}>{a.activity.orders}</td>
                    <td className={`${td} text-right whitespace-nowrap text-slate-300`}>{formatMoney(a.activity.paidRevenue, a.currency)}</td>
                    <td className={`${td} text-right whitespace-nowrap`}>
                      <span className="text-slate-300">
                        {a.usage.runs7d} · {a.usage.tokens7d.toLocaleString()} tok
                      </span>
                      {a.usage.failures7d > 0 && <p className="text-[11px] text-amber-300">{a.usage.failures7d} failed</p>}
                    </td>
                    <td className={`${td} whitespace-nowrap text-slate-400`}>
                      {a.activity.lastCustomerMessageAt ? timeAgo(a.activity.lastCustomerMessageAt) : "—"}
                    </td>
                    <td className={`${td} whitespace-nowrap text-slate-400`}>{timeAgo(a.createdAt)}</td>
                    <td className={`${td} text-right whitespace-nowrap`}>
                      <div className="flex justify-end gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          className="border-slate-700 bg-slate-900 text-slate-200"
                          onClick={() => void open(a.id)}
                          disabled={busy === a.id}
                          title="Set up their connections"
                        >
                          {busy === a.id ? <Loader2 className="size-3.5 animate-spin" /> : <ExternalLink className="size-3.5" />} Set up
                        </Button>
                        <Link href={`/admin/accounts/${a.id}`}>
                          <Button size="sm">Manage</Button>
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
