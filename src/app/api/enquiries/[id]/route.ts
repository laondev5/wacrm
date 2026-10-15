import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { parseId } from '@/lib/db/ids'
import { readJson, ValidationError } from '@/lib/http/errors'
import { num, optStr } from '@/lib/http/validate'
import { dismissEnquiry, quoteEnquiry } from '@/lib/sales/quotes'

/**
 * POST — { action: 'quote', amount (major units), description? } prices the
 * enquiry, creates the invoice and sends it to the customer on WhatsApp.
 * { action: 'dismiss' } closes it without a quote. Agent+.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent')
    const id = parseId((await params).id, 'id')
    const body = await readJson(request)
    switch (body.action) {
      case 'quote': {
        const amount = num(body.amount, 'amount', { min: 1, max: 100_000_000 })
        const result = await quoteEnquiry(ctx, id, {
          amountMinor: Math.round(amount * 100),
          description: optStr(body.description, 'description', 200),
        })
        return NextResponse.json(result, { status: 201 })
      }
      case 'dismiss':
        await dismissEnquiry(ctx, id)
        return NextResponse.json({ ok: true })
      default:
        throw new ValidationError('Unknown action')
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
