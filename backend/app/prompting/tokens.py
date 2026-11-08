"""Rough token count without a tokenizer: about 3.5 characters a token, a safe average for prose."""


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return int(len(text) / 3.5) + 1
