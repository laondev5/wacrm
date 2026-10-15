import { NextResponse } from 'next/server'
import { requirePlatformAdmin } from '@/lib/auth/platform'
import { parseSlots, shapeConfig } from '@/lib/ai/platform-admin'
import { loadPlatformAI } from '@/lib/ai/platform-config'
import { getDb } from '@/lib/db/mongo'
import type { AIRunDoc, PlatformAIConfigDoc } from '@/lib/db/types'
import { readJson, toErrorResponse } from '@/lib/http/errors'

// ============================================================
// The platform's AI: the model that powers every merchant's sales rep
// (plus three fallbacks) and the one that transcribes their voice notes
// (plus one fallback). Configured here and nowhere else.
// ============================================================

/** GET — the current setup (keys masked) and which slot has been answering. */
export async function GET() {
  try {
    await requirePlatformAdmin()
    const cfg = await loadPlatformAI()
    const db = await getDb()
    const since = new Date(Date.now() - 7 * 86_400_000)
    // Per model: how many times it answered, how many times it failed
    // (including the times a fallback then covered for it), and tokens.
    // Failures live on each run's `attempts`, not on the run itself — a
    // run that a fallback rescued is a success overall, and would hide
    // exactly the failures the operator needs to see.
    const runs = db.collection<AIRunDoc>('ai_runs')
    const [attempted, billed] = await Promise.all([
      runs
        .aggregate<{ _id: string; ok: number; failed: number }>([
          { $match: { createdAt: { $gte: since }, attempts: { $exists: true, $ne: [] } } },
          { $unwind: '$attempts' },
          {
            $group: {
              _id: '$attempts.id',
              ok: { $sum: { $cond: ['$attempts.ok', 1, 0] } },
              failed: { $sum: { $cond: ['$attempts.ok', 0, 1] } },
            },
          },
        ])
        .toArray(),
      runs
        .aggregate<{ _id: string; tokens: number }>([
          { $match: { createdAt: { $gte: since }, ok: true } },
          { $group: { _id: '$providerId', tokens: { $sum: { $ifNull: ['$tokens.total', 0] } } } },
        ])
        .toArray(),
    ])
    const served: Record<string, { ok: number; failed: number; tokens: number }> = {}
    for (const r of attempted) served[r._id] = { ok: r.ok, failed: r.failed, tokens: 0 }
    for (const r of billed) served[r._id] = { ok: served[r._id]?.ok ?? 0, failed: served[r._id]?.failed ?? 0, tokens: r.tokens }
    return NextResponse.json({
      ...shapeConfig(cfg),
      served,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** PUT { chat: Slot[], speech: Slot[] } — replace the setup. Blank slots are dropped. */
export async function PUT(request: Request) {
  try {
    const admin = await requirePlatformAdmin()
    const body = await readJson(request)
    const existing = await loadPlatformAI()
    const chat = await parseSlots(body.chat, 'chat', existing?.chat)
    const speech = await parseSlots(body.speech, 'speech', existing?.speech)

    const db = await getDb()
    await db.collection<PlatformAIConfigDoc>('platform_settings').updateOne(
      { _id: 'ai' },
      { $set: { chat, speech, updatedAt: new Date(), updatedBy: admin.email } },
      { upsert: true },
    )
    return NextResponse.json(shapeConfig(await loadPlatformAI()))
  } catch (err) {
    return toErrorResponse(err)
  }
}
