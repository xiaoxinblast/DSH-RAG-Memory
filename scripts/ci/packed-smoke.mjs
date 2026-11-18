import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { boot, getDshRuntimeVersion, evaluatePluginCompatibility, prepareProfileEntries } from "@deepseek-ai/dsh-app-boot";
import { SystemPrompt } from "@deepseek-ai/dsh-system-prompt";
import { ToolsService } from "@deepseek-ai/dsh-tools";
import { TypertRegistry } from "@deepseek-ai/dsh-typert-registry";
import { LlmRuntime, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionStore } from "@deepseek-ai/dsh-session";
import { CredentialProvider } from "@deepseek-ai/dsh-credentials";
import { inRange } from "./contracts.mjs";

class SyntheticCredentials extends CredentialProvider { async resolve() { return undefined; } }
const packageRoot = resolve(process.env.DSH_SMOKE_PACKAGE), out = resolve(process.env.DSH_SMOKE_OUT);
const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const runtime = getDshRuntimeVersion(), expected = process.env.DSH_EXPECTED_VERSION;
const report = { plugin: `${pkg.name}@${pkg.version}`, runtime, node: process.version, range: pkg.engines.dsh, realModelCalls: 0, dailyProfileLoaded: false };
let ctx;
try {
  assert.equal(runtime, expected);
  assert.ok(inRange(runtime, pkg.engines.dsh));
  assert.equal(evaluatePluginCompatibility(pkg), undefined);
  const require = createRequire(pathToFileURL(join(packageRoot, "package.json")));
  report.peers = Object.fromEntries(Object.entries(pkg.peerDependencies).filter(([name]) => name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-")).map(([name, range]) => {
    const filename = require.resolve(`${name}/package.json`), version = JSON.parse(readFileSync(filename, "utf8")).version;
    assert.equal(version, expected, `${name}: npm must not silently select another runtime`);
    assert.ok(inRange(version, range), `${name}: peer range`);
    return [name, version];
  }));
  const home = mkdtempSync(join(out, "home-")), config = join(home, "cordis.json"), errors = [];
  process.env.DSH_HOME = home; process.env.DSH_AGENTS_HOME = join(home, "agents");
  writeFileSync(config, "[]\n");
  const row = { id: "packed-memory", name: pathToFileURL(join(packageRoot, "dsh/index.mjs")).href };
  const start = () => boot("dsh-compatibility", config, [{ insert: [row] }], async host => {
    host.provide("profileContext", { dir: home });
    assert.equal(prepareProfileEntries(host, [row], pathToFileURL(config).href)[0].disabled, undefined);
    host.logger.exporter({ levels: { default: 2 }, export: m => {
      if (m.type === "warn" || m.type === "error") errors.push(m.args.map(String).join(" "));
    } });
    for (const [plugin, options] of [[SystemPrompt, {}], [ToolsService], [TypertRegistry], [LlmRuntime], [SessionStore], [SyntheticCredentials]]) await host.plugin(plugin, options);
  });
  ctx = await start();
  assert.ok(ctx.memoryWorkbench.service, "the installed package must actually activate");
  assert.equal(ctx.typert.local.get("memoryUi/invoke").id, `${pkg.name}#memoryUi/invoke`);
  assert.equal(ctx.tools.definitions().filter(t => t.name.startsWith("dsh_memory_")).length, 6);
  const workspace = join(home, "synthetic-project");
  const item = await ctx.memoryUi.invoke({ action: "save", scope: "project", kind: "fact", content: "SQLite compatibility smoke fixture.", workspace });
  const found = await ctx.memoryUi.invoke({ action: "search", query: "SQLite", workspace });
  assert.ok(found.some(row => row.id === item.id));
  assert.equal((await ctx.memoryUi.invoke({ action: "search", query: "SQLite", workspace: join(home, "other-project") })).length, 0);
  const session = ctx.sessions.create("synthetic-smoke", { meta: { cwd: workspace } });
  const users = ["SQLite", "Continue SQLite"].map(text => createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text }] }));
  assert.equal(session.append(users.map(user => ["user/message", user, { surfaceOp: "append" }])).length, 2);
  assert.equal(ctx.memoryWorkbench.service.store.db.prepare("SELECT COUNT(*) n FROM sources WHERE session_id=?").get(session.id).n, 2);
  const decision = await ctx.waterfall("agent/pre-step", { agent: { session }, messages: [users[1]], signal: new AbortController().signal }, () => ({ kind: "enter", messages: [users[1]] }));
  assert.equal(decision.messages[0].source.kind, "plugin:dsh-memory");
  assert.equal(decision.messages[1], users[1]);
  let browserModule;
  runInNewContext(readFileSync(join(packageRoot, "dist/client.js"), "utf8"), { window: { __ModuleLoader__: { load: value => { browserModule = value; } } } });
  assert.equal(browserModule.id, pkg.name); assert.equal(typeof browserModule.factory, "function");
  await ctx.fiber.dispose(); ctx = await start();
  assert.equal((await ctx.memoryUi.invoke({ action: "read", id: item.id, workspace })).content, item.content);
  const forgotten = await ctx.memoryUi.invoke({ action: "forget", id: item.id, version: item.version, workspace });
  assert.equal(forgotten.status, "forgotten");
  assert.equal((await ctx.memoryUi.invoke({ action: "search", query: "SQLite", workspace })).length, 0);
  assert.equal(existsSync(join(home, "compatibility.json")), false);
  assert.equal(readFileSync(process.env.DSH_KERNEL_NETWORK_LOG, "utf8"), "");
  assert.deepEqual(errors, []);
  Object.assign(report, { status: "passed", activation: true, sixTools: true, remote: true, localSaveReadSearch: true, projectIsolation: true, batchCapture: true, recall: true, restartPersistence: true, forget: true, browserEntry: true, externalAttempts: 0 });
} catch (error) { Object.assign(report, { status: "failed", error: error.stack }); throw error; }
finally {
  await ctx?.fiber.dispose();
  writeFileSync(join(out, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
