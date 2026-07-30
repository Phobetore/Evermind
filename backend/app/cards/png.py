"""Read/write the `chara` tEXt chunk used by character card PNGs.

Pure stdlib PNG chunk manipulation: no image decoding, we only walk the chunk
list. The card is stored as base64-encoded JSON in a tEXt chunk keyed `chara`.
"""

import base64
import json
import struct
import zlib

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_CHARA_KEY = b"chara\x00"


def _iter_chunks(data: bytes):
    """Yield (type, chunk_data, start_offset, end_offset)."""
    pos = len(PNG_SIGNATURE)
    total = len(data)
    while pos + 8 <= total:
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        ctype = data[pos + 4 : pos + 8]
        end = pos + 8 + length + 4
        if end > total:
            break
        yield ctype, data[pos + 8 : pos + 8 + length], pos, end
        if ctype == b"IEND":
            break
        pos = end


def _make_chunk(ctype: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + ctype
        + data
        + struct.pack(">I", zlib.crc32(ctype + data) & 0xFFFFFFFF)
    )


def is_png(data: bytes) -> bool:
    return data.startswith(PNG_SIGNATURE)


def make_placeholder_png(width: int = 512, height: int = 512,
                         rgb: tuple[int, int, int] = (26, 22, 37)) -> bytes:
    """Solid-color truecolor PNG used as export base when a card has no avatar."""
    scanline = b"\x00" + bytes(rgb) * width
    raw = scanline * height
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        PNG_SIGNATURE
        + _make_chunk(b"IHDR", ihdr)
        + _make_chunk(b"IDAT", zlib.compress(raw, 9))
        + _make_chunk(b"IEND", b"")
    )


def read_card_from_png(data: bytes) -> dict | None:
    if not is_png(data):
        return None
    for ctype, chunk_data, _, _ in _iter_chunks(data):
        if ctype == b"tEXt" and chunk_data.startswith(_CHARA_KEY):
            payload = chunk_data[len(_CHARA_KEY) :]
            try:
                return json.loads(base64.b64decode(payload))
            except (ValueError, json.JSONDecodeError):
                return None
    return None


def write_card_to_png(png: bytes, card: dict) -> bytes:
    if not is_png(png):
        raise ValueError("Not a PNG file")
    payload = base64.b64encode(json.dumps(card, ensure_ascii=False).encode("utf-8"))
    card_chunk = _make_chunk(b"tEXt", _CHARA_KEY + payload)

    out = bytearray(PNG_SIGNATURE)
    inserted = False
    for ctype, chunk_data, start, end in _iter_chunks(png):
        if ctype == b"tEXt" and chunk_data.startswith(_CHARA_KEY):
            continue  # drop previous card
        if ctype == b"IEND":
            out += card_chunk
            inserted = True
        out += png[start:end]
    if not inserted:
        raise ValueError("PNG has no IEND chunk")
    return bytes(out)
