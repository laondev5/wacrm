import 'server-only'
import { getDb } from '@/lib/db/mongo'
import type { AIProviderDoc, PlatformAIConfigDoc, PlatformAIHealth, PlatformAISlot } from '@/lib/db/types'
import type { Document } from 'mongodb'
import { getPreset } from './presets'
import type { SlotKind } from './slots'

// ============================================================
// The platform's own AI setup: one document, written only from the
// admin console, read by the sales rep and the voice-note pipeline.
//
// It lives in `platform_settings`, deliberately outside every
// merchant's account: a merchant can neither read the keys nor change
// which model answers their customers.
// ============================================================

const COLLECTION = 'platform_settings'
const DOC_ID = 'ai'

export async function loadPlatformAI(): Promise<PlatformAIConfigDoc | null> {
  const db = await getDb()
  return db.collection<PlatformAIConfigDoc>(COLLECTION).findOne({ _id: DOC_ID })
}

/** What generateJSON / transcribeAudio expect, built from a platform slot. */
export function slotToProvider(slot: PlatformAISlot): AIProviderDoc {
  const preset = getPreset(slot.preset)
  const now = new Date()
  return {
    _id: slot.id,
    accountId: 'platform',
    createdAt: now,
    updatedAt: now,
    label: preset?.label ?? slot.preset,
    kind: preset?.kind ?? 'openai_compatible',
    preset: slot.preset,
    baseUrl: slot.baseUrl,
    apiKeyEnc: slot.apiKeyEnc,
    model: slot.model,
    isDefault: false,
    lastTestAt: null,
    lastTestOk: null,
  }
}

export interface ChainEntry {
  id: string
  model: string
  kind: SlotKind
  provider: AIProviderDoc
  health: PlatformAIHealth | null
}

/** A slot is usable if its preset either needs no key or has one. */
export function isUsableSlot(slot: PlatformAISlot | null | undefined): slot is PlatformAISlot {
  if (!slot || !slot.model) return false
  const preset = getPreset(slot.preset)
  if (!preset) return false
  return !preset.requiresKey || !!slot.apiKeyEnc
}

function entriesFor(cfg: PlatformAIConfigDoc | null, kind: SlotKind): ChainEntry[] {
  const slots = (kind === 'chat' ? cfg?.chat : cfg?.speech) ?? []
  return slots.filter(isUsableSlot).map((slot) => ({
    id: slot.id,
    model: slot.model,
    kind,
    provider: slotToProvider(slot),
    health: slot.health ?? null,
  }))
}

export async function chatChain(): Promise<ChainEntry[]> {
  return entriesFor(await loadPlatformAI(), 'chat')
}

export async function speechChain(): Promise<ChainEntry[]> {
  return entriesFor(await loadPlatformAI(), 'speech')
}

/**
 * Remember how a slot did. Best-effort: bookkeeping must never be the
 * reason a customer goes unanswered, so a failed write is only logged.
 */
export async function recordHealth(
  kind: SlotKind,
  slotId: string,
  outcome: { ok: boolean; error: string | null; kind: PlatformAIHealth['kind']; cooldownMs: number },
): Promise<void> {
  try {
    const db = await getDb()
    const now = new Date()
    const health: PlatformAIHealth = {
      ok: outcome.ok,
      at: now,
      error: outcome.error ? outcome.error.slice(0, 300) : null,
      kind: outcome.kind,
      cooldownUntil: outcome.cooldownMs > 0 ? new Date(now.getTime() + outcome.cooldownMs) : null,
    }
    // Untyped filter: the array-element path (`chat.id`) isn't something
    // the driver's typings can express, and `_id` here is a string, not
    // the ObjectId the generic Document type assumes.
    const filter = { _id: DOC_ID, [kind + '.id']: slotId } as unknown as Document
    await db.collection<Document>(COLLECTION).updateOne(filter, { $set: { [kind + '.$.health']: health } })
  } catch (err) {
    console.warn('[ai-chain] could not record health', (err as Error).message)
  }
}
