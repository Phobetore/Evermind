"""What is sent as a reply ceiling, and the room and window counted, for each mode. Pure: no
database, no network."""

import pytest

from app.services import ai_call
from app.services.ai_call import (
    ASSUMED_WINDOW,
    REPLY_ROOM,
    SIZE_UNTOLD,
    THINKING_ALLOWANCE,
    call_for,
    ceiling,
    for_engine,
    notices,
    reply_room,
    window,
)

ROOMS = [512, 1024, 2048]
OUTS = [None, 1500, 64000]


# One row per cell, every figure worked out by hand (allowance 3072, floor 4096).
AUTO_ROWS = [
    # (reasons, anthropic, family, room, out, sent, reserve)
    (0, True, "anthropic", 512, None, 4096, 4096),
    (0, True, "anthropic", 1024, None, 4096, 4096),
    (0, True, "anthropic", 2048, None, 4096, 4096),
    (0, True, "anthropic", 512, 1500, 1500, 1500),
    (0, True, "anthropic", 1024, 1500, 1500, 1500),
    (0, True, "anthropic", 2048, 1500, 1500, 1500),
    (0, True, "anthropic", 512, 64000, 4096, 4096),
    (0, True, "anthropic", 1024, 64000, 4096, 4096),
    (0, True, "anthropic", 2048, 64000, 4096, 4096),
    (0, False, "generic", 512, None, 512, 512),
    (0, False, "generic", 1024, None, 1024, 1024),
    (0, False, "generic", 2048, None, 2048, 2048),
    (0, False, "generic", 512, 1500, 512, 512),
    (0, False, "generic", 1024, 1500, 1024, 1024),
    (0, False, "generic", 2048, 1500, 1500, 1500),
    (0, False, "generic", 512, 64000, 512, 512),
    (0, False, "generic", 1024, 64000, 1024, 1024),
    (0, False, "generic", 2048, 64000, 2048, 2048),
    (0, False, "openai", 512, None, None, 512),
    (0, False, "openai", 1024, None, None, 1024),
    (0, False, "openai", 2048, None, None, 2048),
    (0, False, "openai", 512, 1500, None, 512),
    (0, False, "openai", 1024, 1500, None, 1024),
    (0, False, "openai", 2048, 1500, None, 1500),
    (0, False, "openai", 512, 64000, None, 512),
    (0, False, "openai", 1024, 64000, None, 1024),
    (0, False, "openai", 2048, 64000, None, 2048),
    (1, True, "anthropic", 512, None, 4096, 4096),
    (1, True, "anthropic", 1024, None, 4096, 4096),
    (1, True, "anthropic", 2048, None, 5120, 5120),
    (1, True, "anthropic", 512, 1500, 1500, 1500),
    (1, True, "anthropic", 1024, 1500, 1500, 1500),
    (1, True, "anthropic", 2048, 1500, 1500, 1500),
    (1, True, "anthropic", 512, 64000, 4096, 4096),
    (1, True, "anthropic", 1024, 64000, 4096, 4096),
    (1, True, "anthropic", 2048, 64000, 5120, 5120),
    (1, False, "generic", 512, None, None, 3584),
    (1, False, "generic", 1024, None, None, 4096),
    (1, False, "generic", 2048, None, None, 5120),
    (1, False, "generic", 512, 1500, None, 1500),
    (1, False, "generic", 1024, 1500, None, 1500),
    (1, False, "generic", 2048, 1500, None, 1500),
    (1, False, "generic", 512, 64000, None, 3584),
    (1, False, "generic", 1024, 64000, None, 4096),
    (1, False, "generic", 2048, 64000, None, 5120),
    (1, False, "openai", 512, None, None, 3584),
    (1, False, "openai", 1024, None, None, 4096),
    (1, False, "openai", 2048, None, None, 5120),
    (1, False, "openai", 512, 1500, None, 1500),
    (1, False, "openai", 1024, 1500, None, 1500),
    (1, False, "openai", 2048, 1500, None, 1500),
    (1, False, "openai", 512, 64000, None, 3584),
    (1, False, "openai", 1024, 64000, None, 4096),
    (1, False, "openai", 2048, 64000, None, 5120),
]


@pytest.mark.parametrize("reasons,anthropic,family,room,out,sent,reserve", AUTO_ROWS)
def test_the_ceiling_table_in_auto(reasons, anthropic, family, room, out, sent, reserve):
    model = {"reply_cap_mode": "auto", "reasons": reasons, "output_read": out}
    got = ceiling(model, anthropic=anthropic, family=family, room=room)
    assert (got.sent, got.reserve) == (sent, reserve)


