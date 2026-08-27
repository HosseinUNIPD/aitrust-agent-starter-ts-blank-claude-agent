/**
 * Insurance Claims Agent — the agent loop (zero KOBIL SDK).
 *
 * The model loop is driven by the Claude Agent SDK's `query()`: the insurance
 * tools are exposed as an in-process SDK MCP server, and `query()` runs the
 * tool-use loop internally (calling tools, feeding results back, repeating until
 * the model stops). `query()` spawns the SDK's bundled Claude Code runtime as a
 * subprocess; it needs no separately-installed CLI, only `ANTHROPIC_API_KEY`.
 *
 * The only "security" here is what a developer hand-rolls: a sliding-window
 * rate limiter (enforced in the SDK's per-tool `canUseTool` seam), a couple of
 * regex threat/SSRF checks run before the loop, and output redaction on the
 * final answer. They are deliberately ad-hoc — Steps 4-7 of the integration
 * guide show how the KOBIL AI Trust SDK replaces each of them with a managed,
 * centrally-policied, and audited equivalent (FGA, CIBA, Guard, Audit).
 */

import Anthropic from "@anthropic-ai/sdk";
import { query, type CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { redactSecrets } from "./output-guard.js";
import { createInsuranceTools, type StoredFile } from "./tool-defs.js";
import {
  createInsuranceMcpServer,
  MCP_SERVER_NAME,
  type ToolResultReporter,
  type ToolDefinition,
  type ToolInput,
} from "./tools-runtime.js";
import type { ClaimsContext } from "./claims-context.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TrustedAgentConfig {
  model?: string;
  visionModel?: string;
  agentName?: string;
  rateLimitMax?: number;
  rateLimitWindowMs?: number;
  userId?: string;
  /** Per-conversation claim state. */
  claimsContext: ClaimsContext;
  /** File store accessors, owned by the server. */
  getFile: (fileId: string) => StoredFile | undefined;
  saveFile: (fileName: string, buffer: Buffer, contentType: string) => string;
}

export type AgentEventCallback = (event: string, data: unknown) => void;

// ---------------------------------------------------------------------------
// Rate limiting — in-memory sliding window
// ---------------------------------------------------------------------------

const _rateLimitTimestamps: number[] = [];

function _checkRateLimit(max: number, windowMs: number): { allowed: boolean; remaining: number; retryAfterMs: number } {
  const now = Date.now();
  while (_rateLimitTimestamps.length > 0 && _rateLimitTimestamps[0]! < now - windowMs) {
    _rateLimitTimestamps.shift();
  }
  const remaining = Math.max(0, max - _rateLimitTimestamps.length);
  const retryAfterMs = _rateLimitTimestamps.length > 0
    ? Math.max(0, (_rateLimitTimestamps[0]! + windowMs) - now)
    : 0;
  return { allowed: remaining > 0, remaining, retryAfterMs };
}

function _recordRequest(): void {
  _rateLimitTimestamps.push(Date.now());
}

export function getRateLimitStatus(max: number, windowMs: number): { remaining: number; total: number; windowMs: number; used: number } {
  const now = Date.now();
  const active = _rateLimitTimestamps.filter(t => t >= now - windowMs);
  return { remaining: Math.max(0, max - active.length), total: max, windowMs, used: active.length };
}

export function resetRateLimitState(): void {
  _rateLimitTimestamps.length = 0;
  // A reset ends the current claim, so drop the SDK session too: the next
  // message starts a fresh conversation instead of resuming the old one.
  _lastSessionId = undefined;
}

// ---------------------------------------------------------------------------
// Multi-turn memory — the SDK session for the current claim
//
// `query()` runs one turn per call. To keep conversation memory across turns we
// resume the session id returned by the previous turn. The claim's chat history
// (in claims-context, reset by `clear()`) is the fresh-vs-continuing signal:
// an empty history means a new/just-reset claim, so we start a new session.
// ---------------------------------------------------------------------------

let _lastSessionId: string | undefined;

// ---------------------------------------------------------------------------
// Hand-rolled SSRF protection
// ---------------------------------------------------------------------------

