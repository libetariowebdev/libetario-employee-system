import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { environment } from '../../lib/config';
export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export const randomToken = () => randomBytes(32).toString('hex');
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export function passwordValid(password: string) {
  return typeof password === 'string' && Array.from(password).length >= 12 && Array.from(password).length <= 128 && /\p{L}/u.test(password) && /[^\p{L}]/u.test(password);
}
export function hashPassword(password: string) {
  if (!passwordValid(password)) throw new HttpError(400, 'Password must have 12–128 characters, a letter and a non-letter.');
  return hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
}
export { verify as verifyPassword };
export function cookie(request: Request, name: string) { return request.headers.get('cookie')?.split(';').map(v => v.trim()).find(v => v.startsWith(name+'='))?.slice(name.length+1); }
export function constantEqual(a: string, b: string) { const aa=Buffer.from(a),bb=Buffer.from(b); return aa.length===bb.length && timingSafeEqual(aa,bb); }
export function csrfForSession(token: string) { return createHmac('sha256', environment().SESSION_SECRET).update('csrf:'+token).digest('hex'); }
export function csrfAnonymous() { const token=randomToken(); return token+'.'+createHmac('sha256',environment().SESSION_SECRET).update('anonymous:'+token).digest('hex'); }
export function assertCsrf(request: Request, submitted: unknown, sessionToken?: string) {
  if (request.headers.get('origin') !== environment().APP_ORIGIN || request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403, 'Invalid request origin');
  if (typeof submitted !== 'string' || submitted.length > 200) throw new HttpError(403,'Invalid request token');
  if (sessionToken) { if (!constantEqual(submitted,csrfForSession(sessionToken))) throw new HttpError(403,'Invalid request token'); }
  else {
    const stored=cookie(request,'libetario_csrf') ?? '';
    const [token,signature]=stored.split('.');
    if (!token || !signature || !constantEqual(stored,submitted) || !constantEqual(signature,createHmac('sha256',environment().SESSION_SECRET).update('anonymous:'+token).digest('hex'))) throw new HttpError(403,'Invalid request token');
  }
}
export function cookieString(name: string, value: string, maxAge: number) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${environment().APP_ORIGIN.startsWith('https:') ? '; Secure' : ''}`;
}
export function networkKey(request: Request) {
  const network = environment().TRUST_PROXY === 'true' ? (request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown') : 'untrusted-network';
  return createHmac('sha256',environment().SESSION_SECRET).update('network:'+network).digest('hex');
}
