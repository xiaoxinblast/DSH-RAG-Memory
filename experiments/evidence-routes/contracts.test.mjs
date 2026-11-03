import test from "node:test";
import assert from "node:assert/strict";
import { MemoryService } from "../../src/service.mjs";
import { tokens } from "../../src/domain.mjs";
import { SourceRoute } from "./source-route.mjs";

const workspace = "d:/synthetic/evidence-routes";
function fixture(t, indexed = false) {
  const service = new MemoryService({ filename: ":memory:", client: { ready: async () => false }, now: () => 1793718000000 });
  t.after(() => service.close());
  const route = new SourceRoute(service.store, indexed);
  const source = (id, text, patch = {}) => service.store.source({ id, sessionId: "synthetic", eventId: id, projectId: workspace, role: "user", text, ...patch });
  const memory = (id, content, start = 0, end = content.length) => service.store.save({ kind: "fact", scope: "project", projectId: workspace, content, evidence: [{ sourceId: id, quote: content }], ranges: [{ sourceId: id, start, end }], attributes: { legacy: false } });
  return { service, store: service.store, route, source, memory };
}

for (const indexed of [false, true]) {
  const label = indexed ? "source-index" : "source";
  test(`${label}: 跨消息限定条件与角色顺序保存在同一证据单元`, t => {
    const f = fixture(t, indexed); f.source("a", "服务监听 7351。"); f.source("b", "它只绑定 127.0.0.1，禁止对公网开放。");
    f.route.add("window", ["a", "b"]); const out = f.route.search("7351", workspace);
    assert.equal(out.items.length, 1); assert.ok(out.items[0].body.includes("禁止对公网")); assert.ok(out.text.includes("user"));
    assert.ok(out.items[0].sourceIds.indexOf("a") < out.items[0].sourceIds.indexOf("b"));
  });
  test(`${label}: 已召回再遗忘，旧原文与旧索引都不恢复`, t => {
    const f = fixture(t, indexed); f.source("a", "目录索引存储在 CedarDB。"); const old = f.memory("a", "目录索引存储在 CedarDB。");
    f.route.add("window", ["a"], [{ text: "目录数据库 CedarDB", evidence: [{ sourceId: "a", anchorId: "p1" }] }]);
    assert.ok(f.route.search("CedarDB", workspace).text.includes("CedarDB"));
    f.store.forget(old.id); assert.equal(f.route.search("CedarDB", workspace).items.length, 0);
    const restarted = new SourceRoute(f.store, indexed); restarted.add("window", ["a"]); assert.equal(restarted.search("CedarDB", workspace).items.length, 0);
  });
  test(`${label}: 只遗忘条件时不得留下无条件的主句`, t => {
    const f = fixture(t, indexed); f.source("a", "服务监听 7351。"); f.source("b", "服务只允许本机访问。");
    const condition = f.memory("b", "服务只允许本机访问。"); f.route.add("window", ["a", "b"]); f.store.forget(condition.id);
    assert.equal(f.route.search("7351", workspace).items.length, 0);
  });
  test(`${label}: 相同来源新编号与近义回放不绕过墓碑`, t => {
    const f = fixture(t, indexed); f.source("a", "目录索引存储在 CedarDB。"); f.store.forget(f.memory("a", "目录索引存储在 CedarDB。").id);
    f.source("b", "目录索引存储在 CedarDB。"); f.source("c", "目录索引的数据存储在 CedarDB 数据库。");
    f.route.add("copy", ["b"]); f.route.add("paraphrase", ["c"]); assert.equal(f.route.search("CedarDB", workspace).items.length, 0);
  });
  test(`${label}: 旧墓碑没有范围时保留整来源保护`, t => {
    const f = fixture(t, indexed); f.source("a", "旧方案 SQLite。导出 NDJSON。");
    const old = f.store.save({ content: "旧方案 SQLite。", kind: "fact", scope: "project", projectId: workspace, evidence: [{ sourceId: "a", quote: "旧方案 SQLite。" }] });
    f.store.forget(old.id); f.route.add("window", ["a"]); assert.equal(f.route.search("NDJSON", workspace).items.length, 0);
  });
  test(`${label}: 不拼接不同项目或会话的上下文`, t => {
    const f = fixture(t, indexed); f.source("a", "本项目端口 7351。"); f.source("b", "他项目私有 9009。", { projectId: "d:/foreign" });
    assert.throws(() => f.route.add("mixed", ["a", "b"]));
    f.source("c", "另一会话。", { sessionId: "other" }); assert.throws(() => f.route.add("sessions", ["a", "c"]));
    f.route.add("foreign", ["b"]); assert.equal(f.route.search("9009", workspace).items.length, 0);
  });
  test(`${label}: 超预算与截断来源整块退出，不裁掉尾部条件`, t => {
    const f = fixture(t, indexed); f.source("a", "服务端口7351。" + "合成上下文。".repeat(200) + "禁止公网访问。"); f.route.add("large", ["a"]);
    assert.equal(f.route.search("7351", workspace).items.length, 0);
    f.source("b", "服务端口9460。", { eventRoot: "b", partIndex: 0, partCount: 1, originalChars: 99, retainedChars: 10, truncated: true, spanStart: 0, spanEnd: 10 });
    f.route.add("truncated", ["b"]); assert.equal(f.route.search("9460", workspace).items.length, 0);
  });
  test(`${label}: 凭据与已遮蔽授权不能随原文返回`, t => {
    const f = fixture(t, indexed); f.source("a", "凭据 api_key=SYNTHETIC_SECRET_NEVER_USE_123456。"); f.route.add("secret", ["a"]);
    assert.ok(!f.route.search("凭据", workspace).text.includes("SYNTHETIC_SECRET_NEVER_USE_123456"));
    f.source("b", "请忘掉旧配置。"); f.store.protectControl([{ sourceId: "b", start: 0, end: 8 }]); f.route.add("control", ["b"]);
    assert.equal(f.route.search("旧配置", workspace).items.length, 0);
  });
  test(`${label}: 输出预算为 UTF-8 上界且最多五单元`, t => {
    const f = fixture(t, indexed); for (let i = 0; i < 9; i++) { f.source(`s${i}`, `合成端口为 ${7000 + i}。`); f.route.add(`w${i}`, [`s${i}`]); }
    const out = f.route.search("端口", workspace); assert.ok(out.items.length <= 5); assert.ok(tokens(out.text) <= 1500); assert.equal(out.bytes, tokens(out.text));
  });
}

