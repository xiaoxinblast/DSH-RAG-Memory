import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
export const hash = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
export const CANDIDATES = [
  { id: "qwen-flash", model: "qwen3.7-flash-2026-07-15", provider: "evaluation-qwen-beijing", input: .2, output: .8, inputLimit: 32000 },
  { id: "qwen-27b", model: "qwen3.5-27b", provider: "evaluation-qwen-beijing", input: .6, output: 4.8, inputLimit: 128000 },
  { id: "deepseek-baseline", model: "deepseek-flash", provider: "deepseek-account", input: 2, output: 8, inputLimit: 1000000 },
];
const rates = [...CANDIDATES, { model: "qwen3.5-35b-a3b", input: .4, output: 3.2, inputLimit: 128000 }];
export function metered(phase) {
  const u = phase?.usage;
  return phase?.httpStatus === 200 && ["stop", "length"].includes(phase.finish) && u && ["inputTokens", "outputTokens"].every(k => Number.isFinite(u[k]) && u[k] >= 0) && ["cacheReadTokens", "cacheWriteTokens"].every(k => u[k] === undefined || Number.isFinite(u[k]) && u[k] >= 0) && u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) > 0;
}
// Budget uses official peak/no-cache rates, not a discounted estimate; unknown requests keep the full reservation.
export function budgetCost(phase, candidate) {
  if (!metered(phase)) return null;
  const u = phase.usage, input = u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
  if (input > candidate.inputLimit) throw Error("已发生用量超出冻结价格档，请停止并核对");
  return ((u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) * 1.25) * candidate.input + u.outputTokens * candidate.output) / 1e6;
}
export function referenceCost(phase, candidate) {
  if (!metered(phase)) return null;
  const u = phase.usage, write = (u.cacheWriteTokens ?? 0) * candidate.input * 1.25;
  const high = (u.inputTokens * candidate.input + (u.cacheReadTokens ?? 0) * (candidate.model === "deepseek-flash" ? .04 : candidate.input * .2) + write + u.outputTokens * candidate.output) / 1e6;
  return { low: candidate.model === "deepseek-flash" ? high / 2 : high, high };
}
export function reserveCost(body, candidate) {
  const bytes = Buffer.byteLength(JSON.stringify(body), "utf8") + 1024;
  if (bytes > candidate.inputLimit) throw Error("请求超出冻结价格档");
  return 2 * (bytes * candidate.input + 2048 * candidate.output) / 1e6;
}
export class Budget {
  constructor(used, limit = 10) { this.used = used; this.limit = limit; this.pending = 0; }
  reserve(amount) { if (!Number.isFinite(amount) || amount <= 0 || this.used + this.pending + amount > this.limit - 1e-9) return false; this.pending += amount; return true; }
  settle(reserved, cost) { this.pending -= reserved; const charged = cost === null || !Number.isFinite(cost) || cost < 0 ? reserved : cost; this.used += charged; if (charged > reserved + 1e-9) this.overrun = true; return charged; }
}
export function auditHistory() {
  const rounds = [], files = {}, corrections = [];
  for (const round of ["", "v2/", "v3/", "v4/", "v5/", "v6/"]) {
    const file = `.cache/extraction-evaluation/${round}live/journal.jsonl`, raw = readFileSync(file), events = raw.toString().trim().split(/\r?\n/).map(JSON.parse);
    files[file] = hash(raw); const started = new Map(), finished = new Map();
    for (const e of events) {
      const id = e.key ?? e.taskId;
      if (["started", "phase-start"].includes(e.event)) { if (started.has(id)) throw Error("历史请求编号重复"); started.set(id, e); }
      if (["finished", "phase-finish"].includes(e.event)) { if (finished.has(id) || !started.has(id)) throw Error("历史请求完成顺序错误"); finished.set(id, e.record); }
    }
    let upper = 0, oldPolicy = 0, low = 0, high = 0, unknown = 0, unknownCount = 0;
    for (const [id, start] of started) {
      const phase = finished.get(id), candidate = rates.find(c => c.model === (phase?.wire?.model ?? start.wire?.model));
      const known = metered(phase); if (known && !candidate) throw Error("历史价格型号未知");
      const amount = known ? budgetCost(phase, candidate) : start.reservedCny;
      if (!Number.isFinite(amount) || amount < 0) throw Error("历史请求缺失预留金额");
      upper += amount; oldPolicy += known ? 2 * amount : amount;
      if (known) { const ref = referenceCost(phase, candidate); low += ref.low; high += ref.high; }
      else { unknown += amount; unknownCount++; const recorded = phase?.chargedCny ?? phase?.budgetChargedCny; if (recorded !== amount) corrections.push({ round: round || "v1", key: id, original: recorded ?? null, reserved: amount, status: phase?.httpStatus ?? null, reason: "未确认收费的失败请求按原始全额预留保留，不假设免费" }); }
    }
    rounds.push({ round: round.replace("/", "") || "v1", requests: started.size, finishes: finished.size, unknownCount, unknownReserveCny: unknown, knownReferenceLowCny: low, knownReferenceHighCny: high, officialPeakNoCachePlusUnknownCny: upper, correctedOldDoublePeakCny: oldPolicy });
  }
  const sum = key => rounds.reduce((n, r) => n + r[key], 0);
  return { at: new Date().toISOString(), pricingChecked: "2026-11-03", rounds, corrections, files, originalConservativeReportedCny: JSON.parse(readFileSync(".cache/extraction-evaluation/v6/live/completion.json")).cumulativeAccountedCny, correctedOldDoublePeakCny: sum("correctedOldDoublePeakCny"), knownReferenceLowCny: sum("knownReferenceLowCny"), knownReferenceHighCny: sum("knownReferenceHighCny"), unknownReserveCny: sum("unknownReserveCny"), budgetPriorCny: sum("officialPeakNoCachePlusUnknownCny"), budgetCeilingCny: 10, remainingCny: 10 - sum("officialPeakNoCachePlusUnknownCny"), actualInvoiceVerified: false, basis: "已知请求按官方峰时无缓存价上界；未知请求保留原始完整预留。发送前另按两倍价格和最大输出预留；不是以旧预算记账当实际扣费。", sources: ["https://help.aliyun.com/zh/model-studio/model-pricing", "https://help.aliyun.com/zh/model-studio/context-cache", "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/"] };
}
export function journalState(file, planId) {
  const events = existsSync(file) ? readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : [], started = new Map(), phases = new Map(), tasks = new Map();
  for (const e of events) {
    if (e.planId !== planId) throw Error("运行日志清单不匹配");
    if (e.event === "phase-start") { if (started.has(e.key)) throw Error("禁止重发已开始阶段"); started.set(e.key, e); }
    else if (e.event === "phase-finish") { if (!started.has(e.key) || phases.has(e.key)) throw Error("阶段日志顺序错误"); phases.set(e.key, e.record); }
    else if (e.event === "task-finish") { if (tasks.has(e.record.taskId)) throw Error("任务重复"); tasks.set(e.record.taskId, e.record); }
    else throw Error("未知运行事件");
  }
  const unresolved = [...started.keys()].filter(k => !phases.has(k)), orphanTasks = [...started.keys()].map(k => k.replace(/:(extraction|verification)$/, "")).filter(k => !tasks.has(k));
  return { started, phases, tasks, unresolved, orphanTasks };
}
