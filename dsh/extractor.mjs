import { randomUUID } from "node:crypto";
import { BlockAssembler, createSystemMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { EXTRACTION_PROMPT, extractionInput, parseExtraction } from "../src/extraction.mjs";

export async function listDshModels(llm) {
  const providers = await Promise.all(llm.listProviders().map(async (p) => {
    try { return { id: p.id, name: p.name, models: (await llm.listModels(p.id)).map((m) => ({ id: m.id, name: m.name })) }; }
    catch { return { id: p.id, name: p.name, models: [], error: "暂时无法读取模型列表，请检查 DSH 配置后刷新" }; }
  }));
  return providers;
}
export async function requireDshModel(llm, route) {
  let message;
  if (!route?.provider || !route?.model) message = "请在记忆的连接设置中单独选择 DSH 提炼模型";
  else if (!llm.listProviders().some((p) => p.id === route.provider)) message = "已选择的 DSH 提炼提供商不可用，请重新选择提炼模型";
  else {
    let models;
    try { models = await llm.listModels(route.provider); }
    catch { message = "无法读取已选择的 DSH 提炼模型，请检查 DSH 配置后重试"; }
    if (models && !models.some((m) => m.id === route.model)) message = "已选择的 DSH 提炼模型不可用，请重新选择；不会自动切换模型";
  }
  if (message) { const error = new Error(message); error.code = "WAIT_DSH_MODEL"; throw error; }
}

export function createDshExtractor(ctx, store) {
  return async (sources, existing, signal) => {
    const sessionId = sources[0]?.session_id;
    const route = store.settings().extractionRoute;
    await requireDshModel(ctx.llm, route);
    const combined = AbortSignal.any([signal, AbortSignal.timeout(90000)]);
    const messages = [createSystemMessage(EXTRACTION_PROMPT), createUserMessage({ source: { kind: "plugin:dsh-memory" }, content: [{ type: "text", text: extractionInput(sources, existing) }] })];
    const prepared = await ctx.llm.prepareCall({ provider: route.provider, model: route.model, temperature: 0, maxTokens: 2048 }, combined, (controls, info) => {
      const least = info.reasoning?.efforts?.[0]?.id;
      return least === undefined ? controls : { ...controls, reasoningEffort: least };
    });
    const id = randomUUID(), assembler = new BlockAssembler();
    // Keep the exact auxiliary request in the local memory audit log. No main-chat history or tools are sent.
    store.db.prepare("INSERT INTO extraction_calls(id,session_id,provider,model,request,status,created_at) VALUES(?,?,?,?,?,'running',?)").run(id, sessionId, prepared.config.provider, prepared.config.model, JSON.stringify({ config: prepared.config, messages }), store.now());
    try {
      for await (const chunk of prepared.stream({ ...prepared.config, messages, sessionId, purpose: "memory-extraction", signal: combined })) assembler.push(chunk);
      if (assembler.finish.kind !== "stop") throw new Error(`DSH 提炼未完成：${assembler.finish.kind}`);
      const text = assembler.blocks().filter((b) => b.type === "text").map((b) => b.text).join("");
      const usage = assembler.usage;
      store.db.prepare("UPDATE extraction_calls SET response=?,usage=?,status='done' WHERE id=?").run(text, usage ? JSON.stringify(usage) : null, id);
      return parseExtraction(text);
    } catch (error) {
      store.db.prepare("UPDATE extraction_calls SET status='failed',usage=?,error=? WHERE id=?").run(assembler.usage ? JSON.stringify(assembler.usage) : null, "DSH 提炼请求未完成或返回格式无效", id);
      throw error;
    }
  };
}
