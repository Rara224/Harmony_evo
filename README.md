# Harmony_Evo Client

This branch contains the standalone client for a Harmony_Evo server.

The client can be copied into any HarmonyOS project or installed as an npm package. It provides:

- Claude Code hooks for prompt/tool/failure context injection.
- OpenCode MCP tools for active search, status, feedback, and candidate submission.
- OpenCode plugin hooks for event-level dev-signal capture.
- CLI commands for manual search, submit, feedback, and status checks.

The full project lives on `main`; the server-only version lives on `server`.

## Requirements

- Node.js 18+
- A running Harmony_Evo server, for example `http://localhost:3456`

No runtime npm dependencies are required.

## Quick Check

```bash
node bin/harmony-evo-client.js self-test
node bin/harmony-evo-client.js status
node bin/harmony-evo-client.js search "hvigor signingConfigs Failed to find signature file"
```

If the server is remote:

```bash
export HARMONY_EVO_SERVER=http://SERVER_IP:3456
```

If the server requires upload auth:

```bash
export HARMONY_EVO_TOKEN=YOUR_TOKEN
```

## Claude Code Hook

Run this inside the real business project, not inside this client directory:

```bash
node /absolute/path/to/harmony-evo-client/bin/harmony-evo-client.js install claude --server http://SERVER_IP:3456 --upload-signals
```

Then start Claude Code normally:

```bash
ccb
```

The installer writes:

```text
.claude/settings.local.json
```

Verified locally with `ccb 2.1.888`:

- Session: `60464599-50e8-4ba7-9e77-cc9e66928a8a`
- Failure: `Failed to find signature file`
- Top case: `dc_hm_004`
- Uploaded event: `PostToolUseFailure`, `score=0.9`, `candidate_ready=true`

## OpenCode MCP + Hook

Run this inside the real business project:

```bash
node /absolute/path/to/harmony-evo-client/bin/harmony-evo-client.js install opencode --server http://SERVER_IP:3456 --upload-signals
```

The installer writes:

```text
opencode.jsonc
.opencode/plugins/harmony-evo.js
```

MCP tools:

- `harmony_search`
- `harmony_status`
- `harmony_submit_candidate`
- `harmony_feedback`

Plugin hooks listen to chat messages, command execution, tool execution, failure events, and system-context transform.

## Package Files

- `harmony-evo-client-0.1.0.tgz`: npm package.
- `harmony-evo-client-standalone-0.1.0.tar.gz`: copyable standalone archive.
- `examples/`: Claude/OpenCode/MCP config examples.
- `QUICK_START_CN.md` and `USAGE_CLIENT.md`: usage docs.

## Privacy Defaults

Uploads are opt-in:

```bash
HARMONY_EVO_UPLOAD_SIGNALS=false
HARMONY_EVO_AUTO_SUBMIT=false
```

The client redacts authorization headers, API keys, passwords, cookies, email, phone numbers, private IPs, and signing file paths before upload.
