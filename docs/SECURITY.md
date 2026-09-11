# Security

## Secrets

Provider API keys are encrypted with AES-256-GCM using a random 256-bit local master key. The master key and state files are mode `0600` under the identity-scoped data directory. Provider read APIs return only `apiKeyConfigured: true/false`.

The MCP App submits a new credential through an App-only MCP tool. This prevents the normal model tool surface from advertising credential-management operations on hosts that honor MCP Apps visibility metadata. The embedding MCP/App host is still part of the trusted local boundary and can observe traffic it transports; do not use an untrusted host for credential entry.

## Local gateway

The Responses compatibility gateway:

- binds only to `127.0.0.1`;
- requires a random 256-bit bearer token;
- keeps third-party API keys out of Codex configuration;
- stores only a path to the local gateway token in the namespaced Codex provider auth command.

## Codex configuration

`codex_install` manages only a marker-delimited `[model_providers.delegation_worker_gateway]` block. Before writing, it snapshots and compares top-level `model_provider` and `model` selectors and refuses a write if they would change. ChatGPT OAuth state is never read from or written to `auth.json`.

## Worker privilege

The operator chooses Worker access in the MCP App. The model-facing `worker_start` tool has no access/provider/model/reasoning arguments. Automatic verifier runs are forced to `read-only`.

## Capability claims

HTTP success alone is not treated as proof that an upstream supports a reasoning control. v0.1 uses explicit catalog metadata or an explicit operator override. Unknown capability remains `Auto` only.
