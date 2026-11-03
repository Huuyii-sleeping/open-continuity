# Changelog

All notable changes to OpenContinuity are documented here. The project follows Semantic Versioning; prerelease versions may still change before the corresponding stable release.

## [Unreleased]

### Fixed

- Update the locked MIT-licensed `@hono/node-server` dependency from 2.1.1 to 2.1.6 to address GHSA-rmxm-3fg6-px4f; keep the MCP SDK and public dependency ranges unchanged.

- Add opt-in bidirectional Dense rescue with an independent bounded window, original top-hit preservation, nearest-neighbour contradiction veto and unique mutual support. Bind direction to verifier evidence/caches and audit reverse work and partial windows. Default lexical/score-gate behavior remains unchanged, with no new inference dependency or Adapter change.
- Add rescue/permission/deadline/cursor regressions and paired model evaluation, retaining original labels, rejected ablations and exposed challenges. Reject stale generations and unavailable reverse inference before scoring. Quality gains remain modest; existing wrong selections are retained.

- SQLite schema 5 indexes decoded JSON literal values and field names, avoiding escaped-path/quote misses and serialization-only false matches. Preserve authoritative values/events; add stable integer FTS row pointers, transactional migration/rebuild and content-change-only trigger maintenance. SQLite scored cursors bind `lexicalIndexVersion`; restart pagination after migration. Candidate receipts and actual capability discovery expose the index version additively. Other stores retain their declared substring compatibility paths.
- Add separate literal-value regressions and cross-store retry/CAS/history/reopen tests, plus SQLite migration rollback, pointer rollback, VACUUM backup/restore and imported-ID replacement coverage. Existing quality judgments and permissions are unchanged; import still requires an empty target. New synthetic results and write/import costs are reported separately from semantic challenges.

- Dense quality evaluation now rejects unavailable query embedding, pair inference, incomplete indexes and Query deadlines before scoring, including Query calls whose final pack omits channel receipts. Add nine fictional inference and lifecycle regressions; genuine model rejection remains scoreable. Disabled control arms never allocate a verifier, invalid judgments are checked before model allocation, and failed warmup/construction releases initialized owners. Include all Dense evaluation entry points in strict typechecking and explicitly type report rows.

### Removed

- Withdraw the unreleased manual term-alias experiment, its constructor option, explanations/capabilities, and dedicated evaluation command. Stale `termAliases` constructor settings now fail explicitly; default literal retrieval and its cursor fingerprints remain. No persisted schema or database migration. Automatic model-assisted query rewriting remains unimplemented.

### Added

- Add reviewed Handoff preparation/confirmation to Core, MCP and HTTP, plus normal CLI prepare/review/confirm/resume commands. Drafts are read-only with respect to long-term memory, default private, content/identity/target-bound and valid for24 hours. Source Agents must present the draft before explicit user approval; no transcript harvesting or default model dependency.
- Add built-in atomic target-ID/source-event/version checks inside the existing write transaction or JSON compatibility lock, retaining original idempotent receipts across later writes and Forget. Custom stores must explicitly implement `handoffReviewVersion`; capability discovery reports actual support. Keep Capsule1.0 and SQL schemas, recording review metadata in the event ledger.
- Add cross-store review/ABA/private/idempotency, CLI, HTTP authorization and independent MCP process regressions, and installed-package reviewed Handoff smoke. Real model task performance remains separate from protocol evidence.

- Add opt-in query/document relevance reranking over at most 20 authorized Dense candidates. Preserve the original verified selection on normal rejection; unavailable inference remains an explicit failure. Separate model ownership, source/query/access-bound scores, pure ordering and two-phase selection; keep original cosine/NLI admission and shared deadlines.
- Add raw Cross-Encoder score and original cosine-rank evidence, bounded verification-phase receipts, and configuration-based rerank capability discovery. Model/policy/window changes invalidate experimental cursors; default fingerprints, service wiring and production dependencies remain unchanged.
- Add independent reranker, ordering, selection, lifecycle, invalidation and evaluation regressions plus a fictional 248-memory candidate-window challenge. Batch evaluation indexing with progress checks; keep original labels and distinguish ranking diagnostics, final recall, false selections and no-answer false matches.

