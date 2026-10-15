import 'server-only'
import { ChainFailedError, transcribeWithFallback } from '@/lib/ai/chain'
import { speechChain } from '@/lib/ai/platform-config'
import { scopedCollection, type AuthContext } from '@/lib/db/scoped'
import type { ConversationDoc, MessageDoc } from '@/lib/db/types'
import { downloadMedia, getMediaUrl } from '@/lib/whatsapp/meta-api'
import { getWhatsAppCredentials, sendText } from '@/lib/whatsapp/store'

// ============================================================
// Inbound voice notes.
//
// Customers in a hurry talk instead of typing. The audio is fetched
// from WhatsApp, transcribed, and written back onto the message as
// its text — from there the rep, the inbox and the order detection
// all treat it like anything else the customer typed.
//
// The transcript is stored, not just used: staff reading the inbox
// later should see what was said without replaying the clip.
// ============================================================

/**
 * Transcribe an inbound audio message in place. Returns the updated
 * message, or null when it could not be transcribed — the caller then
 * carries on with the original, which has no text and so stays quiet.
 */
export async function transcribeInbound(
  ctx: AuthContext,
  conversation: ConversationDoc,
  message: MessageDoc,
): Promise<MessageDoc | null> {
  const mediaId = message.media?.id
  if (!mediaId) return null

  const chain = await speechChain()
  if (chain.length === 0) {
    // The platform has no speech model set up. Say so, in the
    // customer's own chat, rather than leaving them waiting on silence.
    await sendText(
      ctx,
      conversation._id,
      "Sorry, I can't listen to voice notes yet — please send that as a message and I'll help right away.",
      'ai',
    ).catch(() => {})
    return null
  }

  try {
    const creds = await getWhatsAppCredentials(ctx)
    if (!creds) return null
    const info = await getMediaUrl({ mediaId, accessToken: creds.accessToken })
    const { buffer, contentType } = await downloadMedia({ downloadUrl: info.url, accessToken: creds.accessToken })
    // Primary first, then the fallback: a Whisper outage or a spent quota
    // on one provider must not turn every voice note into "send it again".
    const { text: transcript } = await transcribeWithFallback(chain, {
      bytes: new Uint8Array(buffer),
      mime: contentType || info.mimeType || message.media?.mime || null,
    })

    const messages = await scopedCollection<MessageDoc>(ctx, 'messages')
    await messages.updateById(message._id, { $set: { text: transcript, transcribed: true } })
    const conversations = await scopedCollection<ConversationDoc>(ctx, 'conversations')
    await conversations.updateById(conversation._id, {
      $set: { lastMessagePreview: `🎤 ${transcript.slice(0, 80)}` },
    })
    return { ...message, text: transcript, transcribed: true }
  } catch (err) {
    const why = err instanceof ChainFailedError ? err.message : 'Could not transcribe the voice note'
    console.warn('[voice]', why)
    await sendText(
      ctx,
      conversation._id,
      "Sorry, I couldn't hear that clearly — could you type it or send it again?",
      'ai',
    ).catch(() => {})
    return null
  }
}
