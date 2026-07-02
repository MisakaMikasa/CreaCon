import os
from typing import Optional

from dotenv import load_dotenv

# Must run before anything reads ANTHROPIC_API_KEY / GEMINI_API_KEY, and
# before the provider modules (which read env vars at import time) load.
load_dotenv()

PROVIDER = os.environ.get("LLM_PROVIDER", "anthropic").lower()


def request_edit_plan(instruction: str, image_base64: Optional[str] = None) -> dict:
    """Dispatches to the configured provider. Set LLM_PROVIDER=gemini|anthropic in .env.

    Lazily imports the provider module so you only need that provider's SDK
    installed (anthropic vs google-genai), not both.
    """
    if PROVIDER == "gemini":
        from llm_providers.gemini_provider import request_edit_plan as impl
    elif PROVIDER == "anthropic":
        from llm_providers.anthropic_provider import request_edit_plan as impl
    else:
        raise ValueError(f"Unknown LLM_PROVIDER '{PROVIDER}' - use 'anthropic' or 'gemini'")

    return impl(instruction, image_base64)
