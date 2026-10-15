import 'server-only'
import { loadAccount } from '@/lib/auth/accounts'
import type { ChatTurn } from '@/lib/ai/client'
import { ChainFailedError, generateWithFallback, type ChatResult } from '@/lib/ai/chain'
import { chatChain, type ChainEntry } from '@/lib/ai/platform-config'
import { agentFlags, allowedIntents, anyAgentOn, type AgentFlags } from '@/lib/ai/agents'
import { scopedCollection, type AuthContext } from '@/lib/db/scoped'
import type {
  AccountDoc,
  AIRunDoc,
  ContactDoc,
  ConversationDoc,
  KnowledgeDoc,
  MessageDoc,
  OrderDoc,
  ProductDoc,
} from '@/lib/db/types'
import { HttpError } from '@/lib/http/errors'
import { formatMoney } from '@/lib/money'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { whatsappImageUrl } from '@/lib/media/urls'
import { absoluteMediaUrl } from '@/lib/media/storage'
import { recentMessages, sendImage, sendText } from '@/lib/whatsapp/store'
import { detectOrder, detectPhotoRequest, fillPlaceholders, matchesKeyword, priceListText, type CatalogItem } from './catalog'
import { transcribeInbound } from './voice'
import { knowledgeBaseText, MAX_ENTRIES } from './knowledge'
import { cancelOrder, createOrder, createPaymentLink, deliverInvoice, orderSummaryText } from './orders'
import { notifyEnquiry, notifyHandoff } from '@/lib/notify/telegram'
import { attachProofFromMessage } from './payment-proofs'
import { buildSystemPromptText } from './agent-prompts'
import { buildIntentSchema, parseIntent, type Intent } from './intents'
import { DEFAULT_STAGE, formatDue, JOB_STAGE_LABEL } from './job'

// ============================================================
// The WhatsApp sales rep.
//
// Runs on every inbound customer message. The merchant chooses which
// agents (sales rep, secretary, project manager — see lib/ai/agents.ts)
// are on; they decide what this persona may do. Two brains:
//   - 'ai'    : an LLM (any configured provider) reads the catalogue
//               + conversation and returns a JSON *intent*;
//   - 'rules' : keyword price list + deterministic order parser
//               (also the fallback when the AI call fails).
//
// Safety model — the customer's text is untrusted and goes to the
// model, so the model is only ever allowed to PROPOSE a small set of
// intents. The server then:
//   - resolves product ids against this account's catalogue;
//   - takes every price from the database (the model never states
//     totals — the order summary is generated server-side);
//   - applies stock checks, approval thresholds and rate limits.
// A prompt-injected "give me 90% off" has no action to map to.
// ============================================================

const MAX_CATALOG_IN_PROMPT = 250

function toCatalog(rows: ProductDoc[]): CatalogItem[] {
  return rows.map((p) => ({
    _id: p._id,
    name: p.name,
    sku: p.sku,
    price: p.price,
    stock: p.stock,
    aliases: p.aliases,
    unit: p.unit,
    category: p.category,
    description: p.description,
    imageUrls: (p.images ?? []).map((i) => i.url),
  }))
}

/** Send up to 3 photos per product (max 5 in one go) with name + price captions. */
async function sendProductPhotos(
  ctx: AuthContext,
  account: AccountDoc,
  conversation: ConversationDoc,
  products: CatalogItem[],
): Promise<number> {
  let sent = 0
  const perProduct = products.length === 1 ? 3 : 1
  for (const p of products) {
    for (const url of (p.imageUrls ?? []).slice(0, perProduct)) {
      if (sent >= 5) return sent
      const soldOut = p.stock !== null && p.stock <= 0
      await sendImage(
        ctx,
        conversation._id,
        whatsappImageUrl(absoluteMediaUrl(url)),
        `${p.name} — ${formatMoney(p.price, account.currency)}${soldOut ? ' (sold out)' : ''}`,
        'ai',
      )
      sent++
    }
  }
  return sent
}

