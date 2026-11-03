import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MemoryService } from "../src/service.mjs";
import { PROTOCOL_VERSION, CONTRACT } from "../src/extraction.mjs";
import { createDshExtractor } from "../dsh/extractor.mjs";

export async function verifyKernelSdk({ invalidFirst = false, invalidReview = false, scenario = "preference" } = {}) {
  const [{ Context }, { LlmRuntime }, { PiAiAdapter }] = await Promise.all([import("@deepseek-ai/cordis"), import("@deepseek-ai/dsh-llm"), import("@deepseek-ai/dsh-llm-pi-ai")]);
  const adapterFile = realpathSync(fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-llm-pi-ai"))), protocol = join(dirname(adapterFile), "../../../@earendil-works/pi-ai/dist/api/openai-completions.lazy.js");
  const api = (await import(pathToFileURL(protocol).href)).openAICompletionsApi(), requests = [];
  const text = { preference: "这是我的长期偏好：所有项目的解释都用简体中文。", forget: "忘掉旧端口配置。", group: "API 监听8123。API 仅限回环访问。" }[scenario], evidence = [{ sourceId: "sdk-source", start: 0, end: text.length }];
  const operation = { action: "add", intent: "remember", content: "用户长期偏好使用简体中文解释。", kind: "preference", scope: "global", targetId: null, targetVersion: null, certainty: "confirmed", authorization: "explicit", eventState: "not_applicable", unit: "self_contained", restores: null, evidence };
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const body = JSON.parse(raw); requests.push(body);
    const payload = JSON.parse(body.messages.at(-1).content), refs = [{ sourceId: "sdk-source", anchorId: payload.sources[0].anchors[0].id }], response = payload.items ? { version: PROTOCOL_VERSION, units: payload.items.map(i => ({ members: [i.id], decision: "approve", reason: "合成来源直接表达长期个人偏好", evidence: i.evidence, authorizationEvidence: i.authorizationEvidence, unit: i.unit, restores: i.restores, certainty: i.certainty, authorization: i.authorization, eventState: i.eventState })) } : { version: PROTOCOL_VERSION, operations: [{ ...operation, evidence: refs, authorizationEvidence: refs }] };
    if (scenario === "forget") {
      if (payload.items) response.units = response.units.map(r => Object.fromEntries(CONTRACT.fields.reviewForget.map(k => [k, r[k]])));
      else response.operations = [{ action: "forget", targetId: payload.existing[0].id, targetVersion: payload.existing[0].version, evidence: refs, authorizationEvidence: refs, certainty: "confirmed", authorization: "explicit" }];
    }
    if (scenario === "group") {
      if (payload.items) response.units = [{ ...response.units[0], members: payload.items.map(i => i.id), evidence: payload.items.flatMap(i => i.evidence) }];
      else response.operations = payload.sources[0].anchors.map(a => ({ ...operation, scope: "project", kind: "fact", intent: "statement", authorization: "ordinary", content: a.text, evidence: [{ sourceId: "sdk-source", anchorId: a.id }], authorizationEvidence: [] }));
    }
    if (!payload.items && invalidFirst) response.operations.unshift(null);
    if (payload.items && invalidFirst) assert.deepEqual(payload.items.map(i => i.id), ["op1"]);
    if (payload.items && invalidReview) response.units[0].decision = "pending";
    const chunk = { id: "synthetic-kernel", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: { content: JSON.stringify(response) }, finish_reason: null }] };
    res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } })}\n\n`); res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const ctx = new Context(), service = new MemoryService({ filename: ":memory:", client: { ready: async () => false } });
  try {
    new LlmRuntime(ctx); ctx.on("llm/stream", async function* (_options, next) { for await (const chunk of next()) { if (chunk.type === "finish" && chunk.reason.kind === "error") throw new Error(`合成 SDK 回环失败: ${JSON.stringify(chunk.reason)}`); yield chunk; } });
    const provider = "synthetic-kernel-provider", model = "synthetic-kernel-model", descriptor = { id: model, name: model, api: "openai-completions", provider, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reasoning: true, input: ["text"], contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { thinkingFormat: "qwen", supportsDeveloperRole: false } };
    const piProvider = { id: provider, name: provider, auth: { apiKey: { name: "synthetic-only", resolve: async () => ({ auth: { apiKey: "synthetic-kernel-key" }, source: "synthetic-only" }) } }, getModels: () => [descriptor], stream: (...args) => api.stream(...args), streamSimple: (...args) => api.streamSimple(...args) };
    const profiles = new Map([[provider, { displayName: provider, piProvider, modelErrors: new Map(), configuredMaxTokens: new Map(), streamIdleTimeoutMs: 90000 }]]);
    ctx.llm.registerAdapter([provider], new PiAiAdapter({ profiles: () => profiles, resolveApiKey: async () => "synthetic-kernel-key" }));
    service.store.configure({ extractionRoute: { provider, model } }); service.extractor = createDshExtractor(ctx, service.store);
    if (scenario === "forget") service.manual({ content: "旧端口配置。", kind: "fact", scope: "project" }, { workspace: "D:/synthetic-sdk-kernel/project" });
    service.store.source({ id: "sdk-source", sessionId: "sdk-session", projectId: "D:/synthetic-sdk-kernel/project", eventId: "user", role: "user", text, turnId: "turn" });
    service.schedule("sdk-session"); await service.work("extract");
    assert.equal(requests.length, 2, JSON.stringify(service.store.db.prepare("SELECT error FROM jobs WHERE kind='extract'").all())); assert.equal(service.store.eligible("D:/synthetic-sdk-kernel/another").length, !invalidReview && scenario === "preference" ? 1 : 0);
    if (scenario === "forget") assert.equal(service.store.list({ status: "all" })[0].status, "forgotten");
    if (scenario === "group") assert.deepEqual(service.store.eligible("D:/synthetic-sdk-kernel/project").map(r => r.content), ["API 监听8123。\nAPI 仅限回环访问。"]);
    assert.ok(!requests[0].messages[0].content.includes('"decision":'));
    assert.ok(requests[1].messages[0].content.includes('"members"'));
    const audits = service.store.db.prepare("SELECT * FROM extraction_calls ORDER BY rowid").all();
    assert.deepEqual(audits.map((a) => JSON.parse(a.request).phase), ["extraction", "verification"]); assert.ok(audits.every((a) => a.status === "done" && a.provider === provider && a.model === model));
    for (const body of requests) { assert.equal(body.enable_thinking, false); assert.equal(body.temperature, 0); assert.equal(body.max_tokens ?? body.max_completion_tokens, 2048); assert.equal(body.messages.length, 2); assert.equal(body.messages[0].role, "system"); assert.ok(!body.tools?.length); assert.equal(body.response_format, undefined); }
    assert.equal(JSON.parse(audits[0].request).config.reasoningEffort, "off");
    assert.equal(service.store.operations().filter((r) => r.job_id).length, (invalidFirst ? 2 : 1) + (invalidReview ? 1 : 0)); assert.equal(service.store.getSource("sdk-source").processed, 1);
    if (invalidFirst) assert.equal(service.store.operations().filter(r => r.details.phase === "extraction").length, 1);
    return { mode: "real-sdk-loopback-two-stage", scenario, externalModelCalls: 0, dailyProfileLoaded: false, realCredentialsRead: false, requests: requests.length, phases: audits.map((a) => JSON.parse(a.request).phase), sameRoute: true, thinkingOffVerified: true, maxTokens: 2048, temperature: 0, noToolsOrHistory: true, canonicalOperations: true, globalApplied: !invalidReview && scenario === "preference", invalidReviewIsolated: invalidReview, sourceProcessed: true, usage: audits.map((a) => JSON.parse(a.usage)) };
  } finally { await service.close(); try { await ctx.fiber.dispose(); } finally { server.closeAllConnections(); await new Promise((done) => server.close(done)); } }
}
