# Harmony_Evo 客户端

这个分支是 Harmony_Evo 的独立客户端，用来接入已经运行的 Harmony_Evo 服务端。

完整项目在 `main` 分支；服务端版本在 `server` 分支。

## 功能介绍

- Claude Code Hook：在开发对话、工具调用、构建失败时自动搜索服务端案例，并注入上下文。
- OpenCode MCP：提供 `harmony_search`、`harmony_status`、`harmony_submit_candidate`、`harmony_feedback` 工具。
- OpenCode Plugin Hook：监听 prompt、命令和工具执行结果，生成事件级 dev-signal。
- CLI：手动查询服务端状态、搜索案例、提交候选案例、反馈案例是否有效。
- 脱敏：上传前会处理 token、password、cookie、API key、签名文件路径等敏感信息。

## 环境要求

- Node.js 18+
- 一个可访问的 Harmony_Evo 服务端，例如：

```text
http://localhost:3456
```

如果服务端不在本机：

```bash
export HARMONY_EVO_SERVER=http://SERVER_IP:3456
```

如果服务端设置了上传 token：

```bash
export HARMONY_EVO_TOKEN=YOUR_TOKEN
```

## 快速检查

```bash
node bin/harmony-evo-client.js self-test
node bin/harmony-evo-client.js status
node bin/harmony-evo-client.js search "hvigor signingConfigs Failed to find signature file"
```

## 接入 Claude Code

进入你的真实 HarmonyOS 项目目录，不是在客户端目录里执行：

```bash
cd /path/to/your/harmonyos-app
```

安装 hook：

```bash
node /absolute/path/to/harmony-evo-client/bin/harmony-evo-client.js install claude --server http://SERVER_IP:3456 --upload-signals
```

然后启动 Claude Code。本机默认命令是：

```bash
ccb
```

安装后会写入：

```text
.claude/settings.local.json
```

已用本机 `ccb 2.1.888` 做过真实验证：

- Session：`60464599-50e8-4ba7-9e77-cc9e66928a8a`
- 错误：`Failed to find signature file`
- 命中案例：`dc_hm_004`
- 上传事件：`PostToolUseFailure`，`score=0.9`，`candidate_ready=true`

## 接入 OpenCode MCP + Hook

进入你的真实 HarmonyOS 项目目录：

```bash
cd /path/to/your/harmonyos-app
```

安装 MCP 和事件级 hook：

```bash
node /absolute/path/to/harmony-evo-client/bin/harmony-evo-client.js install opencode --server http://SERVER_IP:3456 --upload-signals
```

安装后会写入：

```text
opencode.jsonc
.opencode/plugins/harmony-evo.js
```

只安装 MCP：

```bash
node /absolute/path/to/harmony-evo-client/bin/harmony-evo-client.js install opencode --server http://SERVER_IP:3456 --mcp-only
```

## 手动 CLI

```bash
node bin/harmony-evo-client.js status
node bin/harmony-evo-client.js search "Canvas 大量笔画卡顿"
node bin/harmony-evo-client.js submit --title "hvigor 签名失败" --file ./build.log
node bin/harmony-evo-client.js feedback dc_hm_004 --worked --note "签名文件路径问题已解决"
```

## 包文件

- `harmony-evo-client-0.1.0.tgz`：npm 安装包。
- `harmony-evo-client-standalone-0.1.0.tar.gz`：可直接复制的独立包。
- `examples/`：Claude、OpenCode、MCP 示例配置。
- `QUICK_START_CN.md`：中文快速使用说明。
- `USAGE_CLIENT.md`：更完整的客户端用法。

## 默认隐私策略

默认不上传候选案例：

```bash
HARMONY_EVO_UPLOAD_SIGNALS=false
HARMONY_EVO_AUTO_SUBMIT=false
```

只有显式加 `--upload-signals` 或设置 `HARMONY_EVO_UPLOAD_SIGNALS=true`，才会上报事件级 dev-signal。
