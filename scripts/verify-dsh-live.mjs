import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const require = createRequire(join(process.env.DSH_DEV_MODULES ?? join(process.cwd(), "node_modules"), "__live.cjs"));
const { chromium, expect } = require("@playwright/test");
const url = process.argv[2], home = resolve(".cache/home");
if (!url || new URL(url).hostname !== "127.0.0.1") throw new Error("只接受隔离 Host 回环地址");
const db = new DatabaseSync(join(home, "storages/dsh-memory/memory.sqlite"), { readOnly: true });
const before = db.prepare("SELECT count(*) AS n FROM extraction_calls").get().n;
const memories = db.prepare("SELECT count(*) AS n FROM memories").get().n;
const browser = await chromium.launch({ channel: "msedge", headless: true }), page = await browser.newPage({ viewport: { width: 1600, height: 1050 } });
try {
  await page.goto(url); await page.waitForTimeout(1500); await page.keyboard.press("Escape");
  await page.getByRole("navigation").getByRole("button", { name: "DSH-RAG-Memory", exact: true }).click();
  const root = page.locator(".dsh-memory:visible");
  await root.getByRole("button", { name: "连接设置", exact: true }).click();
  await expect(root.getByRole("combobox", { name: "提炼模型", exact: true })).toHaveValue(JSON.stringify(["deepseek-account", "deepseek-flash"]));
  const start = performance.now();
  await root.getByRole("button", { name: "测试 DSH 提炼", exact: true }).click();
  await expect(root.getByRole("status").filter({ hasText: "DSH 提炼调用成功" })).toBeVisible({ timeout: 95000 });
  const latencyMs = performance.now() - start;
  const row = db.prepare("SELECT provider,model,status,usage,request FROM extraction_calls ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(row.provider, "deepseek-account"); assert.equal(row.model, "deepseek-flash"); assert.equal(row.status, "done");
  assert.equal(db.prepare("SELECT count(*) AS n FROM extraction_calls").get().n, before + 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM memories").get().n, memories);
  const request = JSON.parse(row.request); assert.equal(request.messages.length, 2); assert.equal(request.tools, undefined);
  await root.screenshot({ path: ".cache/screenshots/dsh-model-test-success.png" });
  const report = { realDshCall: true, syntheticTextOnly: true, provider: row.provider, model: row.model, status: row.status, usage: row.usage ? JSON.parse(row.usage) : null, latencyMs, memoriesUnchanged: true, costCny: null };
  await writeFile(".cache/dsh-live-verification.json", JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (e) { await rootScreenshot(); throw e; }
finally { db.close(); await browser.close(); }
async function rootScreenshot() { await page.screenshot({ path: ".cache/screenshots/dsh-live-failure.png" }).catch(() => {}); console.log(JSON.stringify({ uiAlert: await page.getByRole("alert").allTextContents() })); }
