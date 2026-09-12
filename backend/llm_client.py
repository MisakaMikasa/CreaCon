import os
from typing import Optional

import config

# Importing config is what loads settings: it resolves config.json ->
# environment -> backend/.env, and calls load_dotenv() itself. It must come
# before the provider modules, which read their key and model at import time.

# Gemini, matching /settings, the settings screen and the README. An
# installed user has no config and no .env, so this default is what they
# actually get - and they will have entered a Gemini key.
PROVIDER = str(config.get("llm_provider", "gemini")).lower()


def request_edit_plan(instruction: str, image_base64: Optional[str] = None, context: Optional[dict] = None) -> dict:
    """Dispatches to the configured provider. Set LLM_PROVIDER=gemini|anthropic in .env.

    `context` carries document info for the prompt (layer_names, selected_layers).
    Lazily imports the provider module so you only need that provider's SDK
    installed (anthropic vs google-genai), not both.
    """
    if PROVIDER == "gemini":
        from llm_providers.gemini_provider import request_edit_plan as impl
    elif PROVIDER == "anthropic":
        from llm_providers.anthropic_provider import request_edit_plan as impl
    else:
        raise ValueError(f"Unknown LLM_PROVIDER '{PROVIDER}' - use 'anthropic' or 'gemini'")

    return impl(instruction, image_base64, context)


def chat(messages: list, image_base64: Optional[str] = None, context: Optional[dict] = None) -> str:
    """Conversational turn: returns the model's raw text reply (which may embed
    a ```json edit-plan block). Dispatches to the configured provider."""
    if PROVIDER == "gemini":
        from llm_providers.gemini_provider import chat as impl
    elif PROVIDER == "anthropic":
        from llm_providers.anthropic_provider import chat as impl
    else:
        raise ValueError(f"Unknown LLM_PROVIDER '{PROVIDER}' - use 'anthropic' or 'gemini'")

    return impl(messages, image_base64, context)
