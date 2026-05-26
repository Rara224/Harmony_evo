# Harmony_Evo Client Standalone 使用说明

这个目录是从 Harmony_Evo 客户端复制出来的独立包，用来接入共享 Harmony_Evo 服务端。

它包含三种用法：

- Claude Code hook：自动从 prompt、构建失败、工具输出里检索 Harmony_Evo 案例。
- MCP server：给 OpenCode 或其他 MCP 客户端暴露 `harmony_search` 等工具。
- OpenCode plugin hook：监听 prompt、命令和工具执行结果，上传事件级 dev-signal。
- CLI：直接向 Harmony_Evo 服务端发 `status/search/submit/feedback` 请求。

运行环境只需要 Node.js 18+。

## 1. 快速检查服务端

如果服务端在本机：

```bash
node bin/harmony-evo-client.js status
node bin/harmony-evo-client.js search "hvigor signingConfigs 签名失败"
```

如果服务端在另一台机器：

```bash
export HARMONY_EVO_SERVER=http://SERVER_IP:3456
node bin/harmony-evo-client.js status
node bin/harmony-evo-client.js search "requestPermissionsFromUser 权限弹窗不显示"
```

如果服务端配置了上传 token：

```bash
export HARMONY_EVO_TOKEN=YOUR_TOKEN
```

## 2. 接入 Claude Code hook

进入业务项目目录，不是在这个客户端目录里安装：

```bash
cd /path/to/your/harmonyos-project
node /absolute/path/to/harmony-evo-client-standalone/bin/harmony-evo-client.js install claude --server http://SERVER_IP:3456
```

这会写入当前项目的：

```text
.claude/settings.local.json
```

默认只做检索和上下文注入，不上传开发信号。

如果要打开开发信号上传：

```bash
node /absolute/path/to/harmony-evo-client-standalone/bin/harmony-evo-client.js install claude --server http://SERVER_IP:3456 --upload-signals
```

然后在业务项目目录里启动 Claude Code：

```bash
ccb
```

可以直接问：

```text
用 harmony-evo 查一下这个 hvigor 签名报错有没有类似案例
```

本包对应的源码版本已通过真实 `ccb 2.1.888` session 验证：`PostToolUseFailure` 能解析 Claude Code 顶层 `error` 字段，真实 hvigor 签名文件缺失会上传为 `score=0.9`、`candidate_ready=true` 的 dev-signal。

## 3. 接入 OpenCode MCP + Hook

### OpenCode 自动写配置

进入业务项目目录：

```bash
cd /path/to/your/harmonyos-project
node /absolute/path/to/harmony-evo-client-standalone/bin/harmony-evo-client.js install opencode --server http://SERVER_IP:3456
```

这会写入：

```text
opencode.jsonc
.opencode/plugins/harmony-evo.js
```

`opencode.jsonc` 注册 MCP 工具，`.opencode/plugins/harmony-evo.js` 注册 OpenCode 事件级 hook。MCP 用于主动查询，hook 用于自动捕获 prompt、命令和工具输出。

### 通用 MCP 配置

如果你的 MCP 客户端需要手写配置，命令使用：

```bash
node /absolute/path/to/harmony-evo-client-standalone/bin/harmony-evo-client.js mcp
```

环境变量：

```bash
HARMONY_EVO_SERVER=http://SERVER_IP:3456
HARMONY_EVO_TOKEN=YOUR_TOKEN
```

工具列表：

- `harmony_search`：搜索 HarmonyOS 案例资产。
- `harmony_status`：查看服务端状态。
- `harmony_submit_candidate`：提交候选案例到服务端审核队列。
- `harmony_feedback`：反馈某个案例是否有效。

打开事件级上传：

```bash
node /absolute/path/to/harmony-evo-client-standalone/bin/harmony-evo-client.js install opencode --server http://SERVER_IP:3456 --upload-signals
```

只安装 MCP、不安装 hook：

```bash
node /absolute/path/to/harmony-evo-client-standalone/bin/harmony-evo-client.js install opencode --server http://SERVER_IP:3456 --mcp-only
```

## 4. 打成 npm 全局命令

在这个目录里执行：

```bash
npm pack
npm install -g ./harmony-evo-client-0.1.0.tgz
```

之后可以直接用：

```bash
harmony-evo-client status
harmony-evo-client search "Canvas 大量笔画卡顿"
harmony-evo-client install claude --server http://SERVER_IP:3456
harmony-evo-client mcp
```

## 5. 本地自检

```bash
node bin/harmony-evo-client.js self-test
```

自检只验证客户端本地逻辑，不要求服务端在线。
