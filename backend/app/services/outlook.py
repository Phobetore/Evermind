"""What a conversation's next turn would read, for each AI and each way, worked out ahead of it.

The prompt is built as the turn builds it, from what the turn reads (chat_service.prepare), but
no model is asked and no vector is made: the facts go by recency, and the past passages a turn
may add are counted at their budget by a stand-in of that cost. What the page shows of a
conversation's reading, and what it says another AI or another way would read, come from here.
"""

import aiosqlite

from ..errors import NotFoundError
from ..prompting import embeddings, ways
from ..prompting.engine import build_chat_payload
from ..repositories import conversations as convo_repo
from ..repositories import models as models_repo
from ..repositories import ways as ways_repo
from . import ai_call, chat_service

# What a way that leaves the reply's room to the AI is counted with, with no AI to ask.
_NO_AI = {"reply_cap_mode": "auto"}


def _connection(ai: tuple[dict, dict] | None, room: int | None) -> dict:
    """What the engine is given for this AI under a way's room, as the turn gives it; with no AI,
    the window Evermind assumes and the room the way asks."""
    if ai is not None:
        model, service = ai
        return ai_call.for_engine(ai_call.call_for(model, service, room=room))
    window = ai_call.ASSUMED_WINDOW
    reserve = ai_call.ceiling(_NO_AI, anthropic=False, family="generic", room=room,
                              window=window).reserve
    return {"context_size": window, "max_tokens": reserve,
            "margin": ai_call.margin_for({}, window), "token_ratio": None}


def _entry(story: dict, convo: dict, ai: tuple[dict, dict] | None, way: dict) -> dict:
    reminders = {key: way[key] for key in ways.REMINDER_FIELDS}
    connection = _connection(ai, way["reply_room"])
    settings = story["settings"]

    def build(passages=None):
        return build_chat_payload(
            character=story["character"], persona=story["persona"], conversation=convo,
            messages=story["messages"], connection=connection,
            global_instructions=settings.get("global_instructions") or "",
            memories=story["memories"], lore_entries=story["lore_entries"],
            reply_length=way["reply_length"], history_limit=way["history_limit"],
            relevance_scores=None, retrieved_passages=passages, reminders=reminders)

    stats = build().stats
    if stats["messages_included"] < stats["messages_total"] and embeddings.installed():
        # The turn would look for passages of what is no longer read: counted at their budget.
        budget = ways.passage_budget(reminders, stats["budget"])
        if budget > 0:
            stats = build(ways.stand_in_passages(budget)).stats
    model = ai[0] if ai is not None else None
    room = way["reply_room"]
    cap_short = None
    if (model is not None and room is not None and model.get("reply_cap_mode") == "fixed"
            and model["reply_cap_tokens"] < room):
        cap_short = model["reply_cap_tokens"]
    return {
        "model_id": model["id"] if model is not None else None,
        "play_style": way["id"],
        **ways.outlook_entry(
            stats, ratio=connection.get("token_ratio") or 1.0,
            history_limit=way["history_limit"],
            # A way that leaves the room to the AI: what the prompt keeps for the reply.
            reply_room=room if room is not None else connection["max_tokens"],
            cap_short=cap_short),
        # What the turn would keep for the reply (its meta.context.reply_room): the way's room
        # as this AI is given it, its thinking, a ceiling it is sent or none.
        "reply_kept": connection["max_tokens"],
    }


async def outlook(db: aiosqlite.Connection, convo_id: str, *, only_current: bool) -> dict:
    """{"current": the conversation's AI under its way, overrides applied, "models": every AI
    under that way, "ways": every way with that AI}; the two lists empty when only the current
    entry is asked for."""
    convo = await convo_repo.get(db, convo_id, with_messages=False)
    if not convo:
        raise NotFoundError("Conversation not found.", "conversation")
    story = await chat_service.prepare(db, convo)
    settings = story["settings"]
    way = ways.way_for(convo, settings)
    ai = await models_repo.resolve(db, convo.get("model_id"))
    current = {**_entry(story, convo, ai, way), "way": way}
    if only_current:
        return {"current": current, "models": [], "ways": []}
    every_ai = await models_repo.every_row(db) if ai is not None else []
    return {
        "current": current,
        "models": [_entry(story, convo, other, way) for other in every_ai],
        "ways": [{**_entry(story, convo, ai, other), "way": other}
                 for other in ways_repo.every(settings)],
    }
