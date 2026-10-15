import 'server-only'
import { agentFlags } from '@/lib/ai/agents'
import { loadAccount } from '@/lib/auth/accounts'
import { scopedCollection, type AuthContext } from '@/lib/db/scoped'
import type { ConversationDoc, OrderDoc } from '@/lib/db/types'
import { NotFoundError, ValidationError } from '@/lib/http/errors'
import { sendText } from '@/lib/whatsapp/store'
import { DEFAULT_STAGE, jobUpdateMessage, type JobStage } from './job'

// ============================================================
// Moving a job along — the project manager's working half.
//
// Staff set the stage, due date and note from the order screen. If the
// project manager is on and the stage actually changed, the customer is
// told in fixed, merchant-recorded wording (never model output: a
// status message is a promise). The due date and note are saved either
// way; the message is the optional part.
// ============================================================

/** WhatsApp only allows free-form messages within a day of the customer's last one. */
const SESSION_WINDOW_MS = 24 * 60 * 60_000

export interface JobInput {
  stage?: JobStage
  /** undefined = leave alone, null = clear. */
  dueAt?: Date | null
  note?: string | null
}

export type Notified =
  | { sent: true }
  | { sent: false; reason: 'agent_off' | 'no_change' | 'not_started' | 'no_conversation' | 'window_closed' | 'send_failed' }

export async function updateJob(
  ctx: AuthContext,
  orderId: string,
  input: JobInput,
  now = new Date(),
): Promise<{ order: OrderDoc; notified: Notified }> {
  const orders = await scopedCollection<OrderDoc>(ctx, 'orders')
  const order = await orders.findById(orderId)
  if (!order) throw new NotFoundError('Order not found')
  if (order.status === 'cancelled') throw new ValidationError('A cancelled order has no job to track')

  const prev = order.job ?? { stage: DEFAULT_STAGE, dueAt: null, note: null, updatedAt: now }
  const dueAt = input.dueAt === undefined ? (prev.dueAt ?? null) : input.dueAt
  const dueChanged = (dueAt?.getTime() ?? null) !== (prev.dueAt?.getTime() ?? null)
  const next = {
    stage: input.stage ?? prev.stage,
    dueAt,
    note: input.note === undefined ? (prev.note ?? null) : input.note,
    updatedAt: now,
    // A new deadline deserves its own reminder.
    dueReminderSentAt: dueChanged ? null : (prev.dueReminderSentAt ?? null),
  }
  await orders.updateById(order._id, { $set: { job: next } })
  const saved = (await orders.findById(order._id)) ?? order

  const stageChanged = next.stage !== prev.stage
  return { order: saved, notified: await tellCustomer(ctx, saved, stageChanged, now) }
}

async function tellCustomer(ctx: AuthContext, order: OrderDoc, stageChanged: boolean, now: Date): Promise<Notified> {
  if (!stageChanged) return { sent: false, reason: 'no_change' }
  const account = await loadAccount(ctx.accountId)
  if (!account || !agentFlags(account).projectManager) return { sent: false, reason: 'agent_off' }
  if (!order.job) return { sent: false, reason: 'not_started' }
  const message = jobUpdateMessage(order.number, order.job)
  if (!message) return { sent: false, reason: 'not_started' }
  if (!order.conversationId) return { sent: false, reason: 'no_conversation' }

  const conversations = await scopedCollection<ConversationDoc>(ctx, 'conversations')
  const conversation = await conversations.findById(order.conversationId)
  if (!conversation) return { sent: false, reason: 'no_conversation' }
  const lastInbound = conversation.lastInboundAt ? new Date(conversation.lastInboundAt).getTime() : 0
  if (now.getTime() - lastInbound > SESSION_WINDOW_MS) return { sent: false, reason: 'window_closed' }

  const sent = await sendText(ctx, order.conversationId, message, 'system')
  return sent.status === 'failed' ? { sent: false, reason: 'send_failed' } : { sent: true }
}
