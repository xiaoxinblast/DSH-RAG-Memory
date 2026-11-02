import test from "node:test";
import assert from "node:assert/strict";
import { recallDefinition } from "../ui/recall.mjs";
test("对话卡片只认领本插件的记忆快照，不影响其他上下文或用户消息", () => {
  const match = recallDefinition.match["user/message"];
  assert.equal(match({ data: { id: "u", source: { kind: "user" } } }), null);
  assert.equal(match({ data: { id: "x", source: { kind: "plugin:other", form: "snapshot" } } }), null);
  assert.equal(match({ data: { id: "x", source: { kind: "plugin:dsh-memory", form: "notice" } } }), null);
  assert.deepEqual(match({ data: { id: "m", source: { kind: "plugin:dsh-memory", form: "snapshot" } } }), { id: "m", role: "start", exclusive: true });
});
test("记忆卡片保留位置、内容和稳定身份，可从持久会话记录重建", () => {
  const source = { kind: "plugin:dsh-memory", form: "snapshot", memoryIds: ["memory-1"] }, content = [{ type: "text", text: "来源明确的记忆" }];
  const state = recallDefinition.start(null, { event: { seq: 17, data: { source, content } } }), location = { kind: "step", turn: { turn: 1 }, step: { step: 1 } };
  const context = { key: "context-key", id: "message-id", state, start: { location } };
  assert.equal(recallDefinition.update(context), state);
  assert.deepEqual(recallDefinition.buildViewNode(context), { key: context.key, kind: "dsh-memory-recall", id: context.id, target: "chat", anchorSeq: 17, location, visibility: "visible", groupTree: "input", data: state });
});
