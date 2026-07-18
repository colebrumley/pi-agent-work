#!/usr/bin/env node
/**
 * Requirements Interviewer CLI — the deterministic surface.
 *
 * The interviewer skill drives a human conversation, then calls these commands
 * to validate, persist, and render. The CLI owns process integrity; the LLM
 * owns judgment. Commands:
 *
 *   init <feature> [--tier t] [--dir d]   create requirements.json + decision-log.json
 *   validate [--dir d]                    structural + completeness validation
 *   gaps [--dir d] [--json]               deterministic gap report (feeds questions)
 *   blockers [--dir d]                    unresolved items blocking handoff
 *   apply <patch.json> [--dir d]          apply a structured update, then validate
 *   decisions [--dir d]                   show the decision log
 *   defer <questionId> [--dir d]          mark a blocking question deferred
 *   accept-risk <questionId> [--dir d]    mark a question accepted as risk
 *   render-spec [--dir d] [--out f]       render the human requirements spec
 *   migrate [--dir d]                     persist deterministic schema-v1 → v2 migration
 *   render-handoff [--dir d] [--out f] [--force]   render (force is compatibility-only; no implicit bypass)
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { Patch } from "./state.ts";
import {
  loadState,
  saveState,
  newState,
  applyPatch,
  stateExists,
} from "./state.ts";
import type { Issue } from "./validate-requirements.ts";
import { validateRequirements } from "./validate-requirements.ts";
import { analyzeGaps } from "./gaps.ts";
import { renderSpec } from "./render-spec.ts";
import { renderHandoff } from "./render-handoff.ts";
import type { Tier } from "./types.ts";
import { TIERS } from "./types.ts";

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else _.push(a);
  }
  return { _, flags };
}

function dirOf(args: Args): string {
  return (args.flags.dir as string) ?? process.cwd();
}

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function printIssues(label: string, issues: Issue[]) {
  if (!issues.length) return;
  console.log(`\n${label}:`);
  for (const i of issues) console.log(`  - [${i.code}] ${i.message}${i.path ? ` (${i.path})` : ""}`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

try {
switch (cmd) {
  case "init": {
    const feature = args._[1];
    if (!feature) fail("usage: init <feature-name> [--tier tiny|small|medium|large|epic]");
    const tier = ((args.flags.tier as string) ?? "medium") as Tier;
    if (!TIERS.includes(tier)) fail(`invalid tier "${tier}" (one of ${TIERS.join(", ")})`);
    const dir = dirOf(args);
    if (stateExists(dir) && !args.flags.force)
      fail("requirements.json / decision-log.json already exist here (use --force to overwrite)");
    saveState(dir, newState(feature, tier));
    console.log(`Initialized ${tier} requirements session for "${feature}" in ${dir}`);
    break;
  }

  case "migrate": {
    const dir = dirOf(args);
    const state = loadState(dir);
    saveState(dir, state);
    console.log(`Requirements state is schema v${state.schemaVersion}; readiness remains fail-closed until explicitly completed.`);
    break;
  }

  case "validate": {
    const state = loadState(dirOf(args));
    const report = validateRequirements(state);
    printIssues("Errors", report.errors);
    printIssues("Unresolved blockers", report.blockers.filter((b) => !report.errors.includes(b)));
    printIssues("Warnings", report.warnings);
    console.log(
      `\nvalid: ${report.valid}  handoffReady: ${report.handoffReady}  (tier: ${report.tier})`
    );
    process.exit(report.valid ? 0 : 1);
  }

  case "gaps": {
    const state = loadState(dirOf(args));
    const report = analyzeGaps(state);
    if (args.flags.json) {
      console.log(JSON.stringify(report, null, 2));
      break;
    }
    console.log(`Gap report — tier ${report.tier}, handoffReady: ${report.handoffReady}`);
    if (!report.gaps.length) console.log("  No gaps. State is ready.");
    for (const g of report.gaps) console.log(`  [${g.impact.toUpperCase()}] ${g.area}: ${g.detail}`);
    break;
  }

  case "blockers": {
    const state = loadState(dirOf(args));
    const report = validateRequirements(state);
    const all = [...report.errors, ...report.blockers.filter((b) => !report.errors.includes(b))];
    if (!all.length) console.log("No blockers. Handoff is unblocked.");
    else for (const b of all) console.log(`  - [${b.code}] ${b.message}${b.path ? ` (${b.path})` : ""}`);
    process.exit(all.length ? 1 : 0);
  }

  case "apply": {
    const patchPath = args._[1];
    if (!patchPath) fail("usage: apply <patch.json>");
    const dir = dirOf(args);
    let patch: Patch;
    try {
      patch = JSON.parse(readFileSync(patchPath, "utf8"));
    } catch (e) {
      fail(`could not read/parse patch: ${(e as Error).message}`);
    }
    const state = loadState(dir);
    const next = applyPatch(state, patch!);
    const report = validateRequirements(next);
    // Persist even if validation has errors — the interview is iterative — but
    // refuse to persist structurally broken (schema-invalid) state.
    if (report.errors.some((e) => e.code.startsWith("schema."))) {
      printIssues("Schema errors — NOT saved", report.errors);
      process.exit(1);
    }
    saveState(dir, next);
    console.log("Applied. Post-apply state:");
    printIssues("Errors", report.errors);
    printIssues("Unresolved blockers", report.blockers.filter((b) => !report.errors.includes(b)));
    console.log(`\nvalid: ${report.valid}  handoffReady: ${report.handoffReady}`);
    break;
  }

  case "decisions": {
    const state = loadState(dirOf(args));
    const sorted = state.decisions.slice().sort((a, b) => a.sequence - b.sequence);
    if (!sorted.length) console.log("No decisions recorded.");
    for (const d of sorted)
      console.log(
        `#${d.sequence} [${d.id}] (${d.status}) ${d.decision}\n     why: ${d.rationale ?? "—"} | alts: ${d.alternatives.join("; ") || "—"} | src: ${d.source}/${d.confidence}`
      );
    break;
  }

  case "defer":
  case "accept-risk": {
    const qid = args._[1];
    if (!qid) fail(`usage: ${cmd} <questionId>`);
    const dir = dirOf(args);
    const state = loadState(dir);
    const q = state.openQuestions.find((x) => x.id === qid);
    if (!q) fail(`no open question with id "${qid}"`);
    q!.status = cmd === "defer" ? "deferred" : "accepted-risk";
    if (cmd === "accept-risk") {
      const assumption = args.flags.assumption as string;
      const stop = args.flags["stop-condition"] as string;
      if (!assumption || !stop) fail("accept-risk requires --assumption <text> and --stop-condition <text>");
      q!.acceptedRiskAssumption = assumption;
      q!.stopCondition = stop;
    }
    saveState(dir, state);
    console.log(`Question ${qid} marked ${q!.status}.`);
    break;
  }

  case "render-spec": {
    const state = loadState(dirOf(args));
    const md = renderSpec(state);
    if (args.flags.out) {
      writeFileSync(args.flags.out as string, md);
      console.log(`Wrote spec to ${args.flags.out}`);
    } else process.stdout.write(md);
    break;
  }

  case "render-handoff": {
    const state = loadState(dirOf(args));
    const result = renderHandoff(state, { force: !!args.flags.force });
    if (!result.ok) {
      console.error("Handoff withheld — state is not ready:");
      printIssues("Errors", result.report.errors);
      printIssues("Unresolved blockers", result.report.blockers.filter((b) => !result.report.errors.includes(b)));
      console.error("\nResolve these. Tiny/small opt-out requires an explicit user-approved readinessOptOut record; --force never invents approval.");
      process.exit(1);
    }
    if (args.flags.out) {
      writeFileSync(args.flags.out as string, result.markdown);
      console.log(`Wrote handoff to ${args.flags.out}`);
    } else process.stdout.write(result.markdown);
    break;
  }

  default:
    console.log(
      `Requirements Interviewer CLI

Commands:
  init <feature> [--tier t]      create a new requirements session
  migrate                        persist schema-v1 state as incomplete schema v2
  validate                       structural + completeness validation
  gaps [--json]                  deterministic gap report (feeds questions)
  blockers                       unresolved items blocking handoff
  apply <patch.json>             apply a structured update, then validate
  decisions                      show the decision log
  defer <questionId>             mark a blocking question deferred
  accept-risk <questionId> --assumption <text> --stop-condition <text>
  render-spec [--out f]          render the human requirements spec
  render-handoff [--out f] [--force]   render the builder handoff

Common flags: --dir <path> (default: cwd)`
    );
    if (cmd && cmd !== "help") process.exit(1);
}
} catch (e) {
  // loadState and other helpers throw clean Errors; surface them as a tidy
  // message + nonzero exit instead of an uncaught stack trace.
  fail((e as Error).message);
}
