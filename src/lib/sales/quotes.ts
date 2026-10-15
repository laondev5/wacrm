import 'server-only'
import { loadAccount } from '@/lib/auth/accounts'
import { scopedCollection, type AuthContext } from '@/lib/db/scoped'
import type { ContactDoc, EnquiryDoc, OrderDoc } from '@/lib/db/types'
import { ConflictError, NotFoundError, ValidationError } from '@/lib/http/errors'
import { notifyEnquiry } from '@/lib/notify/telegram'
import { sendText } from '@/lib/whatsapp/store'
import { createOrder, createPaymentLink, deliverInvoice } from './orders'

// ============================================================
// Enquiry → quote → invoice.
//
// Most print and design work is priced per job, so the secretary can't
// quote it and the catalogue can't hold it. What the owner needs is to
// say one number and have the invoice reach the customer. This is that
// step: an open enquiry is turned into an order with a single custom
// line at the owner's price, and the invoice and payment details are
// sent on WhatsApp straight away.
//
// The price is only ever the owner's — it arrives from their Telegram
// chat or their signed-in session, never from the customer or the AI.
// ============================================================

/**
 * Record a request that needs the owner's price and tell them on
 * Telegram. One open enquiry per distinct request: the same sentence
 * from the same conversation is not recorded twice.
 */
export async function openEnquiry(
  ctx: AuthContext,
  conversationId: string,
  contact: ContactDoc,
  enquiry: { summary: string; deadline: string | null },
): Promise<EnquiryDoc | null> {
  const enquiries = await scopedCollection<EnquiryDoc>(ctx, 'enquiries')
  const open = await enquiries.find({ conversationId, status: 'open' }).limit(20).toArray()
  if (open.some((e) => e.summary.toLowerCase() === enquiry.summary.toLowerCase())) return null

  const created = await enquiries.insertOne({
    contactId: contact._id,
    conversationId,
    summary: enquiry.summary,
    deadline: enquiry.deadline,
    status: 'open',
    orderId: null,
    telegram: [],
    remindedAt: null,
  })
  // The alert is best-effort and slow; the customer's reply has already gone.
  void notifyEnquiry(ctx, contact.name ?? `+${contact.phone}`, enquiry.summary, enquiry.deadline, '15000')
    .then((sent) => (sent.length ? enquiries.updateById(created._id, { $set: { telegram: sent } }) : null))
    .catch((err) => console.warn('[enquiry] could not record alert', (err as Error).message))
  return created
}

export interface QuoteResult {
  order: OrderDoc
  /** False when the order exists but WhatsApp would not take the message (24-hour window, no connection). */
  delivered: boolean
  deliveryError: string | null
}

/**
 * Price an open enquiry. Claimed with a conditional update first, so a
 * double tap or two chats answering at once produce one invoice.
 */
export async function quoteEnquiry(
  ctx: AuthContext,
  enquiryId: string,
  input: { amountMinor: number; description?: string | null },
): Promise<QuoteResult> {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor < 1) {
    throw new ValidationError('Enter a price greater than zero')
  }
  const enquiries = await scopedCollection<EnquiryDoc>(ctx, 'enquiries')
  const existing = await enquiries.findById(enquiryId)
  if (!existing) throw new NotFoundError('Enquiry not found')

  const claimed = await enquiries.findOneAndUpdate({ _id: enquiryId, status: 'open' }, { $set: { status: 'quoted' } })
  if (!claimed) throw new ConflictError(existing.status === 'quoted' ? 'That enquiry has already been quoted' : 'That enquiry is closed')

  let order: OrderDoc
  try {
    order = await createOrder(ctx, {
      lines: [],
      customLines: [
        { name: input.description?.trim() || claimed.summary, quantity: 1, unitPrice: input.amountMinor },
      ],
      contactId: claimed.contactId,
      conversationId: claimed.conversationId,
      source: 'quote',
      notes: `Quote for: ${claimed.summary}${claimed.deadline ? ` (needed: ${claimed.deadline})` : ''}`,
      status: 'awaiting_payment',
    })
  } catch (err) {
    await enquiries.updateById(enquiryId, { $set: { status: 'open' } }).catch(() => {})
    throw err
  }
  await enquiries.updateById(enquiryId, { $set: { orderId: order._id } })

  // Same payment choice the sales rep makes for a catalogue order.
  const account = await loadAccount(ctx.accountId)
  const settings = account?.salesAgent
  const orders = await scopedCollection<OrderDoc>(ctx, 'orders')
  if (settings?.autoSendPaymentLink && (settings.paymentProvider === 'paystack' || settings.paymentProvider === 'flutterwave')) {
    try {
      order = await createPaymentLink(ctx, order._id, settings.paymentProvider)
    } catch (err) {
      console.warn('[quote] payment link failed, falling back to bank details:', (err as Error).message)
    }
  } else {
    await orders.updateById(order._id, { $set: { 'payment.provider': 'bank_transfer', 'payment.status': 'pending' } })
    order = { ...order, payment: { ...order.payment, provider: 'bank_transfer', status: 'pending' } }
  }

  try {
    // sendText records a refusal (closed 24-hour window, WhatsApp not
    // connected) as a failed message instead of throwing, so read it.
    const lead = await sendText(ctx, claimed.conversationId, `Thanks for waiting! Here is your quote for ${claimed.summary}:`, 'agent')
    if (lead.status === 'failed') {
      return { order, delivered: false, deliveryError: (lead.error ?? 'WhatsApp refused the message').slice(0, 200) }
    }
    await deliverInvoice(ctx, order, 'agent')
    return { order, delivered: true, deliveryError: null }
  } catch (err) {
    console.warn('[quote] could not deliver invoice', (err as Error).message)
    return { order, delivered: false, deliveryError: (err as Error).message.slice(0, 200) }
  }
}

/** The customer no longer needs a quote (they went elsewhere, or it was a duplicate). */
export async function dismissEnquiry(ctx: AuthContext, enquiryId: string): Promise<void> {
  const enquiries = await scopedCollection<EnquiryDoc>(ctx, 'enquiries')
  const closed = await enquiries.findOneAndUpdate({ _id: enquiryId, status: 'open' }, { $set: { status: 'dismissed' } })
  if (!closed) throw new ConflictError('That enquiry is already closed')
}

/**
 * The enquiry a Telegram message is about: the one replied to, or the
 * only one still open. With several open and no reply to say which, it
 * is 'ambiguous' — guessing would put an invoice in front of the wrong
 * customer.
 */
export async function targetEnquiry(
  ctx: AuthContext,
  replyToMessageId: number | null,
): Promise<EnquiryDoc | 'ambiguous' | null> {
  const enquiries = await scopedCollection<EnquiryDoc>(ctx, 'enquiries')
  if (replyToMessageId) {
    const byReply = await enquiries.findOne({ status: 'open', 'telegram.messageId': replyToMessageId })
    if (byReply) return byReply
  }
  const open = await enquiries.find({ status: 'open' }).sort({ createdAt: -1 }).limit(2).toArray()
  if (open.length === 0) return null
  return open.length === 1 ? open[0] : 'ambiguous'
}
