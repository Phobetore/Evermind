from .anthropic import AnthropicProvider
from .base import Answer, Provider, ProviderError, ProviderEvent, complete, complete_answer
from .openai_compat import OpenAICompatProvider

__all__ = ["Answer", "Provider", "ProviderError", "ProviderEvent", "complete", "complete_answer",
           "get_provider"]


def get_provider(connection: dict) -> Provider:
    """Anthropic's own API, or any server that speaks OpenAI's."""
    if connection.get("provider") == "anthropic":
        return AnthropicProvider(connection)
    return OpenAICompatProvider(connection)
