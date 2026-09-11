# Delegation Worker MCP

A universal Worker control plane exposed through MCP. The project keeps host integrations thin: a host such as **Codex Official App Server Web** only needs to connect this MCP server and render its MCP App. Worker model/provider configuration, secret storage, dynamic model capability discovery, Codex worker execution, progress, steering and cancellation live here.

## What v0.1 implements

- MCP tools for Worker lifecycle: `worker_start`, `worker_status`, `worker_wait`, `worker_steer`, `worker_cancel`.
- A compact MCP App at `ui://delegation-worker/control` for selecting provider, model, reasoning control, access level and automatic verification.
- App-only provider management: arbitrary OpenAI-compatible base URL + API key, not hard-coded to New API.
- AES-256-GCM local secret vault. API keys are never returned by read APIs.
- Dynamic `/v1/models` discovery and per-`(provider, model)` reasoning metadata normalization.
- No model-name guessing. If the upstream does not advertise reasoning controls, the UI exposes only `Auto` unless an operator override is configured.
- A local Responses-compatible gateway that can route many upstream providers and fall back to Chat Completions when Responses is not supported.
- Codex-native model discovery for Worker route aliases: the gateway exposes a real Codex `ModelsResponse`, projects explicit/probed third-party tool capability into `ModelInfo`, and keeps unknown capabilities conservative instead of guessing from model names.
- Active compatibility probes distinguish native Responses, ordinary function tools (including the wire shape used by MCP tools), and custom/freeform tools required for native `apply_patch`.
- A Codex adapter that installs one namespaced provider (`delegation_worker_gateway`) without changing the user's top-level official model/provider selectors.
- Third-party workers run as independent official Codex App Server threads, so they can use the Codex workspace/tool harness while official ChatGPT authentication remains separate.
- Worker status reports a compatibility grade. `full-candidate` means native Responses plus function and custom/freeform tool schemas were actively accepted; archive-grade parity still requires the real target seal to prove actual tool execution.

## Product boundary

```text
Codex Web / ChatGPT / OpenClaw / Hermes host
                  |
                  | MCP tools + MCP App
                  v
        Delegation Worker MCP
        - provider profiles
        - secret vault
        - model capability registry
        - worker lifecycle
        - runtime adapters
                  |
          Codex adapter (v0.1)
                  |
         official codex app-server
                  |
     delegation_worker_gateway
                  |
       third-party model provider
```

`Codex-Official-App-Server-Web` does **not** need Worker-specific APIs. It can treat this project as an MCP server. A lightweight `/worker` or `@Worker` launcher can invoke the `worker_panel` tool and let the existing MCP Apps Host render the returned UI resource.

## Reasoning controls

Reasoning is model-specific. The registry can normalize:

- effort scales (`low`, `medium`, `high`, ...);
- on/off thinking;
- adaptive modes;
- budget-style controls.

The source is always retained (`upstream_metadata`, `operator_override`, or `unknown`). Unknown capability means `Auto` only.

## Run

Requirements:

- Node.js 20+
- `codex` installed for Codex worker execution

```bash
npm test
npm run check
node mcp/server.mjs
```

The MCP server uses newline-delimited JSON-RPC over stdio. It also owns a loopback-only local model gateway on `127.0.0.1:8791` by default. Override with `DWMCP_GATEWAY_PORT`.

Data is stored under:

```text
~/.local/share/delegation-worker-mcp
```

Override with `DWMCP_DATA_DIR`.

## Connect to Codex

Add this MCP server through the normal Codex MCP configuration/plugin surface, pointing the command at:

```text
scripts/run-mcp.sh
```

Then open the `worker_panel` MCP App. On first use, choose **Connect Codex**. The app-only `codex_install` operation adds only the namespaced `delegation_worker_gateway` provider to `~/.codex/config.toml`; it does not replace the official provider/model selectors or touch ChatGPT OAuth state.

## Provider setup

The compact panel asks for only:

1. provider name;
2. API base URL;
3. API key.

On save, the project calls the provider model catalog, records the models and their explicit metadata, and stores the key encrypted locally. The first adapter supports OpenAI-compatible services such as New API and other compatible gateways. The provider adapter boundary is intentionally separate so native Anthropic/Gemini-style transports can be added without changing MCP or UI contracts.

## Security notes

- Provider configuration tools are marked MCP App-only where supported by the host, so models do not receive secret-management tools in their normal tool surface.
- API keys are encrypted at rest with a local 256-bit AES-GCM master key and never returned by provider reads.
- The local model gateway requires its own random bearer token.
- Worker model/access/reasoning selection is saved by the human-facing panel. `worker_start` does not accept arbitrary provider/model/access parameters, preventing a model from self-upgrading its configured permissions.
- `danger-full-access` is therefore an operator-selected Worker profile setting, not a model-controlled argument.

## Current adapter scope

v0.1 fully implements the generic OpenAI-compatible path plus the Codex runtime adapter. Direct native Anthropic/Gemini transports are extension points rather than silently emulated. Providers reachable through an OpenAI-compatible gateway work without New API-specific assumptions.