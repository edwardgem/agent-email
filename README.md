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
  - `async` (boolean) — If `true`, requires `instance_id` and returns `202 Accepted` immediately after activating the instance; processing continues in background. See Async Mode below.
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
  - `async` (boolean) — If `true`, requires `instance_id` and returns `202 Accepted` immediately after activating the instance; processing continues in background.
  - Recipients from config.json:
    - Keys: `to`, `cc`, `bcc` (lowercase arrays of emails). At least one must be non-empty.

### Generate and Send (one call)
```
curl -X POST http://localhost:3001/api/email-agent/generate-send \
  -H "Content-Type: application/json" \
  -d '{
    "instance_id": "email-20250909140103"
  }'
```
- Parameters: Same as Generate for prompt control; then sends the resulting HTML.
- Recipient handling: Matches `/send` — uses lowercase `to`/`cc`/`bcc` from config. If none are present, the request fails with `no_recipients_configured`.
 - Supports `async: true` (requires `instance_id`).

### Async Mode
- For long-running operations, you can request asynchronous processing by setting `"async": true` and providing `"instance_id"`.
- The server returns `202 Accepted` immediately after marking the instance `meta.json` to `status: "active"`.
- Response example:
```
{
  "accepted": true,
  "status": "active",
  "instance_id": "email-20250909140103",
  "links": { "status": "/api/email-agent/status?instance_id=email-20250909140103" }
}
```

### HITL Config
Add one of the following sections to enable/define HITL behavior for instance runs:
```
{
  "human-in-the-loop": { "enable": true }
}
```
or
```
{
  "HITL": { "enable": false }
}
```
or
```
{
  "hitl": { "enable": true }
}
```
At least one of `human-in-the-loop`, `HITL`, or `hitl` must be present; otherwise the send flow aborts with `missing_hitl_config_section`.
- The background task continues and will update `meta.json` high-level `status` to `"finished"` or `"abort"`, and set fields like `last_error`, `last_html_path`, and/or `last_send_id`.
- Progress tracking is stored as an array in `meta.json` under `progress`, each item is `[timestamp, message]`:
```
{
  "status": "active",
  "progress": [
    ["2025-09-13 10:00:01", "llm generating email"],
    ["2025-09-13 10:00:05", "writing html output"],
    ["2025-09-13 10:00:10", "generated html"],
    ["2025-09-13 10:00:15", "sending emails"],
    ["2025-09-13 10:00:19", "sent email"]
  ]
}
```

Check status:
```
curl -s "http://localhost:3001/api/email-agent/status?instance_id=email-20250909140103"
```
- Returns content from the instance’s `meta.json`, e.g.:
```
{
  "instance_id": "email-20250909140103",
  "status": "finished",
  "started_at": "2025-09-13 10:00:01",
  "finished_at": "2025-09-13 10:01:45",
  "last_html_path": "artifacts/email.html",
  "last_send_id": "188d5c1f1a2b3c4"
}
```
On failure, expect `status: "abort"` and `last_error` populated.

## Config Format (config.json)
```
{
  "email_subject": "Subject line",
  "sender_email": "you@example.com",
  "sender_name": "Your Name",
  "html_output": "artifacts/email.html",
  "prompt_file": "prompt.txt",
  // Recipient lists
  "to": ["a@example.com"],
  "cc": ["team@example.com"],
  "bcc": ["hidden@example.com"],
  "email": { "transport": "gmail-api" }
}
```
Backward compatibility: Uppercase keys (`EMAIL_SUBJECT`, `SENDER_EMAIL`, `SENDER_NAME`, `HTML_OUTPUT`, `PROMPT_FILE`) are still supported and normalized internally.

