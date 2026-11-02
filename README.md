# DSH-RAG-Memory

本地优先的 DSH 独立记忆插件。个人偏好与全局规则共享，项目事实按工作区路径隔离。首版只接管启用后到达的新文本对话，不扫描历史聊天，不读取或迁移喵记忆数据库。

## 当前状态

版本 `0.1.2`，适配 DSH `0.2.1-rc.5`、Node.js `>=24.2`。本地逻辑、DSH SDK 接入及隔离 Host 界面已有验收脚本。真实 Qwen 向量与精排已用固定 60 例完成验收；DSH 提炼的模型选择、独立输入、审计及恢复通过 51 项自动化测试；隔离 Host 已实际调用所选 DeepSeek 账号 Flash，设置页与模型选择器已截图验收。日用启用状态另见交付验收记录。本地关键词基线不等于云端语义验收。

## 使用方式

插件启用后，左侧“记忆”提供记忆库、处理队列、用量与费用、连接设置。记忆可以搜索、查看来源、纠正、确认候选或遗忘。对话中的召回显示为可展开记忆卡片，历史卡片在重启后可恢复。遗忘立即移出检索并清除向量；本地修订记录仍会保留，不代表物理擦除全部历史数据。

自动整理在 4 轮对话完成，或有未处理片段且会话空闲 2 分钟后运行。每次只处理新的片段，输入使用 UTF-8 字节数作为保守 Token 预算，上限 8000。来源较长时按片段处理，不代表全文导入。助手自述与失败工具结果不能独自支持已验证事实。

新会话首轮及每条用户消息进行一次召回。SQLite FTS5 关键词检索与本地向量检索融合，最多精排 8 条、注入 5 条，注入正文使用不超过 1500 的保守 Token 预算。实际 Token 数以模型用量为准。云端总等待上限 2 秒，超时回退本地检索；过低的网络响应速度会降低语义链路使用率。

## 配置 Qwen

