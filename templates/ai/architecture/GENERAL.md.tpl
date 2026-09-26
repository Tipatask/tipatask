# {{PROJECT_NAME}} — General Architecture

<!-- Seeded by tipatask-setup discover.js. Fill in TBD sections as you learn the codebase. -->

## Stack

{{STACK_SUMMARY}}

## Project Structure

{{DIR_TABLE}}

## Environment Variables

{{ENV_TABLE}}

## Local Setup

{{SETUP_COMMANDS}}

## Database / Storage

{{DB_NOTES}}

## Common Commands

{{COMMANDS_TABLE}}

## System Tags

See `ai/architecture/tt-*.md` for per-module details. Use MCP tools:
- `list_system_tags` — all registered `tt-*` tags
- `get_tag_architecture <tag>` — full architecture doc
- `create_system_tag` — register a new module tag + create stub

## Conventions

- Every code change that touches a module → update that module's `tt-*.md` before marking task complete — standing system facts only; task investigation notes, evidence tables and corrections go in the task's resolution comment (`create_task_comment`, type `resolution`), never in a `tt-*.md`.
- Changes to this file (structure, env vars, commands) happen when cross-cutting concerns change.
- See `CLAUDE.md` / `AGENTS.md` for agent workflow and communication style.
