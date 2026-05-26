# Harmony_Evo 服务端

这个分支是 Harmony_Evo 的服务端版本，用来管理团队共享的 HarmonyOS 案例资产。

完整项目在 `main` 分支；独立客户端在 `client` 分支。

## 功能介绍

- 案例库：管理结构化 DebugCase，支持错误码、关键词、信号标签搜索。
- 采集：从华为开发者论坛采集候选问题，保存为 raw candidates。
- 提取：把候选内容整理成 DebugCase。
- 反馈：记录案例是否解决问题，沉淀成功/失败经验。
- 上传队列：接收客户端提交的候选案例和事件级 dev-signal。
- 进化：把高价值 DebugCase 提升为 Gene / Capsule，接入 evolver 资产。
- 前端看板：提供案例库、采集、信号、进化状态等页面。

## 当前状态

| 项目 | 状态 |
| --- | --- |
| 本地服务 | `http://localhost:3456` |
| DebugCase | 187 条 |
| Raw Candidates | 213 条 |
| Dev Signals | 40 条 |
| Harmony Gene | 3 个 |
| Evolver | 已连接 |

## 启动

```bash
npm install
npm run server
```

浏览器打开：

```text
http://localhost:3456
```

## 常用命令

```bash
npm test
npm run test:functional
npm run quality
npm run status
npm run scrape -- --count 30
npm run extract
npm run promote -- --auto
```

## 主要接口

- `GET /api/stats`：总览统计。
- `GET /api/search?q=...`：搜索案例。
- `GET /api/cases`：案例列表。
- `POST /api/scrape`：启动采集。
- `GET /api/evolver`：进化资产状态。
- `POST /api/submissions`：客户端候选案例上传。
- `POST /api/dev-signals`：客户端事件级信号上传。
- `GET /api/health`：系统健康状态。

## 文档

- `USAGE_SERVER.md`：服务端使用说明。
- `PRODUCT.md`：产品方案。
- `docs/HARMONY_EVO_STATUS_REVIEW.md`：项目现状 review。
- `docs/SERVER_CLIENT_ASSET_HUB_PLAN.md`：服务端/客户端规划。

## 安全说明

不会提交本地账号、密码和会话文件：

- `.env`
- `.forum_session_storage.json`
- `opencode.jsonc`
- `.opencode/`
- `node_modules/`

客户端上传内容会先进入审核队列，不会直接变成正式案例。
