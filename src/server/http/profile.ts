import { createHash } from 'node:crypto';
import { scoped } from '../db';
import { profileForSession } from '../dal/profiles';
export async function profileResponse(request: Request, employeeId: string): Promise<Response> {
  const token = request.headers.get('cookie')?.match(/(?:^|;\s*)libetario_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  const headers = { 'Cache-Control': 'private, no-store' };
  if (!token) return Response.json({ error: 'Sign in required' }, { status: 401, headers });
  const hash = createHash('sha256').update(token).digest('hex');
  const identity = await scoped(hash, tx => tx.$queryRaw<{ must_change_password: boolean }[]>`SELECT * FROM private.identity()`);
  if (!identity[0] || identity[0].must_change_password) return Response.json({ error: 'Sign in required' }, { status: 401, headers });
  if (!/^[a-f0-9-]{36}$/i.test(employeeId)) return Response.json({ error: 'Not found' }, { status: 404, headers });
  const profile = await profileForSession(hash, employeeId);
  return profile ? Response.json(profile, { headers }) : Response.json({ error: 'Not found' }, { status: 404, headers });
}
