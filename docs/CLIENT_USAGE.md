# Harmony_Evo 客户端使用指南

这份文档只讲怎么用，不讲实现。

展示页见：`docs/CLIENT_SHOWCASE.html`

## 你要先知道的三件事

1. 服务端是 Harmony_Evo 项目本身，默认跑在 `http://localhost:3456`。
2. 客户端在 `clients/harmony-evo-client/`，不需要单独安装 npm 依赖。
3. 日常使用推荐两种接入：Claude Code hooks 或 OpenCode MCP。

## 第一步：启动服务端

在 Harmony_Evo 项目目录执行：

```bash
cd /Users/ra/Downloads/Paper_Repo/Harmony_Evo
npm run server
```

确认服务端正常：

```bash
npm run client -- status
```

能看到类似下面的结果就可以：

```text
Harmony_Evo server: http://localhost:3456
Cases: 59
Candidates: 53
Harmony genes: 3
Evolver connected: yes
```

## 第二步：接入 Claude Code

进入你真正开发 HarmonyOS 应用的项目目录，不是 Harmony_Evo 目录：

```bash
cd /path/to/your/harmonyos-app
```

执行安装命令：

```bash
node /Users/ra/Downloads/Paper_Repo/Harmony_Evo/clients/harmony-evo-client/bin/harmony-evo-client.js install claude --server http://localhost:3456
```

这会写入当前项目的：

```text
.claude/settings.local.json
```

它会合并已有 hooks，不会覆盖你的全局 Claude 配置。

之后你在这个项目里正常打开 Claude Code。遇到 HarmonyOS 报错、hvigor 构建失败、权限问题、ArkUI 布局问题等，hook 会自动查询 Harmony_Evo 案例库，并把匹配案例作为上下文注入给 Claude Code。

如果你要开启“开发信号上传”，用这个安装命令：

```bash
node /Users/ra/Downloads/Paper_Repo/Harmony_Evo/clients/harmony-evo-client/bin/harmony-evo-client.js install claude --server http://localhost:3456 --upload-signals
```

这会让 Claude Code hook 在每个开发事件里做事件级分析：

```text
UserPromptSubmit / PostToolUse / PostToolUseFailure
  -> 提取 prompt、命令、工具输出、失败状态
  -> 本地脱敏
  -> 识别 HarmonyOS 信号、错误码、工具失败证据
  -> 查询服务端相似案例
  -> 计算质量分
  -> 本地记录事件
  -> 达到阈值后上传 dev-signal 到服务端审核队列
```

上传的是 `dev-signal`，不是正式案例。它用于后续审核、聚类、生成候选案例。

### Claude Code 实测结果

2026-05-25 已用本机 `ccb 2.1.888 (Claude Code)` 做过真实新会话验证：

```text
session_id: 60464599-50e8-4ba7-9e77-cc9e66928a8a
demo: /tmp/harmony-evo-real-ccb.fWO543
server: http://localhost:3456
```

链路是：

```text
ccb 新会话
  -> npm run build
  -> Failed to find signature file
  -> Harmony_Evo hook 注入 dc_hm_004
  -> 创建 sign/missing-release.p12
  -> npm run build 复测通过
```

服务端收到的关键事件：

```text
hook_event: PostToolUseFailure
kind: post-tool-failure
command: npm run build 2>&1
exit_code: 1
top_case: dc_hm_004 / Hvigor 编译报错：Failed to find signature file
quality.score: 0.9
candidate_ready: true
```

注意：Claude Code 的失败输出在这次实测里位于 hook payload 的顶层 `error` 字段，不在 `tool_response` 里；客户端已经兼容这种格式。

## 第三步：接入 OpenCode MCP + Hook

同样进入你的业务项目目录：

```bash
cd /path/to/your/harmonyos-app
```

执行：

```bash
node /Users/ra/Downloads/Paper_Repo/Harmony_Evo/clients/harmony-evo-client/bin/harmony-evo-client.js install opencode --server http://localhost:3456
```

这会写入当前项目的两部分：

```text
opencode.jsonc
.opencode/plugins/harmony-evo.js
```

`opencode.jsonc` 负责 MCP 工具，`.opencode/plugins/harmony-evo.js` 负责事件级 hook。

OpenCode 里会多出一个 MCP server：

```text
harmony-evo
```

可用工具：

- `harmony_search`：搜索案例资产。
- `harmony_status`：查看服务端状态。
- `harmony_submit_candidate`：提交候选案例到审核队列。
- `harmony_feedback`：反馈某个案例是否有效。

Hook 会监听 OpenCode 的：

```text
chat.message
command.execute.before
tool.execute.before
tool.execute.after
event
experimental.chat.system.transform
```

这部分用于自动分析 prompt、命令、工具参数、工具输出和失败信息。MCP 只能在模型主动调用工具时工作，不能覆盖这些事件级信号。

使用时可以直接对 OpenCode 说：

```text
用 harmony-evo 查一下这个 hvigor 签名报错有没有类似案例
```

或：

```text
用 harmony-evo 搜索 requestPermissionsFromUser 权限弹窗不显示
```

