import 'server-only'
import { cache } from 'react'
import { getDb } from '@/lib/db/mongo'
import type { AuthContext } from '@/lib/db/scoped'
import type { AccountDoc, UserDoc } from '@/lib/db/types'
import { ForbiddenError, UnauthorizedError } from '@/lib/http/errors'
import { actingAccountId, isPlatformAdmin } from './platform'
import { hasMinRole, isAccountRole, type AccountRole } from './roles'
import { getSessionUser } from './session'

// ============================================================
// Server-side account context for route handlers.
//
// EVERY route handler that touches tenant data starts with
// `requireRole(min)`. There is no database-level safety net
// any more (no RLS) — this call plus `scopedCollection()` IS the
// authorization layer. Minimum roles mirror the old 017 policy
// tiers:
//
//   viewer  read anything in the account
//   agent   operational writes: messages, contacts, orders,
//           inventory stock, conversations
//   admin   settings: WhatsApp, payments, email, AI providers,
//           business profile, products catalogue, members
//   owner   ownership transfer, account deletion
//
//   try {
//     const ctx = await requireRole('agent')
//     const orders = await scopedCollection<OrderDoc>(ctx, 'orders')
//   } catch (err) {
//     return toErrorResponse(err)
//   }
// ============================================================

export { UnauthorizedError, ForbiddenError }
export { toErrorResponse } from '@/lib/http/errors'

export class PasswordChangeRequiredError extends ForbiddenError {
  constructor() {
    super('Choose your own password before continuing')
    this.name = 'PasswordChangeRequiredError'
  }
}

export interface AccountContext extends AuthContext {
  kind: 'user'
  sessionId: string
  user: Pick<UserDoc, '_id' | 'email' | 'fullName' | 'avatarUrl' | 'role'>
  account: { id: string; name: string }
  /** True when the caller runs the platform, not just this account. */
  platformAdmin: boolean
  /** True when a platform admin is working inside someone else's account. */
  actingAsAccount: boolean
  /** Still on a password somebody else chose — see UserDoc.mustChangePassword. */
  mustChangePassword: boolean
}

/** Resolve the caller's session → user → account. */
async function resolveAccount(allowPendingPasswordChange: boolean): Promise<AccountContext> {
  const resolved = await getSessionUser()
  if (!resolved) throw new UnauthorizedError()
  const { session, user } = resolved

  // A password someone else chose can only be used to change it. This is
  // the one gate every route passes through, so it can't be forgotten
  // on a new route the way a per-route check could.
  if (user.mustChangePassword && !allowPendingPasswordChange) {
    throw new PasswordChangeRequiredError()
  }

  if (!isAccountRole(user.role)) throw new ForbiddenError('Unknown account role')

  const platformAdmin = isPlatformAdmin(user)
  // A platform admin can open a merchant's account to set it up for
  // them; everyone else is pinned to their own.
  const acting = platformAdmin ? await actingAccountId() : null
  const accountId = acting ?? user.accountId

  const db = await getDb()
  const account = await db
    .collection<AccountDoc>('accounts')
    .findOne({ _id: accountId }, { projection: { name: 1, suspendedAt: 1 } })
  if (!account) throw new ForbiddenError('User is not linked to an account')
  // A suspended merchant is locked out of their own workspace; the
  // platform admin can still open it to fix whatever caused it.
  if (account.suspendedAt && !platformAdmin) {
    throw new ForbiddenError('This account is suspended. Please contact support.')
  }

  return {
    kind: 'user',
    sessionId: session._id,
    userId: user._id,
    accountId,
    // Inside someone else's account the admin acts as its owner.
    role: acting ? 'owner' : user.role,
    user: {
      _id: user._id,
      email: user.email,
      fullName: user.fullName,
      avatarUrl: user.avatarUrl,
      role: user.role,
    },
    account: { id: account._id, name: account.name },
    platformAdmin,
    actingAsAccount: !!acting,
    mustChangePassword: !!user.mustChangePassword,
    // A platform admin sets things up for merchants; they do not read
    // the merchant's customers (enforced in scopedCollection).
    operator: platformAdmin,
  }
}

export const getCurrentAccount = cache(() => resolveAccount(false))

/**
 * For the few routes a person with a not-yet-changed temporary password
 * must still reach: reading who they are, and changing the password.
 */
export const getCurrentAccountAllowingPasswordChange = cache(() => resolveAccount(true))

/** Resolve the account context and enforce a minimum role. */
export async function requireRole(min: AccountRole): Promise<AccountContext> {
  const ctx = await getCurrentAccount()
  if (!hasMinRole(ctx.role, min)) {
    throw new ForbiddenError(`This action requires the '${min}' role or higher`)
  }
  return ctx
}
