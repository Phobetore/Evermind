"""Tiny OpenAI-compatible mock LLM server for trying Evermind without a real model.

    python scripts/mock_llm.py [port]

Then add a connection in Evermind: OpenAI-compatible, http://localhost:5599/v1,
model "evermind-demo". It streams a canned roleplay-style reply that echoes
context, so you can validate the whole pipeline (streaming, swipes, summary).
"""

import json
import os
import random
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5599
# Seconds between words. The end-to-end suite sets its own, a little over the
# default: nearly all of its tests only need a reply to exist, and wait for it
# in their setup.
WORD_DELAY = float(os.environ.get("EVERMIND_MOCK_DELAY", "0.045"))
# Seconds between words in a conversation that says SLOWLY. A fixed pace, not a
# multiple of the one above: how slow is slow enough depends on how long a browser
# takes to close one page and open another, and that has nothing to do with how
# quickly the other replies are wanted.
SLOW_WORD_DELAY = 0.6
# Seconds a conversation that says MOCK_FAILS waits before the model refuses, which
# gives a test a turn it can watch before it fails.
FAIL_AFTER = 2.0
# Seconds a conversation that says MOCK_QUIET waits before its first word, as a local
# model does on a long prompt.
QUIET_FOR = 8.0

REPLIES = [
    "*{char} watches you for a moment, weighing something.* Now that is an interesting "
    "way to put it. *A pause.* Go on. I would rather hear the rest before I decide.",
    "*The silence that follows is not a comfortable one.* You should not have said that. "
    "*{char} looks toward the window, and does not look back.* But we are here now, so "
    "we may as well go the whole way.",
    "*A short laugh, entirely without warmth.* Really. *Then, quieter:* Fine. I will "
    "follow you in this. But the first time it goes wrong, you are the one explaining it.",
]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quiet
        pass

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            body = json.dumps({"data": [{"id": "evermind-demo"}, {"id": "evermind-demo-fast"}]})
            self._json(body)
        else:
            self._json(json.dumps({"ok": True}))

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        payload = json.loads(self.rfile.read(length) or b"{}")
        if not self.path.rstrip("/").endswith("/chat/completions"):
            self._json(json.dumps({"error": {"message": "unknown endpoint"}}), status=404)
            return

        if "MOCK_FAILS" in json.dumps(payload):
            time.sleep(FAIL_AFTER)
            self._json(json.dumps({"error": {"message": "The mock was told to fail."}}), status=500)
            return

        system = next((m["content"] for m in payload.get("messages", [])
                       if m.get("role") == "system"), "")
        char = "The narrator"
        for line in system.splitlines():
            if line.startswith("You are ") and " in " in line:
                char = line.removeprefix("You are ").split(" in ")[0].strip()
                break

        if "ghost-writing" in system:
            reply = ("*I take a breath and hold their gaze.* All right. I will play this "
                     "straight, on one condition: you go first.")
        elif "card-writer" in system:
            # card assistant request -> full card JSON
            reply = json.dumps({
                "name": "Nyra the Cartographer",
                "tagline": "She sells maps of places that do not exist yet.",
                "description": "Nyra draws prophetic maps in a shop that stands on a "
                               "different street every night. {{user}} is her only "
                               "regular customer.",
                "personality": "sly, enigmatic, playful",
                "scenario": "{{user}} pushes open the shop door on a night of storms.",
                "greeting": "*The ink is still wet on the parchment when she looks "
                            "up.* There you are, {{user}}. I was just about to draw "
                            "your next mistake.",
                "alternate_greetings": ["*The shop is empty, but one map has your "
                                        "name on it.*"],
                "example_dialogues": "<START>\n{{user}}: Are your maps reliable?\n"
                                     "{{char}}: *She smiles.* About as much as you are.",
                "tags": ["fantasy", "mystery"],
            }, ensure_ascii=False)
        elif "memory-keeper" in system:
            # memory extraction request -> strict JSON
            reply = json.dumps({
                "facts": [
                    {"content": f"{char} met the player in a sealed crypt.",
                     "kind": "event"},
                    {"content": f"{char} remains wary of the player.",
                     "kind": "relationship"},
                ],
                "summary": "The player woke the character in a crypt; introductions "
                           "have been made and mistrust still dominates.",
            }, ensure_ascii=False)
        elif "long-term memory" in system:
            reply = ("The player woke the character in a sealed crypt; they have "
                     "exchanged cautious introductions.")
        else:
            reply = random.choice(REPLIES).replace("{char}", char)

        # A conversation that says MOCK_SAYS_word gets a reply of its own, which
        # can be told apart from another's, and which has a definite end.
        says = re.search(r"MOCK_SAYS_(\w+)", json.dumps(payload))
        if says:
            word = says.group(1)
            reply = f"{word} one two three four five six seven eight nine ten end{word}"

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if "MOCK_QUIET" in json.dumps(payload):
            time.sleep(QUIET_FOR)
        # A test that is about what happens *during* a reply needs the
        # reply to still be going when it looks. Rather than tune sleeps
        # against whatever machine is running, it says so in the
        # conversation and this slows right down.
        delay = SLOW_WORD_DELAY if "SLOWLY" in json.dumps(payload) else WORD_DELAY
        for word in reply.split(" "):
            chunk = {"choices": [{"delta": {"content": word + " "}}]}
            self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode())
            self.wfile.flush()
            time.sleep(delay)
        self.wfile.write(b'data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
                         b'"usage":{"total_tokens":42}}\n\n')
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _json(self, body: str, status: int = 200):
        data = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Server(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        # The reader went away, mid-reply or between two requests on a
        # connection it had kept open. Tests do that on purpose (one of them
        # is about what an interrupted reply leaves behind), so it is no error
        # here, and a traceback for each buries a real failure in noise. The
        # system words it differently (broken pipe, connection reset, and on
        # Windows connection aborted), all of them a ConnectionError.
        if isinstance(sys.exc_info()[1], ConnectionError):
            return
        super().handle_error(request, client_address)


if __name__ == "__main__":
    print(f"Mock LLM (OpenAI-compatible) on http://localhost:{PORT}/v1 - model \"evermind-demo\"")
    Server(("127.0.0.1", PORT), Handler).serve_forever()
