import { createHash } from "node:crypto";
import { resolve, win32 } from "node:path";

export const KINDS = ["preference", "rule", "decision", "fact", "progress"];
export const hash = (text) => createHash("sha256").update(text).digest("hex");
export const normalize = (text) => String(text).normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
export function validityTime(value, endOfDay = false) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value !== "string") return NaN;
  const date = value.slice(0, 10), day = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(+day) || day.toISOString().slice(0, 10) !== date) return NaN;
  if (value.length === 10) {
    return Date.parse(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+08:00`);
  }
  return /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
}
export function projectId(workspace) {
  if (typeof workspace !== "string" || !workspace.trim()) throw new Error("缺少工作区路径");
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(workspace);
  return (windows ? win32.resolve(workspace).replaceAll("\\", "/").toLowerCase() : resolve(workspace)).replace(/\/$/, "");
}
// A byte upper bound, deliberately conservative for text token budgets. Provider usage is authoritative.
export const tokens = (text) => Buffer.byteLength(String(text), "utf8");
export function bounded(text, budget) {
  let result = "";
  for (const cp of String(text)) { if (tokens(result) + tokens(cp) > budget) break; result += cp; }
  return result;
}
export function terms(text) {
  const normalized = normalize(text);
  const words = normalized.match(/[\p{L}\p{N}_./:\\-]+/gu) ?? [];
  const cjk = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? [];
  for (const word of cjk) { const chars = [...word]; for (let i = 0; i < chars.length - 1; i++) words.push(chars[i] + chars[i + 1]); }
  return [...new Set(words)].filter((x) => x.length > 1);
}
export function lexicalScore(query, content) {
  return scoreTerms(terms(query), normalize(content));
}
export function scoreTerms(queryTerms, normalizedText) {
  const hits = queryTerms.filter((t) => normalizedText.includes(t));
  return queryTerms.length ? hits.length / queryTerms.length : 0;
}
export function cosine(a, b) {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
export const DEFAULTS = Object.freeze({ enabled: true, cloudPaused: false, credentialRef: "DSH_MEMORY_API_KEY", workspaceId: "", excludedWorkspaces: [], monthlyTarget: 10, extractionRoute: null, embeddingModel: "text-embedding-v4", rerankModel: "qwen3-rerank" });
export function validateSettings(input) {
  const v = { ...DEFAULTS, ...input };
  if (typeof v.enabled !== "boolean" || typeof v.cloudPaused !== "boolean") throw new Error("开关必须是布尔值");
  if (!/^[A-Z_][A-Z0-9_]*$/.test(v.credentialRef)) throw new Error("API Key 保存名称只能使用大写字母、数字和下划线，且不能以数字开头。建议填写 DSH_MEMORY_API_KEY，请勿填写网址。");
  if (v.workspaceId && !/^[a-zA-Z0-9_-]+$/.test(v.workspaceId)) throw new Error("业务空间 ID 格式无效");
  if (!Number.isFinite(v.monthlyTarget) || v.monthlyTarget <= 0) throw new Error("提醒金额必须大于 0");
  if (!Array.isArray(v.excludedWorkspaces) || v.excludedWorkspaces.some((p) => typeof p !== "string" || !p.trim())) throw new Error("排除工作区必须是路径列表");
  for (const field of ["embeddingModel", "rerankModel"]) if (typeof v[field] !== "string" || !v[field].trim()) throw new Error("模型名称不能为空");
  if (v.extractionRoute !== null) {
    if (!v.extractionRoute || ["provider", "model"].some((k) => typeof v.extractionRoute[k] !== "string" || !v.extractionRoute[k].trim())) throw new Error("请选择完整的 DSH 提炼模型");
    v.extractionRoute = { provider: v.extractionRoute.provider, model: v.extractionRoute.model };
  }
  return Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, v[k]]));
}
export function validateMemory(input) {
  if (!KINDS.includes(input.kind)) throw new Error("无效的记忆类型");
  if (!["global", "project"].includes(input.scope)) throw new Error("无效的记忆范围");
  if (input.scope === "global" && !["preference", "rule"].includes(input.kind)) throw new Error("只有个人偏好和全局规则可以共享");
  if (input.scope === "project" && !input.projectId) throw new Error("项目记忆必须绑定工作区");
  if (typeof input.content !== "string" || !input.content.trim() || tokens(input.content) > 6000) throw new Error("记忆内容为空或过长");
  return { ...input, content: input.content.trim(), projectId: input.scope === "global" ? null : projectId(input.projectId) };
}
