import { handleAbuseReportRequest } from "@/features/moderation/api/report-handler";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleAbuseReportRequest(request);
}
