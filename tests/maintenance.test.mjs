import test from "node:test";
import assert from "node:assert/strict";
import { fixture, operation, approve, model, draft, workspace } from "./helpers/kernel.mjs";
import { maintenanceContext, askClarification, observeConversation, processReply } from "../src/maintenance.mjs";
import { MemoryService } from "../src/service.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const session = { header: { id: "synthetic", cwd: workspace } };
const context = { workspace, sessionId: "synthetic" };
function seed(s, { scope = "project", replacement = true } = {}) {
  const old = replacement ? s.manual({ content: "项目使用 Python。", kind: "fact", scope: "project" }, { workspace }) : null;
  const id = s.store.source({ sessionId: "origin", eventId: "proposal", projectId: workspace, role: "user", text: "项目拟改用 TypeScript。" });
  const candidate = s.store.save({ content: "项目使用 TypeScript。", kind: scope === "global" ? "preference" : "fact", scope, projectId: workspace, status: "pending", evidence: [{ sourceId: id, quote: "项目拟改用 TypeScript。" }], attributes: { legacy: false, subject: "项目", facet: "语言" } }, { supersedes: old?.id ?? null });
  return { old, candidate };
}
function event(s, role, text, seq) {
  const e = { type: `${role}/message`, seq, time: s.store.now() + seq, data: role === "user" ? { source: { kind: "user" }, content: [{ type: "text", text }] } : { message: { content: [{ type: "text", text }] } } };
  s.capture(session, e); observeConversation(s, session, e); return e;
}
async function ask(s, candidate) {
  event(s, "user", "请继续项目 TypeScript 的实现。", 10);
  const shown = maintenanceContext(s, "synthetic", "u10", workspace, "项目 TypeScript 实现");
  assert.match(shown, /TypeScript/);
  await askClarification(s, { id: candidate.id, version: candidate.version, question: "TypeScript 是替代原来的 Python，还是新增模块？", taskImpact: "当前要选择实现语言，替代关系会改变本次代码。" }, context);
  event(s, "assistant", "TypeScript 是替代原来的 Python，还是新增模块？", 11);
}
function resolver(s, candidate, old, mode = "update", review = approve) {
  return model(s, p => {
    const refs = p.sources.filter(x => x.sourceId.startsWith("synthetic:12:")).flatMap(x => x.anchors.map(a => ({ sourceId: x.sourceId, anchorId: a.id })));
    const target = mode === "forget" ? candidate : old;
    return draft([operation(p, { action: mode, intent: mode === "forget" ? "forget" : mode === "update" ? "correct" : "statement", content: mode === "forget" ? "" : candidate.content, kind: candidate.kind, scope: candidate.scope, authorization: "explicit", evidence: refs, authorizationEvidence: refs, targetId: mode === "add" ? null : target.id, targetVersion: mode === "add" ? null : target.version })]);
  }, review);
}

test("对话维护：只呈现相关候选，候选不作为事实召回且限制数量", async t => {
  const s = fixture(t, []), { candidate } = seed(s);
  assert.equal(maintenanceContext(s, "synthetic", "u", workspace, "晚饭吃什么"), "");
  assert.match(maintenanceContext(s, "synthetic", "u", workspace, "TypeScript 项目语言"), /不是已确认事实/);
  assert.match(maintenanceContext(s, "synthetic", "u", workspace, "继续TypeScript项目的实现。"), /TypeScript/);
  assert.ok(!(await s.search("TypeScript", workspace)).some(r => r.id === candidate.id));
  assert.equal(maintenanceContext(s, "synthetic", "u", "d:/other", "TypeScript 项目语言"), "");
  const source = s.store.detail(candidate.id).evidence[0];
  for (let i = 0; i < 3; i++) s.store.save({ content: `TypeScript 模块 ${i}。`, kind: "fact", scope: "project", projectId: workspace, status: "pending", evidence: [{ sourceId: source.id, quote: source.quote }], attributes: { legacy: false } });
  maintenanceContext(s, "synthetic", "u2", workspace, "TypeScript 项目语言");
  assert.equal(s.store.getMeta("maintenanceShown:synthetic").candidates.length, 2);
});

