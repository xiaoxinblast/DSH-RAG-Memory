import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { MemoryService } from "../src/service.mjs";

const require = createRequire(join(process.env.DSH_DEV_MODULES ?? join(process.cwd(), "node_modules"), "__settings-ui.cjs"));
const { build } = require("esbuild"), { chromium, expect } = require("@playwright/test");
const output = ".cache/settings-ui";
await mkdir(output, { recursive: true });
const bundle = await build({ stdin: { contents: 'import React from "react"; import { createRoot } from "react-dom/client"; import { App } from "./ui/plugin.jsx"; createRoot(document.getElementById("app")).render(React.createElement(App, { call: window.memoryCall }));', resolveDir: process.cwd(), loader: "jsx" }, bundle: true, format: "iife", platform: "browser", write: false, loader: { ".css": "text" }, nodePaths: [dirname(dirname(require.resolve("react/package.json")))], define: { "process.env.NODE_ENV": '"production"' } });
let savedKey = null, responseStatus = 200, releaseTest, testCalls = 0;
const service = new MemoryService({ filename: ":memory:", credential: async () => savedKey, extractor: async () => [], fetcher: async () => ({ ok: responseStatus === 200, status: responseStatus, json: async () => ({ output: { embeddings: [{ text_index: 0, embedding: Array(1024).fill(0.1) }] }, usage: { total_tokens: 8 } }) }) });
service.store.configure({ workspaceId: "test-space", extractionRoute: { provider: "test-provider", model: "test-model" } });
const browser = await chromium.launch({ channel: "msedge", headless: true }), page = await browser.newPage({ viewport: { width: 1180, height: 1100 } }), checks = [], errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.exposeFunction("memoryCall", async (operation) => {
    if (operation.action === "models") return [{ id: "test-provider", name: "测试提供商", models: [{ id: "test-model", name: "合成测试模型" }] }];
    if (operation.action === "credential") { savedKey = operation.key; return { saved: true }; }
    if (operation.action === "testConnection") { testCalls++; await new Promise((resolve) => { releaseTest = resolve; }); }
    return service.invoke(operation);
  });
  await page.setContent('<html lang="zh-CN"><meta charset="UTF-8"><style>body{margin:0}#app{height:1100px}</style><div id="app"></div></html>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const root = page.locator(".dsh-memory");
  await root.getByRole("button", { name: "连接设置", exact: true }).click();
  const runtime = root.locator(".mm-panel").filter({ has: page.getByRole("heading", { name: "提炼与运行方式", exact: true }) });
  const connection = root.locator(".mm-panel").filter({ has: page.getByRole("heading", { name: "Qwen · 北京地域", exact: true }) });
  const credential = connection.getByRole("textbox", { name: /凭据引用|API Key 保存名称/ });
  const saveRuntime = runtime.getByRole("button", { name: "保存运行设置", exact: true });
  const saveConnection = connection.getByRole("button", { name: "保存连接", exact: true });
  const testConnection = connection.getByRole("button", { name: "测试连接", exact: true });
  const runtimeNotice = runtime.getByRole("status"), connectionNotice = connection.getByRole("status");

  await credential.fill("test-space.cn-beijing.maas.aliyuncs.com");
  await saveRuntime.click();
  await expect(runtimeNotice).toContainText("设置已保存");
  assert.equal(service.store.settings().credentialRef, "DSH_MEMORY_API_KEY");
  checks.push("Qwen 输入无效时仍可独立保存运行设置，反馈位于运行按钮旁");

  await credential.fill("DSH_MEMORY_API_KEY");
  await runtime.getByRole("spinbutton", { name: "每月费用提醒", exact: true }).fill("0");
  await connection.getByRole("textbox", { name: "API Key", exact: true }).fill("synthetic-test-key");
  await saveConnection.click();
  await expect(connectionNotice).toContainText("连接配置已保存");
  assert.equal(service.store.settings().monthlyTarget, 10);
  checks.push("运行设置输入无效时仍可独立保存连接，API Key 使用合成值");

  await credential.fill("test-space.cn-beijing.maas.aliyuncs.com");
  await saveConnection.click();
  await expect(connection.getByRole("alert")).toContainText("DSH_MEMORY_API_KEY");
  assert.equal(service.store.settings().credentialRef, "DSH_MEMORY_API_KEY");
  await connection.screenshot({ path: `${output}/invalid-credential.png` });
  checks.push("将域名填入保存名称时就地说明正确格式，失败不修改已保存配置");

  const beforeUnsavedTest = testCalls;
  await testConnection.click();
  await expect(connection.getByRole("alert")).toContainText("先保存");
  assert.equal(testCalls, beforeUnsavedTest);
  checks.push("未保存的连接修改会得到明确提示，不测试旧配置");

  await credential.fill("");
  await saveConnection.click();
  await expect(connectionNotice).toContainText("连接配置已保存");
  await expect(credential).toHaveValue("DSH_MEMORY_API_KEY");
  await testConnection.click();
  await expect(connection.getByRole("button", { name: "测试中…", exact: true })).toBeDisabled();
  await expect(connectionNotice).toContainText("正在测试");
  await expect.poll(() => typeof releaseTest).toBe("function");
  await connection.screenshot({ path: `${output}/connection-pending.png` });
  releaseTest(); releaseTest = null;
  await expect(connectionNotice).toContainText("连接成功");
  await expect(testConnection).toBeEnabled();
  await page.waitForTimeout(5200);
  await expect(connectionNotice).toContainText("连接成功");
  await connection.screenshot({ path: `${output}/connection-success.png` });
  checks.push("空名称恢复默认值；测试立即显示进行中、禁用重复点击，并保留成功反馈");

  responseStatus = 401;
  await testConnection.click();
  await expect.poll(() => typeof releaseTest).toBe("function");
  releaseTest(); releaseTest = null;
  await expect(connection.getByRole("alert")).toContainText("Qwen HTTP 401");
  await expect(testConnection).toBeEnabled();
  await connection.screenshot({ path: `${output}/connection-error.png` });
  await root.getByRole("button", { name: /^记忆库/ }).click();
  await expect(root.getByRole("alert")).toHaveCount(0);
  await expect(root.getByRole("status").filter({ hasText: /连接|设置已保存/ })).toHaveCount(0);
  checks.push("HTTP 失败就地展示，切换到记忆库不携带设置反馈");

  await root.getByRole("button", { name: "连接设置", exact: true }).click();
  await runtime.getByRole("spinbutton", { name: "每月费用提醒", exact: true }).fill("10");
  await saveRuntime.click();
  await expect(runtimeNotice).toContainText("设置已保存");
  await runtime.getByRole("button", { name: "测试 DSH 提炼", exact: true }).click();
  await expect(runtimeNotice).toContainText("DSH 提炼调用成功");
  await expect(saveRuntime).toBeEnabled();
  await runtime.screenshot({ path: `${output}/runtime-success.png` });
  checks.push("DSH 保存及测试结果位于运行设置内，与连接反馈分开");
  for (const width of [1180, 768, 390]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.locator("body").evaluate((element, dark) => { if (dark) element.setAttribute("data-ds-dark-theme", ""); else element.removeAttribute("data-ds-dark-theme"); }, theme === "dark");
    await connection.getByRole("alert").scrollIntoViewIfNeeded();
    assert.ok(await root.evaluate((element) => element.scrollWidth <= element.clientWidth));
    await connection.screenshot({ path: `${output}/connection-${theme}-${width}.png` });
  }
  checks.push("1180/768/390 像素宽度及明暗主题截图，无水平溢出");
  assert.deepEqual(errors, []);
  const report = { checks, errors, realQwen: false, realDsh: false, syntheticDataOnly: true };
  await writeFile(`${output}/verification.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) { await page.screenshot({ path: `${output}/failure.png`, fullPage: true }); throw error; }
finally { releaseTest?.(); await browser.close(); await service.close(); }
