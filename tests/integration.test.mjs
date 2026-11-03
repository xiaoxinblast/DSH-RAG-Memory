import test from "node:test";
import assert from "node:assert/strict";
import { MemoryService } from "../src/service.mjs";
import { registerIntegration } from "../dsh/integration.mjs";
import { operation, approve, model, draft } from "./helpers/kernel.mjs";
const workspace = "D:/memory-tests/host";
function setup(t) {
  const service = new MemoryService({ filename: ":memory:" }); t.after(() => service.close());
  const events = {}, tools = [], ctx = { on: (name, fn) => { events[name] = fn; }, tools: { register: (tool) => tools.push(tool) }, effect: () => {}, logger: { warn: () => {} } };
  registerIntegration(ctx, service);
  const agent = { session: { header: { id: "host-session", cwd: workspace } } };
  return { service, events, tools, agent };
}
test("真实 DSH SDK 工具注册及首轮独立快照，不改写用户消息", async (t) => { const { service, events, tools, agent } = setup(t); assert.equal(tools.length, 6); service.manual({ kind: "fact", scope: "project", content: "Host 使用 SQLite" }, { workspace }); const user = { id: "user-1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "SQLite" }] }; const decision = { kind: "enter", messages: [user] }; const result = await events["agent/pre-step"]({ agent, signal: new AbortController().signal }, async () => decision); assert.equal(result.messages.length, 2); assert.equal(result.messages[1], user); assert.equal(result.messages[0].source.form, "snapshot"); assert.equal(result.messages[0].source.kind, "plugin:dsh-memory"); const again = await events["agent/pre-step"]({ agent, signal: new AbortController().signal }, async () => result); assert.equal(again.messages.length, 2); });
test("成功压缩后重注入，失败压缩不增加代次", async (t) => { const { service, events, agent } = setup(t); service.manual({ kind: "fact", scope: "project", content: "Host SQLite" }, { workspace }); const decision = { kind: "enter", messages: [{ id: "m", source: { kind: "user" }, content: [{ type: "text", text: "SQLite" }] }] }; const run = () => events["agent/pre-step"]({ agent, signal: new AbortController().signal }, async () => decision); assert.equal((await run()).messages[0].source.generation, 0); events["session/event"](agent.session, { type: "compaction/end", data: { error: "failed" } }); assert.equal((await run()).messages[0].source.generation, 0); events["session/event"](agent.session, { type: "compaction/end", data: {} }); assert.equal((await run()).messages[0].source.generation, 1); });
test("子代理不自动注入记忆", async (t) => { const { service, events, agent } = setup(t); service.manual({ kind: "fact", scope: "project", content: "SQLite" }, { workspace }); agent.session.header.origin = "subagent"; const decision = { kind: "enter", messages: [{ id: "m", source: { kind: "user" }, content: [{ type: "text", text: "SQLite" }] }] }; assert.equal(await events["agent/pre-step"]({ agent, signal: new AbortController().signal }, async () => decision), decision); });

test("宿主对话维护：无已确认记忆也呈现相关候选，回答在下一步自动处理", async t => {
  const { service, events, tools, agent } = setup(t), session = agent.session;
  const sourceId = service.store.source({ sessionId: "origin", eventId: "idea", role: "user", text: "报告拟使用 Markdown。", projectId: workspace });
  const candidate = service.store.save({ content: "报告使用 Markdown。", kind: "fact", scope: "project", projectId: workspace, status: "pending", evidence: [{ sourceId, quote: "报告拟使用 Markdown。" }], attributes: { legacy: false } });
  const send = (role, text, seq) => events["session/event"](session, { type: `${role}/message`, seq, time: Date.now() + seq, data: role === "user" ? { source: { kind: "user" }, content: [{ type: "text", text }] } : { message: { content: [{ type: "text", text }] } } });
  const decision = text => ({ kind: "enter", messages: [{ id: text, source: { kind: "user" }, content: [{ type: "text", text }] }] });
  const step = value => events["agent/pre-step"]({ agent, signal: new AbortController().signal }, async () => value);
  send("user", "继续 Markdown 报告。", 1); model(service, () => draft([]));
  const first = await step(decision("继续 Markdown 报告。"));
  assert.equal(first.messages[0].source.maintenance, true); assert.deepEqual(first.messages[0].source.memoryIds, []);
  assert.equal(service.store.dashboard().injectionTokens, Buffer.byteLength(first.messages[0].content[0].text, "utf8"));
  const tool = tools.find(t => t.name === "dsh_memory_clarify"); assert.ok(tool);
  const result = await tool.execute({ id: candidate.id, version: candidate.version, question: "报告确定长期使用 Markdown 吗？", taskImpact: "当前要选择报告生成格式。" }, { agent });
  assert.equal(result.shouldAsk, true); send("assistant", result.question, 2); send("user", "确定，以后都用 Markdown。", 3);
  const calls = model(service, p => draft([operation(p, { content: candidate.content, authorization: "explicit", evidence: p.sources.filter(s => s.role === "user" && !s.contextOnly).flatMap(s => s.anchors.map(a => ({ sourceId: s.sourceId, anchorId: a.id }))) })]), approve);
  const final = await step(decision("确定，以后都用 Markdown。"));
  assert.equal(calls.length, 2); assert.equal(service.store.get(candidate.id).status, "active");
  assert.match(final.messages[0].content[0].text, /resolved/);
  await step(final); assert.equal(calls.length, 2);
});
