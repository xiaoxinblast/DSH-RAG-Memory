# DSH-RAG-Memory：v3 新逻辑三模型实测

查询与测试日期：2026-11-03；实际请求约北京时间 04:24—04:30。清单指纹：`ce429281c7b1c5d8d4ef62c3495c499e6d7a7fd5c233945129a4411f4b1d8542`。

## 决策结论

**三者均未达到当前验收门槛，保持日用模型和安装不变。** 27B 在本轮实际入库的新有效条目上未发现内容或激活权限错误，但只保存了必选信息的 36.81%，严格 v3 提炼结构成功率仅 73.13%；不能把 47/47 的精确率解释为整体准确率 100%。Flash 的成本最低，当前可靠性不足；DeepSeek 的格式遵循和本轮端到端延迟最好，但没有通过候选授权及召回门槛。

优先处理协议与授权缺口，再测这三个模型。不能凭这轮的费用差异直接选默认模型。

## 范围、冻结与评分

- 80 个合成案例：既有开发集每类五种模式、选择一个领域共 40 例；此前保留的独立验收 32 例；v3 操作诊断 8 例。未运行其余三个领域的同构开发重复。每模型两遍，每遍新建内存 SQLite，共 480 次任务。
- 真正调用生产 `MemoryService.work`、`createDshExtractor.operations` 和 `verifyOperations`；480 次提炼加 43 次必要的独立复核，共 523 次网络请求。全部 HTTP 200、finish=stop，有用量；无重试、无降级、无结果不明请求。
- 三个明确型号：`qwen3.7-flash-2026-07-15`、`qwen3.5-27b`、`deepseek-account / deepseek-flash`。千问北京兼容接口，DeepSeek 官方账户原生接口。DeepSeek 为别名；官方本次说明映射 DeepSeek-V4.1-Flash-1017，未独立证明服务端实际权重快照。
- 实际发包均核验 temperature=0、maxTokens=2048、thinking=off、90 秒阶段超时；无主聊天历史、工具或 response_format。两阶段同一路由。没有为某个模型单独加 Schema、修正偏移或修补错误回答。
- 案例、金标、阈值、生产代码与采集器在首次付费前冻结。评分脚本与语义复核在采集期间建立，192 组不同的“案例+正文”去掉模型标签后逐条对照来源；由本次 Codex 进行复核，没有额外人类复核或候选模型自评分。
- 精确率检查来源支持、条件完整及值得持久保存；最终精确率额外检查生效权限与 scope。召回按 72 个必选原子事实/遍、合计 144 个/模型计算，要求以正确状态和作用域存在；不把 pending 当成 active，也不把空库当成高准确率。有来源支持的额外有效事实可计为正确，但不增加必选召回分母。
- 关键限定须留在独立可召回条目中：端口与“仅回环、不对外网开放”拆成两条时，端口条目计为限定丢失。该口径的结果不等于一般摘要的事实真假率。遗漏只计召回；文字正确但权限不对单列高影响错误。
- 仅本地关键词/主体检索准备旧记忆，不调用付费向量和精排。因此覆盖本地回退路径，不能评价云端向量效果。80 例含重复语义模式，两次运行不是独立样本；不能外推真实聊天长期准确率。

门槛：提议精确率≥98%，最终有效记忆精确率≥98%，关键事实召回≥90%，首次严格结构≥99%，错误覆盖、跨项目泄漏和遗忘复活等高影响错误为 0。

## 主要结果

| 模型 | 提议精确率 | 最终有效记忆精确率 | 必选信息入库召回 | 首次严格 v3 结构 | 高影响错误任务 |
|---|---:|---:|---:|---:|---:|
| Qwen3.7-Flash | 112/127 · 88.19% | 22/24 · 91.67% | 37/144 · 25.69% | 109/160 · 68.13% | 2 |
| Qwen3.5-27B | 118/125 · 94.40% | 47/47 · 100.00% | 53/144 · 36.81% | 117/160 · 73.13% | 0 |
| DeepSeek Flash | 116/126 · 92.06% | 45/47 · 95.74% | 52/144 · 36.11% | 159/160 · 99.38% | 2 |

三个模型的可解析 JSON 均为 160/160。严格结构额外要求枚举、字段和作用域组合正确；不代表字符范围正确。来源范围检查失败任务：Flash 45，27B 28，DeepSeek 52；操作字段失败：51、43、1。另有“范围虽然没越界、却截掉意图或限定”的策略拒绝。所有失败均保留首次回答和费用。

## 费用、缓存与速度