test("对话维护：实际问过后，简短回答自动激活原候选并替代旧记忆", async t => {
  const s = fixture(t, []), { old, candidate } = seed(s);
  model(s, () => draft([])); await ask(s, candidate);
  event(s, "user", "替代，以后都用 TypeScript。", 12);
  const calls = resolver(s, candidate, old);
  await Promise.all([processReply(s, context), processReply(s, context)]);
  assert.equal(calls.length, 2); assert.equal(s.store.get(candidate.id).status, "active");
  assert.equal(s.store.get(old.id).status, "superseded");
  assert.ok(s.store.detail(candidate.id).evidence.some(e => e.text.includes("替代")));
  assert.ok(s.store.operations({ memoryId: candidate.id }).some(r => r.outcome === "applied"));
});

test("对话维护：否认只取消候选，不遗忘旧事实也不建立遗忘墓碑", async t => {
  const s = fixture(t, []), { old, candidate } = seed(s);
  model(s, () => draft([])); await ask(s, candidate); event(s, "user", "不是，这个 TypeScript 方案取消，保留 Python。", 12);
  resolver(s, candidate, old, "forget"); await processReply(s, context);
  assert.equal(s.store.get(candidate.id).status, "dismissed"); assert.equal(s.store.get(old.id).status, "active");
  assert.equal(s.store.db.prepare("SELECT count(*) AS n FROM forgotten_facts").get().n, 0);
  event(s, "user", "继续项目 TypeScript。", 13);
  assert.equal(maintenanceContext(s, "synthetic", "next", workspace, "项目 TypeScript"), "");
});

test("对话维护：回答说明是独立事项时解除替代关联，保留旧事实", async t => {
  const s = fixture(t, []), { old, candidate } = seed(s);
  model(s, () => draft([])); await ask(s, candidate); event(s, "user", "新增独立模块，原来的 Python 保留。", 12);
  resolver(s, candidate, old, "add"); await processReply(s, context);
  assert.equal(s.store.get(candidate.id).status, "active"); assert.equal(s.store.get(candidate.id).supersedes, null);
  assert.equal(s.store.get(old.id).status, "active");
});

test("对话维护：未决或无关回答不升级、不反复追问，也不要求去界面确认", async t => {
  for (const skip of [false, true]) {
    const s = fixture(t, []), { old, candidate } = seed(s);
    model(s, () => draft([])); await ask(s, candidate); event(s, "user", "先不决定，继续写说明。", 12);
    if (skip) model(s, () => draft([])); else resolver(s, candidate, old, "update", p => approve(p, { decision: "uncertain", certainty: "unresolved" }));
    await processReply(s, context);
    assert.equal(s.store.get(candidate.id).status, "pending"); assert.equal(s.store.get(old.id).status, "active");
    assert.equal(maintenanceContext(s, "another-session", "next", workspace, "TypeScript 项目语言"), "");
  }
});

test("对话维护：没实际提问、跨项目、候选变化或旧目标遗忘均不应用回答", async t => {
  for (const change of ["unsent", "foreign", "candidate", "forgotten"]) {
    const s = fixture(t, []), { old, candidate } = seed(s);
    model(s, () => draft([])); await ask(s, candidate);
    if (change === "unsent") s.store.setMeta("maintenance:synthetic", { ...s.store.getMeta("maintenance:synthetic"), questionSourceId: null });
    if (change === "candidate") s.store.save({ ...candidate, content: "另一个候选", projectId: workspace, evidence: s.store.detail(candidate.id).evidence.map(e => ({ sourceId: e.id, quote: e.quote })), attributes: { legacy: false } }, { expectedVersion: candidate.version });
    if (change === "forgotten") s.store.forget(old.id);
    event(s, "user", "是的。", 12); const calls = resolver(s, candidate, old);
    await processReply(s, change === "foreign" ? { ...context, workspace: "d:/other" } : context);
    assert.equal(calls.length, 0); assert.equal(s.store.get(candidate.id).status, "pending");
  }
});

