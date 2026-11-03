import { extractionCases as regression } from "./extraction-cases-v5.mjs";
export const DATASET_VERSION = "zh-extraction-6-state-and-item-isolation-120";
// New cases written after production implementation and offline regression; frozen before paid calls.
const inputs = [
  ["ambiguous-plan", ["候选是启动清理任务或压缩任务，先启动哪个我还没想好。"], [{ content: "清理任务和压缩任务先启动哪个尚未决定。", optional: true }], "decision", "project", "pending"],
  ["ambiguous-plan", ["已经决定周二迁移备份，是否更换日志引擎仍在讨论。"], ["已决定周二迁移备份。"], "decision"],
  ["causality", ["服务在切换 DNS 后中断，先后顺序已确认，但因果关系尚未确认。"], ["服务在切换 DNS 后中断，因果关系尚未确认。"]],
  ["causality", ["已确认：证书过期，因此同步失败。"], ["证书过期导致同步失败。"]],
  ["completion", ["已允许执行归档，但归档尚未开始。"], ["归档已获授权，但尚未开始。"], "progress"],
  ["completion", ["前端构建已完成；后端构建仍未完成。"], ["前端构建已完成。", "后端构建尚未完成。"], "progress"],
  ["roles", [{ role: "assistant", text: "数据导出已完成。" }, { role: "user", text: "我只同意准备导出，没有允许执行，工具也没有运行。" }], ["数据导出尚未获执行授权，工具没有运行。"], "progress"],
  ["candidate", ["长期全局规则：所有项目的备份保留十天。请仅存候选，待我确认。"], ["所有项目的备份保留十天。"], "rule", "global", "pending"],
];
const fresh = inputs.map(([category, texts, facts, kind = "fact", scope = "project", status = "active"], i) => {
  const id = `fresh-v6-${i + 1}`, sources = texts.map((s, j) => ({ ...(typeof s === "string" ? { text: s, role: "user" } : s), id: `${id}:source:${j}`, session_id: `${id}:session` }));
  return { id, category, split: "fresh-holdout", workspace: `D:/synthetic-extraction/v6/${category}`, foreignWorkspace: "D:/synthetic-extraction/v6/other", sources, existing: [], expected: facts.map((fact,j) => ({ id: `${id}:fact:${j}`, ...(typeof fact === "string" ? { content: fact } : fact), kind, scope, status, evidence: sources.map(s => s.id), targetId: null })), expectedOldStatus: {}, rubric: "沿用原始事实、状态及作用域标准；有明确未决对象的计划不得激活，先后关系不等于因果，授权不等于执行。" };
});
export const extractionCases = [...regression.map(f => ({ ...structuredClone(f), split: "regression" })), ...fresh];
