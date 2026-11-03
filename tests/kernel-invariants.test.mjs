import test from "node:test";
import assert from "node:assert/strict";
import { fixture, operation, approve, model, draft, work, rows, jobs, workspace } from "./helpers/kernel.mjs";
import { prepareOperations } from "../src/operations.mjs";
import { sourceAnchors } from "../src/evidence.mjs";
import { MemoryStore } from "../src/store.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
const seed = (s, content = "项目使用 SQLite。", extra = {}) => s.manual({ kind: "fact", scope: "project", content, ...extra }, { workspace });
const targetOp = (p, old, patch = {}) => operation(p, { action: "update", intent: "correct", authorization: "explicit", targetId: old.id, targetVersion: old.version, content: "项目使用 PostgreSQL。", ...patch });

test("硬约束：候选重复有效正文不得把未确认来源合入有效记忆", async t => {
  const s = fixture(t), old = seed(s); const before = s.store.detail(old.id).evidence.length;
  model(s, p => draft([operation(p, { authorization: "candidate_only" })])); await work(s);
  assert.equal(s.store.detail(old.id).evidence.length, before); assert.equal(rows(s).find(r => r.id !== old.id)?.status, "pending"); assert.equal(s.store.operations().find(r => r.job_id).after.status, "pending");
});
test("硬约束：完全重复补充证据不重复索引；近义合并须双阶段明确复核", async t => {
  const s = fixture(t), old = seed(s); s.store.setEmbedding(old.id, old.content_hash, "text-embedding-v4", [1, 0]); s.store.db.prepare("UPDATE jobs SET status='done'").run();
  model(s, p => draft([operation(p)])); await work(s); assert.equal(rows(s).length, 1); assert.equal(s.store.detail(old.id).evidence.length, 2); assert.equal(s.store.vectors(workspace, "text-embedding-v4").length, 1); assert.equal(s.store.db.prepare("SELECT count(*) AS n FROM jobs WHERE kind='embed' AND status='pending'").get().n, 0);
  const x = fixture(t, ["之前的项目数据库确实是 SQLite。"]), base = seed(x); const calls = model(x, p => draft([targetOp(p, base, { action: "merge", content: "项目数据库为 SQLite。" })])); await work(x);
  assert.equal(calls.length, 2); assert.equal(rows(x).length, 1); assert.equal(x.store.get(base.id).content, base.content); assert.equal(x.store.detail(base.id).evidence.length, 2);
});
test("硬约束：明确更正事务替代、清向量、回退版本校验；后续修改拒绝过期回退", async t => {
  for (const changed of [false, true]) {
    const s = fixture(t, ["更正项目数据库为 PostgreSQL。"]), old = seed(s); s.store.setEmbedding(old.id, old.content_hash, "text-embedding-v4", [1, 0]);
    model(s, p => draft([targetOp(p, old)])); await work(s); const receipt = s.store.operations().find(r => r.job_id && r.action === "update");
    assert.equal(receipt.outcome, "applied"); assert.equal(s.store.get(old.id).status, "superseded"); assert.equal(s.store.vectors(workspace, "text-embedding-v4").length, 0);
    if (changed) { s.manual({ ...receipt.after, content: "后续明确更改", version: receipt.after.version }, { workspace }); await assert.rejects(s.invoke({ action: "revert", operationId: receipt.id }), /过期回退/); }
    else { await s.invoke({ action: "revert", operationId: receipt.id }); assert.equal(s.store.get(old.id).status, "active"); assert.equal(s.store.get(receipt.after.id).status, "superseded"); }
  }
});
test("硬约束：全局同意才共享；候选不共享；项目目标及旧元数据不能强行覆盖", async t => {
  for (const review of [{}, { decision: "uncertain" }, { decision: "reject" }]) {
    const s = fixture(t, ["我长期偏好所有项目使用中文解释。"]); model(s, p => draft([operation(p, { scope: "global", kind: "preference", authorization: "explicit", content: "长期偏好中文解释。" })]), p => approve(p, review)); await work(s);
    assert.equal(s.store.eligible("d:/another").length, Object.keys(review).length ? 0 : 1);
  }
  for (const foreign of [true, false]) {
    const s = fixture(t), old = foreign ? s.manual({ content: "另项目数据库 SQLite。", kind: "fact", scope: "project" }, { workspace: "d:/another" }) : seed(s);
    if (!foreign) s.store.setAttributes(old.id, { legacy: true }); model(s, p => draft([targetOp(p, old)])); await work(s);
    assert.equal(s.store.get(old.id).status, "active"); assert.ok(s.store.operations().some(r => r.job_id && ["pending", "rejected"].includes(r.outcome)));
  }
});
test("硬约束：新来源明确重记建立新条目，旧来源与同主体属性改写受墓碑保护", async t => {
  let now = 1000; const s = fixture(t, [], { now: () => now }), old = seed(s); s.store.setAttributes(old.id, { subject: "项目", facet: "数据库" }); s.store.forget(old.id); now = 2000;
  s.store.source({ id: "s0", sessionId: "synthetic", projectId: workspace, eventId: "new", role: "user", text: "现在重新记住项目使用 SQLite。", turnId: "turn" });
  model(s, p => draft([operation(p, { intent: "rerecord", authorization: "explicit", attributes: { subject: "项目", facet: "数据库" } })])); await work(s);
  const current = s.store.eligible(workspace); assert.equal(current.length, 1); assert.notEqual(current[0].id, old.id); assert.equal(s.store.get(old.id).status, "forgotten"); assert.equal(s.store.operations().find(r => r.job_id).details.decision.rerecordGrant.memoryId, old.id);
  const x = fixture(t), forgotten = seed(x); x.store.setAttributes(forgotten.id, { subject: "项目", facet: "数据库" }); x.store.forget(forgotten.id);
  model(x, p => draft([operation(p, { content: "项目数据库还是 SQLite。", attributes: { subject: "项目", facet: "数据库" } })])); await work(x); assert.equal(x.store.eligible(workspace).length, 0);
});
test("硬约束：模糊或被否定的遗忘不执行；引用不能充当直接用户授权", async t => {
  for (const [text, decision] of [["忘掉那个旧方案。", "approve"], ["不要忘掉项目使用 SQLite。", "reject"], ['"忘掉项目使用 SQLite。"', "approve"]]) {
    const s = fixture(t, [text]), old = seed(s); model(s, p => draft([targetOp(p, old, { action: "forget", intent: "forget", content: "" })]), p => approve(p, { decision })); await work(s);
    assert.equal(s.store.get(old.id).status, "active"); assert.equal(s.store.operations().find(r => r.job_id)?.outcome === "applied", false);
  }
});
test("硬约束：遗忘遮蔽输入及相邻上下文，凭据和引用锚点不泄漏", async t => {
  const s = fixture(t, []), text = "合成敏感旧事实_FORGETME";
  s.store.source({ id: "old", sessionId: "synthetic", eventId: "old", projectId: workspace, role: "user", text, turnId: "t" });
  const old = s.store.save({ kind: "fact", scope: "project", projectId: workspace, content: text, evidence: [{ sourceId: "old", quote: text }], ranges: [{ sourceId: "old", start: 0, end: text.length }] }); s.store.forget(old.id);
  const calls = model(s, p => { assert.ok(!JSON.stringify(p).includes(text)); return draft([]); }); await work(s); assert.equal(calls.length, 0); assert.equal(s.store.getSource("old").processed, 1);
  s.store.source({ id: "new", sessionId: "synthetic", eventId: "new", projectId: workspace, role: "user", text: "独立的新事实。", turnId: "t2" }); await work(s); assert.equal(calls.length, 1);
  const anchors = sourceAnchors({ text: '这是“完整，引文。”。api_key=123456789;另一事实。' }); assert.ok(anchors.some(a => a.text.includes('完整，引文。'))); assert.ok(!JSON.stringify(anchors).includes('123456789'));
});
test("硬约束：主体召回旧记忆，辅助上下文不能单独支撑写入或重复推进", async t => {
  const s = fixture(t, []), old = seed(s, "连接方式 TCP。"); s.store.setAttributes(old.id, { subject: "传输协议", facet: "类型" });
  s.store.source({ id: "context", sessionId: "synthetic", eventId: "context", projectId: workspace, role: "user", text: "上一条讨论网络。", turnId: "t" }); s.store.db.prepare("UPDATE sources SET processed=1 WHERE id='context'").run();
  s.store.source({ id: "new", sessionId: "synthetic", eventId: "new", projectId: workspace, role: "user", text: "传输协议改为 QUIC。", turnId: "t2" });
  const prepared = await prepareOperations(s, [s.store.getSource("new")], workspace, { cloud: false }); assert.ok(prepared.existing.some(r => r.id === old.id)); assert.ok(prepared.sources.some(r => r.id === "context" && r.contextOnly));
  model(s, p => draft([operation(p, { content: "上下文冒充新事实", evidence: [{ sourceId: "context", anchorId: "p1" }] })])); await work(s); assert.equal(rows(s).length, 1); assert.equal(s.store.getSource("context").processed, 1); assert.equal(s.store.getSource("new").processed, 1);
});
test("恢复：复核超时与已收坏 JSON 不重发，既有事实与检查点保留", async t => {
  for (const mode of ["unknown", "json", "length"]) {
    const s = fixture(t), old = seed(s); const calls = model(s, p => draft([operation(p, { content: "另一独立事实" })]), () => { if (mode === "unknown") throw Error("合成超时"); return { text: "{", finish: mode === "length" ? "length" : "stop" }; });
    await work(s); await s.invoke({ action: "retry" }); await s.work("extract"); assert.equal(calls.length, 2); assert.equal(rows(s).length, 1); assert.equal(s.store.get(old.id).status, "active"); assert.equal(s.store.getSource("s0").processed, 0); assert.equal(s.store.stage(jobs(s)[0].id, "verification").state, mode === "unknown" ? "interrupted" : "done");
  }
});
test("恢复：一项坏复核的添加或排序不改变合法项结果，错误记录保留", async t => {
  for (const mode of ["missing", "duplicate", "unknown", "evidence", "reverse"]) {
    const s = fixture(t); model(s, p => draft([operation(p), operation(p, { content: "第二事实" })]), p => {
      const r = approve(p); if (mode === "missing") r.units.pop(); if (mode === "duplicate") r.units.push(r.units[1]); if (mode === "unknown") r.units.push({ ...r.units[1], members: ["unknown"] }); if (mode === "evidence") r.units[1].evidence[0] = { sourceId: "fake", anchorId: "p1" }; if (mode === "reverse") r.units.reverse(); return r;
    }); await work(s); assert.ok(s.store.eligible(workspace).some(r => r.content === "项目使用 SQLite。")); assert.equal(rows(s).length, ["unknown", "reverse"].includes(mode) ? 2 : 1); if (mode !== "reverse") assert.ok(s.store.operations().some(r => r.outcome === "review-required")); assert.equal(s.store.getSource("s0").processed, 1);
  }
});
test("工具：不能顺带执行多提议，遗忘幂等不返回旧正文，不推进原消息", async t => {
  const s = fixture(t), old = seed(s); s.store.source({ id: "latest", sessionId: "synthetic", eventId: "latest", projectId: workspace, role: "user", text: `忘掉 ${old.id}。`, turnId: "t" });
  const calls = model(s, p => draft([targetOp(p, old, { action: "forget", intent: "forget", content: "" })])); const context = { kind: "agent", workspace, sessionId: "synthetic" };
  const first = await s.invoke({ action: "forget", id: old.id, version: old.version }, context), again = await s.invoke({ action: "forget", id: old.id, version: old.version }, context); assert.equal(first.outcome, "applied"); assert.equal(again.content, undefined); assert.equal(calls.length, 2); assert.equal(s.store.getSource("latest").processed, 0);
  const x = fixture(t); const extra = model(x, p => draft([operation(p), operation(p, { content: "额外事实" })])); await assert.rejects(x.manual({ content: "项目使用 SQLite。", kind: "fact", scope: "project" }, context), /多个提议/); assert.equal(extra.length, 1); assert.equal(rows(x).length, 0);
});
test("工具：暂不可用后复用请求；暂停时普通写入也不得绕过统一复核", async t => {
  let now = 1000, ready = false; const s = fixture(t, undefined, { now: () => now }), calls = model(s, p => draft([operation(p)]));
  s.extractor.assertReady = async () => { if (!ready) { const e = Error("等待已选模型"); e.code = "WAIT_DSH_MODEL"; throw e; } };
  const context = { kind: "agent", workspace, sessionId: "synthetic" }, input = { content: "项目使用 SQLite。", kind: "fact", scope: "project" };
  await assert.rejects(s.manual(input, context), /等待/); assert.equal(calls.length, 0); ready = true; now = 40000; await s.work("memory"); assert.equal(rows(s)[0].status, "active"); assert.equal(calls.length, 2);
});
test("兼容：未来数据库版本拒绝；旧阶段版本不匹配不重发、不重置检查点", async t => {
  const s = fixture(t), calls = model(s, () => assert.fail("不发送")); s.schedule("synthetic"); const job = s.store.claim("extract"); s.store.startStage(job, "input", "old"); s.store.finishStage(job, "input", { protocolVersion: 4 }); s.store.db.prepare("UPDATE jobs SET status='pending',next_at=0 WHERE id=?").run(job.id); await s.work("extract"); assert.equal(calls.length, 0); assert.equal(s.store.getSource("s0").processed, 0); assert.equal(jobs(s)[0].status, "failed");
  const dir = mkdtempSync(join(tmpdir(), "dsh-kernel-future-")); t.after(() => { assert.ok(relative(resolve(tmpdir()), resolve(dir)).startsWith("dsh-kernel-future-")); rmSync(dir, { recursive: true, force: true }); }); const file = join(dir, "future.sqlite"), db = new DatabaseSync(file); db.exec("PRAGMA user_version=99"); db.close(); assert.throws(() => new MemoryStore(file), /版本过新/);
});

