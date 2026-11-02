import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
const require = createRequire(join(process.env.DSH_DEV_MODULES ?? join(process.cwd(), "node_modules"), "__build.cjs"));
const { build } = require("esbuild");
await mkdir("dist", { recursive: true });
const output = await build({ entryPoints: ["ui/plugin.jsx"], bundle: true, format: "cjs", platform: "browser", target: "chrome130", external: ["react", "react-dom", "react-dom/client"], write: false, loader: { ".css": "text" }, define: { "process.env.NODE_ENV": '"production"' } });
await writeFile("dist/client.js", `window.__ModuleLoader__.load({id:"dsh-rag-memory",factory(require){const module={exports:{}};const exports=module.exports;\n${output.outputFiles[0].text}\nreturn module.exports.default;}});\n`);
console.log("Built DSH-RAG-Memory native client");
