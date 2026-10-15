// ============================================================
// Try a list of models in order until one answers.
//
// Pure on purpose — no network, no database — so the rules that decide
// whether a customer gets a reply can be unit-tested exactly:
//
//  - a model that just ran out of credit (quota) or was rejected
//    (auth / retired model) is tried LAST for a while, not first, so a
//    dead primary doesn't cost every customer its timeout;
//  - if every model is cooling down we still try them all, in order —
//    a stale cooldown must never be the reason nobody answers;
//  - each attempt gets its own deadline, and the deadlines add up to
//    less than the per-conversation lock, so two replies never race;
//  - but a short deadline only makes sense while there is someone to
//    hand over to. The LAST model in line gets the long one, otherwise a
//    slow-but-working single model would be cut off for nothing.
// ============================================================

export type ErrorKind = 'quota' | 'auth' | 'model' | 'timeout' | 'other'

export interface ChainHealth {
  ok: boolean
  cooldownUntil: Date | null
}

export interface ChainMember {
  id: string
  model: string
  health?: ChainHealth | null
}

export interface Attempt {
  id: string
  model: string
  ok: boolean
  kind: ErrorKind | null
  error: string | null
  ms: number
}

/** How long a model sits at the back of the queue after each kind of failure. */
export const COOLDOWN_MS: Record<ErrorKind, number> = {
  quota: 5 * 60_000,
  auth: 15 * 60_000,
  model: 15 * 60_000,
  timeout: 60_000,
  other: 0,
}

/** Most actionable first — the merchant alert and the admin banner use this. */
const SEVERITY: ErrorKind[] = ['quota', 'auth', 'model', 'timeout', 'other']

export function worstKind(kinds: Array<ErrorKind | null>): ErrorKind {
  for (const k of SEVERITY) if (kinds.includes(k)) return k
  return 'other'
}

export class ChainFailedError extends Error {
  constructor(
    readonly attempts: Attempt[],
    readonly kind: ErrorKind,
    /** A usable reply the model wrote without the JSON wrapper, if any did. */
    readonly salvage: string | null,
  ) {
    super(
      attempts.length === 0
        ? 'No AI model is configured'
        : `All ${attempts.length} AI model${attempts.length === 1 ? '' : 's'} failed — ${attempts[attempts.length - 1].error ?? 'unknown error'}`,
    )
    this.name = 'ChainFailedError'
  }
}

/** Healthy members first, then the ones cooling down; order kept within each. */
export function orderForAttempt<T extends ChainMember>(members: T[], now: number): T[] {
  const cooling = (m: T) =>
    !!m.health && !m.health.ok && !!m.health.cooldownUntil && m.health.cooldownUntil.getTime() > now
  return [...members.filter((m) => !cooling(m)), ...members.filter(cooling)]
}

export interface ChainOptions<T extends ChainMember> {
  /** Deadline for the 1st, 2nd… attempt in ms. The last value repeats. */
  timeouts: number[]
  /** Deadline for the final model in line — nothing follows it, so be patient. */
  finalTimeoutMs?: number
  /** Turn whatever a call threw into something the chain understands. */
  classify: (err: unknown) => { kind: ErrorKind; message: string; salvage?: string | null }
  /** Called after every attempt, for health bookkeeping. Must not throw. */
  onOutcome?: (member: T, outcome: { ok: boolean; kind: ErrorKind | null; message: string | null; cooldownMs: number }) => void | Promise<void>
  now?: () => number
}

export async function runChain<T extends ChainMember, R>(
  members: T[],
  call: (member: T, timeoutMs: number) => Promise<R>,
  opts: ChainOptions<T>,
): Promise<{ value: R; member: T; attempts: Attempt[] }> {
  const now = opts.now ?? Date.now
  const attempts: Attempt[] = []
  let salvage: string | null = null

  const ordered = orderForAttempt(members, now())
  for (let i = 0; i < ordered.length; i++) {
    const member = ordered[i]
    const base = opts.timeouts[Math.min(i, opts.timeouts.length - 1)] ?? 30_000
    const isLast = i === ordered.length - 1
    const timeoutMs = isLast && opts.finalTimeoutMs ? Math.max(base, opts.finalTimeoutMs) : base
    const started = now()
    try {
      const value = await call(member, timeoutMs)
      attempts.push({ id: member.id, model: member.model, ok: true, kind: null, error: null, ms: now() - started })
      await opts.onOutcome?.(member, { ok: true, kind: null, message: null, cooldownMs: 0 })
      return { value, member, attempts }
    } catch (err) {
      const c = opts.classify(err)
      if (c.salvage && !salvage) salvage = c.salvage
      attempts.push({ id: member.id, model: member.model, ok: false, kind: c.kind, error: c.message, ms: now() - started })
      await opts.onOutcome?.(member, { ok: false, kind: c.kind, message: c.message, cooldownMs: COOLDOWN_MS[c.kind] })
    }
  }
  throw new ChainFailedError(attempts, worstKind(attempts.map((a) => a.kind)), salvage)
}
