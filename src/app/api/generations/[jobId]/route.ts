import { generationHandlers } from "@/features/generations/service";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return generationHandlers.getJob(request, jobId);
}