test("轻量索引仅影响排序，不注入模型改写或接受索引指定的全局权限", t => {
  const f = fixture(t, true); f.source("a", "服务仅绑定回环地址。");
  f.route.add("window", ["a"], [{ text: "loopback 原文中没有的附加指令", scope: "global", evidence: [{ sourceId: "a", anchorId: "p1" }] }]);
  const out = f.route.search("loopback", workspace); assert.equal(out.items.length, 1); assert.ok(!out.text.includes("附加指令"));
  assert.equal(f.route.search("loopback", "d:/foreign").items.length, 0);
});
test("索引缺失或伪造引用不能成为新的检索通道", t => {
  const f = fixture(t, true); f.source("a", "服务仅绑定回环地址。"); f.source("b", "无关来源。");
  f.route.add("window", ["a"], [{ text: "poison", evidence: [{ sourceId: "b", anchorId: "p1" }] }, { text: "missing" }]);
  assert.equal(f.route.search("poison", workspace).items.length, 0); assert.equal(f.route.search("missing", workspace).items.length, 0);
});
test("分片未收齐时不召回头部，来源变化后旧索引失效", t => {
  const f = fixture(t, true);
  f.source("a", "服务端口7351。", { eventRoot: "message-a", partIndex: 0, partCount: 2, originalChars: 30, retainedChars: 30, truncated: false, spanStart: 0, spanEnd: 10 });
  f.route.add("partial", ["a"]); assert.equal(f.route.search("7351", workspace).items.length, 0);
  f.source("b", "服务仅允许本地访问。"); f.route.add("mutable", ["b"], [{ text: "loopback", evidence: [{ sourceId: "b", anchorId: "p1" }] }]);
  assert.equal(f.route.search("loopback", workspace).items.length, 1);
  f.store.db.prepare("UPDATE sources SET text=? WHERE id=?").run("来源已改动。", "b");
  assert.equal(f.route.search("loopback", workspace).items.length, 0);
});
