import { resolve, join } from "node:path";
import { MemoryService } from "../src/service.mjs";
const home = resolve(process.env.DSH_HOME ?? "");
if (!home.includes(`${process.platform === "win32" ? "\\" : "/"}.cache${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("仅允许向 .cache 中的隔离 DSH_HOME 写入合成数据");
const service = new MemoryService({ filename: join(home, "storages", "dsh-memory", "memory.sqlite") });
const samples = [
  ["preference", "global", "默认使用简体中文沟通，命令、代码和配置键保持原文。"],
  ["rule", "global", "修改界面后，先通过真实截图检查视觉效果，再交付。"],
  ["decision", "project", "记忆数据库保存在本机，只有必要文本发送给 Qwen API。"],
  ["progress", "project", "存储与来源追溯已完成；真实语义召回验收等待配置 API Key。"],
  ["fact", "project", "当前适配的 DSH 版本为 0.2.1-rc.5。"],
  ["decision", "project", "每月 10 元作为费用提醒目标，达到后继续云端调用。"],
  ["progress", "project", "首版从新对话开始，不扫描历史聊天，旧记忆库继续保留。"],
  ["fact", "project", "项目事实按规范化工作区路径隔离，个人偏好供各项目共享。"]
];
for (const [kind, scope, content] of samples) service.manual({ kind, scope, content }, { workspace: "D:/Projects/记忆插件", sessionId: "synthetic-ui-acceptance" });
service.manual({ kind: "decision", scope: "project", content: "本项目交付格式为带修订记录的 Word 文档。" }, { workspace: "D:/Projects/本地化工作台", sessionId: "synthetic-ui-acceptance" });
await service.close(); console.log("Seeded isolated synthetic memories");
