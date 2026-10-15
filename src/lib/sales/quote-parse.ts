// ============================================================
// "quote 15000" — the owner pricing an enquiry from Telegram.
//
// Pure so it can be tested to death: a mis-read amount becomes an
// invoice in front of a customer, so anything that isn't clearly a
// price is refused rather than guessed.
// ============================================================

export interface QuoteCommand {
  /** Minor units (kobo). */
  amountMinor: number
  /** What the owner wrote after the amount, if anything. */
  description: string | null
}

const MAX_MAJOR = 100_000_000

/**
 * Accepts: "quote 15000", "/quote ₦15,000", "quote N15000.50",
 * "quote 15k", "quote 1.5m", "quote 15000 for 10 A5 flyers".
 * Returns null for anything that isn't a quote command or has no
 * usable price.
 */
export function parseQuoteCommand(text: string): QuoteCommand | null {
  const m = /^\/?quote\b[:\s]*(?:₦|ngn\b|n(?=\d))?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(k|m)?(?![\w.])\s*(?:[-:]|for\b)?\s*([\s\S]*)$/i.exec(
    text.trim(),
  )
  if (!m) return null
  let major = Number(m[1].replace(/,/g, ''))
  if (!Number.isFinite(major)) return null
  const unit = m[2]?.toLowerCase()
  if (unit === 'k') major *= 1_000
  if (unit === 'm') major *= 1_000_000
  if (major <= 0 || major > MAX_MAJOR) return null
  const amountMinor = Math.round(major * 100)
  const description = m[3].trim().slice(0, 200)
  return { amountMinor, description: description || null }
}
