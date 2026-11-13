import { handleGetModerationQueueRequest } from "@/features/moderation/api/admin-handler";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleGetModerationQueueRequest(request);
}
