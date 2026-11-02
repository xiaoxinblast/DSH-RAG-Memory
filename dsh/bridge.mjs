import { TypertRemoteService, isRemoteJsonValue } from "@deepseek-ai/dsh-typert-protocol";
import { listDshModels, requireDshModel } from "./extractor.mjs";

export const jsonCodec = { mode: "strict", typeSymbol: "dsh-memory#Json", jsonSchema: {}, create: () => ({ parse(value) { if (!isRemoteJsonValue(value)) throw new Error("Expected JSON"); return value; } }) };
export const descriptor = { id: "dsh-memory#memoryUi/invoke", service: "memoryUi", namespace: "memoryUi", method: "invoke", invocation: { kind: "direct" }, parameters: [{ name: "operation", wire: "operation", source: "json", codec: jsonCodec }], cancellation: { parameter: "signal" }, result: jsonCodec };
export const TYPERT = { package: "dsh-memory", face: "host", schemas: [], invocations: [descriptor], model: { services: [], events: [], objects: [] } };
export class MemoryUiService extends TypertRemoteService {
  static inject = ["memoryWorkbench", "credentials", "llm"];
  constructor(ctx) { super(ctx, "memoryUi"); }
  async invoke(operation, signal) {
    signal?.throwIfAborted();
    if (!operation || typeof operation.action !== "string") throw new Error("操作格式无效");
    const service = this.ctx.memoryWorkbench.service;
    if (operation.action === "models") return listDshModels(this.ctx.llm);
    if (operation.action === "settings" && operation.value?.extractionRoute && JSON.stringify(operation.value.extractionRoute) !== JSON.stringify(service.store.settings().extractionRoute)) await requireDshModel(this.ctx.llm, operation.value.extractionRoute);
    if (operation.action === "credential") {
      if (typeof operation.key !== "string" || !operation.key.trim() || operation.key.length > 4096) throw new Error("API Key 为空或过长");
      await this.ctx.credentials.set(service.store.settings().credentialRef, operation.key.trim());
      return { saved: true };
    }
    return service.invoke(operation, { workspace: operation.workspace, sessionId: "human-workbench" });
  }
}
