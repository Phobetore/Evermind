"""Builds the provider-agnostic chat payload for one turn, and trims the reply that comes back.

The history is trimmed oldest first, and its latest message always stays. The system prompt is
not trimmed: it drops its example dialogue when it takes too much of the budget. ``post_history``
is the closing block each provider places after the history.
"""

from dataclasses import dataclass, field

from .defaults import DEFAULT_RP_RULES, SCENARIO_RP_RULES
from .lorebook import (
    activated,
    at_a_depth,
    before_the_card,
    depth_of,
    strip_decorators,
    within_budget,
)
from .macros import has_original_macro, substitute, substitute_original
from .tokens import estimate_tokens

# Enough for what someone marked, without another wall of text.
_MAX_PINNED_RESTATED = 8

_POST_HISTORY_REMINDER = (
    "[Stay in character as {{char}}. Write only {{char}}'s next turn. Every line "
    "of dialogue and every action must be a COMPLETE sentence — never leave "
    "{{char}} trailing off mid-thought as a tic, and never END your reply on an "
    "unfinished line or a lone word followed by '...'. Do NOT reuse phrasings, "
    "images or sentence structures from your recent replies — especially not "
    "how they ended; vary them. Move the scene forward with something new. "
    "Never write or decide {{user}}'s actions.]"
)

_BUDGET_MARGIN = 200
_SYSTEM_SHARE_BEFORE_DROPPING_EXAMPLES = 0.6
_MAX_FACTS = 60  # so that a long story cannot crowd out the card
_FACTS_TOKEN_BUDGET = 700       # floor, used on tiny contexts
_MAX_FACTS_TOKEN_BUDGET = 2000  # cap, so facts never dominate the window
_FACTS_BUDGET_SHARE = 0.12      # of the budget, between the two
_LORE_SCAN_MESSAGES = 6
_LORE_TOKEN_BUDGET = 800
_NOTE_DEPTH = 4  # CharacterIn's default, for a character that says nothing of it


@dataclass
class PromptPayload:
    system: str
    messages: list[dict] = field(default_factory=list)
    stop: list[str] = field(default_factory=list)
    post_history: str = ""
    stats: dict = field(default_factory=dict)


def active_content(message: dict) -> str:
    variants = message.get("variants") or [""]
    index = message.get("active_index") or 0
    if not 0 <= index < len(variants):
        index = len(variants) - 1
    return variants[index]


def is_out_of_character(message: dict) -> bool:
    return (message.get("meta") or {}).get("mode") == "ooc"


def select_facts(memories: list[dict], token_budget: int = _FACTS_TOKEN_BUDGET,
                 relevance_scores: dict[str, float] | None = None) -> list[dict]:
    """Which facts get injected: pinned always survive, the rest fill the
    budget by relevance when scores are given, a fact with no vector yet first,
    else newest-first (recency). Returned oldest-first for chronological reading."""
    pinned = [m for m in memories if m.get("is_pinned")]
    others = [m for m in memories if not m.get("is_pinned")]
    if relevance_scores is not None:
        others.sort(key=lambda m: relevance_scores.get(m.get("id"), float("inf")),
                    reverse=True)
    else:
        others.sort(key=lambda m: m.get("source_position", 0), reverse=True)

    kept: list[dict] = []
    budget = token_budget
    for memory in pinned + others:
        if len(kept) >= _MAX_FACTS:
            break
        cost = estimate_tokens(memory.get("content") or "")
        if not memory.get("is_pinned") and cost > budget:
            continue
        budget -= cost
        kept.append(memory)

    kept.sort(key=lambda m: m.get("source_position", 0))
    return kept


def _format_facts(memories: list[dict], token_budget: int = _FACTS_TOKEN_BUDGET,
                  relevance_scores: dict[str, float] | None = None) -> str:
    lines = []
    for memory in select_facts(memories, token_budget, relevance_scores):
        position = memory.get("source_position") or 0
        prefix = f"(turn {position}) " if position else ""
        lines.append(f"- {prefix}{(memory.get('content') or '').strip()}")
    return "\n".join(lines)


