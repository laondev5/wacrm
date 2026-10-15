// ============================================================
// Job progress — what the project manager tracks and talks about.
//
// An order is a sale; a job is the work that follows it. The merchant
// moves the job through a few plain stages, and the project manager
// turns that into customer updates and deadline reminders. Pure, so the
// wording and the date rules can be tested exactly.
// ============================================================

export const JOB_STAGES = ['queued', 'in_progress', 'awaiting_customer', 'ready', 'done'] as const
export type JobStage = (typeof JOB_STAGES)[number]

export const JOB_STAGE_LABEL: Record<JobStage, string> = {
  queued: 'Not started',
  in_progress: 'In progress',
  awaiting_customer: 'Waiting on customer',
  ready: 'Ready',
  done: 'Done',
}

export function isJobStage(v: unknown): v is JobStage {
  return typeof v === 'string' && (JOB_STAGES as readonly string[]).includes(v)
}

/** A job nobody has touched yet. */
export const DEFAULT_STAGE: JobStage = 'queued'

const LAGOS = 'Africa/Lagos'

/** "Fri 17 Oct", in Lagos time, whatever the server's own zone is. */
export function formatDue(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: LAGOS }).formatToParts(date)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('weekday')} ${get('day')} ${get('month')}`
}

/**
 * A date picked in the app ("2026-10-17") means the END of that day in
 * Lagos — "due Friday" is not overdue on Friday morning. Lagos is UTC+1
 * all year, so a fixed offset is exact.
 */
export function dueFromDateInput(ymd: unknown): Date | null {
  if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null
  const d = new Date(`${ymd}T23:59:00+01:00`)
  return Number.isNaN(d.getTime()) ? null : d
}

/** The inverse, for filling the date box. */
export function dateInputFrom(date: Date | string | null | undefined): string {
  if (!date) return ''
  const d = new Date(date)
  if (Number.isNaN(d.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: LAGOS }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}`
}

export interface JobLike {
  stage: JobStage
  dueAt: Date | null
  note: string | null
}

/**
 * What a customer is told when a job reaches a stage — fixed wording,
 * not model output: a status message is a promise, so it only ever says
 * what the merchant recorded. Null when there is nothing worth sending.
 */
export function jobUpdateMessage(orderNumber: string, job: JobLike): string | null {
  const note = job.note?.trim().slice(0, 300) || ''
  switch (job.stage) {
    case 'queued':
      return null
    case 'in_progress':
      return `Good news — we've started work on ${orderNumber}.${job.dueAt ? ` We expect to have it ready by ${formatDue(job.dueAt)}.` : ''}${note ? ` ${note}` : ''}`
    case 'awaiting_customer':
      return `Quick update on ${orderNumber}: we're waiting to hear from you before we can continue.${note ? ` ${note}` : ''}`
    case 'ready':
      return `${orderNumber} is ready! 🎉${note ? ` ${note}` : ''}`
    case 'done':
      return `${orderNumber} is complete. Thank you for choosing us — we hope to serve you again soon! 🙏`
  }
}

/** How close a deadline has to be before the owner is reminded. */
export const DUE_SOON_MS = 24 * 60 * 60_000

export function isDueSoon(job: Pick<JobLike, 'stage' | 'dueAt'>, now: number): boolean {
  if (job.stage === 'done' || !job.dueAt) return false
  return job.dueAt.getTime() - now <= DUE_SOON_MS
}

export function dueText(dueAt: Date, now: number): string {
  const ms = dueAt.getTime() - now
  if (ms < 0) return `overdue since ${formatDue(dueAt)}`
  return `due ${formatDue(dueAt)}`
}
