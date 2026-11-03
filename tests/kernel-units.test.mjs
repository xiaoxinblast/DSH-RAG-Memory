import test from "node:test";
import assert from "node:assert/strict";
import * as protocol from "../src/extraction.mjs";
import { decideOperation } from "../src/policy.mjs";
import { fixture, operation, model, draft, work, workspace, jobs } from "./helpers/kernel.mjs";

// New synthetic v7 contracts, never converted from paid model responses.
const ref = sourceId => ({ sourceId, anchorId: "p1" });
const sources = [{ id: "s0", role: "user", text: "所有项目使用中文。" }, { id: "s1", role: "user", text: "请长期记住上述偏好。" }];
const input = { sources: sources.map(s => ({ sourceId: s.id, anchors: [{ id: "p1" }] })) };
const parse = operations => protocol.parseOperations(JSON.stringify(draft(operations)), sources);
const forget = (targetId, targetVersion) => ({ action: "forget", targetId, targetVersion, evidence: [ref("s0")], authorizationEvidence: [ref("s0")], certainty: "confirmed", authorization: "explicit" });
const approve = (p, members = p.items.map(o => [o.id])) => ({ version: protocol.PROTOCOL_VERSION, units: members.map(ids => {
  const items = ids.map(id => p.items.find(o => o.id === id)), first = items[0];
  return { members: ids, decision: "approve", reason: "合成分组判断", certainty: first.certainty, authorization: first.authorization, evidence: items.flatMap(o => o.evidence), authorizationEvidence: first.authorizationEvidence, ...(first.action === "forget" ? {} : { eventState: first.eventState, unit: "self_contained", restores: first.restores }) };
}) });

test("v7 契约：两阶段提示各自投影，不再展示另一阶段的输出字段", () => {
  assert.equal(protocol.PROTOCOL_VERSION, 7);
  assert.ok(!protocol.OPERATIONS_PROMPT.includes('"review"'));
  assert.ok(!protocol.OPERATIONS_PROMPT.includes('"decision":'));
  assert.ok(protocol.VERIFICATION_PROMPT.includes('"members"'));
});
test("v7 契约：遗忘只需目标与授权，空元数据一致归一化", () => {
  const d = parse([forget("memory-a", 1), operation(input, { attributes: null })]);
  assert.equal(d.errors.length, 0); assert.equal(d.operations.length, 2);
  assert.deepEqual(d.operations[1].attributes, {});
});
test("v7 证据：事实和明确授权可以来自不同原文锚点", () => {
  const d = parse([operation(input, { content: sources[0].text, kind: "preference", scope: "global", authorization: "explicit", evidence: [ref("s0")], authorizationEvidence: [ref("s1")] })]);
  assert.equal(d.errors.length, 0);
  assert.equal(d.operations[0].authorizationEvidence[0].sourceId, "s1");
});
test("v7 最终单元：端口与必要限制合为一条，独立事实单独写入", async t => {
  const texts = ["项目 API 监听8123。", "API 仅绑定本机回环，不对外开放。", "项目语言为中文。"], s = fixture(t, texts);
  model(s, p => draft(texts.map((content, i) => operation(p, { content, evidence: [ref(`s${i}`)] }))), p => approve(p, [["op0", "op1"], ["op2"]]));
  await work(s);
  assert.deepEqual(s.store.eligible(workspace).map(r => r.content).sort(), [texts.slice(0, 2).join("\n"), texts[2]].sort());
  const found = await s.search("8123", workspace, { cloud: false });
  assert.equal(found.length, 1); assert.equal(found[0].content, texts.slice(0, 2).join("\n"));
});
test("v7 遗忘：最小操作执行原事务，另一条事实仍可写入", async t => {
  const s = fixture(t, ["忘掉项目使用SQLite。", "项目语言为中文。"]);
  const old = s.manual({ content: "项目使用SQLite。", kind: "fact", scope: "project" }, { workspace });
  model(s, p => draft([forget(old.id, old.version), operation(p, { content: "项目语言为中文。", evidence: [ref("s1")] })]), p => approve(p));
  await work(s); assert.equal(s.store.get(old.id).status, "forgotten");
  assert.deepEqual(s.store.eligible(workspace).map(r => r.content), ["项目语言为中文。"]);
});

