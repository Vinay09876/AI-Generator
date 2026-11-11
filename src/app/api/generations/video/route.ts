import { videoGenerationHandlers } from "@/features/video/service";

export const runtime = "nodejs";
export const maxDuration = 60;

export function POST(request: Request) {
  return videoGenerationHandlers.postVideo(request);
}

