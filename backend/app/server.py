"""How the server reads a request, before any route or the password sees it."""

import asyncio

import h11
from uvicorn.protocols.http.h11_impl import H11Protocol

# A browser sends a request's line and headers at once: this leaves room for a poor Wi-Fi.
WAIT_SECONDS = 20


class Protocol(H11Protocol):
    """h11, which refuses a request's line and headers past 16 KB where httptools (uvicorn's pick
    when installed) keeps them all, plus a deadline neither has: a connection that leaves the
    server waiting, for the rest of a request's head or for a body after its answer, is closed."""

    _deadline: asyncio.TimerHandle | None = None

    def connection_made(self, transport):
        super().connection_made(transport)
        self._watch()

    def data_received(self, data):
        if self.transport.is_closing():
            return  # what follows a refused head: h11 would refuse it again, with a traceback
        super().data_received(data)
        self._watch()

    def connection_lost(self, exc):
        if self._deadline is not None:
            self._deadline.cancel()
        super().connection_lost(exc)

    def send_400_response(self, msg):
        if self.conn.our_state in (h11.IDLE, h11.SEND_RESPONSE):
            super().send_400_response(msg)
        else:  # an answer has started and h11 takes no 400: raising would leave the connection open
            self.transport.close()

    def _watch(self):
        waiting = self.conn.their_state is h11.IDLE or self.conn.our_state is h11.DONE
        if waiting and self._deadline is None:
            self._deadline = self.loop.call_later(WAIT_SECONDS, self.timeout_keep_alive_handler)
        elif not waiting and self._deadline is not None:
            self._deadline.cancel()
            self._deadline = None
