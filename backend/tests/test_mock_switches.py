"""The fake model's switches, which a conversation turns on by saying them: each does what it says
alone, and none undoes another, whether it acts on the replies or on the memory."""

import importlib.util
import json
import sys
import threading
import time
from pathlib import Path

import httpx
import pytest

MOCK = Path(__file__).resolve().parents[2] / "scripts" / "mock_llm.py"
CHAT = "You are Vane in a story told to Alex."
EXTRACT = "You are the memory-keeper of a roleplay between Alex (the player) and Vane."
CONSOLIDATE = ("You are the memory-keeper of a roleplay between Alex and Vane. The list of recorded "
               "facts has grown long and needs consolidating.")
SLOW = 0.5


@pytest.fixture(scope="module")
def mock():
    saved = sys.argv
    sys.argv = ["mock_llm.py"]  # its port comes from the command line, which is pytest's here
    try:
        spec = importlib.util.spec_from_file_location("mock_llm_under_test", MOCK)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.argv = saved
    module.WORD_DELAY = 0
    module.SLOW_MEMORY_FOR = SLOW
    server = module.Server(("127.0.0.1", 0), module.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}/v1/chat/completions"
    server.shutdown()
    server.server_close()


def ask(url: str, system: str, said: str) -> dict:
    """What the mock answered a request whose story says ``said``: its status, words, reasoning,
    how it ended, and how long it took."""
    began = time.monotonic()
    body = {"model": "evermind-demo", "stream": True, "messages": [
        {"role": "system", "content": system}, {"role": "user", "content": f"(turn 3) {said}"}]}
    text = reasoning = ""
    finish = None
    # Read as the server does, to its last line: the stream sends no length, and stays open.
    with httpx.stream("POST", url, json=body, timeout=10) as response:
        if response.status_code != 200:
            return {"status": response.status_code, "took": time.monotonic() - began}
        for line in response.iter_lines():
            if line == "data: [DONE]":
                break
            if not line.startswith("data: "):
                continue
            choice = json.loads(line[6:])["choices"][0]
            text += choice["delta"].get("content", "")
            reasoning += choice["delta"].get("reasoning_content", "")
            finish = choice.get("finish_reason") or finish
    took = time.monotonic() - began
    return {"status": 200, "text": text.strip(), "reasoning": bool(reasoning), "finish": finish,
            "took": took}


def an_ordinary_reply(answer: dict) -> bool:
    return answer["status"] == 200 and len(answer["text"].split()) > 10 and answer["finish"] == "stop"


def facts_of(answer: dict) -> list[str]:
    assert answer["status"] == 200, answer
    return [f["content"] for f in json.loads(answer["text"])["facts"]]


def a_quick_memory(answer: dict) -> bool:
    return answer["took"] < SLOW and len(facts_of(answer)) == 2


def reasons_only(answer):
    return answer["status"] == 200 and answer["text"] == "" and answer["reasoning"] and answer["finish"] == "length"


def hits_ceiling(answer):
    return answer["status"] == 200 and len(answer["text"].split()) == 6 and answer["finish"] == "length"


def withholds(answer):
    return answer["status"] == 200 and answer["text"] == "" and answer["finish"] == "content_filter"


CHAT_SWITCHES = {"MOCK_REASONS_ONLY": reasons_only, "MOCK_HITS_CEILING": hits_ceiling,
                 "MOCK_WITHHOLDS": withholds}


@pytest.mark.parametrize("switch", sorted(CHAT_SWITCHES))
def test_a_switch_of_the_replies_alone_leaves_the_memory_be(mock, switch):
    assert CHAT_SWITCHES[switch](ask(mock, CHAT, switch))
    assert a_quick_memory(ask(mock, EXTRACT, switch))


def test_forgetting_alone_refuses_the_memory_and_leaves_the_replies_be(mock):
    assert ask(mock, EXTRACT, "MOCK_FORGETS")["status"] == 500
    assert ask(mock, CONSOLIDATE, "MOCK_FORGETS")["status"] == 500
    assert an_ordinary_reply(ask(mock, CHAT, "MOCK_FORGETS"))


def test_a_slow_memory_alone_is_slow_and_leaves_the_replies_be(mock):
    extracted = ask(mock, EXTRACT, "MOCK_SLOW_MEMORY")
    assert extracted["took"] >= SLOW
    assert facts_of(extracted) == ["Turn 3 happened (MOCK_SLOW_MEMORY)."]
    assert facts_of(ask(mock, CONSOLIDATE, "MOCK_SLOW_MEMORY")) == ["The whole story so far, in one line."]
    reply = ask(mock, CHAT, "MOCK_SLOW_MEMORY")
    assert an_ordinary_reply(reply) and reply["took"] < SLOW


def test_a_slow_memory_that_forgets_is_refused_after_its_wait(mock):
    refused = ask(mock, EXTRACT, "MOCK_SLOW_MEMORY MOCK_FORGETS")
    assert (refused["status"], refused["took"] >= SLOW) == (500, True)


@pytest.mark.parametrize("switch", sorted(CHAT_SWITCHES))
@pytest.mark.parametrize("memory", ["MOCK_FORGETS", "MOCK_SLOW_MEMORY"])
def test_a_switch_of_the_replies_and_one_of_the_memory_each_do_their_own(mock, switch, memory):
    said = f"{switch} {memory}"
    reply = ask(mock, CHAT, said)
    assert CHAT_SWITCHES[switch](reply) and reply["took"] < SLOW
    extracted = ask(mock, EXTRACT, said)
    if memory == "MOCK_FORGETS":
        assert extracted["status"] == 500
    else:
        assert extracted["took"] >= SLOW
        assert facts_of(extracted) == ["Turn 3 happened (MOCK_SLOW_MEMORY)."]
