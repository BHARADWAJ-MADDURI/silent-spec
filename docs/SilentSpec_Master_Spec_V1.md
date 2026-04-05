**SilentSpec**

Master Functional Specification

Version 1.0 --- Post-Audit Stabilization (Final)

*Publisher: bharadwajmadduri.silent-spec*

Last Updated: March 24, 2026 --- All 25 Requirements Delta-Verified

**1. Product Overview**

SilentSpec is a VS Code extension that automatically generates and
maintains TypeScript unit tests on file save using AI. It supports four
AI providers, four test frameworks, and produces structured spec files
with protected zones that preserve user-written tests.

  ---------------------- ------------------------------------------------
  **Property**           **Value**

  Extension ID           bharadwajmadduri.silent-spec

  Default Provider       GitHub Models (gpt-4o)

  Supported Providers    GitHub Models, Claude (claude-sonnet-4-6),
                         OpenAI (gpt-4o), Ollama (auto-detected)

  Supported Frameworks   Jest, Vitest, Mocha, Jasmine

  Supported Languages    TypeScript (.ts, .tsx), JavaScript (.js, .jsx)

  Architecture           4-zone protected spec file with SS markers
  ---------------------- ------------------------------------------------

**2. V1 AST Gate --- Testable Symbol Detection**

**2.1 Validated V1 Testable Targets**

SilentSpec proceeds when at least one of the following exported runtime
symbols is detected:

- Exported named functions

- Exported default functions

- Exported arrow functions assigned to const

- Async functions (exported)

- Generic functions (exported)

- Overloaded functions (treated as one symbol)

**2.2 Non-Targets --- Skip Without Generation**

- Files with zero exported runtime symbols

- Files with only type/interface/enum exports

