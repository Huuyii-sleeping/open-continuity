# Changelog

All notable changes to OpenContinuity are documented here. The project follows Semantic Versioning; prerelease versions may still change before the corresponding stable release.

## [Unreleased]

### Added

- Public Beta governance, support, and contribution templates.
- Reproducible Lite benchmark tooling and SQLite maintenance commands.

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