def _match_lore_before_cards(entries: list[dict], messages: list[dict]) -> list[dict]:
    """Entries whose keywords appear in the recent turns, whatever the case, in the
    lorebook's order, within the lore token budget."""
    if not entries:
        return []
    recent = sorted(messages, key=lambda m: m.get("position", 0))[-_LORE_SCAN_MESSAGES:]
    text = "\n".join(active_content(m) for m in recent).lower()

    matched = [entry for entry in entries if entry.get("enabled", True)
               and any(key and key.lower() in text for key in entry.get("keys") or [])]
    kept, budget = [], _LORE_TOKEN_BUDGET
    for entry in matched:
        cost = estimate_tokens(entry.get("content") or "")
        if cost > budget:
            continue
        budget -= cost
        kept.append(entry)
    return kept


def match_lore(entries: list[dict], messages: list[dict], rules: int = 1,
               budget: int = _LORE_TOKEN_BUDGET, char_name: str = "Character",
               user_name: str = "User") -> list[dict]:
    """The lorebook entries that reach the prompt. Rules 1, Evermind's from before community
    cards were read whole, are kept as they were, so that an older card gives the prompt it
    gave; rules 2 are those the cards are written for (lorebook.py)."""
    if rules != 2:
        return _match_lore_before_cards(entries, messages)
    if not entries:
        return []
    recent = sorted(messages, key=lambda m: m.get("position", 0))[-_LORE_SCAN_MESSAGES:]
    # Each turn under the name of who speaks, as SillyTavern reads them: a key {{char}} then
    # fires on any of the character's turns, as the cards expect.
    scan = "\n".join(f"{char_name if m.get('role') == 'assistant' else user_name}: {active_content(m)}"
                     for m in recent)

    fired = [{**entry, "content": strip_decorators(entry.get("content") or "")}
             for entry in activated(entries, scan, char_name, user_name)]
    # An entry that is only decorators, or blank, has nothing for the model: kept, it would
    # leave a heading with nothing under it, or an empty gap between two entries.
    return within_budget([entry for entry in fired if entry["content"].strip()], budget)


def _build_system(character: dict, persona: dict | None, summary: str,
                  global_instructions: str, include_examples: bool,
                  char_name: str, user_name: str,
                  memories: list[dict] | None = None,
                  lore: list[dict] | None = None,
                  lore_before: list[dict] | None = None,
                  facts_budget: int = _FACTS_TOKEN_BUDGET,
                  relevance_scores: dict[str, float] | None = None,
                  passages: list[dict] | None = None) -> str:
    is_scenario = character.get("kind") == "scenario"
    sections: list[str] = []

    if is_scenario:
        sections.append(
            f'You are running "{char_name}", an immersive roleplay scenario, for {user_name}.'
        )
    else:
        sections.append(
            f"You are {char_name} in an endless immersive roleplay with {user_name}."
        )

    if lore_before:
        block = "\n\n".join((entry.get("content") or "").strip() for entry in lore_before)
        sections.append(f"### WORLD KNOWLEDGE (background)\n{block}")

    identity: list[str] = []
    if character.get("description"):
        identity.append(character["description"])
    if character.get("personality"):
        label = "Tone and themes" if is_scenario else f"{char_name}'s personality"
        identity.append(f"{label}: {character['personality']}")
    if character.get("scenario"):
        identity.append(f"Current scenario: {character['scenario']}")
    if identity:
        header = "SCENARIO" if is_scenario else f"ABOUT {char_name.upper()}"
        sections.append(f"### {header}\n" + "\n\n".join(identity))

    if persona and (persona.get("name") or persona.get("description")):
        body = persona.get("description") or ""
        sections.append(
            f"### ABOUT {user_name.upper()} (the player's character)\n{body}".rstrip()
        )

    if summary:
        sections.append(f"### STORY SO FAR\n{summary}")

    if lore:
        lore_block = "\n\n".join((entry.get("content") or "").strip() for entry in lore)
        sections.append(f"### WORLD KNOWLEDGE (relevant to the current scene)\n{lore_block}")

    if memories:
        facts = _format_facts(memories, facts_budget, relevance_scores)
        if facts:
            sections.append(
                "### ESTABLISHED FACTS (hard canon — never contradict these, "
                f"{char_name} never forgets them)\n{facts}"
            )

    if passages:
        lines = []
        for p in sorted(passages, key=lambda p: p.get("position") or 0):
            speaker = char_name if p.get("role") == "assistant" else user_name
            pos = p.get("position") or 0
            lines.append(f"(turn {pos}) {speaker}: {(p.get('content') or '').strip()}")
        sections.append(
            "### RELEVANT PAST (verbatim excerpts retrieved from earlier in this "
            f"story — may repeat; {char_name} recalls these)\n" + "\n".join(lines)
        )

    if include_examples and character.get("example_dialogues"):
        sections.append(
            "### EXAMPLE OF HOW YOU WRITE\n(style reference only — never quote or reuse verbatim)\n"
            + character["example_dialogues"]
        )

    default_rules = SCENARIO_RP_RULES if is_scenario else DEFAULT_RP_RULES
    card_prompt = (character.get("system_prompt") or "").strip()
    if card_prompt:
        rules = (
            substitute_original(card_prompt, default_rules)
            if has_original_macro(card_prompt)
            else card_prompt
        )
    else:
        rules = default_rules
    sections.append(rules)

    if global_instructions.strip():
        sections.append(f"### PLAYER'S STANDING INSTRUCTIONS\n{global_instructions.strip()}")

    system = "\n\n".join(sections)
    return substitute(system, char_name=char_name, user_name=user_name)


