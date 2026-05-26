# Harmony_Evo 客户端 Hook/MCP 实施说明

## 目标

当前实现把 Harmony_Evo 拆成两个角色：

- 服务端：团队共享的案例资产中心，负责案例库、采集候选、Evo/Gene 状态、搜索、反馈、上传审核队列。
- 客户端：本地开发会话适配层，接入 Claude Code hooks 或 OpenCode MCP，把本地问题转成脱敏查询，再把匹配到的案例资产注入给开发工具。

这样做的意义是把“共享资产治理”和“本地隐私上下文”分开。服务端可以沉淀和审核团队经验，客户端只承担轻量接入、脱敏、查询、反馈和候选上传。

## 已落地内容

客户端目录：

```text
clients/harmony-evo-client/
  bin/harmony-evo-client.js
  src/
    cli.js
    hooks.js
    mcp.js
    install.js
    server-api.js
    redact.js
    signals.js
    event-signals.js
    opencode-hooks.js
    profile.js
    format.js
    self-test.js
```

服务端新增：

- `POST /api/submissions`：接收客户端共享候选案例，写入 review queue。
- `GET /api/submissions`：查看提交文件和数量。
- `POST /api/dev-signals`：接收 hook 事件级开发信号，写入 dev signal queue。
- `GET /api/dev-signals`：查看 dev signal 文件和数量。
- `HARMONY_EVO_UPLOAD_TOKEN`：可选上传鉴权。
- `HARMONY_EVO_SUBMISSIONS_DIR`：测试或私有部署时可覆盖提交目录。
- `HARMONY_EVO_DEV_SIGNALS_DIR`：测试或私有部署时可覆盖开发信号目录。
- 服务端二次脱敏：即使客户端漏脱敏，服务端也会再处理一次。
- 高风险提交隔离：发现 API key、Authorization、password、cookie 时状态为 `quarantined`。

## 易用性设计

默认只需要一个服务端地址：

```bash
HARMONY_EVO_SERVER=http://localhost:3456
```

Claude Code 项目级接入：

```bash
node clients/harmony-evo-client/bin/harmony-evo-client.js install claude --server http://localhost:3456
```

OpenCode MCP 接入：

```bash
node clients/harmony-evo-client/bin/harmony-evo-client.js install opencode --server http://localhost:3456
```

客户端没有外部 npm 依赖，使用 Node.js 18+ 内置 `fetch`。

## Hook 流程

Claude Code hook 的核心链路：

```text
UserPromptSubmit / PostToolUse / PostToolUseFailure
  -> 读取 hook stdin JSON
  -> 抽取 prompt、命令、工具输出、错误信息
  -> 本地脱敏
  -> 识别 HarmonyOS 信号和错误码
  -> 调 /api/search
  -> 格式化案例匹配结果
  -> 通过 hook JSON additionalContext 注入给 Claude Code
```

失败策略：

- 服务端不可用：静默返回空结果，不阻塞开发。
- 搜索无匹配：不注入额外上下文。
- 上传失败：如果开启自动上传，则写入本地 pending 缓存。

默认不开启自动上传：

```bash
HARMONY_EVO_UPLOAD_SIGNALS=false
HARMONY_EVO_AUTO_SUBMIT=false
```

事件级信号和候选案例是两条队列：

- `dev-signals`：由 hook 事件分析生成，记录 prompt、工具调用、失败证据、相似案例命中、质量分。默认只本地缓存；开启 `HARMONY_EVO_UPLOAD_SIGNALS=true` 后上传。
- `submissions`：候选案例队列，只有 `HARMONY_EVO_AUTO_SUBMIT=true` 且事件质量达到更高阈值时才自动提交。

这避免把每次工具输出都当作 bug case，也为后续 LLM 归纳、去重、审核提供更干净的事件证据。

## MCP 流程

OpenCode 侧现在是 MCP + Plugin Hook 双层接入。MCP 通过本地 server 调用：

```text
OpenCode MCP client
  -> stdio JSON-RPC
  -> harmony-evo-client mcp
  -> /api/search /api/stats /api/submissions /api/feedback
```

暴露工具：

- `harmony_search`：搜索共享案例资产。
- `harmony_status`：检查服务端资产数量和连接状态。
- `harmony_submit_candidate`：用户明确触发后上传候选案例。
- `harmony_feedback`：记录案例是否有效。

MCP 提交也是 review queue，不会直接进入正式案例库或 Evo Gene。

OpenCode Plugin Hook 额外监听：

```text
chat.message / command.execute.before / tool.execute.before
tool.execute.after / event / experimental.chat.system.transform
```

其中 `tool.execute.after` 会把失败工具输出映射为 `post-tool-failure`，用于 dev-signal 评分和上传。

## 资产闭环

当前闭环是：

```text
本地问题
  -> 客户端脱敏查询
  -> 服务端返回案例资产
  -> 开发工具使用案例修复
  -> 用户反馈 worked/failed
  -> 可选上传新候选
  -> 服务端审核、抽取、去重
  -> 达到质量条件后进入案例库/Evo Gene
```

这条链路把案例自进化分成两个阶段：

- 自动辅助阶段：查找、注入、反馈，尽量低摩擦。
- 治理阶段：候选审核、质量评分、去重、Promotion，避免共享库变成噪音库。

## 当前边界

已经完成的边界：

- 支持 Claude Code hooks 和 OpenCode MCP + Plugin hooks 的接入。
- 支持手动 CLI 查询、反馈、提交。
- 支持本地与服务端双层脱敏。
- 支持可选上传 token。
- 支持功能测试覆盖提交审核队列。

还没做的边界：

- 候选案例和 dev-signal 的前端列表已可查看，但完整审核工作台还没有做。
- 上传候选到正式案例库的 promotion 仍需要人工或后续脚本。
- 自动上传默认关闭，避免误传本地业务上下文。
- 还没有针对不同团队项目建立细粒度命名空间、权限和配额。

## 协议依据

实现时按这几个当前官方文档核对：

- Claude Code hooks：`https://docs.anthropic.com/en/docs/claude-code/hooks`
- OpenCode MCP servers：`https://opencode.ai/docs/mcp-servers/`
- MCP stdio transport：`https://modelcontextprotocol.io/specification/2025-06-18/basic/transports`

## 下一步建议

优先级从高到低：

1. 做 submissions review UI：查看、过滤、批准、拒绝、转案例。
2. 给 `/api/submissions` 增加 namespace/project 字段，便于多团队使用。
3. 增加候选去重和相似案例合并，避免重复上传污染资产库。
4. 用 LLM 做候选规范化：把本地日志转成 DebugCase schema，并给出置信度。
5. 用反馈数据重排搜索结果，把“解决过”的案例排到更前。
