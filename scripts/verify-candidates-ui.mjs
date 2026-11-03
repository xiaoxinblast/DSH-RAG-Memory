import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { MemoryService } from "../src/service.mjs";

const require = createRequire(join(process.env.DSH_DEV_MODULES ?? join(process.cwd(), "node_modules"), "__candidates-ui.cjs"));
const { build } = require("esbuild"), { chromium, expect } = require("@playwright/test");
const output = process.env.DSH_UI_OUTPUT ?? ".cache/candidates-ui", workspace = "D:/synthetic-candidate-ui/project";
await mkdir(output, { recursive: true });
const bundle = await build({ stdin: { contents: 'import React from "react"; import { createRoot } from "react-dom/client"; import { App } from "./ui/plugin.jsx"; createRoot(document.getElementById("app")).render(React.createElement(App, { call: window.memoryCall }));', resolveDir: process.cwd(), loader: "jsx" }, bundle: true, format: "iife", platform: "browser", write: false, loader: { ".css": "text" }, nodePaths: [dirname(dirname(require.resolve("react/package.json")))], define: { "process.env.NODE_ENV": '"production"' } });
const service = new MemoryService({ filename: ":memory:", client: { ready: async () => false } });
function seed(name, oldContent, newContent) {
  const sourceId = `${name}:old`;
  service.store.source({ id: sourceId, sessionId: name, projectId: workspace, eventId: "old", role: "user", text: oldContent });
  const old = service.store.save({ kind: "fact", scope: "project", content: oldContent, projectId: workspace, evidence: [{ sourceId, quote: oldContent }] });
  const currentId = `${name}:new`;
  service.store.source({ id: currentId, sessionId: name, projectId: workspace, eventId: "new", role: "user", text: newContent });
  const proposal = service.store.save({ kind: "fact", scope: "project", content: newContent, projectId: workspace, status: "pending", evidence: [{ sourceId: currentId, quote: newContent }] }, { supersedes: old.id });
  return { old, proposal };
}
const replacement = seed("archive", "归档目录为 archive-old，旧记忆目前有效。", "归档目录更正为 archive-new，旧目录停用。"), stale = seed("timeout", "客户端超时为 30 秒。", "客户端超时拟更正为 45 秒。");
const globalSource = service.store.source({ sessionId: "global", projectId: workspace, eventId: "global", role: "user", text: "所有项目回复都用简体中文。" });
const global = service.store.save({ kind: "preference", scope: "global", status: "pending", content: "所有项目回复都用简体中文。", evidence: [{ sourceId: globalSource, quote: "所有项目回复都用简体中文。" }] });
const browser = await chromium.launch({ channel: "msedge", headless: true }), page = await browser.newPage({ viewport: { width: 1440, height: 900 } }), errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.exposeFunction("memoryCall", (op) => service.invoke(op, { workspace: op.workspace ?? workspace }));
  await page.setContent('<html lang="zh-CN"><meta charset="UTF-8"><style>body{margin:0}#app{height:900px}</style><div id="app"></div></html>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const root = page.locator(".dsh-memory"), drawer = root.locator(".mm-detail");
  await root.getByRole("combobox", { name: "记忆状态", exact: true }).selectOption("pending");
  await expect(root.locator(".mm-card")).toHaveCount(3);
  await root.locator(".mm-card").filter({ hasText: "archive-new" }).click();
  const note = drawer.getByRole("note", { name: "待确认操作", exact: true });
  await expect(note).toContainText("archive-old"); await expect(note).toContainText("确认前旧记忆继续使用");
  await drawer.getByRole("button", { name: "纠正 / 确认", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "确认并替代旧记忆", exact: true })).toBeVisible();
  for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator("body").evaluate((e, dark) => dark ? e.setAttribute("data-ds-dark-theme", "") : e.removeAttribute("data-ds-dark-theme"), theme === "dark");
    assert.ok(await root.evaluate((e) => e.scrollWidth <= e.clientWidth));
    await root.screenshot({ animations: "disabled", path: `${output}/replacement-${theme}-${width}.png` });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("body").evaluate((e) => e.removeAttribute("data-ds-dark-theme"));
  await drawer.getByRole("button", { name: "确认并替代旧记忆", exact: true }).click();
  await expect(drawer.getByRole("status")).toContainText("记忆已保存");
  assert.equal(service.store.get(replacement.old.id).status, "superseded"); assert.equal(service.store.get(replacement.proposal.id).status, "active");
  await drawer.getByRole("button", { name: "关闭详情", exact: true }).click();
  await root.locator(".mm-card").filter({ hasText: "简体中文" }).click();
  await expect(note).toContainText("所有项目"); await drawer.getByRole("button", { name: "纠正 / 确认", exact: true }).click();
  await expect(drawer.getByRole("button", { name: "确认全局共享", exact: true })).toBeVisible();
  await root.screenshot({ animations: "disabled", path: `${output}/global-confirmation.png` });
  await drawer.getByRole("button", { name: "确认全局共享", exact: true }).click(); await expect(drawer.getByRole("status")).toContainText("记忆已保存");
  assert.equal(service.store.get(global.id).status, "active");
  await drawer.getByRole("button", { name: "关闭详情", exact: true }).click();
  await root.locator(".mm-card").filter({ hasText: "45 秒" }).click(); await drawer.getByRole("button", { name: "纠正 / 确认", exact: true }).click();
  service.manual({ ...stale.old, content: "客户端超时已另行确认保持 30 秒，不再更改。", version: stale.old.version }, { workspace });
  await drawer.getByRole("button", { name: "确认并替代旧记忆", exact: true }).click(); await expect(drawer.getByRole("alert")).toContainText("旧记忆已变化");
  assert.equal(service.store.get(stale.proposal.id).status, "pending"); assert.equal(service.store.get(stale.old.id).status, "active");
  await root.screenshot({ animations: "disabled", path: `${output}/stale-confirmation-rejected.png` });
  assert.deepEqual(errors, []);
  const report = { replacementConfirmed: true, globalConfirmed: true, staleRejected: true, screenshots: 6, errors, syntheticOnly: true, externalModelCalls: 0, dailyProfileLoaded: false };
  await writeFile(`${output}/verification.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (e) { await page.screenshot({ path: `${output}/failure.png`, fullPage: true }); throw e; }
finally { await browser.close(); await service.close(); }
