import { MemoryService } from "../../src/service.mjs";
import { PROTOCOL_VERSION, CONTRACT } from "../../src/extraction.mjs";
export const workspace = "d:/synthetic/kernel";
export function fixture(t, texts = ["项目使用 SQLite。"], options = {}) {
  const service = new MemoryService({ filename: ":memory:", client: { ready: async () => false }, ...options }); t.after(() => service.close());
  texts.forEach((value, i) => { const s = typeof value === "string" ? { text: value } : value; service.store.source({ id: `s${i}`, sessionId: "synthetic", projectId: workspace, eventId: `e${i}`, role: "user", turnId: "turn", ...s }); });
  return service;
}
export function operation(payload, patch = {}) {
  const value = { action: "add", intent: "statement", content: "项目使用 SQLite。", kind: "fact", scope: "project", targetId: null, targetVersion: null, certainty: "confirmed", authorization: "ordinary", eventState: "not_applicable", unit: patch.action === "forget" ? "control" : "self_contained", restores: patch.intent === "rerecord" ? payload.protected?.[0]?.id ?? null : null, evidence: payload.sources.filter(s => !s.contextOnly).flatMap(s => s.anchors.map(a => ({ sourceId: s.sourceId, anchorId: a.id }))), ...patch };
  const o = { ...value, authorizationEvidence: value.authorizationEvidence ?? (value.authorization === "explicit" ? value.evidence : []) };
  return o.action === "forget" ? Object.fromEntries(CONTRACT.fields.forget.map(k => [k, o[k]])) : o;
}
export function approve(payload, patch = {}) {
  return { version: PROTOCOL_VERSION, units: payload.items.map(o => {
    const row = { members: [o.id], decision: "approve", reason: "合成结构化判断，非模型准确率测试", evidence: o.evidence, authorizationEvidence: o.authorizationEvidence, restores: o.restores, unit: o.unit, certainty: o.certainty, authorization: o.authorization, eventState: o.eventState, ...patch };
    return o.action === "forget" ? Object.fromEntries(CONTRACT.fields.reviewForget.map(k => [k, row[k]])) : row;
  }) };
}
export function model(service, extraction, review = approve) {
  const calls = [];
  service.extractor = { request: async (phase, raw) => { const payload = JSON.parse(raw); calls.push({ phase, payload }); const response = await (phase === "extraction" ? extraction : review)(payload); return response?.finish ? response : { text: JSON.stringify(response), finish: "stop", usage: { inputTokens: 1, outputTokens: 1 } }; } };
  return calls;
}
export const draft = operations => ({ version: PROTOCOL_VERSION, operations });
export async function work(service) { service.schedule("synthetic"); await service.work("extract"); }
export const rows = service => service.store.list({ status: "all" });
export const jobs = service => service.store.db.prepare("SELECT * FROM jobs WHERE kind='extract'").all();
