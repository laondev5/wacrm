import { NextResponse } from 'next/server'
import { agentFlags } from '@/lib/ai/agents'
import { chatChain } from '@/lib/ai/platform-config'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { loadAccount } from '@/lib/auth/accounts'
import { getDb } from '@/lib/db/mongo'
import type { AccountDoc } from '@/lib/db/types'
import { NotFoundError, readJson, ValidationError } from '@/lib/http/errors'
import { bool, num, oneOf, str, strList } from '@/lib/http/validate'

function agentsSaved(account: { agents?: { secretary?: boolean; projectManager?: boolean } | null }) {
  return { secretary: !!account.agents?.secretary, projectManager: !!account.agents?.projectManager }
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const account = await loadAccount(ctx.accountId)
    if (!account) throw new NotFoundError('Account not found')
    // Whether the platform has an AI model set up. A merchant can't fix a
    // missing one, but the page should say so instead of pretending.
    const aiAvailable = (await chatChain()).length > 0
    return NextResponse.json({
      salesAgent: account.salesAgent,
      // What each switch is set to, and what is actually working (the
      // secretary and project manager only run in AI mode).
      agents: { salesRep: account.salesAgent.enabled, ...agentsSaved(account) },
      working: agentFlags(account),
      currency: account.currency,
      aiAvailable,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** PATCH — sales rep behaviour. Admin+. Money fields in major units. */
export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = await readJson(request)
    const set: Record<string, unknown> = {}
    if ('name' in body) set['salesAgent.name'] = str(body.name, 'name', { max: 40 })
    if ('enabled' in body) set['salesAgent.enabled'] = bool(body.enabled, 'enabled')
    // The secretary and project manager switches. (The sales rep's is
    // `enabled` above — it was there first.)
    if ('agents' in body) {
      const a = body.agents
      if (!a || typeof a !== 'object') throw new ValidationError('agents must be an object')
      const o = a as Record<string, unknown>
      if ('secretary' in o) set['agents.secretary'] = bool(o.secretary, 'agents.secretary')
      if ('projectManager' in o) set['agents.projectManager'] = bool(o.projectManager, 'agents.projectManager')
    }
    if ('mode' in body) set['salesAgent.mode'] = oneOf(body.mode, 'mode', ['ai', 'rules'] as const)
    if ('instructions' in body) set['salesAgent.instructions'] = str(body.instructions, 'instructions', { max: 4000 })
    if ('greeting' in body) set['salesAgent.greeting'] = str(body.greeting, 'greeting', { max: 500, optional: true })
    if ('priceListKeywords' in body) set['salesAgent.priceListKeywords'] = strList(body.priceListKeywords, 'priceListKeywords', 30, 40)
    if ('handoffKeywords' in body) set['salesAgent.handoffKeywords'] = strList(body.handoffKeywords, 'handoffKeywords', 30, 40)
    if ('paymentProvider' in body) {
      set['salesAgent.paymentProvider'] = oneOf(body.paymentProvider, 'paymentProvider', ['paystack', 'flutterwave', 'bank_transfer'] as const)
    }
    if ('autoSendPaymentLink' in body) set['salesAgent.autoSendPaymentLink'] = bool(body.autoSendPaymentLink, 'autoSendPaymentLink')
    if ('deliveryFee' in body) set['salesAgent.deliveryFee'] = Math.round(num(body.deliveryFee ?? 0, 'deliveryFee', { min: 0, max: 10_000_000 }) * 100)
    if ('approvalThreshold' in body) {
      set['salesAgent.approvalThreshold'] = Math.round(num(body.approvalThreshold ?? 0, 'approvalThreshold', { min: 0, max: 1_000_000_000 }) * 100)
    }
    if (Object.keys(set).length === 0) throw new ValidationError('Nothing to update')
    const db = await getDb()
    await db.collection<AccountDoc>('accounts').updateOne({ _id: ctx.accountId }, { $set: { ...set, updatedAt: new Date() } })
    const account = await loadAccount(ctx.accountId)
    return NextResponse.json({
      salesAgent: account?.salesAgent,
      agents: account ? { salesRep: account.salesAgent.enabled, ...agentsSaved(account) } : undefined,
      working: account ? agentFlags(account) : undefined,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
