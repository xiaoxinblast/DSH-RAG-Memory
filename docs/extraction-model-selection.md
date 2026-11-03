# 国内提炼模型：准备与验收记录

本文件保留第一轮研究和调用流程。源码修复、v2 数据和保护规则见 [提炼保护修复记录](extraction-refinement-safety.md)；最新的 240 次调用结果见 [v2 小规模筛选报告](extraction-model-pilot-results.md)。三路未通过质量门槛，未继续完整调用或切换日用模型。下文第一轮路径不与 v2 混用；第一轮原始报告和回答保留不变。

日期：2026-11-03（Asia/Hong_Kong）。已完成离线准备和授权后的首轮隔离调用；最新结论及限制见 [首轮结果](extraction-model-results.md)。**当前没有可直接切换的达标型号，继续保留日用配置。**

## 当前结论

首批候选为 `qwen3.7-flash-2026-07-15`、`qwen3.5-35b-a3b`、`qwen3.5-27b` 和现用 `deepseek-account / deepseek-flash`。日用路由通过 SQLite `readOnly: true`、只读 `meta.settings.extractionRoute` 核对。离线阶段未读取真实凭据；授权调用阶段仅在隔离进程内解析现有凭据，未复制或输出密钥，也未读取真实对话。生产源码、日用模型配置、公共接口、数据库格式和 UI 未修改。

四个模型先完成质量验收，再按有账单证据的每条正确有效记忆成本选择。不完整对比、未复核答案、未验证实际参数或缺少实付费用时，工具不会输出最终切换建议。

### 冻结的价格参考

以下是方案查询日的标准在线、无缓存价格快照，单位为人民币／百万 Token，**不是持续更新的报价，也不是账户线路实付账单**。

| 候选 | 输入／输出 | 本轮准备的模式 |
|---|---:|---|
| qwen3.7-flash-2026-07-15 | 0.2／0.8，输入≤32K | 非思考 |
| qwen3.5-35b-a3b | 0.4／3.2，输入≤128K | 非思考 |
| qwen3.5-27b | 0.6／4.8，输入≤128K | 非思考 |
| deepseek-account / deepseek-flash | 官方 API 峰时参考 2／8；谷时 1／4 | 保留实际基线参数 |

