"""Logging in with the access password, and out again.

All of it is public except logging out every device, which GateMiddleware
keeps behind a session like the rest of the API.
"""

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from .. import gate

router = APIRouter(prefix="/api/gate", tags=["gate"])


class LoginRequest(BaseModel):
    password: str


def _store(request: Request) -> gate.GateStore:
    return request.app.state.gate


@router.get("")
async def gate_state(request: Request) -> dict:
    store = _store(request)
    token = request.cookies.get(gate.SESSION_COOKIE)
    return {"enabled": store.enabled, "authenticated": store.enabled and store.check(token)}


@router.post("", status_code=204)
async def login(payload: LoginRequest, request: Request) -> Response:
    store = _store(request)
    if not store.enabled:
        return Response(status_code=204)
    # Behind a reverse proxy every attempt seems to come from the proxy, and so
    # shares one limit, unless the proxy sends X-Forwarded-For and uvicorn
    # trusts it: it does from 127.0.0.1, and from anywhere else only once
    # FORWARDED_ALLOW_IPS names the proxy.
    key = request.client.host if request.client else "unknown"
    wait = store.limiter.retry_after(key)
    if wait > 0:
        return JSONResponse({"error": "Too many attempts.", "kind": "rate_limited"},
                            status_code=429, headers={"Retry-After": str(wait)})
    # The attempt counts as a failure from here, before the password is
    # checked, and nothing has awaited since the limit was: the check takes a
    # while, and attempts sent all at once must not all get past the limit
    # before the first of them is counted.
    store.limiter.record_failure(key)
    token = await store.login(payload.password)
    if token is None:
        await gate.failure_pause()
        return JSONResponse({"error": "Wrong password.", "kind": "wrong_password"},
                            status_code=401)
    # The right password forgets the address's failures, this one included.
    store.limiter.reset(key)
    response = Response(status_code=204)
    gate.set_session_cookie(response, token, secure=request.url.scheme == "https")
    return response


@router.delete("", status_code=204)
async def logout(request: Request) -> Response:
    """Public, so that logging out with a session that has already ended, or
    with none, still clears the cookie instead of failing."""
    await _store(request).logout(request.cookies.get(gate.SESSION_COOKIE))
    response = Response(status_code=204)
    gate.clear_session_cookie(response)
    return response


@router.delete("/sessions", status_code=204)
async def logout_everywhere(request: Request) -> Response:
    await _store(request).logout_all()
    response = Response(status_code=204)
    gate.clear_session_cookie(response)
    return response
