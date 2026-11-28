"""Token counts: the engine's, without a tokenizer, at about 3.5 characters a token, a safe
average for prose; and the server's own, read from what it said it used. A leaf: what counts
tokens imports nothing of the application."""


def tokens_of_chars(chars: int) -> int:
    """Tokens for ``chars`` characters, as the engine estimates them."""
    return 0 if chars <= 0 else int(chars / 3.5) + 1


def estimate_tokens(text: str) -> int:
    return tokens_of_chars(len(text)) if text else 0


def _whole(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def counts_of(usage: dict) -> tuple[int, int | None] | None:
    """(prompt, completion) as the server counted them: prompt_tokens, else input_tokens +
    cache_read_input_tokens + cache_creation_input_tokens; completion_tokens, else output_tokens.
    None when the prompt count is missing, not an int, or not above 0."""
    if not isinstance(usage, dict):
        return None
    if "prompt_tokens" in usage:
        prompt = _whole(usage["prompt_tokens"])
    else:
        # Anthropic counts what it read from its cache apart from the rest.
        prompt = _whole(usage.get("input_tokens"))
        if prompt is not None:
            prompt += sum(_whole(usage.get(key)) or 0 for key in (
                "cache_read_input_tokens", "cache_creation_input_tokens"))
    if prompt is None or prompt <= 0:
        return None
    completion = _whole(usage.get("completion_tokens"))
    if completion is None:
        completion = _whole(usage.get("output_tokens"))
    if completion is not None and completion < 0:
        completion = None
    return prompt, completion
