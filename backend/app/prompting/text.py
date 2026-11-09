def is_writable(text: str) -> bool:
    """Whether a text can be written to the database or sent in a response. A lone
    surrogate cannot: an escape of one in a model's answer gives it, and it fails
    wherever it is encoded, after what came before it was saved."""
    try:
        text.encode("utf-8")
    except UnicodeEncodeError:
        return False
    return True


def text_of(value: object) -> str:
    """What a value says once stripped, "" when it is not a string or cannot be written."""
    return value.strip() if isinstance(value, str) and is_writable(value) else ""
