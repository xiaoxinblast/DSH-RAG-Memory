import test from "node:test";
import assert from "node:assert/strict";
import { fixture, model, operation, draft, approve, work, workspace } from "../../tests/helpers/kernel.mjs";
import { AdmittedRoute } from "./route.mjs";

// Synthetic semantic decisions, not tests of a model's ability to infer these decisions.
const ref = (sourceId, anchorId = "p1") => ({ sourceId, anchorId });
async function admitted(t, texts, proposals, review = approve) {
  const service = fixture(t, texts);
  model(service, p => draft(proposals(p)), review); await work(service);
  const receipts = service.store.operations({ limit: 1000 });
  const route = new AdmittedRoute(service.store);
  for (const r of receipts) route.add(r.id);
  return { service, store: service.store, route, receipts };
}
const textOf = (f, query) => f.route.search(query, workspace).text;

test("不保存和允许保存的范围共处一条消息，只有独立 B 返回", async t => {
  const f = await admitted(t, ["这次调整语气，不保存这个临时请求。导出固定使用 NDJSON。"], p => [
    operation(p, { content: "调整语气", intent: "temporary", authorization: "none", evidence: [ref("s0"), ref("s0", "p2")] }),
    operation(p, { content: "导出固定使用 NDJSON。", evidence: [ref("s0", "p3")] }),
  ]);
  assert.equal(textOf(f, "语气"), "");
  assert.match(textOf(f, "NDJSON"), /NDJSON/); assert.doesNotMatch(textOf(f, "NDJSON"), /语气|不保存/);
});

test("准入的独立 B 在同消息 A 被忘后仍返回，重建读取器与旧快照同样生效", async t => {
  const f = await admitted(t, ["目录索引存储在 CedarDB。导出格式固定为 NDJSON。"], p => [
    operation(p, { content: "目录索引存储在 CedarDB。", evidence: [ref("s0")] }),
    operation(p, { content: "导出格式固定为 NDJSON。", evidence: [ref("s0", "p2")] }),
  ]);
  assert.match(textOf(f, "CedarDB"), /CedarDB/); const snapshot = JSON.parse(JSON.stringify(f.route.snapshot()));
  const a = f.store.eligible(workspace).find(r => r.content.includes("CedarDB")); f.store.forget(a.id);
  for (const route of [f.route, new AdmittedRoute(f.store, snapshot)]) {
    assert.equal(route.search("CedarDB", workspace).text, "");
    const text = route.search("NDJSON", workspace).text; assert.match(text, /NDJSON/); assert.doesNotMatch(text, /CedarDB/);
  }
});

test("已知跨语言来源关联继承撤销；另一个主体的独立事实不受牵连", async t => {
  const f = await admitted(t, ["目录索引存储在 CedarDB。", "The catalog index is stored in CedarDB.", "音频索引存储在 CedarDB。"], p => [
    operation(p, { content: "目录索引存储在 CedarDB。", evidence: [ref("s0")] }),
    operation(p, { content: "The catalog index is stored in CedarDB.", evidence: [ref("s1")] }),
    operation(p, { content: "音频索引存储在 CedarDB。", evidence: [ref("s2")] }),
  ]);
  const a = f.receipts.find(r => r.after?.content === "目录索引存储在 CedarDB。"), b = f.receipts.find(r => r.after?.content.startsWith("The catalog"));
  // Host-supplied synthetic provenance. No claim that a model discovered this relation.
  const route = new AdmittedRoute(f.store); route.add(a.id); route.add(b.id, [a.id]);
  route.add(f.receipts.find(r => r.after?.content.startsWith("音频")).id);
  const snapshot = route.snapshot(); assert.match(route.search("catalog", workspace).text, /catalog/);
  f.store.forget(a.memory_id);
  for (const r of [route, new AdmittedRoute(f.store, snapshot)]) {
    assert.equal(r.search("catalog", workspace).text, "");
    assert.match(r.search("音频", workspace).text, /音频索引/);
  }
});

