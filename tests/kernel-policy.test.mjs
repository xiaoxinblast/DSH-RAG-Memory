import test from "node:test";
import assert from "node:assert/strict";
import { decideOperation } from "../src/policy.mjs";
import { validityTime } from "../src/domain.mjs";
import { sourceAnchors } from "../src/evidence.mjs";

const workspace = "d:/synthetic/kernel";
function input(text = "项目使用 SQLite。", extra = {}) {
  const sources = [{ id: "s", role: "user", text, project_id: workspace, contextOnly: false, created_at: 20, source_order: 20 }];
  const op = { id: "op0", action: "add", intent: "statement", content: text, kind: "fact", scope: "project", targetId: null, targetVersion: null, evidence: sourceAnchors(sources[0]).map(({ start, end }) => ({ sourceId: "s", start, end })), certainty: "confirmed", authorization: "ordinary", eventState: "not_applicable", ...extra };
  Object.assign(op, { unit: op.action === "forget" ? "control" : "self_contained", authorizationEvidence: op.evidence, restores: op.intent === "rerecord" ? "forgotten" : null });
  const review = { id: op.id, decision: "approve", certainty: op.certainty, authorization: op.authorization, eventState: op.eventState, unit: op.unit, authorizationEvidence: op.authorizationEvidence, restores: op.restores, evidence: op.evidence, reason: "模拟复核；不代表真实模型能力" };
  return { op, review, facts: { sources, workspace, existing: [], target: null, blocked: false, forgotten: [], conflicts: [], legacyTombstones: [] } };
}
const decide = f => decideOperation(f.op, f.review, f.facts);
test("kernel 裁决：已确定未来计划与事件完成分离；只存候选不得被批准提升", () => {
  const f = input("已决定周五迁移，目前未开始。", { eventState: "planned" });
  assert.equal(decide(f).outcome, "applied");
  for (const side of ["op", "review"]) {
    const p = input(); p[side].authorization = "candidate_only"; assert.equal(decide(p).outcome, "pending");
    const u = input(); u[side].certainty = "unresolved"; assert.equal(decide(u).outcome, "pending");
  }
  f.review.eventState = "completed"; assert.equal(decide(f).outcome, "pending");
});
test("kernel 裁决：无价值与拒绝不入库；坏复核需要检查，不冒充候选", () => {
  const f = input(); f.review.decision = "reject"; assert.equal(decide(f).outcome, "rejected");
  f.review = null; assert.equal(decide(f).outcome, "review-required");
  f.op.action = "skip"; assert.equal(decide(f).outcome, "skipped");
  for (const intent of ["query", "temporary", "quoted"]) { const x = input("合成内容", { intent }); assert.equal(decide(x).outcome, "rejected"); }
});
test("kernel 硬约束：伪造、越界、遮蔽、跨项目和上下文来源不能靠批准绕过", () => {
  const patches = [f => f.op.evidence[0].start = 1, f => f.op.evidence[0].sourceId = "fake", f => f.facts.sources[0].maskedRanges = [{ start: 0, end: 2 }], f => f.facts.sources[0].project_id = "d:/other", f => f.facts.sources[0].contextOnly = true, f => f.facts.sources[0].role = "assistant"];
  for (const patch of patches) { const f = input(); patch(f); assert.equal(decide(f).outcome, "rejected"); }
});
test("kernel 来源：工具失败可以证明失败，不能充当个人偏好或全局授权", () => {
  const f = input("部署失败。", { kind: "progress", eventState: "failed" }); f.facts.sources[0].role = "tool-error";
  assert.equal(decide(f).outcome, "applied");
  f.op.scope = "global"; f.op.kind = "preference"; f.op.authorization = f.review.authorization = "explicit";
  assert.equal(decide(f).outcome, "rejected");
});
test("kernel 授权：全局及更正必须双阶段明确授权，版本变化保留旧条目", () => {
  const g = input("长期偏好简体中文。", { scope: "global", kind: "preference" }); assert.equal(decide(g).outcome, "pending");
  g.op.authorization = g.review.authorization = "explicit"; assert.equal(decide(g).outcome, "applied");
  const f = input("目录已停用。", { action: "update", intent: "correct", targetId: "old", targetVersion: 1, authorization: "explicit" });
  const target = { id: "old", version: 1, status: "active", scope: "project", project_id: workspace, attributes: { legacy: false } };
  f.facts.existing = [target]; f.facts.target = target; assert.equal(decide(f).outcome, "applied");
  f.facts.target = { ...target, version: 2 }; assert.equal(decide(f).outcome, "pending");
  f.facts.target.status = "forgotten"; assert.equal(decide(f).outcome, "rejected");
});

