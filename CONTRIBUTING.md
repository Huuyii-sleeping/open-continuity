# Contributing to OpenContinuity

OpenContinuity welcomes focused bug fixes, connector improvements, compatibility reports, and protocol discussions. Please open an issue before making a large protocol or architecture change.

## Development

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run typecheck
npm test
npm run build
npm run release:check
```

Tests and examples must use obviously fictional data. Never commit credentials, personal exports, local databases, internal URLs, private logs, or third-party content without a compatible license.

## Pull requests

- Keep changes scoped to one problem.
- Add or update tests for behavior changes.
- Preserve existing MCP and HTTP contracts unless the change is explicitly versioned.
- Document security, migration, and compatibility effects.
- Do not claim support for an Agent client without an isolated connector test and a real smoke test on a documented version.
- Treat changes to memory schemas, scope rules, identities, error codes, Memory Packages, and Handoff Capsules as protocol changes that require compatibility notes.
- Large protocol or architecture proposals should begin as an issue before implementation.

By participating, you agree to follow the [Code of Conduct](./CODE_OF_CONDUCT.md). Support expectations are documented in [SUPPORT.md](./SUPPORT.md).
