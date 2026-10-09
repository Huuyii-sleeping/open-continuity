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

### Changed

- The product narrative now clarifies that shared memory and handoff remain the core product, while Capture Adapter → user-approved Inbox promotion → Injection Adapter → on-demand MCP deep query is the first complete productization path, with the Trae adapter as the reference implementation.

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
