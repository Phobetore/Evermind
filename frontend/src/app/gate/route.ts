import { NextResponse, type NextRequest } from "next/server";
import { GATE_COOKIE, GATE_MAX_AGE, gatePassword, gateToken } from "@/lib/gate";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));

  if (body?.password !== gatePassword()) {
    // Small delay: makes hammering the gate over the network pointless.
    await new Promise((resolve) => setTimeout(resolve, 600));
    return NextResponse.json({ error: "Mot de passe incorrect." }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(GATE_COOKIE, gateToken(), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: GATE_MAX_AGE,
  });
  return response;
}

/** Sign out: drop the cookie. */
export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  response.cookies.delete(GATE_COOKIE);
  return response;
}
