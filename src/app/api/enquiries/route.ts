import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { scopedCollection } from '@/lib/db/scoped'
import type { ContactDoc, EnquiryDoc } from '@/lib/db/types'

/** GET — requests waiting for the owner's price, oldest first. Any member. */
export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const enquiries = await scopedCollection<EnquiryDoc>(ctx, 'enquiries')
    const rows = await enquiries.find({ status: 'open' }).sort({ createdAt: 1 }).limit(50).toArray()
    const contacts = await scopedCollection<ContactDoc>(ctx, 'contacts')
    const out = []
    for (const e of rows) {
      const c = await contacts.findById(e.contactId)
      out.push({
        id: e._id,
        summary: e.summary,
        deadline: e.deadline,
        createdAt: e.createdAt,
        customer: { name: c?.name ?? null, phone: c?.phone ?? null },
      })
    }
    return NextResponse.json({ enquiries: out })
  } catch (err) {
    return toErrorResponse(err)
  }
}
