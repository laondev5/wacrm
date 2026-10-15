import { NextResponse } from 'next/server'
import { createAccountWithOwner } from '@/lib/auth/accounts'
import { generatePassword, hashPassword, MIN_PASSWORD_LENGTH } from '@/lib/auth/password'
import { requirePlatformAdmin } from '@/lib/auth/platform'
import { getDb } from '@/lib/db/mongo'
import { listAccountSummaries } from '@/lib/db/platform'
import type { UserDoc } from '@/lib/db/types'
import { ConflictError, readJson, toErrorResponse } from '@/lib/http/errors'
import { email as emailV, optStr, str } from '@/lib/http/validate'

/** GET — every merchant on the platform, with health and usage. */
export async function GET() {
  try {
    await requirePlatformAdmin()
    return NextResponse.json({ accounts: await listAccountSummaries() })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST { businessName, ownerName?, email, password? } — create a merchant
 * and its owner login. Merchants don't sign themselves up; the operator
 * creates the account and hands over the credentials.
 *
 * With no password given one is generated and returned ONCE in the
 * response — it is stored only as a hash, so it can't be shown again
 * (use reset-password to issue a new one).
 */
export async function POST(request: Request) {
  try {
    await requirePlatformAdmin()
    const body = await readJson(request)
    const businessName = str(body.businessName, 'businessName', { max: 120 })
    const ownerName = optStr(body.ownerName, 'ownerName', 120)
    const email = emailV(body.email, 'email')
    const typed = typeof body.password === 'string' && body.password.length > 0 ? body.password : null
    const password = typed
      ? str(typed, 'password', { min: MIN_PASSWORD_LENGTH, max: 200, trim: false })
      : generatePassword()

    const db = await getDb()
    const existing = await db.collection<UserDoc>('users').findOne({ email }, { projection: { _id: 1 } })
    if (existing) throw new ConflictError('A user with this email already exists')

    const { user, account } = await createAccountWithOwner({
      email,
      passwordHash: await hashPassword(password),
      fullName: ownerName,
      businessName,
    })
    // createAccountWithOwner stamps a first login; nobody has signed in yet.
    // The password is known to the operator, typed or generated alike, so
    // the owner has to replace it with their own before using anything.
    await db
      .collection<UserDoc>('users')
      .updateOne({ _id: user._id }, { $set: { lastLoginAt: null, mustChangePassword: true } })

    return NextResponse.json(
      {
        account: { id: account._id, name: account.name },
        owner: { id: user._id, email: user.email, fullName: user.fullName },
        // Only when we made it up — a password the operator typed is already known to them.
        temporaryPassword: typed ? null : password,
      },
      { status: 201 },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}
