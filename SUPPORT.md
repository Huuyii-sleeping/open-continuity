# Support policy

OpenContinuity is currently a Developer Preview. It is suitable for evaluation with fictional or recoverable local data, but it does not yet carry a production support commitment.

## Supported runtime

- Node.js 22.13 or newer on maintained Node.js 22 and 24 release lines.
- macOS and Linux are covered by CI. Windows is not yet part of the compatibility claim.
- Lite with SQLite is the primary supported Profile.
- Team with PostgreSQL is an implementation preview and is not yet recommended for production deployment.

Only the newest prerelease receives fixes before the first stable release. After `1.1.0` becomes stable, security and data-loss fixes will target the latest minor release; a longer support window will be defined when real usage justifies it.

## Getting help

Before reporting a problem:

1. Run `open-continuity doctor`.
2. For an Adapter issue, run `open-continuity doctor trae --workspace <path>`, `open-continuity doctor claude --workspace <path>`, or `open-continuity doctor codex --workspace <path>` and `open-continuity data status`.
3. Run `open-continuity demo` to separate shared-memory runtime problems from Agent-client behavior.
4. Check the compatibility matrix and known limitations in the README.
5. Create a minimal reproduction using fictional data.

Use the Bug Report template for reproducible defects and the Feature Request template for product proposals. Do not put secrets, private memory exports, real conversations, or internal logs in public issues.

Agent tool availability does not guarantee automatic tool invocation. Reports about an Agent failing to remember should state whether the tool was unavailable, returned an error, or was simply not selected by the model.
