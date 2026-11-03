import { extractionCases as v2 } from "./extraction-cases-v2.mjs";

export const DATASET_VERSION = "zh-extraction-3-live-80";
// Freeze new gold before any v3 paid request. Never rewrite the v1/v2 evidence.
const inherited = structuredClone(v2.filter((f) => f.split === "holdout" || /^[^-]+-1-/.test(f.id))).map((f) => {
  f.rubric = "按原始来源逐条检查事实、限定条件、角色、范围和操作意图。v3 明确纠正及长期全局要求经独立复核可自动生效；明确要求候选时不能自动激活。";
  f.expected = f.expected.map((e) => ({ ...e, status: e.scope === "global" || e.explicitCorrection ? "active" : e.status }));
  f.expectedOldStatus = Object.fromEntries(f.existing.map((old) => [old.id, old.status]));
  for (const e of f.expected.filter((e) => e.explicitCorrection && e.targetId)) f.expectedOldStatus[e.targetId] = "superseded";
  if (f.concurrentUpdate) {
    f.expected.forEach((e) => { e.status = "pending"; });
    f.expectedOldStatus[f.existing[0].id] = "active";
  }
  if (f.id === "holdout-scope-2") f.expected.forEach((e) => { e.status = "pending"; });
  if (f.id === "holdout-roles-1") f.expected.forEach((e) => { e.evidence = [f.sources[1].id]; });
  if (f.id === "roles-1-4") { f.expected[0].evidence = [f.sources[0].id]; f.expected[1].evidence = [f.sources[2].id]; }
  if (f.id === "reference-1-4" || f.id === "holdout-reference-3") {
    const content = f.id.startsWith("holdout") ? "客户端和网关都需要调整超时，但先改哪个尚未确定。" : "两个组件都需要检查，但具体修改对象尚未确定。";
    f.expected.push({ id: `${f.id}:optional-work`, content, kind: "progress", scope: "project", status: "pending", evidence: f.sources.map((s) => s.id), targetId: null, optional: true });
  }
  return f;
});

function extra(n, texts, expected, old = [], extraFields = {}) {
  const id = `v3-actions-${n}`, sources = texts.map((text, i) => ({ id: `${id}:source:${i}`, session_id: `${id}:session`, role: "user", text }));
  const existing = old.map((o, i) => ({ id: `${id}:existing:${i}`, key: `old${i}`, sourceId: `${id}:seed:${i}`, kind: "fact", scope: "project", status: "active", ...o }));
  return { id, category: "actions", split: "v3-extension", domain: "合成 v3 操作", workspace: "D:/synthetic-extraction/v3-actions", foreignWorkspace: "D:/synthetic-extraction/v3-other", sources, existing, expected: expected.map((e, i) => ({ id: `${id}:fact:${i}`, kind: "fact", scope: "project", status: "active", evidence: [sources.at(-1).id], targetId: null, ...e })), expectedOldStatus: Object.fromEntries(existing.map((o) => [o.id, o.status])), rubric: "核对事实与来源，并独立核对遗忘、重新记住和候选授权；允许语义等价的合并或拆分。", ...extraFields };
}
const extensions = [
  extra(1, ["请忘掉这条旧记忆：邮件索引使用 SQLite。"], [], [{ content: "邮件索引使用 SQLite。" }]),
  extra(2, ["忘掉那个端口配置，我还没说是 API 还是管理端口。"], [], [{ content: "API 端口为 8123。" }, { content: "管理端口为 8124。" }]),
  extra(3, ["不要忘掉邮件索引使用 SQLite 这条记忆。它仍然有效。"], [], [{ content: "邮件索引使用 SQLite。" }]),
  extra(4, ["请忘掉这条旧记忆：邮件索引使用 SQLite。另一个新事实：导出格式固定为 NDJSON。"], [{ content: "导出格式为 NDJSON。" }], [{ content: "邮件索引使用 SQLite。" }]),
  extra(5, ["我现在明确授权重新记住这个具体事实：邮件索引使用 SQLite。"], [{ content: "邮件索引使用 SQLite。" }], [{ content: "邮件索引使用 SQLite。", status: "forgotten", attributes: { subject: "邮件索引", facet: "存储后端" } }]),
  extra(6, ["这是我的长期个人偏好，适用于所有项目：回复先给结论。请只保存为候选，暂不生效。"], [{ content: "所有项目回复先给结论。", kind: "preference", scope: "global", status: "pending" }]),
  extra(7, ["纠正旧记忆：邮件索引现在改为 PostgreSQL，SQLite 已停用。"], [{ content: "邮件索引使用 PostgreSQL，SQLite 已停用。", status: "pending", targetId: "v3-actions-7:existing:0" }], [{ content: "邮件索引使用 SQLite。", attributes: { legacy: true } }]),
  extra(8, ["本项目维护窗口从 2026-11-10 起生效，截止 2026-11-12；只有这三天允许部署。"], [{ content: "本项目仅在 2026-11-10 至 2026-11-12 的维护窗口允许部署。", kind: "rule" }]),
];
for (const n of [1, 4]) extensions[n - 1].expectedOldStatus[extensions[n - 1].existing[0].id] = "forgotten";
export const extractionCases = [...inherited, ...extensions];