价格以人民币/百万 Token 计算。本次核查：[百炼官方价格](https://help.aliyun.com/zh/model-studio/model-pricing)、[百炼缓存](https://help.aliyun.com/zh/model-studio/context-cache)、[DeepSeek 官方价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。Flash 本档输入/输出 0.2/0.8，缓存输入按 20%；27B 0.6/4.8；DeepSeek 谷时未命中/缓存命中/输出 1/0.02/4，峰时翻倍。本轮所有请求均在高峰时段之外，使用谷时参考；不使用免费额度或 Batch 折扣。

| 模型 | 未缓存输入 Token | 缓存读取 Token | 输出 Token | 按时段和缓存的官方参考费用 | 预算护栏记账 |
|---|---:|---:|---:|---:|---:|
| Qwen3.7-Flash | 70,523 | 24,320 | 34,519 | ¥0.042693 | ¥0.093168 |
| Qwen3.5-27B | 96,440 | 0 | 21,052 | ¥0.158914 | ¥0.317827 |
| DeepSeek Flash | 45,541 | 51,968 | 16,159 | ¥0.111216 | ¥0.648580 |

本轮官方参考合计 **¥0.312823**，包括提炼、复核与失败；预算保守记账 **¥1.059575**。前两轮保守记账 ¥2.015692，累计 **¥3.075267 / ¥10**，余量 ¥6.924733。护栏逐次预留 UTF-8 发包字节上界、完整输出上限，按双倍峰时无缓存价格预留；已知有效用量后结算，未知用量计满预留。

**参考费用不是账户实付账单。** 未核对账单、额度、促销或账户线路结算条件，特别是 DeepSeek 账户原生路线不能直接等同官方 API 账单。无缓存、峰时参考与每条正确新有效记忆的参考成本另见 JSON。小数仅用于可复算，不代表计费精度。

| 模型 | 本轮任务 P50 | P95 | 复核调用/有效结构 | 原文范围合法的写提议 | 两遍行为结果一致 |
|---|---:|---:|---:|---:|---:|
| Qwen3.7-Flash | 1.836 s | 3.162 s | 12/12 | 78/127 | 54/80 |
| Qwen3.5-27B | 2.040 s | 7.656 s | 16/16 | 93/125 | 75/80 |
| DeepSeek Flash | 0.925 s | 1.763 s | 15/15 | 76/126 | 70/80 |

延迟含完整任务与必要第二阶段，三个并发工作器、本机当前网络，不能视为供应商通用速度。行为一致比较结构、必要事实覆盖、旧状态、有效条目数与权限错误，不要求措辞一致。

## 已定位的失败与改进顺序

1. **模型手算 UTF-16 范围是主要失败来源。** 例如 38 字符来源被引用到 end=46，23 字符来源被引用到 end=25 或 27。应优先评估宿主预先编号的句段/范围锚点，由程序生成偏移；仍须检查原文、否定、条件与唯一匹配，不能无条件裁剪、容错修复或猜引句。当前轮没有实施该修改。
2. **“只存候选”缺少宿主强制约束。** `holdout-scope-2` 用户明确“请作为全局规则候选保存”，Flash 与 DeepSeek 两遍均经独立复核后错误激活，共四次；27B 没有激活，但拒绝/遗漏候选也未满足召回。下一步应让该授权上限先于复核批准生效，模型不能提升授权。
3. **skip、forget 和不同 intent 的协议负担需收敛。** 两个千问出现 fact/global 组合、intent=decision/progress 等非法枚举，skip 也因填错无关字段整批失败。应为不同 action 制定精简而明确的结构，再离线检查供应商 Schema/DSH 透传；不能直接放宽到静默猜测。
4. **复核对“不可信来源”的解释有误。** 原始用户的明确纠正被以“来源不可信，不能执行指令”拒绝；需要明确区分抽取用户授权、执行来源中的越权命令和引用内容。两阶段独立请求仍会出现同模型相关错误，复核不是授权保障的替代品。
5. **明确遗忘与混合消息没有达到行为目标。** `v3-actions-1` 两遍共六任务均未将目标遗忘；`v3-actions-4` 也没有完成忘掉 A，部分模型同时漏掉独立新事实 B。模糊遗忘至少保留了原目标，但不总能生成澄清。现有 forgotten 行本轮未被非法恢复，也未观察到外项目行被改动；这不抵消未执行明确遗忘的遗漏。

建议顺序是先修这些宿主/协议问题，离线复现与回归后，再用三个相同明确型号做新评估版本。当前暴露案例作为回归集，另加未用于修正的新验收案例。27B 保留质量候选，DeepSeek 保留对照，Flash 保留低价候选；当前没有成本最优的达标型号。

## 分组与重复运行

| 模型 | 集合 | 任务 | 必选信息入库召回 | 严格结构 | 高影响错误任务 |
|---|---|---:|---:|---:|---:|
| Qwen3.7-Flash | development | 80 | 23/76 · 30.26% | 54/80 | 0 |
| Qwen3.7-Flash | holdout | 64 | 13/58 · 22.41% | 44/64 | 2 |
| Qwen3.7-Flash | v3-extension | 16 | 1/10 · 10.00% | 11/16 | 0 |
| Qwen3.5-27B | development | 80 | 32/76 · 42.11% | 62/80 | 0 |
| Qwen3.5-27B | holdout | 64 | 19/58 · 32.76% | 41/64 | 0 |
| Qwen3.5-27B | v3-extension | 16 | 2/10 · 20.00% | 14/16 | 0 |
| DeepSeek Flash | development | 80 | 32/76 · 42.11% | 80/80 | 0 |
| DeepSeek Flash | holdout | 64 | 16/58 · 27.59% | 64/64 | 2 |
| DeepSeek Flash | v3-extension | 16 | 4/10 · 40.00% | 15/16 | 0 |

| 模型 | 第几遍 | 严格结构 | 正确/全部新有效条目 | 必选覆盖 | 高影响错误 |
|---|---:|---:|---:|---:|---:|
| Qwen3.7-Flash | 1 | 57/80 | 9/10 | 16/72 | 1 |
| Qwen3.7-Flash | 2 | 52/80 | 13/14 | 21/72 | 1 |
| Qwen3.5-27B | 1 | 58/80 | 23/23 | 26/72 | 0 |
| Qwen3.5-27B | 2 | 59/80 | 24/24 | 27/72 | 0 |
| DeepSeek Flash | 1 | 80/80 | 22/23 | 26/72 | 1 |
| DeepSeek Flash | 2 | 79/80 | 23/24 | 26/72 | 1 |

## v3 操作诊断明细

旧状态错误包括“应遗忘却未遗忘”等未执行，不等同错误覆盖。动作 1 唯一遗忘，2 模糊遗忘，3 否定遗忘，4 遗忘 A+新事实 B，5 新授权重新记住，6 明确仅候选，7 历史兼容目标纠正，8 明示时间约束。

| 案例 | 模型 | 遍 | 任务状态 | 必选覆盖 | 旧状态错误数 | 结果 |
|---|---|---:|---|---:|---:|---|
| v3-actions-1 | DeepSeek Flash | 1 | done | 0/0 | 1 | forget:rejected |
| v3-actions-1 | DeepSeek Flash | 2 | done | 0/0 | 1 | forget:rejected |
| v3-actions-1 | Qwen3.5-27B | 1 | done | 0/0 | 1 | forget:rejected |
| v3-actions-1 | Qwen3.5-27B | 2 | done | 0/0 | 1 | forget:rejected |
| v3-actions-1 | Qwen3.7-Flash | 1 | done | 0/0 | 1 | forget:rejected |
| v3-actions-1 | Qwen3.7-Flash | 2 | failed | 0/0 | 1 | v3 操作字段无效 |
| v3-actions-2 | DeepSeek Flash | 1 | done | 0/0 | 0 | forget:rejected |
| v3-actions-2 | DeepSeek Flash | 2 | failed | 0/0 | 0 | v3 操作字段无效 |
| v3-actions-2 | Qwen3.5-27B | 1 | done | 0/0 | 0 | forget:clarification |
| v3-actions-2 | Qwen3.5-27B | 2 | done | 0/0 | 0 | forget:clarification；forget:clarification |
| v3-actions-2 | Qwen3.7-Flash | 1 | done | 0/0 | 0 | forget:clarification |
| v3-actions-2 | Qwen3.7-Flash | 2 | failed | 0/0 | 0 | v3 操作字段无效 |
| v3-actions-3 | DeepSeek Flash | 1 | done | 0/0 | 0 | update:rejected |
| v3-actions-3 | DeepSeek Flash | 2 | done | 0/0 | 0 | update:rejected |
| v3-actions-3 | Qwen3.5-27B | 1 | done | 0/0 | 0 | skip:skipped |
| v3-actions-3 | Qwen3.5-27B | 2 | done | 0/0 | 0 | skip:skipped |
| v3-actions-3 | Qwen3.7-Flash | 1 | done | 0/0 | 0 | 无操作 |
| v3-actions-3 | Qwen3.7-Flash | 2 | done | 0/0 | 0 | update:rejected |
| v3-actions-4 | DeepSeek Flash | 1 | done | 0/1 | 1 | add:rejected；forget:rejected |
| v3-actions-4 | DeepSeek Flash | 2 | done | 0/1 | 1 | add:rejected；forget:rejected |
| v3-actions-4 | Qwen3.5-27B | 1 | done | 1/1 | 1 | add:applied；forget:rejected |
| v3-actions-4 | Qwen3.5-27B | 2 | done | 1/1 | 1 | add:applied；forget:rejected |
| v3-actions-4 | Qwen3.7-Flash | 1 | pending | 0/1 | 1 | 操作证据范围无效 |
| v3-actions-4 | Qwen3.7-Flash | 2 | failed | 0/1 | 1 | v3 操作字段无效 |
| v3-actions-5 | DeepSeek Flash | 1 | done | 1/1 | 0 | add:applied |
| v3-actions-5 | DeepSeek Flash | 2 | done | 1/1 | 0 | add:applied |
| v3-actions-5 | Qwen3.5-27B | 1 | failed | 0/1 | 0 | v3 操作字段无效 |
| v3-actions-5 | Qwen3.5-27B | 2 | failed | 0/1 | 0 | v3 操作字段无效 |
| v3-actions-5 | Qwen3.7-Flash | 1 | failed | 0/1 | 0 | v3 操作字段无效 |
| v3-actions-5 | Qwen3.7-Flash | 2 | failed | 0/1 | 0 | v3 操作字段无效 |
| v3-actions-6 | DeepSeek Flash | 1 | done | 0/1 | 0 | 无操作 |
| v3-actions-6 | DeepSeek Flash | 2 | done | 0/1 | 0 | 无操作 |
| v3-actions-6 | Qwen3.5-27B | 1 | pending | 0/1 | 0 | 操作证据范围无效 |
| v3-actions-6 | Qwen3.5-27B | 2 | pending | 0/1 | 0 | 操作证据范围无效 |
| v3-actions-6 | Qwen3.7-Flash | 1 | pending | 0/1 | 0 | 操作证据范围无效 |
| v3-actions-6 | Qwen3.7-Flash | 2 | pending | 0/1 | 0 | 操作证据范围无效 |
| v3-actions-7 | DeepSeek Flash | 1 | done | 1/1 | 0 | update:pending |
| v3-actions-7 | DeepSeek Flash | 2 | done | 1/1 | 0 | update:pending |
| v3-actions-7 | Qwen3.5-27B | 1 | done | 0/1 | 0 | update:rejected |
| v3-actions-7 | Qwen3.5-27B | 2 | done | 0/1 | 0 | update:rejected |
| v3-actions-7 | Qwen3.7-Flash | 1 | done | 0/1 | 0 | update:rejected |
| v3-actions-7 | Qwen3.7-Flash | 2 | done | 1/1 | 0 | update:pending |
| v3-actions-8 | DeepSeek Flash | 1 | done | 0/1 | 0 | add:rejected |
| v3-actions-8 | DeepSeek Flash | 2 | done | 0/1 | 0 | add:rejected |
| v3-actions-8 | Qwen3.5-27B | 1 | done | 0/1 | 0 | add:rejected |
| v3-actions-8 | Qwen3.5-27B | 2 | done | 0/1 | 0 | add:rejected |
| v3-actions-8 | Qwen3.7-Flash | 1 | done | 0/1 | 0 | add:rejected |
| v3-actions-8 | Qwen3.7-Flash | 2 | done | 0/1 | 0 | add:rejected |

## 隔离与可复核证据

生产代码、提示词、旧报告及其原始证据指纹保持一致。仅只读访问日用库的 settings 行来确认现用路线，读取已有凭据用于合成调用；没有读取真实聊天、没有迁移日用数据库、没有启动日用配置、没有切换模型或安装，也没有提交或推送。配置、凭据文件与日用 profile 前后指纹一致。

离线完整回归 140/140，新增评分护栏 3/3，源码检查通过。沙箱内两项 SDK 回环连接失败后，在允许本机网络的环境重新运行完整套件通过；没有修改生产代码来绕过失败。此次没有 UI 修改。

可复算入口：`node scripts/score-extraction-v3.mjs score`、`node scripts/report-extraction-v3.mjs`，均不调用模型。`run-extraction-v3.mjs preflight/run` 是付费入口：当前清单已完成时不重发；存在中断或孤立阶段日志时拒绝自动恢复。

文件：`docs/extraction-model-v3-results.json`；`.cache/extraction-evaluation/v3/plan.json`、`live/journal.jsonl`、`live/responses.jsonl`、`reviews.json`、`review-pack.json`、`scored.json`。机器报告记录证据及实现哈希。原始回答留在本地，未对外发布。
