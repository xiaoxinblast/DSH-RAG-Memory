import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryService } from "../src/service.mjs";
import { createDshExtractor, listDshModels } from "../dsh/extractor.mjs";
import { extractionInput, parseExtraction } from "../src/extraction.mjs";

const workspace = "D:/memory-tests/extractor";
const route = { provider: "chosen-provider", model: "chosen-model" };
function catalog() { return { listProviders: () => [{ id: route.provider, name: "已配置提供商" }, { id: "other", name: "另一提供商" }], listModels: async (provider) => provider === route.provider ? [{ provider, id: route.model, name: "选定模型" }, { provider, id: "second-model", name: "另一模型" }] : [{ provider, id: "other-model", name: "其他模型" }] }; }
test("DSH 提炼固定使用插件选择，独立请求不带主聊天历史和工具", async (t) => {
  const service = new MemoryService({ filename: ":memory:" }); t.after(() => service.close()); service.store.configure({ extractionRoute: route });
  let request, config;
  const ctx = { sessions: { get: () => { throw new Error("不得读取会话模型"); } }, agentDefaultModel: { currentSelection: () => { throw new Error("不得读取默认模型"); } }, llm: { ...catalog(), prepareCall: async (selected, _signal, configure) => { config = { ...selected, ...configure(selected, { reasoning: { efforts: [{ id: "minimal" }, { id: "high" }] } }) }; return { config, async *stream(options) { request = options; yield { type: "block-start", index: 0, blockType: "text" }; yield { type: "text-delta", index: 0, text: '{"memories":[]}' }; yield { type: "usage", usage: { inputTokens: 80, outputTokens: 8 } }; yield { type: "finish", reason: { kind: "stop" } }; } }; } } };
  const result = await createDshExtractor(ctx, service.store)([{ id: "source-1", session_id: "s", role: "user", text: "请用中文回答" }], [], new AbortController().signal);
  assert.deepEqual(result, []); assert.equal(config.provider, route.provider); assert.equal(config.model, route.model); assert.equal(config.reasoningEffort, "minimal"); assert.equal(request.messages.length, 2); assert.equal(request.tools, undefined); assert.equal(request.purpose, "memory-extraction");
  const audit = service.store.db.prepare("SELECT * FROM extraction_calls").get(); assert.equal(audit.status, "done"); assert.ok(audit.request.includes("source-1")); assert.equal(service.store.dashboard().dshUsage[0].inputTokens, 80); assert.equal(service.store.dashboard().cost, 0);
});
test("DSH 提炼在 Qwen 未配置时仍能运行，证据由宿主读取原文", async (t) => {
  const service = new MemoryService({ filename: ":memory:", extractor: async (sources) => [{ kind: "fact", scope: "project", content: "使用本地数据库", status: "active", evidence: [{ sourceId: sources[0].id, quote: "模型改写的伪引句" }] }] }); t.after(() => service.close());
  service.store.source({ sessionId: "s", eventId: "actual", projectId: workspace, role: "user", text: "已确定使用本地数据库。", turnId: "1" }); service.schedule("s"); await service.tick();
  const rows = service.store.eligible(workspace); assert.equal(rows.length, 1); assert.equal(service.store.detail(rows[0].id).evidence[0].quote, "已确定使用本地数据库。");
});
for (const [label, selected] of [["未选择", null], ["提供商已移除", { provider: "removed", model: "old" }], ["模型已移除", { provider: route.provider, model: "removed" }]]) test(`DSH ${label}时保留队列，不消耗失败次数或自动切换`, async (t) => {
  const service = new MemoryService({ filename: ":memory:" }); t.after(() => service.close()); service.store.configure({ extractionRoute: selected });
  service.extractor = createDshExtractor({ llm: { ...catalog(), prepareCall: () => { throw new Error("不得调用其他模型"); } } }, service.store);
  service.store.source({ sessionId: "s", eventId: "e", projectId: workspace, role: "user", text: "待整理", turnId: "1" }); service.schedule("s"); await service.tick();
  const job = service.store.dashboard().jobs[0]; assert.equal(job.status, "pending"); assert.equal(job.attempts, 0); assert.match(job.error, /选择/); assert.equal(service.store.getSource("s:e").processed, 0);
});
test("已选提炼模型重启后持久化，缺少 usage 时不编造金额", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-memory-route-")), filename = join(dir, "memory.sqlite");
  const first = new MemoryService({ filename }); first.store.configure({ extractionRoute: route }); await first.close();
  const service = new MemoryService({ filename }); t.after(async () => { await service.close(); rmSync(dir, { recursive: true, force: true }); }); assert.deepEqual(service.store.settings().extractionRoute, route);
  let provider; const ctx = { llm: { ...catalog(), prepareCall: async (selected) => ({ config: selected, async *stream() { provider = selected.provider; yield { type: "text-delta", index: 0, text: '{"memories":[]}'}; yield { type: "finish", reason: { kind: "stop" } }; } }) } };
  await createDshExtractor(ctx, service.store)([{ id: "1", session_id: "s", role: "user", text: "新片段" }], [], new AbortController().signal); assert.equal(provider, route.provider); assert.equal(service.store.dashboard().dshUsage[0].missingUsage, 1);
});
test("DSH 模型选择器返回多个已注册模型，只传递安全的 ID 和名称", async () => {
  const llm = catalog(), result = await listDshModels({ ...llm, listModels: async (provider) => (await llm.listModels(provider)).map((m) => ({ ...m, apiKey: "not-for-ui" })) });
  assert.equal(result.length, 2); assert.equal(result[0].models.length, 2); assert.deepEqual(result[0].models[0], { id: route.model, name: "选定模型" }); assert.ok(!JSON.stringify(result).includes("apiKey"));
  const failure = await listDshModels({ listProviders: llm.listProviders, listModels: async () => { throw new Error("不要透传提供商异常内容"); } }); assert.match(failure[0].error, /无法读取/);
});
test("提炼选择必须完整，允许清空但不接受多余配置", async (t) => {
  const service = new MemoryService({ filename: ":memory:" }); t.after(() => service.close());
  assert.throws(() => service.store.configure({ extractionRoute: { provider: route.provider } }), /完整/); service.store.configure({ extractionRoute: { ...route, apiKey: "not-stored" } }); assert.deepEqual(service.store.settings().extractionRoute, route); service.store.configure({ extractionRoute: null }); assert.equal(service.store.settings().extractionRoute, null);
});
test("提炼输入有 8000 上限并拒绝无效结构", () => { assert.throws(() => extractionInput([{ text: "字".repeat(4000) }], []), /8000/); assert.deepEqual(parseExtraction('```json\n{"memories":[]}\n```'), []); assert.throws(() => parseExtraction('{"items":[]}'), /格式/); });
