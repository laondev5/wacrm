// ============================================================
// The AI agents a merchant can switch on.
//
// A business has ONE WhatsApp number and ONE persona the customer
// talks to; the agents are what that persona is allowed to do:
//
//   Sales rep        quotes prices from the catalogue, takes orders,
//                    sends payment links, invoices and receipts
//   Secretary        front desk — finds out what a customer needs,
//                    answers questions about the business, and passes
//                    the enquiry to the team
//   Project manager  tells customers how their jobs are going, and
//                    keeps the owner on top of deadlines
//
// Pure on purpose (no server or database imports): the switches in the
// UI, the prompt the model sees and the actions the server will accept
// are all derived from the same function here, so they cannot drift.
// ============================================================

export const AGENT_IDS = ['salesRep', 'secretary', 'projectManager'] as const
export type AgentId = (typeof AGENT_IDS)[number]

export interface AgentInfo {
  id: AgentId
  label: string
  tagline: string
  /** What switching it on gives the business, in the merchant's terms. */
  does: string[]
}

export const AGENTS: Record<AgentId, AgentInfo> = {
  salesRep: {
    id: 'salesRep',
    label: 'Sales rep',
    tagline: 'Sells for you',
    does: ['Quotes prices from your inventory', 'Takes orders and sends payment links', 'Sends invoices and receipts'],
  },
  secretary: {
    id: 'secretary',
    label: 'Secretary',
    tagline: 'Answers the front desk',
    does: [
      'Finds out what each customer needs, one question at a time',
      'Answers questions about your business from your knowledge base',
      'Saves the enquiry on the customer and alerts you on Telegram',
    ],
  },
  projectManager: {
    id: 'projectManager',
    label: 'Project manager',
    tagline: 'Keeps customers and deadlines on track',
    does: [
      'Tells customers how their job is going when they ask',
      'Messages them when you move a job to a new stage',
      'Reminds you on Telegram when a job is due or overdue',
    ],
  },
}

export type AgentFlags = Record<AgentId, boolean>

/** The slice of an account the switches are read from. */
export interface AgentSettingsLike {
  salesAgent: { enabled: boolean; mode: 'ai' | 'rules' }
  agents?: { secretary?: boolean; projectManager?: boolean } | null
}

/**
 * Which agents are actually working right now. The sales rep's own
 * switch is `salesAgent.enabled` (it predates the other two). The
 * secretary and project manager need a model that can hold a
 * conversation, so they only count while the account is in AI mode —
 * in keyword-rules mode they have nothing to run on.
 */
export function agentFlags(a: AgentSettingsLike): AgentFlags {
  const ai = a.salesAgent.mode === 'ai'
  return {
    salesRep: !!a.salesAgent.enabled,
    secretary: ai && !!a.agents?.secretary,
    projectManager: ai && !!a.agents?.projectManager,
  }
}

export const anyAgentOn = (f: AgentFlags): boolean => AGENT_IDS.some((id) => f[id])
export const enabledAgentIds = (f: AgentFlags): AgentId[] => AGENT_IDS.filter((id) => f[id])

// ---- what the model may ask the server to do ---------------------------------

export type IntentName =
  | 'chat'
  | 'handoff'
  | 'price_list'
  | 'place_order'
  | 'cancel_order'
  | 'send_photos'
  | 'log_enquiry'

export const ALL_INTENTS: IntentName[] = ['chat', 'handoff', 'price_list', 'place_order', 'cancel_order', 'send_photos', 'log_enquiry']

/** Everyone can talk, and everyone can hand over to a person. */
const ALWAYS: IntentName[] = ['chat', 'handoff']

const INTENTS_BY_AGENT: Record<AgentId, IntentName[]> = {
  salesRep: ['price_list', 'place_order', 'cancel_order', 'send_photos'],
  secretary: ['log_enquiry'],
  // The project manager answers from job data in the prompt; it needs no
  // action of its own — a change request is a handoff.
  projectManager: [],
}

/** The intents the server will act on for this set of agents. */
export function allowedIntents(f: AgentFlags): IntentName[] {
  const out = new Set<IntentName>(ALWAYS)
  for (const id of AGENT_IDS) if (f[id]) for (const i of INTENTS_BY_AGENT[id]) out.add(i)
  return ALL_INTENTS.filter((i) => out.has(i))
}