test("v7 契约：投影生成的例子经同一解析器验证，旧包装与旧协议不猜测恢复", () => {
  const src = [{ id: "example", role: "user", text: "项目语言为中文。忘掉 old。" }];
  const d = protocol.parseOperations(JSON.stringify(protocol.EXAMPLES.extraction), src, [{ id: "old", scope: "global" }]);
  assert.equal(d.errors.length, 0); assert.equal(d.operations[1].scope, "global");
  const r = protocol.parseReview(JSON.stringify(protocol.EXAMPLES.verification), src, d.operations);
  assert.equal(r.errors.length, 0); assert.equal(r.units.length, 2);
  assert.equal(parse([{ operation: operation(input), review: { decision: "approve" } }]).errors.length, 1);
  for (const version of [4, 5, 6]) assert.throws(() => protocol.parseOperations(JSON.stringify({ version, operations: [] }), src));
  for (const patch of [{ attributes: [] }, { attributes: { subject: 1 } }, { attributes: { validUntil: false } }, { attributes: { extra: "x" } }, { unit: "control" }]) assert.equal(parse([operation(input, patch)]).errors.length, 1);
});

test("v7 授权：独立授权来源确实可生效，复核单方补授权不能生效", async t => {
  for (const authorized of [true, false]) {
    const s = fixture(t, sources.map(s => s.text));
    model(s, p => draft([operation(p, { content: sources[0].text, kind: "preference", scope: "global", authorization: "explicit", evidence: [ref("s0")], authorizationEvidence: authorized ? [ref("s1")] : [] })]), p => {
      const r = approve(p); r.units[0].authorizationEvidence = [ref("s1")]; return r;
    });
    await work(s); assert.equal(s.store.eligible("d:/other").length, authorized ? 1 : 0);
  }
});

test("v7 遗忘授权：分离的授权锚点也遮蔽，邻接的独立事实保留", async t => {
  const s = fixture(t, ["旧端口配置。", "请忘掉它。项目语言中文。"]);
  const old = s.manual({ content: "旧端口配置。", kind: "fact", scope: "project" }, { workspace });
  model(s, p => draft([{ ...forget(old.id, old.version), authorizationEvidence: [ref("s1")] }, operation(p, { content: "项目语言中文。", evidence: [{ sourceId: "s1", anchorId: "p2" }] })]), p => approve(p));
  await work(s); assert.equal(s.store.get(old.id).status, "forgotten");
  const masked = s.store.maskSource(s.store.getSource("s1")).text;
  assert.ok(!masked.includes("请忘掉它")); assert.ok(masked.includes("项目语言中文"));
  assert.deepEqual(s.store.eligible(workspace).map(r => r.content), ["项目语言中文。"]);
});

test("v7 授权边界：控制授权与事实不可分时同时挂起，跨项目授权拒绝", async t => {
  const s = fixture(t, ["旧端口配置。", "忘掉它同时记住项目端口9000。"]);
  const old = s.manual({ content: "旧端口配置。", kind: "fact", scope: "project" }, { workspace });
  model(s, p => draft([{ ...forget(old.id, old.version), authorizationEvidence: [ref("s1")] }, operation(p, { content: "项目端口9000。", evidence: [ref("s1")] })]), p => approve(p));
  await work(s); assert.equal(s.store.get(old.id).status, "active"); assert.equal(s.store.list({ status: "all" }).length, 1);
  const src = sources.map((s, i) => ({ ...s, project_id: i ? "d:/foreign" : workspace }));
  const d = protocol.parseOperations(JSON.stringify(draft([operation(input, { kind: "preference", scope: "global", authorization: "explicit", evidence: [ref("s0")], authorizationEvidence: [ref("s1")] })])), src);
  const o = d.operations[0], review = { ...o, decision: "approve", reason: "模拟误批跨项目授权" };
  assert.equal(decideOperation(o, review, { sources: src, workspace }).outcome, "rejected");
});

