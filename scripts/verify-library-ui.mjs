import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { MemoryService } from "../src/service.mjs";

const require = createRequire(join(process.env.DSH_DEV_MODULES ?? join(process.cwd(), "node_modules"), "__library-ui.cjs"));
const { build } = require("esbuild"), { chromium, expect } = require("@playwright/test");
const output = process.env.DSH_UI_OUTPUT ?? ".cache/library-ui", workspace = "D:/memory-library-ui/synthetic";
await mkdir(output, { recursive: true });
const bundle = await build({ stdin: { contents: 'import React from "react"; import { createRoot } from "react-dom/client"; import { App } from "./ui/plugin.jsx"; createRoot(document.getElementById("app")).render(React.createElement(App, { call: window.memoryCall }));', resolveDir: process.cwd(), loader: "jsx" }, bundle: true, format: "iife", platform: "browser", write: false, loader: { ".css": "text" }, nodePaths: [dirname(dirname(require.resolve("react/package.json")))], define: { "process.env.NODE_ENV": '"production"' } });
let seedTime = Date.now();
const service = new MemoryService({ filename: ":memory:", now: () => seedTime++ });
for (let i = 1; i <= 40; i++) {
  const content = `[合成记忆 ${String(i).padStart(2, "0")}] 用于验证长列表中的详情查看和滚动位置。只包含界面测试数据。`;
  const text = content + (i === 1 ? "这段较长的来源用于检查详情正文独立滚动，阅读时关闭按钮应保持可见。".repeat(24) : "");
  const sourceId = service.store.source({ sessionId: "synthetic-ui", eventId: `synthetic-${i}`, projectId: workspace, role: "user", text });
  service.store.save({ kind: "fact", scope: "project", projectId: workspace, content, evidence: [{ sourceId, quote: text }] });
}
const browser = await chromium.launch({ channel: "msedge", headless: true }), page = await browser.newPage({ viewport: { width: 1440, height: 850 } }), checks = [], errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.exposeFunction("memoryCall", (operation) => service.invoke(operation, { workspace: operation.workspace ?? workspace, sessionId: "synthetic-ui" }));
  await page.setContent('<html lang="zh-CN"><meta charset="UTF-8"><style>body{margin:0}#app{height:850px}</style><div id="app"></div></html>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const root = page.locator(".dsh-memory"), main = root.locator(".mm-main"), cards = root.locator(".mm-cards"), drawer = root.locator(".mm-detail");
  await expect(root.locator(".mm-card")).toHaveCount(40);
  const columns = () => cards.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length);
  const scrollTop = () => main.evaluate((element) => element.scrollTop);
  const initialColumns = await columns(); assert.ok(initialColumns > 1);
  const bottomCard = root.locator(".mm-card").last();
  await bottomCard.evaluate((element) => element.scrollIntoView({ block: "start" }));
  const initialScroll = await scrollTop(); assert.ok(initialScroll > 0);
  await bottomCard.click({ position: { x: 20, y: 20 } });
  await expect(drawer).toContainText("[合成记忆 01]");
  assert.equal(await columns(), initialColumns, "打开详情不能把卡片网格改成单列");
  const openedScroll = await scrollTop();
  assert.ok(Math.abs(openedScroll - initialScroll) <= 1, `打开底部记忆不能改变列表滚动位置：${initialScroll} -> ${openedScroll}`);
  await expect(drawer.getByRole("button", { name: "关闭详情", exact: true })).toBeInViewport();
  await root.screenshot({ animations: "disabled", path: `${output}/bottom-detail-desktop.png` });
  checks.push("长列表底部打开详情，卡片列数及列表滚动位置保持不变，详情立即可见");

  const body = drawer.locator(".mm-detail-body");
  await drawer.locator(".mm-source summary").first().click();
  await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  assert.ok(await body.evaluate((element) => element.scrollTop > 0));
  assert.ok(Math.abs(await scrollTop() - initialScroll) <= 1);
  await expect(drawer.getByRole("button", { name: "关闭详情", exact: true })).toBeInViewport();
  checks.push("详情正文独立滚动，不移动列表，关闭按钮持续可见");

  const nextCard = root.locator(".mm-card").nth(36);
  const nextContent = await nextCard.locator("p").textContent();
  await nextCard.click({ position: { x: 20, y: 20 } });
  await expect(drawer.locator(".mm-detail-body > .mm-content")).toHaveText(nextContent);
  assert.equal(await body.evaluate((element) => element.scrollTop), 0);
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(nextCard).toBeFocused();
  assert.equal(await columns(), initialColumns);
  checks.push("连续切换记忆会重置详情正文位置，Escape 关闭并将焦点还给原卡片");

  await nextCard.click({ position: { x: 20, y: 20 } });
  await drawer.getByRole("button", { name: "纠正 / 确认", exact: true }).click();
  await drawer.getByRole("textbox", { name: "记忆内容", exact: true }).fill("[界面纠正验收] 修改仅作用于合成记忆。");
  await drawer.getByRole("button", { name: "保存记忆", exact: true }).click();
  await expect(drawer.locator(".mm-detail-body > .mm-content")).toHaveText("[界面纠正验收] 修改仅作用于合成记忆。");
  await drawer.getByRole("button", { name: "关闭详情", exact: true }).click();
  await expect(drawer).toHaveCount(0);
  checks.push("抽屉中纠正记忆并保存，仍显示详情并可正常关闭");

  await root.getByRole("button", { name: "＋ 添加记忆", exact: true }).click();
  await drawer.getByRole("textbox", { name: "记忆内容", exact: true }).fill("[界面新增验收] 这是抽屉中添加的合成记忆。");
  await drawer.getByRole("button", { name: "保存记忆", exact: true }).click();
  await expect(drawer.locator(".mm-detail-body > .mm-content")).toHaveText("[界面新增验收] 这是抽屉中添加的合成记忆。");
  await expect(drawer.getByRole("status")).toContainText("记忆已保存");
  await drawer.getByRole("button", { name: "关闭详情", exact: true }).click();
  await expect(root.getByRole("button", { name: "＋ 添加记忆", exact: true })).toBeFocused();
  checks.push("抽屉中添加记忆、就地保存反馈及关闭后焦点返回均正常");

  for (const width of [1180, 768, 390]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 850 });
    await page.locator("body").evaluate((element, dark) => { if (dark) element.setAttribute("data-ds-dark-theme", ""); else element.removeAttribute("data-ds-dark-theme"); }, theme === "dark");
    const beforeColumns = await columns();
    const card = root.locator(".mm-card").last();
    await card.evaluate((element) => element.scrollIntoView({ block: "start" }));
    const beforeScroll = await scrollTop();
    await card.click({ position: { x: 20, y: 20 } });
    await expect(drawer.getByRole("heading", { name: "记忆详情", exact: true })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "关闭详情", exact: true })).toBeInViewport();
    assert.equal(await columns(), beforeColumns);
    assert.ok(Math.abs(await scrollTop() - beforeScroll) <= 1);
    assert.ok(await root.evaluate((element) => element.scrollWidth <= element.clientWidth));
    if (width === 390) assert.ok(Math.abs((await drawer.boundingBox()).width - width) <= 1);
    await root.screenshot({ animations: "disabled", path: `${output}/drawer-${theme}-${width}.png` });
    await drawer.getByRole("button", { name: "关闭详情", exact: true }).click();
    await expect(card).toBeFocused();
    assert.ok(Math.abs(await scrollTop() - beforeScroll) <= 1);
  }
  checks.push("1180/768/390 像素明暗主题截图，窄窗口全宽抽屉，开关详情不重排或跳动");
  assert.deepEqual(errors, []);
  const report = { checks, errors, realQwen: false, realDsh: false, syntheticDataOnly: true };
  await writeFile(`${output}/verification.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) { await page.screenshot({ path: `${output}/failure.png`, fullPage: true }); throw error; }
finally { await browser.close(); await service.close(); }
