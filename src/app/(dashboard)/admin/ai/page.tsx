"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, CheckCircle2, Loader2, Mic, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { api } from "@/lib/client/api";
import { useAuth } from "@/hooks/use-auth";
import { AI_PRESETS, getPreset } from "@/lib/ai/presets";
import { CHAT_SLOT_LABELS, CHAT_SLOTS, SPEECH_SLOT_LABELS, SPEECH_SLOTS, type SlotKind } from "@/lib/ai/slots";
import { SPEECH_MODELS, SPEECH_PRESET_IDS } from "@/lib/ai/speech-formats";
import { Button } from "@/components/ui/button";
import { PasswordInput } from "@/components/ui/password-input";
import { Field, PageHeader, Panel, inputCls, timeAgo } from "@/components/sales/kit";

interface Health {
  ok: boolean;
  at: string;
  error: string | null;
  kind: string | null;
  cooldownUntil: string | null;
  cooling?: boolean;
}
interface SlotView {
  id: string;
  preset: string;
  model: string;
  baseUrl: string | null;
  apiKeyMasked: string | null;
  health: Health | null;
}
interface ServerConfig {
  chat: Array<SlotView | null>;
  speech: Array<SlotView | null>;
  served: Record<string, { ok: number; failed: number; tokens: number }>;
}

interface Draft {
  id?: string;
  preset: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  masked: string | null;
  health: Health | null;
  models: string[] | null;
  result: { ok: boolean; message: string; ms: number } | null;
}

function fromView(v: SlotView | null): Draft | null {
  if (!v) return null;
  return {
    id: v.id,
    preset: v.preset,
    model: v.model,
    apiKey: "",
    baseUrl: v.baseUrl ?? "",
    masked: v.apiKeyMasked,
    health: v.health,
    models: null,
    result: null,
  };
}

function blank(kind: SlotKind): Draft {
  const preset = kind === "chat" ? getPreset("nvidia")! : getPreset("groq")!;
  return {
    preset: preset.id,
    model: kind === "chat" ? preset.defaultModel : SPEECH_MODELS[preset.id]?.[0] ?? "",
    apiKey: "",
    baseUrl: preset.baseUrl ?? "",
    masked: null,
    health: null,
    models: null,
    result: null,
  };
}

const CATEGORY = { paid: "Paid APIs", open_source: "Open-source models (hosted)", local: "Self-hosted" } as const;

function HealthLine({ health }: { health: Health | null }) {
  if (!health) return <span className="text-slate-500">Not used yet</span>;
  if (health.ok) return <span className="text-emerald-300">Working · checked {timeAgo(health.at)}</span>;
  const cooling = !!health.cooling;
  return (
    <span className="text-amber-300">
      Failing ({health.kind ?? "error"}) {timeAgo(health.at)}
      {cooling ? " · skipped for now, tried last" : ""}
      {health.error ? <span className="block break-words text-[11px] text-slate-400">{health.error}</span> : null}
    </span>
  );
}

