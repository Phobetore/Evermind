"""Builds the provider-agnostic chat payload for one turn.

Output contract (locked in the v2 plan):
- `system`: single structured system prompt (card, persona, summary, examples, rules).
- `messages`: real user/assistant turns, oldest first, trimmed to the context
  budget (system is never trimmed; the latest message always survives).
- `stop`: anti-impersonation stop sequences.
- `post_history`: card `post_history_instructions`; each provider decides how
  to inject it after the history.
"""

from dataclasses import dataclass, field

from .defaults import DEFAULT_RP_RULES, SCENARIO_RP_RULES
from .macros import has_original_macro, substitute, substitute_original
from .tokens import estimate_tokens

# Re-stated at generation time because rule adherence decays with distance:
# on a long chat the system prompt is thousands of tokens away, drowned out
# by the model's own recent output.
# Enough for what someone has deliberately marked, not so many that the block
# becomes another wall of text to skim. Pinning more than this is a sign the
# facts want consolidating rather than repeating.
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
# If the system prompt alone eats more than this share of the budget, the
# example-dialogue block is dropped first (card identity is never dropped).
_SYSTEM_SHARE_BEFORE_DROPPING_EXAMPLES = 0.6
# Established facts: pinned first, then newest; capped so a very long story
# cannot crowd out the card and history.
_MAX_FACTS = 60
_FACTS_TOKEN_BUDGET = 700       # floor, used on tiny contexts
_MAX_FACTS_TOKEN_BUDGET = 2000  # cap, so facts never dominate the window
# Lorebook: keyword-triggered world knowledge, scanned over the recent turns.
_LORE_SCAN_MESSAGES = 6
_LORE_TOKEN_BUDGET = 800


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


def select_facts(memories: list[dict], token_budget: int = _FACTS_TOKEN_BUDGET,
                 relevance_scores: dict[str, float] | None = None) -> list[dict]:
    """Which facts get injected: pinned always survive, the rest fill the
    budget by relevance when scores are given, else newest-first (recency).
    Returned oldest-first for chronological reading."""
    pinned = [m for m in memories if m.get("is_pinned")]
    others = [m for m in memories if not m.get("is_pinned")]
    if relevance_scores is not None:
        others.sort(key=lambda m: relevance_scores.get(m.get("id"), float("-inf")),
                    reverse=True)
    else:
        others.sort(key=lambda m: m.get("source_position", 0), reverse=True)

    kept: list[dict] = []
    budget = token_budget
    for memory in pinned + others:
        if len(kept) >= _MAX_FACTS:
            break
        cost = estimate_tokens(memory.get("content") or "")
        if memory not in pinned and cost > budget:
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
        lines.append(f"- {prefix}{memory.get('content', '').strip()}")
    return "\n".join(lines)


def match_lore(entries: list[dict], messages: list[dict]) -> list[dict]:
    """Entries whose keywords appear in the recent turns, priority first,
    within the lore token budget."""
    if not entries:
        return []
    recent = sorted(messages, key=lambda m: m.get("position", 0))[-_LORE_SCAN_MESSAGES:]
    text = "\n".join(active_content(m) for m in recent)
    lowered = text.lower()

    matched = []
    for entry in entries:
        if not entry.get("enabled", True):
            continue
        haystack = text if entry.get("case_sensitive") else lowered
        for key in entry.get("keys") or []:
            needle = key if entry.get("case_sensitive") else key.lower()
            if needle and needle in haystack:
                matched.append(entry)
                break

    matched.sort(key=lambda e: e.get("priority", 0), reverse=True)
    kept, budget = [], _LORE_TOKEN_BUDGET
    for entry in matched:
        cost = estimate_tokens(entry.get("content") or "")
        if cost > budget:
            continue
        budget -= cost
        kept.append(entry)
    return kept