test("条件与主句按复核单元一起返回，条件撤销后不能输出无条件主句", async t => {
  const f = await admitted(t, ["API 监听 7351。", "它只绑定 127.0.0.1，禁止公网开放。"], p => [
    operation(p, { content: "API 监听 7351。", evidence: [ref("s0")] }),
    operation(p, { content: "它只绑定 127.0.0.1，禁止公网开放。", evidence: [ref("s1"), ref("s1", "p2")] }),
  ], p => { const r = approve(p); r.units = [{ ...r.units[0], members: p.items.map(o => o.id), evidence: p.items.flatMap(o => o.evidence) }]; return r; });
  const out = f.route.search("7351", workspace); assert.equal(out.items.length, 1);
  assert.match(out.items[0].body, /7351[\s\S]*127\.0\.0\.1[\s\S]*禁止公网/);
  f.store.protectControl([{ sourceId: "s1", start: 0, end: "它只绑定 127.0.0.1，".length }]);
  assert.equal(textOf(f, "7351"), "");
});

for (const mode of ["pending", "rejected", "incomplete"]) test(`准入为 ${mode} 时，原文不能自行升级`, async t => {
  const f = await admitted(t, ["缓存拟使用 Redis。"], p => [operation(p, { content: "缓存拟使用 Redis。" })], p => approve(p, mode === "pending" ? { decision: "uncertain" } : mode === "rejected" ? { decision: "reject" } : { unit: "incomplete" }));
  assert.equal(textOf(f, "Redis"), ""); assert.equal(f.route.snapshot().length, 0);
});

test("未知凭证不能登记，未知派生父项不能忽略，不能重登记擦掉既有关联", async t => {
  const f = await admitted(t, ["项目格式 NDJSON。"], p => [operation(p, { content: "项目格式 NDJSON。" })]);
  assert.equal(f.route.add("not-a-receipt"), false);
  const route = new AdmittedRoute(f.store);
  assert.throws(() => route.add(f.receipts[0].id, ["unknown"]));
  assert.throws(() => f.route.add(f.receipts[0].id));
});

test("来源版本变化、越界引用及凭证变化停止使用，不从整条来源兜底", async t => {
  for (const change of ["source", "receipt"]) {
    const f = await admitted(t, ["端口固定 7351。"], p => [operation(p, { content: "端口固定 7351。" })]);
    assert.match(textOf(f, "7351"), /7351/);
    if (change === "source") f.store.db.prepare("UPDATE sources SET text=? WHERE id='s0'").run("端口固定 7351。另一条未经准入的内容。");
    else f.store.db.prepare("UPDATE memory_operations SET evidence=? WHERE id=?").run(JSON.stringify([{ sourceId: "s0", start: 0, end: 9000 }]), f.receipts[0].id);
    assert.equal(textOf(f, "7351"), "");
  }
});

test("项目范围与记忆版本每次读取复查", async t => {
  const f = await admitted(t, ["端口固定 7351。"], p => [operation(p, { content: "端口固定 7351。" })]);
  assert.equal(f.route.search("7351", "d:/synthetic/foreign").text, "");
  f.store.db.prepare("UPDATE memories SET version=version+1 WHERE id=?").run(f.receipts[0].memory_id);
  assert.equal(textOf(f, "7351"), "");
});

test("预算保留整个单元；超长内容不能以截断尾部条件的方式返回", async t => {
  const text = "端口 7351。" + "完整条件需保留。".repeat(100);
  const f = await admitted(t, [text], p => [operation(p, { content: "端口 7351，附长条件。" })]);
  assert.equal(textOf(f, "7351"), "");
});

test("跨消息的独立 B、控制指令与局部撤销不会连带屏蔽", async t => {
  const f = await admitted(t, ["目录索引 CedarDB。", "导出格式 NDJSON。", "请忘掉目录索引 CedarDB。"], p => [
    operation(p, { content: "目录索引 CedarDB。", evidence: [ref("s0")] }),
    operation(p, { content: "导出格式 NDJSON。", evidence: [ref("s1")] }),
  ]);
  f.store.forget(f.store.eligible(workspace).find(r => r.content.includes("CedarDB")).id);
  f.store.protectControl([{ sourceId: "s2", start: 0, end: f.store.getSource("s2").text.length }]);
  assert.equal(textOf(f, "CedarDB"), ""); assert.match(textOf(f, "NDJSON"), /NDJSON/);
});

test("无精确范围的旧墓碑保留保守保护", async t => {
  const f = await admitted(t, ["目录索引 CedarDB。导出格式 NDJSON。"], p => [operation(p, { content: "导出格式 NDJSON。", evidence: [ref("s0", "p2")] })]);
  const old = f.store.save({ content: "目录索引 CedarDB。", kind: "fact", scope: "project", projectId: workspace, evidence: [{ sourceId: "s0", quote: "目录索引 CedarDB。" }] });
  f.store.forget(old.id); assert.equal(textOf(f, "NDJSON"), "");
});