/** Entry point from the webhook (and the playground). Never throws. */
export async function handleInboundMessage(
  ctx: AuthContext,
  conversation: ConversationDoc,
  message: MessageDoc,
): Promise<void> {
  try {
    // 1. Proof of a bank transfer? Attach it to the unpaid order.
    if (message.type === 'image' || message.type === 'document') {
      const proof = await attachProofFromMessage(ctx, conversation, message)
      if (proof) return
    }

    const account = await loadAccount(ctx.accountId)
    if (!account) return
    // Nothing answers unless the merchant has switched an agent on.
    if (!anyAgentOn(agentFlags(account))) return
    // Suspended by the platform: take no further action on their behalf.
    if (account.suspendedAt) return

    // 2. A voice note is a message like any other once it's words.
    if (!message.text && (message.type === 'audio' || message.type === 'video')) {
      message = (await transcribeInbound(ctx, conversation, message)) ?? message
    }
    if (!message.text) return

    // 3. Serialise per conversation: two quick messages → one run that
    //    sees both (the second sets aiPending; the holder re-runs).
    const conversations = await scopedCollection<ConversationDoc>(ctx, 'conversations')
    const now = new Date()
    const locked = await conversations.findOneAndUpdate(
      { _id: conversation._id, $or: [{ aiLockUntil: null }, { aiLockUntil: { $exists: false } }, { aiLockUntil: { $lt: now } }] },
      { $set: { aiLockUntil: new Date(now.getTime() + 150_000), aiPending: false } },
    )
    if (!locked) {
      await conversations.updateById(conversation._id, { $set: { aiPending: true } })
      return
    }
    try {
      for (let pass = 0; pass < 2; pass++) {
        const fresh = await conversations.findById(conversation._id)
        if (!fresh || fresh.aiPaused) return
        await respond(ctx, account, fresh)
        const after = await conversations.findOneAndUpdate(
          { _id: conversation._id, aiPending: true },
          { $set: { aiPending: false } },
        )
        if (!after) break
      }
    } finally {
      await conversations.updateById(conversation._id, { $set: { aiLockUntil: null } })
    }
  } catch (err) {
    console.error('[sales-agent] failed:', err)
  }
}

async function respond(ctx: AuthContext, account: AccountDoc, conversation: ConversationDoc): Promise<void> {
  const settings = account.salesAgent
  const history = await recentMessages(ctx, conversation._id, 16)
  const last = [...history].reverse().find((m) => m.direction === 'inbound')
  const text = last?.text?.trim()
  if (!text) return

  // Handoff keywords always win, AI or not.
  if (matchesKeyword(text, settings.handoffKeywords)) {
    await pauseAI(ctx, conversation, 'Customer asked for a person')
    await sendText(ctx, conversation._id, 'No problem — a member of our team will reply you shortly. 🙏', 'ai')
    return
  }

  const limit = checkRateLimit(`ai:${conversation._id}`, RATE_LIMITS.aiReply)
  if (!limit.success) {
    await pauseAI(ctx, conversation, 'Too many messages in a short time — possible bot loop')
    return
  }

  const products = await scopedCollection<ProductDoc>(ctx, 'products')
  const catalog = toCatalog(
    await products.find({ isActive: true }).sort({ name: 1 }).limit(MAX_CATALOG_IN_PROMPT).toArray(),
  )

  const flags = agentFlags(account)
  if (settings.mode === 'ai') {
    // One AI powers every merchant; the operator configures it once, with
    // fallbacks. A merchant only chooses AI or rules.
    const chain = await chatChain()
    if (chain.length > 0) {
      const ok = await respondWithAI(ctx, account, conversation, history, catalog, chain, flags)
      if (ok) return
      // every model failed
    }
  }
  if (flags.salesRep) {
    await respondWithRules(ctx, account, conversation, history, text, catalog)
    return
  }
  // The keyword rules only know how to sell. Without the sales rep, the
  // honest fallback is a person — not silence, and not a price list the
  // merchant has chosen not to offer.
  await pauseAI(ctx, conversation, 'The AI was unavailable and no sales rep is on to fall back to')
  await sendText(ctx, conversation._id, 'Thanks for your message — a member of our team will reply shortly. 🙏', 'ai')
}

