import { handleReconcileRequest } from "@/features/billing/api/reconcile-handler";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleReconcileRequest(request);
}
