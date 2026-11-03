import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { MemoryService } from "../src/service.mjs";
import { MemoryUiService, TYPERT } from "./bridge.mjs";
import { registerIntegration } from "./integration.mjs";
import { createDshExtractor } from "./extractor.mjs";

export const inject = ["typert", "tools", "credentials", "llm"];
export function apply(ctx) {
  const service = new MemoryService({ filename: join(resolveDshHome(), "storages", "dsh-memory", "memory.sqlite"), credential: async (ref) => (await ctx.credentials.resolve(ref))?.value ?? null, notify: (message) => { service.lastWarning = message; ctx.logger.info(message); } });
  service.extractor = createDshExtractor(ctx, service.store);
  ctx.effect(() => ctx.reflect.provide("memoryWorkbench", { service }));
  ctx.plugin(MemoryUiService);
  ctx.typert.register(TYPERT);
  registerIntegration(ctx, service);
  service.start();
  ctx.effect(() => () => service.close());
  ctx.logger.info("DSH-RAG-Memory 0.1.5 已启用；只记录启用后到达的新对话片段");
}
