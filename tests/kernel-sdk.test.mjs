import test from "node:test";
import assert from "node:assert/strict";
import { verifyKernelSdk } from "../scripts/verify-kernel-sdk.mjs";
for (const mode of [{}, { invalidFirst: true }, { invalidReview: true }]) test(`真实 SDK 本机两阶段回环 ${JSON.stringify(mode)}，无外网与真实凭据`, async t => {
  const report = await verifyKernelSdk(mode); assert.equal(report.externalModelCalls, 0); assert.equal(report.requests, 2); assert.equal(report.globalApplied, !mode.invalidReview); assert.deepEqual(report.phases, ["extraction", "verification"]);
  t.diagnostic(JSON.stringify(report));
});
for (const scenario of ["forget", "group"]) test(`真实 SDK 最小遗忘与最终记忆单元 ${scenario}`, async t => {
  const report = await verifyKernelSdk({ scenario }); assert.equal(report.requests, 2); assert.equal(report.externalModelCalls, 0);
  assert.equal(report.globalApplied, false); t.diagnostic(JSON.stringify(report));
});