test("已确认全局原文可跨项目使用；项目原文不能借全局父项提升范围", async t => {
  const f = await admitted(t, ["所有项目解释使用简体中文。", "项目端口固定 7351。"], p => [
    operation(p, { content: "所有项目解释使用简体中文。", kind: "preference", scope: "global", authorization: "explicit", evidence: [ref("s0")] }),
    operation(p, { content: "项目端口固定 7351。", evidence: [ref("s1")] }),
  ]);
  const global = f.receipts.find(r => r.after?.scope === "global"), local = f.receipts.find(r => r.after?.scope === "project");
  const route = new AdmittedRoute(f.store); route.add(global.id); route.add(local.id, [global.id]);
  assert.match(route.search("简体中文", "d:/synthetic/foreign").text, /简体中文/);
  assert.equal(route.search("7351", "d:/synthetic/foreign").text, "");
});

test("截断来源、缺少分片和来源角色篡改不能降级返回", async t => {
  for (const patch of [{ truncated: 1 }, { event_root: "missing", part_count: 2 }, { role: "assistant" }]) {
    const f = await admitted(t, ["端口固定 7351。"], p => [operation(p, { content: "端口固定 7351。" })]);
    for (const [field, value] of Object.entries(patch)) f.store.db.prepare(`UPDATE sources SET ${field}=? WHERE id='s0'`).run(value);
    assert.equal(textOf(f, "7351"), "");
  }
});

test("预算最多五条，重复查询不改变写入和审计状态", async t => {
  const texts = Array.from({ length: 8 }, (_, i) => `独立服务 node${i}。`);
  const f = await admitted(t, texts, p => texts.map((content, i) => operation(p, { content, evidence: [ref(`s${i}`)] })));
  const before = f.store.db.prepare("SELECT total_changes() AS n").get().n;
  const one = f.route.search("独立服务", workspace), two = f.route.search("独立服务", workspace);
  assert.equal(one.items.length, 5); assert.ok(one.bytes <= 1500); assert.deepEqual(two, one);
  assert.equal(f.store.db.prepare("SELECT total_changes() AS n").get().n, before);
});

test("有效期届满后不再使用原文", async t => {
  let now = Date.now();
  const service = fixture(t, ["临时端口 7351。"], { now: () => now });
  model(service, p => draft([operation(p, { content: "临时端口 7351。" })])); await work(service);
  const r = service.store.operations()[0]; const route = new AdmittedRoute(service.store); route.add(r.id);
  service.store.setAttributes(r.memory_id, { validUntil: now + 1000 });
  assert.match(route.search("7351", workspace).text, /7351/); now += 2000;
  assert.equal(route.search("7351", workspace).text, "");
});

test("明确重新记住以新凭证使用新来源，旧记录和旧原文不会恢复", async t => {
  const s = fixture(t, []);
  const old = s.manual({ content: "目录索引存储在 CedarDB。", kind: "fact", scope: "project" }, { workspace }); s.store.forget(old.id);
  s.store.source({ id: "s0", sessionId: "synthetic", projectId: workspace, eventId: "new", role: "user", turnId: "turn", text: "请重新记住：目录索引存储在 CedarDB。" });
  model(s, p => draft([operation(p, { intent: "rerecord", authorization: "explicit", content: "目录索引存储在 CedarDB。" })])); await work(s);
  const receipt = s.store.operations().find(r => r.details.operation?.intent === "rerecord");
  assert.equal(receipt.outcome, "applied"); assert.notEqual(receipt.memory_id, old.id);
  const route = new AdmittedRoute(s.store); assert.equal(route.add(receipt.id), true);
  assert.match(route.search("CedarDB", workspace).text, /CedarDB/);
  assert.equal(s.store.get(old.id).status, "forgotten");
  s.store.forget(receipt.memory_id); assert.equal(route.search("CedarDB", workspace).text, "");
});

test("旧来源没有准入凭证时不会因新查询获得授权；源文本仍是本地审计并未擦除", async t => {
  const s = fixture(t, ["这次只调整语气，不保存。"]), route = new AdmittedRoute(s.store);
  assert.equal(route.add("s0"), false); assert.equal(route.search("语气", workspace).text, "");
  assert.equal(s.store.getSource("s0").text, "这次只调整语气，不保存。");
});