test("v7 单元隔离：乱序不改正文顺序，重复或未知成员冻结整组，独立组继续", async t => {
  for (const mode of ["reverse", "duplicate", "unknown", "missing", "invalid", "forged", "empty"]) {
    const texts = ["API 监听8123。", "API 只允许回环访问。", "项目语言中文。"], s = fixture(t, texts);
    model(s, p => draft(texts.map((content, i) => operation(p, { content, evidence: [ref(`s${i}`)] }))), p => {
      const r = approve(p, [["op1", "op0"], ["op2"]]);
      if (mode === "duplicate") r.units.push({ ...r.units[0], members: ["op0"] });
      if (mode === "unknown") r.units[0].members.push("foreign");
      if (mode === "missing") r.units.shift();
      if (mode === "invalid") r.units[0].decision = "pending";
      if (mode === "forged") r.units[0].evidence = [ref("foreign")];
      if (mode === "empty") r.units[0].members = [];
      return r;
    });
    await work(s); const got = s.store.eligible(workspace).map(r => r.content).sort();
    assert.deepEqual(got, (mode === "reverse" ? [texts.slice(0, 2).join("\n"), texts[2]] : [texts[2]]).sort(), mode);
    assert.equal(s.store.getSource("s0").processed, 1);
    if (mode !== "reverse") assert.ok(s.store.operations().some(r => r.outcome === "review-required"));
  }
});

test("v7 单元边界：状态、作用域、属性冲突与超长整组挂起，不回退成半条", async t => {
  for (const patch of [{ certainty: "unresolved" }, { authorization: "candidate_only" }, { scope: "global" }, { kind: "rule" }, { eventState: "planned" }, { attributes: { subject: "另一主体" } }, { intent: "rerecord" }, { unit: "incomplete" }, { content: "长".repeat(300) }]) {
    const s = fixture(t, ["甲事实。", "甲的必要条件。", "独立事实。"]);
    model(s, p => draft([operation(p, { content: "甲事实。", evidence: [ref("s0")] }), operation(p, { content: "甲的必要条件。", evidence: [ref("s1")], ...patch }), operation(p, { content: "独立事实。", evidence: [ref("s2")] })]), p => approve(p, [["op0", "op1"], ["op2"]]));
    await work(s); assert.deepEqual(s.store.list({ status: "all" }).map(r => r.content), ["独立事实。"], JSON.stringify(patch));
  }
});

test("v7 单元保护：拼接不能冲淡成员墓碑、助手来源或仅上下文证据", async t => {
  for (const mode of ["forgotten", "assistant", "context"]) {
    const s = fixture(t, [{ text: "旧系统使用SQLite。", role: mode === "assistant" ? "assistant" : "user" }, "旧系统仅限内网。"]);
    if (mode === "forgotten") { const old = s.manual({ content: "旧系统使用SQLite。", kind: "fact", scope: "project" }, { workspace }); s.store.forget(old.id); }
    if (mode === "context") s.store.db.prepare("UPDATE sources SET processed=1 WHERE id='s0'").run();
    model(s, p => draft([operation(p, { content: "旧系统使用SQLite。", evidence: [ref("s0")] }), operation(p, { content: "旧系统仅限内网。", evidence: [ref("s1")] })]), p => approve(p, [["op0", "op1"]]));
    await work(s); assert.equal(s.store.eligible(workspace).length, 0, mode);
  }
});

