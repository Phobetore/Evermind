"""Rough token estimation without a tokenizer dependency.

~3.5 characters per token is a safe cross-model average for mixed prose;
overestimating slightly is fine (we only use this to trim history).
"""


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return int(len(text) / 3.5) + 1
