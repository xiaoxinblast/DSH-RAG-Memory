import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { upstream, workflow, selectRelease, inRange, completedAttempt } from "./contracts.mjs";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
if (process.argv[2] === "--check") {
  if (!inRange(process.argv[3], pkg.engines.dsh)) throw new Error(`NEEDS VALIDATION: ${process.argv[3]} is outside ${pkg.engines.dsh}; no installation or exemption`);
  process.exit(0);
}

async function api(path) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  const response = await fetch(`https://api.github.com/${path}`, { headers, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${path}`);
  return response.json();
}

async function pages(path, field) {
  const items = [];
  for (let page = 1; ; page++) {
    const data = await api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const rows = field ? data[field] : data;
    items.push(...rows);
    if (rows.length < 100) return items;
  }
}

const releases = await pages(`repos/${upstream}/releases`);
const { release, version } = selectRelease(releases, process.env.DSH_UPSTREAM_VERSION ?? "");
let status = inRange(version, pkg.engines.dsh) ? "test" : "needs-validation", previousRun;
// Run history persists independently of cache eviction and artifact/log retention.
// The workflow concurrency group serializes selection and testing across dispatches.
if (status === "test" && process.env.GITHUB_REPOSITORY && process.env.DSH_RETRY !== "true") {
  const runs = await pages(`repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/${workflow}/runs?head_sha=${process.env.GITHUB_SHA}&status=completed`, "workflow_runs");
  for (const run of runs) {
    if (run.id === Number(process.env.GITHUB_RUN_ID)) continue;
    const jobs = await pages(`repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${run.id}/jobs`, "jobs");
    if (completedAttempt(jobs, version)) { status = "already-tested"; previousRun = run.html_url; break; }
  }
}
const selection = { version, tag: release.tag_name, release: release.html_url ?? `https://github.com/${upstream}/releases/tag/${release.tag_name}`, range: pkg.engines.dsh, revision: process.env.GITHUB_SHA ?? "local", status, previousRun };
const out = resolve(".cache/compatibility"); mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, "selection.json"), JSON.stringify(selection, null, 2));
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nshould_run=${status === "test"}\nstatus=${status}\n`);
const summary = `DSH **${version}**, plugin revision \`${selection.revision}\`, declared range \`${selection.range}\`.\n\nStatus: **${status}**.${previousRun ? ` Previous attempt: ${previousRun}` : ""}\n\n${status === "needs-validation" ? "Outside the declared range: no install, activation, exemption, range edit, or publication. Review and test a separate plugin change first." : status === "already-tested" ? "This upstream version and plugin SHA already completed an attempt (including failures). Use the manual retry input to repeat it." : "The Windows job will install the exact official SDK and the newly packed plugin in a disposable profile."}\n`;
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(JSON.stringify(selection));
if (status === "needs-validation") { console.error(`::warning::DSH ${version} needs validation; outside ${pkg.engines.dsh}`); process.exitCode = 1; }
