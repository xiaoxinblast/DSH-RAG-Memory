import test from "node:test";
import assert from "node:assert/strict";
import { parseOperations, parseReview, PROTOCOL_VERSION, OPERATIONS_PROMPT, CONTRACT, stageContract } from "../src/extraction.mjs";
import { hash, normalize } from "../src/domain.mjs";
import { prepareOperations } from "../src/operations.mjs";
import { fixture, operation, approve, model, draft, work, workspace } from "./helpers/kernel.mjs";

// Synthetic judgments exercise the host contract, not model understanding or accuracy.
const ref = (sourceId, anchorId = "p1") => ({ sourceId, anchorId });
const unit = (p, patch = {}) => operation(p, { unit: "self_contained", authorizationEvidence: [], restores: null, ...patch });
const reviewUnits = (p, patch = {}) => approve(p, { unit: "self_contained", authorizationEvidence: [], restores: null, ...patch });
const seed = (s, text = "邮件索引使用SQLite。") => {
  const id = s.store.source({ sessionId: "seed", projectId: workspace, eventId: text, role: "user", text, turnId: "seed" });
  return s.store.save({ content: text, kind: "fact", scope: "project", projectId: workspace, evidence: [{ sourceId: id, quote: text }], ranges: [{ sourceId: id, start: 0, end: text.length }] });
};

test("统一契约：skip 的说明与解析一致，额外字段不能静默丢弃", () => {
  assert.match(OPERATIONS_PROMPT, /skip 只能/);
  const sources = [{ id: "s", text: "无需保存。", role: "user" }];
  const r = parseOperations(JSON.stringify(draft([{ action: "skip", evidence: [ref("s")] }, { action: "skip", evidence: [ref("s")], content: "额外" }])), sources);
  assert.equal(r.operations.length, 1); assert.equal(r.errors.length, 1);
});

test("统一契约：完整正文允许复核补齐来源，补证实际进入来源范围", async t => {
  const text = "仅在离线模式下，邮件索引才使用SQLite；在线模式使用PostgreSQL。", s = fixture(t, [text]);
  model(s, p => draft([unit(p, { content: text, evidence: [ref("s0")] })]), p => reviewUnits(p, { evidence: p.sources[0].anchors.map(a => ref("s0", a.id)) }));
  await work(s); const rows = s.store.eligible(workspace); assert.equal(rows.length, 1);
  assert.equal(s.store.db.prepare("SELECT count(*) AS n FROM evidence_ranges WHERE memory_id=?").get(rows[0].id).n, 3);
});

test("统一契约：补证不能借其他用户片段扩大操作授权", async t => {
  const s = fixture(t, ["本项目用中文。", "另一个话题请长期记住。"]);
  model(s, p => draft([unit(p, { content: "所有项目使用中文。", scope: "global", kind: "preference", authorization: "explicit", evidence: [ref("s0")], authorizationEvidence: [] })]), p => reviewUnits(p, { authorization: "explicit", evidence: [ref("s0"), ref("s1")], authorizationEvidence: [ref("s1")] }));
  await work(s); assert.equal(s.store.eligible(workspace).length, 0);
});

test("完整单位：任一阶段发现拆散限定均不入记忆表，独立项不受影响", async t => {
  for (const side of ["extraction", "verification"]) {
    const s = fixture(t, ["导出任务使用端口9460。", "它仅允许本地访问，外部地址禁止访问。", "项目语言为中文。"]);
    model(s, p => draft([unit(p, { content: "导出任务使用端口9460。", evidence: [ref("s0")], unit: side === "extraction" ? "incomplete" : "self_contained" }), unit(p, { content: "项目语言为中文。", evidence: [ref("s2")] })]), p => { const r = reviewUnits(p); if (side === "verification") r.units[0].unit = "incomplete"; return r; });
    await work(s); assert.deepEqual(s.store.list({ status: "all" }).map(r => r.content), ["项目语言为中文。"]);
    assert.ok(s.store.operations().some(r => r.outcome === "review-required"));
  }
});

