# Architecture

## Core boundary

`Delegation-Worker-MCP` owns Worker orchestration. Host products should not reimplement provider routing, secret storage or Worker lifecycle.

```text
Host UI / Main model
       |
       | MCP
       v
Delegation Worker MCP
  |-- MCP App control panel
  |-- Provider registry + vault
  |-- Model capability registry
  |-- Worker lifecycle
  |-- Responses compatibility gateway
  `-- Runtime adapters
          |
          `-- Codex (v0.1)
                |
         official codex app-server
```

The MCP App and model-facing MCP tools operate on the same state. Human-only settings are marked App-only where the host supports MCP Apps visibility metadata.

## Provider identity

A model is never identified by model ID alone. Runtime identity is:

```text
(providerId, modelId)
```

The same model name through two providers may expose different reasoning controls and protocols.

## Reasoning capability

The capability registry does not own a global effort enum. It normalizes explicit upstream metadata to one of:

- `effort`
- `toggle`
- `adaptive`
- `budget`
- `unknown`

`unknown` exposes only `Auto`. Model names are not used as capability evidence.

Each capability also records a request style used by the provider adapter, for example `openai_reasoning`, `thinking_flag`, `thinking_mode` or `thinking_budget`.

## Codex execution

The operator-selected route is materialized as a short opaque model alias. Codex receives only the alias through the namespaced provider `delegation_worker_gateway`. The local gateway resolves the alias to the real provider/model/reasoning tuple and injects provider-specific reasoning controls.

This is intentional: Codex reasoning enums do not need to represent every third-party provider's thinking semantics.

```text
Worker profile
  provider=P1
  model=MiniMax-X
  reasoning=on
       |
       v
route alias dw_xxx
       |
thread/start(modelProvider=delegation_worker_gateway, model=dw_xxx)
       |
Codex Responses request(model=dw_xxx)
       |
local gateway
       |
P1 / MiniMax-X / thinking=on
```

Third-party workers are independent App Server threads rather than pretending to be native OpenAI subagents.

## Permission boundary

`worker_start` accepts the task and workspace, but not provider/model/reasoning/access. Those values come from the human Worker profile. This prevents a Main model from changing its own Worker route or escalating Worker permissions through tool arguments.

## Automatic verification

When enabled, the same selected model is run again in an independent `read-only` Codex thread after implementation. The verification result is attached to the Worker task.