// ------------------------------------------------------------
// Rules engine
// ------------------------------------------------------------

async function respondWithRules(
  ctx: AuthContext,
  account: AccountDoc,
  conversation: ConversationDoc,
  history: MessageDoc[],
  text: string,
  catalog: CatalogItem[],
): Promise<void> {
  const settings = account.salesAgent
  // Photo requests first: "send me a picture of the lace" must not be
  // read as an order for one lace.
  const wanted = detectPhotoRequest(text, catalog)
  if (wanted.length > 0) {
    const sent = await sendProductPhotos(ctx, account, conversation, wanted)
    if (sent === 0) {
      await sendText(ctx, conversation._id, `Sorry, I don't have a photo of ${wanted[0].name} yet — a team member can send one.`, 'ai')
    }
    return
  }
  const lines = detectOrder(text, catalog)
  if (lines.length > 0) {
    await placeOrder(ctx, account, conversation, lines.map((l) => ({ productId: l.product._id, quantity: l.quantity })), 'rules', null)
    return
  }
  if (matchesKeyword(text, settings.priceListKeywords)) {
    await sendText(ctx, conversation._id, priceListText(account.business.displayName, catalog, account.currency), 'ai')
    return
  }
  const isFirstContact = history.filter((m) => m.direction === 'inbound').length <= 1
  if (isFirstContact && settings.greeting) {
    await sendText(
      ctx,
      conversation._id,
      `${fillPlaceholders(settings.greeting, { name: settings.name, business: account.business.displayName })}\n\nReply *price list* to see what we sell, or tell me what you'd like to order.`,
      'ai',
    )
  }
  // Otherwise stay quiet — a human will pick it up from the inbox.
}

// ------------------------------------------------------------
// AI engine
// ------------------------------------------------------------

interface PromptData {
  account: AccountDoc
  flags: AgentFlags
  catalog: CatalogItem[]
  openOrder: OrderDoc | null
  knowledge: string | null
  jobLines: string[]
}

function buildSystemPrompt(d: PromptData): string {
  const { account, catalog } = d
  const m = (v: number) => formatMoney(v, account.currency)
  const catalogueLines = catalog.map((p) => {
    const stock = p.stock === null ? 'in stock' : p.stock > 0 ? `${p.stock} left` : 'SOLD OUT'
    const extra = [p.aliases.length ? `aka ${p.aliases.join('/')}` : '', p.description ? p.description.slice(0, 120) : '']
      .filter(Boolean)
      .join(' — ')
    const photos = p.imageUrls?.length ? ' | has photos' : ''
    return `${p._id} | ${p.name} | ${m(p.price)}${p.unit !== 'pcs' ? `/${p.unit}` : ''} | ${stock}${photos}${extra ? ` | ${extra}` : ''}`
  })
  return buildSystemPromptText({
    agentName: account.salesAgent.name,
    businessName: account.business.displayName,
    instructions: fillPlaceholders(account.salesAgent.instructions, {
      name: account.salesAgent.name,
      business: account.business.displayName,
    }),
    flags: d.flags,
    catalogueLines,
    knowledge: d.knowledge,
    openOrderText: d.openOrder
      ? `The customer has an UNPAID order ${d.openOrder.number}:
${orderSummaryText(d.openOrder)}`
      : null,
    jobLines: d.jobLines,
  })
}