test("v7 单元授权：一项缺授权不能借同组另一项的授权升为全局", async t => {
  const s = fixture(t, ["所有项目使用中文。", "所有项目说明保留术语原文。", "请长期记住上述规则。"]);
  model(s, p => draft([0, 1].map(i => operation(p, { content: i ? "说明保留术语原文。" : "所有项目使用中文。", scope: "global", kind: "preference", authorization: "explicit", evidence: [ref(`s${i}`)], authorizationEvidence: i ? [] : [ref("s2")] }))), p => {
    const r = approve(p, [["op0", "op1"]]); r.units[0].authorizationEvidence = [ref("s2")]; return r;
  });
  await work(s); assert.equal(s.store.eligible("d:/other").length, 0);
  assert.equal(s.store.list({ status: "all" })[0].status, "pending");
});

test("v7 恢复：合并单元与遗忘同一事务，凭证失败回滚，重放不再请求模型", async t => {
  let now = 1000; const s = fixture(t, ["忘掉旧端口配置。", "API 监听8123。", "API 只允许回环访问。"], { now: () => now });
  const old = s.manual({ content: "旧端口配置。", kind: "fact", scope: "project" }, { workspace });
  const calls = model(s, p => draft([forget(old.id, old.version), ...[1, 2].map(i => operation(p, { content: i === 1 ? "API 监听8123。" : "API 只允许回环访问。", evidence: [ref(`s${i}`)] }))]), p => approve(p, [["op0"], ["op1", "op2"]]));
  const receipt = s.store.receipt.bind(s.store); let remaining = 2;
  s.store.receipt = (...args) => { if (--remaining === 0) throw Error("合成凭证事务失败"); return receipt(...args); };
  await work(s); assert.equal(s.store.get(old.id).status, "active"); assert.equal(s.store.getSource("s0").processed, 0);
  assert.deepEqual(s.store.getMeta("control:s0", []), []);
  now += 200000; await s.work("extract"); assert.equal(calls.length, 2); assert.equal(s.store.get(old.id).status, "forgotten");
  assert.deepEqual(s.store.eligible(workspace).map(r => r.content), ["API 监听8123。\nAPI 只允许回环访问。"]);
  const receipts = s.store.operations().filter(r => r.job_id); assert.equal(receipts.length, 2);
  assert.deepEqual(receipts.find(r => r.action === "add").details.operation.members.map(o => o.id), ["op1", "op2"]);
});

test("v7 兼容：协议6已付费结果原样保留，不解释、不重发、不推进", async t => {
  const s = fixture(t); s.store.enqueue("extract", "old-six", { protocolVersion: 6, sourceIds: ["s0"], projectId: workspace });
  const job = s.store.claim("extract"), raw = { version: 6, raw: { text: '{"version":6,"operations":[]}', finish: "stop" } };
  s.store.startStage(job, "extraction", "old-input"); s.store.finishStage(job, "extraction", raw);
  s.store.db.prepare("UPDATE jobs SET status='pending',next_at=0 WHERE id=?").run(job.id);
  const calls = model(s, () => assert.fail("不能重发")); await s.work("extract");
  assert.equal(calls.length, 0); assert.equal(jobs(s)[0].status, "failed"); assert.equal(s.store.getSource("s0").processed, 0);
  assert.deepEqual(s.store.stage(job.id, "extraction").response, raw);
});

test("v7 已知语义边界：双方误把依赖拆成独立组时，宿主不会用词表猜出依赖", async t => {
  const s = fixture(t, ["API 监听8123。", "API 仅限回环访问。"]);
  model(s, p => draft([operation(p, { content: "API 监听8123。", evidence: [ref("s0")] }), operation(p, { content: "API 仅限回环访问。", evidence: [ref("s1")] })]), p => approve(p));
  await work(s);
  // This intentionally records the residual risk, NOT successful semantic acceptance.
  assert.equal(s.store.eligible(workspace).length, 2);
});