@pytest.mark.parametrize("mode,reasons,anthropic,family,room,out,sent,reserve", [
    ("fixed", 0, True, "anthropic", 512, None, 1024, 1024),
    ("fixed", 1, True, "anthropic", 2048, 64000, 1024, 1024),
    ("fixed", 0, False, "generic", 2048, 1500, 1024, 1024),
    ("fixed", 1, False, "openai", 512, 1500, 1024, 1024),
    ("unsent", 0, True, "anthropic", 512, None, None, 1024),
    ("unsent", 1, True, "anthropic", 2048, 64000, None, 1024),
    ("unsent", 0, False, "generic", 2048, 1500, None, 1024),
    ("unsent", 1, False, "openai", 1024, 64000, None, 1024),
])
def test_fixed_and_unsent_ignore_the_service_the_room_the_output_and_the_reasoning(
        mode, reasons, anthropic, family, room, out, sent, reserve):
    model = {"reply_cap_mode": mode, "reply_cap_tokens": 1024 if mode == "fixed" else None,
             "reasons": reasons, "output_read": out}
    got = ceiling(model, anthropic=anthropic, family=family, room=room)
    assert (got.sent, got.reserve) == (sent, reserve)


@pytest.mark.parametrize("anthropic,family,room,out,sent,reserve", [
    (True, "anthropic", 512, None, 4096, 4096),        # the room kept is what is sent
    (True, "anthropic", 1024, None, 4096, 4096),       # conception B: 1 024 becomes 4 096
    (False, "generic", 1024, 64000, None, 4096),       # reasons, compatible: nothing sent
    (False, "generic", 1024, 1500, None, 1500),
    (True, "anthropic", 1024, 64000, 4096, 4096),
    (True, "anthropic", 2048, 64000, 5120, 5120),
])
def test_the_ceiling_cells_the_plan_names_for_a_model_that_reasons(
        anthropic, family, room, out, sent, reserve):
    model = {"reply_cap_mode": "auto", "reasons": 1, "output_read": out}
    got = ceiling(model, anthropic=anthropic, family=family, room=room)
    assert (got.sent, got.reserve) == (sent, reserve)


def test_the_cells_the_plan_names_for_the_other_modes():
    auto = {"reply_cap_mode": "auto", "reasons": 0, "output_read": None}
    got = ceiling(auto, anthropic=True, family="anthropic", room=1024)
    assert (got.sent, got.reserve) == (4096, 4096)
    got = ceiling(auto, anthropic=False, family="openai", room=1024)
    assert (got.sent, got.reserve) == (None, 1024)
    fixed = {"reply_cap_mode": "fixed", "reply_cap_tokens": 1024, "reasons": 0}
    got = ceiling(fixed, anthropic=False, family="openai", room=1024)
    assert (got.sent, got.reserve) == (1024, 1024)
    unsent = {"reply_cap_mode": "unsent", "reasons": 1}
    got = ceiling(unsent, anthropic=False, family="generic", room=1024)
    assert (got.sent, got.reserve) == (None, 1024)


def test_the_openai_family_sends_nothing_in_auto_even_when_it_reasons():
    model = {"reply_cap_mode": "auto", "reasons": 1, "output_read": None}
    got = ceiling(model, anthropic=False, family="openai", room=1024)
    assert got.sent is None


@pytest.mark.parametrize("anthropic,family", [(True, "anthropic"), (False, "generic"),
                                              (False, "openai")])
def test_a_model_with_no_word_on_reasoning_is_capped_like_one_that_does_not_reason(
        anthropic, family):
    base = {"reply_cap_mode": "auto", "output_read": 1500}
    for room in ROOMS:
        silent = ceiling({**base, "reasons": None}, anthropic=anthropic, family=family, room=room)
        absent = ceiling(dict(base), anthropic=anthropic, family=family, room=room)
        no = ceiling({**base, "reasons": 0}, anthropic=anthropic, family=family, room=room)
        assert silent == absent == no