- Separate Dense ranking, access/revision-bound snapshot caching, and local model-veto lifecycle into independent modules. SQLite projects authorized vectors and hydrates only bounded current references; vector-table triggers invalidate cached generations. Default factories remain lexical and install no inference dependency.
- Add typed, source-event/version/access/content/query-bound verifier receipts and carry accepted evidence through existing Recall/Context/Query paths. Budgeted candidates and unavailable verification remain distinguishable; experimental policies evolve their fingerprints, with default cursors unchanged.
- Add 17 projection/verifier/parity contract tests, same-ledger quality counterfactuals, cache-disabled model reloads and three-round fresh-process capacity comparisons. Report cold/warm costs separately and retain false positives, false negatives and heavier-model resource failures; default semantic retrieval remains OFF.

- Add an explicit Core-only SQLite Dense experiment: local model session port/ownership, optional derived vector/job tables with transactional invalidation and event/version/model-epoch CAS, authorized streaming cosine search, independent rank fusion and fail-open Dense receipts. Default model loading remains OFF; no inference dependency, download or Agent adapter change.
- Extend result/capability types additively for `dense`, fingerprinted cosine evidence and experimental Context selection/coverage. Experimental cursors bind model/policy/index generation; default fingerprints and authority schema remain unchanged. Other builtin stores explicitly reject unsupported Dense reads.
- Add separate Dense engineering/permission tests and real-model OFF/miss-only/hybrid regression evaluation without changing labels or thresholds. Synthetic semantic gains coexist with negation errors; stream scanning reduces materialization cost, while 10k linear scanning and cross-platform/model-installation gaps remain documented.

- Staged directional Dense text-pair verification with query/content/model/policy-bound receipts, explicit unavailable/contradiction/insufficient states, and independent validation tests. Add a streaming local-model artifact verifier with manifest/size/hash/path and symlink boundary checks. Fixed-weight external ONNX/local platform experiments reduce embedding residency; small-verifier quality and stronger-verifier resource failures remain explicit. No default semantic channel, production model dependency, storage schema or Adapter change.

- Staged, independently testable Dense admission and local model lifecycle ports: fingerprinted same-space score/margin decisions over authorized complete comparisons; coalesced loading, bounded outstanding work, idle resource release and fail-closed retirement. Neither port is wired into the default service. External same-model cost/quality experiments preserve legacy Required results but retain active-memory and negation-acceptance failures; no default Embedding dependency, public Dense channel or schema change.

- Final modular-kernel audit regression checks: reject invalid unscored evidence models/directions, unknown candidate status/nonboolean truncation and not-run batches claiming hits; reject contradictory skipped/pending file versus executed assertion states in module reports. Existing ranking, access boundaries, schema and cursor configuration remain.

- Complete remaining 7A boundaries: separate Context selection eligibility/signals/relevance/input-order/legacy strategies, Runtime policy/observer/store guard, and Query budgeted sufficiency/fallback with a narrow ContextMemoryPacker. No public behavior, schema or dependency change.
- Registered responsibility-to-source/test map and direct backend port tests; per-file zero-assertion, duplicate-selection, unknown-status and invalid-duration rejection in development module reports. Preserve old operation selectors as aliases while reporting history/forget port names explicitly.

- Complete 7A operation routes: independent Query recall/history/evidence/fact-review/response, Context rendering and rank/coverage schedules sharing one budget, fact validity/reference/group checks, Answer citation/validation/projection, and backend writes/records/event transfer. Transaction owners and public behavior remain unchanged.
- `test:core` module/route discovery, selection and separate JSON reports; source/test/fixture/harness fingerprints and complete-grid checks reject empty, missing and duplicated evidence. Independent failure-boundary tests preserve skipped/native-PG distinctions; no model or schema change.

