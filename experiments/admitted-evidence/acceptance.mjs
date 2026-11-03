// Unresolved product contracts stay FAILING; do not count absence-only successes as admission quality.
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryService } from "../../src/service.mjs";
import { fixture, model, operation, draft, work, workspace } from "../../tests/helpers/kernel.mjs";
import { AdmittedRoute } from "./route.mjs";

function setup(t) {
  const service = new MemoryService({ filename: ":memory:", client: { ready: async () => false } }); t.after(() => service.close());
  const store = service.store, route = new AdmittedRoute(store), workspace = "d:/synthetic/acceptance";
  const source = (id, text) => store.source({ id, sessionId: "synthetic", projectId: workspace, eventId: id, role: "user", text });
  const old = (id, content) => store.save({ content, kind: "fact", scope: "project", projectId: workspace, evidence: [{ sourceId: id, quote: content }], ranges: [{ sourceId: id, start: 0, end: content.length }], attributes: { legacy: false } });
  return { store, route, workspace, source, old };
}
// Original three assertions and source data are retained; the new route has no source-only admission.
test("原验收：忘掉共享消息中的 A，独立事实 B 仍应可召回", t => {
  const f = setup(t); f.source("a", "目录索引存储在 CedarDB。导出格式固定为 NDJSON。");
  f.store.forget(f.old("a", "目录索引存储在 CedarDB。").id); f.route.add("window", ["a"]);
  const text = f.route.search("NDJSON", f.workspace).text;
  assert.ok(!text.includes("CedarDB")); assert.ok(text.includes("NDJSON"), "B 没有准入依据，仍不能视为完整替代方案");
});
test("原验收：明确不保存的临时指令不能因原文直存重新召回", t => {
  const f = setup(t); f.source("a", "这次只帮我调整语气，不要保存这个临时请求。"); f.route.add("window", ["a"]);
  assert.equal(f.route.search("语气", f.workspace).items.length, 0);
});
test("原验收：遗忘后跨语言等义回放不应重新暴露具体事实", t => {
  const f = setup(t); f.source("a", "目录索引存储在 CedarDB。"); f.store.forget(f.old("a", "目录索引存储在 CedarDB。").id);
  f.source("b", "The catalog index is stored in CedarDB."); f.route.add("replay", ["b"]);
  assert.equal(f.route.search("CedarDB", f.workspace).items.length, 0);
});
test("未决：v7 错批且未识别跨语言身份时，原文读取不能补出身份关系", async t => {
  const s = fixture(t, ["The catalog index is stored in CedarDB."]);
  const old = s.manual({ content: "目录索引存储在 CedarDB。", kind: "fact", scope: "project" }, { workspace }); s.store.forget(old.id);
  model(s, p => draft([operation(p, { content: "The catalog index is stored in CedarDB." })])); await work(s);
  const route = new AdmittedRoute(s.store); for (const r of s.store.operations()) route.add(r.id);
  assert.equal(route.search("catalog", workspace).text, "", "无关联的新表述被上游错批后仍会泄漏；不得宣称跨语言语义保护达标");
});
test("未决：v7 给出不完整引用却认定完整时，读取层不能补造遗漏条件", async t => {
  const s = fixture(t, ["API 监听 7351。它只绑定 127.0.0.1，禁止公网开放。"]);
  model(s, p => draft([operation(p, { content: "API 监听 7351。", evidence: [{ sourceId: "s0", anchorId: "p1" }] })])); await work(s);
  const route = new AdmittedRoute(s.store); for (const r of s.store.operations()) route.add(r.id);
  assert.match(route.search("7351", workspace).text, /127\.0\.0\.1[\s\S]*禁止公网/, "正确的引用位置不代表引用范围在语义上完整");
});

test("未决：两阶段都错批明确不保存内容时，原文门禁不能重新理解意图", async t => {
  const s = fixture(t, ["这次只帮我调整语气，不要保存这个临时请求。"]);
  model(s, p => draft([operation(p, { content: "用户要求调整语气。" })])); await work(s);
  const route = new AdmittedRoute(s.store); for (const r of s.store.operations()) route.add(r.id);
  assert.equal(route.search("语气", workspace).text, "", "门禁执行批准结果，不代表识别批准结果的语义错误");
});
