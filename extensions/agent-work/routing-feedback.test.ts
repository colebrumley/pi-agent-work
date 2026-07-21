import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnoseMissingRouteFeedback, escalationFromRouteFeedback, readRouteFeedback, settleTerminalRoute } from "./routing-feedback.ts";

const root = await mkdtemp(join(tmpdir(), "agent-routing-feedback-"));
try {
  const attempt = { featureId: "f", taskId: "t", attempt: 1, model: "test/low" };
  const [first, duplicate] = await Promise.all([
    settleTerminalRoute(root, { ...attempt, outcome: "failed", diagnosis: { category: "task-complexity", reason: "bounded task exceeded tier" } }),
    settleTerminalRoute(root, { ...attempt, outcome: "accepted" }),
  ]);
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.record.outcome, "failed");
  const feedback = await readRouteFeedback(root);
  assert.equal(feedback.length, 1);
  assert.deepEqual(escalationFromRouteFeedback(feedback[0]), { previousModel: "test/low", diagnosis: feedback[0].diagnosis });
  const report = diagnoseMissingRouteFeedback([attempt, { featureId: "f", taskId: "other", attempt: 1 }], feedback);
  assert.equal(report.terminalRoutes, 2);
  assert.equal(report.feedbackRecords, 1);
  assert.deepEqual(report.missing, [{ featureId: "f", taskId: "other", attempt: 1 }]);
  await settleTerminalRoute(root, { featureId: "f", taskId: "other", attempt: 1, outcome: "accepted" });
  const complete = diagnoseMissingRouteFeedback([attempt, { featureId: "f", taskId: "other", attempt: 1 }], await readRouteFeedback(root));
  assert.equal(complete.terminalRoutes, complete.feedbackRecords, "every terminal route has exactly one feedback record");
  assert.deepEqual(complete.missing, []);
  console.log("routing feedback tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
