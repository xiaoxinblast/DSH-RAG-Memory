import test from "node:test";
import assert from "node:assert/strict";
import { parseOperations, parseReview, PROTOCOL_VERSION } from "../src/extraction.mjs";

const sources = [{ id: "s", role: "user", text: "项目使用 SQLite。", project_id: "d:/synthetic/kernel", contextOnly: false }];
const evidence = [{ sourceId: "s", anchorId: "p1" }];
const semantics = { certainty: "confirmed", authorization: "ordinary", eventState: "not_applicable", unit: "self_contained", authorizationEvidence: [], restores: null };
const op = (extra = {}) => ({ action: "add", intent: "statement", content: "项目使用 SQLite。", kind: "fact", scope: "project", targetId: null, targetVersion: null, evidence, ...semantics, ...extra });
const draft = operations => parseOperations(JSON.stringify({ version: PROTOCOL_VERSION, operations }), sources);
const review = (items, units) => parseReview(JSON.stringify({ version: PROTOCOL_VERSION, units }), sources, items);
const decision = (id, extra = {}) => ({ members: [id], decision: "approve", reason: "模拟证据核对", evidence, ...semantics, ...extra });

test("kernel 协议：坏项隔离保留稳定编号，不修补非法字段", () => {
  const d = draft([op(), null, op({ content: "另一个事实" }), op({ evidence: [{ sourceId: "s", anchorId: "fake" }] })]);
  assert.deepEqual(d.operations.map(o => o.id), ["op0", "op2"]);
  assert.deepEqual(d.errors.map(e => e.id), ["op1", "op3"]);
  assert.equal(d.version, PROTOCOL_VERSION);
  assert.equal(draft([op({ intent: "decision" })]).operations.length, 0);
});
test("kernel 协议：复核乱序、缺项、重复与未知编号只冻结相应项", () => {
  const d = draft([op(), op(), op()]);
  const r = review(d.operations, [decision("op2"), decision("op0"), decision("op0"), decision("foreign")]);
  assert.deepEqual(r.units.map(x => x.id), ["op2"]);
  assert.deepEqual(new Set(r.errors.map(x => x.id)), new Set(["op0", "op1", "foreign"]));
  const bad = review(d.operations, [decision("op0"), decision("op1", { decision: "pending" }), decision("op2", { evidence: [] })]);
  assert.deepEqual(bad.units.map(x => x.id), ["op0"]);
  assert.equal(bad.errors.length, 2);
});
test("kernel 协议：坏 JSON、旧版本、超限和模型自造宿主字段不接受", () => {
  for (const text of ["{", "null", JSON.stringify({ version: 4, operations: [] }), JSON.stringify({ version: PROTOCOL_VERSION, operations: Array(13).fill(op()) }), JSON.stringify({ version: PROTOCOL_VERSION, operations: [], errors: [] })]) assert.throws(() => parseOperations(text, sources));
  assert.equal(draft([]).operations.length, 0);
  assert.equal(draft([op({ id: "override" })]).errors.length, 1);
});
test("kernel 协议：复核不能修改正文、范围或目标，引用须属于冻结来源", () => {
  const d = draft([op()]);
  for (const patch of [{ content: "改写" }, { targetId: "other" }, { scope: "global" }, { evidence: [{ sourceId: "fake", anchorId: "p1" }] }]) assert.equal(review(d.operations, [decision("op0", patch)]).units.length, 0);
});
