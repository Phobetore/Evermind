import { NextResponse, type NextRequest } from "next/server";
import { GATE_COOKIE, gateEnabled, gateToken } from "@/lib/gate";

/** Guards every request, pages and API alike. `/api/*` is rewritten to the
 * backend, so leaving it open would expose the whole API to anyone on the LAN. */
export function middleware(request: NextRequest) {
  if (!gateEnabled() || request.cookies.get(GATE_COOKIE)?.value === gateToken()) {
    return NextResponse.next();
  }

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Accès verrouillé." }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = request.nextUrl.pathname === "/"
    ? ""
    : `?from=${encodeURIComponent(request.nextUrl.pathname + request.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|login|gate).*)"],
};