/** The customer's paid jobs, one line each, for the project manager. */
async function jobLinesFor(ctx: AuthContext, account: AccountDoc, contactId: string): Promise<string[]> {
  const orders = await scopedCollection<OrderDoc>(ctx, 'orders')
  const rows = await orders
    .find({ contactId, status: { $in: ['paid', 'fulfilled'] } })
    .sort({ createdAt: -1 })
    .limit(5)
    .toArray()
  return rows.map((o) => {
    const job = o.job
    const stage = JOB_STAGE_LABEL[job?.stage ?? DEFAULT_STAGE]
    const what = o.items.slice(0, 3).map((i) => `${i.quantity}× ${i.name}`).join(', ')
    const due = job?.dueAt ? ` — due ${formatDue(job.dueAt)}` : ''
    const note = job?.note ? ` — note: ${job.note.slice(0, 200)}` : ''
    return `- ${o.number}: ${what} — ${stage}${due}${note}${o.status === 'fulfilled' ? ' — delivered' : ''}`
  })
}

function historyToTurns(history: MessageDoc[]): ChatTurn[] {
  const turns: ChatTurn[] = []
  for (const msg of history) {
    const content =
      msg.text?.slice(0, 1500) || (msg.type === 'document' ? `[${msg.media?.filename ?? 'document'}]` : `[${msg.type}]`)
    const role: ChatTurn['role'] = msg.direction === 'inbound' ? 'user' : 'assistant'
    const prev = turns[turns.length - 1]
    if (prev && prev.role === role) prev.content += `\n${content}`
    else turns.push({ role, content })
  }
  while (turns.length && turns[0].role !== 'user') turns.shift()
  return turns
}

