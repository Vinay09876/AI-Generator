import {
  DEFAULT_DAILY_USER_VIDEO_LIMIT,
  DEFAULT_VIDEO_CREDIT_COST,
  PROVISIONAL_PAID_DAILY_VIDEO_LIMIT,
  PROVISIONAL_QA_DAILY_VIDEO_LIMIT,
  type VideoUserTier,
} from "./config";

export interface ServerUserIdentity {
  id?: string | null;
  email?: string | null;
  emailVerified?: boolean | Date | null;
}

export interface UserVideoEntitlement {
  tier: VideoUserTier;
  dailyLimit: number;
  creditCost: number;
  isQaAuthorized: boolean;
}

export interface QaAllowlistParsed {
  userIds: Set<string>;
  emails: Set<string>;
}

/**
 * Parses raw server-side QA allowlist string into normalized user IDs and email addresses.
 * Expects comma-, semicolon-, or newline-separated values.
 * Never leaks raw input in logs or errors.
 */
export function parseQaAllowlist(raw?: string | null): QaAllowlistParsed {
  const userIds = new Set<string>();
  const emails = new Set<string>();

  if (!raw || typeof raw !== "string") {
    return { userIds, emails };
  }

  const tokens = raw.split(/[\s,;]+/);
  for (const token of tokens) {
    const trimmed = token.trim();
    if (!trimmed) continue;

    if (trimmed.includes("@")) {
      emails.add(trimmed.toLowerCase());
    } else {
      userIds.add(trimmed);
    }
  }

  return { userIds, emails };
}

export interface QaAuthorizationParams {
  user: ServerUserIdentity | null | undefined;
  allowlistRaw?: string | null;
  nodeEnv?: string;
}

/**
 * Server-side evaluation of QA authorization for Stage 8 video generation.
 *
 * Security Invariants:
 * 1. Prefer stable user IDs over email addresses.
 * 2. If email is used, requires exact match AND verified email identity (emailVerified is truthy).
 * 3. In production, if STAGE_8_QA_ALLOWLIST is missing, empty, or whitespace-only, fails closed (returns false).
 * 4. Never trusts client-supplied roles, flags, or tier claims.
 * 5. Allowlist values are never exposed to client-side bundles or response payloads.
 */
export function isServerAuthorizedQaUser(params: QaAuthorizationParams): boolean {
  const { user, nodeEnv = process.env.NODE_ENV || "development" } = params;

  if (!user || (!user.id && !user.email)) {
    return false;
  }

  // Read from explicit param or server-side environment
  const rawAllowlist =
    params.allowlistRaw !== undefined
      ? params.allowlistRaw
      : process.env.STAGE_8_QA_ALLOWLIST;

  // Fail-closed in production if allowlist is missing or empty
  if (nodeEnv === "production") {
    if (!rawAllowlist || typeof rawAllowlist !== "string" || rawAllowlist.trim() === "") {
      return false;
    }
  } else if (!rawAllowlist || typeof rawAllowlist !== "string" || rawAllowlist.trim() === "") {
    return false;
  }

  const allowlist = parseQaAllowlist(rawAllowlist);
  if (allowlist.userIds.size === 0 && allowlist.emails.size === 0) {
    return false;
  }

  // 1. Prefer stable user ID check (exact match)
  if (user.id && typeof user.id === "string") {
    const trimmedId = user.id.trim();
    if (trimmedId && allowlist.userIds.has(trimmedId)) {
      return true;
    }
  }

  // 2. Check normalized email with required verified identity
  if (user.email && typeof user.email === "string") {
    const normalizedEmail = user.email.trim().toLowerCase();
    if (allowlist.emails.has(normalizedEmail)) {
      // Require verified email identity
      const isVerified = Boolean(user.emailVerified);
      if (isVerified) {
        return true;
      }
      // Unverified email identity fails closed
      return false;
    }
  }

  return false;
}

export interface ResolveEntitlementParams {
  /** Authenticated user identity from server session. */
  user: ServerUserIdentity | null | undefined;
  /** Untrusted client payload (e.g. request body/headers) — strictly ignored for tier assignment. */
  clientPayload?: unknown;
  /** Trusted subscription record from server database or auth claims. */
  trustedSubscription?: { status: string; tier: string } | null;
  /** Server-side allowlist override for unit tests. */
  allowlistRaw?: string | null;
  /** Environment override for unit tests. */
  nodeEnv?: string;
}

/**
 * Resolves the user's authoritative video generation entitlement.
 *
 * Security Invariants:
 * 1. The server exclusively determines the user's actual entitlement.
 * 2. Client requests cannot choose or elevate their own tier (clientPayload is ignored).
 * 3. Paid quota cannot be granted without trusted active subscription data.
 * 4. QA quota requires successful server-side QA authorization.
 * 5. Unknown or unrecognized tiers fail closed to 'promotional' (1 video per UTC day).
 */
export function resolveUserVideoEntitlement(
  params: ResolveEntitlementParams
): UserVideoEntitlement {
  const { user, trustedSubscription, allowlistRaw, nodeEnv } = params;

  // 1. Check for trusted paid subscription
  if (
    trustedSubscription &&
    typeof trustedSubscription === "object" &&
    trustedSubscription.status === "active" &&
    trustedSubscription.tier === "paid"
  ) {
    return {
      tier: "paid",
      dailyLimit: PROVISIONAL_PAID_DAILY_VIDEO_LIMIT,
      creditCost: DEFAULT_VIDEO_CREDIT_COST,
      isQaAuthorized: false,
    };
  }

  // 2. Check for server-side QA authorization
  const isQa = isServerAuthorizedQaUser({
    user,
    allowlistRaw,
    nodeEnv,
  });

  if (isQa) {
    return {
      tier: "qa",
      dailyLimit: PROVISIONAL_QA_DAILY_VIDEO_LIMIT,
      creditCost: DEFAULT_VIDEO_CREDIT_COST,
      isQaAuthorized: true,
    };
  }

  // 3. Fail-closed default: promotional tier
  return {
    tier: "promotional",
    dailyLimit: DEFAULT_DAILY_USER_VIDEO_LIMIT,
    creditCost: DEFAULT_VIDEO_CREDIT_COST,
    isQaAuthorized: false,
  };
}

export interface Stage8AccessDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * Validates whether an entitlement is permitted to generate video during Stage 8.
 * In production, restricts access exclusively to QA-authorized accounts.
 */
export function canGenerateVideoInStage8(params: {
  entitlement: UserVideoEntitlement;
  nodeEnv?: string;
}): Stage8AccessDecision {
  const { entitlement, nodeEnv = process.env.NODE_ENV || "development" } = params;

  if (nodeEnv === "production" && !entitlement.isQaAuthorized) {
    return {
      allowed: false,
      reason:
        "AI Video Generator is currently in private Stage 8 testing and restricted to authorized QA accounts.",
    };
  }

  return { allowed: true };
}

