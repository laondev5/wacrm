import { NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/auth/platform'
import { AIProviderError, listModels } from '@/lib/ai/client'
import { parseSlot } from '@/lib/ai/platform-admin'
import { loadPlatformAI, slotToProvider } from '@/lib/ai/platform-config'
import type { PlatformAISlot } from '@/lib/db/types'
import { readJson, toErrorResponse, ValidationError } from '@/lib/http/errors'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

/**
 * POST { slot } — the models this key can list, so the operator picks
 * from the provider's real catalogue instead of guessing a model id.
 * A catalogue lists more than a key may call, so the Test button is
 * still the real check.
 */
export async function POST(request: Request) {
  try {
    const admin = await requirePlatformAdmin()
    const limit = checkRateLimit(`integration:${admin.userId}`, RATE_LIMITS.integrationTest)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await readJson(request)
    const existing = await loadPlatformAI()
    const previous = new Map(
      [...(existing?.chat ?? []), ...(existing?.speech ?? [])].filter((s): s is PlatformAISlot => !!s).map((s) => [s.id, s]),
    )
    // The model box may still be empty while the operator is choosing one.
    const given = (body.slot && typeof body.slot === 'object' ? body.slot : {}) as Record<string, unknown>
    const draft = { ...given, model: given.model || 'placeholder' }
    const slot = await parseSlot(draft, 'chat', previous)
    try {
      return NextResponse.json({ models: await listModels(slotToProvider(slot)) })
    } catch (err) {
      if (err instanceof AIProviderError) throw new ValidationError(err.message)
      throw err
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
