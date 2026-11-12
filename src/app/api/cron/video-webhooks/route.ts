export const dynamic = "force-dynamic";

import { handleVideoCronRequest } from "@/features/video/cron-auth";

export async function GET(request: Request) {
  return handleVideoCronRequest(request);
}