- Stage 7A modular kernel: independent channel retrievers/backend readers, narrow Context/Query consumers, separated memory/facts/ranking/runtime/application modules and canonical `src/storage/` paths. Flat entry points retain constructor identity and legacy facade override semantics; general storage commands move to `cli/storage`. No schema, default ranking, cursor configuration, dependency or model change.
- Executable Core/storage dependency boundaries and mutation tests, independent Reader registration/eligibility/error/deadline contracts, compatibility identities and installed-package BM25/Reader smoke. Quality and synthetic cost comparisons remain separate from architecture checks; Embedding/index integration was excluded from the 7A increment and was implemented separately as the explicit experiment described above.


- Stage 6A offline `eval:diagnostics`: actual scored-channel capture, separately labelled bounded candidate probes/ranking replay, per-case retrieval/ranking/Context/fact/policy diagnostics and independent store/partition/endpoint reports. Legacy judgments and graded relevance remain fixed; new development and exposed acceptance fixtures are wholly fictional, not blind held-out evidence. Complete-grid/metric/snapshot/citation integrity and mutation tests; no production retrieval, permission, Adapter, schema, dependency or model change.
- Stage 6B opt-in SQLite `latin-one-edit-v1` spelling-only fallback after zero literal hits. Original eligibility precedes bounded FTS5 trigram probes, then all-anchor token verification and exactly one edit. Additive correction/edit-distance/channel receipts and supported/enabled capability discovery; effective policy is cursor-bound, OFF fingerprints unchanged. Default remains OFF, no new public request argument/CLI switch, migration, Adapter, embedding or model dependency.
- Stage 6C `eval:lexical` separates unchanged old judgments, fixed exposed synthetic acceptance, OFF/ON quality and real-word ambiguity failures, safety/citations/stability, and raw 1k/10k latency samples. Engineering integrity is distinct from default-enable acceptance; false selections and predeclared performance-budget failures are retained, not hidden by the command's successful experiment exit.

- Stage 5 `bounded-reads-v1`: per-service monotonic shared deadline, lazy pre/post-read checks, no-queue admission, outstanding-read capacity retained until actual settlement, explicit timeout/busy/closed errors, immutable Query policy and actual capability discovery. Query keeps structured timeout/abstain; ordinary reads can return 504/503. Graceful shutdown drains actual reads/writes without force-closing sessions; optional metadata-only observers are off by default. No SQL hard cancellation or identity/permission expansion.
- Separate real-process SQLite COMMIT-boundary crash recovery, concurrent idempotency/CAS, live-query citation checks, WAL restore and bounded Query soak tests. `eval:reliability` preserves per-entry raw responses/latencies for sizes, value lengths and offered concurrency, with a predeclared same-host regression budget; fake-driver fault comparison remains distinct from quality and performance. No embedding, external telemetry, power-loss guarantee or production SLO.
- Default PostgreSQL factory pool acquisition/statement/lock wait limits and an optional SQLite post-initialization `busyTimeoutMs`; no schema/index/ranking change, automatic write retry or claim that custom pools inherit those server limits.

- Stage 4B bounded query-coverage packing, immutable whole-memory Context, identical-snapshot deduplication, per-query coverage and budget-aware `budgeted-context-v1` sufficiency. The former retrieved-set assessment is preserved as `retrievalSufficiency`; an empty budgeted pack is insufficient. Query can explicitly ablate coverage packing with constructor `queryPacking=rank_only`.
- Stage 4C `evidence-answer-v1` verbatim memory projection in Query with exact memory/event/version/content-hash citations, structural verification, and explicit evidence-ready/partial/abstain states. Readiness is lexical evidence coverage, never semantic answerability or truth. Audit history is not projected into an answer timeline, so history requests remain partial at the answer layer. Separate synthetic projection/citation/security/stability and packing-ablation reports are available via `eval:answer`; no model/embedding dependency or new public tool.

