import test from "node:test";
import assert from "node:assert/strict";
import { fixture, operation, approve, model, draft, work, rows, jobs, workspace } from "./helpers/kernel.mjs";
import { PROTOCOL_VERSION } from "../src/extraction.mjs";

test("kernel 运行：普通新增统一两阶段，空批与 skip 不复核", async t => {
  const s = fixture(t), calls = model(s, p => draft([operation(p)])); await work(s);
  assert.deepEqual(calls.map(c => c.phase), ["extraction", "verification"]); assert.equal(rows(s)[0].status, "active"); assert.equal(s.store.getSource("s0").processed, 1);
  for (const skip of [false, true]) { const x = fixture(t); const c = model(x, p => draft(skip ? [{ action: "skip", evidence: operation(p).evidence }] : [])); await work(x); assert.equal(c.length, 1); assert.equal(rows(x).length, 0); assert.equal(jobs(x)[0].status, "done"); }
});
test("kernel 运行：提炼与复核坏项独立隔离，合法项保存且原始回答可恢复", async t => {
  const s = fixture(t), calls = model(s, p => draft([operation(p), null, operation(p, { content: "候选内容" }), operation(p, { content: "另一事实" })]), p => {
    const r = approve(p); r.units[1].decision = "pending"; r.units.reverse(); return r;
  });
  await work(s); assert.equal(calls.length, 2); assert.equal(rows(s).length, 2);
  assert.ok(rows(s).every(r => r.status === "active")); assert.equal(s.store.getSource("s0").processed, 1);
  const receipts = s.store.operations(); assert.equal(receipts.filter(r => r.outcome === "review-required").length, 3);
  assert.deepEqual(new Set(receipts.filter(r => r.outcome === "applied").map(r => r.details.operation.id)), new Set(["op0", "op3"]));
  assert.equal(JSON.parse(s.store.stage(jobs(s)[0].id, "extraction").response.raw.text).operations[1], null);
});
test("kernel 恢复：已收坏 JSON/截断与未知请求区分，不自动重发", async t => {
  for (const response of [{ text: "{", finish: "stop" }, { text: "{}", finish: "length" }, null]) {
    const s = fixture(t), calls = model(s, () => { if (!response) throw new Error("模拟结果不明"); return response; }); await work(s);
    const job = jobs(s)[0], stage = s.store.stage(job.id, "extraction"); assert.equal(job.status, "failed"); assert.equal(stage.state, response ? "done" : "interrupted");
    assert.equal(s.store.getSource("s0").processed, 0); if (response) assert.equal(stage.response.raw.text, response.text);
    await s.invoke({ action: "retry" }); await s.work("extract"); assert.equal(calls.length, 1); assert.equal(rows(s).length, 0);
  }
});
test("kernel 恢复：事务失败只重放已保存回答，不重发也不重复凭证", async t => {
  let now = 1000; const s = fixture(t, undefined, { now: () => now }), calls = model(s, p => draft([operation(p)]));
  const save = s.store.save.bind(s.store); let once = true; s.store.save = (...args) => { if (once) { once = false; throw new Error("模拟入库失败"); } return save(...args); };
  await work(s); assert.equal(calls.length, 2); assert.equal(s.store.operations().length, 0); assert.equal(s.store.getSource("s0").processed, 0);
  now += 200000; await s.work("extract"); assert.equal(calls.length, 2); assert.equal(rows(s).length, 1); assert.equal(s.store.operations().length, 1);
});
test("kernel 恢复：失去租约不能提交，下一执行者复用已完成阶段", async t => {
  let now = 1000; const s = fixture(t, undefined, { now: () => now }), save = s.store.finishStage.bind(s.store);
  const calls = model(s, p => draft([operation(p)]));
  s.store.finishStage = (...args) => { save(...args); if (args[1] === "verification") now += 130000; };
  await work(s); assert.equal(rows(s).length, 0); assert.equal(s.store.getSource("s0").processed, 0);
  await s.work("extract"); assert.equal(calls.length, 2); assert.equal(rows(s).length, 1);
});
test("kernel 更正：并发修改保留新版本，待确认不覆盖；可按版本回退", async t => {
  const s = fixture(t, ["更正配置使用 B。"]), old = s.manual({ content: "配置使用 A。", kind: "fact", scope: "project" }, { workspace });
  const calls = model(s, p => draft([operation(p, { action: "update", intent: "correct", authorization: "explicit", content: "配置使用 B。", targetId: old.id, targetVersion: old.version })]), p => {
    s.manual({ ...old, content: "配置继续使用 C。", version: old.version }, { workspace }); return approve(p);
  });
  await work(s); assert.equal(calls.length, 2); assert.equal(s.store.get(old.id).content, "配置继续使用 C。"); assert.equal(rows(s).find(r => r.content === "配置使用 B。").status, "pending");
});
test("kernel 遗忘：同批忘 A 保留 B，已遗忘原条目不复活", async t => {
  const s = fixture(t, ["忘掉项目使用 SQLite。项目端口为 9000。"]), old = s.manual({ content: "项目使用 SQLite。", kind: "fact", scope: "project" }, { workspace });
  model(s, p => draft([operation(p, { action: "forget", intent: "forget", content: "", authorization: "explicit", targetId: old.id, targetVersion: old.version, evidence: [{ sourceId: "s0", anchorId: "p1" }] }), operation(p, { content: "项目端口为 9000。", evidence: [{ sourceId: "s0", anchorId: "p2" }] })]));
  await work(s); assert.equal(s.store.get(old.id).status, "forgotten"); assert.equal(s.store.eligible(workspace)[0].content, "项目端口为 9000。");
});
test("kernel 遗忘：提炼期间的遗忘使旧批次失效，复核不再发送", async t => {
  const s = fixture(t), old = s.manual({ content: "项目使用 SQLite。", kind: "fact", scope: "project" }, { workspace });
  const calls = model(s, p => { s.store.forget(old.id); return draft([operation(p)]); }); await work(s);
  assert.equal(calls.length, 1); assert.equal(s.store.eligible(workspace).length, 0); assert.ok(s.store.operations().some(r => r.outcome === "blocked"));
});
test("kernel 兼容：旧任务停止，来源不重新排入新版本付费处理", async t => {
  const s = fixture(t); s.store.enqueue("extract", "legacy", { sourceIds: ["s0"], projectId: workspace }); const calls = model(s, () => { throw Error("不得调用"); });
  await work(s); assert.equal(calls.length, 0); assert.equal(jobs(s).length, 1); assert.equal(jobs(s)[0].status, "failed"); assert.equal(s.store.getSource("s0").processed, 0);
  s.schedule("synthetic"); assert.equal(jobs(s).length, 1); assert.ok(!JSON.parse(jobs(s)[0].payload).protocolVersion);
});
test("kernel 工具：真实用户来源，同一两阶段，严格限制请求边界并幂等", async t => {
  const s = fixture(t, ["请记住项目使用 SQLite。"]), context = { kind: "agent", workspace, sessionId: "synthetic" };
  const calls = model(s, p => draft([operation(p)])); const input = { content: "项目使用 SQLite。", kind: "fact", scope: "project" };
  const result = await s.manual(input, context); assert.equal(result.status, "active"); assert.equal(calls.length, 2); assert.equal(s.store.getSource("s0").processed, 0);
  assert.equal((await s.manual(input, context)).id, result.id); assert.equal(calls.length, 2);
  assert.ok(calls[0].payload.sources.some(x => x.anchors.some(a => a.text === "请记住项目使用 SQLite。")));
  const x = fixture(t, ["只记住请求内容。"]); model(x, p => draft([operation(p, { scope: "global", kind: "rule", authorization: "explicit" })]));
  assert.equal((await x.manual(input, context)).outcome, "rejected"); assert.equal(rows(x).length, 0);
});
test("kernel 人工：直接编辑不调用模型，版本和遗忘保护仍有效", t => {
  const s = fixture(t); const calls = model(s, () => { throw Error("不能调用"); });
  const row = s.manual({ content: "人工事实", kind: "fact", scope: "project" }, { workspace });
  assert.throws(() => s.manual({ ...row, version: 99 }, { workspace }), /修改/);
  s.store.forget(row.id); assert.equal(s.manual({ ...row, version: row.version }, { workspace }).blocked, true); assert.equal(s.store.get(row.id).status, "forgotten"); assert.equal(calls.length, 0);
});
test("kernel 调度：版本写入任务，来源检查点只在处理凭证提交后推进", async t => {
  const s = fixture(t); model(s, p => draft([operation(p, { certainty: "unresolved" })])); await work(s);
  assert.equal(JSON.parse(jobs(s)[0].payload).protocolVersion, PROTOCOL_VERSION); assert.equal(rows(s)[0].status, "pending"); assert.equal(s.store.eligible(workspace).length, 0);
});
