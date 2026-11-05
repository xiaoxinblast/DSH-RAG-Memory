import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { readPluginMeta } from "@deepseek-ai/dsh-app-boot";
import { TYPERT } from "../dsh/bridge.mjs";

const manifestUrl = new URL("../package.json", import.meta.url), require = createRequire(manifestUrl);
const manifest = JSON.parse(readFileSync(manifestUrl, "utf8"));

test("改名后的包可由 DSH 读取中英文显示名称、图标及入口", () => {
  const metadata = readPluginMeta(manifest.name, manifestUrl.href);
  assert.equal(metadata.error, undefined);
  assert.equal(metadata.title.en, "DSH-RAG-Memory");
  assert.equal(metadata.title.zh, "DSH-RAG-Memory");
  assert.ok(metadata.icon.startsWith("data:image/svg+xml;"));
  assert.equal(require.resolve(manifest.name), require.resolve("./dsh/index.mjs"));
  assert.equal(require.resolve(`${manifest.name}/client`), require.resolve("./dist/client.js"));
});

test("安装元数据声明支持的 DSH 宿主与 SDK peer 版本一致", () => {
  assert.equal(manifest.engines.dsh, "0.2.2-rc.1");
  assert.equal(manifest.engines.node, ">=24.9");
  for (const version of Object.values(manifest.peerDependencies)) assert.equal(version, manifest.engines.dsh);
});

test("改名后的浏览器构建与宿主使用同一包标识及远程协议，侧栏显示仓库名称", async () => {
  let client, moduleId, mounted; const slots = [];
  runInNewContext(readFileSync(new URL("../dist/client.js", import.meta.url), "utf8"), { window: { __ModuleLoader__: { load(entry) {
    moduleId = entry.id;
    client = entry.factory((name) => { assert.equal(name, "react"); return {}; });
  } } } });
  const ctx = {
    effect: (fn) => fn(),
    uiConversation: { events: { register: () => () => {} } },
    locale: { register: () => () => {} },
    remote: { $mount: async (definition) => { mounted = definition; return () => {}; }, memoryUi: {} },
    slots: { inject: (_name, register) => register(), register: (options) => { slots.push(options); return () => {}; } },
    inject: async (_dependencies, apply) => apply(ctx)
  };
  await client.apply(ctx);
  assert.equal(moduleId, manifest.name);
  assert.equal(mounted.package, TYPERT.package);
  assert.equal(mounted.package, manifest.name);
  assert.equal(mounted.descriptors[0].id, TYPERT.invocations[0].id);
  assert.equal(mounted.descriptors[0].parameters[0].codec.typeSymbol, TYPERT.invocations[0].parameters[0].codec.typeSymbol);
  assert.equal(slots.find((slot) => slot.name === "sidebar.panellist").label, "DSH-RAG-Memory");
});
