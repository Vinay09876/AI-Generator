import { generationHandlers } from "@/features/generations/service";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  const { assetId } = await params;
  return generationHandlers.getAsset(request, assetId);
}
