import { handleDeleteAccountRequest } from "@/features/users/api/delete-handler";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleDeleteAccountRequest(request);
}
