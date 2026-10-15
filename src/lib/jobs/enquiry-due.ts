import 'server-only'
import { scopedCollection, type AuthContext } from '@/lib/db/scoped'
import type { ContactDoc, EnquiryDoc } from '@/lib/db/types'
import { escapeHtml, sendMessage, telegramTarget } from '@/lib/notify/telegram'

/** How long an enquiry may sit unpriced before the owner is nudged once. */
export const ENQUIRY_NUDGE_AFTER_MS = 5 * 60_000

/**
 * A customer who asked "how much?" and heard nothing is a customer
 * gone. Five minutes after an enquiry arrives, if it still has no
 * price, say so on Telegram — once, claimed with a conditional update
 * before sending so overlapping workers can't both nudge. Runs from the
 * background worker, so it fires on the first request after the five
 * minutes rather than on a timer.
 */
export async function remindOpenEnquiries(ctx: AuthContext): Promise<number> {
  const enquiries = await scopedCollection<EnquiryDoc>(ctx, 'enquiries')
  const stale = await enquiries
    .find({ status: 'open', remindedAt: null, createdAt: { $lt: new Date(Date.now() - ENQUIRY_NUDGE_AFTER_MS) } })
    .sort({ createdAt: 1 })
    .limit(5)
    .toArray()
  if (stale.length === 0) return 0

  const target = await telegramTarget(ctx)
  if (!target || !target.controlEnabled) return 0
  const contacts = await scopedCollection<ContactDoc>(ctx, 'contacts')
  let sent = 0
  for (const enquiry of stale) {
    const claimed = await enquiries.findOneAndUpdate(
      { _id: enquiry._id, status: 'open', remindedAt: null },
      { $set: { remindedAt: new Date() } },
    )
    if (!claimed) continue
    const contact = await contacts.findById(enquiry.contactId)
    const who = contact?.name ?? (contact ? `+${contact.phone}` : 'A customer')
    const html = [
      '⏳ <b>Still waiting for a price</b>',
      escapeHtml(who),
      escapeHtml(enquiry.summary),
      '',
      'Reply with <b>quote 15000</b> (your price) and the invoice goes to them now.',
    ].join('\n')
    for (const chat of target.chats) {
      await sendMessage(target.token, chat.chatId, html)
        .then((messageId) =>
          enquiries.updateById(enquiry._id, { $push: { telegram: { chatId: chat.chatId, messageId } } }),
        )
        .catch((err) => console.warn('[telegram] enquiry nudge failed', (err as Error).message))
    }
    sent++
  }
  return sent
}
