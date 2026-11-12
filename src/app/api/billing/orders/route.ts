export const dynamic = "force-dynamic";

import { handleCreateOrderRequest } from "@/features/billing/api/orders-handler";

export async function POST(request: Request) {
  return handleCreateOrderRequest(request);
}
