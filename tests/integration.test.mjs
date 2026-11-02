import test from "node:test";
import assert from "node:assert/strict";
import { MemoryService } from "../src/service.mjs";
import { registerIntegration } from "../dsh/integration.mjs";
const workspace = "D:/memory-tests/host";
function setup(t) {
  const service = new MemoryService({ filename: ":memory:" }); t.after(() => service.close());
  const events = {}, tools = [], ctx = { on: (name, fn) => { events[name] = fn; }, tools: { register: (tool) => tools.push(tool) }, effect: () => {}, logger: { warn: () => {} } };
  registerIntegration(ctx, service);
  const agent = { session: { header: { id: "host-session", cwd: workspace } } };
  return { service, events, tools, agent };
}
test("真实 DSH SDK 工具注册及首轮独立快照，不改写用户消息", async (t) => { const { service, events, tools, agent } = setup(t); assert.equal(tools.length, 5); service.manual({ kind: "fact", scope: "project", content: "Host 使用 SQLite" }, { workspace }); const user = { id: "user-1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "SQLite" }] }; const decision = { kind: "enter", messages: [user] }; const result = await events["agent/pre-step"]({ agent, signal: new AbortController().signal }, async () => decision); assert.equal(result.messages.length, 2); assert.equal(result.messages[1], user); assert.equal(result.messages[0].source.form, "snapshot"); assert.equal(result.messages[0].source.kind, "plugin:dsh-memory"); const again = await events["agent/pre-step"]({ agent, signal: new AbortController().signal }, async () => result); assert.equal(again.messages.length, 2); });
test("成功压缩后重注入，失败压缩不增加代次", async (t) => { const { service, events, agent } = setup(t); service.manual({ kind: "fact", scope: "project", content: "Host SQLite" }, { workspace }); const decision = { kind: "enter", messages: [{ id: "m", source: { kind: "user" }, content: [{ type: "text", text: "SQLite" }] }] }; const run = () => events["agent/pre-step"]({ agent, signal: new AbortController().signal }, async () => decision); assert.equal((await run()).messages[0].source.generation, 0); events["session/event"](agent.session, { type: "compaction/end", data: { error: "failed" } }); assert.equal((await run()).messages[0].source.generation, 0); events["session/event"](agent.session, { type: "compaction/end", data: {} }); assert.equal((await run()).messages[0].source.generation, 1); });
test("子代理不自动注入记忆", async (t) => { const { service, events, agent } = setup(t); service.manual({ kind: "fact", scope: "project", content: "SQLite" }, { workspace }); agent.session.header.origin = "subagent"; const decision = { kind: "enter", messages: [{ id: "m", source: { kind: "user" }, content: [{ type: "text", text: "SQLite" }] }] }; assert.equal(await events["agent/pre-step"]({ agent, signal: new AbortController().signal }, async () => decision), decision); });
