# Security policy

OpenContinuity stores user memory locally by default. Reports involving unauthorized access, scope bypass, secret exposure, package tampering, or unsafe connector configuration should not be filed with real user data attached. Provide a minimal reproduction using fictional data.

## Defaults

- The Lite profile binds HTTP to `127.0.0.1` unless explicitly changed.
- Private memories cannot be recalled unless the runtime explicitly enables that policy.
- Connector commands back up existing client configuration before mutation.
- Capture and Injection are disabled until a workspace is explicitly allowlisted. Trae and Codex Capture read only their local app-server surfaces; Claude Capture reads only the transcript supplied by its public `Stop` Hook. Codex reasoning items are discarded except for a type marker; no Adapter claims access to hidden reasoning.
- Visible conversation content may be staged in the local Conversation Inbox. It is separate from long-term memory, is filtered by workspace, redacted for recognized sensitive fields, and expires by turn after 7 days by default. A pending candidate keeps only its extracted evidence for up to 30 days and does not keep the raw turn alive.
- No candidate becomes long-term memory without explicit approval. Exact repeats can be linked to an existing memory; a likely conflict requires an explicit replacement target and creates an auditable new version instead of silently overwriting the old one.
- Injection reads only approved public memory for an allowlisted workspace, treats it as untrusted reference data, applies strict count/token/time limits, and fails open. Its local receipts contain a short Prompt fingerprint rather than the Prompt body and default to 30 days or 5000 entries.
- OpenContinuity should not be used to store credentials, authentication tokens, private keys, or complete conversation archives as long-term memories.
- CLI Memory Package exports are limited to the current local user. Imports verify checksums, rebind ownership to the current local user, and only import into an empty SQLite event store.

`open-continuity data status` reports the active transient-data policy. `data cleanup` applies it immediately, while `data purge-transient --yes` deletes the Inbox, candidates, checkpoints, and Injection receipts without deleting approved long-term memory. If Capture remains enabled, future Agent activity can create new transient data; disable Capture before purging when continued observation is not desired.

The local data directory and SQLite/JSONL files are created with owner-only permissions where the operating system supports POSIX modes. This reduces accidental access by other local users but is not encryption and does not defend against software already running as the same user. Full-disk encryption, account security, backups, and the integrity of installed Agent Hooks remain part of the local trust boundary.

Before exposing the HTTP server outside localhost, configure an API key and review Agent allowlists, network controls, and backup handling.

## Reporting

Do not open a public issue containing a vulnerability exploit, credential, memory export, real conversation, or identifying log. Use a private security-reporting channel published by the repository owner. Until one is configured, provide only a non-sensitive request for contact; do not send sensitive evidence through a public issue.

The current Developer Preview has no encrypted-at-rest database layer, remote identity provider, multi-tenant authorization, signed Hook distribution, or production support commitment. Capture and Injection do not upload data themselves, but the third-party Agent receiving injected memory may send its Prompt to whatever model service that Agent is configured to use. Users remain responsible for that Agent's own data-processing policy.
