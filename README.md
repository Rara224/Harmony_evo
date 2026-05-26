# Harmony_Evo

Harmony_Evo 是一个面向 HarmonyOS 开发的共享案例资产中心。服务端管理 DebugCase、采集候选、Gene/Capsule、反馈和事件级开发信号；客户端接入 Claude Code hooks、OpenCode MCP + Plugin hooks 或 CLI，把本地报错脱敏后查询服务端，并把高质量开发事件上传到审核队列。

## 当前状态

截至 2026-05-26，本机验证状态：

| 模块 | 状态 |
| --- | --- |
| 服务端 | `http://localhost:3456` 正常运行 |
| DebugCase | 187 条，schema 校验全部通过 |
| Raw Candidates | 213 条 |
| Harmony Gene | 3 个，evolver connected |
| Dev Signals | 40 条事件级信号 |
| 客户端 | CLI、Claude Code hook、OpenCode MCP + hook 自检通过 |
| 展示页 | `docs/CLIENT_SHOWCASE.html` 桌面/移动端渲染通过 |

已实测的关键链路：

- CLI 搜索 `hvigor signingConfigs Failed to find signature file` 命中 `dc_hm_004`。
- Claude Code `ccb 2.1.888` 新 session 触发真实 `PostToolUseFailure`，上传 `score=0.9`、`candidate_ready=true` 的 dev-signal。
- OpenCode `1.15.10` 真实 session 通过 MCP 搜索案例，并通过 plugin hook 上传失败构建事件。

## 启动服务端

```bash
npm run server
```

打开：

```text
http://localhost:3456
```

检查服务端和资产状态：

```bash
npm run client -- status
curl http://localhost:3456/api/health
```

## 客户端接入

详细说明见：

- `docs/CLIENT_USAGE.md`
- `clients/harmony-evo-client/README.md`
- `dist/harmony-evo-client-standalone/QUICK_START_CN.md`

在业务 HarmonyOS 项目目录安装 Claude Code hooks：

```bash
node /Users/ra/Downloads/Paper_Repo/Harmony_Evo/clients/harmony-evo-client/bin/harmony-evo-client.js install claude --server http://localhost:3456 --upload-signals
```

在业务 HarmonyOS 项目目录安装 OpenCode MCP + Hook：

```bash
node /Users/ra/Downloads/Paper_Repo/Harmony_Evo/clients/harmony-evo-client/bin/harmony-evo-client.js install opencode --server http://localhost:3456 --upload-signals
```

手动搜索：

```bash
npm run client -- search "hvigor signingConfigs Failed to find signature file"
```

## 独立客户端包

可复制给别人使用的客户端包在：

```text
dist/harmony-evo-client-standalone/
dist/harmony-evo-client-standalone-0.1.0.tar.gz
```

对方只需要 Node.js 18+ 和服务端地址即可使用。

## 验证命令

```bash
npm run client:self-test
npm run test:functional
npm test
```

当前已知边界：

- 案例库运行可用，但仍有 539 个质量提示，主要是低置信度、泛分类、待人工验证和 thin fix。
- 自进化链路已经具备 dev-signal、submission、feedback、Gene promotion 和 Capsule 写入能力，但 `dev-signals -> DebugCase -> Capsule` 仍需要审核/LLM 结构化后才能完全自动化。
- 默认不会上传候选案例；只有显式开启 `--upload-signals` 或 `--auto-submit` 才会上报。
