import { handleActionModerationRequest } from "@/features/moderation/api/admin-handler";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleActionModerationRequest(request);
}
