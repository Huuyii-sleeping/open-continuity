# Agent compatibility

The connector matrix records the supported integration contract. A detected CLI is not automatically modified; users run `open-continuity connect <agent>` explicitly. Existing MCP entries are never replaced unless `--force` is supplied, and the connector backs up the client configuration first.

| Client | Integration | Connector | Identity binding | Current verification |
| --- | --- | --- | --- | --- |
| Trae | MCP stdio | `connect trae` | shared local user + `trae` Agent | automated isolated connector test; real MCP E2E |
| Claude Code | MCP stdio, user scope | `connect claude` | shared local user + `claude` Agent | command contract implemented; real smoke test requires Claude Code installed |
| Codex CLI | MCP stdio | `connect codex` | shared local user + `codex` Agent | automated isolated connector test; real smoke test depends on working client authentication |

Other products can use the documented MCP stdio command or HTTP API. A client must support custom MCP servers or another extension mechanism. OpenContinuity cannot inject itself into a closed product that exposes neither capability.

MCP server instructions advise capable clients to retrieve relevant context at task start, store only durable information, and create a Handoff Capsule on explicit handoff. The client model and its tool policy still decide whether a tool is called, so tool availability is not a guarantee of automatic invocation.
