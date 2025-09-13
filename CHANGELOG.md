# Changelog

All notable changes to this project will be documented in this file.

## v1.0.0 – 2025-09-13

Breaking changes
- REST base path changed to `/api/email-agent/*` (was `/api/email/*`).
- Instance selection switched to `instance_id` + `AGENT_FOLDER`; removed `instance_path` support.

Features & improvements
- Refactored server flows: `generate-send` now reuses `generate` and `send` logic via shared helpers.
- Instance vs project pathing fixed and unified:
  - Instance runs read `config.json`/`prompt.txt` from the instance folder and write to `artifacts/email.html`.
  - Project (no instance) runs use repo `config.json`/`prompt.txt` and write to `outputs/email.html`.
  - Inline inputs materialize to temp files in `artifacts/tmp/` (instance) or `outputs/tmp/` (project).
- Logging policy clarified and enforced:
  - Instance runs log to remote logger service AND per‑instance `logs/run.log`.
  - Project runs log only to repo `logs/run.log`.
- Added support for edit mode via `instructions`, defaulting source HTML per context (instance vs project).

Docs
- Updated README to reflect new endpoints, `instance_id` usage, `.env` location (project root), and `AGENT_FOLDER`.
- Added `.env.example` entry for `AGENT_FOLDER`.

Notes
- To test instance runs, set `AGENT_FOLDER` in `.env`, then pass `{ "instance_id": "<your-instance>" }` to the endpoints.