def test_the_window_counted():
    def of(family, **fields):
        return window({"context_own": None, "context_read": None, "context_read_kind": None,
                       **fields}, family=family)

    got = of("lmstudio", context_own=9000, context_read=4000, context_read_kind="max")
    assert (got.tokens, got.source) == (9000, "own")
    got = of("openrouter", context_read=32768, context_read_kind="served")
    assert (got.tokens, got.source) == (32768, "read")
    got = of("lmstudio", context_read=131072, context_read_kind="max")
    assert (got.tokens, got.source) == (SIZE_UNTOLD, "size_untold")
    got = of("lmstudio", context_read=2048, context_read_kind="max")
    assert (got.tokens, got.source) == (2048, "size_untold")
    got = of("ollama")
    assert (got.tokens, got.source) == (SIZE_UNTOLD, "size_untold")
    got = of("ollama", context_read=8192, context_read_kind="configured")
    assert (got.tokens, got.source) == (8192, "read")
    got = of("openrouter", context_read=200000, context_read_kind="max")
    assert (got.tokens, got.source) == (200000, "read")
    for family in ("openrouter", "generic"):
        got = of(family)
        assert (got.tokens, got.source) == (ASSUMED_WINDOW, "assumed")
    got = of("llamacpp", context_read=6000, context_read_kind="observed")
    assert (got.tokens, got.source) == (6000, "read")


def test_reply_room_is_the_way_s_of_the_conversation():
    assert [REPLY_ROOM[k] for k in ("short", "medium", "long")] == [512, 1024, 2048]
    assert reply_room({"id": "c"}, {}) == 1024
    # The old setting no longer counts: the way does.
    assert reply_room({"id": "c"}, {"reply_length": "long"}) == 1024
    assert reply_room({"id": "c", "play_style": "light"}, {}) == 512
    assert reply_room({"id": "c", "play_style": "immersive"}, {}) == 2048
    assert reply_room({"id": "c", "play_style": "light",
                       "play_overrides": {"reply_length": "long"}}, {}) == 2048
    offered = {"default_play_style": "immersive"}
    assert reply_room(None, offered) == 2048
    assert reply_room({"id": "c", "play_style": "gone"}, offered) == 2048
    # A way of the person's own that leaves the room to the AI.
    open_room = {"play_styles": {"overrides": {}, "custom": [{"id": "w", "reply_room": None}]}}
    assert reply_room({"id": "c", "play_style": "w"}, open_room) is None


def test_the_engine_is_given_the_room_kept_not_the_ceiling_sent():
    model = {"id": "m", "name": "M", "model": "x", "reply_cap_mode": "auto", "reasons": 1,
             "output_read": None, "context_own": None, "context_read": None,
             "context_read_kind": None}
    service = {"provider": "openai", "base_url": "https://example.test/v1", "api_key": "k",
               "family": "generic", "family_url": None}
    call = call_for(model, service, room=1024)
    assert call["max_tokens"] is None
    assert call["reserve"] == 4096
    assert for_engine(call)["max_tokens"] == 4096
    assert call["max_tokens"] is None          # the call itself is not changed


def test_call_for_carries_what_a_provider_and_the_services_take():
    model = {"id": "m1", "name": "Mine", "model": "claude-x", "reply_cap_mode": "fixed",
             "reply_cap_tokens": 700, "reasons": 1, "output_read": None, "context_own": 20000,
             "context_read": None, "context_read_kind": None, "temperature": 0.7, "top_p": 0.9,
             "frequency_penalty": 0.1, "presence_penalty": None}
    service = {"id": "s1", "provider": "anthropic", "base_url": "https://api.anthropic.com/v1",
               "api_key": "secret", "family": "anthropic", "family_url": None}
    call = call_for(model, service, room=1024)
    assert call == {
        "provider": "anthropic", "base_url": "https://api.anthropic.com/v1",
        "api_key": "secret", "model": "claude-x", "temperature": 0.7, "top_p": 0.9,
        "frequency_penalty": 0.1, "presence_penalty": None, "max_tokens": 700,
        "context_size": 20000, "reserve": 700, "model_id": "m1", "model_name": "Mine",
        "service_id": "s1", "reasons": 1, "margin": 1200, "token_ratio": None,
    }


def test_call_for_reads_the_family_from_the_address_and_a_row_without_one_as_generic():
    model = {"id": "m", "name": "M", "model": "x", "reply_cap_mode": "auto"}
    row = {"provider": "openai", "base_url": "http://192.168.1.9:5000/v1", "api_key": ""}
    call = call_for(model, row, room=1024)
    assert call["context_size"] == ASSUMED_WINDOW   # generic: today's default
    assert call["max_tokens"] == 1024
    on_openai = {"provider": "openai", "base_url": "https://api.openai.com/v1", "api_key": "k"}
    assert call_for(model, on_openai, room=1024)["max_tokens"] is None


