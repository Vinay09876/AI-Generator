export const dynamic = "force-dynamic";

import { handleRazorpayWebhookRequest } from "@/features/billing/api/webhook-handler";

export async function POST(request: Request) {
  return handleRazorpayWebhookRequest(request);
}
