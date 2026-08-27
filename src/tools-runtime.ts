/**
 * Local tool runtime — the zero-SDK stand-in for `@kobil/aitrust`.
 *
 * A tool is just: a name, an LLM-facing description, a Zod parameter shape, and
 * an async `execute(input) => string`. `defineTool` is an identity helper that
 * gives you type inference; `createInsuranceMcpServer` projects a registry of
 * tools into the in-process SDK MCP server the Claude Agent SDK drives.
 *
 * This file is intentionally tiny. When you follow the integration guide, Step 3
 * replaces these exports with the real ones from `@kobil/aitrust`
 * (`defineTool`, `registerTools`, …), which add per-tool security metadata
 * (scopes, CIBA approval) and wrap `execute` in the trust pipeline. The tool
 * *definitions* in `tool-defs.ts` barely change.
 *
 * The Claude Agent SDK exposes custom, in-process tools through an "SDK MCP
 * server": each tool is declared with `tool(name, description, zodShape,
 * handler)` and the set is bundled with `createSdkMcpServer`. The model then
 * addresses them as `mcp__<serverName>__<toolName>`; `mcpToolName()` builds that
 * wire name so the agent loop can gate them in `canUseTool`.
 */

import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { z } from "zod";

/** A free-form bag of LLM-supplied arguments for a single tool call. */
export type ToolInput = Record<string, unknown>;

/** A Zod "raw shape" — an object mapping each parameter name to its Zod type. */
export type ToolParameters = Record<string, z.ZodTypeAny>;

/** Declarative description of one tool the agent can call. */
export interface ToolDefinition<I extends ToolInput = ToolInput> {
  /** Stable tool name sent to the model (snake_case). */
  name: string;
  /** Natural-language description the model uses to decide when to call it. */
  description: string;
  /** Zod parameter shape (the SDK converts it to the JSON Schema sent to the model). */
  parameters: ToolParameters;
  /** The implementation. Returns a string the model reads back as the result. */
  execute: (input: I) => Promise<string>;
}

/** Identity helper — colocates a tool's schema and implementation with type inference. */
export function defineTool<I extends ToolInput = ToolInput>(
  def: ToolDefinition<I>,
): ToolDefinition<I> {
  return def;
}

/** The in-process SDK MCP server name our tools live under. */
export const MCP_SERVER_NAME = "insurance";

/** The wire name the model uses for one of our tools (`mcp__insurance__<name>`). */
export function mcpToolName(name: string): string {
  return `mcp__${MCP_SERVER_NAME}__${name}`;
}

/**
 * Called once per tool execution so the agent loop can relay a `tool_result`
 * SSE event. `ok` is false when `execute` threw.
 */
export type ToolResultReporter = (name: string, result: string, ok: boolean) => void;

/**
 * Project a tool registry into an in-process SDK MCP server. Each tool's
 * `execute` is wrapped so its string return becomes the MCP text result, and
 * so a thrown error is reported (`ok: false`) and surfaced to the model as an
 * error result — mirroring the direct dispatch the zero-SDK loop used to do.
 */
export function createInsuranceMcpServer(
  defs: Record<string, ToolDefinition>,
  onToolResult?: ToolResultReporter,
): McpSdkServerConfigWithInstance {
  const tools = Object.values(defs).map((d) =>
    tool(d.name, d.description, d.parameters, async (args: unknown) => {
      try {
        const resultText = await d.execute(args as ToolInput);
        onToolResult?.(d.name, resultText, true);
        return { content: [{ type: "text" as const, text: resultText }] };
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        onToolResult?.(d.name, errMsg, false);
        return { content: [{ type: "text" as const, text: `Error: ${errMsg}` }], isError: true };
      }
    }),
  );

  return createSdkMcpServer({ name: MCP_SERVER_NAME, version: "1.0.0", tools });
}
