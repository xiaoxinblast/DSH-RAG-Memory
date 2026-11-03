import test from "node:test";
import assert from "node:assert/strict";
import { MemoryService } from "../src/service.mjs";
import { createDshExtractor, listDshModels } from "../dsh/extractor.mjs";
const route = { provider: "synthetic-provider", model: "synthetic-model" };
function catalog() { return { listProviders: () => [{ id: route.provider, name: "合成提供商" }], listModels: async () => [{ id: route.model, name: "合成模型", apiKey: "never-expose" }] }; }
function fixture(t) { const s = new MemoryService({ filename: ":memory:" }); t.after(() => s.close()); s.store.configure({ extractionRoute: route }); return s; }
test("adapter：两阶段使用同一传输、路由、限额、用量与原始回答审计", async t => {
  const s = fixture(t), sent = [];
  const ctx = { sessions: { get: () => assert.fail("不读取聊天") }, llm: { ...catalog(), prepareCall: async (selected, _signal, configure) => {
    const config = { ...selected, ...configure(selected, { reasoning: { efforts: [{ id: "minimal" }, { id: "high" }] } }) };
    return { config, async *stream(request) { sent.push(request); yield { type: "text-delta", index: 0, text: "{invalid received answer" }; yield { type: "usage", usage: { inputTokens: 80, outputTokens: 8 } }; yield { type: "finish", reason: { kind: "stop" } }; } };
  } } };
  const extractor = createDshExtractor(ctx, s.store); assert.equal(typeof extractor, "object"); assert.deepEqual(Object.keys(extractor).sort(), ["assertReady", "request"]);
  for (const phase of ["extraction", "verification"]) { const raw = await extractor.request(phase, '{"sources":[]}', new AbortController().signal); assert.equal(raw.text, "{invalid received answer"); assert.equal(raw.finish, "stop"); }
  for (const request of sent) { assert.equal(request.provider, route.provider); assert.equal(request.model, route.model); assert.equal(request.temperature, 0); assert.equal(request.maxTokens, 2048); assert.equal(request.reasoningEffort, "minimal"); assert.equal(request.messages.length, 2); assert.equal(request.tools, undefined); }
  assert.deepEqual(sent.map(r => r.purpose), ["memory-extraction", "memory-verification"]);
  const audits = s.store.db.prepare("SELECT * FROM extraction_calls ORDER BY rowid").all(); assert.equal(audits.length, 2); assert.ok(audits.every(r => r.status === "done" && r.response === "{invalid received answer" && JSON.parse(r.usage).inputTokens === 80)); assert.equal(s.store.dashboard().cost, 0);
});
for (const [label, selected] of [["未选择", null], ["提供商移除", { provider: "removed", model: "removed" }], ["模型移除", { provider: route.provider, model: "removed" }]]) test(`adapter：${label}保留任务，不重试、不更换路由`, async t => {
  const s = fixture(t); s.store.configure({ extractionRoute: selected }); s.extractor = createDshExtractor({ llm: { ...catalog(), prepareCall: () => assert.fail("不调用") } }, s.store);
  s.store.source({ sessionId: "synthetic", projectId: "d:/synthetic", eventId: "1", role: "user", text: "合成事实", turnId: "1" }); s.schedule("synthetic"); await s.work("extract");
  const job = s.store.db.prepare("SELECT * FROM jobs WHERE kind='extract'").get(); assert.equal(job.status, "pending"); assert.equal(job.attempts, 0); assert.equal(s.store.db.prepare("SELECT count(*) AS n FROM extraction_calls").get().n, 0);
});
test("adapter：暂停、输入上限在发送前阻止调用；最低推理档不冒充关闭思考", async t => {
  const s = fixture(t), e = createDshExtractor({ llm: { ...catalog(), prepareCall: () => assert.fail("不调用") } }, s.store);
  s.store.configure({ cloudPaused: true }); await assert.rejects(e.request("extraction", "{}", new AbortController().signal), /已暂停/);
  s.store.configure({ cloudPaused: false }); await assert.rejects(e.request("extraction", "中".repeat(8000), new AbortController().signal), /预算/);
});
test("adapter：失败用量保留，缺失用量不编造费用", async t => {
  const s = fixture(t); let failed = true;
  const e = createDshExtractor({ llm: { ...catalog(), prepareCall: async selected => ({ config: selected, async *stream() { if (failed) { yield { type: "usage", usage: { inputTokens: 5 } }; throw Error("synthetic-interrupted"); } yield { type: "text-delta", index: 0, text: "{}" }; yield { type: "finish", reason: { kind: "stop" } }; } }) } }, s.store);
  await assert.rejects(e.request("extraction", "{}", new AbortController().signal), /synthetic-interrupted/); failed = false; await e.request("verification", "{}", new AbortController().signal);
  const audits = s.store.db.prepare("SELECT * FROM extraction_calls ORDER BY rowid").all(); assert.equal(audits[0].status, "failed"); assert.equal(JSON.parse(audits[0].usage).inputTokens, 5); assert.equal(audits[1].usage, null); assert.equal(s.store.dashboard().dshUsage.reduce((n, row) => n + row.missingUsage, 0), 1);
});
test("adapter：模型选择器只返回安全标识；完整配置可清空", async t => {
  const s = fixture(t), result = await listDshModels(catalog()); assert.deepEqual(result[0].models, [{ id: route.model, name: "合成模型" }]);
  const failure = await listDshModels({ ...catalog(), listModels: () => { throw Error("private error"); } }); assert.ok(!JSON.stringify(failure).includes("private error"));
  assert.throws(() => s.store.configure({ extractionRoute: { provider: route.provider } }), /完整/); s.store.configure({ extractionRoute: { ...route, apiKey: "not-stored" } }); assert.deepEqual(s.store.settings().extractionRoute, route); s.store.configure({ extractionRoute: null }); assert.equal(s.store.settings().extractionRoute, null);
});
