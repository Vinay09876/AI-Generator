export const dynamic = "force-dynamic";

import { handleFalWebhookRequest } from "@/features/video/webhooks/fal-handler";

export async function POST(request: Request) {
  return handleFalWebhookRequest(request);
}
