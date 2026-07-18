import assert from "node:assert/strict";
import { FEATURE_WORKFLOW_PROTOCOL } from "./policy.ts";

assert.match(FEATURE_WORKFLOW_PROTOCOL, /requests a new feature or a meaningful behavior change/);
assert.match(FEATURE_WORKFLOW_PROTOCOL, /Do not wait for, suggest, or require slash commands/);
assert.match(FEATURE_WORKFLOW_PROTOCOL, /load and follow the requirements-interviewer skill/);
assert.match(FEATURE_WORKFLOW_PROTOCOL, /Do not write implementation code or delegate writing until requirements are validated/);
assert.match(FEATURE_WORKFLOW_PROTOCOL, /Never make the user remember internal commands/);

console.log("policy tests passed");