function SlotCard(props: {
  kind: SlotKind;
  label: string;
  index: number;
  count: number;
  draft: Draft | null;
  served?: { ok: number; failed: number; tokens: number };
  onChange: (next: Draft | null) => void;
  onMove: (dir: -1 | 1) => void;
}) {
  const { kind, label, index, count, draft, served, onChange, onMove } = props;
  const [busy, setBusy] = useState<"test" | "models" | null>(null);

  if (!draft) {
    return (
      <button
        type="button"
        onClick={() => onChange(blank(kind))}
        className="flex w-full items-center justify-between rounded-xl border border-dashed border-slate-700 px-4 py-3 text-left text-sm text-slate-400 hover:border-slate-500 hover:text-slate-200"
      >
        <span>
          <span className="font-medium text-slate-300">{label}</span> · empty
        </span>
        <span className="inline-flex items-center gap-1">
          <Plus className="size-4" /> Add model
        </span>
      </button>
    );
  }

  const preset = getPreset(draft.preset);
  const presets = AI_PRESETS.filter((p) => kind === "chat" || (SPEECH_PRESET_IDS as readonly string[]).includes(p.id));
  const suggestions = draft.models ?? (kind === "chat" ? preset?.suggestedModels ?? [] : SPEECH_MODELS[draft.preset] ?? []);
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch, result: patch.result === undefined ? null : patch.result });

  const changePreset = (id: string) => {
    const p = getPreset(id)!;
    onChange({
      ...draft,
      preset: id,
      model: kind === "chat" ? p.defaultModel : SPEECH_MODELS[id]?.[0] ?? "",
      baseUrl: p.baseUrl ?? "",
      // A saved key belongs to the provider it was saved for.
      apiKey: "",
      masked: null,
      models: null,
      result: null,
    });
  };

  const slotBody = () => ({
    id: draft.id,
    preset: draft.preset,
    model: draft.model,
    apiKey: draft.apiKey || undefined,
    baseUrl: draft.baseUrl || undefined,
  });

  const test = async () => {
    setBusy("test");
    try {
      const r = await api<{ ok: boolean; message: string; latencyMs: number }>("/api/admin/ai/test", { body: { kind, slot: slotBody() } });
      onChange({ ...draft, result: { ok: r.ok, message: r.message, ms: r.latencyMs } });
    } catch (e) {
      onChange({ ...draft, result: { ok: false, message: (e as Error).message, ms: 0 } });
    } finally {
      setBusy(null);
    }
  };

  const loadModels = async () => {
    setBusy("models");
    try {
      const r = await api<{ models: string[] }>("/api/admin/ai/models", { body: { slot: slotBody() } });
      onChange({ ...draft, models: r.models, result: null });
      toast.success(`${r.models.length} models listed — press Test to confirm the one you pick works`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium text-white">
            {kind === "chat" ? <Sparkles className="size-4 text-primary" /> : <Mic className="size-4 text-primary" />}
            {label}
            {index === 0 && <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">tried first</span>}
          </p>
          <p className="mt-0.5 text-[11px]">
            <HealthLine health={draft.health} />
            {served && served.ok + served.failed > 0 && (
              <span className="ml-2 text-slate-500">
                · {served.ok.toLocaleString()} answered this week{served.failed ? `, ${served.failed} failed` : ""}
                {served.tokens ? ` · ${served.tokens.toLocaleString()} tokens` : ""}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" className="text-slate-400" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move up">
            <ArrowUp className="size-4" />
          </Button>
          <Button size="icon-sm" variant="ghost" className="text-slate-400" disabled={index >= count - 1} onClick={() => onMove(1)} aria-label="Move down">
            <ArrowDown className="size-4" />
          </Button>
          <Button size="icon-sm" variant="ghost" className="text-slate-400 hover:text-red-300" onClick={() => onChange(null)} aria-label="Remove this model">
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Provider">
          <select className={inputCls} value={draft.preset} onChange={(e) => changePreset(e.target.value)}>
            {(["paid", "open_source", "local"] as const).map((cat) => {
              const inCat = presets.filter((p) => p.category === cat);
              return inCat.length ? (
                <optgroup key={cat} label={CATEGORY[cat]}>
                  {inCat.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </optgroup>
              ) : null;
            })}
          </select>
        </Field>

        <Field
          label="Model"
          hint={draft.models ? `${draft.models.length} models listed — pick one, then Test.` : "Type any model id, or load the provider's list."}
        >
          <div className="flex gap-2">
            <input
              className={inputCls}
              list={`models-${kind}-${index}`}
              value={draft.model}
              onChange={(e) => set({ model: e.target.value.trim() })}
              spellCheck={false}
            />
            {kind === "chat" && (
              <Button variant="outline" size="icon" className="shrink-0 border-slate-700 bg-slate-900 text-slate-300" onClick={() => void loadModels()} disabled={busy !== null} aria-label="Load models" title="Load this provider's models">
                {busy === "models" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              </Button>
            )}
          </div>
          <datalist id={`models-${kind}-${index}`}>
            {suggestions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>

        <Field
          label="API key"
          className={preset?.customBaseUrl ? "" : "sm:col-span-2"}
          hint={draft.masked ? "Saved — leave blank to keep it." : preset?.keyHelpUrl ? `Get one at ${preset.keyHelpUrl.replace(/^https?:\/\//, "")}` : undefined}
        >
          <PasswordInput
            autoComplete="off"
            className={inputCls}
            value={draft.apiKey}
            placeholder={draft.masked ? `${draft.masked}  (saved)` : preset?.requiresKey ? "Paste the key" : "Optional"}
            onChange={(e) => set({ apiKey: e.target.value.trim() })}
          />
        </Field>

        {preset?.customBaseUrl && (
          <Field label="Base URL" hint="OpenAI-compatible endpoint, e.g. https://your-host/v1">
            <input className={inputCls} value={draft.baseUrl} onChange={(e) => set({ baseUrl: e.target.value.trim() })} spellCheck={false} />
          </Field>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="outline" className="border-slate-700 bg-slate-900 text-slate-200" onClick={() => void test()} disabled={busy !== null || !draft.model}>
          {busy === "test" ? <Loader2 className="size-4 animate-spin" /> : null} Test
        </Button>
        {draft.result && (
          <p className={`flex items-start gap-1.5 text-xs ${draft.result.ok ? "text-emerald-300" : "text-red-300"}`}>
            {draft.result.ok ? <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />}
            <span className="break-words">
              {draft.result.message}
              {draft.result.ms ? ` (${(draft.result.ms / 1000).toFixed(1)}s)` : ""}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}

function padTo<T>(list: Array<T | null>, n: number): Array<T | null> {
  return Array.from({ length: n }, (_, i) => list[i] ?? null);
}

export default function AdminAIPage() {
  const { platformAdmin, loading } = useAuth();
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const [chat, setChat] = useState<Array<Draft | null>>([]);
  const [speech, setSpeech] = useState<Array<Draft | null>>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<"chat" | "voice">("chat");

  const apply = useCallback((c: ServerConfig) => {
    setCfg(c);
    setChat(padTo(c.chat.map(fromView), CHAT_SLOTS));
    setSpeech(padTo(c.speech.map(fromView), SPEECH_SLOTS));
    setDirty(false);
  }, []);

  useEffect(() => {
    if (!platformAdmin) return;
    api<ServerConfig>("/api/admin/ai").then(apply).catch((e) => toast.error(e.message));
  }, [platformAdmin, apply]);

  const edit = (kind: SlotKind, index: number, next: Draft | null) => {
    (kind === "chat" ? setChat : setSpeech)((cur) => cur.map((d, i) => (i === index ? next : d)));
    setDirty(true);
  };

  const move = (kind: SlotKind, index: number, dir: -1 | 1) => {
    (kind === "chat" ? setChat : setSpeech)((cur) => {
      const next = [...cur];
      const j = index + dir;
      if (j < 0 || j >= next.length) return cur;
      [next[index], next[j]] = [next[j], next[index]];
      return next;
    });
    setDirty(true);
  };

  const save = async () => {
    const body = (list: Array<Draft | null>) =>
      list
        .filter((d): d is Draft => !!d)
        .map((d) => ({ id: d.id, preset: d.preset, model: d.model, apiKey: d.apiKey || undefined, baseUrl: d.baseUrl || undefined }));
    setSaving(true);
    try {
      await api("/api/admin/ai", { method: "PUT", body: { chat: body(chat), speech: body(speech) } });
      // Reload rather than trust the response shape, so "answered this week" refreshes too.
      apply(await api<ServerConfig>("/api/admin/ai"));
      toast.success("System AI saved");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="h-64 animate-pulse rounded-xl bg-slate-900/50" />;
  if (!platformAdmin) return <p className="text-sm text-slate-400">This area is for the platform operator.</p>;

  const chatCount = chat.filter(Boolean).length;
  const speechCount = speech.filter(Boolean).length;

  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/admin" className="mb-3 inline-flex items-center gap-1 text-sm text-slate-400 hover:text-white">
        <ArrowLeft className="size-4" /> All merchants
      </Link>
      <PageHeader
        title="System AI"
        description="One AI powers every merchant's sales rep, and one transcribes their customers' voice notes. Merchants never see or bring a key."
      />

      <div className="mb-4 flex gap-1 rounded-xl border border-slate-800 bg-slate-900/60 p-1" role="tablist" aria-label="AI sections">
        {([
          { key: "chat", label: "Chat model", hint: "answers customers", Icon: Sparkles, count: chatCount, max: CHAT_SLOTS },
          { key: "voice", label: "Voice notes", hint: "voice → text", Icon: Mic, count: speechCount, max: SPEECH_SLOTS },
        ] as const).map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${
              tab === t.key ? "bg-primary/15 text-primary" : "text-slate-400 hover:bg-slate-800 hover:text-white"
            }`}
          >
            <t.Icon className="size-4" />
            <span className="font-medium">{t.label}</span>
            <span className="hidden text-xs opacity-70 sm:inline">· {t.hint}</span>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] ${t.count === 0 ? "bg-amber-500/15 text-amber-300" : "bg-slate-800 text-slate-300"}`}
            >
              {t.count === 0 ? "not set up" : `${t.count}/${t.max}`}
            </span>
          </button>
        ))}
      </div>

      {!cfg ? (
        <div className="h-64 animate-pulse rounded-xl bg-slate-900/50" />
      ) : (
        <div className="space-y-4">
          {tab === "chat" && (
          <Panel
            title="Sales rep — chat model"
            description="Tried in order. If the primary is slow, out of credit or rejected, the next one answers the customer instead. A model that just failed goes to the back of the queue for a few minutes so it doesn't slow everyone down."
          >
            <div className="space-y-3">
              {chat.map((d, i) => (
                <SlotCard
                  key={d?.id ?? `chat-${i}`}
                  kind="chat"
                  label={CHAT_SLOT_LABELS[i]}
                  index={i}
                  count={CHAT_SLOTS}
                  draft={d}
                  served={d?.id ? cfg.served[d.id] : undefined}
                  onChange={(n) => edit("chat", i, n)}
                  onMove={(dir) => move("chat", i, dir)}
                />
              ))}
            </div>
            {chatCount === 0 && (
              <p className="mt-3 flex items-center gap-2 text-xs text-amber-300">
                <AlertTriangle className="size-3.5" /> With no model here every merchant&apos;s rep answers from keyword rules only.
              </p>
            )}
          </Panel>
          )}

          {tab === "voice" && (
          <Panel
            title="Voice notes — transcription"
            description="Turns a customer's voice note into text before the sales rep reads it. OpenAI and Groq (Whisper) are supported. The fallback takes over if the primary fails."
          >
            <div className="space-y-3">
              {speech.map((d, i) => (
                <SlotCard
                  key={d?.id ?? `speech-${i}`}
                  kind="speech"
                  label={SPEECH_SLOT_LABELS[i]}
                  index={i}
                  count={SPEECH_SLOTS}
                  draft={d}
                  served={d?.id ? cfg.served[d.id] : undefined}
                  onChange={(n) => edit("speech", i, n)}
                  onMove={(dir) => move("speech", i, dir)}
                />
              ))}
            </div>
            {speechCount === 0 && (
              <p className="mt-3 flex items-center gap-2 text-xs text-amber-300">
                <AlertTriangle className="size-3.5" /> With no model here, customers who send a voice note are asked to type instead.
              </p>
            )}
          </Panel>
          )}

          <div className="sticky bottom-0 flex items-center justify-end gap-3 bg-gradient-to-t from-slate-950 via-slate-950 pt-3 pb-1">
            {dirty && <span className="text-xs text-amber-300">Unsaved changes</span>}
            <Button onClick={() => void save()} disabled={!dirty || saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : null} {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
