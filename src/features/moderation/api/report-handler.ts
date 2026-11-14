import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { defaultRateLimiter, RATE_LIMITS, trustedClientIp, type RateLimitConfig } from "@/lib/rate-limit";
import { isPlainObject, isTrustedOrigin, readJsonBody, resolveTrustedOrigins } from "@/lib/api";
import {
  submitAbuseReport,
  InvalidAbuseReportError,
  ModerationServiceUnavailableError,
} from "../service";
import type { AbuseReportCategory } from "../types";

export interface ReportHandlerDeps {
  getUserId?: () => Promise<string | null>;
  trustedOrigins?: () => readonly string[];
  dbClient?: any;
}

/** Reports are small: details are capped at 2000 characters by the service. */
const REPORT_MAX_BODY_BYTES = 8 * 1024;
/** Job, asset and user ids are cuid-style identifiers. */
const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const VALID_CATEGORIES: AbuseReportCategory[] = [
  "csam",
  "extreme_violence",
  "self_harm",
  "hate_speech",
  "harassment",
  "copyright_infringement",
  "spam_or_abuse",
  "other",
];

export async function handleAbuseReportRequest(
  request: Request,
  deps?: ReportHandlerDeps,
): Promise<Response> {
  if (request.method !== "POST") {
    return NextResponse.json(
      { error: "Method not allowed", code: "METHOD_NOT_ALLOWED" },
      { status: 405 },
    );
  }

  // 1. Origin Check (CSRF defense)
  const trustedOrigins = deps?.trustedOrigins ? deps.trustedOrigins() : resolveTrustedOrigins();
  if (process.env.NODE_ENV === "production" && !isTrustedOrigin(request, trustedOrigins)) {
    return NextResponse.json({ error: "Untrusted origin", code: "FORBIDDEN" }, { status: 403 });
  }

  // 2. Optional Session User
  let userId: string | null = null;
  if (deps?.getUserId) {
    userId = await deps.getUserId();
  } else {
    try {
      const session = await auth();
      userId = session?.user?.id ?? null;
    } catch {
      userId = null;
    }
  }

  // 3. Parse the payload with a hard size cap (this endpoint accepts anonymous traffic).
  const parsedBody = await readJsonBody(request, REPORT_MAX_BODY_BYTES);
  if (!parsedBody.ok) {
    return parsedBody.reason === "TOO_LARGE"
      ? NextResponse.json({ error: "Request body is too large", code: "PAYLOAD_TOO_LARGE" }, { status: 413 })
      : NextResponse.json({ error: "Invalid JSON payload", code: "BAD_REQUEST" }, { status: 400 });
  }
  if (!isPlainObject(parsedBody.value)) {
    return NextResponse.json({ error: "Invalid JSON payload", code: "BAD_REQUEST" }, { status: 400 });
  }
  const body = parsedBody.value as Record<string, unknown>;
  const { targetType, targetId, category, details, reporterEmail } = body as any;

  if (typeof targetId !== "string" || !TARGET_ID_PATTERN.test(targetId)) {
    return NextResponse.json({ error: "targetId is invalid", code: "INVALID_TARGET_ID" }, { status: 400 });
  }
  if (reporterEmail !== undefined && reporterEmail !== null && (typeof reporterEmail !== "string" || reporterEmail.length > 254)) {
    return NextResponse.json({ error: "reporterEmail is invalid", code: "INVALID_REPORTER_EMAIL" }, { status: 400 });
  }

  // 4. Rate limiting. Signed-in: per user. Anonymous: per trusted client IP (only when a trusted
  // proxy supplies one), per reported target, and a site-wide cap; never one shared anonymous
  // bucket that a single client could exhaust for everyone. All limits are checked before any is
  // recorded, so a refused report does not consume the other budgets.
  const limits: [string, RateLimitConfig][] = userId
    ? [[`moderation:report:user:${userId}`, RATE_LIMITS.REPORT_USER]]
    : [
        ...(() => {
          const ip = trustedClientIp(request.headers);
          return ip ? [[`moderation:report:anon:ip:${ip}`, RATE_LIMITS.REPORT_ANON_IP] as [string, RateLimitConfig]] : [];
        })(),
        [`moderation:report:anon:target:${String(targetType)}:${targetId}`, RATE_LIMITS.REPORT_ANON_TARGET],
        ["moderation:report:anon:global", RATE_LIMITS.REPORT_ANON_GLOBAL],
      ];
  if (limits.some(([key, cfg]) => !defaultRateLimiter.peek(key, cfg).allowed)) {
    return NextResponse.json(
      { error: "Too many abuse reports submitted. Please wait before reporting again.", code: "RATE_LIMITED" },
      { status: 429 },
    );
  }
  for (const [key, cfg] of limits) defaultRateLimiter.check(key, cfg);

  if (!["JOB", "ASSET", "USER"].includes(targetType)) {
    return NextResponse.json(
      { error: "targetType must be JOB, ASSET, or USER", code: "INVALID_TARGET_TYPE" },
      { status: 400 },
    );
  }

  if (!VALID_CATEGORIES.includes(category)) {
    return NextResponse.json(
      { error: `category must be one of: ${VALID_CATEGORIES.join(", ")}`, code: "INVALID_CATEGORY" },
      { status: 400 },
    );
  }

  try {
    const item = await submitAbuseReport(
      {
        targetType,
        targetId,
        category,
        details,
        reporterEmail,
      },
      userId,
      deps?.dbClient,
    );

    return NextResponse.json(
      {
        success: true,
        reportId: item.id,
        status: "RECEIVED",
        message: "Abuse report received and queued for operational review.",
      },
      { status: 201 },
    );
  } catch (err: any) {
    if (err instanceof InvalidAbuseReportError) {
      return NextResponse.json({ error: err.message, code: "INVALID_REPORT" }, { status: 400 });
    }

    if (err instanceof ModerationServiceUnavailableError) {
      return NextResponse.json(
        { error: "Moderation persistence service is currently unavailable. Abuse reports must be durably recorded.", code: "SERVICE_UNAVAILABLE" },
        { status: 503 },
      );
    }

    console.error("[api/moderation/reports] Intake error:", err);
    return NextResponse.json(
      { error: "Failed to submit abuse report", code: "INTERNAL_ERROR" },
      { status: 500 },
    );
  }
}
