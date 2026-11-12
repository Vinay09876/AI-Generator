export const dynamic = "force-dynamic";

import { handleVerifyPaymentRequest } from "@/features/billing/api/verify-handler";

export async function POST(request: Request) {
  return handleVerifyPaymentRequest(request);
}
