import { ALL_INTENTS, allowedIntents, type AgentFlags, type IntentName } from '@/lib/ai/agents'

// ============================================================
// What the model is allowed to ask for, and how its answer is read.
//
// The customer's text is untrusted and goes to the model, so the model
// only ever PROPOSES an intent; the server decides. Which intents are on
// the table depends on the agents the merchant has switched on, and an
// answer asking for one that is switched off is not honoured — see
// parseIntent.
// ============================================================

export interface Intent {
  reply: string
  intent: IntentName
  items: Array<{ product_id: string; quantity: number }>
  customer_name: string | null
  customer_email: string | null
  /** Secretary: the request to pass to the team. */
  enquiry: { summary: string; deadline: string | null } | null
}

/** Said instead of whatever the model wrote, when it asked for something this business hasn't switched on. */
export const NOT_AVAILABLE_REPLY =
  "Thanks — I've passed that to our team and they'll confirm it with you shortly. 🙏"

export function buildIntentSchema(flags: AgentFlags): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    reply: { type: 'string', description: 'Message to send the customer. Plain WhatsApp text.' },
    intent: { type: 'string', enum: allowedIntents(flags) },
    items: {
      type: 'array',
      // Only describe what this business has switched on — naming
      // place_order to a model that may not place orders invites it.
      description: flags.salesRep
        ? 'For place_order: the complete order. For send_photos: the products to show. Otherwise empty.'
        : 'Always an empty list.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['product_id', 'quantity'],
        properties: { product_id: { type: 'string' }, quantity: { type: 'integer' } },
      },
    },
    customer_name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    customer_email: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  }
  const required = ['reply', 'intent', 'items', 'customer_name', 'customer_email']
  if (flags.secretary) {
    properties.enquiry_summary = {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'For log_enquiry: one line saying what the customer wants. Otherwise null.',
    }
    properties.enquiry_deadline = {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'For log_enquiry: when they need it, in their words, or null if they did not say.',
    }
    required.push('enquiry_summary', 'enquiry_deadline')
  }
  return { type: 'object', additionalProperties: false, required, properties }
}

export function parseIntent(raw: unknown, catalogIds: Set<string>, allowed: IntentName[]): Intent | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const requested = ALL_INTENTS.includes(o.intent as IntentName) ? (o.intent as IntentName) : 'chat'
  let reply = typeof o.reply === 'string' ? o.reply.trim().slice(0, 1500) : ''
  let intent: IntentName = requested

  const items = Array.isArray(o.items)
    ? o.items
        .map((i) => i as Record<string, unknown>)
        .filter((i) => typeof i.product_id === 'string' && catalogIds.has(i.product_id))
        .map((i) => ({ product_id: i.product_id as string, quantity: Math.floor(Number(i.quantity)) }))
        .filter((i) => Number.isFinite(i.quantity) && i.quantity >= 1 && i.quantity <= 1000)
        .slice(0, 30)
    : []

  const summary = typeof o.enquiry_summary === 'string' ? o.enquiry_summary.trim().slice(0, 300) : ''
  const deadlineText = typeof o.enquiry_deadline === 'string' ? o.enquiry_deadline.trim().slice(0, 80) : ''
  let enquiry: Intent['enquiry'] = summary ? { summary, deadline: deadlineText || null } : null

  // The model asked for something this business has switched off (an
  // order from a secretary-only setup, say). Its reply was written for
  // the action it expected to take — "I've placed your order" — so it is
  // not sent either; a person picks it up.
  let finalItems = items
  if (!allowed.includes(intent)) {
    intent = 'handoff'
    reply = NOT_AVAILABLE_REPLY
    finalItems = []
    enquiry = null
  }
  // Logging an enquiry with nothing in it would only add a blank line.
  if (intent === 'log_enquiry' && !enquiry) intent = 'chat'
  if (intent !== 'log_enquiry') enquiry = null

  const name = typeof o.customer_name === 'string' ? o.customer_name.trim().slice(0, 80) : null
  const email =
    typeof o.customer_email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.customer_email.trim())
      ? o.customer_email.trim().toLowerCase().slice(0, 254)
      : null
  return { reply, intent, items: finalItems, customer_name: name || null, customer_email: email, enquiry }
}