- `context-selection-v2` with default relevance-first Context ordering, purpose preference only at exact score/tier ties, zero scope/confirmation boosts, explicit relevance-only ablation and legacy-weighted compatibility. Per-item signals and policy/fallback receipts are additive; numeric priority now represents the retrieval score by default, not a complete ordering key. Context/Query share a validated immutable policy, and HTTP/MCP discovery reflects actual context budgets and confirmation mode. No storage schema, rendered JSON format or cursor change.
- Independent `eval:context` synthetic mechanism reports and cross-store/native-PG Context selection contracts. Original retrieval judgments remain unchanged; the later 4B/4C additions above are evaluated separately from this selection-only increment.

- Explicit fact declarations (`group`, validity intervals, exact-version replacement references), visible-partition group lookup, and conservative `explicit-facts-v1` adjudication after relevance ranking. Conflicts, incomplete groups and unresolved references are omitted with independent receipts; unannotated memories remain unverified compatibility results. Query revalidates accumulated claims within its deadline before Context.
- Cross-store fact conformance, HTTP/MCP entry tests, SQLite event-projection rollback and package/reference portability tests. `eval:facts` reports explicit contract quality, security, membership/repeat stability and latency separately; optional 1k/10k annotated cost workloads do not replace original quality judgments or establish an SLO.
- Public scored candidate integration and `core-ranking-v2` evidence receipts: native single-channel order, rank-only RRF, exact-key tier precedence, zero-weight structured eligibility, deduplication, and consistent current-version checks. Context and Query preserve raw channel evidence; Query signals identify their subquery and step.
- Cross-store public ranking, confirmation-before-budget, version, bounded paging, policy-bound cursor tests, and separate controlled ranking signal ablations via `eval:ranking`.
- Phase-2C candidate report v2 and fail-closed per-case comparison: coverage/budget/provenance validation, recomputed judgments, repeated selections, boundary ratios, and raw capacity percentile validation. Persistent local evidence manifests and a path-free portable summary keep original failures, retries and slow samples auditable; v1 reports are not silently treated as v2.
- Staged phase-2 Core candidate search with independent Exact/Structured/Lexical batches and explicit channel rank meaning, native score model/direction, match evidence, budgets and capability/fallback receipts. SQLite uses native FTS5 BM25 plus literal-term AND/short-query fallback; other stores retain honest substring compatibility.
- Per-channel synthetic candidate quality, permission, stability, latency and BM25-ablation reports, opt-in capacity workloads, cross-store candidate conformance and native PostgreSQL candidate tests. Existing quality judgments are preserved; unsupported fallback/semantic challenges remain visible.
- Executable `core-baseline-v1` evaluation with frozen judgments, cross-store Recall/Context measurements, per-case regression checks, evaluator integrity tests, and separate human-readable quality, safety, stability, capacity and engineering reports. Its PostgreSQL quality path remains pg-mem; native quality and performance SLOs remain unverified.
- Stage-1 MemoryRepository contract, detached snapshots, collision-free in-memory identities, cross-store conformance/failure tests, and explicit opt-in disposable PostgreSQL integration tests.
- Separate stage-1B/1C contracts and an opt-in local Docker fixture for native PostgreSQL storage conformance, transaction recovery, migration, commit-acknowledgement loss and repeated fresh-instance verification.
- Public Beta governance, support, and contribution templates.
- Reproducible Lite benchmark tooling and SQLite maintenance commands.
- Experimental Trae Conversation Capture with app-server capability probing, normalized local Inbox, explicit-signal candidate extraction, and approve/reject workflow.
- Experimental Trae `UserPromptSubmit` Injection Adapter with workspace opt-in, bounded public-memory Context Pack injection, fail-open behavior, and privacy-preserving receipts.
- Incremental Trae Capture watch mode, Inbox retention cleanup, sensitive-field redaction with candidate blocking, and backed-up Hook install/check commands.
- Fictional Golden Dataset evaluation for Capture/Injection quality, security leakage, and latency metrics.
- Multi-round `suite-v1` assessment with 185 independent assertions across Capture, Injection, Inbox governance, and fail-open behavior.
- Idempotent `setup trae`, layered `doctor trae`, transactional per-thread Capture checkpoints, install-path refresh, cross-platform launchd fallback reporting, safer service lifecycle handling, and a process-level fictional Trae Adapter black-box test.
- Provider-neutral `CaptureAdapter` and `InjectionAdapter` contracts with workspace allowlists shared by Trae, Claude Code, and Codex.
- Claude Code `Stop` transcript Capture and `UserPromptSubmit` Injection Adapter, including idempotent setup/doctor, settings backup, self-injection filtering, per-record workspace filtering, and final-response recovery for asynchronous transcript writes.
- Experimental Codex CLI Capture/Injection Adapter using the local `app-server --stdio` protocol, `Stop`/`UserPromptSubmit` Hooks, backed-up idempotent `hooks.json` installation, legacy turn-read fallback, reasoning-content suppression, and process-level fictional black-box coverage.
- Cross-Agent candidate occurrence merging, exact duplicate linking, deterministic conflict review, and explicit `--replace-memory` evolution with `supersedes` history.
- Local transient-data governance with turn-level 7-day Conversation Inbox retention, 30-day pending-candidate retention, bounded 30-day/5000-entry Injection receipts, owner-only local file permissions, and status/cleanup/purge CLI commands.
- Adapter contract, failure recovery, 1000-cycle soak, Claude process black-box, candidate evolution, migration, and data-governance tests using fictional data only.
- Installed-tarball smoke coverage for shared-memory handoff, Claude Adapter setup/doctor, and transient-data policy.
- Unified Capture checkpoint read options, runtime snapshot identity validation, and Claude transcript byte-cursor resume with safe file-rotation fallback.
- Shared Injection context envelope with final rendered-payload budgeting and budget-exhaustion fail-open behavior across Trae, Claude Code, and Codex.
- Shared Injection Adapter registry for CLI routing, exact delta base-cursor validation, bounded/repeated-cursor pagination guards, short-transcript byte-resume correctness, and escaped untrusted-memory envelope content.
- Claude Code 2.1.x MCP setup compatibility by placing the positional server name before its variadic environment options.
- Real Claude Code 2.1.296 no-account probe coverage for isolated setup, MCP connection, UserPromptSubmit Hook execution, and privacy-safe receipt recording; credential-backed Stop Capture remains explicitly unverified.

