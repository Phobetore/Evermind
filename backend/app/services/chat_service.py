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
from app.core.repositories.memory_repository import MemoryRepository
from app.core.repositories.message_repository import MessageRepository
from app.core.repositories.world_state_repository import WorldStateRepository
from app.memory_pipeline.extractor import build_extraction_prompt, parse_extraction_response
from app.models.memory import MemoryCreate
from app.models.message import MessageCreate
from app.prompting.assembler import build_chat_messages
from app.services.timing import TimingContext

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

logger = logging.getLogger(__name__)

# Minimum confidence score for extracted memories to be persisted.
MEMORY_CONFIDENCE_THRESHOLD = 0.6


def _resolve_llm_client(
    cfg: Any, server_key: str, *, timeout: float = 120.0
) -> LLMClient | None:
    """Build an :class:`LLMClient` for the given server key, or *None*."""
    server_cfg = cfg.llm_servers.get(server_key)
    if server_cfg is None:
        return None
    base_url = f"http://{cfg.bind_host}:{server_cfg.port}"
    return LLMClient(base_url=base_url, timeout=timeout)


class ChatService:
    """Orchestrates a single chat turn: prompt → LLM → persist → extract memory."""

    def __init__(self) -> None:
        self.char_repo = CharacterRepository()
        self.conv_repo = ConversationRepository()
        self.msg_repo = MessageRepository()
        self.mem_repo = MemoryRepository()
        self.ws_repo = WorldStateRepository()

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

        # 4. Load world state and memories for context injection
        world_state_obj = await self.ws_repo.get(character_id)
        world_state = world_state_obj.state if world_state_obj else None
        memories = await self.mem_repo.list_by_character(character_id)

        # 5. Assemble prompt (with world state + memories)
        messages = build_chat_messages(
            character,
            recent,
            user_message,
            world_state=world_state,
            memories=memories,
        )

        # 6. Resolve LLM server (multi-server routing by role)
        cfg = get_config()
        profile = cfg.profiles.get(profile_id)
        chat_server_key = profile.chat_server if profile else "chat"
        server_cfg = cfg.llm_servers.get(chat_server_key)
        if server_cfg is None:
            yield _sse({"error": f"LLM server '{chat_server_key}' not configured"})
            return

        llm = _resolve_llm_client(cfg, chat_server_key)
        if llm is None:
            yield _sse({"error": f"LLM server '{chat_server_key}' not configured"})
            return

        # 7. Stream tokens from LLM
        collected_tokens: list[str] = []
        request_id = str(uuid.uuid4())
        first_token_sent = False
        errors: list[str] = []

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

        # 8. Post-generation: trigger memory extraction (async, non-blocking)
        full_response = "".join(collected_tokens)
        memory_extract_enabled = False
        memory_server_key = profile.memory_server if profile else "memory"
        mem_llm = _resolve_llm_client(cfg, memory_server_key, timeout=60.0)

        if mem_llm is not None:
            memory_extract_enabled = True
            try:
                await self._extract_and_store_memories(
                    character_id=character_id,
                    char_name=character.name,
                    user_message=user_message,
                    assistant_response=full_response,
                    recent_messages=recent,
                    world_state=world_state,
                    mem_llm=mem_llm,
                    timing=timing,
                )
            except Exception:
                logger.exception("Memory extraction failed for request %s", request_id)
                errors.append("memory_extraction_failed")
        else:
            logger.debug("Memory server '%s' not configured — skipping extraction", memory_server_key)

        timing.mark("t_memory_extract_end")

        # 9. Persist assistant message
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
                "memory_extract_enabled": memory_extract_enabled,
                "memory_write_enabled": memory_extract_enabled,
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
            "errors": errors,
        }

        assistant_msg = await self.msg_repo.create(
            MessageCreate(
                conversation_id=conversation_id,
                role="assistant",
                content=full_response,
                meta=meta,
            )
        )

        # 10. Emit done event
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
                        "dur_memory_extract": latency_meta["dur_memory_extract"],
                    },
                },
            }
        )

    async def _extract_and_store_memories(
        self,
        *,
        character_id: str,
        char_name: str,
        user_message: str,
        assistant_response: str,
        recent_messages: list[Any],
        world_state: dict[str, Any] | None,
        mem_llm: LLMClient,
        timing: TimingContext,
    ) -> None:
        """Call the memory-extraction LLM and persist the results."""
        # Build extraction input text from the latest exchange
        recent_text = f"User: {user_message}\n{char_name}: {assistant_response}"
        ws_json = json.dumps(world_state) if world_state else "{}"

        extraction_messages = build_extraction_prompt(
            char_name=char_name,
            recent_messages_text=recent_text,
            world_state_json=ws_json,
        )

        # Call the memory LLM (non-streaming)
        response = await mem_llm.chat_completion(extraction_messages, temperature=0.1, max_tokens=1024)
        raw_content = response.get("choices", [{}])[0].get("message", {}).get("content", "")

        timing.mark("t_memory_extract_end")

        # Parse and store extracted memories
        parsed = parse_extraction_response(raw_content)

        for mem_type in ("semantic", "episodic"):
            for item in parsed.get(mem_type, []):
                if item.get("confidence", 0) < MEMORY_CONFIDENCE_THRESHOLD:
                    continue
                await self.mem_repo.create(
                    MemoryCreate(
                        character_id=character_id,
                        type=mem_type,
                        title=item.get("title", "Untitled"),
                        content=item.get("content", ""),
                        tags=item.get("tags", []),
                        importance=item.get("importance", 0.5),
                        confidence=item.get("confidence", 0.8),
                    )
                )

        # Apply world state updates
        for update in parsed.get("world_updates", []):
            field = update.get("field")
            value = update.get("value")
            if field and value and update.get("confidence", 0) >= MEMORY_CONFIDENCE_THRESHOLD:
                await self.ws_repo.update_field(character_id, field, value)

        timing.mark("t_memory_write_end")
        logger.info(
            "Memory extraction complete for %s: %d semantic, %d episodic, %d world updates",
            char_name,
            len(parsed.get("semantic", [])),
            len(parsed.get("episodic", [])),
            len(parsed.get("world_updates", [])),
        )


def _sse(data: dict[str, Any]) -> str:
    """Format a dict as an SSE ``data:`` line."""
    return f"data: {json.dumps(data)}\n\n"
