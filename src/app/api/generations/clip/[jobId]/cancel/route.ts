import { getClipperHandlers } from "@/features/clipper/service";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return getClipperHandlers().postCancelClipJob(request, jobId);
}
