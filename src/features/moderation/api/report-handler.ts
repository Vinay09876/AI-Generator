import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { defaultRateLimiter } from "@/lib/rate-limit";
import { isTrustedOrigin, resolveTrustedOrigins } from "@/lib/api";
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

  // 3. Rate Limiting Check (10 reports/hour)
  const rateLimitKey = userId ? `moderation:report:${userId}` : "moderation:report:anon";
  const rateLimit = defaultRateLimiter.check(rateLimitKey, {
    max: 10,
    windowMs: 60 * 60_000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many abuse reports submitted. Please wait before reporting again.", code: "RATE_LIMITED" },
      { status: 429 },
    );
  }

  // 4. Parse & Validate Payload
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload", code: "BAD_REQUEST" }, { status: 400 });
  }

  const { targetType, targetId, category, details, reporterEmail } = body;

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
