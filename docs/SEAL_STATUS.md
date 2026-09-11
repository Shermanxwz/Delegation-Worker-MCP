# Seal status

Current source architecture supports a fail-closed archive process.

- Source seal: automated in CI.
- Official Codex upstream: pinned by `tests/upstream-lock.json`.
- Real target seal: intentionally requires a signed-in Codex host and real provider/model.
- Final archive seal: generated only from matching source + target evidence.

A green hosted CI run is **not** `ARCHIVE_READY`.

## Product-mode contract

The MCP product exposes only two high-level modes:

- **NATIVE** — this project is dormant for the current host session.
- **WORKER** — the official Codex Main remains the supervisor; a configured third-party model executes in its own official Codex App Server thread.

Official Codex **Plan mode is separate**. In Codex Web, Worker and Plan can coexist:

```text
Worker = who executes
Plan   = how the official Main is currently reasoning/organizing
```

This separation tracks upstream semantics and avoids inventing a third Codex collaboration mode.
