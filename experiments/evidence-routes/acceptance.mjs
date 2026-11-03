// Product-level acceptance: failures are preserved as route-selection blockers.
// Do not turn these into "expected failure" assertions to make the prototype look ready.
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryService } from "../../src/service.mjs";
import { SourceRoute } from "./source-route.mjs";

for (const indexed of [false, true]) {
  const label = indexed ? "source-index" : "source";
  function setup(t) {
    const service = new MemoryService({ filename: ":memory:", client: { ready: async () => false } });
    t.after(() => service.close()); const store = service.store, route = new SourceRoute(store, indexed), workspace = "d:/synthetic/acceptance";
    const source = (id, text) => store.source({ id, sessionId: "synthetic", projectId: workspace, eventId: id, role: "user", text });
    const old = (id, content) => store.save({ content, kind: "fact", scope: "project", projectId: workspace, evidence: [{ sourceId: id, quote: content }], ranges: [{ sourceId: id, start: 0, end: content.length }], attributes: { legacy: false } });
    return { store, route, workspace, source, old };
  }
  test(`${label}: 忘掉共享消息中的 A，独立事实 B 仍应可召回`, t => {
    const f = setup(t); f.source("a", "目录索引存储在 CedarDB。导出格式固定为 NDJSON。");
    f.store.forget(f.old("a", "目录索引存储在 CedarDB。").id); f.route.add("window", ["a"]);
    const text = f.route.search("NDJSON", f.workspace).text;
    assert.ok(!text.includes("CedarDB")); assert.ok(text.includes("NDJSON"), "保守整块屏蔽损失了 B");
  });
  test(`${label}: 明确不保存的临时指令不能因原文直存重新召回`, t => {
    const f = setup(t); f.source("a", "这次只帮我调整语气，不要保存这个临时请求。"); f.route.add("window", ["a"]);
    assert.equal(f.route.search("语气", f.workspace).items.length, 0, "原文路线缺少持久价值与不保存意图判断");
  });
  test(`${label}: 遗忘后跨语言等义回放不应重新暴露具体事实`, t => {
    const f = setup(t); f.source("a", "目录索引存储在 CedarDB。"); f.store.forget(f.old("a", "目录索引存储在 CedarDB。").id);
    f.source("b", "The catalog index is stored in CedarDB."); f.route.add("replay", ["b"]);
    assert.equal(f.route.search("CedarDB", f.workspace).items.length, 0, "本地字面及近义保护不能证明跨语言事实身份");
  });
}