## Notes
- Provide recipients via `to`/`cc`/`bcc` in the instance config; at least one must be non-empty.
- The LLM is prompted to return only HTML (preferably in ```html code fences). Review output before sending.
- Set up credentials carefully; do not commit secrets.
 - Logs are written to `logs/run.log` (global) and per-instance `logs/run.log`.
   - Local logs always include full details (including full prompts and HTML content).
   - The REST logging at `LOG_API_URL` captures state and key events for observability; it does not include full prompt/HTML content.
  - Progress events are mirrored to logging: each progress update (llm generating email, writing html output, generated html, sending emails, sent email) is also emitted via `agent_log` and, for per-instance runs, POSTed to `LOG_API_URL`.
- Human-in-the-loop (HITL): Before sending, the agent calls a HITL endpoint to get a decision.
  - Configure `HITL_API_URL` in `.env` (e.g., `HITL_API_URL=http://localhost:4001/api/hitl-agent`). If you set only a path like `/api/hitl-agent`, it will default to the current server port.
  - Request body includes: `{ instance_id, html_path?, html?, hitl: <instance HITL config>, HITL: <raw HITL section>, human_in_the_loop: <raw human-in-the-loop section>, loop: <current loop index> }`.
  - HITL decisions supported: `no-hitl` (proceed), `wait-for-response` (pause and keep the instance active; the API returns `waiting-for-response`), or `active` (treated the same as `wait-for-response`).
  - Error policy: If the instance config’s `human-in-the-loop.enable` or `HITL.enable` is true, a HITL error aborts the run; otherwise the agent proceeds (still logs the error).
  - Config requirement: For instance runs, your `config.json` must include a HITL section under one of these keys: `"human-in-the-loop"`, `"HITL"`, or `"hitl"`. If missing, the run aborts with error `missing_hitl_config_section`.
  - Dev mock: You can enable a built-in mock endpoint by setting `HITL_MOCK=1` in `.env`. It exposes `POST /api/hitl-agent` directly on this server. Default behavior returns `{ status: "no-hitl" }`. You can override via query `?decision=no-hitl|wait-for-response|active`.

Async flow with HITL
- The server makes a single POST to the HITL endpoint and expects 200 OK with a JSON body containing `status`.
- If `status` is `no-hitl`, the server proceeds to send the email.
- If `status` is `wait-for-response` or `active`, the server stops contacting HITL and leaves the run active:
  - Sync requests respond with `200 { ok: true, status: 'waiting-for-response' }`.
  - Async requests return `202 Accepted` initially; the background job exits early, leaving the instance status as `active`.
- To resume, your HITL system (or a human tool) must call the WI callback endpoint on this server:
  - `GET /api/email-agent/wi_response?instance_id=...&respond=approve|modify|reject`
    - `approve` — sends the default generated HTML (`artifacts/email.html`) and finalizes the run.
    - `modify&info=...` — regenerates HTML with the supplied info; stays active (you can call again to approve/reject later).
    - `reject` — aborts the run.
- Temporary prompt files are written to `outputs/tmp/` (global) or `artifacts/tmp/` (per-instance).
- meta.json in each instance folder tracks agent state.

## Environment
- `AGENT_FOLDER`: Parent directory for all instance folders. Required when using `instance_id`.
 - Note: The server reads environment variables from `.env` in this project root only. Do not place `.env` files in the instance folders; per-instance settings belong in each instance's `config.json`.
 - HITL settings:
   - `HITL_API_URL`: Absolute URL (e.g., `http://localhost:4000/api/hitl-agent`) or path (e.g., `/api/hitl-agent`). If path, the server will call `http://127.0.0.1:<HITL_API_PORT || PORT || 3001>`.
   - `HITL_API_PORT`: Optional port to use when `HITL_API_URL` is a path.

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
- `GET /api/email-agent/status?instance_id=...` — returns per-instance `meta.json` (status, job info)
- `GET /api/email-agent/progress?instance_id=...` — returns `{ instance_id, latest: [timestamp, message] | null }`
- `GET /api/email-agent/progress-all?instance_id=...` — returns `{ instance_id, progress: [[timestamp, message], ...] }`
- `GET /api/email-agent/wi_response?instance_id=...&respond=approve` — work‑item response; when `respond=approve`, sends the instance's default generated HTML email (`artifacts/email.html`) and returns send id
 - HITL (external): `POST /api/hitl-agent` — expected to accept `{ instance_id, html_path?, html? }` and return `{ status: "no-hitl" | "wait-for-response" }`.
 - Note: The HITL endpoint may also return `{ status: \"active\" }`, which the server treats the same as `\"wait-for-response\"`.

## Port Configuration
- The default port is 3001. You can override it by setting the `PORT` environment variable:
  - `PORT=3005 bash run.sh`

## CLI Sender (optional)
- A standalone CLI script `mcp_email_sender.sh` can generate and send emails without the REST server using Claude CLI + Gmail MCP.
- It reads the same config keys: `email_subject`, `sender_email`, `sender_name`, `html_output`, `prompt_file`, and recipient lists `to`/`cc`/`bcc`.
- Use it when you prefer a quick CLI workflow or for debugging without running the REST server.
