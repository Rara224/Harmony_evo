# Harmony_Evo Client Usage

## 1. Basic Commands

```bash
node bin/harmony-evo-client.js self-test
node bin/harmony-evo-client.js status
node bin/harmony-evo-client.js search "hvigor signingConfigs Failed to find signature file"
```

Remote server:

```bash
export HARMONY_EVO_SERVER=http://SERVER_IP:3456
```

Upload token:

```bash
export HARMONY_EVO_TOKEN=YOUR_TOKEN
```

## 2. Install Claude Code Hooks

Go to the HarmonyOS app project:

```bash
cd /path/to/your/harmonyos-app
```

Install:

```bash
node /absolute/path/to/harmony-evo-client/bin/harmony-evo-client.js install claude --server http://SERVER_IP:3456
```

Enable event-level dev-signal upload:

```bash
node /absolute/path/to/harmony-evo-client/bin/harmony-evo-client.js install claude --server http://SERVER_IP:3456 --upload-signals
```

Then use Claude Code normally:

```bash
ccb
```

Ask, for example:

```text
用 harmony-evo 查一下这个 hvigor 签名报错有没有类似案例
```

## 3. Install OpenCode MCP + Plugin Hook

Go to the HarmonyOS app project:

```bash
cd /path/to/your/harmonyos-app
```

Install both MCP and hook:

```bash
node /absolute/path/to/harmony-evo-client/bin/harmony-evo-client.js install opencode --server http://SERVER_IP:3456 --upload-signals
```

Install MCP only:

```bash
node /absolute/path/to/harmony-evo-client/bin/harmony-evo-client.js install opencode --server http://SERVER_IP:3456 --mcp-only
```

The MCP command is:

```bash
node /absolute/path/to/harmony-evo-client/bin/harmony-evo-client.js mcp
```

## 4. Submit And Feedback

Submit a candidate case:

```bash
node bin/harmony-evo-client.js submit \
  --title "权限弹窗不显示" \
  --problem "requestPermissionsFromUser 调用后没有弹窗" \
  --solution "检查 module.json5 permissions 配置，并确认调用时机"
```

Submit a log file:

```bash
node bin/harmony-evo-client.js submit --title "hvigor 签名失败" --file ./build.log
```

Record feedback:

```bash
node bin/harmony-evo-client.js feedback dc_hm_004 --worked --note "签名文件路径问题，已解决"
```

## 5. Generated Files

Claude Code:

```text
.claude/settings.local.json
```

OpenCode:

```text
opencode.jsonc
.opencode/plugins/harmony-evo.js
```

## 6. Safety

By default, hooks search and inject context but do not upload dev-signals unless `--upload-signals` or `HARMONY_EVO_UPLOAD_SIGNALS=true` is set.

Candidate auto-submit remains disabled unless `--auto-submit` or `HARMONY_EVO_AUTO_SUBMIT=true` is set.
