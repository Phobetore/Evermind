"""Chat service — orchestrates prompt assembly, LLM streaming, and message persistence."""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import uuid
from collections import Counter
from typing import TYPE_CHECKING, Any

import httpx

from app.chat_orchestrator.orchestrator import run_pipeline
from app.config import get_config
from app.core.llm_client import LLMClient
from app.core.repositories.character_repository import CharacterRepository
from app.core.repositories.conversation_repository import ConversationRepository
from app.core.repositories.memory_repository import MemoryRepository
from app.core.repositories.message_repository import MessageRepository
from app.core.repositories.user_persona_repository import UserPersonaRepository
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

# Interval (seconds) between heartbeat SSE events during pipeline execution.
# Keeps the connection alive through proxies while the LLM is generating.
_HEARTBEAT_INTERVAL = 15.0


QUALITY_MODE_PRESETS: dict[str, dict[str, Any]] = {
    "balanced": {
        "temperature": 0.72,
        "top_p": 0.9,
        "max_tokens": 900,
        "best_of_n": 3,
        "self_refine": True,
        "repeat_penalty": 1.08,
    },
    "immersive": {
        "temperature": 0.78,
        "top_p": 0.92,
        "max_tokens": 1100,
        "best_of_n": 5,
        "self_refine": True,
        "repeat_penalty": 1.12,
    },
    "fast": {
        "temperature": 0.68,
        "top_p": 0.88,
        "max_tokens": 700,
        "best_of_n": 1,
        "self_refine": False,
        "repeat_penalty": 1.04,
    },
}

# Weak set of fire-and-forget background tasks to prevent garbage collection
# before completion (see https://docs.python.org/3/library/asyncio-task.html#creating-tasks).
_background_tasks: set[asyncio.Task[None]] = set()


def _resolve_llm_client(
    cfg: Any, server_key: str, *, timeout: float | None = None
) -> LLMClient | None:
    """Build an :class:`LLMClient` for the given server key, or *None*.

    Uses the per-server ``timeout`` from config if no explicit timeout is given.
    """
    server_cfg = cfg.llm_servers.get(server_key)
    if server_cfg is None:
        return None
    base_url = f"http://{cfg.bind_host}:{server_cfg.port}"
    effective_timeout = timeout if timeout is not None else server_cfg.timeout
    return LLMClient(base_url=base_url, timeout=effective_timeout)


