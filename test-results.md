# SilentSpec V1.0 — Pre-Launch Test Results

**Date:** 2026-03-15
**Tester:** Bharadwaj Madduri
**Extension version:** 0.0.1
**Provider:** GitHub Models (gpt-4o default)

---

## Summary

| Metric              | Result |
| ------------------- | ------ |
| Total tests run     | 15     |
| Tests passed        |        |
| Specs tsc clean     |        |
| Avg generation time |        |

---

## Test Results

| ID  | Test                       | Repo              | Pass | tsc Clean | Time | Notes                        |
| --- | -------------------------- | ----------------- | ---- | --------- | ---- | ---------------------------- |
| 1.1 | No token notification      | —                 | ✅   | N/A       | —    | Notification fired correctly |
| 1.2 | Token button opens URL     | —                 |      | N/A       |      |                              |
| 1.6 | Rapid saves debounce       | chaos-test        |      |           |      |                              |
| 2.1 | Ollama detected            | —                 |      |           |      |                              |
| 2.2 | Ollama fallback            | —                 |      |           |      |                              |
| 2.3 | Internet cut graceful      | —                 |      | N/A       |      |                              |
| 2.4 | 401 token rotation         | —                 |      | N/A       |      |                              |
| 3.1 | Test file silently skipped | —                 |      | N/A       |      |                              |
| 3.2 | No exports skip message    | —                 |      | N/A       |      |                              |
| 3.4 | Large file skip            | large-file-test   |      | N/A       |      |                              |
| 3.5 | Path aliases graceful      | bulletproof-react |      |           |      |                              |
| 4.1 | New spec created           | chaos-test        | ✅   |           |      | chaos.test.ts created        |
| 4.2 | User zones preserved       | chaos-test        |      |           |      |                              |
| 4.3 | Git conflicts aborted      | —                 |      | N/A       |      |                              |
| 4.4 | Ghost file no crash        | —                 |      | N/A       |      |                              |
| 4.5 | First run toast            | chaos-test        | ✅   | N/A       | —    | Fired on first generation    |

---

## Repo-Specific Results

| Repo              | File tested    | Spec created | tsc clean | Time(s) | Notes                  |
| ----------------- | -------------- | ------------ | --------- | ------- | ---------------------- |
| chaos-test        | chaos.ts       | ✅           |           |         | 6/6 functions detected |
| bulletproof-react | —              |              |           |         |                        |
| nestjs sample     | —              |              |           |         |                        |
| logic-bench       | logic-bench.ts |              |           |         |                        |
| cypress-rwa       | —              |              |           |         |                        |

---

## HumanEval Benchmark

| Dataset                       | Functions | Specs created | Tests passing | Pass rate |
| ----------------------------- | --------- | ------------- | ------------- | --------- |
| HumanEval-TS (logic-bench.ts) | 8         |               |               |           |
| javascript-algorithms         |           |               |               |           |
| MultiPL-E (humaneval-ts/)     |           |               |               |           |

---

## AI Output Quality Observations

### chaos.ts — 2026-03-15 — GitHub Models

**Functions detected:** 6/6 correct
**Spec created:** ✅ chaos.test.ts
**Header:** ✅ Date + source + functions covered
**SS markers:** ✅ SS-GENERATED-START/END present
**SS-USER-TESTS:** ✅ Present

**Issues found (2 — requires developer review):**

**Issue 1: Default export import syntax**

- Generated: `import { bootstrap } from './chaos'`
- Correct: `import bootstrap, { ... } from './chaos'`
- Root cause: AI conflated named and default export syntax
- Fix required: 1-line manual edit
- V1.1 fix: Pass exportMap (default/named) from AST analyzer
  to prompt builder so AI knows exact import syntax required

**Issue 2: Generic type incompatibility**

- Generated: test passing `{ b: null, c: undefined }` to
  `deepMerge<T extends Record<string, unknown>>`
- Root cause: AI did not respect TypeScript generic constraints
- Fix required: Replace one test case
- V1.1 fix: Add prompt instruction — when testing generic
  functions, use type-safe values matching the constraint

**After manual fixes:**

- tsc clean: [fill in]
- Tests passing: [fill in]/X
- Assessment: Core generation correct. Two TypeScript-specific
  edge cases caught. Demonstrates need for developer review pass
  on generated output.

---

## V1.1 Backlog (from testing)

| #   | Finding                            | Fix                                                 | Priority |
| --- | ---------------------------------- | --------------------------------------------------- | -------- |
| 1   | Default vs named export confusion  | Add exportMap to AST output, pass to prompt         | High     |
| 2   | Generic type constraint violations | Add prompt instruction for generic-safe test values | Medium   |