### Changed

- Raise the Fastify, Zod and Vitest minimum versions and update affected runtime/test transitive dependencies to patched public npm releases. Package integrity hashes were checked against the public registry; no internal registry endpoints are retained.
- HTTP/MCP capability discovery now reflects actual service channels and budgets; legacy custom stores report unverified/null ranking capabilities instead of claiming the scored pipeline.
- Fact declarations and changes/removal require confirmation plus CAS. SQLite schema v4 and PostgreSQL v3 add current/event fact data and a partitioned group index; no automatic fact inference/backfill. Back up before migration: releases predating schema-version checks may open upgraded SQL databases while ignoring fact fields and must not be used for in-place rollback. Packages with fact events use 1.1 (ordinary packages remain 1.0); fact-bearing JSON uses a v2 event field so old array-only readers fail rather than silently strip declarations. Retrieval cursor fingerprints now include fact policy/budget. Semantic truth, implicit cross-key conflicts and source authentication remain unimplemented.
- The first Phase-3 increment integrates the phase-2 candidate APIs into built-in public text queries. Additive receipts distinguish raw BM25, reciprocal-rank compatibility scores, fused scores and multi-query sums. Retrieval cursor v2 binds ranking version, enabled channels, candidate/RRF budgets and confirmation policy; old query cursors require restarting. Plain Recall/History keep their protocols; that first increment did not change SQL schema (3C migrations are listed separately). Old custom stores/retrievers retain the legacy path without claiming scored capabilities.
- Confirmation-required Context/Query apply the policy before native candidate truncation. Public Recall retains its existing confirmation policy; Context retains purpose/scope weights. Semantic/implicit cross-key fact resolution and performance SLOs remain challenges. SQLite BM25 uses whole-corpus statistics, not cross-user statistical isolation.
- Storage cursor v2 binds Recall/History filters; unbound legacy cursors require restarting pagination. PostgreSQL advertises literal substring fallback, not native full-text relevance.
- Memory writes reject cyclic/sparse JSON, canonicalize JSON values and preserve prototype-named keys during deterministic merge. PostgreSQL writes acquire ordered transaction advisory locks; initialization failures remain retryable.
- PostgreSQL rollback failures return sanitized storage errors and discard uncertain connections; custom pool wrappers must forward the destroy argument. SQLite Remember idempotency checks reject Forget events, including null-value requests. Reopen/replay and malformed/constructed cursor eligibility tests run across stores.
- The product narrative now clarifies that shared memory and handoff remain the core product, while Capture Adapter → user-approved Inbox promotion → Injection Adapter → on-demand MCP deep query is the first complete productization path; Trae, Claude Code, and Codex CLI are the first Adapter implementations.
- Capture cleanup now applies to individual turns and filters expired turns before re-import, so an actively updated long-running conversation cannot keep old raw content indefinitely.
- Injection token budgets now include the adapter safety envelope, so configured limits apply to the final Hook context rather than only the inner memory lines.
- Local configuration v2 separates Capture and Injection enablement/workspace allowlists per Agent. Existing v1 configuration is migrated conservatively with an on-disk backup instead of granting one Agent's workspaces to every Adapter.
- Hook lifecycle management now records owned handlers, reconciles stale installed-runtime paths, and supports safe `injection uninstall-hook --agent <name>` without deleting unrelated user hooks.
- `setup trae|claude|codex` now reports a plan/apply/verify transaction and compensates MCP, Hook, configuration, and Trae service mutations when a later step fails.
- The three-Adapter milestone is now explicitly feature-frozen for the current beta; future Adapter work is limited to evidence-backed compatibility, security, correctness, or new-client requirements while primary feature development moves to Core.