class ChatService:
    """Orchestrates a single chat turn: prompt → LLM → persist → extract memory."""

    def __init__(self) -> None:
        self.char_repo = CharacterRepository()
        self.conv_repo = ConversationRepository()
        self.msg_repo = MessageRepository()
        self.mem_repo = MemoryRepository()
        self.ws_repo = WorldStateRepository()
        self.persona_repo = UserPersonaRepository()

    async def stream_chat(
        self,
        conversation_id: str,
        character_id: str,
        user_message: str,
        profile_id: str = "balanced",
        generation_params: dict[str, Any] | None = None,
        regenerate: bool = False,
    ) -> AsyncIterator[str]:
        """Yield SSE-formatted lines for a streaming chat response.

        Protocol:
          ``data: {"token": "…"}``   — incremental tokens
          ``data: {"done": true, "message_id": "…", "meta": {…}}`` — final event
          ``data: {"error": "…"}``   — on failure

        When the profile enables best-of-N (> 1) or self-refine, the service
        uses the full orchestrator pipeline (non-streaming generation → judge
        → optional refine) before emitting the final response as tokens.
        """
        timing = TimingContext()
        gen_params = generation_params or {}

        # 1. Load character
        character = await self.char_repo.get(character_id)
        if character is None:
            yield _sse({"error": "Character not found"})
            return

        # 2. Handle regeneration: delete the previous assistant message
        #    and skip saving the user message (it already exists in the DB).
        if regenerate:
            await self.msg_repo.delete_last_assistant_message(conversation_id)
        else:
            # Persist the user message
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
        memories = await self.mem_repo.list_by_conversation(conversation_id, character_id)

        # 4b. Load user persona if linked to this conversation
        user_persona = None
        conv = await self.conv_repo.get(conversation_id)
        if conv and conv.user_persona_id:
            user_persona = await self.persona_repo.get(conv.user_persona_id)

        # 5. Assemble prompt (with world state + memories + user persona)
        messages = build_chat_messages(
            character,
            recent,
            user_message,
            world_state=world_state,
            memories=memories,
            user_persona=user_persona,
        )

        # 6. Resolve LLM server (multi-server routing by role)
        cfg = get_config()
        profile = cfg.profiles.get(profile_id)
        if profile is None:
            logger.warning(
                "Profile '%s' not found in config — falling back to defaults",
                profile_id,
            )

        # Merge profile generation defaults (user-supplied params take precedence).
        if profile is not None:
            gen_params = {**profile.generation_defaults, **gen_params}

        chat_server_key = profile.chat_server if profile else "chat"
        server_cfg = cfg.llm_servers.get(chat_server_key)
        if server_cfg is None:
            yield _sse({"error": f"LLM server '{chat_server_key}' not configured"})
            return

        llm = _resolve_llm_client(cfg, chat_server_key)
        if llm is None:
            yield _sse({"error": f"LLM server '{chat_server_key}' not configured"})
            return

        quality_mode = str(gen_params.pop("quality_mode", "")).strip().lower()
        if quality_mode in QUALITY_MODE_PRESETS:
            # Quality mode presets are applied as an explicit generation policy.
            gen_params = {
                **QUALITY_MODE_PRESETS[quality_mode],
                **gen_params,
            }

        # Determine pipeline settings from profile
        best_of_n = profile.best_of_n if profile else 1
        do_self_refine = profile.self_refine if profile else False
        # Allow generation_params to override profile settings
        best_of_n = gen_params.pop("best_of_n", best_of_n)
        do_self_refine = gen_params.pop("self_refine", do_self_refine)
        use_pipeline = best_of_n > 1 or do_self_refine

        # Resolve judge LLM for the pipeline (if needed)
        judge_server_key = profile.judge_server if profile else "judge"
        judge_llm: LLMClient | None = None
        memory_injected_count = len(memories or [])

        if use_pipeline:
            judge_llm = _resolve_llm_client(cfg, judge_server_key)
            if judge_llm is None:
                logger.warning(
                    "Judge server '%s' not configured — falling back to simple generation",
                    judge_server_key,
                )
                # Degrade gracefully: no judge means best-of-N returns first candidate
                # and self-refine is skipped.

        collected_tokens: list[str] = []
        request_id = str(uuid.uuid4())
        first_token_sent = False
        errors: list[str] = []
        judge_enabled = False

        logger.info(
            "Chat request %s: profile=%s best_of_n=%d self_refine=%s pipeline=%s",
            request_id,
            profile_id,
            best_of_n,
            do_self_refine,
            use_pipeline,
        )

        # Pre-flight: verify LLM server is reachable before streaming
        base_url = f"http://{cfg.bind_host}:{server_cfg.port}"
        status = await llm.health_status()
        if status != "ok":
            logger.error(
                "LLM server '%s' %s at %s for request %s",
                chat_server_key,
                status,
                base_url,
                request_id,
            )
            if status == "loading":
                yield _sse({
                    "error": (
                        f"LLM server '{chat_server_key}' is still loading the model at {base_url}. "
                        "Please wait for the model to finish loading and try again."
                    ),
                })
            else:
                yield _sse({
                    "error": (
                        f"LLM server '{chat_server_key}' is not reachable at {base_url}. "
                        "Please ensure the llama.cpp server is running on the configured port."
                    ),
                })
            return

        if use_pipeline:
            # --- Best-of-N / self-refine pipeline (non-streaming) ---
            judge_enabled = judge_llm is not None
            world_state_json = json.dumps(world_state) if world_state else "{}"
            memory_lines_text = _format_memory_lines_text(memories or [])

            # Emit a progress event so the connection stays alive and the
            # frontend can show a status indicator while candidates generate.
            yield _sse({
                "status": "generating",
                "detail": f"Generating {best_of_n} candidate(s)...",
            })

            # Run the pipeline in a task and send periodic heartbeat events
            # to keep the SSE connection alive through any proxies.
            # Build extra generation params (penalties, etc.) for the pipeline.
            _pipeline_skip = {
                "temperature",
                "max_tokens",
                "seed",
                "best_of_n",
                "self_refine",
                "quality_mode",
            }
            extra_gen_params = {k: v for k, v in gen_params.items() if k not in _pipeline_skip}

            pipeline_task: asyncio.Task[tuple[str, Any]] = asyncio.create_task(
                run_pipeline(
                    chat_llm=llm,
                    judge_llm=judge_llm,
                    messages=messages,
                    best_of_n=best_of_n,
                    do_self_refine=do_self_refine,
                    char_name=character.name,
                    writing_style=character.writing_style or "",
                    boundaries=character.boundaries or "",
                    world_state_json=world_state_json,
                    world_state_block=world_state_json,
                    memory_lines_text=memory_lines_text,
                    user_message=user_message,
                    base_temperature=gen_params.get("temperature", 0.7),
                    max_tokens=gen_params.get("max_tokens", 1024),
                    base_seed=gen_params.get("seed"),
                    extra_params=extra_gen_params,
                )
            )

            try:
                while not pipeline_task.done():
                    try:
                        await asyncio.wait_for(asyncio.shield(pipeline_task), timeout=_HEARTBEAT_INTERVAL)
                    except TimeoutError:
                        # Pipeline still running — send a heartbeat to keep the connection alive
                        yield _sse({"status": "generating", "detail": "Still generating..."})
                final_text, judge_result = pipeline_task.result()
            except Exception:
                logger.exception("Pipeline failed for request %s", request_id)
                timing.mark("t_stream_end")
                timing.mark("t_request_end")
                yield _sse({"error": "Generation pipeline failed unexpectedly"})
                return

            timing.mark("t_stream_end")

            if judge_result is not None:
                yield _sse({"status": "judging", "detail": "Judge scoring completed."})
                timing.mark("t_judge_end")
                if do_self_refine and judge_result.rewrite_suggestion:
                    yield _sse({"status": "refining", "detail": "Running final self-refine pass."})
                    timing.mark("t_self_refine_end")

            if not final_text:
                timing.mark("t_request_end")
                yield _sse({"error": "Generation produced empty response"})
                return

            # Emit the final response as chunks for a streaming-like UX
            timing.mark("t_first_token")
            for chunk in _chunk_text(final_text):
                yield _sse({"token": chunk})
            collected_tokens.append(final_text)
        else:
            # --- Simple streaming path (best_of_n == 1, no self-refine) ---
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
            except (httpx.ConnectError, httpx.ReadError, httpx.HTTPStatusError, ConnectionError, OSError):
                logger.exception(
                    "LLM connection failed for request %s at %s", request_id, base_url
                )
                timing.mark("t_stream_end")
                timing.mark("t_request_end")
                yield _sse({
                    "error": (
                        f"Cannot connect to LLM server '{chat_server_key}' at {base_url}. "
                        "Please verify the llama.cpp server is running."
                    ),
                })
                return
            except httpx.TimeoutException:
                logger.exception(
                    "LLM request timed out for request %s at %s", request_id, base_url
                )
                timing.mark("t_stream_end")
                timing.mark("t_request_end")
                yield _sse({
                    "error": (
                        f"LLM server '{chat_server_key}' at {base_url} timed out. "
                        "The model may be loading or the request is too large."
                    ),
                })
                return
            except Exception:
                logger.exception("LLM streaming error for request %s", request_id)
                timing.mark("t_stream_end")
                timing.mark("t_request_end")
                yield _sse({"error": "LLM streaming failed unexpectedly"})
                return

            timing.mark("t_stream_end")

        # 8. Post-generation: trigger memory extraction (fire-and-forget background task)
        full_response = "".join(collected_tokens)
        memory_extract_enabled = False
        memory_server_key = profile.memory_server if profile else "memory"
        mem_llm = _resolve_llm_client(cfg, memory_server_key, timeout=60.0)

        if mem_llm is not None:
            memory_extract_enabled = True
            yield _sse({"status": "memory", "detail": "Extracting and writing long-term memory..."})
            task = asyncio.create_task(
                self._extract_and_store_memories_safe(
                    character_id=character_id,
                    conversation_id=conversation_id,
                    char_name=character.name,
                    user_message=user_message,
                    assistant_response=full_response,
                    recent_messages=recent,
                    world_state=world_state,
                    mem_llm=mem_llm,
                    request_id=request_id,
                )
            )
            _background_tasks.add(task)
            task.add_done_callback(_background_tasks.discard)
        else:
            logger.debug(
                "Memory server '%s' not configured — skipping extraction", memory_server_key
            )

        timing.mark("t_memory_extract_end")

        # 9. Persist assistant message
        timing.mark("t_request_end")
        latency_meta = timing.to_meta()

        quality_signals = _compute_quality_signals(
            full_response,
            memory_items_injected=memory_injected_count,
        )
        def _safe_num(value: float | None) -> float:
            return float(value) if value is not None else 0.0

        retrieval_meta = {
            "top_k": memory_injected_count,
            "selected_n": memory_injected_count,
            "memory_ids_selected": [m.id for m in (memories or [])],
            "scoring": {
                "method": "importance_x_confidence",
                "formula": "score = importance * confidence",
                "strategy": "static",
                "weight_importance": 1.0,
                "weight_confidence": 1.0,
            },
            "memory_summaries": [
                {
                    "id": m.id,
                    "rank": idx + 1,
                    "type": m.type,
                    "title": m.title,
                    "importance": _safe_num(m.importance),
                    "confidence": _safe_num(m.confidence),
                    "score": round(_safe_num(m.importance) * _safe_num(m.confidence), 4),
                }
                for idx, m in enumerate(memories or [])
            ],
        }

        meta: dict[str, Any] = {
            "schema_version": "1.1",
            "request_id": request_id,
            "profile_id": profile_id,
            "pipeline": {
                "best_of_n": best_of_n,
                "self_refine": do_self_refine,
                "quality_mode": quality_mode or "custom",
                "judge_enabled": judge_enabled,
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
            "quality_signals": quality_signals,
            "retrieval": retrieval_meta,
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
                    "pipeline": {
                        "best_of_n": best_of_n,
                        "self_refine": do_self_refine,
                        "quality_mode": quality_mode or "custom",
                        "judge_enabled": judge_enabled,
                        "memory_extract_enabled": memory_extract_enabled,
                        "memory_write_enabled": memory_extract_enabled,
                    },
                    "quality_signals": quality_signals,
                    "retrieval": retrieval_meta,
                    "latency_ms": {
                        "dur_total": latency_meta["dur_total"],
                        "dur_generate": latency_meta["dur_generate"],
                        "dur_judge": latency_meta.get("dur_judge", 0),
                        "dur_self_refine": latency_meta.get("dur_self_refine", 0),
                        "dur_memory_extract": latency_meta["dur_memory_extract"],
                    },
                },
            }
        )

    async def _extract_and_store_memories_safe(
        self,
        *,
        character_id: str,
        conversation_id: str,
        char_name: str,
        user_message: str,
        assistant_response: str,
        recent_messages: list[Any],
        world_state: dict[str, Any] | None,
        mem_llm: LLMClient,
        request_id: str,
    ) -> None:
        """Fire-and-forget wrapper around memory extraction.

        Catches all exceptions so a background task failure never crashes the
        event loop.
        """
        try:
            await self._extract_and_store_memories(
                character_id=character_id,
                conversation_id=conversation_id,
                char_name=char_name,
                user_message=user_message,
                assistant_response=assistant_response,
                recent_messages=recent_messages,
                world_state=world_state,
                mem_llm=mem_llm,
            )
        except Exception:
            logger.exception("Background memory extraction failed for request %s", request_id)

    async def _extract_and_store_memories(
        self,
        *,
        character_id: str,
        conversation_id: str,
        char_name: str,
        user_message: str,
        assistant_response: str,
        recent_messages: list[Any],
        world_state: dict[str, Any] | None,
        mem_llm: LLMClient,
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
        response = await mem_llm.chat_completion(
            extraction_messages,
            temperature=0.1,
            max_tokens=1024,
        )
        # Defensive: some mocked or non-conforming clients may return an awaitable
        # payload or a non-dict response object.
        if inspect.isawaitable(response):
            response = await response
        if not isinstance(response, dict):
            logger.warning("Memory extraction returned non-dict response: %s", type(response))
            return

        raw_content = response.get("choices", [{}])[0].get("message", {}).get("content", "")

        # Parse and store extracted memories
        parsed = parse_extraction_response(raw_content)

        for mem_type in ("semantic", "episodic"):
            for item in parsed.get(mem_type, []):
                if item.get("confidence", 0) < MEMORY_CONFIDENCE_THRESHOLD:
                    continue
                await self.mem_repo.create(
                    MemoryCreate(
                        character_id=character_id,
                        conversation_id=conversation_id,
                        type=mem_type,
                        title=item.get("title", "Untitled"),
                        content=item.get("content", ""),
                        tags=item.get("tags", []),
                        importance=item.get("importance", 0.5),
                        confidence=item.get("confidence", 0.8),
                    )
                )

        # Apply world state updates (allow-list fields to prevent injection)
        allowed_ws_fields = {
            "location", "relationship_state", "active_goals",
            "open_threads", "inventory", "notes",
        }
        for update in parsed.get("world_updates", []):
            field = update.get("field")
            value = update.get("value")
            if (
                field
                and field in allowed_ws_fields
                and value
                and update.get("confidence", 0) >= MEMORY_CONFIDENCE_THRESHOLD
            ):
                await self.ws_repo.update_field(character_id, field, value)

        logger.info(
            "Memory extraction complete for %s: %d semantic, %d episodic, %d world updates",
            char_name,
            len(parsed.get("semantic", [])),
            len(parsed.get("episodic", [])),
            len(parsed.get("world_updates", [])),
        )




def _compute_quality_signals(response_text: str, *, memory_items_injected: int) -> dict[str, float | int]:
    """Compute lightweight per-turn quality telemetry signals.

    These heuristics are intentionally cheap and deterministic so they can run
    on every turn without extra model calls.
    """
    words = [
        w.strip(".,!?;:()[]{}\"'\n\t").lower()
        for w in response_text.split()
    ]
    words = [w for w in words if w]
    word_count = len(words)
    unique_count = len(set(words))

    if word_count <= 1:
        repetition_ratio = 0.0
        lexical_diversity = 1.0 if word_count == 1 else 0.0
    else:
        counts = Counter(words)
        repeated_tokens = sum(c - 1 for c in counts.values() if c > 1)
        repetition_ratio = repeated_tokens / word_count
        lexical_diversity = unique_count / word_count

    return {
        "response_chars": len(response_text),
        "response_words": word_count,
        "unique_words": unique_count,
        "lexical_diversity": round(lexical_diversity, 4),
        "repetition_ratio": round(repetition_ratio, 4),
        "memory_items_injected": memory_items_injected,
    }


def _sse(data: dict[str, Any]) -> str:
    """Format a dict as an SSE ``data:`` line."""
    return f"data: {json.dumps(data)}\n\n"


def _chunk_text(text: str, max_chunk: int = 6) -> list[str]:
    """Split *text* into word-sized chunks for a streaming-like UX.

    When the best-of-N pipeline produces a complete response, this function
    breaks it into small pieces so the frontend receives a gradual stream
    rather than a single large payload.
    """
    if not text:
        return []
    words = text.split(" ")
    chunks: list[str] = []
    for i in range(0, len(words), max_chunk):
        chunk = " ".join(words[i : i + max_chunk])
        if chunks:
            chunk = " " + chunk
        chunks.append(chunk)
    return chunks


def _format_memory_lines_text(memories: list[Any]) -> str:
    """Build a plain-text representation of memories for the judge/refine prompts."""
    if not memories:
        return "(none)"
    lines: list[str] = []
    for m in memories:
        imp = f"{m.importance:.2f}"
        conf = f"{m.confidence:.2f}"
        lines.append(f"- [{m.type}|imp={imp}|conf={conf}] {m.content}")
    return "\n".join(lines)
