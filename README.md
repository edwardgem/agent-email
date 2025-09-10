# Agent Email – LLM‑generated HTML + Gmail API

This project generates an HTML email from a prompt, lets you review it, and sends it via Gmail using the Gmail API. A REST server exposes generate and send endpoints with pluggable LLMs (Ollama or OpenAI).

## Prerequisites
- Ollama running locally (default http://127.0.0.1:11434) with model `llama3.1` pulled, or an OpenAI API key (`OPENAI_API_KEY`).
- Gmail OAuth env vars set: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` (token for the account sending mail).

## Project Structure
- `config.json` – Global config (used only if no instance_path is provided)
- `outputs/` – Global outputs (used only if no instance_path is provided)
- `logs/` – Global logs (used only if no instance_path is provided)
- `server/` – Server and logic code
- Per-instance folders (recommended for production):
  - Each instance folder (e.g. `/path/to/email-20250909140103/`) contains:
    - `config.json` (instance config)
    - `prompt.txt` (instance prompt)
    - `meta.json` (instance state)
    - `logs/` (per-instance logs)
    - `artifacts/` (per-instance outputs, e.g. `artifacts/email.html`)

## Quick Start (REST server)
1. Copy `.env.example` to `.env` and fill in Gmail OAuth values:
   - `cp .env.example .env` (edit with your `GMAIL_*` values)
2. Install deps: `npm ci`
3. Start the server via env loader: `bash run.sh`
   - Auto-reload during development: `bash run.sh dev`
4. Health check: `curl -s http://localhost:3000/health`

## REST API Usage

### Generate Email HTML
```
curl -X POST http://localhost:3000/api/email/generate \
  -H "Content-Type: application/json" \
  -d '{
    "instance_path": "/path/to/instance-folder"
  }'
```
- If `instance_path` is provided, the server uses that folder's config, prompt, and outputs HTML to `artifacts/email.html` in the instance folder.
- If not, it uses the global config and outputs to `outputs/email.html`.
- You can override the prompt or output path by passing `promptText`, `promptFile`, or `htmlOutput` in the request body.

### Send Email
```
curl -X POST http://localhost:3000/api/email/send \
  -H "Content-Type: application/json" \
  -d '{
    "instance_path": "/path/to/instance-folder"
  }'
```
- If `htmlPath` is omitted, the server defaults to `artifacts/email.html` in the instance folder (if `instance_path` is set).
- Sender, sender name, and recipients are loaded from the instance's `config.json`.

### Generate and Send (one call)
```
curl -X POST http://localhost:3000/api/email/generate-send \
  -H "Content-Type: application/json" \
  -d '{
    "instance_path": "/path/to/instance-folder"
  }'
```

## Config Format (config.json)
```
{
  "EMAIL_SUBJECT": "Subject line",
  "SENDER_EMAIL": "you@example.com",
  "SENDER_NAME": "Your Name",
  "HTML_OUTPUT": "artifacts/email.html",
  "PROMPT_FILE": "prompt.txt",
  "RECIPIENTS": ["a@example.com", "b@example.com"],
  "llm": {
    "provider": "ollama",                 // or "openai"
    "model": "llama3.1",                  // e.g., for openai: "gpt-4o-mini"
    "endpoint": "http://127.0.0.1:11434", // Ollama endpoint
    "options": {                           // provider-specific options
      "temperature": 0.3,
      "top_k": 40,
      "top_p": 0.9,
      "repeat_penalty": 1.1,
      "num_ctx": 4096
    }
  },
  "email": { "transport": "gmail-api" }
}
```

## Notes
- The service sends one email To the sender and BCCs all recipients for privacy.
- The LLM is prompted to return only HTML (preferably in ```html code fences). Review output before sending.
- Set up credentials carefully; do not commit secrets.
- Logs are written to `logs/run.log` (global) and per-instance `logs/run.log`.
- Temporary prompt files are written to `outputs/tmp/` (global) or `artifacts/tmp/` (per-instance).
- meta.json in each instance folder tracks agent state.

## Endpoints
- `GET /health` — health check
- `POST /api/email/generate` — generate HTML
- `POST /api/email/send` — send email
- `POST /api/email/generate-send` — generate and send in one call

## Port Configuration
- The default port is 3001. You can override it by setting the `PORT` environment variable:
  - `PORT=3005 bash run.sh`

## Legacy
- The legacy shell script is kept for reference but is not required for REST operation.
