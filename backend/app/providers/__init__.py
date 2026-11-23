from .anthropic import AnthropicProvider
from .base import Answer, Provider, ProviderError, ProviderEvent, complete, complete_answer
from .openai_compat import OpenAICompatProvider

__all__ = ["Answer", "Provider", "ProviderError", "ProviderEvent", "complete", "complete_answer",
           "get_provider", "max_tokens_sent"]


def _kind(connection: dict) -> type[Provider]:
    return AnthropicProvider if connection.get("provider") == "anthropic" else OpenAICompatProvider


def get_provider(connection: dict) -> Provider:
    """Anthropic's own API, or any server that speaks OpenAI's."""
    return _kind(connection)(connection)


def max_tokens_sent(connection: dict) -> int | None:
    """The max_tokens a request on this connection carries, which may be a provider's own."""
    return _kind(connection).max_tokens_sent(connection)
