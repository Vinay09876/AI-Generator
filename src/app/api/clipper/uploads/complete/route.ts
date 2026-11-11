import { getClipperHandlers } from "@/features/clipper/service";

export const runtime = "nodejs";

export function POST(request: Request) {
  return getClipperHandlers().postUploadComplete(request);
}