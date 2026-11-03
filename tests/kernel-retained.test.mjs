import test from "node:test";

import assert from "node:assert/strict";

import { MemoryService } from "../src/service.mjs";

import { registerIntegration } from "../dsh/integration.mjs";

import { MemoryStore } from "../src/store.mjs";

import { validityTime } from "../src/domain.mjs";

import { DatabaseSync } from "node:sqlite";

import { mkdtempSync, rmSync } from "node:fs";

import { join, resolve, relative } from "node:path";

import { tmpdir } from "node:os";

const workspace = "D:/synthetic-v3/project"; const client = { ready: async () => false };

function source(service, text, id = "source") { service.store.source({ id, sessionId: "v3-session", projectId: workspace, eventId: id, role: "user", text, turnId: id }); return { sourceId: id, start: 0, end: text.length }; }

function fixture(t, extra = {}) { const s = new MemoryService({ filename: ":memory:", client, ...extra }); t.after(() => s.close()); return s; }

function seed(s, content = "邮件索引使用 SQLite。", extra = {}) { return s.manual({ kind: "fact", scope: "project", content, ...extra }, { workspace }); }

function temp(t) { const dir = mkdtempSync(join(tmpdir(), "dsh-logic-v3-")); t.after(() => { const child = relative(resolve(tmpdir()), resolve(dir)); assert.ok(child.startsWith("dsh-logic-v3-") && !child.includes("..")); rmSync(dir, { recursive: true, force: true }); }); return join(dir, "memory.sqlite"); }

test("v3 回归：明确过期的条目不参与正常召回，历史读取保留", async (t) => {
  const service = new MemoryService({ filename: ":memory:", client, now: () => Date.parse("2026-11-03T00:00:00Z") }); t.after(() => service.close());
  const e = source(service, "临时发布窗口有效期截止 2026-11-01。");
  const row = service.store.save({ kind: "fact", scope: "project", projectId: workspace, content: "发布窗口有效。", evidence: [{ sourceId: e.sourceId, quote: service.store.getSource(e.sourceId).text }] });
  service.store.setAttributes(row.id, { validUntil: "2026-11-01T23:59:59Z" });
  assert.equal((await service.search("发布窗口", workspace, { cloud: false })).length, 0);
  assert.equal((await service.search("发布窗口", workspace, { cloud: false, history: true }))[0].id, row.id);
});

test("v3 回归：已注入快照在遗忘后失效，同一消息下一步不再注入", async (t) => {
  const service = new MemoryService({ filename: ":memory:", client }); t.after(() => service.close());
  const row = service.manual({ kind: "fact", scope: "project", content: "索引使用 SQLite。" }, { workspace });
  const events = {}, ctx = { on: (name, f) => { events[name] = f; }, tools: { register() {} }, effect() {}, logger: { warn() {} } };
  registerIntegration(ctx, service);
  const agent = { session: { header: { id: "snapshot-session", cwd: workspace } } }, signal = new AbortController().signal;
  const decision = { kind: "enter", messages: [{ id: "message", source: { kind: "user" }, content: [{ type: "text", text: "SQLite" }] }] };
  const first = await events["agent/pre-step"]({ agent, signal }, async () => decision);
  assert.equal(first.messages.length, 2); service.store.forget(row.id);
  const next = await events["agent/pre-step"]({ agent, signal }, async () => first);
  assert.equal(next.messages.length, 1);
});

test("v3 租约令牌、续租和过期调用阻止另一个执行者重复发送与提交", (t) => {
  let now = 0; const s = fixture(t, { now: () => now }); s.store.enqueue("extract", "lease", { sourceIds: [], projectId: workspace });
  const first = s.store.claim("extract"); now = 100000; assert.equal(s.store.renew(first), true); now = 130000; assert.equal(s.store.claim("extract"), null);
  s.store.startStage(first, "verification", "hash"); now = 300000; assert.equal(s.store.claim("extract"), null); assert.equal(s.store.owns(first), false); assert.throws(() => s.store.complete(first), /租约/);
  assert.equal(s.store.stage(first.id, "verification").state, "interrupted");
});

