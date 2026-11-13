export class AdminAuthorizationError extends Error {
  public readonly status = 403;
  public readonly code = "FORBIDDEN";

  constructor(message = "Administrative or operator authorization required.") {
    super(message);
    this.name = "AdminAuthorizationError";
  }
}

/**
 * Evaluates whether the user holds administrative or operator privileges.
 *
 * Checks:
 * 1. Explicit role claim on session user ("admin" | "operator").
 * 2. Presence in comma-separated ADMIN_USER_IDS environment configuration.
 *
 * Fails closed if neither is present.
 */
export function isAdmin(userId: string | null | undefined, sessionUser?: any): boolean {
  if (!userId) return false;

  if (sessionUser?.role === "admin" || sessionUser?.role === "operator") {
    return true;
  }

  const adminIds = process.env.ADMIN_USER_IDS
    ? process.env.ADMIN_USER_IDS.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  return adminIds.includes(userId);
}

/**
 * Asserts administrative authorization, throwing AdminAuthorizationError (403) on failure.
 */
export function assertAdmin(userId: string | null | undefined, sessionUser?: any): void {
  if (!isAdmin(userId, sessionUser)) {
    throw new AdminAuthorizationError();
  }
}