1. 打开 [阿里云百炼控制台](https://bailian.console.aliyun.com/)，选择华北 2（北京）。
2. 按 [API Key 官方说明](https://help.aliyun.com/zh/model-studio/get-api-key)开通服务并创建 Key。
3. 取得同一业务空间的 [Workspace ID](https://help.aliyun.cn/zh/model-studio/obtain-the-app-id-and-workspace-id)。
4. 在插件“连接设置”填入 Workspace ID；“API Key 保存名称”保留默认 `DSH_MEMORY_API_KEY`。它是 DSH 保存和读取 Key 时使用的名称（凭据引用），只接受大写字母、数字和下划线，不能以数字开头；留空保存会恢复默认值，请勿填写网址。Key 只填写到密码框，点击“保存连接”。随后点击“测试连接”（会产生少量模型费用）；进行中、成功或失败的反馈显示在按钮下方。API Key 留空时沿用此名称下已有的 Key。

提炼通过 DSH 原生 `ctx.llm.prepareCall/stream`，使用插件设置中单独选定的 DSH 提供商、模型与其凭据；独立发送受长度限制的新片段，不附带主聊天历史和工具。在“连接设置 → DSH 提炼模型”中选择并保存，不跟随聊天模型；未选择或模型不可用时保留队列，不自动回退到其他模型。默认向量 `text-embedding-v4`（1024 维）、精排 `qwen3-rerank`。Endpoint 由 Workspace ID 和固定北京地域域名拼接，禁止重定向凭据到其他主机。

Key 由 `ctx.credentials` 保存；普通设置与数据库不保存 Key。凭据服务不能提供针对同一操作系统用户的绝对隔离。发送前会遮蔽常见凭据格式，但不应主动要求记忆保存任何密码、验证码或密钥。

## 存储和费用

数据库：`$DSH_HOME/storages/dsh-memory/memory.sqlite`。与源码、DSH 程序目录、旧 `.dsh-meow` 分开。保留来源片段、修订、向量、任务和用量；后台任务使用两分钟租约避免多个读取器重新执行正在运行的任务。崩溃后租约到期可继续，不会重复导入旧聊天。

Qwen 向量和精排的每月提醒目标默认 10 元（香港时区自然月），达到后继续运行。费用按固定模型标价估算：[官方模型价格](https://help.aliyun.com/zh/model-studio/model-pricing)，2026-11-02 核查。向量和精排各为 0.5 元/百万输入 Token。DSH 提炼另记 provider/model、输入输出 Token 和本地请求审计，不编造主模型单价；其费用不计入 Qwen 提醒金额。精排预算包括查询文本随候选重复计入的部分。响应缺失 `usage` 或超时时保留估算标记，真实账单以百炼为准。免费额度不纳入价格估算。

主模型新增上下文单独计数。本页统计新注入的保守预算，不能精确反映后续上下文重放、缓存折扣和不同主模型的全部账单。

## 开发与验证

```powershell
npm install
npm run build
npm test
npm run test:ui
npm run check
npm run evaluate
```

开发环境需要同版本的 DSH peer 包。可使用 DSH 源码/SDK的 `node_modules`；不要复制旧插件数据到测试目录。若复用已有开发依赖，设置 `DSH_DEV_MODULES` 为包含 `esbuild`、`@playwright/test`、`react` 和 `react-dom` 的 `node_modules` 绝对路径。

`npm run test:ui` 使用无界面 Edge 渲染实际设置组件和内存数据库，验证独立保存、凭据名称校验、未保存配置提示、测试进行中及成功/失败反馈，并生成明暗主题和不同宽度的截图至 `.cache/settings-ui/`。它只使用合成凭据和模拟响应，不访问真实模型服务。

`npm run evaluate` 执行固定的 60 例本地关键词基线。真实语义评估：

```powershell
# 推荐先在隔离 Host 的连接设置中保存凭据，然后从同一 DSH_HOME 读取；Key 不回显。
node scripts/evaluate.mjs --live --home "<隔离 DSH_HOME>"
```

也可在本次进程环境中提供 `DSH_MEMORY_API_KEY`、`DSH_MEMORY_WORKSPACE_ID` 后运行 `node scripts/evaluate.mjs --live`，不要把 Key 写入脚本、命令历史或报告。真实评估会上传固定的合成样例并按量计费，不包含个人聊天。

隔离 Host 使用 `.cache/home`，仅在该隔离环境运行 `scripts/seed-demo.mjs`。启动后运行 `node scripts/verify-ui.mjs "<完整回环URL>"` 检查实际操作、明暗主题、1180/768/390 像素容器布局与截图。验收报告保存在 `.cache/`，不进入发布包。

## 安装与日用切换

在真实语义验收通过前保持旧喵记忆日用配置。源码构建完成后运行 `npm pack --ignore-scripts` 得到本地包；包内不包含数据库、凭据、测试浏览器资料和 `.cache`。

插件显示名称为 `DSH-RAG-Memory`，安装包名为 `dsh-rag-memory`。从旧包 `dsh-memory` 切换时，先停用旧包，再安装并启用新包，避免两份插件同时运行。原有 `$DSH_HOME/storages/dsh-memory/memory.sqlite`、`DSH_MEMORY_API_KEY` 凭据名称及 `dsh_memory_*` 工具接口继续沿用，无须搬移记忆数据。

通过验收后，完全退出 DSH（包含托盘进程），备份日用 profile 的 `package.json`、`pnpm-lock.yaml`、`cordis.patch.yml` 和所有旧记忆库。SQLite 应使用一致性备份并检查完整性，不直接复制正在写入的主文件。

使用 DSH 官方插件管理器安装本地包并先保持停用，随后停用 `meow-memory` 组合包、启用 `dsh-rag-memory`，重启检查。两套插件不要同时自动记录和注入。不要卸载或删除旧插件及其数据。

需要回退时退出 DSH，恢复 profile 备份或停用 `dsh-rag-memory`、重新启用 `meow-memory`，然后重启。新记忆库保留在自己的存储目录，不覆盖旧库。

## 工具

`dsh_memory_search`、`dsh_memory_read`、`dsh_memory_remember`、`dsh_memory_update`、`dsh_memory_forget`。手动写入仍保留来源。跨项目搜索必须由用户明确指定目标项目；自动召回不会搜索其他项目。


