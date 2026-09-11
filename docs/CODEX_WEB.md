# Codex Official App Server Web integration

The intended integration is deliberately thin.

`Delegation-Worker-MCP` exposes:

- tool: `worker_panel`
- UI resource: `ui://delegation-worker/control`
- MIME: `text/html;profile=mcp-app`
- tool metadata: `_meta.ui.resourceUri = "ui://delegation-worker/control"`

`Codex-Official-App-Server-Web` already hosts stable MCP Apps. It does not need Worker-specific provider, secret, lifecycle or gateway APIs.

A native-feeling launcher can therefore be implemented generically:

```text
/worker
  -> invoke/discover worker_panel
  -> existing MCP Apps Host reads ui://delegation-worker/control
  -> render panel
```

Likewise `@Worker` can be a generic discovered MCP App mention. The Web product should not import `Delegation-Worker-MCP` internals.

The panel itself presents only high-frequency choices:

```text
Provider
Model
Reasoning (dynamic per model)
Full access
Automatic verification
```

Provider URL/API key configuration is behind the settings button in the same MCP App.
