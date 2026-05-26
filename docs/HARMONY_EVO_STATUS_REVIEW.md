# Harmony_Evo 项目现状 Review

日期：2026-05-25

更新：2026-05-26 已完成服务端/客户端收尾验收。当前以 `README.md`、`docs/CLIENT_USAGE.md` 和 `docs/CLIENT_SHOWCASE.html` 为最新交付入口。

设计参考：华为开发者联盟 HarmonyOS 设计页（纯净蓝白、数据可视化、舒适圆角、卡片式设计）：https://developer.huawei.com/consumer/cn/design/concept/

## 结论

Harmony_Evo 现在已经具备可用的“案例库 -> 采集 -> 提取 -> 搜索复用 -> Hook 注入 -> 事件级上传 -> 候选审核队列 -> Gene 升级 -> 反馈修正”闭环雏形。团队共享上传 Hub 的基础 API、dev-signal 队列和客户端 hook 已经落地，但它还不是完全自动自治学习系统。

当前最核心的问题不是功能入口缺失，而是数据质量、语义匹配、Gene 提升门槛和共享可信机制还不够成熟。

## 当前数据状态

| 项目 | 当前状态 |
| --- | --- |
| DebugCase 案例库 | 187 条，schema 校验全部通过 |
| Raw candidates | 213 条 |
| 空内容候选 | 0 条 question/answer 同时为空 |
| Harmony Gene | 3 个，已同步到 `../evolver-main/assets/gep/genes.json` |
| 待提升案例 | 0 个 |
| 事件级开发信号 | 40 条，Claude Code / OpenCode 真实失败构建均已上传 |
| 质量问题 | 539 个提示，主要是低置信度、泛分类、人工验证、噪声标签、thin fix |
| 服务入口 | `http://localhost:3456` |

## 三个核心功能

### 1. 案例库

可用能力：
- 案例列表可渲染 187 条案例。
- 支持错误码、关键词、signal 搜索。
- `GET /api/search` 不再污染 `matched_count`。
- 通过 `POST /api/cases/:id/match` 显式记录命中。
- 案例详情支持记录命中、修复有效/无效反馈、手动升级 Gene。

主要问题：
- 规则搜索对语义相似问题支持弱。
- 低质量案例较多，`other` 分类和噪声 API 标签会影响召回和聚类。
- 很多 validation 仍是人工验证文本，不能自动执行。

### 2. 采集

已修复：
- 不再用“采集 N 页”的假页数逻辑，改为 `--count` / `--limit` / UI 中的 30/100/300 条。
- 论坛列表优先走华为开发者论坛 JSON 接口 `getAnswerTopicList`，不再依赖滚动到底。
- 详情页优先走 `getTopicDetail` 和 `getAnswerDepthPostList`，直接拿问题正文和采纳回答。
- Playwright DOM 抓取保留为 fallback。
- 候选保存按 `source_url` 去重。

已验证：
- `npm run scrape -- --count 1 --concurrency 1` 能读到 100 个列表项、41 个已解决帖子，并保存 1 条完整候选。
- 最新候选有问题正文和答案，不再是只有标题的空内容。

剩余风险：
- 华为接口字段或鉴权策略变化会导致采集失效。
- 论坛回答本身可能很短、无上下文或并非真正修复方案。
- 详情 API 目前只拉第一页回复，长讨论可能漏掉后续高质量答案。

### 3. 进化

当前运行逻辑：
1. 用户搜索案例。
2. 搜索结果不会自动累计命中。
3. 用户显式点击“记录命中”后，`matched_count++`。
4. `matched_count >= 3` 且未提升时，案例进入待升级。
5. 手动或 `npm run promote -- --auto` 将 DebugCase 转为 Gene。
6. Gene 写入 `../evolver-main/assets/gep/genes.json`。
7. 同步写入 `events.jsonl` 和 `candidates.jsonl`，本地案例标记 promoted。
8. 反馈接口会记录成功/失败，并影响经验置信度。

主要问题：
- 这是本地资产桥接，不是完整自治学习。
- Gene 提升仍主要依赖命中次数，缺少“修复成功证据”和反例检查。
- 没有自动 hook 到真实开发会话的错误捕获、修复应用、回归验证链路。

