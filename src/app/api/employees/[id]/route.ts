import { profileResponse } from "@/server/http/profile";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return profileResponse(request, (await context.params).id);
}
