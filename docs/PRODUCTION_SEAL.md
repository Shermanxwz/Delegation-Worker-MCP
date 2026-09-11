# Production seal

Delegation Worker MCP uses three evidence levels. They are deliberately not interchangeable.

## 1. SOURCE_SEALED

`npm run seal:source` requires a clean Git candidate and runs:

- the complete Node test suite;
- static project contract checks;
- pinned official `openai/codex` upstream contract verification;
- deterministic source-tree digest generation.

The result is `.seal/source.json`.

Hosted CI is allowed to produce **SOURCE_SEALED** evidence.

## 2. TARGET_SEALED

`npm run seal:target` must run on a real host with:

- a real signed-in ChatGPT/Codex account visible through official `account/read`;
- the namespaced `delegation_worker_gateway` installed;
- a real configured third-party provider/model;
- a provider that succeeds on the Responses transport for archive-grade native tool parity.

The target probe performs real execution, not mocks:

1. starts a third-party Worker inside official `codex app-server`;
2. actively probes native Responses plus ordinary function-tool and custom/freeform-tool request acceptance;
3. proves Codex shell/tool execution by creating a marker file in a temporary workspace;
4. requires a native `apply_patch` call to create a second marker and requires the official `fileChange` lifecycle event;
5. injects a temporary stdio MCP server only into the seal thread, requires the third-party model to call it, independently verifies that the server was actually invoked, observes the official `mcpToolCall` lifecycle, and requires the model to continue from the real tool result;
6. keeps a command active long enough to cross a Worker lease review and proves bounded automatic renewal;
7. proves independent read-only verification;
8. starts another Worker and proves official `turn/steer` changes the requested result;
9. starts another Worker and proves official `turn/interrupt` cancellation;
10. checks that the official ChatGPT account remains `chatgpt`;
11. checks that top-level official Codex model/provider selectors are unchanged;
12. rejects Chat-Completions-only, function-only, or custom-tool-incompatible transports as archive-grade native tool parity.

The result is `.seal/target.json`.

Ordinary hosted CI refuses to fabricate this evidence.

## 3. ARCHIVE_READY

`npm run seal:release` succeeds only when:

- `source.json` is eligible and `SOURCE_SEALED`;
- `target.json` is eligible and `TARGET_SEALED`;
- both point to the exact current Git commit;
- both point to the exact same pinned official Codex commit.

Only then is `.seal/SEALED.json` created with `status: ARCHIVE_READY`.

## Tool-parity classification

A Worker is executed by the official Codex App Server and therefore receives the Codex runtime/tool harness selected for that thread. The project does not reimplement shell, patching, MCP, plan or other Codex tools.

Transport still matters:

- **Responses upstream**: request/tool envelopes are forwarded through the gateway without collapsing them to Chat Completions. This is the required archive-grade path.
- **Chat Completions fallback**: useful compatibility path, but only function tools can be represented by the current bridge. It must not be described as full native tool parity.

Compatibility is graded before behavior is sealed:

- **full-candidate** — native Responses + ordinary function tools + custom/freeform tools were actively accepted. Only this grade can attempt archive sealing.
- **responses-function** — native Responses + ordinary function tools work, but custom/freeform tools are not proven; native `apply_patch` stays disabled.
- **compatibility** — Chat Completions fallback or insufficient tool evidence. Useful, but never full native tool parity.

The actual third-party model must also use the advertised tools correctly. Capability probes establish protocol acceptance; the target seal proves real behavior end to end.