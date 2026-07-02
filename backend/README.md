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
uvicorn main:app --reload --port 8000
```

The plugin (`CreaCon/src/aiClient.js`) posts to `http://localhost:8000/edit-plan` by default.
