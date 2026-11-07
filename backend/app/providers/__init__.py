from .anthropic import AnthropicProvider
from .base import Provider, ProviderError, ProviderEvent, complete
from .openai_compat import OpenAICompatProvider

__all__ = ["Provider", "ProviderError", "ProviderEvent", "complete", "get_provider"]


def get_provider(connection: dict) -> Provider:
    """Anthropic's own API, or any server that speaks OpenAI's."""
    if connection.get("provider") == "anthropic":
        return AnthropicProvider(connection)
    return OpenAICompatProvider(connection)
