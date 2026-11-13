import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/features/admin/auth";
import { isTrustedOrigin, resolveTrustedOrigins } from "@/lib/api";
import {
  getModerationQueue,
  actionModerationItem,
  ModerationItemNotFoundError,
  ModerationServiceUnavailableError,
} from "../service";
import type { ModerationAction, ModerationQueueStatus } from "../types";

export interface AdminHandlerDeps {
  getUserId?: () => Promise<string | null>;
  isAdmin?: (userId: string | null | undefined, sessionUser?: any) => boolean;
  trustedOrigins?: () => readonly string[];
  dbClient?: any;
}

export async function handleGetModerationQueueRequest(
  request: Request,
  deps?: AdminHandlerDeps,
): Promise<Response> {
  if (request.method !== "GET") {
    return NextResponse.json({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" }, { status: 405 });
  }

  // 1. Authentication Check
  let userId: string | null = null;
  let sessionUser: any = null;
  if (deps?.getUserId) {
    userId = await deps.getUserId();
  } else {
    try {
      const session = await auth();
      userId = session?.user?.id ?? null;
      sessionUser = session?.user ?? null;
    } catch {
      userId = null;
    }
  }

  // 2. Admin Authorization Check
  const authorized = deps?.isAdmin ? deps.isAdmin(userId, sessionUser) : isAdmin(userId, sessionUser);
  if (!authorized) {
    return NextResponse.json(
      { error: "Administrative authorization required", code: "FORBIDDEN" },
      { status: 403 },
    );
  }

  const { searchParams } = new URL(request.url);
  const status = (searchParams.get("status") as ModerationQueueStatus) || undefined;
  const takeStr = searchParams.get("take");
  const take = takeStr ? parseInt(takeStr, 10) : undefined;

  try {
    const items = await getModerationQueue({ status, take }, deps?.dbClient);
    return NextResponse.json({
      success: true,
      count: items.length,
      items,
    });
  } catch (err: any) {
    if (err instanceof ModerationServiceUnavailableError) {
      return NextResponse.json(
        { error: "Moderation persistence service is currently unavailable.", code: "SERVICE_UNAVAILABLE" },
        { status: 503 },
      );
    }

    console.error("[api/admin/moderation] Queue retrieval error:", err);
    return NextResponse.json(
      { error: "Failed to retrieve moderation queue", code: "INTERNAL_ERROR" },
      { status: 500 },
    );
  }
}

export async function handleActionModerationRequest(
  request: Request,
  deps?: AdminHandlerDeps,
): Promise<Response> {
  if (request.method !== "POST") {
    return NextResponse.json({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" }, { status: 405 });
  }

  // 1. Origin Check (CSRF)
  const trustedOrigins = deps?.trustedOrigins ? deps.trustedOrigins() : resolveTrustedOrigins();
  if (process.env.NODE_ENV === "production" && !isTrustedOrigin(request, trustedOrigins)) {
    return NextResponse.json({ error: "Untrusted origin", code: "FORBIDDEN" }, { status: 403 });
  }

  // 2. Authentication Check
  let userId: string | null = null;
  let sessionUser: any = null;
  if (deps?.getUserId) {
    userId = await deps.getUserId();
  } else {
    try {
      const session = await auth();
      userId = session?.user?.id ?? null;
      sessionUser = session?.user ?? null;
    } catch {
      userId = null;
    }
  }

  // 3. Admin Authorization Check
  const authorized = deps?.isAdmin ? deps.isAdmin(userId, sessionUser) : isAdmin(userId, sessionUser);
  if (!authorized || !userId) {
    return NextResponse.json(
      { error: "Administrative authorization required", code: "FORBIDDEN" },
      { status: 403 },
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload", code: "BAD_REQUEST" }, { status: 400 });
  }

  const { reportId, action, notes } = body;
  const validActions: ModerationAction[] = ["DISMISS", "HIDE_CONTENT", "SUSPEND_USER", "WARN_USER"];

  if (!reportId || !validActions.includes(action) || !notes) {
    return NextResponse.json(
      { error: "reportId, valid action, and resolution notes are required", code: "INVALID_ACTION_PAYLOAD" },
      { status: 400 },
    );
  }

  try {
    const item = await actionModerationItem(
      {
        reportId,
        action,
        operatorId: userId,
        notes,
      },
      deps?.dbClient,
    );

    return NextResponse.json({
      success: true,
      message: `Moderation action ${action} executed successfully.`,
      item,
    });
  } catch (err: any) {
    if (err instanceof ModerationItemNotFoundError) {
      return NextResponse.json({ error: err.message, code: "NOT_FOUND" }, { status: 404 });
    }

    if (err instanceof ModerationServiceUnavailableError) {
      return NextResponse.json(
        { error: "Moderation persistence service is unavailable. Moderation action could not be committed.", code: "SERVICE_UNAVAILABLE" },
        { status: 503 },
      );
    }

    console.error("[api/admin/moderation/action] Action error:", err);
    return NextResponse.json(
      { error: "Failed to execute moderation action", code: "INTERNAL_ERROR" },
      { status: 500 },
    );
  }
}
