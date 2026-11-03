import { NextRequest, NextResponse } from "next/server";
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp =
    "default-src 'self'; script-src 'self' 'nonce-" +
    nonce +
    "' 'strict-dynamic'" +
    (process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "") +
    "; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  headers.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", csp);
  if (!request.nextUrl.pathname.startsWith("/_next/"))
    response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export const config = {
  // Upload Route Handlers own auth/CSRF/security headers. Skipping Proxy here
  // avoids Next's eager body cloning, so quotas precede streaming disk writes.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/work/(?:projects|tasks|submissions)/[^/]+/files).*)",
  ],
};