test("完整单位：完整跨句限定一条保存，召回不拆开", async t => {
  const content = "导出任务使用端口9460，仅允许本地访问，禁止外部地址访问。", s = fixture(t, ["导出任务使用端口9460。", "它仅允许本地访问，外部地址禁止访问。"]);
  model(s, p => draft([unit(p, { content })]), reviewUnits); await work(s);
  assert.deepEqual(s.store.eligible(workspace).map(r => r.content), [content]);
  const recalled = await s.recall("synthetic", "msg", workspace, "9460"); assert.ok(JSON.stringify(recalled).includes(content));
});

test("遗忘：旧正文包装成新规则也受本地保护，不依赖可选主体属性", async t => {
  const s = fixture(t, ["重启后请保持遗忘邮件索引使用SQLite，不要从日志恢复。"]), old = seed(s); s.store.forget(old.id);
  model(s, p => draft([unit(p, { content: "用户要求保持遗忘邮件索引使用SQLite，不要从日志恢复。", kind: "rule" })]), reviewUnits);
  await work(s); assert.equal(s.store.get(old.id).status, "forgotten"); assert.equal(s.store.eligible(workspace).length, 0);
});

test("遗忘：控制不能伪装为普通规则；重复保护只记凭证并遮蔽控制来源", async t => {
  const s = fixture(t, []), old = seed(s); s.store.forget(old.id);
  s.store.source({ id: "s0", sessionId: "synthetic", projectId: workspace, eventId: "new", role: "user", text: `请保持遗忘 ${old.id}。项目端口9000。`, turnId: "t" });
  const protectedRow = s.store.get(old.id);
  const calls = model(s, p => { assert.ok(!JSON.stringify(p).includes(old.content)); return draft([unit(p, { action: "forget", intent: "forget", unit: "control", content: "", targetId: old.id, targetVersion: protectedRow.version, authorization: "explicit", evidence: [ref("s0")], authorizationEvidence: [ref("s0")] }), unit(p, { content: "项目端口9000。", evidence: [ref("s0", "p2")] })]); }, p => { const r = reviewUnits(p); Object.assign(r.units[0], { authorization: "explicit", authorizationEvidence: [ref("s0")] }); return r; });
  await work(s); assert.equal(calls.length, 2); assert.equal(s.store.get(old.id).version, protectedRow.version);
  assert.deepEqual(s.store.eligible(workspace).map(r => r.content), ["项目端口9000。"]);
  const control = s.store.operations().find(r => r.action === "forget"); assert.equal(control.outcome, "applied");
  assert.ok(!s.store.maskSource(s.store.getSource("s0")).text.includes(old.id));
  assert.ok(s.store.maskSource(s.store.getSource("s0")).text.includes("项目端口9000"));
});

test("遗忘：布尔重记许可不能绕过任意墓碑", t => {
  const s = fixture(t), old = seed(s); s.store.forget(old.id);
  assert.equal(s.store.blocked(old.content, [], { scope: "project", project: workspace, authorizedRerecord: true }), true);
});

test("协议：坏完整性字段与伪造复核引用只冻结相应项", () => {
  const sources = [{ id: "s", role: "user", text: "独立事实。" }], payload = { sources: [{ sourceId: "s", anchors: [{ id: "p1" }] }] };
  const d = parseOperations(JSON.stringify(draft([unit(payload), unit(payload, { unit: "yes" }), unit(payload)])), sources);
  assert.deepEqual(d.operations.map(o => o.id), ["op0", "op2"]);
  const p = { items: d.operations.map(o => ({ ...o, evidence: [ref("s")], authorizationEvidence: [] })) }, r = reviewUnits(p); r.units[1].evidence = [ref("fake")];
  const result = parseReview(JSON.stringify({ ...r, version: PROTOCOL_VERSION }), sources, d.operations);
  assert.deepEqual(result.units.map(o => o.id), ["op0"]);
});

