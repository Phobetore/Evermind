"""Local sentence embeddings for semantic memory retrieval.

Optional feature: the model load needs the `semantic` extra
(sentence-transformers). numpy is a core dependency, so vector packing and
similarity always work. When the model is unavailable, embed() returns None and
callers fall back to recency-based memory — this module never raises.
"""

import asyncio
import logging

import numpy as np

logger = logging.getLogger(__name__)

MODEL_NAME = "intfloat/multilingual-e5-small"

_model = None            # loaded SentenceTransformer, or None
_load_attempted = False  # only try (and log failure) once


def pack(vector) -> bytes:
    """Serialize a float vector to compact float32 bytes for BLOB storage."""
    return np.asarray(vector, dtype=np.float32).tobytes()


def unpack(blob: bytes):
    """Read a float32 vector back from BLOB bytes."""
    return np.frombuffer(blob, dtype=np.float32)


async def warmup() -> bool:
    """Load the model once, in a thread. The ONLY place a download can start.
    Returns True if the model is ready. Safe to call repeatedly."""
    global _model, _load_attempted
    if _model is not None:
        return True
    if _load_attempted:
        return False
    _load_attempted = True
    try:
        def _load():
            from sentence_transformers import SentenceTransformer
            return SentenceTransformer(MODEL_NAME)
        _model = await asyncio.to_thread(_load)
        logger.info("semantic memory enabled: loaded %s", MODEL_NAME)
        return True
    # Deliberately blind: the extra is optional, so a missing package, a failed
    # download or an incompatible torch build all mean the same thing here, which
    # is that the feature stays off and the app runs on recency.
    except Exception:  # noqa: BLE001
        logger.info("semantic memory disabled: could not load %s", MODEL_NAME)
        return False


async def embed(texts: list[str], kind: str) -> list[list[float]] | None:
    """Embed texts as L2-normalized vectors. `kind` is 'query' or 'passage'
    (e5 requires these prefixes). Returns None if the model is not loaded —
    never raises, so callers degrade to recency."""
    if _model is None or not texts:
        return None
    prefix = "query: " if kind == "query" else "passage: "
    prefixed = [prefix + t for t in texts]
    try:
        def _encode():
            return _model.encode(prefixed, normalize_embeddings=True)
        vectors = await asyncio.to_thread(_encode)
        return [[float(x) for x in v] for v in vectors]
    except Exception:
        logger.exception("embedding failed")
        return None
