# Harmony_Evo 产品方案

> **鸿蒙开发 Bug 修复知识系统** —— 把华为开发者论坛的已解决案例，结构化注入 evolver GEP 体系，让团队开发中遇到的每个报错都能秒级匹配历史修复方案。

---

## 一、产品定位

### 解决什么问题

鸿蒙（HarmonyOS）生态发展迅速，API 频繁迭代，开发中踩坑是常态。团队的痛点：

| 痛点 | 现状 | Harmony_Evo 方案 |
|------|------|-----------------|
| 报错搜不到有效方案 | 百度/Google 搜到的是过时或无关的结果 | 精准匹配华为论坛已解决的同款问题 |
| 修过的 bug 下次还踩 | 靠个人记忆，换人/换项目就丢失 | 每次修复自动入库，沉淀为团队资产 |
| 论坛海量信息利用率低 | 知道华为论坛有答案但懒得翻 | 爬虫批量抓取 + LLM 结构化提取 |
| 经验不可迁移 | 这个项目的修坑经验下个项目用不上 | DebugCase 跨项目共享，高频案例升级为 evolver Gene |

### 一句话概括

> **相当于给团队配了一个"鸿蒙踩坑百科"，每次遇到报错，秒级告诉你历史上谁遇到过、怎么修的、代码怎么改。**

---

## 二、整体架构

```
┌──────────────────────────────────────────────────────────────────────┐
│                        用户交互层                                     │
│  ┌──────────────────┐  ┌───────────────┐  ┌──────────────────────┐  │
│  │ Web Dashboard    │  │ CLI 命令行     │  │ API 接口            │  │
│  │ (图表/搜索/管理)  │  │ (搜索/爬取/注入)│  │ (供 CI/CD 集成)     │  │
│  └────────┬─────────┘  └───────┬───────┘  └─────────┬────────────┘  │
└───────────┼───────────────────┼─────────────────────┼────────────────┘
            │                   │                     │
┌───────────▼───────────────────▼─────────────────────▼────────────────┐
│                        核心引擎层                                     │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  三层匹配引擎（search.js）                                     │   │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐                       │   │
│  │  │ 精确匹配  │  │ 信号匹配  │  │ 模糊匹配  │ ← 实时响应 <1ms    │   │
│  │  │ 错误码   │  │ 标签重叠 │  │ 关键词   │                     │   │
│  │  │ score=100│  │ score=30│  │ score=5~20│                    │   │
│  │  └─────────┘  └─────────┘  └─────────┘                       │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  爬虫引擎（huawei-forum.js）                                   │   │
│  │  Playwright 无头浏览器 → 自动翻页 → 提取已解决帖子             │   │
│  │  → 原始数据 JSONL → LLM/模板提取 → DebugCase                  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  GEP 桥接层（inject.js + promote.js）                         │   │
│  │  DebugCase → evolver.genes.json                               │   │
│  │  DebugCase → evolver.capsules.json                            │   │
│  │  DebugCase → evolver.candidates.jsonl                         │   │
│  │  高频案例(≥3次匹配) → 自动提升为 Gene                          │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
                          │
┌─────────────────────────▼──────────────────────────────────────────┐
│                        数据存储层                                    │
│                                                                     │
│  Harmony_Evo/assets/debug_cases/     evolver-main/assets/gep/       │
│  ┌──────────────────────────────┐  ┌─────────────────────────┐      │
│  │ cases.jsonl   (187 条正式案例)│  │ genes.json    (+3 Gene) │      │
│  │ candidates/   (213 条候选来源)│  │ capsules.json (经验胶囊)│      │
│  │ .checkpoint.json(爬虫断点)   │  │ candidates.jsonl(候选)  │      │
│  └──────────────────────────────┘  │ events.jsonl (+3 Event) │      │
│                                    └─────────────────────────┘      │
│                                                                     │
│  存储方案：JSONL 文件（无数据库依赖，git 可追踪、grep 可搜索）        │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 三、核心数据模型：DebugCase

每个故障案例是一个结构化 JSON 对象，包含以下维度：

```jsonc
{
  "dc_id": "dc_hm_001",            // 唯一 ID
  "source": "huawei_forum",        // 来源（huawei_forum / github_issue / local_git / manual）
  "source_url": "...",             // 原文链接
  
  "symptom": {
    "error_signals": ["push_token_null", "hms_core_error"],   // 信号标签（匹配用）
    "error_code": "907135702",                                // 华为错误码
    "error_message": "PushService.getToken() returns null",   // 原始报错信息
    "observed_environment": ["HarmonyOS 4.0", "Mate 60 Pro"], // 环境
    "scenario": "应用启动时获取 push token 返回 null"           // 场景描述
  },

  "root_cause": {
    "category": "api_usage",        // 分类（api_usage/permission/performance/...）
    "analysis": "...",              // 根因分析（中文）
    "confidence": 0.95              // 置信度
  },

  "fix": {
    "strategy": "repair",           // repair/optimize/workaround/config_change/upgrade
    "description": "...",           // 修复步骤
    "key_code_snippet": "// 正确方式...\nonNewToken(token)...",  // 关键代码
    "validation": "getToken 返回非空字符串"                       // 验证方法
  },

  "tags": {
    "harmonyos_version": ["4.0", "4.1"],
    "api_category": ["push", "hms-core"],
    "bug_type": ["null_return", "async_timing"],
    "severity": "major",
    "keywords": ["push token null", "907135702", "华为推送 token 为空"]
  },

  "evolver_meta": {
    "promoted_to_gene": false,      // 是否已提升为 Gene
    "matched_count": 3,            // 被匹配次数（≥3 触发自动提升）
    "ingested_at": "..."            // 入库时间
  }
}
```

**这个模型的三层价值**：
- **开发者**：直观看到"什么错了"→"为什么"→"怎么修"→"代码长啥样"
- **搜索引擎**：`error_signals` 精确匹配 + `keywords` 模糊匹配 + `error_code` 硬匹配
- **evolver GEP**：自动映射为 Gene（`signals_match` + `strategy` + `validation`）

---

## 四、用户使用流程

### 4.1 日常开发：秒级匹配历史修复

```
团队开发中 → 遇到鸿蒙报错
                │
                ▼
        打开 http://localhost:3456
                │
                ▼
        在搜索框输入报错信息
        "canvas 画布 卡顿" 或 "907135702"
                │
                ▼
        <1ms 返回匹配结果
        ┌─────────────────────────────────────┐
        │ [exact] token 返回空 (score:100)     │
        │   根因: HmsMessageService 未初始化    │
        │   修复: 将 getToken 移到 onNewToken  │
        │   代码: onNewToken(token) { ... }    │
        └─────────────────────────────────────┘
                │
                ▼
        按照修复方案改代码 → 问题解决