test("契约：单一声明的字段、版本、枚举和上限进入提示词及解析", () => {
  assert.ok(OPERATIONS_PROMPT.includes(JSON.stringify(stageContract("extraction"))));
  const sources = [{ id: "s", role: "user", text: "独立事实。" }], p = { sources: [{ sourceId: "s", anchors: [{ id: "p1" }] }] };
  for (const field of CONTRACT.fields.add.filter(k => k !== "attributes")) {
    const o = unit(p); delete o[field]; assert.equal(parseOperations(JSON.stringify(draft([o])), sources).errors.length, 1, field);
  }
  assert.equal(parseOperations(JSON.stringify(draft([unit(p, { content: "字".repeat(CONTRACT.maxContent + 1) })])), sources).errors.length, 1);
  assert.equal(parseOperations(JSON.stringify(draft([{ ...unit(p, { action: "forget" }), content: "不得作为正文" }])), sources).errors.length, 1);
  assert.throws(() => parseOperations(JSON.stringify({ version: 5, operations: [] }), sources));
});

test("证据：辅助上下文可补全正文，但不得单独授权全局写入", async t => {
  const s = fixture(t, ["仅限本地访问。", "导出任务使用端口9460。"]); s.store.db.prepare("UPDATE sources SET processed=1 WHERE id='s0'").run();
  model(s, p => draft([unit(p, { content: "导出任务使用端口9460，仅限本地访问。", evidence: [ref("s1")] })]), p => reviewUnits(p, { evidence: [ref("s0"), ref("s1")] })); await work(s);
  assert.equal(s.store.eligible(workspace).length, 1);
  const x = fixture(t, ["所有项目使用中文。", "这次用中文。"]); x.store.db.prepare("UPDATE sources SET processed=1 WHERE id='s0'").run();
  model(x, p => draft([unit(p, { scope: "global", kind: "preference", content: "所有项目使用中文。", authorization: "explicit", evidence: [ref("s0"), ref("s1")], authorizationEvidence: [ref("s0")] })]), p => reviewUnits(p, { authorization: "explicit", authorizationEvidence: [ref("s0")] })); await work(x);
  assert.equal(x.store.eligible(workspace).length, 0);
});

test("补证：明确适用时间可由复核补齐，不能用补证掩盖无来源日期", async t => {
  for (const date of ["2026-11-30", "2026-12-30"]) {
    const s = fixture(t, ["临时服务仅限内网。", "有效期截至2026-11-30。"]);
    model(s, p => draft([unit(p, { content: "临时服务仅限内网，有效期截至2026-11-30。", evidence: [ref("s0")], attributes: { validUntil: date } })]), p => reviewUnits(p, { evidence: [ref("s0"), ref("s1")] }));
    await work(s); assert.equal(s.store.eligible(workspace).length, date === "2026-11-30" ? 1 : 0);
  }
});

test("控制：同一不可分锚点同时提议遗忘和事实时双方挂起，不先遗忘再丢弃事实", async t => {
  const s = fixture(t, ["忘掉邮件索引使用SQLite同时记住端口9000。"]), old = seed(s);
  model(s, p => draft([unit(p, { action: "forget", intent: "forget", unit: "control", content: "", authorization: "explicit", authorizationEvidence: [ref("s0")], targetId: old.id, targetVersion: old.version }), unit(p, { content: "项目端口9000。" })]), p => { const r = reviewUnits(p); Object.assign(r.units[0], { authorization: "explicit", authorizationEvidence: [ref("s0")] }); return r; });
  await work(s); assert.equal(s.store.get(old.id).status, "active"); assert.equal(s.store.list({ status: "all" }).length, 1);
  assert.equal(s.store.operations().filter(r => r.job_id && r.outcome === "review-required").length, 2);
  assert.equal(s.store.maskSource(s.store.getSource("s0")).text, s.store.getSource("s0").text);
});

