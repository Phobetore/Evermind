"""Chat service — orchestrates prompt assembly, LLM streaming, and message persistence."""

from __future__ import annotations

import json
import logging
import uuid
from typing import TYPE_CHECKING, Any

from app.config import get_config
from app.core.llm_client import LLMClient
from app.core.repositories.character_repository import CharacterRepository
from app.core.repositories.conversation_repository import ConversationRepository
from app.core.repositories.message_repository import MessageRepository
from app.models.message import MessageCreate
from app.prompting.assembler import build_chat_messages
from app.services.timing import TimingContext

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

logger = logging.getLogger(__name__)


class ChatService:
    """Orchestrates a single chat turn: prompt → LLM → persist."""

    def __init__(self) -> None:
        self.char_repo = CharacterRepository()
        self.conv_repo = ConversationRepository()
        self.msg_repo = MessageRepository()

    async def stream_chat(
        self,
        conversation_id: str,
        character_id: str,
        user_message: str,
        profile_id: str = "balanced",
        generation_params: dict[str, Any] | None = None,
    ) -> AsyncIterator[str]:
        """Yield SSE-formatted lines for a streaming chat response.

        Protocol:
          ``data: {"token": "…"}``   — incremental tokens
          ``data: {"done": true, "message_id": "…", "meta": {…}}`` — final event
          ``data: {"error": "…"}``   — on failure
        """
        timing = TimingContext()
        gen_params = generation_params or {}

        # 1. Load character
        character = await self.char_repo.get(character_id)
        if character is None:
            yield _sse({"error": "Character not found"})
            return

        # 2. Persist the user message
        await self.msg_repo.create(
            MessageCreate(
                conversation_id=conversation_id,
                role="user",
                content=user_message,
            )
        )

        # 3. Load recent history (windowed)
        recent = await self.msg_repo.get_recent(conversation_id, limit=20)

        # 4. Assemble prompt
        messages = build_chat_messages(character, recent, user_message)

        # 5. Resolve LLM server
        cfg = get_config()
        profile = cfg.profiles.get(profile_id)
        chat_server_key = profile.chat_server if profile else "chat"
        server_cfg = cfg.llm_servers.get(chat_server_key)
        if server_cfg is None:
            yield _sse({"error": f"LLM server '{chat_server_key}' not configured"})
            return

        base_url = f"http://{cfg.bind_host}:{server_cfg.port}"
        llm = LLMClient(base_url=base_url, timeout=120.0)

        # 6. Stream tokens from LLM
        collected_tokens: list[str] = []
        request_id = str(uuid.uuid4())
        first_token_sent = False

        try:
            async for chunk in llm.chat_completion_stream(messages, **gen_params):
                choices = chunk.get("choices", [])
                if not choices:
                    continue
                delta = choices[0].get("delta", {})
                token = delta.get("content", "")
                if token:
                    if not first_token_sent:
                        timing.mark("t_first_token")
                        first_token_sent = True
                    collected_tokens.append(token)
                    yield _sse({"token": token})
        except Exception:
            logger.exception("LLM streaming error for request %s", request_id)
            timing.mark("t_stream_end")
            timing.mark("t_request_end")
            yield _sse({"error": "LLM streaming failed"})
            return

        timing.mark("t_stream_end")

        # 7. Persist assistant message
        full_response = "".join(collected_tokens)
        timing.mark("t_request_end")
        latency_meta = timing.to_meta()

        meta: dict[str, Any] = {
            "schema_version": "1.1",
            "request_id": request_id,
            "profile_id": profile_id,
            "pipeline": {
                "best_of_n": 1,
                "self_refine": False,
                "judge_enabled": False,
                "memory_extract_enabled": False,
                "memory_write_enabled": False,
            },
            "models": {
                "chat": {
                    "server_id": chat_server_key,
                    "model_path": server_cfg.model_path,
                    "quant": server_cfg.quant,
                    "ctx": server_cfg.ctx,
                    "backend": server_cfg.backend,
                },
            },
            "generation": {**gen_params},
            "usage": {
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
            },
            "latency_ms": latency_meta,
            "errors": [],
        }

        assistant_msg = await self.msg_repo.create(
            MessageCreate(
                conversation_id=conversation_id,
                role="assistant",
                content=full_response,
                meta=meta,
            )
        )

        # 8. Emit done event
        yield _sse(
            {
                "done": True,
                "message_id": assistant_msg.id,
                "meta": {
                    "request_id": request_id,
                    "profile_id": profile_id,
                    "latency_ms": {
                        "dur_total": latency_meta["dur_total"],
                        "dur_generate": latency_meta["dur_generate"],
                    },
                },
            }
        )


def _sse(data: dict[str, Any]) -> str:
    """Format a dict as an SSE ``data:`` line."""
    return f"data: {json.dumps(data)}\n\n"
