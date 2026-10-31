from .anthropic import AnthropicProvider
from .base import UNKNOWN_TYPE, Provider, ProviderError, ProviderEvent
from .openai_compat import OpenAICompatProvider

__all__ = ["Provider", "ProviderError", "ProviderEvent", "get_provider"]

_PROVIDERS = {
    "openai-compatible": OpenAICompatProvider,
    "anthropic": AnthropicProvider,
}


def get_provider(connection: dict) -> Provider:
    provider_type = connection.get("provider") or ""
    cls = _PROVIDERS.get(provider_type)
    if cls is None:
        raise ProviderError(f"Unknown connection type: \"{provider_type}\"", kind=UNKNOWN_TYPE)
    return cls(connection)