test("采集：保留分片顺序、未覆盖范围与检查点，不把局部整理当全文完成", async t => {
  const s = fixture(t, [], { now: () => 1 }), session = { id: "capture", header: { id: "capture", cwd: workspace } };
  s.capture(session, { type: "turn/start", time: 2, seq: 1, data: { turnId: "turn" } });
  s.capture(session, { type: "user/message", time: 3, seq: 2, data: { source: { kind: "user" }, content: [{ type: "text", text: "甲".repeat(10000) }] } });
  s.capture(session, { type: "turn/end", time: 4, seq: 3 }); const pieces = s.store.pendingSources("capture");
  assert.ok(pieces.length > 1); assert.ok(pieces.every(r => r.truncated && r.part_count === pieces.length && r.original_chars === 10000)); assert.equal(pieces[1].span_start, pieces[0].span_end); assert.equal(pieces.at(-1).span_end, pieces[0].retained_chars);
  model(s, () => draft([])); s.schedule("capture"); await s.work("extract"); assert.equal(s.store.getSource(pieces[0].id).processed, 1); assert.ok(pieces.some(r => !s.store.getSource(r.id).processed));
});
test("兼容：来源已被处理的旧任务也不能伪装完成；已保存路由重启保持", async t => {
  const s = fixture(t); s.store.enqueue("extract", "legacy-processed", { sourceIds: ["s0"], projectId: workspace }); s.store.db.prepare("UPDATE sources SET processed=1").run(); model(s, () => assert.fail("不发送")); await s.work("extract"); assert.equal(jobs(s)[0].status, "failed"); assert.equal(s.store.getSource("s0").processed, 1);
  const dir = mkdtempSync(join(tmpdir(), "dsh-kernel-route-")); t.after(() => { assert.ok(relative(resolve(tmpdir()), resolve(dir)).startsWith("dsh-kernel-route-")); rmSync(dir, { recursive: true, force: true }); }); const file = join(dir, "isolated.sqlite"), first = new MemoryStore(file), route = { provider: "synthetic", model: "synthetic" }; first.configure({ extractionRoute: route }); first.close(); const second = new MemoryStore(file); assert.deepEqual(second.settings().extractionRoute, route); second.close();
});
test("工具：遗忘后重复保存请求不返回旧正文，关联缓存失效", async t => {
  const s = fixture(t), calls = model(s, p => draft([operation(p)])), input = { content: "项目使用 SQLite。", kind: "fact", scope: "project" }, context = { kind: "agent", workspace, sessionId: "synthetic" };
  const first = await s.manual(input, context); s.store.cache("synthetic-cache", [1, 0]); s.store.forget(first.id); const repeated = await s.manual(input, context); assert.equal(repeated.content, undefined); assert.equal(repeated.outcome, "blocked"); assert.equal(s.store.cached("synthetic-cache"), null); assert.equal(calls.length, 2);
});
test("人工：候选确认检查自身和被替代版本；Agent 不可代为激活旧候选", async t => {
  const s = fixture(t, ["更正项目数据库为 PostgreSQL，但先只存候选。"]), old = seed(s); model(s, p => draft([targetOp(p, old, { authorization: "candidate_only" })])); await work(s);
  const pending = rows(s).find(r => r.status === "pending"); assert.ok(pending); const before = s.store.db.prepare("SELECT count(*) AS n FROM sources").get().n;
  s.manual({ ...old, content: "又一次人工修改", version: old.version }, { workspace }); const afterEdit = s.store.db.prepare("SELECT count(*) AS n FROM sources").get().n; assert.ok(afterEdit > before);
  assert.throws(() => s.manual({ ...pending, version: pending.version }, { workspace }), /旧记忆已变化/); assert.equal(s.store.db.prepare("SELECT count(*) AS n FROM sources").get().n, afterEdit);
  model(s, p => draft([targetOp(p, pending, { content: pending.content })])); const result = await s.manual({ ...pending, version: pending.version }, { kind: "agent", workspace, sessionId: "synthetic" }); assert.equal(result.outcome, "rejected"); assert.equal(s.store.get(pending.id).status, "pending");
});
test("恢复：关闭等待工具复核退出，未知结果先持久化再关闭数据库", async t => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-kernel-close-")); t.after(() => { assert.ok(relative(resolve(tmpdir()), resolve(dir)).startsWith("dsh-kernel-close-")); rmSync(dir, { recursive: true, force: true }); }); const filename = join(dir, "isolated.sqlite"), s = fixture(t, undefined, { filename });
  let started; const waiting = new Promise(resolve => { started = resolve; });
  s.extractor = { request: async (phase, raw, signal) => {
    if (phase === "extraction") return { text: JSON.stringify(draft([operation(JSON.parse(raw))])), finish: "stop" };
    started(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Error("合成关闭中断")), { once: true }));
  } };
  const task = s.manual({ content: "项目使用 SQLite。", kind: "fact", scope: "project" }, { kind: "agent", workspace, sessionId: "synthetic" }), rejected = assert.rejects(task, /合成关闭中断/); await waiting; await s.close(); await rejected;
  const reopened = new MemoryStore(filename); assert.equal(reopened.db.prepare("SELECT state FROM job_stages WHERE phase='verification'").get().state, "interrupted"); assert.equal(reopened.list({ status: "all" }).length, 0); reopened.close();
});
