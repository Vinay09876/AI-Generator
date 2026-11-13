/**
 * Session-time account status check (post-S8 remediation).
 *
 * Sessions are stateless JWTs (required by the Credentials provider), so deleting Session rows does
 * not revoke them. The Node.js Auth.js instance (src/lib/auth.ts) calls this from its `jwt` callback
 * on every session read: a token whose account is missing, deleted or suspended is rejected, which
 * makes auth() return null and clears the session cookie.
 *
 * Fail closed: if the status lookup itself fails, the session is rejected rather than trusted.
 */

export type AccountStatus = "active" | "suspended" | "deleted" | "missing";

export interface AccountStatusRow {
  isDeleted: boolean;
  isSuspended: boolean;
}

export type AccountStatusLookup = (userId: string) => Promise<AccountStatusRow | null>;

export function classifyAccount(row: AccountStatusRow | null): AccountStatus {
  if (!row) return "missing";
  if (row.isDeleted) return "deleted";
  if (row.isSuspended) return "suspended";
  return "active";
}

/**
 * Returns true only when the token's subject is an existing, non-deleted, non-suspended account.
 * Never throws; lookup errors count as "not active".
 */
export async function isSessionAccountActive(
  userId: string | null | undefined,
  lookup: AccountStatusLookup,
): Promise<boolean> {
  if (!userId) return false;
  try {
    return classifyAccount(await lookup(userId)) === "active";
  } catch (err) {
    console.error("[auth] Account status check failed; rejecting session.", (err as Error)?.name ?? "Error");
    return false;
  }
}
