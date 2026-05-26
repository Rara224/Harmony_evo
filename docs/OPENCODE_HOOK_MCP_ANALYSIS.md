# OpenCode Hook 与 MCP 接入分析

日期：2026-05-25

## 结论

OpenCode 只接 MCP 不够覆盖 Harmony_Evo 的事件级自进化需求。

MCP 适合做“模型主动调用工具”：

- 搜索案例：`harmony_search`
- 查看状态：`harmony_status`
- 提交候选：`harmony_submit_candidate`
- 反馈有效性：`harmony_feedback`

但 MCP 不负责监听 OpenCode 的真实开发过程事件。也就是说，如果模型没有主动调用 Harmony_Evo 工具，MCP 看不到 prompt、命令、工具参数、工具输出和失败链路。

OpenCode 的事件级能力在 plugin hook 系统里。Harmony_Evo 因此需要同时提供：

```text
OpenCode MCP：主动查询和提交工具
OpenCode Hook Plugin：被动监听开发事件，做自进化信号采集
```

## 当前实现

客户端安装命令：

```bash
node clients/harmony-evo-client/bin/harmony-evo-client.js install opencode --server http://localhost:3456 --upload-signals
```

会写入两部分：

```text
opencode.jsonc
.opencode/plugins/harmony-evo.js
```

`opencode.jsonc` 注册本地 MCP server：

```text
harmony-evo
```

`.opencode/plugins/harmony-evo.js` 注册 OpenCode plugin hooks。

## Hook 覆盖事件

当前插件监听：

```text
chat.message
command.execute.before
tool.execute.before
tool.execute.after
event
experimental.chat.system.transform
```

其中：

- `chat.message`：分析用户 prompt，适合提前召回案例。
- `command.execute.before`：分析 slash command / 自定义命令上下文。
- `tool.execute.before`：分析工具调用参数。
- `tool.execute.after`：分析工具输出，尤其是构建失败、命令失败、错误日志。
- `event`：只保留 `error / failed / idle` 等高价值通用事件，避免 `session.updated` 噪声。
- `experimental.chat.system.transform`：把最近一次命中的 Harmony_Evo 上下文注入后续模型系统上下文。

## 自进化链路中的作用

OpenCode MCP 主要服务注入层：

```text
模型需要案例 -> 主动调用 harmony_search -> 返回 DebugCase
```

OpenCode hook plugin 主要服务数据层、门禁层、回流层：

```text
OpenCode 事件
  -> 本地脱敏
  -> HarmonyOS 信号识别
  -> 案例检索
  -> 事件质量评分
  -> 本地 dev-signal 记录
  -> 可选上传服务端审核队列
```

默认不上传：

```bash
HARMONY_EVO_UPLOAD_SIGNALS=false
HARMONY_EVO_AUTO_SUBMIT=false
```

开启事件级上传：

```bash
node clients/harmony-evo-client/bin/harmony-evo-client.js install opencode --server http://localhost:3456 --upload-signals
```

只安装 MCP，不安装 hook：

```bash
node clients/harmony-evo-client/bin/harmony-evo-client.js install opencode --server http://localhost:3456 --mcp-only
```

## 本机实测

已安装 OpenCode：

```text
opencode 1.15.10
```

使用 `/Users/ra/Downloads/ClawHospital/config.env` 中的 DeepSeek 环境变量运行：

```bash
opencode run --model deepseek/deepseek-v4-flash --format json \
  "只回答 OK。hvigor signingConfigs 签名失败 Failed to find signature file 有没有类似案例？"
```

实测结果：

- OpenCode MCP 被模型主动调用，工具名为 `harmony-evo_harmony_search`。
- OpenCode hook plugin 同时记录了事件级 dev-signal。
- `chat.message` 命中 `dc_hm_004`：`Hvigor 编译报错：Failed to find signature file`。
- 噪声过滤后，单次 run 记录 4 条事件，而不是全量 session bus 噪声。

### 真实 bug 上传复测

复测方式不是直接发一个命令，而是在临时 HarmonyOS demo 中启动新的 OpenCode session，让模型自己经历完整排障：

```text
新 session: ses_1a0501d6fffefUk39nksbqPgLE
服务端: http://localhost:3456
临时项目: /tmp/harmony-evo-real-opencode-clean.PTF5TL
```

实际链路：

```text
1. OpenCode 运行 npm run build
2. hvigor-sim 返回 Failed to find signature file，exit=1
3. OpenCode 调用 harmony-evo_harmony_search
4. Top 1 命中 dc_hm_004：Hvigor 编译报错：Failed to find signature file
5. OpenCode 创建 sign/missing-release.p12
6. 再次 npm run build，构建通过
```

3456 服务端收到的核心信号：

| 时间 | hook | kind | 工具 | 质量 | Top Case |
| --- | --- | --- | --- | --- | --- |
| 2026-05-25T15:10:30Z | `opencode:tool-after` | `post-tool-failure` | `bash: npm run build 2>&1` exit=1 | `0.9`, `candidate_ready=true` | `dc_hm_004` |
| 2026-05-25T15:10:33Z | `opencode:tool-after` | `post-tool` | `harmony-evo_harmony_search` | `0.65` | `dc_hm_004` |
| 2026-05-25T15:10:48Z | `opencode:tool-after` | `post-tool` | `bash: npm run build 2>&1` exit=0 | `0.6` | `dc_hm_004` |

前端验证：

- 打开 `http://localhost:3456`，进入“信号”栏目。
- OpenCode 复测时页面显示 `36 条事件级信号 · 1 个文件`；后续完成 Claude Code `ccb` 复测后当前总数为 `40 条事件级信号 · 1 个文件`。
- 最新 session 的失败、搜索、复测事件可见。
- Playwright 检查无 console error，无横向溢出。

本轮还收敛了 OpenCode hook 的门禁：

- `tool-after` 优先使用 OpenCode 的 `metadata.exit` / status，不再因为源码或 query 里出现 `Failed` 就误判为失败。
- dev-signal 上传只放行失败事件、用户意图、Harmony_Evo 工具事件、以及 build/hvigor 复测类验证命令，减少普通 `read` / `touch` 噪声。
- 检索 query 优先取诊断行，例如 `ERROR: Failed to find signature file` 和 `signingConfigs...keyStorePath`，提高 Top Case 精度。

## 工程判断

OpenCode 接入应该固定为双层：

```text
MCP = 可请求、可查询、可提交
Hook Plugin = 可观察、可采集、可回流
```

这和 Claude Code hook 的设计目标一致：真正的案例自进化不能只靠工具调用，必须捕获开发事件。
