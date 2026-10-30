import { api } from "@/server/http/api";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ path: string[] }> };
const handler = async (request: Request, context: Context) =>
  api(request, (await context.params).path);
export { handler as GET, handler as POST, handler as PATCH };
