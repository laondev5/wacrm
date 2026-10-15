import { NextResponse } from 'next/server'
import { generatePassword, hashPassword, MIN_PASSWORD_LENGTH } from '@/lib/auth/password'
import { requirePlatformAdmin } from '@/lib/auth/platform'
import { parseId } from '@/lib/db/ids'
import { getDb } from '@/lib/db/mongo'
import type { UserDoc } from '@/lib/db/types'
import { NotFoundError, readJson, toErrorResponse } from '@/lib/http/errors'
import { str } from '@/lib/http/validate'

type Params = { params: Promise<{ id: string }> }

/**
 * POST { password? } — issue the merchant owner a new password and sign
 * them out everywhere. There is no self-serve reset yet, so this is how
 * a locked-out merchant gets back in.
 */
export async function POST(request: Request, { params }: Params) {
  try {
    await requirePlatformAdmin()
    const id = parseId((await params).id)
    const body = await readJson(request)
    const typed = typeof body.password === 'string' && body.password.length > 0 ? body.password : null
    const password = typed
      ? str(typed, 'password', { min: MIN_PASSWORD_LENGTH, max: 200, trim: false })
      : generatePassword()

    const db = await getDb()
    const owner = await db.collection<UserDoc>('users').findOne({ accountId: id, role: 'owner' })
    if (!owner) throw new NotFoundError('This account has no owner')

    await db
      .collection<UserDoc>('users')
      .updateOne(
        { _id: owner._id },
        { $set: { passwordHash: await hashPassword(password), mustChangePassword: true, updatedAt: new Date() } },
      )
    await db.collection<{ userId: string }>('sessions').deleteMany({ userId: owner._id })
    return NextResponse.json({ ok: true, email: owner.email, temporaryPassword: typed ? null : password })
  } catch (err) {
    return toErrorResponse(err)
  }
}
