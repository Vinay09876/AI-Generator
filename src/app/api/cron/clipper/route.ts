import { clipperCronGET } from "@/features/clipper/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export function GET(request: Request) {
  return clipperCronGET(request);
}