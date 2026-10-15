import { describe, expect, it } from 'vitest'
import { parseQuoteCommand } from './quote-parse'

describe('parseQuoteCommand', () => {
  it('reads a plain amount', () => {
    expect(parseQuoteCommand('quote 15000')).toEqual({ amountMinor: 1_500_000, description: null })
  })

  it('accepts a slash, a naira sign, commas and letter prefixes', () => {
    expect(parseQuoteCommand('/quote ₦15,000')?.amountMinor).toBe(1_500_000)
    expect(parseQuoteCommand('Quote N15000')?.amountMinor).toBe(1_500_000)
    expect(parseQuoteCommand('quote NGN 15000')?.amountMinor).toBe(1_500_000)
    expect(parseQuoteCommand('quote: 15,000')?.amountMinor).toBe(1_500_000)
  })

  it('reads k and m shorthand', () => {
    expect(parseQuoteCommand('quote 15k')?.amountMinor).toBe(1_500_000)
    expect(parseQuoteCommand('quote 1.5m')?.amountMinor).toBe(150_000_000)
  })

  it('keeps kobo', () => {
    expect(parseQuoteCommand('quote 15000.50')?.amountMinor).toBe(1_500_050)
  })

  it('keeps what was written after the amount as the description', () => {
    expect(parseQuoteCommand('quote 15000 for 10 A5 flyers (design + print)')).toEqual({
      amountMinor: 1_500_000,
      description: '10 A5 flyers (design + print)',
    })
    expect(parseQuoteCommand('quote 8k - banner')?.description).toBe('banner')
  })

  it('refuses anything that is not clearly a price', () => {
    expect(parseQuoteCommand('quote')).toBeNull()
    expect(parseQuoteCommand('quote soon')).toBeNull()
    expect(parseQuoteCommand('quote 0')).toBeNull()
    expect(parseQuoteCommand('quote -500')).toBeNull()
    expect(parseQuoteCommand('quote 15000abc')).toBeNull()
    expect(parseQuoteCommand('quote 1e9')).toBeNull()
    expect(parseQuoteCommand('quote 999999999999')).toBeNull()
    expect(parseQuoteCommand('quoted 15000')).toBeNull()
    expect(parseQuoteCommand('please quote 15000')).toBeNull()
  })
})