const SSRF_BLOCKED_PATTERNS = [
  /169\.254\.\d+\.\d+/,
  /127\.\d+\.\d+\.\d+/,
  /10\.\d+\.\d+\.\d+/,
  /172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/,
  /192\.168\.\d+\.\d+/,
  /0\.0\.0\.0/,
  /localhost/i,
  /\[::1\]/,
  /metadata\.google\.internal/i,
  /metadata\.azure\.com/i,
];

function extractUrls(text: string): string[] {
  return text.match(/https?:\/\/[^\s"'<>)]+/gi) ?? [];
}

function checkUrlSafety(url: string): { allowed: boolean; reason?: string } {
  for (const pattern of SSRF_BLOCKED_PATTERNS) {
    if (pattern.test(url)) {
      return { allowed: false, reason: "URL matches blocked internal/metadata pattern" };
    }
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Hand-rolled insurance threat patterns
// ---------------------------------------------------------------------------

interface ThreatPattern {
  id: string;
  pattern: RegExp;
  severity: "critical" | "high" | "medium";
  description: string;
}

const INSURANCE_THREAT_PATTERNS: ThreatPattern[] = [
  {
    id: "exceed_policy_limit",
    pattern: /settle\s+(above|over|beyond|exceed|more\s+than)\s+(policy|coverage|limit|cap|maximum)/i,
    severity: "critical",
    description: "Attempt to settle above policy coverage limits — settlements must never exceed the policy maximum",
  },
  {
    id: "skip_assessment",
    pattern: /skip\s+(damage|photo|assessment|inspection|review|evaluation)\s*(step|phase|process)?|without\s+(assessment|inspection|photos|evidence)/i,
    severity: "high",
    description: "Attempt to skip damage assessment — all claims require documented evidence and formal assessment",
  },
  {
    id: "forge_damage",
    pattern: /fabricat|inflate\s+(damage|cost|estimate|repair|amount)|fake\s+(damage|photo|evidence|claim|report)|forge\s+(damage|report|evidence)/i,
    severity: "critical",
    description: "Damage fabrication or inflation attempt — insurance fraud is a criminal offense",
  },
  {
    id: "external_exfiltration",
    pattern: /send\s+.{0,30}\s+to\s+(my\s+email|external|personal)|email\s+me\s+.{0,20}(all|every|signed|document|pdf|settlement|claim)/i,
    severity: "critical",
    description: "Document exfiltration attempt — sending settlement documents to external/personal destination",
  },
];

function checkCustomThreats(input: string): { matched: boolean; threat?: ThreatPattern } {
  for (const threat of INSURANCE_THREAT_PATTERNS) {
    if (threat.pattern.test(input)) return { matched: true, threat };
  }
  return { matched: false };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ITERATIONS = 30;

// Built-in Claude Code tools are removed from the model's context so the agent
// only ever reaches for the insurance tools. `canUseTool` also denies anything
// outside the insurance MCP server as a backstop.
const DISALLOWED_BUILTIN_TOOLS = [
  "Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "MultiEdit",
  "NotebookEdit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "TodoWrite",
  "ExitPlanMode",
];

// ---------------------------------------------------------------------------
// Anthropic client (lazy, cached)
// ---------------------------------------------------------------------------

let _anthropic: Anthropic | null = null;

export function getAgentAnthropic(): Anthropic {
  if (_anthropic) return _anthropic;
  // Anthropic returns 529 overloaded_error during capacity spikes; the SDK
  // retries 429/408/409/>=500 with backoff. Raise the default of 2 retries.
  _anthropic = new Anthropic({
    maxRetries: Number(process.env["ANTHROPIC_MAX_RETRIES"] ?? "6"),
  });
  return _anthropic;
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildClaimContextBlock(claim: ReturnType<ClaimsContext["getClaimState"]>): string {
  const lines: string[] = [];
  if (claim.policyNumber) lines.push(`- policyNumber: ${claim.policyNumber}`);
  if (claim.policyholderName) lines.push(`- policyholderName: ${claim.policyholderName}`);
  if (claim.vehicleInfo) lines.push(`- vehicleInfo: ${claim.vehicleInfo}`);
  if (claim.policyLimit != null) lines.push(`- policyLimit: EUR ${claim.policyLimit}`);
  if (claim.deductible != null) lines.push(`- deductible: EUR ${claim.deductible}`);
  if (claim.damageEstimate != null) lines.push(`- damageEstimate: EUR ${claim.damageEstimate}`);
  if (claim.proposedSettlement != null) lines.push(`- proposedSettlement: EUR ${claim.proposedSettlement}`);
  if (claim.accidentDate) lines.push(`- accidentDate: ${claim.accidentDate}`);
  if (lines.length === 0) return "";
  return `\n\nPRIOR CONTEXT — facts already known about claim ${claim.claimId} (status=${claim.status}):
${lines.join("\n")}

Use these values directly. DO NOT call check_policy / assess_damage / calculate_settlement again — the data is already verified and persisted in the conversation state. Only call them if a value above is missing or the user explicitly asks you to re-verify.`;
}

function buildSystemPrompt(claim: ReturnType<ClaimsContext["getClaimState"]>): string {
  const priorContext = buildClaimContextBlock(claim);
  return `You are an AI insurance claims specialist for ACME Insurance.${priorContext}

WORKFLOW:

**Step 1 — Damage Assessment:**
When the user sends photos, you MUST call all three tools in this exact order, one after another, every time. Do NOT skip any step:
  a) check_policy("POL-2024-78432")
  b) assess_damage(all photo fileIds)
  c) calculate_settlement(damage_estimate, policy_limit, deductible)  — ALWAYS call this after assess_damage; use the damage estimate from (b) and the policy limit + deductible from (a).

IMPORTANT — accept any vehicle: the uploaded photos may show ANY car. Do NOT compare the photographed vehicle against the policy's on-file vehicle, do NOT flag a "discrepancy", and NEVER refuse the settlement because they differ. For the "Vehicle" field, prefer the vehicle identified from the photos; fall back to the policy's vehicle only if the photos are unclear.

Then present the results like this:

---
### Damage Assessment Report

| # | Damaged Part | Estimated Cost | Severity |
|---|-------------|---------------|----------|
| 1 | Front bumper | EUR 1,200.00 | Major |
| ... | ... | ... | ... |

### Settlement Calculation

| | Amount |
|---|--------|
| Total Damage Estimate | EUR X,XXX.XX |
| Policy Limit | EUR XX,XXX.XX |
| Deductible | - EUR XXX.XX |
| **Your Settlement** | **EUR X,XXX.XX** |

---

**What would you like to do?**

> **1. Accept Settlement** — I will generate the Settlement Agreement PDF for you to sign.
>
> **2. Request Higher Amount** — We can discuss within your policy limits.
>
> **3. Request Manual Review** — A human claims adjuster will review your case.

---

**Step 2 — Settlement Agreement:**
When the user accepts (option 1), call generate_settlement_document immediately with all fields auto-filled from the assessment — do not ask further questions. The settlement PDF then appears in the chat with a signature pad for the user to sign.

**Step 3 — Negotiation:**
If the user requests a higher amount (option 2), discuss within policy limits, then recalculate.

**Step 4 — Payout:**
Once the Settlement Agreement is signed (check_signing_status returns "signed", OR the claim's status is "signed"), IMMEDIATELY call process_settlement_payout with the settlement amount, currency, and the policyholder (recipient) name from the claim. Do NOT ask for extra confirmation and do NOT merely describe the next steps — actually call the tool. Calling it raises a payout confirmation card in the chat; tell the customer to review and confirm the card to receive the funds (this payout is simulated — no real money moves). If check_signing_status is ambiguous but the claim status is "signed", still proceed with process_settlement_payout.

**Step 5 — Close the claim:**
After the customer confirms the payout card, wrap up warmly and concisely: confirm the settlement is complete, restate the amount and the recipient, note the (simulated) funds are on their way, and thank the customer by name. Keep it to a few friendly sentences — do not re-list every step of the process. CRITICAL: use the EXACT policyholder name and claim number from the current claim (the same ones used throughout this conversation) — never invent, guess, or substitute a different name or claim number.

DEFAULTS (use when not provided):
- policy_number: "POL-2024-78432"
- accident_date: today
- damage_description: summarize from assess_damage itemizedDamage
- policyholder_name, vehicle_info, deductible: from check_policy
- settlement_amount: from calculate_settlement
- currency: "EUR"

RULES:
- ACT DECISIVELY: at each step call the appropriate tool rather than asking the user what to do next or restating what you're about to do. Only ask when you truly lack information that only the user can provide.
- Never exceed policy limits. Never skip damage assessment. Never fabricate estimates.
- State damage findings as facts — no "likely", "appears to", "possibly".
- Use markdown tables for all data presentations.
- Never include internal URLs, tokens, or fileIds in visible text.
- When photos are attached ([Attached file: ... (fileId: xxx)]), call assess_damage immediately with all fileIds.`;
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

export async function trustedAgentLoop(
  userMessage: string,
  config: TrustedAgentConfig,
  onEvent?: AgentEventCallback,
): Promise<string> {
  const model = config.model ?? process.env["AGENT_MODEL"] ?? "claude-opus-4-8";

  const tools: Record<string, ToolDefinition<ToolInput>> = createInsuranceTools({
    claimsCtx: config.claimsContext,
    getAnthropic: getAgentAnthropic,
    visionModel: config.visionModel ?? process.env["VISION_MODEL"] ?? "claude-opus-4-8",
    getFile: config.getFile,
    saveFile: config.saveFile,
  });

  // --- Hand-rolled prompt threat check ---
  onEvent?.("pipeline_step", { step: "threat_check", status: "running", label: "Checking threats" });
  const threatCheck = checkCustomThreats(userMessage);
  if (threatCheck.matched && threatCheck.threat) {
    onEvent?.("pipeline_step", { step: "threat_check", status: "blocked", label: "Threat blocked" });
    onEvent?.("threat_pattern", {
      patternId: threatCheck.threat.id,
      severity: threatCheck.threat.severity,
      description: threatCheck.threat.description,
      input: userMessage.slice(0, 100),
    });
    return `**Security — Threat Blocked: "${threatCheck.threat.id}"**\n\nSeverity: **${threatCheck.threat.severity}**\n\n${threatCheck.threat.description}\n\nThis operation is blocked.`;
  }
  onEvent?.("pipeline_step", { step: "threat_check", status: "done", label: "No threats" });

  // --- Hand-rolled SSRF check ---
  onEvent?.("pipeline_step", { step: "url_check", status: "running", label: "Checking URLs" });
  const urls = extractUrls(userMessage);
  for (const url of urls) {
    const urlResult = checkUrlSafety(url);
    if (!urlResult.allowed) {
      onEvent?.("pipeline_step", { step: "url_check", status: "blocked", label: "SSRF blocked" });
      onEvent?.("ssrf_blocked", { url, reason: urlResult.reason });
      return `**SSRF Protection — Blocked**\n\nBlocked access to: \`${url}\`\n\nReason: ${urlResult.reason}`;
    }
  }
  onEvent?.("pipeline_step", { step: "url_check", status: urls.length ? "done" : "skipped", label: urls.length ? "URLs safe" : "No URLs" });

  onEvent?.("pipeline_step", { step: "llm", status: "running", label: "Processing request" });

  // Per-tool rate limit config (server passes 20/60s).
  const rateMax = config.rateLimitMax ?? 100;
  const rateWindow = config.rateLimitWindowMs ?? 60_000;

  // The SDK runs tool execution itself; the wrapper reports each result so we
  // can relay the same `tool_result` SSE event the zero-SDK loop emitted.
  const onToolResult: ToolResultReporter = (name, result, ok) => {
    onEvent?.("tool_result", { name, result: ok ? result.slice(0, 200) : result, ok });
  };
  const insuranceServer = createInsuranceMcpServer(tools, onToolResult);

  // The per-tool security seam. `canUseTool` fires before every tool call:
  // emit `tool_call`, enforce the rate limit, and deny anything that isn't one
  // of our insurance tools. On rate-limit we abort the whole run and return the
  // block message (matching the zero-SDK loop, which returned immediately).
  const abortController = new AbortController();
  let rateLimitMessage: string | null = null;
  const prefix = `mcp__${MCP_SERVER_NAME}__`;

  const canUseTool: CanUseTool = async (toolName, input) => {
    const bareName = toolName.startsWith(prefix) ? toolName.slice(prefix.length) : toolName;

    // No FGA, no CIBA, no audit — anything in our registry just runs. Non-
    // insurance (built-in) tools are refused outright. This is the gap the
    // integration guide closes.
    if (!Object.prototype.hasOwnProperty.call(tools, bareName)) {
      return { behavior: "deny", message: `Tool "${toolName}" is not available to this agent.` };
    }

    onEvent?.("tool_call", { name: bareName, args: input });

    const rateResult = _checkRateLimit(rateMax, rateWindow);
    if (!rateResult.allowed) {
      onEvent?.("rate_limited", {
        name: bareName, remaining: 0, limit: rateMax,
        windowSeconds: rateWindow / 1000, retryAfterMs: rateResult.retryAfterMs,
      });
      rateLimitMessage = `**Rate Limit Reached**\n\nThe agent exceeded ${rateMax} tool calls per ${rateWindow / 1000}s. Please wait ${Math.ceil(rateResult.retryAfterMs / 1000)}s.`;
      abortController.abort();
      return { behavior: "deny", message: "Rate limit exceeded", interrupt: true };
    }
    _recordRequest();

    console.log(`[LOOP] tool_call ${bareName} input=${JSON.stringify(input).slice(0, 160)}`);
    return { behavior: "allow", updatedInput: input };
  };

  // Continue the claim's conversation across turns by resuming the prior
  // session; an empty chat history means a fresh (or just-reset) claim.
  const priorHistory = config.claimsContext.getChatHistory();
  const resume = priorHistory.length > 0 && _lastSessionId ? _lastSessionId : undefined;

  const liveClaim = config.claimsContext.getClaimState();
  console.log(`[LOOP] query start msgs=${priorHistory.length} claimStatus=${liveClaim.status} resume=${resume ? "yes" : "no"}`);

  const stream = query({
    prompt: userMessage,
    options: {
      model,
      systemPrompt: buildSystemPrompt(liveClaim),
      mcpServers: { [MCP_SERVER_NAME]: insuranceServer },
      canUseTool,
      abortController,
      maxTurns: MAX_ITERATIONS,
      permissionMode: "default",
      // Hermetic run: ignore the host's ~/.claude settings, CLAUDE.md, etc.
      settingSources: [],
      disallowedTools: DISALLOWED_BUILTIN_TOOLS,
      includePartialMessages: false,
      ...(resume ? { resume } : {}),
    },
  });

  let finalText = "";
  let sessionId: string | undefined;

  try {
    for await (const message of stream) {
      const sid = (message as { session_id?: string }).session_id;
      if (sid) sessionId = sid;

      if (message.type === "result") {
        console.log(`[LOOP] result subtype=${message.subtype} turns=${message.num_turns}`);
        if (message.subtype === "success") {
          finalText = message.result;
        } else if (message.subtype === "error_max_turns") {
          throw new Error(`Agent exceeded maximum iterations (${MAX_ITERATIONS})`);
        } else {
          const detail = message.errors.length ? `: ${message.errors.join("; ")}` : "";
          throw new Error(`Agent run failed (${message.subtype})${detail}`);
        }
      }
    }
  } catch (error) {
    // A rate-limit abort ends the run here; return the block message verbatim
    // (no chat turn recorded, matching the zero-SDK loop's early return).
    if (rateLimitMessage) return rateLimitMessage;
    throw error;
  }

  _lastSessionId = sessionId ?? _lastSessionId;

  // Hand-rolled output redaction (the zero-SDK output guard).
  const finalRedacted = redactSecrets(finalText) as string;
  config.claimsContext.addChatTurn(userMessage, finalRedacted);
  return finalRedacted;
}
