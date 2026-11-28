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


def ask(url: str, system: str, said: str, *, usage: bool = False) -> dict:
    """What the mock answered a request whose story says ``said``: its status, words, reasoning,
    how it ended, its count, and how long it took. ``usage`` asks for its count, as Evermind
    does."""
    began = time.monotonic()
    body = {"model": "evermind-demo", "stream": True, "messages": [
        {"role": "system", "content": system}, {"role": "user", "content": f"(turn 3) {said}"}]}
    if usage:
        body["stream_options"] = {"include_usage": True}
    text = reasoning = ""
    finish = counted = None
    # Read as the server does, to its last line: the stream sends no length, and stays open.
    with httpx.stream("POST", url, json=body, timeout=10) as response:
        if response.status_code != 200:
            return {"status": response.status_code, "took": time.monotonic() - began,
                    "error": json.loads(response.read())["error"]["message"]}
        for line in response.iter_lines():
            if line == "data: [DONE]":
                break
            if not line.startswith("data: "):
                continue
            event = json.loads(line[6:])
            counted = event.get("usage", counted)
            choice = event["choices"][0]
            text += choice["delta"].get("content", "")
            reasoning += choice["delta"].get("reasoning_content", "")
            finish = choice.get("finish_reason") or finish
    took = time.monotonic() - began
    return {"status": 200, "text": text, "reasoning": reasoning, "finish": finish,
            "usage": counted, "took": took, "read": len(system) + len(f"(turn 3) {said}")}


def an_ordinary_reply(answer: dict) -> bool:
    return answer["status"] == 200 and len(answer["text"].split()) > 10 and answer["finish"] == "stop"


def counted_as_read(answer: dict) -> bool:
    """The count a server gives when asked: what it read and wrote, a third of their characters."""
    written = len(answer["text"]) + len(answer["reasoning"])
    prompt, completion = answer["read"] // 3, written // 3
    return answer["usage"] == {"prompt_tokens": prompt, "completion_tokens": completion,
                               "total_tokens": prompt + completion}


def facts_of(answer: dict) -> list[str]:
    assert answer["status"] == 200, answer
    return [f["content"] for f in json.loads(answer["text"])["facts"]]


def a_quick_memory(answer: dict) -> bool:
    return answer["took"] < SLOW and len(facts_of(answer)) == 2


def reasons_only(answer):
    return (answer["status"] == 200 and answer["text"] == "" and bool(answer["reasoning"])
            and answer["finish"] == "length")


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


def test_a_count_is_given_only_when_asked_for(mock):
    asked = ask(mock, CHAT, "Hello", usage=True)
    assert an_ordinary_reply(asked) and counted_as_read(asked)
    assert ask(mock, CHAT, "Hello")["usage"] == {"total_tokens": 42}
    thought = ask(mock, CHAT, "MOCK_REASONS_ONLY", usage=True)
    assert thought["usage"]["completion_tokens"] == len(thought["reasoning"]) // 3 > 0


def test_a_server_that_never_counts(mock):
    for usage in (True, False):
        answer = ask(mock, CHAT, "MOCK_NO_USAGE", usage=usage)
        assert an_ordinary_reply(answer) and answer["usage"] is None


def test_a_server_that_refuses_to_be_asked_for_its_count(mock):
    refused = ask(mock, CHAT, "MOCK_REFUSES_USAGE_OPTION", usage=True)
    assert refused["status"] == 400
    assert refused["error"] == "Unrecognized request argument supplied: stream_options"
    assert an_ordinary_reply(ask(mock, CHAT, "MOCK_REFUSES_USAGE_OPTION"))


def test_a_server_that_says_how_much_it_read(mock):
    answer = ask(mock, CHAT, "MOCK_READS_4090", usage=True)
    assert an_ordinary_reply(answer) and answer["usage"]["prompt_tokens"] == 4090
    assert answer["usage"]["total_tokens"] == 4090 + answer["usage"]["completion_tokens"]


def test_a_server_that_refuses_a_prompt_longer_than_it_reads(mock):
    long = ask(mock, CHAT, "MOCK_TOO_LONG_10", usage=True)
    read = ask(mock, CHAT, "MOCK_TOO_LONG_10 MOCK_READS_9000", usage=True)["status"]
    assert long["status"] == 400 and read == 400
    words = ask(mock, CHAT, "MOCK_TOO_LONG_10 MOCK_READS_9500")["error"]
    assert words == ("This model's maximum context length is 10 tokens. However, you requested "
                     "9500 tokens.")
    assert an_ordinary_reply(ask(mock, CHAT, "MOCK_TOO_LONG_100000", usage=True))


def events_of(url: str, said: str) -> list[dict]:
    """Every object of the stream the mock sent, as a server's own; the count is asked for."""
    body = {"model": "evermind-demo-fast", "stream": True, "stream_options": {"include_usage": True},
            "messages": [{"role": "system", "content": CHAT}, {"role": "user", "content": said}]}
    events = []
    # To its last line, as the server reads it: the stream sends no length, and stays open.
    with httpx.stream("POST", url, json=body, timeout=10) as response:
        for line in response.iter_lines():
            if line == "data: [DONE]":
                break
            if line.startswith("data: "):
                events.append(json.loads(line[6:]))
    return events


def test_a_cost_is_said_as_openrouter_says_it(mock):
    assert ask(mock, CHAT, "MOCK_COSTS_2100", usage=True)["usage"]["cost"] == 0.0021
    byok = ask(mock, CHAT, "MOCK_BYOK_12300", usage=True)["usage"]
    assert byok["cost"] == 0
    assert byok["cost_details"]["upstream_inference_cost"] == 0.0123
    assert "cost" not in ask(mock, CHAT, "Hello", usage=True)["usage"]


def test_each_piece_names_its_generation_and_the_model_asked(mock):
    first, second = events_of(mock, "Hello"), events_of(mock, "Hello")
    for events in (first, second):
        assert len(events) > 2
        assert {e["id"] for e in events} == {events[0]["id"]}
        assert events[0]["id"].startswith("gen-mock-")
        assert {e["model"] for e in events} == {"evermind-demo-fast"}
    assert first[0]["id"] != second[0]["id"]
