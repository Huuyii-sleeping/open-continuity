# Security policy

OpenContinuity stores user memory locally by default. Reports involving unauthorized access, scope bypass, secret exposure, package tampering, or unsafe connector configuration should not be filed with real user data attached. Provide a minimal reproduction using fictional data.

## Defaults

- The Lite profile binds HTTP to `127.0.0.1` unless explicitly changed.
- Private memories cannot be recalled unless the runtime explicitly enables that policy.
- Connector commands back up existing client configuration before mutation.
- OpenContinuity does not capture complete conversations and should not store credentials or authentication tokens as memories.
- CLI Memory Package exports are limited to the current local user. Imports verify checksums, rebind ownership to the current local user, and only import into an empty SQLite event store.

Before exposing the HTTP server outside localhost, configure an API key and review Agent allowlists, network controls, and backup handling.

## Reporting

Do not open a public issue containing a vulnerability exploit, credential, memory export, real conversation, or identifying log. Use a private security-reporting channel published by the repository owner. Until one is configured, provide only a non-sensitive request for contact; do not send sensitive evidence through a public issue.

The current Developer Preview has no encrypted-at-rest database layer, remote identity provider, multi-tenant authorization, or production support commitment. Local operating-system permissions and full-disk encryption remain part of the deployment boundary.
