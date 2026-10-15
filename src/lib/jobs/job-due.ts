import 'server-only'
import { agentFlags } from '@/lib/ai/agents'
import { loadAccount } from '@/lib/auth/accounts'
import { scopedCollection, type AuthContext } from '@/lib/db/scoped'
import type { OrderDoc } from '@/lib/db/types'
import { notifyJobDue, telegramTarget } from '@/lib/notify/telegram'
import { DUE_SOON_MS, dueText, JOB_STAGE_LABEL } from '@/lib/sales/job'

/**
 * Project manager: tell the owner, on Telegram, about jobs whose
 * deadline is within a day or already past. Once per deadline — the
 * reminder is claimed with a conditional update before it is sent, so
 * two overlapping workers can't both nudge, and moving the date later
 * (which clears the mark) earns a fresh reminder.
 *
 * Runs from the background worker, so it fires on the first request
 * after a deadline gets close rather than on a timer.
 */
export async function remindDueJobs(ctx: AuthContext): Promise<number> {
  const account = await loadAccount(ctx.accountId)
  if (!account || !agentFlags(account).projectManager) return 0
  // No point claiming a reminder there is nowhere to send.
  if (!(await telegramTarget(ctx))) return 0

  const now = Date.now()
  const orders = await scopedCollection<OrderDoc>(ctx, 'orders')
  const due = await orders
    .find({
      status: { $ne: 'cancelled' },
      'job.stage': { $nin: ['done'] },
      'job.dueAt': { $lte: new Date(now + DUE_SOON_MS) },
      'job.dueReminderSentAt': null,
    })
    .sort({ 'job.dueAt': 1 })
    .limit(10)
    .toArray()

  let sent = 0
  for (const order of due) {
    const claimed = await orders.findOneAndUpdate(
      { _id: order._id, 'job.dueReminderSentAt': null, 'job.stage': { $nin: ['done'] } },
      { $set: { 'job.dueReminderSentAt': new Date() } },
    )
    if (!claimed?.job?.dueAt) continue
    const who = order.customer.name ?? (order.customer.phone ? `+${order.customer.phone}` : 'A customer')
    await notifyJobDue(ctx, order.number, who, JOB_STAGE_LABEL[claimed.job.stage], dueText(claimed.job.dueAt, now))
    sent++
  }
  return sent
}