def _build_system(character: dict, persona: dict | None, summary: str,
                  global_instructions: str, include_examples: bool,
                  char_name: str, user_name: str,
                  memories: list[dict] | None = None,
                  lore: list[dict] | None = None,
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
        lore_block = "\n\n".join(entry.get("content", "").strip() for entry in lore)
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
                       fold_leading_assistant: bool = False) -> PromptPayload:
    char_name = character.get("name") or "Character"
    user_name = (persona or {}).get("name") or "User"
    summary = (conversation or {}).get("summary") or ""

    context_size = int(connection.get("context_size") or 8192)
    max_tokens = int(connection.get("max_tokens") or 1024)
    budget = max(512, context_size - max_tokens - _BUDGET_MARGIN)

    lore = match_lore(lore_entries or [], messages)

    length_override = _LENGTH_OVERRIDES.get(reply_length)
    if length_override:
        global_instructions = (global_instructions + "\n\n" + length_override).strip()

    # Post-history block: what the model reads LAST, right before generating,
    # so it carries the most weight when the system prompt is far away up top.
    # Order: card's own jailbreak, then the player's live scene directive, then
    # a compact reminder of the guardrails models most often drift on.
    post_bits = []
    card_note = (character.get("post_history_instructions") or "").strip()
    if card_note:
        post_bits.append(card_note)
    # Pinned facts, said again down here. Pinning is someone marking a thing as
    # the one that must never be dropped, and it used to buy only an exemption
    # from the fact budget — which is worth nothing when the block sits
    # thousands of tokens above the model's own recent output. Same reasoning as
    # the reminder below: the last thing read is the thing that carries.
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

    # Established facts scale with the context window (≈12%, capped): 700 tokens
    # was starving long stories on a 16k context. Pinned facts bypass this.
    facts_budget = min(_MAX_FACTS_TOKEN_BUDGET, max(_FACTS_TOKEN_BUDGET, int(budget * 0.12)))

    # History cap: past this many raw turns the model is mostly imitating its
    # own recent output (tics included) instead of listening to instructions —
    # the story beyond the window lives in the summary and established facts.
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

    # Estimate the history window with a provisional (worst-case) fact block, so
    # we know which turns stay visible. Facts covering a still-visible turn are
    # then dropped: re-stating a message the model already sees is pure echo and
    # a top cause of repetition loops on long chats.
    static = _build_system(character, persona, summary, global_instructions,
                           include_examples=True, char_name=char_name, user_name=user_name,
                           memories=memories, lore=lore, facts_budget=facts_budget,
                           relevance_scores=relevance_scores, passages=retrieved_passages)
    provisional = render_turns(budget - estimate_tokens(static) - estimate_tokens(post_history))
    oldest_visible = min((t["position"] for t in provisional), default=0)
    relevant_memories = [
        m for m in (memories or [])
        if m.get("is_pinned") or (m.get("source_position") or 0) < oldest_visible
    ]
    facts_shown = select_facts(relevant_memories, facts_budget, relevance_scores)

    system = _build_system(character, persona, summary, global_instructions,
                           include_examples=True, char_name=char_name, user_name=user_name,
                           memories=relevant_memories, lore=lore, facts_budget=facts_budget,
                           relevance_scores=relevance_scores, passages=retrieved_passages)
    if estimate_tokens(system) > budget * _SYSTEM_SHARE_BEFORE_DROPPING_EXAMPLES:
        system = _build_system(character, persona, summary, global_instructions,
                               include_examples=False, char_name=char_name, user_name=user_name,
                               memories=relevant_memories, lore=lore, facts_budget=facts_budget,
                               relevance_scores=relevance_scores, passages=retrieved_passages)

    turns = render_turns(budget - estimate_tokens(system) - estimate_tokens(post_history))
    # The TRUE visible window: the oldest turn actually rendered. The provisional
    # `oldest_visible` (used above for the fact anti-echo filter) is computed from
    # a worst-case system with all memories, so it can under-count the window.
    # Consumers that need an exact boundary (passage dedup) must use this value.
    visible_oldest = min((t["position"] for t in turns), default=oldest_visible)
    for t in turns:
        t.pop("position", None)

    # Some chat templates refuse a conversation whose first message is the
    # assistant's, and answer with nothing at all rather than an error. Evermind
    # always opens on the character's greeting, so those models look broken on
    # the very first reply. Folding the leading assistant turns into the system
    # prompt keeps every word of them and leaves a list that starts with the
    # player. Only ever done as a retry, since it is the weaker shape: the model
    # reads the opening as instruction rather than as its own voice.
    folded = 0
    if fold_leading_assistant and any(t["role"] != "assistant" for t in turns):
        spoken = []
        while turns and turns[0]["role"] == "assistant":
            spoken.append(turns.pop(0)["content"])
        if spoken:
            folded = len(spoken)
            block = "\n\n".join(f"{char_name}: {s}" for s in spoken)
            system = (f"{system}\n\n### THE SCENE SO FAR "
                      f"({char_name} has already said this aloud; carry on from it "
                      f"rather than repeating it)\n{block}")

    stop = [f"\n{user_name}:"]
    used = (estimate_tokens(system) + estimate_tokens(post_history)
            + sum(estimate_tokens(t["content"]) + 4 for t in turns))
    stats = {
        "used_tokens": used,
        "budget": budget,
        "context_size": context_size,
        "messages_included": len(turns),
        "messages_total": len(messages),
        "lore_matched": len(lore),
        "facts_injected": len(facts_shown),
        "facts_total": len(memories or []),
        "oldest_visible": visible_oldest,
        "fact_positions": [m.get("source_position") for m in facts_shown],
        "passages_injected": len(retrieved_passages or []),
        "leading_assistant_folded": folded,
    }
    return PromptPayload(system=system, messages=turns, stop=stop,
                         post_history=post_history, stats=stats)