- Files with only re-exports (export { x } from \'./y\')

- Files with only unexported top-level functions

- Non-function exported variables (constants, config objects) --- V1.1

*The unexported function fallback was removed in V1. Zero exported
runtime symbols → Skipped: no exported testable symbols*

**3. Save Pipeline & Trigger Logic**

**3.1 Skip Conditions (in order)**

  --------------------- -------------------------- ---------------
  **Condition**         **Log Line**               **Impact**

  Untitled document     Skipped: untitled document Silent return

  Non-file URI scheme   Skipped: non-file scheme   Silent return
                        (scheme)                   

  No workspace folder   Skipped: no workspace      Silent return
  open                  folder open                

  Extension paused      Skipped: extension paused  Silent return

  Test/spec file        Skipped: test file ---     No pipeline
                        path                       

  Unsupported extension Skipped: unsupported       No pipeline
                        extension                  

  File too large        Skipped: file too large (N No API call
  (\>1500 lines)        lines)                     

  No exported testable  Skipped: no exported       No API call
  symbols               testable symbols           

  All functions covered Skipped: all N functions   No API call
                        covered --- no generation  
                        needed                     

  Already processing    Skipped: already           No API call
                        processing filename        
  --------------------- -------------------------- ---------------

**3.2 Debounce Behavior**

- 2-second debounce per file before processing begins

- Debounce is scoped per file path (Map-keyed)

- No overlapping executions for the same file (processingLock Set)

- Files processed serially via ProcessingQueue

**4. File Placement & Protected Zone Architecture**

**4.1 Spec Path Resolution Priority**

Existing file always wins. Never creates a duplicate.

- Pass 1: Existing spec in adjacent \_\_tests\_\_/ or test/ beside
  source

- Pass 2: Existing spec beside source file

- Pass 3: Existing spec in root-level \_\_tests\_\_/ or test/
  (lookup-only --- never creates here)

- Pass 4: New file in adjacent \_\_tests\_\_/ only if pattern already
  established

- Pass 5: Default --- beside source file

**4.2 Collision Detection**

Before returning a path in a shared test directory, ownership is proven
via relative source path stored in spec header (e.g. // Source:
src/api/utils.ts). Basename-only match accepted only for workspace-root
files as legacy fallback. If ownership cannot be proven, falls back to
beside-source with log: Spec placement: basename collision detected ---
placing beside source

**4.3 Unmanaged File Protection**

*If a spec file exists at the resolved path but has neither a SilentSpec
header nor any SS marker, it is treated as unmanaged and never modified.
Log: Spec file: not managed by SilentSpec --- skipping*

Same guard applies in gapFinder --- findGaps refuses to proceed on
unmanaged files and shows a user-facing warning message.

**4.4 Zone Structure**

  --------------- ---------------------- --------------- -------------------
  **Zone**        **Markers**            **Ownership**   **Behavior**

  SS-IMPORTS      //                     SilentSpec      Replaced on full
                  \<SS-IMPORTS-START\> /                 generation only
                  END                                    

  SS-HELPERS      //                     SilentSpec      Replaced on full
                  \<SS-HELPERS-START\> /                 generation only
                  END                                    

  SS-USER-TESTS   // \<SS-USER-TESTS\> / User            NEVER modified
                  \</SS-USER-TESTS\>                     under any
                                                         circumstance

  SS-GENERATED    //                     SilentSpec      Replaced or
                  \<SS-GENERATED-START                   appended per mode
                  \...\> / END                           
  --------------- ---------------------- --------------- -------------------

*In append mode, SS-IMPORTS and SS-HELPERS are never replaced. Only
SS-GENERATED is updated. This is consistent with appendGapTests()
behavior.*

**5. Provider Abstraction**

**5.1 Provider Selection Order**

- If user explicitly configured a provider, use it

- Otherwise default to GitHub Models (github)

- If active provider is still default AND Ollama detected running on
  activation → may override to Ollama for session

**5.2 Ollama Auto-Detection**

- Runs ONCE per activation --- cached in cachedOllamaRunning
  module-level variable (boolean \| null)

- Never overrides explicit user choice

- If cachedOllamaRunning is null during provider resolution, treated as
  false --- no re-call

- If no models loaded: logs exact message and returns null without
  making API call

- Known V1 behavior: Ollama started after VS Code activation is not
  detected until next reload

**5.3 Error Handling**

  ---------------------- ----------------------------------------
  **Scenario**           **Behavior**

  Missing API key        Block generation, show setup
                         notification, no provider call

  401 response           Stop, delete stored key, notify user, no
                         partial write

  429 response           Stop, notify user, no auto-retry in V1

  Network                Stop, existing spec preserved unchanged
  failure/timeout        

  Empty/malformed        Discard entirely, no partial write, log
  response               reason

  Cost not acknowledged  Block generation for paid providers
                         (claude, openai)
  ---------------------- ----------------------------------------

**6. Framework Detection & Mock Alignment**

**6.1 Detection Priority**

  --------------- -------------------------- ---------------------
  **Framework**   **Detection Key(s)**       **Priority**

  Vitest          deps\[\'vitest\'\]         1 (highest)

  Mocha           deps\[\'mocha\'\]          2

  Jasmine         deps\[\'jasmine\'\]        3

  Jest            deps\[\'jest\'\] \|\|      4
                  deps\[\'ts-jest\'\] \|\|   
                  deps\[\'babel-jest\'\]     

  Default (no     n/a --- returns jest with  5 (fallback)
  framework       detected: false            
  found)                                     
  --------------- -------------------------- ---------------------

**6.2 Mock Hint Alignment**

  --------------- ------------------------------------------------
  **Framework**   **Mock Function**

  vitest          vi.mock(\...)

  jest (detected  jest.mock(\...)
  or fallback)    

  mocha / jasmine sinon-style comments (no mock function injected)
  --------------- ------------------------------------------------

*No cross-contamination path exists. Framework detection and mock
selection are independent if-chains with no shared mutable state.*

**7. Gap Detection & Append Pipeline**

**7.1 Coverage Tracking**

- Coverage tracked via covered attribute in SS-GENERATED-START marker

- On every save, compares exportedFunctions (AST) against marker.covered

- Detection based on symbol names, not semantic equivalence

- All covered → skip with exact log line

**7.2 Batch Behavior**

- Default batch size: 5 functions per API call

- Adaptive threshold configured at 12,000 chars (spec says 8,000 ---
  V1.1 alignment pending)

- Partial batch triggers automatic follow-up --- no manual re-save
  required

- 3-attempt cap per function to prevent infinite loops

**7.3 healerMode Propagation**

- Initial generation respects safe mode (ctx.healerMode set by
  preflight)

- Save-triggered gap fill batches inherit ctx.healerMode from same
  processing flow

- Auto-scheduled gap fill batches also inherit ctx.healerMode

- Command-triggered gap finder (findGaps command) always uses full mode
  --- intentional, no preflight runs

**8. Healer Architecture**

**8.1 Healer Modes**

  ----------- ---------------------- -----------------------------
  **Mode**    **Triggered By**       **Behavior**

  full        Default / healthy      Full surgical repair
              environment            including test removal if
                                     necessary

  safe        Preflight detects      Import fixes only --- test
              missing types          removal disabled
  ----------- ---------------------- -----------------------------

**8.2 Safe Mode Behavior**

- Forbidden: remove any it()/describe()/test() block

- Allowed: fix import paths, add missing imports, apply type casts, fix
  minor syntax

- TS2582 errors skipped without removing the block

- Banner injected idempotently at SS-GENERATED top when env not ready

**9. Status Bar States**

  --------------- ------------------------ ------------------------
  **State**       **Display**              **When**

  Idle (active)   SilentSpec \$(check) --- Extension ready
                  \[provider\]             

  Idle (paused)   \$(debug-pause) Paused   togglePause active

  Generating (1   \$(sync\~spin)           Single file generating
  file)           Generating\...           

  Generating (N   \$(sync\~spin)           Multiple concurrent
  files)          Generating (N files)\... 

  Pending         \$(sync\~spin)           Gap fill continuing
                  Generating\... (N        
                  pending)                 

  Done (with      \$(check) Done --- N     Generation complete
  count)          covered                  

  Done (no count) \$(check) Done           Marker unavailable

  Skipped         \$(circle-slash)         Any skip triggered
                  Skipped: reason          

  Failed:         \$(error) Failed:        Provider null/threw
  provider        provider error           

  Failed: invalid \$(error) Failed:        Validation failed
                  invalid response         

  Failed: env     \$(error) Failed: env    Safe mode, no tests
                  not ready                

  Failed: healer  \$(error) Failed: healer Full mode, all removed
                  removed all tests        

  Failed: default \$(error) Failed:        Unhandled throw
                  unexpected error         
  --------------- ------------------------ ------------------------

**10. Structured Log Lines**

Every generation attempt produces these three structured log lines in
order:

\[SilentSpec\] Spec written: yes/no

\[SilentSpec\] Spec compile-ready: yes/no

\[SilentSpec\] Reason: ok / provider exception / provider error /
invalid response / \...

These fire on both success and failure paths. Skip paths
(pre-generation) do not emit these lines.

**11. Telemetry**

**11.1 Storage**

- Local only --- stored in globalStorageUri/stats.json

- No network calls, no fetch, no http, no WebSocket in TelemetryService

- Stats file missing or corrupted → graceful fallback to DEFAULT_STATS,
  no crash

**11.2 What Is Tracked**

- totalGenerations, successfulGenerations, failedGenerations

- functionsCovered (cumulative batch-covered count)

- estimatedHoursSaved, testsHealed, lastProvider, lastGeneratedAt

- failureBreakdown by category (provider_error, invalid_response,
  no_describe_found)

- functionAttempts keyed by function name (identifier only --- no code
  content)

**11.3 Known V1 Accuracy Limitation**

*testsHealedSuccessfully counter is never incremented in the main save
path --- the second parameter to recordHealing() is always passed as 0.
The heal success rate metric therefore shows 0% in V1. This is a
metrics-accuracy issue only, not a privacy or safety concern. Fix
deferred to V1.1.*

**11.4 Privacy Guarantee**

- No raw file path, file content, prompt text, or generated code stored

- Call sites pass only aggregate counts, provider name, and failure
  category

- functionAttempts stores identifier names only (e.g.
  \'calculateTotal\') --- no code body

**12. Known V1 Limitations (Confirmed Backlog)**

  ---------------------------- -------------------- -------------------------------
  **Item**                     **Classification**   **Notes**

  Non-function exported        V1.1                 Needs dedicated value export
  variables (constants) not                         test template
  detected                                          

  Late export { TypeName }     V1.1                 Add exportKind guard at
  without type keyword                              astAnalyzer.ts:76
  misclassified as runtime                          

  Adaptive batch threshold 12k V1.1                 Fix threshold +
  vs spec 8k --- dead adaptive                      DEFAULT_MAX_FUNCTIONS_PER_RUN
  code                                              

  Gap fill import path         V1.1                 appendGapTests strips imports;
  inconsistency between two                         writeSpecFile append updates
  paths                                             them

  Stray content outside zone   V1.1                 Non-destructive --- warn only
  boundaries not detected                           

  Debounce timer cleanup on    V1.1                 2s race window on extension
  deactivate                                        deactivation

  generateNow on spec file --- V1.1                 Warning message shown but not
  no output channel log                             logged

  Gap finder Done state shows  V1.1                 Requires re-reading marker at
  no covered count                                  gap finder call site

  Command-triggered gap finder V1.1 design          No preflight for command path
  always uses full healer mode                      --- intentional for V1

  testsHealedSuccessfully      V1.1                 Second param to recordHealing()
  counter always 0 in main                          always passed as 0
  path                                              

  Ollama started after VS Code V1 design            Cached per activation ---
  activation not detected                           reload VS Code window to pick
                                                    up Ollama

  env not ready shown as       V1.1 UX              Previously warning-style ---
  \$(error) Failed: env not                         messaging nuance revisit in
  ready                                             V1.1
  ---------------------------- -------------------- -------------------------------

**13. V1 Validation Matrix**

The following matrix defines every combination that must be tested
before README claims are finalized. Cut any claim that does not survive
live testing.

**13.1 Provider × Framework Matrix**

  --------------- ------------------- ---------- ------------ ----------- -------------
  **Provider**    **Model**           **Jest**   **Vitest**   **Mocha**   **Jasmine**

  GitHub Models   gpt-4o              Required   Required     Required    Optional
  (default)                                                               

  Claude          claude-sonnet-4-6   Required   Required     Optional    Optional

  OpenAI          gpt-4o              Required   Optional     Optional    Optional

  Ollama          auto-detected       Required   Optional     Optional    Optional
  --------------- ------------------- ---------- ------------ ----------- -------------

*Required = must pass before claiming support in README. Optional = test
if time permits; do not claim if untested.*

**13.2 Scenario Test Cases (per combination)**

  -------- ------------------------ ------------------------------------
  **\#**   **Scenario**             **Expected Outcome**

  T1       Save exported function   Spec created beside source, all
           --- cold start (no spec  zones present, tests compile
           exists)                  

  T2       Save same file again --- Skipped: all N functions covered ---
           all covered              no generation needed

  T3       Add new export, save --- Gap fill runs, new test appended in
           gap detected             SS-GENERATED, existing tests
                                    preserved

  T4       Save file with only      Skipped: no exported testable
           unexported functions     symbols

  T5       Save file \>1500 lines   Skipped: file too large (N lines)

  T6       Save hand-written spec   Spec file: not managed by SilentSpec
           file                     --- skipping

  T7       Run findGaps on          User-facing warning, no writes
           unmanaged spec           

  T8       Save with no workspace   Skipped: no workspace folder open
           folder open              

  T9       Save type-only file      Skipped: no exported testable
           (interfaces/enums only)  symbols

  T10      Provider API key missing Block + setup notification shown, no
                                    provider call
  -------- ------------------------ ------------------------------------

**13.3 Healer Fault Injection Scenarios**

  -------- ------------------------ ------------------------------------
  **\#**   **Scenario**             **Expected Outcome**

  H1       Generated spec has wrong Healer fixes import, compile-ready:
           import path              yes

  H2       Generated spec missing   Safe mode: tests preserved with
           \@types/jest (safe mode) banner, no removal

  H3       Generated spec has type  Healer applies casts, compile-ready:
           errors (full mode)       yes

  H4       Generated spec is        Discard, Spec written: no, Reason:
           completely invalid ---   no_describe_found
           no describe()            

  H5       Spec file has git        Skip write entirely, existing file
           conflict markers         preserved
  -------- ------------------------ ------------------------------------

**13.4 Real Project Validation**

  ------------------------------------- ------------------- ------------------------
  **Project**                           **Type**            **Purpose**

  logic-bench                           TS + Jest ---       Primary benchmark:
  (\~/silentspec-testing/logic-bench)   synthetic           chaos.ts +
                                                            logic-bench.ts

  bulletproof-react or equivalent       TS + Vitest ---     Vitest cold start
                                        real OSS            validation

  Express or similar                    JS + Jest --- real  JavaScript (.js) source
                                        OSS                 file support
  ------------------------------------- ------------------- ------------------------

**13.5 Result Tracking**

  ------------------- -------- -------- -------- ------------ ------------ ------------
  **Combination**     **T1**   **T2**   **T3**   **T4-T10**   **Healer**   **Status**

  GitHub Models +                                                          Pending
  Jest                                                                     

  GitHub Models +                                                          Pending
  Vitest                                                                   

  GitHub Models +                                                          Pending
  Mocha                                                                    

  Claude + Jest                                                            Pending

  Claude + Vitest                                                          Pending

  OpenAI + Jest                                                            Pending

  Ollama + Jest                                                            Pending
  ------------------- -------- -------- -------- ------------ ------------ ------------

**14. Files Changed --- Audit Stabilization Pass**

Files modified during the 6-subsystem audit and fix sprint (March 2026):

  -------------------------- ------------------------------------------
  **File**                   **Changes**

  src/fileWriter.ts          Unmanaged file guard, resolveSpecPath
                             rewrite (Pass 3/4/5), collision detection
                             with relative path ownership, append mode
                             SS-IMPORTS isolation

  src/gapFinder.ts           Unmanaged file guard before gap fill
                             proceeds

  src/astAnalyzer.ts         Removed unexported function fallback (28
                             lines), fixed skip log strings

  src/saveHandler.ts         Workspace folder guard, skip logs for
                             untitled/non-file, Skipped: colon format

  src/extension.ts           compile-ready on failure paths, Ollama
                             caching, status bar alignment, healerMode
                             propagation through runOneGapBatch

  src/contextExtractor.ts    detectFramework returns { framework,
                             detected } --- distinguishes jest found vs
                             jest fallback

  src/ai/ollamaProvider.ts   detectBestModel returns null when no
                             models, clear user message before API call
  -------------------------- ------------------------------------------

**15. Launch Checklist**

**Completed**

- 36/36 P0 tests confirmed complete

- 7 confirmed bugs fixed with clean build

- 6 subsystem audits completed

- All BLOCKS_LAUNCH findings resolved

- Delta audit: 25/25 requirements verified PASS (1 PARTIAL on telemetry
  accuracy --- non-blocking)

- type-check zero errors, build clean on all fix prompts

- Master Functional Specification updated and finalized

**Remaining Before Publish**

- Matrix testing --- Required combos in Section 13.1

- Healer fault injection --- 5 scenarios in Section 13.3

- Real project validation --- Section 13.4

- README finalization --- cut claims that do not survive matrix testing

- Clean install test (fresh VS Code profile)

- Demo GIF recording

- VS Code Marketplace publish

*SilentSpec Master Functional Specification --- V1.0 Final \| Delta
Audit Verified 2026-03-24*