## 手动 CLI 用法

在 Harmony_Evo 目录里可以用短命令：

```bash
npm run client -- status
npm run client -- search "907135702 requestPermissionsFromUser"
npm run client -- search "hvigor signingConfigs 签名失败"
```

在任意目录也可以用完整路径：

```bash
node /Users/ra/Downloads/Paper_Repo/Harmony_Evo/clients/harmony-evo-client/bin/harmony-evo-client.js status
node /Users/ra/Downloads/Paper_Repo/Harmony_Evo/clients/harmony-evo-client/bin/harmony-evo-client.js search "Canvas 大量笔画卡顿"
```

提交候选案例：

```bash
node /Users/ra/Downloads/Paper_Repo/Harmony_Evo/clients/harmony-evo-client/bin/harmony-evo-client.js submit \
  --title "权限弹窗不显示" \
  --problem "requestPermissionsFromUser 调用后没有弹窗" \
  --solution "检查 module.json5 permissions 配置，并确认调用时机在 UI 可交互之后"
```

提交大日志文件：

```bash
node /Users/ra/Downloads/Paper_Repo/Harmony_Evo/clients/harmony-evo-client/bin/harmony-evo-client.js submit \
  --title "hvigor 签名失败" \
  --file ./build.log
```

反馈案例是否有效：

```bash
node /Users/ra/Downloads/Paper_Repo/Harmony_Evo/clients/harmony-evo-client/bin/harmony-evo-client.js feedback dc_hm_001 --worked --note "这个案例解决了 API 11 推送 token 问题"
```

失败反馈：

```bash
node /Users/ra/Downloads/Paper_Repo/Harmony_Evo/clients/harmony-evo-client/bin/harmony-evo-client.js feedback dc_hm_001 --failed --note "版本不匹配，没有解决"
```

## 上传和隐私

默认情况下，Claude Code hook 只会搜索和注入案例，并在本地记录事件级 dev-signal，不会自动上传你的本地问题。

默认值：

```bash
HARMONY_EVO_UPLOAD_SIGNALS=false
HARMONY_EVO_AUTO_SUBMIT=false
```

两种上传不要混在一起：

- `HARMONY_EVO_UPLOAD_SIGNALS=true`：上传 hook 事件级开发信号，质量分达到阈值才上传。
- `HARMONY_EVO_AUTO_SUBMIT=true`：自动提交候选 bug case，要求更高质量分，默认不建议开。

推荐先只开 dev-signal：

```bash
export HARMONY_EVO_UPLOAD_SIGNALS=true
```

如果以后要打开自动提交候选案例，可以在业务项目环境里设置：

```bash
export HARMONY_EVO_AUTO_SUBMIT=true
```

当前不建议默认打开自动提交案例，除非服务端已经有审核流程。

客户端会先脱敏：

- Authorization、Bearer token、API key。
- password、token、secret、cookie。
- 邮箱、手机号、内网 IP。
- `.p12`、`.keystore`、`.cer` 等签名文件路径。

服务端还会再做一次脱敏。发现高风险内容的提交会进入 `quarantined` 状态，不会直接进入正式案例库。

## 如果服务端不是本机

比如服务端部署在另一台机器：

```bash
node /Users/ra/Downloads/Paper_Repo/Harmony_Evo/clients/harmony-evo-client/bin/harmony-evo-client.js install claude --server http://SERVER_IP:3456
node /Users/ra/Downloads/Paper_Repo/Harmony_Evo/clients/harmony-evo-client/bin/harmony-evo-client.js install opencode --server http://SERVER_IP:3456
```

也可以用环境变量：

```bash
export HARMONY_EVO_SERVER=http://SERVER_IP:3456
```

如果服务端设置了上传 token：

```bash
export HARMONY_EVO_TOKEN=your-upload-token
```

## 常见问题

### 安装命令应该在哪个目录执行？

在你的业务项目目录执行。比如你正在开发一个 HarmonyOS App，就进入那个 App 项目目录执行安装命令。

### Claude Code hooks 会不会改我的全局配置？

默认不会。默认写当前项目的 `.claude/settings.local.json`。

只有你手动加 `--global` 才会写 `~/.claude/settings.json`：

```bash
node /Users/ra/Downloads/Paper_Repo/Harmony_Evo/clients/harmony-evo-client/bin/harmony-evo-client.js install claude --global --server http://localhost:3456
```

### OpenCode MCP 怎么确认已经接上？

看业务项目下是否生成了：

```text
opencode.jsonc
```

里面应该有：

```json
{
  "mcp": {
    "harmony-evo": {
      "type": "local"
    }
  }
}
```

### 我只想手动查案例，不接 hooks/MCP 可以吗？

可以，直接用：

```bash
npm run client -- search "你的错误信息"
```

或完整路径：

```bash
node /Users/ra/Downloads/Paper_Repo/Harmony_Evo/clients/harmony-evo-client/bin/harmony-evo-client.js search "你的错误信息"
```

### 客户端自己是否正常？

执行：

```bash
npm run client:self-test
```

看到：

```text
Harmony_Evo client self-test passed.
```

就说明客户端本身正常。
