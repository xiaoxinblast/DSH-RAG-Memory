// Test-only resolution against one complete official SDK, without changing any profile.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modules = process.env.DSH_SDK_MODULES;
if (modules) {
  if (!isAbsolute(modules) || !existsSync(join(modules, "@deepseek-ai/dsh-app-boot/package.json"))) {
    throw new Error("DSH_SDK_MODULES must be an absolute node_modules directory containing the target DSH SDK");
  }
  const parentURL = pathToFileURL(join(resolve(modules), "__memory_sdk__.mjs")).href;
  registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@deepseek-ai/")) return nextResolve(specifier, { ...context, parentURL });
    return nextResolve(specifier, context);
  } });
}
