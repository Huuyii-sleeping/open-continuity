# Changelog

All notable changes to OpenContinuity are documented here. The project follows Semantic Versioning; prerelease versions may still change before the corresponding stable release.

## [Unreleased]

### Added

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

### Changed

- The product narrative now clarifies that shared memory and handoff remain the core product, while Capture Adapter → user-approved Inbox promotion → Injection Adapter → on-demand MCP deep query is the first complete productization path; Trae, Claude Code, and Codex CLI are the first Adapter implementations.
- Capture cleanup now applies to individual turns and filters expired turns before re-import, so an actively updated long-running conversation cannot keep old raw content indefinitely.

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