test("控制：原失败表述在模拟控制识别后只要求澄清，不另存持续规则", async t => {
  const text = "重启后请保持遗忘邮件索引旧方案SQLite，不要从日志恢复。", s = fixture(t, [text]), old = seed(s); s.store.forget(old.id);
  model(s, p => draft([unit(p, { action: "forget", intent: "forget", unit: "control", content: "", authorization: "explicit", authorizationEvidence: [ref("s0")], targetId: null, targetVersion: null })]), p => reviewUnits(p, { unit: "control", authorization: "explicit", authorizationEvidence: [ref("s0")] }));
  await work(s); assert.equal(s.store.eligible(workspace).length, 0); assert.equal(s.store.operations().find(r => r.job_id).outcome, "clarification");
});

test("遗忘候选：缺少主体属性仍从本地关键词找到候选，近义不成为唯一授权", async t => {
  const s = fixture(t, ["重启后请保持遗忘邮件索引旧方案SQLite，不要从日志恢复。"]), old = seed(s); s.store.forget(old.id);
  const p = await prepareOperations(s, [s.store.getSource("s0")], workspace, { cloud: false });
  const candidate = p.protected.find(r => r.id === old.id); assert.equal(candidate?.match, "related"); assert.equal(candidate.content, undefined);
  model(s, input => draft([unit(input, { action: "forget", intent: "forget", unit: "control", content: "", authorization: "explicit", authorizationEvidence: [ref("s0")], targetId: old.id, targetVersion: s.store.get(old.id).version })]), input => reviewUnits(input, { unit: "control", authorization: "explicit", authorizationEvidence: [ref("s0")] }));
  await work(s); assert.equal(s.store.operations().find(r => r.job_id).outcome, "clarification");
});

test("遗忘：原失败表述即使两阶段误批为规则，已命中的近义保护仍挂起", async t => {
  const s = fixture(t, ["重启后请保持遗忘邮件索引旧方案SQLite，不要从日志恢复。"]), old = seed(s); s.store.forget(old.id);
  model(s, p => draft([unit(p, { intent: "statement", kind: "rule", authorization: "explicit", authorizationEvidence: [ref("s0")], content: "用户要求重启后保持遗忘邮件索引旧方案SQLite，不要从日志恢复。" })]), p => reviewUnits(p, { authorization: "explicit", authorizationEvidence: [ref("s0")] }));
  await work(s); assert.equal(s.store.eligible(workspace).length, 0); assert.equal(s.store.operations().find(r => r.job_id).outcome, "review-required");
});

test("遗忘：共享数据库名称但不同主体的新事实不因关键词一起阻断", async t => {
  const s = fixture(t, ["图像库使用SQLite。"]), old = seed(s); s.store.forget(old.id);
  model(s, p => draft([unit(p, { content: "图像库使用SQLite。" })]), reviewUnits); await work(s);
  assert.deepEqual(s.store.eligible(workspace).map(r => r.content), ["图像库使用SQLite。"]);
});

test("遗忘：改成全局规则不能绕过当前项目保护，全局保护也覆盖项目副本", async t => {
  for (const scope of ["project", "global"]) {
    const s = fixture(t, ["请记住邮件索引使用SQLite。"]), text = "邮件索引使用SQLite。", sid = s.store.source({ sessionId: "seed", eventId: "old", projectId: workspace, role: "user", text });
    const old = s.store.save({ content: text, kind: "rule", scope, projectId: workspace, evidence: [{ sourceId: sid, quote: text }], ranges: [{ sourceId: sid, start: 0, end: text.length }] }); s.store.forget(old.id);
    model(s, p => draft([unit(p, { content: old.content, kind: "rule", scope: scope === "project" ? "global" : "project", authorization: "explicit", authorizationEvidence: [ref("s0")] })]), p => reviewUnits(p, { authorization: "explicit", authorizationEvidence: [ref("s0")] }));
    await work(s); assert.equal(s.store.eligible(workspace).length, 0);
  }
});

