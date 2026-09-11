# Supervision architecture

## Session identity

Official Codex injects the current `threadId` into MCP tool-call request metadata. Delegation Worker MCP uses that value as the authoritative session key. Native/Worker mode and Worker profile are therefore per Codex thread.

Hosts that do not provide a thread ID use the default profile/mode and remain supported.

## Native vs Worker

### NATIVE

Delegation Worker is dormant. `worker_start` fails closed. The host leaves Codex sandbox/collaboration policy unchanged.

### WORKER

The official Codex Main is the planner/supervisor and a third-party model is the executor.

The Codex Web integration enforces Main read-only using official App Server sandbox policy. Worker access is separately selected by the human operator and is passed to the Worker thread's official `thread/start`.

Plan mode is not overloaded as Worker mode. Upstream Codex exposes `default` and `plan` collaboration modes; Worker is a product execution mode layered beside them.

## Sustainable control loop

```text
Main inspects (read-only)
        |
        v
optional official Plan mode
        |
        v
precise worker_start
        |
        v
third-party Worker in official Codex thread
        |
        +--> plan/progress/tool events --> Main status
        +--> turn/steer <-------------- Main direction
        +--> turn/interrupt <---------- Main cancellation
        +--> pending server request <---> worker_respond
        |
        v
bounded lease review
   | progress => auto renew
   | heartbeat-only => one short grace
   | stalled/no progress => cancel
   | hard total limit => stop
        |
        v
independent read-only verifier
        |
        v
Main decides finish / follow-up Worker
```

Automatic renewal is evidence-based and bounded; it is not an infinite timeout reset.

## Upstream-first maintenance

The Codex adapter relies on public official App Server methods and generated schemas. `tests/upstream-lock.json` pins the exact validated upstream commit and CI checks the contracts needed by this project. No private Codex database or ChatGPT backend is used.