def _texts_at_depths(note: str, note_depth: int, entries: list[dict],
                     char_name: str, user_name: str) -> dict[int, str]:
    """What is said among the turns, by depth: the character's note, then the entries at that
    depth in the order they are placed, as one text. It is marked as not the player's, since
    it goes in one of the player's turns: unmarked, a card could speak in the player's voice,
    and a reminder written as an order would read as something the player said."""
    parts: dict[int, list[str]] = {}
    if note:
        parts[note_depth] = [note]
    for entry in entries:
        parts.setdefault(depth_of(entry), []).append((entry.get("content") or "").strip())
    return {depth: f"[Note for the story, not written by {user_name}: "
                   + substitute("\n".join(texts), char_name=char_name, user_name=user_name) + "]"
            for depth, texts in parts.items()}


def _place_at_depths(turns: list[dict], texts: dict[int, str]) -> list[str]:
    """Puts each text in a turn of the player's, as near its depth as one is, and returns
    those that open the closing block instead, the deepest first. No message is ever added:
    local models drop or move a system message in the middle of the story and want the turns
    to alternate, and Anthropic's API takes none there.

    Depth d is the point before the last d turns sent. The text opens the turn just after
    the point when that is the player's, else ends the one just before it; between two of
    the character's turns, it opens the player's next turn, else ends the player's last
    one. Depth 0, or a story with no turn of the player's, opens the closing block, which
    keeps the guardrails after it."""
    count = len(turns)
    # The player's first turn at or after each index, and last turn before it: one pass
    # each, however many depths there are.
    next_player: list[int | None] = [None] * (count + 1)
    for i in range(count - 1, -1, -1):
        next_player[i] = i if turns[i]["role"] == "user" else next_player[i + 1]
    last_player: list[int | None] = [None] * (count + 1)
    for i in range(count):
        last_player[i + 1] = i if turns[i]["role"] == "user" else last_player[i]

    heads: list[list[str]] = [[] for _ in turns]
    tails: list[list[str]] = [[] for _ in turns]
    closing: list[str] = []
    # Deepest first, so that two texts in one turn keep their order in the story.
    for depth in sorted(texts, reverse=True):
        text = texts[depth]
        point = count - min(depth, count)
        if depth == 0:
            closing.append(text)
        elif point < count and turns[point]["role"] == "user":
            heads[point].append(text)
        elif point > 0 and turns[point - 1]["role"] == "user":
            tails[point - 1].append(text)
        elif next_player[point] is not None:
            heads[next_player[point]].append(text)
        elif last_player[point] is not None:
            tails[last_player[point]].append(text)
        else:
            closing.append(text)
    for turn, head, tail in zip(turns, heads, tails, strict=True):
        if head or tail:
            turn["content"] = "\n\n".join([*head, turn["content"], *tail])
    return closing


_LENGTH_OVERRIDES = {
    "short": ("LENGTH OVERRIDE: keep every reply to ONE tight paragraph. "
              "Dense, punchy, no padding."),
    "long": ("LENGTH OVERRIDE: write expansive replies of 3 to 5 rich paragraphs, "
             "with deep sensory and emotional detail — still ending on something "
             "{{user}} can react to."),
}


