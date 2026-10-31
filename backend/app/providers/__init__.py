from collections.abc import AsyncIterator

from ..prompting.engine import PromptPayload
from .anthropic import AnthropicProvider
from .base import UNKNOWN_TYPE, Provider, ProviderError, ProviderEvent, failure
from .openai_compat import OpenAICompatProvider

__all__ = ["Provider", "ProviderError", "ProviderEvent", "get_provider"]

_PROVIDERS = {
    "openai-compatible": OpenAICompatProvider,
    "anthropic": AnthropicProvider,
}


class _UnknownProvider(Provider):
    """What a connection of a type nobody knows gets. The API does not let one
    in, but a hand-edited database or a downgrade can leave one behind, and every
    use of it should fail the way a model's server failing does, with a kind the
    interface can say, and not as a crash."""

    def _failure(self) -> ProviderError:
        kind = self.connection.get("provider") or ""
        return ProviderError(f'Unknown connection type: "{kind}"', **failure(UNKNOWN_TYPE))

    async def stream_chat(self, payload: PromptPayload) -> AsyncIterator[ProviderEvent]:
        error = self._failure()
        yield ProviderEvent(type="error", message=error.message, meta=error.meta)

    async def list_models(self) -> list[str]:
        raise self._failure()


def get_provider(connection: dict) -> Provider:
    cls = _PROVIDERS.get(connection.get("provider") or "", _UnknownProvider)
    return cls(connection)
