"""What the engine asks of a text that Python and JavaScript hold alike."""


def is_writable(text: str) -> bool:
    """Whether a text can be written to the database or sent in a response. A lone
    surrogate cannot: an escape of one in a model's answer gives it, and it fails
    wherever it is encoded, after what came before it was saved."""
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True