参考费率来自[百炼价目表](https://help.aliyun.com/zh/model-studio/model-pricing)和[DeepSeek 价目表](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。报告中的 DeepSeek 参考成本使用峰时价，不能据此宣称账户线路实际扣费。缓存读取按未折扣输入费率估算；出现显式缓存写入、超出所冻结的输入价格档或缺少用量，参考成本记为未知。实际费用独立记录，不用估算值替代。

## 社区证据：只作为试验线索

| 来源 | 可用信息与限制 |
|---|---|
| [Reddit Qwen3.5 抽取测试](https://www.reddit.com/r/LocalLLaMA/comments/1rl1j07/yet_another_post_of_genuinely_impressed_with/)及[原始脚本](https://gist.github.com/divante/9127a5ae30f52f2f93708eaa04c4ea3a) | 27B 抽取综合分 0.99，但仅 6 个英文案例，65% 权重来自 JSON、数量和键名前缀；不是 99% 的事实准确率。 |
| [Reddit 35B-A3B 长文总结经验](https://www.reddit.com/r/LocalLLaMA/comments/1ri39a4/qwen35_35b_a3b_first_small_model_to_not/) | 有正面体验，也有相反评论；本地量化、模板和硬件不能直接代表托管 API。 |
| [Astramem 项目记录](https://github.com/astragenie/astramem-local/issues/434) | 存在 decision 被标成 fact、遗漏与空答案问题；Schema 解决格式不等于解决语义。项目自己的小型测试不能转作本项目成绩。 |
| [Hindsight Retain 评测](https://benchmarks.hindsight.vectorize.io/leaderboard/retain) | 使用 BEAM 长对话子集、固定回答和判分模型；自托管及特定设置不同，不能套用其速度、费用或准确率。 |
| [DeepSeek Flash 批量建忆案例](https://www.reddit.com/r/hermesagent/comments/1wqv98w/giving_hermes_agent_a_longterm_brain_what_seeding/) | 有相关使用案例，未独立复现费用和效果。 |
| [V2EX JSON 讨论](https://v2ex.com/t/1152314)、[LINUX DO 记忆讨论](https://linux.do/t/topic/2207029) | 用于补充格式／语义、写入过宽与重复压缩的失败场景；不把旧帖当作当前接口说明。 |

## 已实现的离线工具

```powershell
node scripts/extraction-evaluation.mjs prepare
node scripts/inspect-extraction-adapter.mjs
npm test
npm run check
```

离线工具的 `prepare` 和 `review` 不发网络请求；适配检查只连接自己在 `127.0.0.1` 创建的模拟端点。付费采集独立放在 `scripts/run-extraction-evaluation.mjs`，不能因运行测试或准备清单而意外触发。

当前 v2 采集器的付费命令如下，仅在对应范围得到授权后运行；本次筛选已完成，因质量不达标停止，不继续完整 `run`：

```powershell
node scripts/run-extraction-evaluation.mjs preflight
node scripts/run-extraction-evaluation.mjs pilot
node scripts/run-extraction-evaluation.mjs run
```

当前固定三候选、最多四并发，本轮上限 ¥3，计入首轮后累计不超过 ¥10，只发送冻结清单中的合成文本。`preflight` 收集每路下一个未完成的筛选任务；`pilot` 限定 40 个开发案例 × 三路 × 两遍，共 240 次，不调用独立验收案例；`run` 指向完整 1,152 个任务，不是本次筛选的自动后续步骤。调用前冻结 `pilot-plan.json`，重启时范围不符拒绝继续。

日志在发起前 fsync，恢复不重复已有任务；存在开始但无完成记录时停止自动恢复。预算对成功且有供应商用量的请求采用官方峰值无缓存参考价的两倍，失败／缺失用量的已发送请求按 UTF-8 字节输入上界和完整输出配额预留。SDK 的零占位用量不作为失败请求零扣费的证明。这是保守预算核算，不是钱包硬限额或实际账单。

### 第一轮数据集和冻结清单（历史记录）

- 160 个合成案例：8 类各 20 个，由 **40 种语义模式 × 4 个项目场景**展开。个别全局规则与寒暄控制例故意重复；不宣称是 160 种独立语义模式。
- 类别为否定／条件、计划／完成、来源角色、作用域、旧记忆纠正、重复／指代、遗忘、无价值内容／凭据。
- 每例保存原始合成来源、旧记录、金标原子事实和人工评分说明；来源带稳定 ID。工具复用生产宿主的旧记忆选择与预算，其他项目和 forgotten 内容不会送给模型。
- 4 个模型 × 160 例 × 2 遍，共 **1,280 个待执行请求**。每次 2,048 输出上限、90 秒超时、temperature 0，不带聊天历史、工具或金标。
- `suite.json` 冻结数据、提示词、生产实现、评分脚本指纹与 Node 版本。重跑准备可复现；导入时拒绝修改后的清单、重复任务、未知任务及错误指纹。
- Qwen 的 DSH provider 保持 `null`，**没有猜测或自动创建账户路由**；后续采集必须在隔离 DSH 中明确绑定正确 provider。基线 provider 已固定。

默认输出在 `.cache/extraction-evaluation/prepare/`：

- `suite.json`：冻结清单及任务。
- `requests.jsonl`：待采集请求；不含金标。它是评估任务格式，不是可直接 POST 的供应商请求体。
- `report.json`、`report.md`：所有型号当前均为 `NOT_RUN`，决策为 `AWAITING_AUTHORIZED_MODEL_RUNS`。

### 真正的宿主回放

评分时使用临时 `MemoryService`，调用生产的提炼任务处理函数，不复制生产的入库规则，也不启动后台定时器。每条回答只做一次处理；失败后不运行重试队列。

覆盖来源检查、批次回滚、作用域、明确纠正、提炼期间并发版本变化和 tombstone。遗忘控制另验证同内容、同旧来源、重开数据库、过期向量和关键词检索。重开数据库的案例使用工具自己创建的临时目录，其余使用内存数据库；完成后清理本次创建的临时目录。

测试中的“金标控制组”直接使用已知正确答案验证评估流程，**不是任何模型的回答，也不是独立的模型准确率测试**。

### 真实 SDK 回环检查结果

本机检查使用 `@deepseek-ai/dsh-llm-pi-ai@0.2.1-rc.5`、真实 `LlmRuntime`、真实协议实现和原始 `createDshExtractor`。没有加载日用 profile，也没有使用真实 API Key。

| 合成 profile | 选定控件 | 实际 `enable_thinking` | `response_format` | 输出上限／消息／工具 |
|---|---|---|---|---|
| 默认 compat | off | 未发送 | 未发送 | 2048／2 条／无 |
| thinkingFormat: qwen，supportsDeveloperRole: false | off | false | 未发送 | 2048／2 条／无 |

这只证明安装版本对两种合成 profile 的发包行为，不证明日用账户路由或供应商执行了非思考模式。后续必须检查实际测试路由。当前提炼协议没有请求 Schema；首轮也不静默加入，以保持公平。

原始记录及 SDK／协议文件 hash 在 `.cache/extraction-evaluation/adapter/report.json`。新测试会在缺少可选 pi-ai 适配器时明确跳过，不能将跳过解释为适配检查通过；本机本轮没有跳过。受限环境若禁止本机回环连接，需要允许该回环测试，不应改为访问供应商。

## 后续回答导入和人工复核

**首轮真实采集已完成。** 原始日志、首次回答和实际参数在 `.cache/extraction-evaluation/live/`；320 个任务／型号全部保留。接入调试失败也未重放或删除，不能把本轮当成无接入故障的干净排行榜。后续新增付费轮次仍需另行确定范围。只使用合成文本，不可把日用记忆库当评估库。

每条回答 JSONL 的最小示意如下。`taskId` 和 `manifestId` 从冻结清单取得；参数和费用未知时留空，不填写“推测已验证”。

```json
{
  "manifestId": "冻结清单 manifest.id",
  "taskId": "请求中的 id",
  "finish": "stop",
  "text": "{\"memories\":[]}",
  "latencyMs": 1200,
  "usage": {
    "inputTokens": 2000,
    "outputTokens": 120,
    "cacheReadTokens": 0,
    "cacheWriteTokens": 0
  },
  "effective": {
    "provider": "实际隔离测试路由",
    "model": "qwen3.7-flash-2026-07-15",
    "temperature": 0,
    "maxTokens": 2048,
    "timeoutMs": 90000,
    "transportAttempts": 1,
    "thinking": "off",
    "wireVerified": false
  }
}
```

- `finish` 支持 `stop`、`length`、`error`、`timeout`、`aborted`、`empty`；无效 JSON、空内容和截断都保留为首次失败，合法 `{"memories":[]}` 与空内容严格区分。
- `usage` 遵循 DSH 归一化：input 不包含 cacheRead/cacheWrite；output 已包含由适配器折入的思考 Token，不能再加一次 reasoning。若能单独核实思考量，可增加 `reasoningTokens`；否则省略，报告显示未知。
- Qwen 必须有实际发包证据后才能将 `wireVerified` 设为 true。基线需保留真实设置，并在核查后增加 `baselinePreserved: true`。多于一次传输或参数不符不算完成公平验收。
- 实付费用需由账单核对后增加 `actualCostCny`、`actualCostVerified: true` 和非空 `billingEvidence`（脱敏账单编号或证据 hash）。工具校验字段，不自行访问／核验账户账单；这是可信操作人的复核声明。
- 回答的参数与计量元数据由采集者提供；导入工具不能独立证明它们来自真实模型。不得将单测、金标或伪造结果标成真实采集。

先导入，得到不含模型标签、按任务 hash 打乱的人工复核模板：

```powershell
node scripts/extraction-evaluation.mjs review --suite .cache/extraction-evaluation/prepare/suite.json --responses .cache/extraction-evaluation/responses.jsonl --out .cache/extraction-evaluation/review
```

复制 `review-template.jsonl` 为 `human-review.jsonl`。逐项核对来源、条件、时间、否定与每个原子事实，填写：

- `judgments[].supported`：整条内容是否被给定来源支持，包括额外断言。
- `conditionsPreserved`：限定条件是否完整。
- `coveredFactIds`：确实覆盖的金标事实 ID，不能只因出现相同关键词就勾选。
- `confirmed: true`：已完成该任务的人工语义复核；空数组也需要确认。

仅修改复核判断和 notes，不改 sources、existing、expected 或 memories。输出指纹变化、来源／金标被改、漏评条目、未知事实 ID 均被拒绝。模型返回两条相同记忆不能重复计入正确数或降低每条有效记忆成本。

重新评分时另选输出目录，不覆盖人工填写文件：

```powershell
node scripts/extraction-evaluation.mjs review --suite .cache/extraction-evaluation/prepare/suite.json --responses .cache/extraction-evaluation/responses.jsonl --reviews .cache/extraction-evaluation/human-review.jsonl --out .cache/extraction-evaluation/scored
```

验收门槛：事实精确率≥98%，关键事实召回≥90%，首次结构成功率≥99%；错误覆盖、项目泄漏和遗忘复活为 0。报告保留分类计数、两遍差异、P50/P95、缺失用量、参考费与实付费。未复核数据不进入语义准确率分母，状态仍为未完成；不能用部分高分获得最终推荐。金标有遗漏或争议时，应修订版本并重建整个清单，不单独改某个模型答案的评分标准。

## 边界与下一步

本轮已完成离线准备、宿主控制回放、SDK 回环、1,280 个任务首次结果采集和独立语义复核。复核由本次 Codex 助手完成，未调用候选模型判分，**未经过人类第二次审阅**；完整口径与限制见首轮结果。最终模型胜出、日用切换、提交与推送未执行。

若候选均未达标，保留现用配置并处理暴露出的提炼问题。若有候选达标但缺少可靠实付费用，先出质量结论，暂不以参考价自动确定赢家。后续切换与回退仍单独确认。