def _notice_model(**fields):
    return {"notices_kept": 0, "context_own": None, "context_read": None,
            "context_read_kind": None, "reply_cap_mode": "auto", "reply_cap_tokens": None,
            **fields}


def test_notices():
    assert notices(_notice_model()) == []
    for kind in ("served", "configured"):
        assert notices(_notice_model(context_own=4096, context_read=8192,
                                     context_read_kind=kind)) == ["follow_server"]
    for kind in ("observed", "max"):
        assert notices(_notice_model(context_own=4096, context_read=8192,
                                     context_read_kind=kind)) == []
    assert notices(_notice_model(context_own=8192, context_read=8192,
                                 context_read_kind="served")) == []
    assert notices(_notice_model(context_read=8192, context_read_kind="served")) == []
    assert notices(_notice_model(context_own=4096)) == []
    assert notices(_notice_model(reply_cap_mode="fixed", reply_cap_tokens=1024)) == ["let_evermind"]
    assert notices(_notice_model(reply_cap_mode="fixed", reply_cap_tokens=2047)) == ["let_evermind"]
    assert notices(_notice_model(reply_cap_mode="fixed", reply_cap_tokens=2048)) == []
    assert notices(_notice_model(reply_cap_mode="unsent")) == []
    both = _notice_model(context_own=4096, context_read=8192, context_read_kind="served",
                         reply_cap_mode="fixed", reply_cap_tokens=512)
    assert notices(both) == ["follow_server", "let_evermind"]


def test_notices_kept_silences_them_all():
    both = _notice_model(context_own=4096, context_read=8192, context_read_kind="served",
                         reply_cap_mode="fixed", reply_cap_tokens=512, notices_kept=1)
    assert notices(both) == []


def test_thinking_allowance_is_the_constant_until_it_is_measured():
    assert ai_call.thinking_allowance({}) == THINKING_ALLOWANCE == 3072


@pytest.mark.parametrize("mode,reasons,anthropic,family,room,out,window_tokens,sent,reserve", [
    ("auto", 1, False, "lmstudio", 1024, None, 4096, None, 2048),
    ("auto", 1, False, "generic", 2048, None, 8192, None, 4096),
    ("auto", 1, False, "generic", 2048, None, 16384, None, 5120),     # not bounded
    ("auto", 1, True, "anthropic", 1024, None, 4096, 2048, 2048),
    ("auto", 1, True, "anthropic", 1024, 64000, 200000, 4096, 4096),  # not bounded
    ("auto", 0, False, "generic", 2048, None, 2048, 1024, 1024),
    ("auto", 0, False, "generic", 1024, None, 16384, 1024, 1024),     # not bounded
    ("auto", None, False, "openai", 2048, None, 2048, None, 1024),
    ("auto", 0, True, "anthropic", 1024, None, 4096, 2048, 2048),
    ("auto", 1, False, "generic", 1024, 1500, 4096, None, 1500),      # the output read is lower
    ("fixed", 1, False, "generic", 1024, None, 4096, 3000, 3000),     # the person's own figure
    ("unsent", 1, False, "ollama", 1024, None, 1024, None, 1024),
])
def test_in_auto_the_reply_never_takes_more_than_half_the_window(
        mode, reasons, anthropic, family, room, out, window_tokens, sent, reserve):
    model = {"reply_cap_mode": mode, "reply_cap_tokens": 3000 if mode == "fixed" else None,
             "reasons": reasons, "output_read": out}
    got = ceiling(model, anthropic=anthropic, family=family, room=room, window=window_tokens)
    assert (got.sent, got.reserve) == (sent, reserve)


def test_a_reasoning_model_on_a_server_that_does_not_say_its_size_leaves_room_for_the_story():
    model = {"id": "m", "name": "M", "model": "x", "reply_cap_mode": "auto", "reasons": 1,
             "output_read": None, "context_own": None, "context_read": 32768,
             "context_read_kind": "max"}
    service = {"provider": "openai", "base_url": "http://localhost:1234/v1", "api_key": "",
               "family": "lmstudio", "family_url": None}
    call = call_for(model, service, room=1024)
    assert call["context_size"] == 4096
    assert call["reserve"] == 2048
    assert call["max_tokens"] is None
    assert for_engine(call)["max_tokens"] == 2048
    # What this buys: 1848 tokens for the prompt, where the engine used to keep its floor of 512.
    assert 4096 - 2048 - 200 == 1848