test("对话维护：同一候选版本只问一次，新话题不能沿用旧的候选展示授权", async t => {
  const s = fixture(t, []), { candidate } = seed(s); model(s, () => draft([])); await ask(s, candidate);
  assert.equal((await askClarification(s, { id: candidate.id, version: candidate.version }, context)).shouldAsk, false);
  assert.equal(maintenanceContext(s, "other", "u", workspace, "TypeScript 项目语言"), "");
  const x = fixture(t, []), c = seed(x).candidate; model(x, () => draft([])); event(x, "user", "项目 TypeScript", 1);
  maintenanceContext(x, "synthetic", "u", workspace, "项目 TypeScript"); event(x, "user", "换个话题聊晚饭", 2);
  await assert.rejects(askClarification(x, { id: c.id, version: c.version, question: "是否替代？", taskImpact: "选择实现语言" }, context), /话题或候选已变化/);
});

test("对话维护：复核必须引用实际回答，不能只靠问题或旧来源批准", async t => {
  const s = fixture(t, []), { old, candidate } = seed(s); model(s, () => draft([])); await ask(s, candidate); event(s, "user", "替代，改用 TypeScript。", 12);
  resolver(s, candidate, old, "update", p => approve(p, { authorizationEvidence: [] })); await processReply(s, context);
  assert.equal(s.store.get(candidate.id).status, "pending"); assert.equal(s.store.get(old.id).status, "active");
  assert.equal(s.store.getMeta("maintenance:synthetic").status, "needs-review");
});

test("对话维护：模型处理期间旧目标变化，保留新版本，不生成重复候选", async t => {
  const s = fixture(t, []), { old, candidate } = seed(s); model(s, () => draft([])); await ask(s, candidate); event(s, "user", "替代，改用 TypeScript。", 12);
  resolver(s, candidate, old, "update", p => { s.manual({ ...old, content: "项目已另行改用 Rust。", version: old.version }, { workspace }); return approve(p); });
  await processReply(s, context); assert.equal(s.store.get(old.id).content, "项目已另行改用 Rust。");
  assert.equal(s.store.get(candidate.id).status, "pending"); assert.equal(s.store.list({ status: "pending" }).length, 1);
});

test("对话维护：完整模型回答保存后事务失败，只重放本地处理，不再次调用模型", async t => {
  let now = 1000; const s = fixture(t, [], { now: () => now }), { old, candidate } = seed(s); model(s, () => draft([])); await ask(s, candidate); event(s, "user", "替代，改用 TypeScript。", 12);
  const calls = resolver(s, candidate, old), save = s.store.save.bind(s.store); let once = true;
  s.store.save = (...args) => { if (once) { once = false; throw new Error("模拟提交失败"); } return save(...args); };
  await processReply(s, context); assert.equal(calls.length, 2); assert.equal(s.store.get(candidate.id).status, "pending");
  assert.equal(s.store.getMeta("maintenance:synthetic").status, "answer-pending");
  now += 200000; await processReply(s, context);
  assert.equal(calls.length, 2); assert.equal(s.store.get(candidate.id).status, "active");
});

test("对话维护：重启后仍将简短回答关联到原问题与原候选", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-maintenance-")), filename = join(dir, "memory.sqlite");
  t.after(async () => { await s.close(); const child = relative(resolve(tmpdir()), resolve(dir)); assert.ok(child.startsWith("dsh-maintenance-") && !child.includes("..")); rmSync(dir, { recursive: true, force: true }); });
  let s = new MemoryService({ filename, client: { ready: async () => false } });
  const { old, candidate } = seed(s); model(s, () => draft([])); await ask(s, candidate); await s.close();
  s = new MemoryService({ filename, client: { ready: async () => false } });
  event(s, "user", "替代，确定用 TypeScript。", 12); const calls = resolver(s, candidate, old); await processReply(s, context);
  assert.equal(calls.length, 2); assert.equal(s.store.get(candidate.id).status, "active");
});
