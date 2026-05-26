# Harmony_Evo Client

Harmony_Evo Client is the local adapter for the shared Harmony_Evo asset hub. It can run as:

- Claude Code hooks: automatically search shared DebugCase assets from prompts and failed tool output.
- OpenCode MCP server: expose Harmony_Evo search, status, feedback, and candidate submission tools.
- OpenCode plugin hooks: capture chat, command, and tool execution events for event-level search and dev-signal upload.
- CLI: manual search, status, feedback, and redacted candidate submission.

The client has no runtime dependencies beyond Node.js 18+.

中文快速指南见：`QUICK_START_CN.md`。

## One Minute Setup

Start the Harmony_Evo service:

```bash
cd /Users/ra/Downloads/Paper_Repo/Harmony_Evo
npm run server
```

Install Claude Code project hooks:

```bash
node clients/harmony-evo-client/bin/harmony-evo-client.js install claude --server http://localhost:3456
```

This writes `.claude/settings.local.json` in the current project and merges with existing hooks.

Install OpenCode MCP:

```bash
node clients/harmony-evo-client/bin/harmony-evo-client.js install opencode --server http://localhost:3456
```

This writes `opencode.jsonc` in the current project and registers a local MCP server named `harmony-evo`. It also writes `.opencode/plugins/harmony-evo.js` so OpenCode can capture event-level hooks. Use `--mcp-only` if you only want the MCP tool server.

Check the client:

```bash
npm run client:self-test
npm run client -- status
npm run client -- search "907135702 requestPermissionsFromUser"
```

## Runtime Defaults

The default server is `http://localhost:3456`.

Useful environment variables:

```bash
  HARMONY_EVO_SERVER=http://localhost:3456
  HARMONY_EVO_TOKEN=optional-upload-token
  HARMONY_EVO_TOP=3
  HARMONY_EVO_UPLOAD_SIGNALS=false
  HARMONY_EVO_AUTO_SUBMIT=false
```

`HARMONY_EVO_UPLOAD_SIGNALS` and `HARMONY_EVO_AUTO_SUBMIT` are disabled by default. Hooks search and inject context, and record event-level development signals locally. Uploading signals or candidate cases requires explicit opt-in.

If the server sets `HARMONY_EVO_UPLOAD_TOKEN`, clients must pass the same token through `HARMONY_EVO_TOKEN`.

## Claude Code Behavior

The installer adds hooks for:

- `SessionStart`: add Harmony_Evo server status context when available.
- `UserPromptSubmit`: search the shared case library from HarmonyOS-related prompts.
- `PostToolUse` / `PostToolUseFailure`: search from build, edit, and command output.
- `Stop`: reserved for future feedback aggregation.

Use `--upload-signals` during install to upload event-level hook signals to the server review queue:

```bash
node clients/harmony-evo-client/bin/harmony-evo-client.js install claude --server http://localhost:3456 --upload-signals
```

Validated with `ccb 2.1.888` on 2026-05-25 using a real failing `npm run build` session:

- Session: `60464599-50e8-4ba7-9e77-cc9e66928a8a`
- Failure: `Failed to find signature file`
- Top case: `dc_hm_004`
- Uploaded signal: `PostToolUseFailure`, `score=0.9`, `candidate_ready=true`
- Fix verification: build passed after creating the missing `.p12` file expected by the demo.

Claude Code can place failed tool output in the top-level hook `error` field. The client parses that field for diagnostics and `Exit code N`, not only `tool_response`.

The hook never blocks the coding session if the Harmony_Evo server is down. It returns no extra context on timeout or error.

## OpenCode MCP Tools

The OpenCode installer now installs both layers by default:

- MCP: explicit tools the model can call on demand.
- Plugin hooks: passive event capture for chat prompts, commands, and tool execution.

MCP alone is not enough for event-level self-evolution because it only runs when a model chooses a tool. The plugin hook runs on OpenCode events even when the model did not explicitly call Harmony_Evo.

The MCP server exposes:

- `harmony_search`: search shared HarmonyOS DebugCase/Gene assets.
- `harmony_status`: check server connection and asset counts.
- `harmony_submit_candidate`: submit a redacted candidate case to the review queue.
- `harmony_feedback`: record whether a case helped.

Candidate submissions go to the server review queue at `/api/submissions`; they are not promoted into the official case library automatically.

OpenCode plugin hooks currently listen to:

- `chat.message`
- `command.execute.before`
- `tool.execute.before`
- `tool.execute.after`
- `event`
- `experimental.chat.system.transform`

Use `--upload-signals` during install to upload event-level dev signals:

```bash
node clients/harmony-evo-client/bin/harmony-evo-client.js install opencode --server http://localhost:3456 --upload-signals
```

## Manual CLI

```bash
node clients/harmony-evo-client/bin/harmony-evo-client.js status
node clients/harmony-evo-client/bin/harmony-evo-client.js search "hvigor signingConfigs 报错"
node clients/harmony-evo-client/bin/harmony-evo-client.js submit --title "权限弹窗不显示" --problem "requestPermissionsFromUser 不弹窗" --solution "fix summary"
node clients/harmony-evo-client/bin/harmony-evo-client.js feedback dc_hm_001 --worked --note "matched API 11"
```

Use `--file` for large problem text:

```bash
node clients/harmony-evo-client/bin/harmony-evo-client.js submit --title "hvigor 签名失败" --file ./build.log
```

## Privacy Model

The client redacts common secrets before search or upload:

- Authorization headers, API keys, tokens, passwords, cookies.
- Email addresses, China mainland phone numbers, private IPs.
- Signing files such as `.p12`, `.keystore`, `.cer`.

The server applies a second redaction pass before writing uploaded candidates. High-risk findings are stored with `status: "quarantined"` for manual review.
