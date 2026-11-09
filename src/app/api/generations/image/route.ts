import { generationHandlers } from "@/features/generations/service";

// Node.js runtime: sharp (WebP conversion) and the Postgres driver need it.
export const runtime = "nodejs";
// Must equal GENERATION_REQUEST_MAX_DURATION_S in features/generations/config.ts (a literal is
// required here). > 60 s provider timeout, < 5 min reconciliation threshold.
export const maxDuration = 90;

export function POST(request: Request) {
  return generationHandlers.postImage(request);
}
