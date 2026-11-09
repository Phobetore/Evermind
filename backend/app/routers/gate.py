"""Signing in with the access password, and out again."""

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from .. import gate

router = APIRouter(prefix="/api/gate", tags=["gate"])


class LoginRequest(BaseModel):
    password: str


def _keep(response: Response, token: str, request: Request) -> None:
    # Secure only over https: a phone on http://192.168.x.y would never send it back.
    response.set_cookie(gate.SESSION_COOKIE, token, max_age=gate.COOKIE_MAX_AGE,
                        secure=request.url.scheme == "https", httponly=True, samesite="lax")


def _forget(response: Response) -> Response:
    response.delete_cookie(gate.SESSION_COOKIE, httponly=True, samesite="lax")
    return response


@router.get("")
async def gate_state(request: Request, response: Response) -> dict:
    token = request.cookies.get(gate.SESSION_COOKIE)
    authenticated = await gate.session_is_open(token)
    if authenticated:
        # The interface asks on every opening, so a device in use never has to sign in again.
        _keep(response, token, request)
    return {"enabled": gate.enabled(), "authenticated": authenticated}


@router.post("", status_code=204)
async def login(payload: LoginRequest, request: Request) -> Response:
    if not gate.enabled():
        return Response(status_code=204)
    address = gate.counted_as(request.client.host if request.client else "unknown")
    if wait := gate.retry_after(address):
        return JSONResponse({"error": "Too many attempts.", "kind": "rate_limited"},
                            status_code=429, headers={"Retry-After": str(wait)})
    if not gate.password_matches(payload.password):
        gate.count_failure(address)
        return JSONResponse({"error": "Wrong password.", "kind": "wrong_password"},
                            status_code=401)
    gate.forget_failures(address)
    response = Response(status_code=204)
    _keep(response, await gate.open_session(), request)
    return response


@router.delete("", status_code=204)
async def logout(request: Request) -> Response:
    await gate.end_session(request.cookies.get(gate.SESSION_COOKIE))
    return _forget(Response(status_code=204))


@router.delete("/sessions", status_code=204)
async def logout_everywhere() -> Response:
    await gate.end_all_sessions()
    return _forget(Response(status_code=204))
