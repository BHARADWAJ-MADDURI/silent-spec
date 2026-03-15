# SilentSpec

Auto-generates unit tests on file save using AI — silent, surgical, zero friction.

## Quick Start

1. Install the extension
2. Set your API key: `Ctrl+Shift+P` → `SilentSpec: Set API Key`
3. Save any `.ts` file — tests appear automatically

## Providers

- **GitHub Models** (free) — requires GitHub Personal Access Token
- **Ollama** (free, local) — runs automatically if detected
- **Claude** (Anthropic) — requires API key
- **OpenAI** — requires API key

## Commands

- `SilentSpec: Set API Key` — configure your provider
- `SilentSpec: Toggle Pause` — pause/resume auto generation
- `SilentSpec: Find Gaps in Current File` — detect untested functions
- `SilentSpec: Generate Tests for Current File` — manual trigger
- `SilentSpec: Open Output Log` — view generation logs
- `SilentSpec: Show Impact Report` — view stats

## Privacy

Telemetry is local-only and never transmitted.
