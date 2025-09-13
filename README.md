# Agent Email – LLM‑generated HTML + Gmail API

This project generates an HTML email from a prompt, lets you review it, and sends it via Gmail using the Gmail API. A REST server exposes generate and send endpoints with pluggable LLMs (Ollama or OpenAI).

## Prerequisites
- Ollama running locally (default http://127.0.0.1:11434) with model `llama3.1` pulled, or an OpenAI API key (`OPENAI_API_KEY`).
- Gmail OAuth env vars set: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` (token for the account sending mail).

## Project Structure
- `config.json` – Global config (used only if no instance_id is provided)
- `outputs/` – Global outputs (used only if no instance_id is provided)
- `logs/` – Global logs (used only if no instance_id is provided)
- `server/` – Server and logic code
- Per-instance folders (recommended for production):
  - Each instance folder (e.g. `/path/to/email-20250909140103/`) contains:
    - `config.json` (instance config)
    - `prompt.txt` (instance prompt)
    - `meta.json` (instance state)
    - `logs/` (per-instance logs)
    - `artifacts/` (per-instance outputs, e.g. `artifacts/email.html`)

## Quick Start (REST server)
1. Copy `.env.example` to `.env` in the project root (same folder as `server/`) and fill in Gmail OAuth values:
   - `cp .env.example .env` (edit with your `GMAIL_*` values)
2. Install deps: `npm ci`
3. Start the server via env loader: `bash run.sh`
   - Auto-reload during development: `bash run.sh dev`
4. Health check: `curl -s http://localhost:3001/health`

## REST API Usage

### Generate Email HTML
```
curl -X POST http://localhost:3001/api/email-agent/generate \
  -H "Content-Type: application/json" \
  -d '{
    "instance_id": "email-20250909140103"
  }'
```
- Uses `process.env.AGENT_FOLDER` + `instance_id` to resolve the instance folder.
- If provided, the server uses that folder's config and prompt, and writes to `artifacts/email.html`.
- If not provided, it uses the global `config.json` and writes to `outputs/email.html`.
- Parameters:
  - `promptText` (string) — Provide prompt content inline (overrides file).
  - `promptFile` (string) — Optional path to prompt file (default: `prompt.txt`).
  - `instructions` (string) — Semicolon-separated guidance; if present, the agent attempts to edit an existing HTML (see below).
  - `htmlPath` or `sourceHtmlPath` (string) — Path to an existing HTML to modify when using `instructions`. If not provided, defaults to current output (`artifacts/email.html` for instances or `outputs/email.html`).
  - `htmlOutput` (string) — Output path for the generated HTML. Default is per-instance `artifacts/email.html` (or `outputs/email.html`).
  - `instance_id` (string) — Instance selector; requires `AGENT_FOLDER` in environment.
  - LLM overrides (optional; otherwise use env): `provider`, `model`, `endpoint`, `options`.

Edit mode behavior:
- With `instructions` set, the agent tries to load the base HTML from `htmlPath`/`sourceHtmlPath` or the default output file, and instructs the model to modify it accordingly. If the explicitly provided path is missing, the request fails with a clear error.

### Send Email
```
curl -X POST http://localhost:3001/api/email-agent/send \
  -H "Content-Type: application/json" \
  -d '{
    "instance_id": "email-20250909140103"
  }'
```
- Parameters:
- `htmlPath` (string) — Path to the HTML to send. With instance context, default is per-instance `artifacts/email.html`.
  - `html` (string) — Inline HTML content to send (writes a temp file and uses it).
  - `subject`, `senderEmail`, `senderName` (strings) — Optional overrides.
  - Recipients from config.json:
    - Preferred keys: `to`, `cc`, `bcc` (lowercase arrays of emails).
    - Fallback legacy key: if none of `to`/`cc`/`bcc` are provided, `RECIPIENTS` will be used as BCC and `To` will default to the sender for privacy.

### Generate and Send (one call)
```
curl -X POST http://localhost:3001/api/email-agent/generate-send \
  -H "Content-Type: application/json" \
  -d '{
    "instance_id": "email-20250909140103"
  }'
```
- Parameters: Same as Generate for prompt control; then sends the resulting HTML.
- Recipient handling: Matches `/send` — uses lowercase `to`/`cc`/`bcc` from config. If none are present, falls back to legacy behavior (To = sender, BCC = `RECIPIENTS`).

## Config Format (config.json)
```
{
  "EMAIL_SUBJECT": "Subject line",
  "SENDER_EMAIL": "you@example.com",
  "SENDER_NAME": "Your Name",
  "HTML_OUTPUT": "artifacts/email.html",
  "PROMPT_FILE": "prompt.txt",
  // Preferred: lowercase recipient lists
  "to": ["a@example.com"],
  "cc": ["team@example.com"],
  "bcc": ["hidden@example.com"],
  // Fallback legacy key: if to/cc/bcc missing, RECIPIENTS will be sent as BCC with To set to sender
  "RECIPIENTS": ["a@example.com", "b@example.com"],
  "email": { "transport": "gmail-api" }
}
```

## Notes
- The service sends one email To the sender and BCCs all recipients for privacy.
- The LLM is prompted to return only HTML (preferably in ```html code fences). Review output before sending.
- Set up credentials carefully; do not commit secrets.
 - Logs are written to `logs/run.log` (global) and per-instance `logs/run.log`.
   - Local logs always include full details (including full prompts and HTML content).
   - The REST logging at `LOG_API_URL` captures state and key events for observability; it does not include full prompt/HTML content.
- Temporary prompt files are written to `outputs/tmp/` (global) or `artifacts/tmp/` (per-instance).
- meta.json in each instance folder tracks agent state.

## Environment
- `AGENT_FOLDER`: Parent directory for all instance folders. Required when using `instance_id`.
 - Note: The server reads environment variables from `.env` in this project root only. Do not place `.env` files in the instance folders; per-instance settings belong in each instance's `config.json`.

## LLM Configuration
- Configure LLM via environment only (no config.json keys):
  - `LLM_PROVIDER` (e.g., `ollama` or `openai`)
  - `LLM_MODEL` (e.g., `llama3.1` or `gpt-4o-mini`)
  - `LLM_ENDPOINT` (e.g., `http://127.0.0.1:11434`) — `OLLAMA_ENDPOINT` is also accepted as an alias
  - Optional: `LLM_OPTIONS` as a JSON string (e.g., `{ "temperature": 0.2 }`)

## Endpoints
- `GET /health` — health check
- `POST /api/email-agent/generate` — generate HTML
- `POST /api/email-agent/send` — send email
- `POST /api/email-agent/generate-send` — generate and send in one call

## Port Configuration
- The default port is 3001. You can override it by setting the `PORT` environment variable:
  - `PORT=3005 bash run.sh`

## Legacy
- The legacy shell script is kept for reference but is not required for REST operation.
