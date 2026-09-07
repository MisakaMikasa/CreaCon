"""Settings, from wherever they happen to live.

An installed build has no repository and no terminal, so `backend/.env` is not
reachable and environment variables are whatever Explorer happened to pass to
the process. Settings therefore live in a file the app owns and the settings
screen writes:

    %APPDATA%\\CreaCon\\config.json

Resolution order, first hit wins:

    1. config.json      what an installed user's settings screen wrote
    2. environment      an explicit override, and how CI would inject a key
    3. backend/.env     the existing development workflow, unchanged

Order matters: a developer with a .env keeps working exactly as before,
because they have no config.json. An installed user has no .env, so their
config.json is the only source. Nobody has to care which case they are in.

The API key is written here in plain text. That matches how every other
desktop tool with a bring-your-own-key model behaves, and the file sits in
the user's own roaming profile - but it is not a secret store, and it should
never be logged or included in a crash report.
"""

import json
import logging
import os
import secrets
from typing import Any, Optional

from dotenv import load_dotenv

from paths import config_dir

logger = logging.getLogger("creacon.config")

CONFIG_FILE = config_dir() / "config.json"

# config.json key -> environment variable it falls back to
_ENV_ALIASES = {
    "gemini_api_key": "GEMINI_API_KEY",
    "anthropic_api_key": "ANTHROPIC_API_KEY",
    "llm_provider": "LLM_PROVIDER",
    "gemini_model": "GEMINI_MODEL",
    "anthropic_model": "ANTHROPIC_MODEL",
    "port": "CREACON_PORT",
}

load_dotenv()  # step 3 of the order above; no-op once installed

_cache: Optional[dict] = None


def load(refresh: bool = False) -> dict:
    """The contents of config.json, or {} if it is absent or unreadable."""
    global _cache
    if _cache is not None and not refresh:
        return _cache
    try:
        _cache = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        if not isinstance(_cache, dict):
            raise ValueError("config.json is not an object")
    except FileNotFoundError:
        _cache = {}
    except Exception as exc:
        # A corrupt config must not stop the app from starting - the settings
        # screen is the way out, and it needs the app running to be reached.
        logger.warning("ignoring unreadable %s: %s", CONFIG_FILE, exc)
        _cache = {}
    return _cache


def get(key: str, default: Any = None) -> Any:
    """One setting, resolved through the order documented above."""
    value = load().get(key)
    if value not in (None, ""):
        return value
    env_name = _ENV_ALIASES.get(key, key.upper())
    value = os.environ.get(env_name)
    if value not in (None, ""):
        return value
    return default


def save(**updates) -> dict:
    """Merge updates into config.json and write it back."""
    cfg = dict(load())
    cfg.update({k: v for k, v in updates.items() if v is not None})
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    globals()["_cache"] = cfg
    logger.info("wrote %s (%s)", CONFIG_FILE, ", ".join(sorted(updates)))
    return cfg


def ensure_token() -> str:
    """The shared secret the plugin must present. Created once, then reused.

    Persisted rather than regenerated per launch so a plugin that is already
    connected survives a backend restart without the user reloading it.
    """
    token = load().get("token")
    if not token:
        token = secrets.token_urlsafe(32)
        save(token=token)
        logger.info("generated a new access token")
    return token