test("v3 核心层不吞掉相关项目记忆，总预算和整条内容受约束", async (t) => {
  const s = fixture(t); for (let i = 0; i < 8; i++) seed(s, `全局规则 ${i}：${"保留完整条件。".repeat(10)}`, { kind: "rule", scope: "global" });
  const relevant = seed(s, "预览服务端口为 8124，仅绑定回环地址。");
  const recalled = await s.recall("budget", "message", workspace, "预览服务端口");
  assert.ok(recalled.ids.includes(relevant.id)); assert.ok(recalled.ids.length <= 5); assert.ok(Buffer.byteLength(recalled.text) <= 1500); assert.ok(recalled.text.includes(relevant.content));
});

test("v3 历史搜索可见已替代条目，永不返回已遗忘内容；跨项目查询核对用户原话", async (t) => {
  const s = fixture(t), old = seed(s); const e = source(s, "改为 PostgreSQL。", "new");
  s.store.save({ kind: "fact", scope: "project", projectId: workspace, content: "邮件索引使用 PostgreSQL。", evidence: [{ sourceId: e.sourceId, quote: s.store.getSource(e.sourceId).text }] }, { supersedes: old.id });
  assert.equal((await s.search("SQLite", workspace, { cloud: false })).length, 0); assert.ok((await s.search("SQLite", workspace, { cloud: false, history: true })).some((r) => r.id === old.id)); s.store.forget(old.id);
  assert.equal((await s.search("SQLite", workspace, { cloud: false, history: true })).length, 0);
  const context = { kind: "agent", workspace, sessionId: "v3-session" };
  await assert.rejects(s.invoke({ action: "search", query: "SQLite", projectId: "D:/synthetic-v3/foreign" }, context), /跨项目/);
  source(s, "请查询 D:/synthetic-v3/foreign 项目的 SQLite 记录。", "authorization"); assert.deepEqual(await s.invoke({ action: "search", query: "SQLite", projectId: "D:/synthetic-v3/foreign" }, context), []);
});

test("v3 数据升级保留旧内容，重复打开幂等；错误迁移回滚新增列", (t) => {
  const file = temp(t), db = new DatabaseSync(file);
  db.exec("CREATE TABLE memories(id TEXT PRIMARY KEY,kind TEXT NOT NULL,scope TEXT NOT NULL,project_id TEXT,content TEXT NOT NULL,content_hash TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1,supersedes TEXT); INSERT INTO memories VALUES('legacy','fact','project','d:/synthetic-v3/project','原始内容','legacy-hash','active',1,1,7,NULL)"); db.close();
  let store = new MemoryStore(file); assert.equal(store.get("legacy").content, "原始内容"); assert.equal(store.get("legacy").version, 7); assert.equal(store.attributes("legacy").legacy, true); store.close();
  store = new MemoryStore(file); assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, 3); assert.equal(store.get("legacy").version, 7); store.close();
  const brokenFile = file.replace("memory.sqlite", "broken.sqlite"), broken = new DatabaseSync(brokenFile); broken.exec("CREATE TABLE memory_attributes(broken TEXT)"); broken.close();
  assert.throws(() => new MemoryStore(brokenFile), /already exists/); const inspect = new DatabaseSync(brokenFile); assert.equal(inspect.prepare("PRAGMA user_version").get().user_version, 0); assert.ok(!inspect.prepare("PRAGMA table_info(sources)").all().some((c) => c.name === "event_root")); inspect.close();
});

test("v3 Agent 读取工具拒绝已遗忘正文，管理界面仍可查看本地审计", async (t) => {
  const s = fixture(t), old = seed(s); s.store.forget(old.id); const tools = [], ctx = { on() {}, tools: { register: (v) => tools.push(v) }, effect() {}, logger: { warn() {} } }; registerIntegration(ctx, s);
  const read = tools.find((v) => v.name === "dsh_memory_read"); await assert.rejects(read.execute({ id: old.id }, { agent: { session: { header: { id: "v3-session", cwd: workspace } } } }), /已遗忘/);
  assert.equal((await s.invoke({ action: "read", id: old.id }, { workspace })).content, old.content);
});

test("v3 插件产生的助手消息不重新捕获为新来源", (t) => {
  const s = fixture(t), session = { id: "capture-plugin", header: { cwd: workspace } };
  s.capture(session, { type: "assistant/message", time: Date.now() + 100, seq: 1, data: { message: { source: { kind: "plugin:dsh-memory" }, content: [{ type: "text", text: "插件召回快照不能成为新事实" }] } } }); assert.equal(s.store.db.prepare("SELECT count(*) AS n FROM sources").get().n, 0);
});
