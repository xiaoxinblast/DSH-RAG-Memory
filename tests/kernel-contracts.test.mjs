import test from "node:test";
import assert from "node:assert/strict";
import { fixture, operation, approve, model, draft, work, rows, workspace } from "./helpers/kernel.mjs";

// Explicit synthetic two-stage judgments. These tests verify state mapping, not natural-language accuracy.
const cases = [
  { texts: ["已决定周五迁移，目前未开始。", "目前未开始，但周五迁移已定。"], content: "已确定周五迁移，尚未开始。", eventState: "planned", status: "active" },
  { texts: ["A、B 先做哪个尚未决定。", "先做 B 还是 A，还没定。"], content: "A、B 的执行顺序未定。", certainty: "unresolved", eventState: "planned", status: "pending" },
  { texts: ["先发生 A 再发生 B，因果未确认。", "B 出现在 A 之后，尚不能认定由 A 导致。"], content: "A 先于 B，因果未确认。", status: "active" },
  { texts: ["工具明确报错，部署没有执行。", "部署未执行，因为工具返回错误。"], content: "工具报错导致部署未执行。", role: "tool-error", eventState: "failed", status: "active" },
  { texts: ["仅先存候选：周五迁移。", "周五迁移这个想法，请先只作为候选。"], content: "周五迁移。", authorization: "candidate_only", eventState: "planned", status: "pending" },
  { texts: ["记住权限边界。", "关于权限边界，记住就行。"], content: "记住权限边界。", reject: true },
  { texts: ["请查询旧方案。", "旧方案是什么，请查一下。"], content: "每次使用旧方案。", reject: true },
  { texts: ["尚未证明 A 导致 B。", "A 和 B 的因果关系没有确认。"], content: "A 导致 B。", reject: true },
  { texts: ["计划部署但没有执行。", "没有部署，仅批准以后执行。"], content: "部署已经完成。", eventState: "completed", reject: true },
];
for (const [i, c] of cases.entries()) test(`语义契约 ${i + 1}：成对表述使用独立模拟判断，不是模型准确率`, async t => {
  for (const text of c.texts) {
    const s = fixture(t, [{ text, role: c.role ?? "user" }]);
    model(s, p => draft([operation(p, { content: c.content, kind: c.eventState ? "progress" : "fact", certainty: c.certainty ?? "confirmed", authorization: c.authorization ?? "ordinary", eventState: c.eventState ?? "not_applicable" })]), p => approve(p, c.reject ? { decision: "reject", reason: "模拟独立复核发现事实或持久价值不被原文支持" } : {}));
    await work(s); assert.equal(rows(s).length, c.reject ? 0 : 1); if (!c.reject) assert.equal(rows(s)[0].status, c.status); else assert.equal(s.store.operations()[0].outcome, "rejected");
  }
});
test("语义契约：当前事实与未决未来分开；另一主体的完成不证明当前主体完成", async t => {
  for (const text of ["当前继续 A，未来是否改 B 未定。甲完成了，乙未开始。", "乙未开始，甲完成了；B 仍待定，现在继续 A。"] ) {
    const s = fixture(t, [text]); model(s, p => draft([operation(p, { content: "当前继续 A。" }), operation(p, { content: "将来是否改 B 未定。", certainty: "unresolved", eventState: "planned" }), operation(p, { content: "乙已经完成。", eventState: "completed" })]), p => { const r = approve(p); r.units[2].decision = "reject"; return r; });
    await work(s); assert.equal(rows(s).length, 2); assert.equal(s.store.eligible(workspace)[0].content, "当前继续 A。");
  }
});
test("语义契约：原句无持续价值由阶段判断，引用完整但丢条件仍可被独立复核拒绝", async t => {
  const s = fixture(t, ["仅内网可访问；公网访问必须审批。"]);
  model(s, p => draft([operation(p, { content: "服务可以访问。" })]), p => approve(p, { decision: "reject", reason: "正文遗漏内网范围与公网审批条件" })); await work(s);
  assert.equal(rows(s).length, 0); assert.equal(s.store.operations()[0].outcome, "rejected");
});
