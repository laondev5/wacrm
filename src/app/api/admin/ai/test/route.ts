import { NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/auth/platform'
import { AIProviderError, generateJSON } from '@/lib/ai/client'
import { parseSlot } from '@/lib/ai/platform-admin'
import { loadPlatformAI, recordHealth, slotToProvider } from '@/lib/ai/platform-config'
import { transcribeAudio } from '@/lib/ai/transcribe'
import { testToneWav } from '@/lib/ai/speech-formats'
import type { PlatformAISlot } from '@/lib/db/types'
import { readJson, toErrorResponse } from '@/lib/http/errors'
import { oneOf } from '@/lib/http/validate'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

/**
 * POST { kind: 'chat' | 'speech', slot } — call one model with the key
 * and settings exactly as typed, before anything is saved. A saved key
 * is used when the key box was left blank.
 *
 * Chat: a tiny structured request. Speech: a generated one-second tone,
 * since there is no recording to send — an empty transcript still
 * proves the key and model are callable.
 */
export async function POST(request: Request) {
  try {
    const admin = await requirePlatformAdmin()
    const limit = checkRateLimit(`integration:${admin.userId}`, RATE_LIMITS.integrationTest)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await readJson(request)
    const kind = oneOf(body.kind, 'kind', ['chat', 'speech'] as const)
    const existing = await loadPlatformAI()
    const saved = (kind === 'chat' ? existing?.chat : existing?.speech) ?? []
    const previous = new Map(saved.filter((s): s is PlatformAISlot => !!s).map((s) => [s.id, s]))
    const typedKey = !!(body.slot && typeof body.slot === 'object' && (body.slot as Record<string, unknown>).apiKey)
    const slot = await parseSlot(body.slot, kind, previous)
    const provider = slotToProvider(slot)

    const started = Date.now()
    let ok = false
    let message = ''
    let failKind: 'quota' | 'auth' | 'model' | 'timeout' | 'other' = 'other'
    try {
      if (kind === 'chat') {
        const out = (await generateJSON(provider, {
          system: 'You are a connectivity check. Reply with JSON only.',
          messages: [{ role: 'user', content: 'Reply with {"ok": true, "greeting": "<a 3-word hello>"}' }],
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['ok', 'greeting'],
            properties: { ok: { type: 'boolean' }, greeting: { type: 'string' } },
          },
          maxTokens: 1500,
          timeoutMs: 40_000,
        })) as { ok?: boolean; greeting?: string }
        ok = out?.ok === true
        message = ok
          ? `Connected — "${String(out.greeting ?? '').slice(0, 60)}"`
          : 'The model replied, but not in the expected format'
      } else {
        await transcribeAudio(provider, { bytes: testToneWav(), mime: 'audio/wav' }, 30_000, { allowEmpty: true })
        ok = true
        message = 'Connected — the model accepted an audio file'
      }
    } catch (err) {
      message = err instanceof AIProviderError ? err.message : 'Could not reach the provider'
      if (err instanceof AIProviderError) failKind = err.kind
    }

    // Only note the result against the saved slot if what was tested is
    // what is saved — otherwise a typo'd draft would mark a good slot bad.
    const prev = previous.get(slot.id)
    if (prev && prev.preset === slot.preset && prev.model === slot.model && prev.baseUrl === slot.baseUrl && !typedKey) {
      await recordHealth(kind, slot.id, { ok, error: ok ? null : message, kind: ok ? null : failKind, cooldownMs: 0 })
    }
    return NextResponse.json({ ok, message, latencyMs: Date.now() - started })
  } catch (err) {
    return toErrorResponse(err)
  }
}
