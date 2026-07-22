export type Severity = "critical" | "high" | "medium" | "low";
export type Verdict = "confirmed" | "false-positive" | "uncertain" | "skipped";

export interface CritiqueFinding {
  severity: Severity;
  category: string;
  location: string;
  description: string;
  impact?: string;
  recommendation?: string;
  perspectives: string[];
  verification?: {
    verdict: Verdict;
    note?: string;
  };
}

export interface CritiqueReport {
  target: string;
  depth: string;
  risk: "CRITICAL" | "HIGH" | "MODERATE" | "LOW";
  findings: CritiqueFinding[];
  dropped: CritiqueFinding[];
  consensus: string[];
  summary: string;
}

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];

function normalizeSeverity(value: string): Severity | undefined {
  const lower = value.toLowerCase();
  if (SEVERITY_ORDER.includes(lower as Severity)) return lower as Severity;
  return undefined;
}

export function parseFindings(text: string, perspective: string): CritiqueFinding[] {
  const trimmed = text.trim();
  try {
    const value = JSON.parse(trimmed) as { findings?: unknown };
    if (!Array.isArray(value.findings)) throw new Error("reviewer JSON must include an explicit findings array");
    return value.findings.map((item: any, index) => {
      if (!item || !SEVERITY_ORDER.includes(item.severity) || typeof item.category !== "string" || typeof item.location !== "string" || typeof item.description !== "string" || !item.category.trim() || !item.location.trim() || !item.description.trim()) throw new Error(`reviewer finding ${index + 1} is malformed`);
      return { severity: item.severity, category: item.category.trim(), location: item.location.trim(), description: item.description.trim(), ...(typeof item.impact === "string" ? { impact: item.impact.trim() } : {}), ...(typeof item.recommendation === "string" ? { recommendation: item.recommendation.trim() } : {}), perspectives: [perspective] };
    });
  } catch (error: any) {
    if (!trimmed.startsWith("LEGACY_MARKDOWN\n")) throw new Error(`reviewer structured handoff refused: ${error?.message ?? "malformed JSON"}`);
  }
  const legacy = trimmed.slice("LEGACY_MARKDOWN\n".length);
  const findings: CritiqueFinding[] = [];
  let severity: Severity | undefined;
  const lines = legacy.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const heading = lines[i].match(/^###\s+(Critical|High|Medium|Low)\s+Findings/i);
    if (heading) {
      severity = normalizeSeverity(heading[1]);
      continue;
    }
    if (!severity) continue;
    const match = lines[i].match(/^\d+\.\s+\*\*\[([^\]]+)\]\*\*\s+`([^`]+)`\s+—\s+(.+)$/);
    if (!match) continue;
    let impact: string | undefined;
    let recommendation: string | undefined;
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      const impactMatch = lines[j].match(/\*\*Impact\*\*:\s*(.+)$/i);
      const recMatch = lines[j].match(/\*\*Recommendation\*\*:\s*(.+)$/i) || lines[j].match(/Fix:\s*(.+)$/i);
      if (impactMatch) impact = impactMatch[1].trim();
      if (recMatch) recommendation = recMatch[1].trim();
      if (/^\d+\.\s+/.test(lines[j]) || /^###\s+/.test(lines[j])) break;
    }
    findings.push({
      severity,
      category: match[1].trim(),
      location: match[2].trim(),
      description: match[3].trim(),
      impact,
      recommendation,
      perspectives: [perspective],
    });
  }
  return findings;
}

export function dedupeFindings(findings: CritiqueFinding[]): CritiqueFinding[] {
  const map = new Map<string, CritiqueFinding>();
  for (const finding of findings) {
    const key = `${finding.severity}|${finding.location}|${finding.description.toLowerCase()}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...finding, perspectives: [...finding.perspectives] });
      continue;
    }
    existing.perspectives = [...new Set([...existing.perspectives, ...finding.perspectives])];
    existing.impact ||= finding.impact;
    existing.recommendation ||= finding.recommendation;
  }
  return [...map.values()];
}

export function parseVerdict(text: string): { verdict: Verdict; note: string } {
  const verdictMatch = text.match(/\*\*Verdict\*\*:\s*(confirmed|false-positive|uncertain)/i);
  const evidenceMatch = text.match(/\*\*Evidence\*\*:\s*([\s\S]*?)(?:\n##|\n\*\*|$)/i);
  const verdict = (verdictMatch?.[1].toLowerCase() as Verdict | undefined) ?? "uncertain";
  return { verdict, note: evidenceMatch?.[1]?.trim() || text.trim().slice(0, 500) };
}

export function riskFromFindings(findings: CritiqueFinding[]): CritiqueReport["risk"] {
  const active = findings.filter((f) => f.verification?.verdict !== "false-positive");
  const critical = active.filter((f) => f.severity === "critical").length;
  const high = active.filter((f) => f.severity === "high").length;
  const medium = active.filter((f) => f.severity === "medium").length;
  if (critical > 0 || high >= 3) return "CRITICAL";
  if (high >= 1 || medium >= 5) return "HIGH";
  if (medium >= 1) return "MODERATE";
  return "LOW";
}

export function renderCritiqueReport(input: {
  target: string;
  depth: string;
  findings: CritiqueFinding[];
  dropped: CritiqueFinding[];
}): string {
  const findings = input.findings;
  const risk = riskFromFindings(findings);
  const bySeverity = (severity: Severity) => findings.filter((f) => f.severity === severity);
  const section = (severity: Severity) => {
    const items = bySeverity(severity);
    if (!items.length) return `### ${severity[0].toUpperCase()}${severity.slice(1)} Findings\nNo ${severity} findings.\n`;
    return `### ${severity[0].toUpperCase()}${severity.slice(1)} Findings\n${items.map((f, index) => {
      const verification = f.verification
        ? `\n   **Verification**: ${f.verification.verdict}${f.verification.note ? ` — ${f.verification.note}` : ""}`
        : "";
      return `${index + 1}. **[${f.category}]** \`${f.location}\` — ${f.description}\n   Raised by: ${f.perspectives.join(", ")}${f.impact ? `\n   **Impact**: ${f.impact}` : ""}${f.recommendation ? `\n   **Recommendation**: ${f.recommendation}` : ""}${verification}`;
    }).join("\n\n")}\n`;
  };
  const consensus = findings.filter((f) => f.perspectives.length > 1).map((f) => `${f.location}: ${f.description}`);
  const dropped = input.dropped.length
    ? `### Dropped as False Positives\n${input.dropped.map((f) => `- **[${f.category}]** \`${f.location}\` — ${f.description}${f.verification?.note ? ` — Refuted: ${f.verification.note}` : ""}`).join("\n")}\n`
    : "";
  return [
    "## Critique Complete",
    `**Target**: ${input.target} | **Depth**: ${input.depth}`,
    `**Verification**: ${findings.filter((f) => f.verification?.verdict === "confirmed").length} confirmed, ${findings.filter((f) => f.verification?.verdict === "uncertain").length} unverified, ${input.dropped.length} dropped`,
    "",
    section("critical"),
    section("high"),
    section("medium"),
    section("low"),
    dropped,
    "### Attacker Consensus",
    consensus.length ? consensus.map((item) => `- ${item}`).join("\n") : "- None",
    "",
    `### Risk Assessment: ${risk}`,
    `Based on surviving findings after verification.`,
    "",
  ].join("\n");
}
