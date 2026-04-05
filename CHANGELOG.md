# Change Log

All notable changes to the "silent-spec" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [1.0.0] - 2026-04-05

### Added
- Auto-generates TypeScript/JavaScript unit tests on file save using AI providers
- Four-zone spec file architecture (SS-IMPORTS, SS-HELPERS, SS-USER-TESTS, SS-GENERATED) preserving user-written tests across all runs
- Support for GitHub Models (default, free), Claude (Anthropic), OpenAI, and Ollama (local) providers
- Adaptive batch sizing: reduces functions-per-AI-call based on file length and provider caps
- Gap detection: compares `covered` marker attribute against current AST exports to find missing tests
- `healSpec` TypeScript Compiler API-based diagnostic analysis — removes broken generated tests, preserves user tests
- Preflight check: detects missing `@types/*` packages, attempts auto-install, sets safe/full healer mode
- Ollama auto-detection on activation: silently overrides to local model when Ollama is running and no provider is explicitly configured
- Status bar indicator showing current provider, processing state, and pause/resume control
- `silentspec.enabled` setting to disable all processing without uninstalling
- `silentspec.pause` command to temporarily suspend test generation
- Serial processing queue (per-spec-path lock) preventing concurrent writes to the same spec file
- 5-pass spec file placement resolution with collision detection
- Debounced save handler (2 s) to avoid triggering on rapid successive saves
- Structured log output with configurable skip-path filters

### Fixed
- `silentspec.enabled` setting is now wired into the save handler and respected on every save event
- `healSpec` precheck `execSync` call now has a 12 s timeout, matching `shellTscVerifySpec`
- Ollama auto-override now only activates when `silentspec.provider` has not been explicitly set by the user
- GitHub token setup flow no longer auto-triggers the Set Token dialog 3 s after opening the tokens page

## [Unreleased]
