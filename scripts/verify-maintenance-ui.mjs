import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { MemoryService } from "../src/service.mjs";
import { registerIntegration } from "../dsh/integration.mjs";
import { operation, approve, model, draft } from "../tests/helpers/kernel.mjs";

const require = createRequire(join(process.env.DSH_DEV_MODULES ?? join(process.cwd(), "node_modules"), "__maintenance-ui.cjs"));
const { build } = require("esbuild"), { chromium, expect } = require("@playwright/test");
const output = ".cache/conversation-maintenance/ui", workspace = "D:/synthetic-maintenance-ui/project";
await mkdir(output, { recursive: true });
const service = new MemoryService({ filename: ":memory:", client: { ready: async () => false } }), events = {}, tools = [];
registerIntegration({ on: (name, fn) => { events[name] = fn; }, tools: { register: t => tools.push(t) }, effect() {}, logger: { warn() {} } }, service);
const agent = { session: { header: { id: "ui-session", cwd: workspace } } }, question = "TypeScript 是替代原来的 Python，还是新增独立模块？";
const old = service.manual({ kind: "fact", scope: "project", content: "项目使用 Python。" }, { workspace });
const sourceId = service.store.source({ sessionId: "origin", eventId: "proposal", role: "user", projectId: workspace, text: "项目拟改用 TypeScript。" });
const candidate = service.store.save({ kind: "fact", scope: "project", content: "项目使用 TypeScript。", projectId: workspace, status: "pending", evidence: [{ sourceId, quote: "项目拟改用 TypeScript。" }], attributes: { legacy: false } }, { supersedes: old.id });
const send = (role, text, seq) => events["session/event"](agent.session, { type: `${role}/message`, seq, time: Date.now() + seq, data: role === "user" ? { source: { kind: "user" }, content: [{ type: "text", text }] } : { message: { content: [{ type: "text", text }] } } });
const step = text => events["agent/pre-step"]({ agent, signal: new AbortController().signal }, async () => ({ kind: "enter", messages: [{ id: text, source: { kind: "user" }, content: [{ type: "text", text }] }] }));
const nodeFrom = result => ({ data: result.messages[0] });
model(service, () => draft([])); send("user", "继续 TypeScript 项目的实现。", 1);
let node = nodeFrom(await step("继续 TypeScript 项目的实现。"));
assert.equal((await tools.find(t => t.name === "dsh_memory_clarify").execute({ id: candidate.id, version: candidate.version, question, taskImpact: "当前需要选择实现语言和模块结构。" }, { agent })).shouldAsk, true);
send("assistant", question, 2);
const bundle = await build({ stdin: { contents: `import React, { useState } from "react"; import { createRoot } from "react-dom/client"; import { App, RecallCard } from "./ui/plugin.jsx";
const root = createRoot(document.getElementById("app"));
function Chat({ initial }) { const [node, setNode] = useState(initial), [reply, setReply] = useState(""); return <main className="chat"><h1>项目实现</h1><p className="user">继续 TypeScript 项目的实现。</p><RecallCard node={node}/><p className="assistant">${question}</p>{reply ? <><p className="user">替代，以后都用 TypeScript。</p><p className="assistant" role="status">{reply}</p></> : <button onClick={async () => { const r = await window.memoryReply(); setNode(r.node); setReply(r.reply); }}>发送：替代，以后都用 TypeScript。</button>}</main>; }
window.showChat = node => root.render(<Chat initial={node}/>); window.showLibrary = () => root.render(<App call={window.memoryCall}/>);`, resolveDir: process.cwd(), loader: "jsx" }, bundle: true, format: "iife", platform: "browser", write: false, loader: { ".css": "text" }, nodePaths: [dirname(dirname(require.resolve("react/package.json")))], define: { "process.env.NODE_ENV": '"production"' } });
const browser = await chromium.launch({ channel: "msedge", headless: true }), page = await browser.newPage({ viewport: { width: 1180, height: 900 } }), errors = [], screenshots = [];
page.on("pageerror", e => errors.push(e.message));
try {
  await page.exposeFunction("memoryCall", op => service.invoke(op, { workspace: op.workspace ?? workspace }));
  await page.exposeFunction("memoryReply", async () => {
    send("user", "替代，以后都用 TypeScript。", 3);
    const calls = model(service, p => draft([operation(p, { action: "update", intent: "correct", kind: "fact", scope: "project", content: candidate.content, authorization: "explicit", targetId: old.id, targetVersion: old.version, evidence: p.sources.filter(s => s.role === "user" && !s.contextOnly).flatMap(s => s.anchors.map(a => ({ sourceId: s.sourceId, anchorId: a.id }))) })]), approve);
    node = nodeFrom(await step("替代，以后都用 TypeScript。"));
    assert.equal(calls.length, 2); assert.equal(service.store.get(candidate.id).status, "active"); assert.equal(service.store.get(old.id).status, "superseded");
    return { node, reply: "已更新为 TypeScript，原来的 Python 方案已替代。" };
  });
  await page.setContent('<html lang="zh-CN"><meta charset="UTF-8"><style>body{margin:0;font:15px/1.7 system-ui,"Microsoft YaHei",sans-serif;background:#f8faf9;color:#223b36}body[data-ds-dark-theme]{background:#151d1b;color:#e1eae4}#app{height:900px}.chat{box-sizing:border-box;max-width:740px;margin:auto;padding:24px}.chat h1{font-size:22px}.chat p{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px 0}.chat .user{border-bottom:1px solid #8884}.chat button{font:inherit;background:transparent;color:inherit;border:1px solid #8886;border-radius:8px;padding:12px;max-width:100%;white-space:normal}</style><div id="app"></div></html>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text }); await page.evaluate(n => window.showChat(n), node);
  await expect(page.locator(".dsh-memory-recall summary")).toContainText("对话维护");
  async function capture(name, root) {
    for (const width of [1180, 390]) for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator("body").evaluate((e, dark) => dark ? e.setAttribute("data-ds-dark-theme", "") : e.removeAttribute("data-ds-dark-theme"), theme === "dark");
      assert.ok(await root.evaluate(e => e.scrollWidth <= e.clientWidth));
      const path = `${output}/${name}-${theme}-${width}.png`; await root.screenshot({ path, animations: "disabled" }); screenshots.push(path);
    }
  }
  await capture("chat-question", page.locator(".chat"));
  await page.getByRole("button", { name: "发送：替代，以后都用 TypeScript。", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已更新为 TypeScript");
  await capture("chat-resolved", page.locator(".chat"));
  const cancelled = service.store.save({ kind: "fact", scope: "project", content: "取消的实验候选。", projectId: workspace, status: "pending", evidence: [{ sourceId, quote: "项目拟改用 TypeScript。" }], attributes: { legacy: false } });
  service.store.dismissCandidate(cancelled.id, cancelled.version);
  await page.evaluate(() => window.showLibrary());
  const root = page.locator(".dsh-memory"), drawer = root.locator(".mm-detail");
  await root.getByRole("combobox", { name: "记忆状态", exact: true }).selectOption("dismissed");
  await expect(root.locator(".mm-card")).toHaveCount(1); await root.locator(".mm-card").click();
  await expect(drawer).toContainText("已取消"); await expect(drawer.getByRole("button", { name: "纠正 / 确认", exact: true })).toHaveCount(0);
  await expect(drawer.getByRole("button", { name: "遗忘", exact: true })).toHaveCount(0);
  await capture("dismissed-candidate", root); assert.deepEqual(errors, []);
  const report = { screenshots, errors, actualReactComponents: true, actualIntegrationHooks: true, answerAppliedWithoutLibraryConfirmation: true, dismissedIsNotForgotten: true, modelReplies: "synthetic two-stage judgments; not live semantic accuracy", externalModelCalls: 0, dailyProfileLoaded: false };
  await writeFile(`${output}/verification.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { await page.screenshot({ path: `${output}/failure.png`, fullPage: true }); throw error; }
finally { await browser.close(); await service.close(); }
