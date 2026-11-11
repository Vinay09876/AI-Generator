import { videoGenerationHandlers } from "@/features/video/service";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const { jobId } = await params;
  return videoGenerationHandlers.getJob(request, jobId);
}

