// Shape of the platform's AI setup, shared by the admin screen and the
// server. Pure: no imports that reach the network or the database.

/** One primary plus three fallbacks for the sales rep's chat model. */
export const CHAT_SLOTS = 4
/** One primary plus one fallback for transcribing voice notes. */
export const SPEECH_SLOTS = 2

export const CHAT_SLOT_LABELS = ['Primary', 'Fallback 1', 'Fallback 2', 'Fallback 3'] as const
export const SPEECH_SLOT_LABELS = ['Primary', 'Fallback'] as const

export type SlotKind = 'chat' | 'speech'

export const MODEL_PATTERN = /^[\w.:/@-]{1,120}$/
