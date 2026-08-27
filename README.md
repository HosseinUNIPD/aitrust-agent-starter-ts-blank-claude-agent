# AI Trust Agent Starter — TypeScript, Claude Agent SDK

A working insurance claims agent starter for the KOBIL Agent Trust integration
guide. It has no dependency on external messaging, payment, or signing services.

The agent loop is driven by the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`): the seven insurance tools are exposed as an
in-process SDK MCP server, and the SDK's `query()` runs the tool-use loop.

A customer chats in the browser, uploads damage photos, the agent assesses them
with Claude Vision, calculates a settlement, generates a PDF, and the customer
signs it **in the browser**. It runs on nothing but an Anthropic API key.

> **Runtime note.** The Claude Agent SDK launches its **bundled Claude Code
> runtime** as a subprocess to drive the loop. You do **not** need to install
> the Claude Code CLI separately — `npm install` pulls the bundled runtime in
> with the SDK. The subprocess inherits your environment, so `ANTHROPIC_API_KEY`
> reaches it automatically.

## Run it

Node 18+ and an Anthropic API key.

```bash
npm install
cp .env.example .env      # Windows PowerShell: copy .env.example .env
# set ANTHROPIC_API_KEY in .env
npm run dev
```

Open <http://localhost:3005> and file a claim: upload a photo of vehicle damage,
let the agent assess it, negotiate a settlement, and sign the PDF.

**Checkpoint:** the chat responds and the whole claim flow works end to end.
That is the baseline the guide starts from.

## What is deliberately missing

This starter does not include KOBIL Agent Trust yet.

The integration guide adds agent identity, policy-driven authorization, human
approval, and audit without changing the claims workflow.

## What "standalone" means here

Everything the user touches happens in the browser, so the agent needs no
external messaging or payment infrastructure:

| Capability | How it works here |
|---|---|
| Chat with the customer | Browser chat UI |
| Collect damage photos | Browser file upload |
| Sign the settlement | In-browser signature pad |
| Take payment | Simulated payout card in the browser |
| Identity, authorization, audit | Added by the integration guide |

No external-service credentials or messaging/payment packages are needed —
the agent runs on nothing but its model-provider API key.

## Human approval (CIBA) works standalone

When the guide reaches the approval step, the delivery chain is fully
standalone: the approval request goes to the approver's enrolled **mobile
approver app**, where they approve or deny — entirely on its own, with no
external app required.

The one prerequisite is human, not architectural: the approver must be enrolled
on a device with the approver app installed. Without one, an approval request
simply times out.

## The guide

Follow the **Integration Guide** on the standalone developer portal. It covers
prerequisites, installing the SDK, agent identity, the secured tool pipeline,
authorization (FGA), human approval (CIBA), and audit.

Step 1 installs the SDK from the KOBIL package registry — **ask your KOBIL
contact for a registry token** before you start, and keep the `.npmrc` it goes
in out of version control (`.gitignore` already covers it).

## Layout

```
src/
  tools-runtime.ts       ← local tool runtime for the SDK MCP server
  tool-defs.ts           ← the 7 claims tools (Zod schemas + execute bodies)
  agent.ts               ← Claude Agent SDK query() loop
  server.ts              ← HTTP server, chat endpoint, file uploads, SSE
  claims-context.ts      ← per-conversation claim state
  settlement-generator.ts← settlement PDF generation
  output-guard.ts        ← output redaction
public/                  ← browser chat UI
```

State is in memory and resets on restart — fine for the guide, not for anything
beyond a demo.