def build_chat_payload(character: dict, persona: dict | None, conversation: dict,
                       messages: list[dict], connection: dict,
                       global_instructions: str = "",
                       memories: list[dict] | None = None,
                       lore_entries: list[dict] | None = None,
                       reply_length: str = "medium",
                       history_limit: int = 0,
                       relevance_scores: dict[str, float] | None = None,
                       retrieved_passages: list[dict] | None = None,
                       fold_leading_assistant: bool = False,
                       insertions: bool = True) -> PromptPayload:
    """``insertions`` False leaves out what the card says to the character among the turns
    (its note, its entries at a depth): the ghostwriter, who writes as the player, has no use
    for them."""
    char_name = character.get("name") or "Character"
    user_name = (persona or {}).get("name") or "User"
    summary = (conversation or {}).get("summary") or ""

    context_size = int(connection.get("context_size") or 8192)
    max_tokens = int(connection.get("max_tokens") or 1024)
    budget = max(512, context_size - max_tokens - _BUDGET_MARGIN)

    # A card keeps the rules it was made with until its owner agrees to have it read again.
    # On those of community cards the lorebook has a share of the prompt, not a fixed amount,
    # and an entry can go before the character's definition or among the turns, as the note
    # to the character does.
    lore_before: list[dict] = []
    at_depth: list[dict] = []
    depth_texts: dict[int, str] = {}
    if (character.get("card_rules") or 1) == 2:
        matched = match_lore(lore_entries or [], messages, rules=2, budget=budget // 4,
                             char_name=char_name, user_name=user_name)
        lore_before = [entry for entry in matched if before_the_card(entry)]
        lore = [entry for entry in matched if not before_the_card(entry) and not at_a_depth(entry)]
        if insertions:
            at_depth = [entry for entry in matched if at_a_depth(entry)]
            note = (character.get("character_note") or "").strip()
            depth_texts = _texts_at_depths(note, character.get("character_note_depth", _NOTE_DEPTH),
                                           at_depth, char_name, user_name)
    else:
        lore = match_lore(lore_entries or [], messages)
    # Said among the turns or in the closing block, these texts take their room from the story.
    depth_cost = sum(estimate_tokens(text) for text in depth_texts.values())

    length_override = _LENGTH_OVERRIDES.get(reply_length)
    if length_override:
        global_instructions = (global_instructions + "\n\n" + length_override).strip()

    # What the model reads last carries the most weight.
    post_bits = []
    card_note = (character.get("post_history_instructions") or "").strip()
    if card_note:
        post_bits.append(card_note)
    pinned = [m for m in (memories or []) if m.get("is_pinned")]
    if pinned:
        lines = "\n".join(f"- {(m.get('content') or '').strip()}" for m in pinned[:_MAX_PINNED_RESTATED])
        post_bits.append(
            f"[Still true, and {char_name} has not forgotten any of it:\n{lines}]"
        )
    scene_directive = ((conversation or {}).get("author_note") or "").strip()
    if scene_directive:
        post_bits.append(f"[Scene directive from {user_name}]: {scene_directive}")
    post_bits.append(_POST_HISTORY_REMINDER)
    post_history = substitute("\n\n".join(post_bits),
                              char_name=char_name, user_name=user_name)

    facts_budget = min(_MAX_FACTS_TOKEN_BUDGET,
                       max(_FACTS_TOKEN_BUDGET, int(budget * _FACTS_BUDGET_SHARE)))

    def render_turns(remaining: int) -> list[dict]:
        ordered = sorted(messages, key=lambda m: m.get("position", 0))
        turns: list[dict] = []
        for i, message in enumerate(reversed(ordered)):
            if history_limit and len(turns) >= history_limit:
                break
            content = substitute(active_content(message), char_name=char_name, user_name=user_name)
            # Player message modes: stored raw, marked up only for the model.
            message_mode = (message.get("meta") or {}).get("mode")
            if message_mode == "narrate":
                content = f"[Narration] {content}"
            elif message_mode == "ooc":
                content = f"(OOC: {content})"
            cost = estimate_tokens(content) + 4
            if i > 0 and cost > remaining:
                break
            remaining -= cost
            turns.append({"role": message["role"], "content": content, "position": message.get("position", 0)})
        turns.reverse()
        return turns

    # A fact the model drew from a turn it still sees is left out unless pinned: an echo feeds
    # repetition loops. Which turns stay is first estimated with every fact in the system prompt.
    static = _build_system(character, persona, summary, global_instructions,
                           include_examples=True, char_name=char_name, user_name=user_name,
                           memories=memories, lore=lore, lore_before=lore_before,
                           facts_budget=facts_budget,
                           relevance_scores=relevance_scores, passages=retrieved_passages)
    provisional = render_turns(budget - estimate_tokens(static) - estimate_tokens(post_history)
                               - depth_cost)
    oldest_visible = min((t["position"] for t in provisional), default=0)
    relevant_memories = [
        m for m in (memories or [])
        if m.get("is_pinned") or m.get("source") == "user"
        or (m.get("source_position") or 0) < oldest_visible
    ]
    facts_shown = select_facts(relevant_memories, facts_budget, relevance_scores)

    system = _build_system(character, persona, summary, global_instructions,
                           include_examples=True, char_name=char_name, user_name=user_name,
                           memories=relevant_memories, lore=lore, lore_before=lore_before,
                           facts_budget=facts_budget,
                           relevance_scores=relevance_scores, passages=retrieved_passages)
    if estimate_tokens(system) > budget * _SYSTEM_SHARE_BEFORE_DROPPING_EXAMPLES:
        system = _build_system(character, persona, summary, global_instructions,
                               include_examples=False, char_name=char_name, user_name=user_name,
                               memories=relevant_memories, lore=lore, lore_before=lore_before,
                               facts_budget=facts_budget,
                               relevance_scores=relevance_scores, passages=retrieved_passages)

    turns = render_turns(budget - estimate_tokens(system) - estimate_tokens(post_history)
                         - depth_cost)
    # The oldest turn actually sent: the estimate above, with every fact, may leave out older ones.
    visible_oldest = min((t["position"] for t in turns), default=oldest_visible)
    for t in turns:
        t.pop("position", None)

    # Some chat templates answer nothing to a conversation that opens on the assistant, as one with
    # a greeting does. Folded into the system prompt, those turns keep every word; only ever as a
    # retry, since the model then reads the opening as instruction rather than as its own voice.
    if fold_leading_assistant and any(t["role"] != "assistant" for t in turns):
        spoken = []
        while turns and turns[0]["role"] == "assistant":
            spoken.append(turns.pop(0)["content"])
        if spoken:
            block = "\n\n".join(f"{char_name}: {s}" for s in spoken)
            system = (f"{system}\n\n### THE SCENE SO FAR "
                      f"({char_name} has already said this aloud; carry on from it "
                      f"rather than repeating it)\n{block}")

    # Placed in the turns as sent, cut and folded, so that a depth counts what the model reads.
    closing = _place_at_depths(turns, depth_texts)
    if closing:
        post_history = "\n\n".join([*closing, post_history])

    stop = [f"\n{user_name}:"]
    used = (estimate_tokens(system) + estimate_tokens(post_history)
            + sum(estimate_tokens(t["content"]) + 4 for t in turns))
    stats = {
        "used_tokens": used,
        "budget": budget,
        "context_size": context_size,
        "messages_included": len(turns),
        "messages_total": len(messages),
        "lore_matched": len(lore_before) + len(lore) + len(at_depth),
        "oldest_visible": visible_oldest,
        "fact_positions": [m.get("source_position") for m in facts_shown],
    }
    return PromptPayload(system=system, messages=turns, stop=stop,
                         post_history=post_history, stats=stats)


def strip_thought(text: str) -> str:
    """What a model says after the thinking some write first between <think> tags: nothing
    until that is closed, nor while the opening tag is still arriving."""
    head = text.lstrip()
    if head.startswith("<think>"):
        return head.partition("</think>")[2].lstrip()
    return "" if head and "<think>".startswith(head) else text


def trim_reply(text: str, char_name: str, user_name: str) -> str:
    """Post-generation cleanup: drop the model's thinking, anything it wrote for the player,
    and a leading "Name:" speaker tag if present."""
    text = strip_thought(text)
    for marker in (f"\n{user_name}:", f"\n{user_name} :"):
        index = text.find(marker)
        if index != -1:
            text = text[:index]
    stripped = text.lstrip()
    for prefix in (f"{char_name}:", f"{char_name} :"):
        if stripped.startswith(prefix):
            text = stripped[len(prefix):].lstrip()
            break
    return text.rstrip()
