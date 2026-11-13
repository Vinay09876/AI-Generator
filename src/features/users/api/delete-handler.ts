import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { defaultRateLimiter } from "@/lib/rate-limit";
import { isTrustedOrigin, resolveTrustedOrigins } from "@/lib/api";
import {
  requestAccountDeletion,
  ActiveJobsInFlightError,
  AccountAlreadyDeletedError,
  InvalidConfirmationError,
  UserNotFoundError,
} from "../account-lifecycle";

export interface DeleteAccountHandlerDeps {
  getUserId?: () => Promise<string | null>;
  trustedOrigins?: () => readonly string[];
  dbClient?: any;
}

export async function handleDeleteAccountRequest(
  request: Request,
  deps?: DeleteAccountHandlerDeps,
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

  // 2. Authentication Check
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

  if (!userId) {
    return NextResponse.json(
      { error: "Authentication required", code: "UNAUTHORIZED" },
      { status: 401 },
    );
  }

  // 3. Rate Limiting Check (5 attempts / 15 minutes)
  const rateLimit = defaultRateLimiter.check(`account:delete:${userId}`, {
    max: 5,
    windowMs: 15 * 60_000,
  });
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Too many deletion attempts. Please wait.", code: "RATE_LIMITED" },
      { status: 429 },
    );
  }

  // 4. Parse confirmation body
  let body: { password?: string; confirmPhrase?: string } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  try {
    const result = await requestAccountDeletion(
      userId,
      {
        password: body.password,
        confirmPhrase: body.confirmPhrase,
      },
      deps?.dbClient,
    );

    return NextResponse.json({
      success: true,
      message: "Your account has been decommissioned and personal information anonymized.",
      result,
    });
  } catch (err: any) {
    if (err instanceof ActiveJobsInFlightError) {
      return NextResponse.json({ error: err.message, code: "ACTIVE_JOBS_IN_FLIGHT" }, { status: 409 });
    }
    if (err instanceof InvalidConfirmationError) {
      return NextResponse.json({ error: err.message, code: "INVALID_CONFIRMATION" }, { status: 400 });
    }
    if (err instanceof AccountAlreadyDeletedError) {
      return NextResponse.json({ error: err.message, code: "ACCOUNT_ALREADY_DELETED" }, { status: 400 });
    }
    if (err instanceof UserNotFoundError) {
      return NextResponse.json({ error: err.message, code: "USER_NOT_FOUND" }, { status: 404 });
    }

    console.error("[api/account/delete] Decommissioning error:", err);
    return NextResponse.json(
      { error: "Account deletion operation failed", code: "INTERNAL_ERROR" },
      { status: 500 },
    );
  }
}