test("控制：同源其他范围继续可用；控制来源改写或旧任务重放不能写回", async t => {
  const s = fixture(t, ["请忘掉旧配置。新端口9000。"]), range = { sourceId: "s0", start: 0, end: "请忘掉旧配置。".length };
  s.store.protectControl([range]);
  assert.equal(s.store.blocked("换个说法继续保存旧配置", ["s0"], { scope: "project", project: workspace, ranges: [range] }), true);
  const start = range.end, end = s.store.getSource("s0").text.length;
  assert.equal(s.store.blocked("新端口9000。", ["s0"], { scope: "project", project: workspace, ranges: [{ sourceId: "s0", start, end }] }), false);
  const prepared = await prepareOperations(s, [s.store.getSource("s0")], workspace, { cloud: false }); assert.ok(prepared.sources[0].text.includes("新端口9000")); assert.ok(!prepared.sources[0].text.includes("旧配置"));
});

test("重记：许可绑定事实、版本、范围、新来源和正文；不能解除第二个保护", t => {
  let now = 1000; const s = fixture(t, [], { now: () => now }), a = seed(s, "甲系统的保留事实。"), b = seed(s, "乙系统的保留事实。"); s.store.forget(a.id); s.store.forget(b.id); now = 2000;
  const sid = s.store.source({ id: "fresh", sessionId: "synthetic", eventId: "new", projectId: workspace, role: "user", text: "重新记住甲系统的保留事实。", turnId: "t" });
  const grant = { memoryId: a.id, version: s.store.get(a.id).version, scope: "project", project: workspace, sourceIds: [sid], contentHash: hash(normalize(a.content)), operationHash: hash("synthetic-operation") };
  const options = { scope: "project", project: workspace, rerecordGrant: grant, operationHash: grant.operationHash };
  assert.equal(s.store.blocked(a.content, [sid], options), false);
  for (const patch of [{ memoryId: b.id }, { version: grant.version + 1 }, { scope: "global" }, { project: "d:/other" }, { sourceIds: [] }, { contentHash: hash("changed") }, { operationHash: hash("another-operation") }]) assert.equal(s.store.blocked(a.content, [sid], { ...options, rerecordGrant: { ...grant, ...patch } }), true);
  assert.equal(s.store.blocked(a.content, ["old"], options), true);
  const both = a.content + b.content; assert.equal(s.store.blocked(both, [sid], { ...options, rerecordGrant: { ...grant, contentHash: hash(normalize(both)) } }), true);
  s.store.db.prepare("UPDATE sources SET role='assistant' WHERE id=?").run(sid); assert.equal(s.store.blocked(a.content, [sid], options), true);
});

test("恢复：控制凭证失败回滚保护与遗忘；重放复用两阶段回答", async t => {
  let now = 1000; const s = fixture(t, ["忘掉邮件索引使用SQLite。"], { now: () => now }), old = seed(s);
  const calls = model(s, p => draft([unit(p, { action: "forget", intent: "forget", unit: "control", content: "", authorization: "explicit", authorizationEvidence: [ref("s0")], targetId: old.id, targetVersion: old.version })]), p => reviewUnits(p, { unit: "control", authorization: "explicit", authorizationEvidence: [ref("s0")] }));
  const receipt = s.store.receipt.bind(s.store); let once = true; s.store.receipt = (...args) => { if (once) { once = false; throw Error("synthetic receipt failure"); } return receipt(...args); };
  await work(s); assert.equal(s.store.get(old.id).status, "active"); assert.deepEqual(s.store.getMeta("control:s0", []), []); assert.equal(s.store.getSource("s0").processed, 0);
  now += 200000; await s.work("extract"); assert.equal(calls.length, 2); assert.equal(s.store.get(old.id).status, "forgotten"); assert.equal(s.store.getSource("s0").processed, 1);
});

