# CreaCon backend

Thin FastAPI service: takes an editing instruction (+ optional preview image), asks an LLM
for a structured edit plan, validates it against `schema/editPlan.schema.json`, and returns it.

## Setup

```
cd backend
python -m venv .venv
.venv\Scripts\activate      # or: source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env      # then fill in the keys below
```

## Choosing a provider

Edit `.env`:

```
LLM_PROVIDER=anthropic      # or: gemini
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
```

You only need the key (and installed SDK) for whichever provider you set. `llm_client.py`
lazily imports `llm_providers/anthropic_provider.py` or `llm_providers/gemini_provider.py`
based on `LLM_PROVIDER`.

## Run

```
uvicorn main:app --port 8000
```

**Do not use `--reload`.** On this machine (Python 3.14 + Windows) it crashes during hot-reload's
multiprocessing spawn, especially with a large `.venv` in the watched tree (watchfiles ends up
watching thousands of dependency files). After editing backend code, stop the server (Ctrl+C)
and restart it manually.

The plugin (`CreaCon/src/aiClient.js`) posts to `http://localhost:8000/edit-plan` by default.

## Self-check trial (optional keyboard automation)

The panel's 🔁 toggle drives Camera Raw's "Update AI settings" via OS-level key events
(`pyautogui`/`pygetwindow`, installed by `requirements.txt`) so AI masks compute without a
manual click. **While it's running (a few seconds after an apply), leave the keyboard and
mouse alone** - it sends real keystrokes to whatever window has focus.

When 🔁 is on, the self-check's corrective edit **applies automatically, without the normal
Apply-gate click** - the one deliberate exception in the whole app, capped at one correction
per user-initiated apply. Leave it off if you want every edit to require your confirmation.
