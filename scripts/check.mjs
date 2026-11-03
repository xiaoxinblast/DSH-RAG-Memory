import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
async function check(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await check(file);
    else if (entry.name.endsWith(".mjs")) {
      const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      if (r.status) { process.stderr.write(r.stderr); process.exitCode = 1; }
    }
  }
}
for (const dir of ["src", "dsh", "scripts", "tests"]) await check(dir);