### Security

- Capture and Injection remain disabled until a workspace is explicitly allowlisted; neither path automatically promotes conversation content into long-term memory.
- Security guidance now documents local transcript staging, retention and purge behavior, Hook trust boundaries, third-party Agent data processing, and the lack of encrypted-at-rest storage in the Developer Preview.

## [1.1.0-beta.1]

### Added

- Installable `open-continuity` CLI with initialization, Agent connectors, diagnostics, memory management, and checked import/export.
- MCP connectors for Trae, Claude Code, and Codex CLI with fixed shared-user identity and per-Agent identity.
- Nine MCP tools covering capabilities, remember, recall, context, bounded query, history, forget, and task handoff.
- Handoff Capsules for explicit task transfer between Agents.
- Checksummed Memory Package export and empty-target import with local identity rebinding.
- Disposable two-Agent MCP demo and installed-tarball release smoke test.
- Linux and macOS CI across supported Node.js release lines.

### Changed

- Lite uses SQLite as its default persistent store; JSON remains a legacy and interchange format.
- Runtime capabilities now describe Profile budgets and unsupported advanced retrieval features explicitly.

### Security

- Connectors back up configuration and refuse implicit replacement or permanent paths inside temporary `npx` caches.
- Local exports are limited to the initialized user and imports validate content checksums before writing.

[Unreleased]: https://github.com/Huuyii-sleeping/open-continuity/compare/v1.1.0-beta.1...HEAD
[1.1.0-beta.1]: https://github.com/Huuyii-sleeping/open-continuity/releases/tag/v1.1.0-beta.1