async function respondWithAI(
  ctx: AuthContext,
  account: AccountDoc,
  conversation: ConversationDoc,
  history: MessageDoc[],
  catalog: CatalogItem[],
  chain: ChainEntry[],
  flags: AgentFlags,
): Promise<boolean> {
  const started = Date.now()
  const runs = await scopedCollection<AIRunDoc>(ctx, 'ai_runs')
  const orders = await scopedCollection<OrderDoc>(ctx, 'orders')
  const openOrder = flags.salesRep
    ? await orders.findOne({ contactId: conversation.contactId, status: 'awaiting_payment' }, { sort: { createdAt: -1 } })
    : null
  const turns = historyToTurns(history)
  if (turns.length === 0) return true

  let intent: Intent | null = null
  let result: ChatResult | null = null
  try {
    const entries = await scopedCollection<KnowledgeDoc>(ctx, 'knowledge_entries')
    const knowledge = knowledgeBaseText(
      account.knowledgeAbout,
      await entries.find({ isActive: true }).sort({ createdAt: 1 }).limit(MAX_ENTRIES).toArray(),
    )
    const catalogIds = new Set(catalog.map((c) => c._id))
    const allowed = allowedIntents(flags)
    const jobLines = flags.projectManager ? await jobLinesFor(ctx, account, conversation.contactId) : []
    result = await generateWithFallback(
      chain,
      {
        system: buildSystemPrompt({ account, flags, catalog, openOrder, knowledge, jobLines }),
        messages: turns,
        schema: buildIntentSchema(flags),
      },
      // A "chat" turn with no words in it would send the customer nothing;
      // count that as this model failing, so the next one gets a turn.
      (value) => {
        const parsed = parseIntent(value, catalogIds, allowed)
        return !!parsed && (parsed.intent !== 'chat' || parsed.reply.trim().length > 0)
      },
    )
    intent = parseIntent(result.value, catalogIds, allowed)
  } catch (err) {
    const failed = err instanceof ChainFailedError ? err : null
    // Open models sometimes answer the customer perfectly but forget the
    // JSON wrapper. If every model failed but one of them wrote a proper
    // sentence, sending that beats leaving the chat on read — which is
    // what reads to a customer as the rep having fallen asleep.
    if (failed?.salvage) {
      await sendText(ctx, conversation._id, failed.salvage, 'ai')
      await runs.insertOne({
        conversationId: conversation._id,
        providerId: failed.attempts[0]?.id ?? 'platform',
        model: failed.attempts[0]?.model ?? 'unknown',
        ok: true,
        latencyMs: Date.now() - started,
        actions: ['chat', 'recovered:no-json'],
        error: null,
        attempts: failed.attempts,
      })
      return true
    }
    const last = failed?.attempts[failed.attempts.length - 1]
    await runs.insertOne({
      conversationId: conversation._id,
      providerId: last?.id ?? chain[0]?.id ?? 'platform',
      model: last?.model ?? chain[0]?.model ?? 'unknown',
      ok: false,
      latencyMs: Date.now() - started,
      actions: [],
      error: failed ? failed.message : 'AI call failed',
      errorKind: failed ? failed.kind : 'other',
      attempts: failed?.attempts ?? [],
    })
    return false
  }
  if (!intent) return false

  const actions: string[] = [intent.intent]
  if (intent.customer_name || intent.customer_email) {
    const contacts = await scopedCollection<ContactDoc>(ctx, 'contacts')
    const contact = await contacts.findById(conversation.contactId)
    if (contact) {
      const set: Partial<ContactDoc> = {}
      if (intent.customer_name && !contact.name) set.name = intent.customer_name
      if (intent.customer_email && !contact.email) set.email = intent.customer_email
      if (Object.keys(set).length) await contacts.updateById(contact._id, { $set: set })
    }
  }

  switch (intent.intent) {
    case 'handoff':
      await pauseAI(ctx, conversation, 'AI handed off to a person')
      await sendText(ctx, conversation._id, intent.reply || 'Let me get a team member to help you with this.', 'ai')
      break
    case 'price_list':
      await sendText(
        ctx,
        conversation._id,
        [intent.reply, priceListText(account.business.displayName, catalog, account.currency)].filter(Boolean).join('\n\n'),
        'ai',
      )
      break
    case 'send_photos': {
      if (intent.reply) await sendText(ctx, conversation._id, intent.reply, 'ai')
      const ids = new Set(intent.items.map((i) => i.product_id))
      const wanted = catalog.filter((c) => ids.has(c._id)).slice(0, 3)
      const sent = await sendProductPhotos(ctx, account, conversation, wanted)
      actions.push(`photos:${sent}`)
      break
    }
    case 'log_enquiry':
      if (intent.reply) await sendText(ctx, conversation._id, intent.reply, 'ai')
      if (intent.enquiry) actions.push(await logEnquiry(ctx, conversation, intent.enquiry))
      break
    case 'cancel_order':
      if (openOrder) {
        await cancelOrder(ctx, openOrder._id).catch(() => {})
        actions.push(`cancelled:${openOrder.number}`)
      }
      if (intent.reply) await sendText(ctx, conversation._id, intent.reply, 'ai')
      break
    case 'place_order':
      if (intent.items.length === 0) {
        if (intent.reply) await sendText(ctx, conversation._id, intent.reply, 'ai')
        break
      }
      if (intent.reply) await sendText(ctx, conversation._id, intent.reply, 'ai')
      if (openOrder) {
        await cancelOrder(ctx, openOrder._id).catch(() => {})
        actions.push(`replaced:${openOrder.number}`)
      }
      actions.push(
        await placeOrder(
          ctx,
          account,
          conversation,
          intent.items.map((i) => ({ productId: i.product_id, quantity: i.quantity })),
          'ai',
          null,
        ),
      )
      break
    default:
      if (intent.reply) await sendText(ctx, conversation._id, intent.reply, 'ai')
  }

  await runs.insertOne({
    conversationId: conversation._id,
    providerId: result.entry.id,
    model: result.entry.model,
    ok: true,
    latencyMs: Date.now() - started,
    actions,
    error: null,
    tokens: result.usage,
    attempts: result.attempts,
  })
  return true
}

// ------------------------------------------------------------
// Shared
// ------------------------------------------------------------