```

### 4.2 定期维护：扩大案例库

```bash
# 每周跑一次：爬取华为论坛最新已解决案例
npm run scrape -- --count 100 --concurrency 3

# 提取为 DebugCase（自动去重）
npm run extract

# 高频案例（记录命中≥3次的）批量提升为 evolver Gene
npm run promote -- --auto

# 查看完整报告
npm run dashboard:html
```

### 4.3 知识沉淀闭环

```
华为论坛帖子 → 爬虫抓取 → LLM 提取 → DebugCase 入库
                                                │
                            ┌───────────────────┘
                            ▼
                 团队遇到同类报错 → 搜索命中
                                    │
                    ┌───────────────┘
                    ▼
           显式记录命中 → matched_count++
                    │
            matched_count ≥ 3?
           ┌────┴────┐
          是         否
           │          └→ 继续积累
           ▼
  promote.js 自动提升为 Gene
           │
           ▼
  genes.json 新增一条记录
           │
           ▼
  evolver 下次运行时可选到此 Gene
           │
           ▼
  团队的修复经验 → 变成了 AI 可选的进化基因
```

---

## 五、当前技术指标

| 指标 | 数值 | 说明 |
|------|------|------|
| **案例库规模** | 187 条 | 当前 `cases.jsonl` 中 187 条结构化 DebugCase，schema 校验通过 |
| **搜索响应** | <1ms | 基于内存 JSONL，无需数据库 |
| **匹配精度 - 错误码** | 100% | `907135702` 精确命中对应案例 |
| **匹配精度 - hvigor 签名** | 可用 | `Failed to find signature file` 命中 `dc_hm_004` |
| **原始候选规模** | 213 条 | raw candidates 已按 `source_url` 去重，后续采集会继续防重复 |
| **事件级开发信号** | 40 条 | Claude Code / OpenCode hook 已上传真实失败构建 dev-signal |
| **爬取内容质量** | 中 | 模板提取可用；当前质量报告仍有 539 个提示，主要是低置信度、泛分类、待人工验证和 thin fix |
| **evolver 注入** | 3 个 Harmony Gene | `gene_harmony_001` / `gene_harmony_002` / `gene_harmony_005` 已同步，本地 case 元数据已标记 promoted |

---

## 六、产品路线图

### Phase 1：基础可用 ✅（当前状态）

- [x] DebugCase Schema 定义
- [x] JSONL 文件存储引擎
- [x] 三层匹配搜索（错误码/信号/模糊）
- [x] 华为论坛爬虫（无需登录）
- [x] 模板提取（无需 API Key）
- [x] evolver GEP 资产注入
- [x] Web Dashboard（5 页面 + REST API）
- [x] 187 条 DebugCase 数据
- [x] candidate 去重与处理索引
- [x] DebugCase 质量报告：`npm run quality`
- [x] Claude Code hooks：搜索注入、失败事件解析、dev-signal 上传
- [x] OpenCode MCP + Plugin hooks：主动搜索、事件级采集、上下文注入
- [x] 共享上传队列：`submissions` 与 `dev-signals`，服务端二次脱敏

### Phase 2：提升数据质量（1-2 周）

- [ ] 配置 `ANTHROPIC_API_KEY` → 模板提取切换为 LLM 提取，accuracy 从 50%→85%
- [ ] 清理爬虫噪音（答案中的"采纳答复""回复于"等 UI 文字的自动过滤）
- [ ] 增加爬虫分类过滤（按 API：Push/Ability/ArkUI/Network 等分类爬取）
- [ ] 添加自动去重（同一问题多个回答时合并最佳答案）

### Phase 3：扩大覆盖（持续）

- [ ] 定期爬虫 + CI 自动更新（GitHub Actions 每周跑一次）
- [ ] 增加 GitHub Issues 数据源（鸿蒙相关仓库的已关闭 issue）
- [x] 团队手动录入入口（CLI/MCP submit 进入 review queue）
- [x] CLI 搜索集成（`npm run client -- search "错误信息"`）

### Phase 4：深度集成

- [x] 与 Claude Code / OpenCode hook 系统集成（prompt、工具输出、失败事件自动匹配案例）
- [ ] IDE 插件（DevEco Studio / VSCode 插件，报错时自动弹出匹配修复）
- [x] 团队共享 Hub 雏形（服务端 API、上传队列、反馈和信号页）
- [ ] 完整审核工作台和案例质量重排（点赞/踩、成功率、自动降权）

---

## 七、团队推广策略

### 第一天

```bash
cd Harmony_Evo
npm run server
# 浏览器打开 http://localhost:3456
# 团队每个人都能看到 Dashboard、搜索已有案例
```

### 第一周

```bash
npm run scrape -- --count 100 --concurrency 3   # 爬一批新案例
npm run extract                # 提取入库
# 群发通知：以后遇到鸿蒙报错，先搜一下这个看板再问人
```

### 持续

- 每周一爬：`npm run scrape -- --count 100`（增量更新）
- 每月评审：看 Dashboard 的高频错误排行榜，针对性地补充手动案例
- 踩坑必录：团队有人解决了一个新坑，手动录入为 DebugCase（`--manual` 模式生成模板）

---

## 八、竞品对比

| 维度 | Harmony_Evo | 百度/Google 搜报错 | 华为论坛手动翻 | 内部 wiki |
|------|------------|-------------------|--------------|----------|
| 响应速度 | <1ms | 10s-30s | 5min-30min | 取决于有没有人记 |
| 匹配精度 | 高（结构化工具体） | 低（通用搜索） | 中（人脑判断） | 低（全靠记忆） |
| 覆盖范围 | 持续增长 | 全互联网 | 全论坛 | 极有限 |
| 团队沉淀 | 自动积累 | 不沉淀 | 不沉淀 | 靠自觉 |
| 与 AI 集成 | evolver GEP 对接 | 无 | 无 | 无 |
| 部署成本 | 一个 terminal 窗口 | 免费 | 免费 | 需要维护 |

---

## 九、局限性

1. **模板提取准确率不高**：没有 API Key 时用的是规则提取（`templateExtract`），能识别错误码但不能精确提取根因和修复方案。配置 `ANTHROPIC_API_KEY` 后切换到 LLM 提取可改善。

2. **爬虫依赖页面结构**：华为论坛是 Angular SPA，如果改版需要调整选择器。当前的选择器 (`topic-link`, `aci-ck4-preview`, `app-reply-card`) 已经比较稳定。

3. **无法自动验证修复方案**：从论坛爬的修复方案不一定 100% 适用于你的项目。需要人工判断后采纳。

4. **案例库冷启动阶段**：当前案例数仍不足以覆盖所有鸿蒙场景，且不少论坛提取案例置信度偏低。需要持续爬取、LLM 复核和团队手动补充。

---

## 十、架构决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 存储格式 | JSONL | 比 SQLite 轻量，比纯文本可搜索，git 可 diff，无需数据库服务 |
| 前端框架 | 零依赖 Vanilla JS | 不需要 npm build，一个 `node server/index.js` 就跑起来了 |
| 图表库 | Chart.js CDN | 按需加载，不增加项目体积 |
| 爬虫引擎 | Playwright | 支持 Angular SPA 的客户端渲染，华为论坛必须 |
| 匹配算法 | 三层 scoring | 简单有效，无需向量数据库，<1ms 响应 |
| 与 evolver 对接 | 直接写 JSON 文件 | evolver 核心是混淆的，不改它，只往它的资产目录写数据 |

---

## 十一、命令速查

```bash
# 启动 Web 看板
npm run server                    # http://localhost:3456

# 搜索
npm run search -- --query "权限 弹窗"
npm run search -- --error-code 907135702

# 爬取
npm run scrape -- --count 30
npm run scrape -- --count 100 --concurrency 4
npm run scrape -- --status        # 查看爬取进度

# 提取 DebugCase
npm run extract

# 提升为 evolver Gene
npm run promote -- --status       # 查看可提升的案例
npm run promote -- --auto         # 自动提升所有符合条件的

# 注入 evolver 资产
npm run inject -- --status        # 查看注入状态
npm run inject -- --as-gene dc_hm_001     # 手动注入为 Gene
npm run inject -- --as-capsule dc_hm_001  # 手动注入为 Capsule

# 测试
npm test                          # 完整验证套件
```