test("召回：预算不足时完整单位整条排除，未截取无条件前半句", async t => {
  const s = fixture(t, []), content = "仅限内网且必须审批：" + "完整条件。".repeat(120), row = s.manual({ content, kind: "rule", scope: "project" }, { workspace });
  s.search = async () => [row]; assert.equal(await s.recall("synthetic", "budget", workspace, "内网"), null);
});

test("控制：全局遗忘不依赖内容分类，不把控制操作当全局事实拦截", async t => {
  const s = fixture(t, []), old = s.manual({ content: "长期偏好使用中文。", kind: "preference", scope: "global" }, { workspace }); s.store.forget(old.id);
  s.store.source({ id: "s0", sessionId: "synthetic", eventId: "global-forget", projectId: workspace, role: "user", text: `保持遗忘 ${old.id}。`, turnId: "t" });
  model(s, p => draft([unit(p, { action: "forget", intent: "forget", unit: "control", scope: "global", kind: "fact", content: "", targetId: old.id, targetVersion: s.store.get(old.id).version, authorization: "explicit", authorizationEvidence: [ref("s0")] })]), p => reviewUnits(p, { unit: "control", authorization: "explicit", authorizationEvidence: [ref("s0")] }));
  await work(s); assert.equal(s.store.operations().find(r => r.job_id).outcome, "applied"); assert.equal(s.store.eligible(workspace).length, 0);
});

test("人工：明确重记只解除唯一事实的保护，旧记录仍不可恢复", t => {
  const s = fixture(t, []), old = s.manual({ content: "人工事实甲。", kind: "fact", scope: "project" }, { workspace }); s.store.forget(old.id);
  const restored = s.manual({ content: old.content, kind: "fact", scope: "project", rerecord: true }, { workspace });
  assert.ok(restored.id); assert.notEqual(restored.id, old.id); assert.equal(s.store.get(old.id).status, "forgotten");
});

test("隔离：受保护候选不能跨项目，协议 5 已收结果不得重新解释或发送", async t => {
  const s = fixture(t, ["邮件索引使用SQLite。"]), old = s.manual({ content: "邮件索引使用SQLite。", kind: "fact", scope: "project" }, { workspace: "d:/other" }); s.store.forget(old.id);
  const p = await prepareOperations(s, [s.store.getSource("s0")], workspace, { cloud: false }); assert.equal(p.protected.length, 0);
  s.store.enqueue("extract", "protocol-five", { protocolVersion: 5, sourceIds: ["s0"], projectId: workspace });
  const calls = model(s, () => assert.fail("不重发")); await s.work("extract"); assert.equal(calls.length, 0); assert.equal(s.store.getSource("s0").processed, 0);
});

test("控制：同批两个独立遗忘凭证互不因先遮蔽而失败", async t => {
  const s = fixture(t, []), a = seed(s, "甲系统旧事实。"), b = seed(s, "乙系统旧事实。"); s.store.forget(a.id); s.store.forget(b.id);
  s.store.source({ id: "s0", sessionId: "synthetic", eventId: "two-controls", projectId: workspace, role: "user", text: "保持遗忘甲系统旧事实。保持遗忘乙系统旧事实。", turnId: "t" });
  model(s, p => draft([a, b].map((old, i) => unit(p, { action: "forget", intent: "forget", unit: "control", content: "", targetId: old.id, targetVersion: s.store.get(old.id).version, authorization: "explicit", evidence: [ref("s0", `p${i + 1}`)], authorizationEvidence: [ref("s0", `p${i + 1}`)] }))), p => approve(p));
  await work(s); assert.equal(s.store.operations().filter(r => r.job_id && r.outcome === "applied").length, 2); assert.equal(s.store.getSource("s0").processed, 1);
});
