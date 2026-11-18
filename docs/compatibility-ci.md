# DSH 兼容范围与 Windows 冒烟测试

宿主和所有 DSH peers 使用同一有界范围：`>=0.2.2-rc.2 <0.2.3-0`。下界保留已实测的 rc.2；rc.3 使用同一个插件包验证。范围包含后续 `0.2.2` RC 和正式版，但不表示这些未来版本都已实测。`0.2.3-0`、`0.2.3-rc.1` 及更高版本均不在声明内。没有版本豁免、自动改范围或自动发布。

## 工作流

`.github/workflows/dsh-compatibility.yml` 每天 07:23 UTC 检查一次，也可在 Actions 页面手动运行：

- `version` 填精确版本（例如 `0.2.2-rc.3`，也接受 `dsh-v` 前缀），或留空。
- 留空时分页调用官方 `deepseek-ai/deepseek-harness` 的 **List releases**，忽略草稿和其他产品标签，再按 SemVer 选择最高的 RC 或正式版；不用 `/latest`，不依赖本仓库的 release 事件。
- 对同一插件提交 SHA，查询该工作流已完成的 `Windows smoke (<版本>)` 任务；成功、失败及取消都算一次尝试。工作流并发组将选择和测试串行化，避免定时与手动运行同时重复。无需可被淘汰的缓存标记。
- 若需要重试已完成的尝试，手动勾选 `retry`。新插件提交会重新测试。若人工删除运行历史，对应查重记录也会消失。
- 范围外版本在选择阶段报 `needs-validation` 并使工作流失败，记录上游版本和插件 SHA；不安装、不激活、不创建豁免。必须另行修改并验证插件才能放行。

每次测试的 Summary 和 artifact 都记录版本、插件 SHA 和结果。SDK 尚未发布到 npm、安装/激活失败或功能断言失败都会使 Windows job 失败，不能当作兼容通过。依赖下载失败同样保留失败任务，可人工重试。

## 实际执行内容

`scripts/ci/windows-smoke.ps1` 先构建并 `npm pack --offline --ignore-scripts`，再在 `.cache/compatibility/<版本>/install` 中通过普通 npm 解析安装这个 tarball 和精确版本的官方宿主 SDK。所有直接 DSH peers 都作为该隔离安装的显式精确依赖；不使用 `--force`、`--legacy-peer-deps` 或 DSH 兼容豁免。激活前逐项检查实际解析到的 peer 版本，防止 npm 静默选用另一宿主版本。

`scripts/ci/packed-smoke.mjs` 用真实官方 boot/Loader、SystemPrompt、Tools、Session、LLM 和 Typert 服务加载**安装后的包**，而不是直接调用源码的 apply。实际的 profile 预检必须接受该包，然后验证：

- 插件确实激活，注册 6 个工具及远程服务；浏览器构建入口存在且包名一致。
- 通过远程服务保存、读取及本地搜索合成记忆，项目范围隔离。
- 真实 Session 批量事件捕获、Agent 前置步骤的记忆召回。
- 关闭、重启、SQLite 持久化和遗忘后不再检索。

测试创建独立 `DSH_HOME` 和 `DSH_AGENTS_HOME`，只提供空的合成凭据服务，不注册模型适配器。运行阶段加载现有外网防护，任何外网请求都会失败；安装阶段只从 npm 获取官方 SDK。不会读取真实项目、聊天、邮件或用户凭据，不连接日用 DSH，不部署插件，不发布 GitHub Release。

这是 Windows 上真实宿主服务的隔离集成测试，不是完整桌面窗口/所有宿主插件的端到端测试，也不测真实模型的语义准确率。它不能证明范围内所有未来版本永远没有回归。

## 固定环境与权限

- GitHub 托管 `windows-2022`；Node `24.21.0`、npm `11.12.1`。
- checkout、setup-node、upload-artifact 固定到已核对的完整官方提交 SHA，checkout 不保存 Git 凭据。
- 根目录开发依赖用提交的 `package-lock.json` 和 `npm ci --ignore-scripts`；SemVer 库固定 `7.8.5`。
- 官方 SDK 的直接包固定到所选 release 的精确版本；其上游声明的传递依赖按 npm 正常解析，完整解析锁文件随 artifact 保存，便于追查依赖漂移。它不是官方桌面安装包的逐字节镜像。
- 工作流只有 `contents: read`、`actions: read`；GitHub API token 仅传给选择步骤。无需仓库写入、issue/PR 权限、外部密钥或云模型凭据。

artifact 包括插件 tarball、pack 清单、实际安装锁文件、运行结果和外网请求日志，不上传数据库或浏览器资料。保留期 30 天；查重依据运行元数据，不依赖 artifact 的保留期。

## 本地运行

先安装锁定的开发工具，再从仓库根目录使用 PowerShell：

```powershell
npm ci --ignore-scripts --no-audit --no-fund
./scripts/ci/windows-smoke.ps1 -Version 0.2.2-rc.3
```

若复用独立的开发依赖，可设置 `DSH_DEV_MODULES`；已有 `DSH_SDK_MODULES` 会被脚本替换为本次隔离安装的 SDK。测试不会改动原 SDK 或日用 profile。旧 v7 历史回归依赖本地冻结证据，未把这些历史文件复制进 CI；新工作流运行可从干净 checkout 重建的打包冒烟测试。

## 复用到 Kami 与 Mail

可复用工作流、`contracts.mjs`、`dsh-release.mjs` 和 Windows 驱动的结构；各仓库保留自己的 SemVer 范围和 SDK 依赖列表，不照抄本插件的支持下界。

`packed-smoke.mjs` 是本插件的适配部分：Kami 应替换为其实际服务、必要的合成文档操作及清理；Mail 应替换为其服务和本地合成邮件操作，禁用真实邮箱连接、发送及真实凭据。每个插件均须用自己的同一 tarball 验证所声称的最低版本与当前版本，不能只复制放宽后的声明。
