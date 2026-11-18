import { createRequire } from "node:module";
import { join } from "node:path";

// The override is also used by the existing local build scripts.
const require = createRequire(join(process.env.DSH_DEV_MODULES ?? join(process.cwd(), "node_modules"), "__compat.cjs"));
export const semver = require("semver");
export const upstream = "deepseek-ai/deepseek-harness";
export const workflow = "dsh-compatibility.yml";
export const smokeJobName = version => `Windows smoke (${version})`;

export function releaseVersion(release) {
  if (release.draft || !release.published_at || !release.tag_name?.startsWith("dsh-v")) return null;
  const version = release.tag_name.slice(5);
  return semver.valid(version) === version ? version : null;
}

export function selectRelease(releases, requested = "") {
  const available = releases.map(release => ({ release, version: releaseVersion(release) })).filter(row => row.version);
  const version = requested.replace(/^dsh-v/, "");
  if (version && semver.valid(version) !== version) throw new Error("Expected an exact DSH version, for example 0.2.2-rc.3");
  const selected = version ? available.find(row => row.version === version) : available.sort((a, b) => semver.rcompare(a.version, b.version))[0];
  if (!selected) throw new Error(`No published official release found for ${version || "DSH"}`);
  return selected;
}

export function inRange(version, range) {
  return semver.valid(version) === version && semver.satisfies(version, range, { includePrerelease: true });
}

export function completedAttempt(jobs, version) {
  return jobs.find(job => job.name === smokeJobName(version) && job.status === "completed" && job.conclusion !== "skipped");
}
