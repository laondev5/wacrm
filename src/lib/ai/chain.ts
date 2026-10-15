import 'server-only'
import { AIProviderError, generateJSON, NonJsonReplyError, plainReplyFrom, takeLastUsage, type GenerateJSONInput, type TokenUsage } from './client'
import { runChain, type Attempt, type ErrorKind } from './chain-core'
import { recordHealth, type ChainEntry } from './platform-config'
import { transcribeAudio } from './transcribe'

export { ChainFailedError } from './chain-core'
export type { Attempt } from './chain-core'

// ============================================================
// The two chains the platform runs: chat (primary + 3 fallbacks) and
// speech-to-text (primary + 1 fallback). The rules live in
// chain-core.ts; this file connects them to the real providers and
// records how each model is doing.
// ============================================================

/**
 * Chat deadlines. While another model can take over, a slow one is cut
 * off quickly (30s, then 20s each) so the customer still gets an answer;
 * the last model in line has nobody to hand over to and gets 60s. The
 * worst case is 30 + 20 + 20 + 60 = 130s, inside the 150s conversation
 * lock. A chain of one is just a 60s call, as it always was.
 */
export const CHAT_TIMEOUTS_MS = [30_000, 20_000, 20_000]
export const CHAT_FINAL_TIMEOUT_MS = 60_000
export const SPEECH_TIMEOUTS_MS = [25_000]
export const SPEECH_FINAL_TIMEOUT_MS = 40_000

function classify(err: unknown): { kind: ErrorKind; message: string; salvage?: string | null } {
  if (err instanceof NonJsonReplyError) {
    return { kind: 'other', message: err.message, salvage: plainReplyFrom(err.text) }
  }
  if (err instanceof AIProviderError) return { kind: err.kind, message: err.message }
  return { kind: 'other', message: 'AI call failed' }
}

type Outcome = { ok: boolean; kind: ErrorKind | null; message: string | null; cooldownMs: number }

async function writeHealth(entry: ChainEntry, outcome: Outcome): Promise<void> {
  // A success only needs writing when it clears a recorded failure;
  // otherwise every reply would be a database write.
  if (outcome.ok && (!entry.health || entry.health.ok)) return
  await recordHealth(entry.kind, entry.id, {
    ok: outcome.ok,
    error: outcome.message,
    kind: outcome.kind,
    cooldownMs: outcome.cooldownMs,
  })
}

export interface ChatResult {
  value: unknown
  entry: ChainEntry
  attempts: Attempt[]
  usage: TokenUsage | null
}

/**
 * Ask the chat chain. Throws ChainFailedError when every model failed.
 *
 * `accept` lets the caller reject an answer that parsed but is useless —
 * a model returning `{"": ""}` or a blank reply is a failure, not a
 * success, and the customer would otherwise be sent nothing. A rejected
 * answer moves on to the next model exactly like an error does.
 */
export async function generateWithFallback(
  entries: ChainEntry[],
  input: Omit<GenerateJSONInput, 'timeoutMs'>,
  accept?: (value: unknown) => boolean,
): Promise<ChatResult> {
  let usage: TokenUsage | null = null
  const addUsage = (u: TokenUsage | null) => {
    if (u) usage = usage ? { input: usage.input + u.input, output: usage.output + u.output, total: usage.total + u.total } : u
  }
  const { value, member, attempts } = await runChain(
    entries,
    async (entry, timeoutMs) => {
      const started = Date.now()
      const ask = async (jsonMode: boolean, ms: number) => {
        try {
          return await generateJSON(entry.provider, { ...input, timeoutMs: ms, jsonMode })
        } finally {
          addUsage(takeLastUsage())
        }
      }

      // Open models are inconsistent in JSON mode: garbled output, a blank
      // reply, `{"": ""}`. The same model is usually fine when asked again
      // with only the schema in the prompt — and quicker. So before giving
      // up on it, try once more that way, within the same deadline.
      const canRetryPlain = entry.provider.kind === 'openai_compatible'
      let out: unknown
      let firstError: unknown = null
      try {
        out = await ask(true, timeoutMs)
      } catch (err) {
        if (!canRetryPlain || !(err instanceof NonJsonReplyError)) throw err
        firstError = err
      }
      if (canRetryPlain && (firstError || (accept && !accept(out)))) {
        const left = timeoutMs - (Date.now() - started)
        if (left > 5_000) {
          try {
            const retry = await ask(false, left)
            if (!accept || accept(retry)) return retry
          } catch (err) {
            firstError ??= err
          }
        }
      }
      if (firstError) throw firstError
      if (accept && !accept(out)) throw new AIProviderError('The model returned an empty or unusable reply', 'other')
      return out
    },
    { timeouts: CHAT_TIMEOUTS_MS, finalTimeoutMs: CHAT_FINAL_TIMEOUT_MS, classify, onOutcome: writeHealth },
  )
  return { value, entry: member, attempts, usage }
}

/** Transcribe a voice note through the speech chain. */
export async function transcribeWithFallback(
  entries: ChainEntry[],
  audio: { bytes: Uint8Array; mime: string | null },
): Promise<{ text: string; entry: ChainEntry; attempts: Attempt[] }> {
  const { value, member, attempts } = await runChain(
    entries,
    (entry, timeoutMs) => transcribeAudio(entry.provider, audio, timeoutMs),
    { timeouts: SPEECH_TIMEOUTS_MS, finalTimeoutMs: SPEECH_FINAL_TIMEOUT_MS, classify, onOutcome: writeHealth },
  )
  return { text: value, entry: member, attempts }
}
