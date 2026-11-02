import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
for (const dir of ["src", "dsh", "scripts", "tests"]) for (const name of await readdir(dir)) if (name.endsWith(".mjs")) {
  const r = spawnSync(process.execPath, ["--check", `${dir}/${name}`], { encoding: "utf8" });
  if (r.status) { process.stderr.write(r.stderr); process.exitCode = 1; }
}
