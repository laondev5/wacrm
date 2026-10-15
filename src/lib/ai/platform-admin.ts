import 'server-only'
import { newId } from '@/lib/db/ids'
import type { PlatformAIConfigDoc, PlatformAISlot } from '@/lib/db/types'
import { ValidationError } from '@/lib/http/errors'
import { optStr, str } from '@/lib/http/validate'
import { decrypt, encrypt, maskSecret } from '@/lib/security/secrets'
import { validateBaseUrl } from './provider-admin'
import { getPreset } from './presets'
import { CHAT_SLOTS, MODEL_PATTERN, SPEECH_SLOTS, type SlotKind } from './slots'
import { SPEECH_PRESET_IDS } from './speech-formats'

// ============================================================
// Validation and shaping for the admin's AI screen. Everything the
// operator submits is checked here before it can reach the chain the
// merchants' customers depend on.
// ============================================================

export const SLOT_LIMIT: Record<SlotKind, number> = { chat: CHAT_SLOTS, speech: SPEECH_SLOTS }

/** What the browser is allowed to see of a slot — never the key. */
export function shapeSlot(slot: PlatformAISlot | null | undefined) {
  if (!slot) return null
  let masked: string | null = null
  try {
    masked = slot.apiKeyEnc ? maskSecret(decrypt(slot.apiKeyEnc)) : null
  } catch {
    masked = '(unreadable — re-enter the key)'
  }
  return {
    id: slot.id,
    preset: slot.preset,
    model: slot.model,
    baseUrl: slot.baseUrl,
    apiKeyMasked: masked,
    health: slot.health
      ? {
          ok: slot.health.ok,
          at: slot.health.at,
          error: slot.health.error,
          kind: slot.health.kind,
          cooldownUntil: slot.health.cooldownUntil,
          // Worked out here, once, so the browser never compares against its own clock.
          cooling: !slot.health.ok && !!slot.health.cooldownUntil && slot.health.cooldownUntil.getTime() > Date.now(),
        }
      : null,
  }
}

export function shapeConfig(cfg: PlatformAIConfigDoc | null) {
  const pad = (slots: Array<PlatformAISlot | null> | undefined, n: number) =>
    Array.from({ length: n }, (_, i) => shapeSlot(slots?.[i]))
  return {
    chat: pad(cfg?.chat, CHAT_SLOTS),
    speech: pad(cfg?.speech, SPEECH_SLOTS),
    updatedAt: cfg?.updatedAt ?? null,
  }
}

/**
 * Validate one slot the operator submitted. `previous` is what is stored
 * under the same id, so leaving the key box blank keeps the saved key —
 * but only while the provider is unchanged: a key for one company must
 * never silently follow a slot over to another.
 */
export async function parseSlot(
  raw: unknown,
  kind: SlotKind,
  previous: Map<string, PlatformAISlot>,
): Promise<PlatformAISlot> {
  if (!raw || typeof raw !== 'object') throw new ValidationError('Invalid AI slot')
  const o = raw as Record<string, unknown>

  const preset = getPreset(str(o.preset, 'provider', { max: 40 }))
  if (!preset) throw new ValidationError('Unknown AI provider')
  if (kind === 'speech' && !(SPEECH_PRESET_IDS as readonly string[]).includes(preset.id)) {
    throw new ValidationError('Voice notes can be transcribed by OpenAI or Groq only')
  }

  const model = str(o.model, 'model', { max: 120 })
  if (!MODEL_PATTERN.test(model)) throw new ValidationError('Model name has invalid characters')

  const claimedId = typeof o.id === 'string' ? o.id : null
  const prev = claimedId ? previous.get(claimedId) : undefined
  const id = prev ? prev.id : newId()

  const typedKey = optStr(o.apiKey, 'apiKey', 400)
  const apiKeyEnc = typedKey ? encrypt(typedKey) : prev && prev.preset === preset.id ? prev.apiKeyEnc : null
  if (preset.requiresKey && !apiKeyEnc) throw new ValidationError(`${preset.label} needs an API key`)

  let baseUrl: string | null = null
  if (preset.customBaseUrl) {
    baseUrl = await validateBaseUrl(optStr(o.baseUrl, 'baseUrl', 300) ?? preset.baseUrl)
    if (!baseUrl) throw new ValidationError(`${preset.label} needs a base URL`)
  }

  // A changed provider, model, key or address deserves a fresh start, not
  // the old one's failure history.
  const unchanged = !!prev && prev.preset === preset.id && prev.model === model && !typedKey && prev.baseUrl === baseUrl
  return { id, preset: preset.id, model, apiKeyEnc, baseUrl, health: unchanged ? (prev.health ?? null) : null }
}

/** Parse the submitted list: drop blanks, cap the length, keep order. */
export async function parseSlots(
  raw: unknown,
  kind: SlotKind,
  existing: Array<PlatformAISlot | null> | undefined,
): Promise<PlatformAISlot[]> {
  if (raw === undefined) return (existing ?? []).filter((s): s is PlatformAISlot => !!s)
  if (!Array.isArray(raw)) throw new ValidationError('Invalid AI configuration')
  const items = raw.filter((x) => x !== null && x !== undefined)
  if (items.length > SLOT_LIMIT[kind]) {
    throw new ValidationError(`At most ${SLOT_LIMIT[kind]} ${kind === 'chat' ? 'chat' : 'voice'} models`)
  }
  const previous = new Map((existing ?? []).filter((s): s is PlatformAISlot => !!s).map((s) => [s.id, s]))
  const out: PlatformAISlot[] = []
  for (const item of items) out.push(await parseSlot(item, kind, previous))
  return out
}
