"""The security headers every answer of the server carries: the content security policy, what
the browser tells other sites of the app's address, and that it guesses no type of its own."""

from starlette.types import ASGIApp, Message, Receive, Scope, Send

# One directive a line, each with its reason, rather than one long string.
CONTENT_SECURITY_POLICY = "; ".join((  # noqa: FLY002
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",                          # React sets styles through the DOM, which this allows
    "img-src 'self' data: blob: https:",         # https: for an image of another site, on a tap only
    "font-src 'self' data:",                     # Vite writes small files into the CSS as data:
    # The update check (lib/releases.ts), and the card sites the browser reads when a card is
    # imported by its link (plan (c)): named one by one, never https: alone. img-src https:
    # already lets a script that slipped through ask any site for an address, its data in the
    # address; connect-src https: would further let it send a body and read every answer CORS
    # allows. Naming the hosts keeps those two out, nothing more.
    ("connect-src 'self' https://api.github.com https://gateway.chub.ai https://avatars.charhub.io"
     " https://realm.risuai.net"),
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
))

# No frame-ancestors: people open their self-hosted apps in the frame of a dashboard.
# same-origin rather than no-referrer: no Referer goes to another site either way, but under
# no-referrer the Fetch standard sends "Origin: null" with a write to our own site, which the gate
# refuses; under same-origin a request to Evermind keeps its Origin in every browser.
HEADERS: tuple[tuple[bytes, bytes], ...] = (
    (b"content-security-policy", CONTENT_SECURITY_POLICY.encode()),
    (b"referrer-policy", b"same-origin"),
    (b"x-content-type-options", b"nosniff"),
    # Firefox looks up, without a tap, the host of every link of a page served over http, which
    # Evermind is on a home network: a card's link would tell its author when the card is read.
    (b"x-dns-prefetch-control", b"off"),
)
_NAMES = {name for name, _ in HEADERS}


class SecurityHeaders:
    """Pure ASGI, like the gate: a stream goes out as the app sends it.

    One answer goes out without these headers: the 500 of an exception nothing catches. Starlette
    wraps every middleware that is added in its ServerErrorMiddleware, which writes that answer
    itself (errors.py only catches AppError and RequestValidationError); it is plain text,
    "Internal Server Error", which loads nothing and is no page.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                # Ours replace any that a route set, so that none is ever sent twice.
                kept = [(name, value) for name, value in message.get("headers", [])
                        if name.lower() not in _NAMES]
                message = {**message, "headers": [*kept, *HEADERS]}
            await send(message)

        await self.app(scope, receive, send_with_headers)
