import { getClipperHandlers } from "@/features/clipper/service";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return getClipperHandlers().getClipJob(request, jobId);
}