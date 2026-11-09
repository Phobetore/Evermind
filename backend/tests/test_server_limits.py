"""What the server takes from a client before any route, password included, sees the request.

Against a real server on the loopback, since it happens below the application: a request's line
and headers are capped, and a client that leaves the server waiting is cut off.
"""

import logging
import socket
import threading
import time

import pytest
import uvicorn

from app import server

KB = 1024
MB = 1024 * KB
DEADLINE = 0.5


async def echo(scope, receive, send):
    """Answers with the body it was sent, or at once on /early, the body left unread, or on /stream
    with an answer that goes on until the client leaves, as a turn's does."""
    if scope["path"] == "/stream":
        await send({"type": "http.response.start", "status": 200, "headers": []})
        while (await receive())["type"] != "http.disconnect":
            pass
        return
    body = b""
    while scope["path"] != "/early":
        message = await receive()
        body += message.get("body", b"")
        if not message.get("more_body"):
            break
    await send({"type": "http.response.start", "status": 200,
                "headers": [(b"content-length", str(len(body)).encode())]})
    await send({"type": "http.response.body", "body": body})


@pytest.fixture()
def address(monkeypatch):
    monkeypatch.setattr(server, "WAIT_SECONDS", DEADLINE)
    running = uvicorn.Server(uvicorn.Config(echo, host="127.0.0.1", port=0, http=server.Protocol,
                                            lifespan="off", log_config=None))
    thread = threading.Thread(target=running.run, daemon=True)
    thread.start()
    for _ in range(500):
        if running.started:
            break
        time.sleep(0.01)
    yield running.servers[0].sockets[0].getsockname()[:2]
    running.should_exit = True
    thread.join(10)


def connect(address) -> socket.socket:
    return socket.create_connection(address, timeout=5)


def send(sock: socket.socket, *pieces: bytes, pause: float = 0) -> bool:
    """Whether every piece went out before the server closed the connection."""
    try:
        for piece in pieces:
            sock.sendall(piece)
            time.sleep(pause)
    except OSError:
        return False
    return True


def response(sock: socket.socket) -> bytes:
    """The status line and body of one answer, b"" for a connection closed without one. A server
    that neither answers nor closes makes it time out."""
    data = b""
    try:
        while b"\r\n\r\n" not in data and (chunk := sock.recv(65536)):
            data += chunk
        head, _, body = data.partition(b"\r\n\r\n")
        length = int(next((line.split(b":")[1] for line in head.split(b"\r\n")
                           if line.lower().startswith(b"content-length:")), b"0"))
        while len(body) < length and (chunk := sock.recv(65536)):
            body += chunk
    except (ConnectionResetError, ConnectionAbortedError):
        return b""
    return head.split(b"\r\n")[0] + (b" " + body if body else b"")


def refused(answer: bytes) -> bool:
    """A 400, with as much of its body as came with the head, or a connection closed without one."""
    return answer == b"" or answer.startswith(b"HTTP/1.1 400 Bad Request")


def closed(sock: socket.socket) -> float:
    """How long the server took to close the connection, which it must do on its own."""
    started = time.monotonic()
    try:
        while sock.recv(65536):
            pass
    except (ConnectionResetError, ConnectionAbortedError):
        pass
    return time.monotonic() - started


def test_a_request_is_answered(address):
    with connect(address) as sock:
        send(sock, b"POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello")
        assert response(sock) == b"HTTP/1.1 200 OK hello"


@pytest.mark.parametrize("start", [b"GET / HTTP/1.1\r\nHost: x\r\nX-Fill: ", b"GET /?q="],
                         ids=["headers", "request line"])
def test_a_head_past_16_kb_is_refused(address, start):
    """uvicorn's default parser keeps all of it, for as long as the client goes on."""
    with connect(address) as sock:
        send(sock, start, b"a" * 20 * KB)
        time.sleep(0.3)  # read late, as on a loaded machine: the 400's body has come with its head
        assert refused(response(sock))


def test_a_megabyte_of_headers_is_refused_and_others_are_still_answered(address, caplog):
    """The security review's request, which was answered 200, and logs nothing on the way."""
    with connect(address) as sock:
        send(sock, b"GET / HTTP/1.1\r\nHost: x\r\n", b"X-Fill: " + b"a" * (MB - 10) + b"\r\n\r\n")
        assert refused(response(sock))
    with connect(address) as sock:
        send(sock, b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
        assert response(sock) == b"HTTP/1.1 200 OK"
    assert [r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR] == []


def test_a_request_that_stops_coming_is_cut_off(address):
    with connect(address) as sock:
        send(sock, b"GET / HTTP/1.1\r\nHost: x\r\n")
        assert closed(sock) < DEADLINE + 1


def test_a_connection_that_asks_nothing_is_cut_off(address):
    with connect(address) as sock:
        assert closed(sock) < DEADLINE + 1


def test_a_request_sent_a_byte_at_a_time_is_cut_off_all_the_same(address):
    """The deadline is for the whole head: each byte that comes does not start it again."""
    head = b"GET / HTTP/1.1\r\nHost: x\r\nX-Slow: " + b"a" * 40
    with connect(address) as sock:
        assert not send(sock, *[head[i:i + 1] for i in range(len(head))], pause=0.1)


def test_a_body_slower_than_the_deadline_is_read_whole(address):
    """An upload over a slow Wi-Fi takes what it takes: only the head has a deadline."""
    with connect(address) as sock:
        assert send(sock, b"POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 15\r\n\r\n",
                    *[b"abcde"] * 3, pause=DEADLINE)
        assert response(sock) == b"HTTP/1.1 200 OK abcdeabcdeabcde"


def test_each_request_on_a_kept_connection_has_the_deadline(address):
    with connect(address) as sock:
        send(sock, b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
        assert response(sock) == b"HTTP/1.1 200 OK"
        send(sock, b"GET / HTTP/1.1\r\n")
        assert closed(sock) < DEADLINE + 1


def test_a_body_still_coming_after_the_answer_is_cut_off(address):
    """As a locked request's is: the answer has gone, and nothing reads what follows."""
    with connect(address) as sock:
        send(sock, b"POST /early HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n")
        assert response(sock) == b"HTTP/1.1 200 OK"
        assert not send(sock, *[b"a"] * 40, pause=0.1)


@pytest.mark.parametrize("path", ["/early", "/stream"], ids=["answered", "answering"])
def test_a_body_refused_once_answered_closes_the_connection(address, caplog, path):
    """A chunk size that is no number, where a 400 can no longer go out: h11 would go on taking
    all that comes, unbounded and with a traceback each time, as the final review found."""
    with connect(address) as sock:
        send(sock, f"POST {path} HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n".encode())
        assert response(sock) == b"HTTP/1.1 200 OK"
        send(sock, b"zz\r\n")
        assert closed(sock) < DEADLINE
    assert [r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR] == []
