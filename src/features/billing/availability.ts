/**
 * Credit purchase availability (post-S8 remediation).
 *
 * There is no live payment gateway integration yet: Razorpay order creation is not implemented and
 * the mock gateway is a development/test fixture that must never run in production. Purchases are
 * therefore DISABLED whenever NODE_ENV=production, with no switch to turn them on. Enabling paid
 * purchases requires a real gateway implementation, verified webhook processing and an explicit
 * code change here — not an environment variable that could be flipped by accident.
 *
 * Outside production (local development and test suites) the mock gateway stays available so the
 * settlement engine can be exercised end to end without any external payment call.
 */

export const PURCHASES_DISABLED_CODE = "PURCHASES_DISABLED" as const;

export const PURCHASES_DISABLED_MESSAGE =
  "Credit purchases are not available yet. Your existing credits are unaffected.";

export type PurchaseAvailability =
  | { enabled: true; gateway: "mock" }
  | { enabled: false; code: typeof PURCHASES_DISABLED_CODE; message: string };

export function getPurchaseAvailability(
  env: Record<string, string | undefined> = process.env,
): PurchaseAvailability {
  if (env.NODE_ENV === "production") {
    return { enabled: false, code: PURCHASES_DISABLED_CODE, message: PURCHASES_DISABLED_MESSAGE };
  }
  return { enabled: true, gateway: "mock" };
}

/** True only where the mock gateway (and its development secrets) may be used. */
export function isMockGatewayAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV !== "production";
}