async function placeOrder(
  ctx: AuthContext,
  account: AccountDoc,
  conversation: ConversationDoc,
  lines: Array<{ productId: string; quantity: number }>,
  source: 'ai' | 'rules',
  notes: string | null,
): Promise<string> {
  const settings = account.salesAgent
  let order: OrderDoc
  try {
    order = await createOrder(ctx, {
      lines,
      contactId: conversation.contactId,
      conversationId: conversation._id,
      source,
      notes,
      deliveryFee: settings.deliveryFee,
      status: 'draft',
    })
  } catch (err) {
    const msg = err instanceof HttpError ? err.message : 'We could not create that order.'
    await sendText(ctx, conversation._id, `Sorry — ${msg}. Would you like something else?`, 'ai')
    return 'order_failed'
  }

  // Large orders wait for a human before the customer is asked to pay.
  if (settings.approvalThreshold > 0 && order.total > settings.approvalThreshold) {
    await sendText(
      ctx,
      conversation._id,
      `${orderSummaryText(order)}\n\nThank you! A team member will confirm availability and send payment details shortly.`,
      'ai',
    )
    return `draft:${order.number}`
  }

  const orders = await scopedCollection<OrderDoc>(ctx, 'orders')
  await orders.updateById(order._id, { $set: { status: 'awaiting_payment' } })
  order = { ...order, status: 'awaiting_payment' }

  if (settings.autoSendPaymentLink && (settings.paymentProvider === 'paystack' || settings.paymentProvider === 'flutterwave')) {
    try {
      order = await createPaymentLink(ctx, order._id, settings.paymentProvider)
    } catch (err) {
      console.warn('[sales-agent] payment link failed, falling back to bank details:', (err as Error).message)
    }
  } else {
    await orders.updateById(order._id, { $set: { 'payment.provider': 'bank_transfer', 'payment.status': 'pending' } })
  }
  await deliverInvoice(ctx, order, 'ai')
  return `order:${order.number}`
}

/**
 * Secretary: keep what the customer asked for on the customer itself —
 * a dated line in their notes plus an "enquiry" tag — and tell the owner.
 * The same request is never written twice, however many times the model
 * decides to log it.
 */
async function logEnquiry(
  ctx: AuthContext,
  conversation: ConversationDoc,
  enquiry: { summary: string; deadline: string | null },
): Promise<string> {
  const contacts = await scopedCollection<ContactDoc>(ctx, 'contacts')
  const contact = await contacts.findById(conversation.contactId)
  if (!contact) return 'enquiry:no-contact'
  const prior = contact.notes ?? ''
  if (prior.toLowerCase().includes(enquiry.summary.toLowerCase())) return 'enquiry:duplicate'

  const line = `${formatDue(new Date())} — Enquiry: ${enquiry.summary}${enquiry.deadline ? ` (needed: ${enquiry.deadline})` : ''}`
  // Notes are capped at 2000 characters in the app; keep the newest lines.
  let notes = [prior, line].filter(Boolean).join('\n')
  while (notes.length > 1900 && notes.includes('\n')) notes = notes.slice(notes.indexOf('\n') + 1)
  const tags = contact.tags.includes('enquiry') || contact.tags.length >= 20 ? contact.tags : [...contact.tags, 'enquiry']
  await contacts.updateById(contact._id, { $set: { notes: notes.slice(0, 1900), tags } })

  void notifyEnquiry(ctx, contact.name ?? `+${contact.phone}`, enquiry.summary, enquiry.deadline)
  return 'enquiry:logged'
}

async function pauseAI(ctx: AuthContext, conversation: ConversationDoc, reason: string): Promise<void> {
  const conversations = await scopedCollection<ConversationDoc>(ctx, 'conversations')
  await conversations.updateById(conversation._id, { $set: { aiPaused: true, aiPausedReason: reason } })
  const contacts = await scopedCollection<ContactDoc>(ctx, 'contacts')
  const contact = await contacts.findById(conversation.contactId)
  void notifyHandoff(ctx, contact?.name ?? (contact ? `+${contact.phone}` : 'A customer'), reason)
}
