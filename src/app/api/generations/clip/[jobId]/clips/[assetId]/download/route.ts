import { getClipperHandlers } from "@/features/clipper/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ jobId: string; assetId: string }> }) {
  const { jobId, assetId } = await params;
  return getClipperHandlers().getClipDownload(request, jobId, assetId);
}