test("kernel 裁决优先级：坏复核不得借版本冲突变成候选，拒绝不会变成待确认", () => {
  const f = input("更正数据库。", { action: "update", targetId: "old", targetVersion: 1, authorization: "explicit" });
  f.facts.target = { id: "old", version: 2, status: "active", scope: "project", project_id: workspace, attributes: { legacy: false } }; f.facts.existing = [f.facts.target];
  f.review.decision = "reject"; assert.equal(decide(f).outcome, "rejected");
  f.review.decision = "pending"; assert.equal(decide(f).outcome, "review-required");
  f.review = null; assert.equal(decide(f).outcome, "review-required");
  f.review = { id: f.op.id, decision: "approve", authorization: "explicit", certainty: "confirmed", eventState: f.op.eventState, evidence: f.op.evidence, authorizationEvidence: f.op.authorizationEvidence, unit: f.op.unit, restores: null }; f.facts.blocked = true;
  assert.equal(decide(f).outcome, "rejected");
});
test("kernel 遗忘：目标不唯一须澄清，新来源双授权才能重新记住", () => {
  const f = input("忘掉项目使用 SQLite。", { action: "forget", intent: "forget", targetId: "old", targetVersion: 1, authorization: "explicit" });
  const target = { id: "old", content: "项目使用 SQLite。", version: 1, status: "active", scope: "project", project_id: workspace, attributes: { legacy: false } };
  f.facts.existing = [target]; f.facts.target = target; assert.equal(decide(f).outcome, "applied");
  f.facts.existing.push({ ...target, id: "also" }); assert.equal(decide(f).outcome, "clarification");
  const r = input("重新记住项目使用 SQLite。", { content: "项目使用 SQLite。", intent: "rerecord", authorization: "explicit" });
  r.facts.blocked = true; r.facts.rerecordGrant = { memoryId: "forgotten", sourceIds: ["s"] }; r.facts.restoreBlocked = false;
  assert.equal(decide(r).rerecordGrant.memoryId, "forgotten"); assert.equal(decide(r).outcome, "applied");
  r.facts.restoreBlocked = true; assert.equal(decide(r).outcome, "rejected");
});
test("kernel 语义契约：同义、倒装、否定位置与主体词不参与宿主状态猜测", () => {
  for (const text of ["先启动哪个我还没想好。", "还没想好先启动哪个。", "A 会导致 B 吗尚未查明。", "旧目录已停用。", "主体甲安装完毕，主体乙尚未开始。"] ) {
    const f = input(text); assert.equal(decide(f).outcome, "applied");
    f.op.certainty = "unresolved"; assert.equal(decide(f).outcome, "pending");
    f.review.decision = "reject"; assert.equal(decide(f).outcome, "rejected");
  }
});

test("kernel 时间：相同日期截止的等价合并按自然日末比较，不误降候选", () => {
  const f = input("项目使用 SQLite，有效期截至 2026-11-03。", { action: "merge", targetId: "old", targetVersion: 1, authorization: "explicit", attributes: { validUntil: "2026-11-03" } });
  f.facts.target = { id: "old", version: 1, kind: "fact", status: "active", scope: "project", project_id: workspace, attributes: { legacy: false, validUntil: validityTime("2026-11-03", true) } }; f.facts.existing = [f.facts.target];
  assert.equal(decide(f).outcome, "merged"); f.op.attributes.validUntil = "2026-11-04"; assert.equal(decide(f).outcome, "rejected");
});
