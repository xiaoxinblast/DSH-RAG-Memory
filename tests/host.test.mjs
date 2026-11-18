import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { boot, getDshRuntimeVersion, prepareProfileEntries } from "@deepseek-ai/dsh-app-boot";
import { Context } from "@deepseek-ai/cordis";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolsService } from "@deepseek-ai/dsh-tools";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import { LlmRuntime, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { CredentialProvider } from "@deepseek-ai/dsh-credentials";

// No ambient credential provider, persisted sessions, profile, or model adapter.
class TestCredentials extends CredentialProvider {
  async resolve() { return undefined; }
}

test("真实 DSH 宿主隔离启动、批量会话捕获、工具与远程注册及重启持久化", async t => {
  const cache = fileURLToPath(new URL("../.cache/", import.meta.url));
  mkdirSync(cache, { recursive: true });
  const home = mkdtempSync(join(cache, "sdk-host-")), config = join(home, "cordis.json");
  const oldHome = process.env.DSH_HOME, errors = [];
  process.env.DSH_HOME = home;
  writeFileSync(config, JSON.stringify([{ id: "memory", name: new URL("../dsh/index.mjs", import.meta.url).href }]));
  const start = () => boot("dsh", config, undefined, async ctx => {
    ctx.logger.exporter({ levels: { default: 2 }, export: m => {
      if (m.type === "warn" || m.type === "error") errors.push(m.args.map(String).join(" "));
    } });
    await ctx.plugin(SystemPrompt, {});
    await ctx.plugin(ToolsService);
    await ctx.plugin(TypertRegistry);
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(TestCredentials);
  });
  let ctx;
  try {
    ctx = await start();
    const service = ctx.memoryWorkbench.service, workspace = join(home, "project");
    assert.ok(existsSync(join(home, "storages/dsh-memory/memory.sqlite")));
    assert.deepEqual(ctx.tools.definitions().map(tool => tool.name).sort(),
      ["search", "read", "remember", "update", "forget", "clarify"].map(name => `dsh_memory_${name}`).sort());
    assert.equal(ctx.typert.local.get("memoryUi/invoke").id, "dsh-rag-memory#memoryUi/invoke");
    const item = service.manual({ scope: "project", kind: "fact", content: "Host 使用 SQLite。" }, { workspace });
    const rows = await ctx.memoryUi.invoke({ action: "list", workspace });
    assert.ok(rows.some(row => row.id === item.id));
    const session = ctx.sessions.create("synthetic-host", { meta: { cwd: workspace } });
    const users = ["查询 SQLite。", "继续 SQLite 项目。"].map(text => createUserMessage({
      source: { kind: "user" }, content: [{ type: "text", text }]
    }));
    const events = session.append(users.map(data => ["user/message", data, { surfaceOp: "append" }]));
    assert.equal(events.length, 2);
    assert.deepEqual(service.store.db.prepare("SELECT text FROM sources WHERE session_id=? ORDER BY rowid").all(session.id).map(source => source.text), users.map(user => user.content[0].text));
    const user = users[1], agent = { session }, payload = { agent, messages: [user], signal: new AbortController().signal };
    const decision = await ctx.waterfall("agent/pre-step", payload, () => ({ kind: "enter", messages: [user] }));
    assert.equal(decision.messages[0].source.kind, "plugin:dsh-memory");
    assert.match(decision.messages[0].content[0].text, /SQLite/);
    assert.equal(decision.messages[1], user);
    const read = ctx.tools.definitions().find(tool => tool.name === "dsh_memory_read");
    assert.equal((await read.execute({ id: item.id }, { agent })).id, item.id);
    await ctx.fiber.dispose();
    assert.equal(service.closed, true);
    assert.equal(service.abort.signal.aborted, true);
    ctx = await start();
    assert.equal(ctx.memoryWorkbench.service.store.get(item.id).content, item.content);
    assert.deepEqual(errors, []);
    t.diagnostic(JSON.stringify({ runtime: getDshRuntimeVersion(), isolatedHome: home, bootAndRestart: true, batchSources: events.length, registeredTools: 6, remoteService: true, realModelCalls: 0 }));
  } finally {
    try { await ctx?.fiber.dispose(); } finally {
      if (oldHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = oldHome;
    }
  }
});

test("真实宿主预检禁用范围外声明，并接受当前插件且不创建兼容豁免", async () => {
  const cache = fileURLToPath(new URL("../.cache/", import.meta.url));
  mkdirSync(cache, { recursive: true });
  const profile = mkdtempSync(join(cache, "compatibility-")), previous = join(profile, "previous");
  mkdirSync(previous);
  writeFileSync(join(previous, "package.json"), JSON.stringify({
    name: "dsh-rag-memory", version: "0.1.7", engines: { dsh: "0.2.1-rc.5" }
  }));
  writeFileSync(join(previous, "index.mjs"), "export function apply() {}\n");
  const ctx = new Context();
  ctx.provide("profileContext", { dir: profile });
  try {
    const rows = [
      { id: "current", name: new URL("../dsh/index.mjs", import.meta.url).href },
      { id: "previous", name: join(previous, "index.mjs") }
    ];
    const prepared = prepareProfileEntries(ctx, rows, import.meta.url);
    assert.equal(prepared[0].disabled, undefined);
    assert.equal(prepared[1].disabled, true);
    assert.equal(rows[1].disabled, undefined, "预检不得改写原配置");
    assert.equal(existsSync(join(profile, "compatibility.json")), false);
  } finally { await ctx.fiber.dispose(); }
});
