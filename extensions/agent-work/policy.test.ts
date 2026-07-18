import assert from "node:assert/strict";
import {
  FEATURE_WORKFLOW_PROTOCOL,
  SUBAGENT_AMBIGUITY_PROTOCOL,
} from "./policy.ts";

assert.match(FEATURE_WORKFLOW_PROTOCOL, /requests a new feature or a meaningful behavior change/);
assert.match(FEATURE_WORKFLOW_PROTOCOL, /Do not wait for, suggest, or require slash commands/);
assert.match(FEATURE_WORKFLOW_PROTOCOL, /load and follow the requirements-interviewer skill/);
assert.match(FEATURE_WORKFLOW_PROTOCOL, /Do not write implementation code or delegate writing until requirements are validated/);
assert.match(FEATURE_WORKFLOW_PROTOCOL, /Never make the user remember internal commands/);
assert.match(FEATURE_WORKFLOW_PROTOCOL, /prefer agent_questionnaire/);
assert.match(FEATURE_WORKFLOW_PROTOCOL, /batches of 1–5/);
assert.match(FEATURE_WORKFLOW_PROTOCOL, /ui_unavailable or cancelled/);
assert.match(FEATURE_WORKFLOW_PROTOCOL, /Isolated subagents never receive agent_questionnaire/);
assert.match(FEATURE_WORKFLOW_PROTOCOL, /status=blocked/);

assert.match(SUBAGENT_AMBIGUITY_PROTOCOL, /You do not have interactive questionnaire tools/);
assert.match(SUBAGENT_AMBIGUITY_PROTOCOL, /status="blocked"/);
assert.match(SUBAGENT_AMBIGUITY_PROTOCOL, /coordinator will ask the user/);
assert.match(SUBAGENT_AMBIGUITY_PROTOCOL, /Do not attempt to call agent_questionnaire/);

console.log("policy tests passed");
