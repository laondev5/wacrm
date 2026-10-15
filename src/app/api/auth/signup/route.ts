import { NextResponse } from 'next/server'
import { hashPassword, MIN_PASSWORD_LENGTH } from '@/lib/auth/password'
import { createSession } from '@/lib/auth/session'
import { createAccountWithOwner } from '@/lib/auth/accounts'
import { getDb } from '@/lib/db/mongo'
import type { UserDoc } from '@/lib/db/types'
import { hashInviteToken } from '@/lib/auth/invitations'
import { peekInvitation } from '@/lib/auth/team'
import { ConflictError, ForbiddenError, readJson, toErrorResponse } from '@/lib/http/errors'
import { email as emailV, optStr, str } from '@/lib/http/validate'
import { checkRateLimit, getClientIp, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

/**
 * POST /api/auth/signup — create a user AND their own account
 * (they become its owner). Joining an existing team happens
 * afterwards through /api/invitations/[token]/redeem.
 *
 * Closed to the public: merchants are created by the platform operator
 * (POST /api/admin/accounts). Since the platform now pays for every
 * merchant's AI, an open signup would let any stranger spend its
 * credit. The one exception is a teammate holding a live invitation,
 * who needs a login before they can accept it.
 */
export async function POST(request: Request) {
  const limit = checkRateLimit(`signup:${getClientIp(request)}`, RATE_LIMITS.signup)
  if (!limit.success) return rateLimitResponse(limit)

  try {
    const body = await readJson(request)
    const inviteToken = typeof body.inviteToken === 'string' ? body.inviteToken.slice(0, 100) : ''
    const invited = inviteToken ? (await peekInvitation(hashInviteToken(inviteToken))).ok : false
    if (!invited) {
      throw new ForbiddenError('Accounts are set up by your administrator. Please contact support to get started.')
    }
    const email = emailV(body.email)
    const password = str(body.password, 'password', {
      min: MIN_PASSWORD_LENGTH,
      max: 200,
      trim: false,
    })
    const fullName = optStr(body.fullName, 'fullName', 120)
    const businessName =
      optStr(body.businessName, 'businessName', 120) ?? (fullName ? `${fullName}'s business` : 'My business')

    const db = await getDb()
    const existing = await db.collection<UserDoc>('users').findOne({ email }, { projection: { _id: 1 } })
    if (existing) throw new ConflictError('An account with this email already exists')

    const { user } = await createAccountWithOwner({
      email,
      passwordHash: await hashPassword(password),
      fullName,
      businessName,
    })
    await createSession(user._id)
    return NextResponse.json({ ok: true }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