## 共享上传功能现状

当前基础能力已经实现：

- `POST /api/submissions` / `GET /api/submissions`：候选案例上传和查看。
- `POST /api/dev-signals` / `GET /api/dev-signals`：事件级开发信号上传和查看。
- 客户端本地脱敏，服务端二次脱敏。
- 可选 `HARMONY_EVO_UPLOAD_TOKEN` 鉴权。
- Claude Code hook 和 OpenCode plugin hook 已经用真实 hvigor 签名失败流程验证上传。

仍未完成的是完整审核工作台、跨团队命名空间、冲突合并、质量重排和自动发布流。

要落地共享上传，至少需要：
- 共享 schema 版本和迁移策略。
- 案例来源、证据、可信度和作者信息。
- 脱敏流程，避免上传 token、签名、包名、业务域名、业务日志。
- 跨团队去重、聚类、冲突合并。
- 上传审核、撤回、回滚和黑名单机制。

## 不好解决的痛点

1. 数据质量不稳定：论坛问答常常短、口语化、缺上下文，规则抽取很容易误判。
2. 根因和修复不一定对应：采纳回答可能只是临时建议，不一定是可复用修复机制。
3. 语义重复难判断：同一类 bug 可能没有共同错误码，标题和描述差异很大。
4. Gene 固化风险：低质量案例一旦升级为 Gene，会污染后续推荐和修复策略。
5. 共享可信难：多团队上传后，隐私、版权、来源可信、版本冲突都会成为工程问题。

## 适合引入 LLM 的位置

### LLM Extractor

从 raw post 生成结构化 DebugCase：
- 抽取症状、环境、根因、修复步骤、验证方式。
- 输出证据句和字段置信度。
- 对短答案标记为低质量，不直接入正式库。

### LLM Judge

入库前审查：
- 判断 root cause 和 fix 是否自洽。
- 检查修复是否可执行、是否缺少上下文。
- 标出“只能作为候选，不能提升 Gene”的案例。

### Embedding + Reranker

提高检索精度：
- 用 embedding 做语义召回。
- 用 reranker 根据错误信息、代码片段、环境和 API 分类重排。
- 支持相似案例聚类和跨来源去重。

### Gene Promotion Gate

提升前增加质量门：
- 至少有可靠来源证据。
- 至少有多次成功反馈或自动验证。
- LLM 做反例检查，确认不会误导到相似但不同根因的问题。

### Share Upload Sanitizer

共享上传前自动脱敏：
- 检测 token、密钥、包名、URL、业务字段、日志隐私。
- 生成可共享版 DebugCase。
- 保留 provenance hash，便于追踪来源但不泄露内容。

## 建议下一阶段

1. 先把 LLM Judge 接到 `llm-extractor.js` 后面，阻止低质量候选直接进案例库。
2. 增加 embedding 索引，搜索从 keyword-only 升级为 hybrid search。
3. 为 Gene 提升增加质量门：命中次数 + 成功反馈 + LLM 审核。
4. 设计共享上传协议，但先做本地 export/import 包，不急着做远端 Hub。
5. 把 `server/index.js`、`huawei-forum.js` 拆分，降低长函数和嵌套复杂度。
6. 做 submissions/dev-signals review UI，把高质量事件转成 DebugCase/Gene/Capsule 的流程产品化。

## 验证记录

已执行：
- `npm test`
- `npm run test:functional`
- `npm run quality`
- `npm run status`
- `npm audit --omit=dev`
- `npm run scrape -- --count 1 --concurrency 1`
- Playwright 页面烟测：案例库、搜索、采集入口、进化视图
- `npm run client:self-test`
- Claude Code `ccb 2.1.888` 真实 session：`60464599-50e8-4ba7-9e77-cc9e66928a8a`
- OpenCode `1.15.10` 真实 session：`ses_1a0501d6fffefUk39nksbqPgLE`

当前已知残留：
- `npm run quality` / 测试摘要仍报告 539 个质量提示。
- Karpathy complexity check 对既有长函数和深嵌套给出 WARN。
- 共享上传基础 API 和 hook 上传已实现，但审核工作台和自动发布流尚未完成。
