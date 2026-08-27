/**
 * Insurance Claims Agent BFF (zero KOBIL SDK).
 *
 * Serves the web chat UI and the HTTP API that drives it:
 *   - POST /api/chat            run the agent loop, stream events over SSE
 *   - POST /api/upload          accept damage photos
 *   - GET  /api/files/:id       serve an uploaded / generated file
 *   - GET  /api/conversation    poll the claim's message feed (signing cards)
 *   - POST /api/signing/finalize embed the browser-drawn signature into the PDF
 *   - POST /api/conversation/reject  mark the settlement rejected
 *   - POST /api/reset           start a fresh claim
 *
 * Everything is local and in-memory: one claim context, one file store, no
 * external services. Communication with the user is the browser — there is no
 * external messaging, no payments, and no human-approval (CIBA). Those are
 * added by the integration guide.
 *
 * Port: 3005 (configurable via PORT env var)
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { trustedAgentLoop, getRateLimitStatus, resetRateLimitState } from "./agent.js";
import type { AgentEventCallback } from "./agent.js";
import { ClaimsContext } from "./claims-context.js";
import type { StoredFile } from "./tool-defs.js";
import { loadEnvFile } from "./local-config.js";
import { generateSettlement } from "./settlement-generator.js";

loadEnvFile();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env["PORT"] ?? "3005", 10);
const __dirname = fileURLToPath(new URL(".", import.meta.url));

if (!process.env["ANTHROPIC_API_KEY"]) {
  console.warn(
    "[WARN] ANTHROPIC_API_KEY is not set. Copy .env.example to .env and add your key, " +
    "or export ANTHROPIC_API_KEY — the agent loop will fail without it.",
  );
}

// ---------------------------------------------------------------------------
// In-memory state — single claim context + single file store (local, one user)
// ---------------------------------------------------------------------------

interface UploadedFile extends StoredFile {
  fileSize: number;
  uploadedAt: string;
}

const claimsContext = new ClaimsContext("insurance-claims-agent");
const uploadedFiles = new Map<string, UploadedFile>();
// One-shot grace: the automated close-out turn right after the payout is
// confirmed must still see the just-paid claim (the auto-reset would
// otherwise wipe it before the closing summary is generated).
let paymentJustConfirmed = false;

const signingResults = new Map<string, { instanceId: string; status: string; filename?: string; signedAt?: string; signedFileId?: string }>();

function createUploadedFileId(prefix = "file"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Accessors passed into the agent / tools so they never touch the store directly. */
function getFile(fileId: string): StoredFile | undefined {
  return uploadedFiles.get(fileId);
}
function saveFile(fileName: string, buffer: Buffer, contentType: string): string {
  const fileId = createUploadedFileId("file");
  uploadedFiles.set(fileId, {
    fileId, fileName, buffer, contentType,
    fileSize: buffer.length, uploadedAt: new Date().toISOString(),
  });
  return fileId;
}

// ---------------------------------------------------------------------------
// Identity (display only)
// ---------------------------------------------------------------------------

const agentName = process.env["AGENT_NAME"] ?? "Insurance Claims Agent";

// ---------------------------------------------------------------------------
// Request / Response helpers
// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function parseJSONBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  const text = raw.toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

function sendJSON(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJSON(res, status, { error: message });
}

/** Flush the response if the runtime/proxy layer exposes a flush() (best-effort, SSE). */
function flushRes(res: ServerResponse): void {
  const f = (res as unknown as { flush?: () => void }).flush;
  if (typeof f === "function") f.call(res);
}

function sendSSE(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  flushRes(res);
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const candidates = [
    resolve(__dirname, "..", "public"),
    resolve(__dirname, "..", "..", "public"),
  ];
  const publicDir = candidates.find((c) => existsSync(c)) ?? candidates[candidates.length - 1]!;
  const urlPath = req.url?.split("?")[0] ?? "/";
  const filePath = urlPath === "/" ? "/index.html" : urlPath;
  const fullPath = resolve(publicDir, filePath.slice(1));

  if (!fullPath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const content = readFileSync(fullPath);
    const ext = fullPath.split(".").pop();
    const types: Record<string, string> = {
      html: "text/html", css: "text/css", js: "application/javascript",
      json: "application/json", png: "image/png", svg: "image/svg+xml",
      ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2",
    };
    const headers: Record<string, string> = {
      "Content-Type": types[ext ?? "html"] ?? "application/octet-stream",
    };
    if (ext === "html") {
      headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0";
    }
    res.writeHead(200, headers);
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

// ---------------------------------------------------------------------------
// After the agent generates a settlement PDF, surface a signing card in the
// conversation feed so the UI renders the in-browser signature pad. With no
// an external signing channel, the user reviews and signs right here in the chat.
// ---------------------------------------------------------------------------

function addSigningRequestIfNeeded(): void {
  const claim = claimsContext.getClaimState();
  if (claim.status !== "approved" || !claim.latestSettlementFileId) return;
  const file = uploadedFiles.get(claim.latestSettlementFileId);
  if (!file) return;
  // Don't double-add for the same file.
  const existing = claimsContext.getSigningRequests().some(m => m.fileId === claim.latestSettlementFileId);
  if (existing) return;
  claimsContext.addOutgoing({
    type: "signing_request",
    content: "Please review and sign your Settlement Agreement.",
    fileName: file.fileName,
    fileId: file.fileId,
    status: "pending",
  });
  claimsContext.updateClaimState({ status: "signing" });
}

// ---------------------------------------------------------------------------
// Chat handler — agent loop with SSE streaming
// ---------------------------------------------------------------------------

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let sseStarted = false;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  try {
    const body = await parseJSONBody(req);
    const message = typeof body["message"] === "string" ? body["message"].trim() : "";
    const userId = typeof body["user"] === "string" ? body["user"] : "claims-adjuster";
    if (!message) { sendError(res, 400, "message is required"); return; }

    // Auto-reset only when the previous claim is fully resolved. Resetting on
    // `signed` wiped the claim on the first message after signing, so the agent
    // reported "no signed agreement" and the payout was impossible; signed PDFs
    // are kept (only unsigned Settlement- drafts are purged).
    const claimStatus = claimsContext.getClaimState().status;
    if (claimStatus === "paid" && paymentJustConfirmed) {
      // This is the automated close-out turn right after the payout was
      // confirmed. Keep the just-paid claim so the closing summary uses the
      // correct policyholder + claim number; reset on the NEXT turn instead.
      paymentJustConfirmed = false;
    } else if (claimStatus === "paid" || claimStatus === "rejected") {
      claimsContext.clear();
      signingResults.clear();
      resetRateLimitState();
      paymentJustConfirmed = false;
      for (const [key, file] of Array.from(uploadedFiles.entries())) {
        if (file.fileName.startsWith("Settlement-") && !key.startsWith("signed-")) uploadedFiles.delete(key);
      }
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });
    res.flushHeaders();
    sseStarted = true;

    keepalive = setInterval(() => {
      try {
        res.write(": keepalive\n\n");
        flushRes(res);
      } catch { /* disconnected */ }
    }, 5_000);

    const onEvent: AgentEventCallback = (event, data) => {
      try { sendSSE(res, event, data); } catch { /* disconnected */ }
    };

    console.log(`[CHAT] /api/chat start msg="${message.slice(0, 80)}"`);
    const result = await trustedAgentLoop(
      message,
      { agentName, rateLimitMax: 20, userId, claimsContext, getFile, saveFile },
      onEvent,
    );
    console.log(`[CHAT] /api/chat loop returned len=${result.length}`);

    // If the model generated a settlement PDF, surface the signing card.
    addSigningRequestIfNeeded();

    sendSSE(res, "text", { content: result });
    sendSSE(res, "done", {});
    if (keepalive) clearInterval(keepalive);
  } catch (error) {
    if (keepalive) clearInterval(keepalive);
    const raw = error instanceof Error ? error.message : String(error);
    console.error("[InsuranceChat] Error:", raw);
    const overloaded = /\b529\b/.test(raw) || /overloaded/i.test(raw);
    const msg = overloaded ? "The assistant is briefly overloaded. Please send your message again in a moment." : raw;
    if (sseStarted) {
      try { sendSSE(res, "error", { message: msg, retryable: overloaded }); } catch { /* disconnected */ }
    } else {
      sendError(res, overloaded ? 503 : 500, msg);
    }
  }
  try { res.end(); } catch { /* already closed */ }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  const method = req.method ?? "GET";
  const parsedUrl = new URL(req.url ?? "/", "http://localhost");
  const path = parsedUrl.pathname;

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  // Health
  if (method === "GET" && path === "/healthz") {
    sendJSON(res, 200, { status: "ok", service: "insurance-claims-agent", messages: claimsContext.count });
    return;
  }

  // Chat (SSE)
  if (method === "POST" && path === "/api/chat") {
    void handleChat(req, res);
    return;
  }

  // Conversation feed (UI polls this for signing cards / async messages)
  if (method === "GET" && path === "/api/conversation") {
    const since = parsedUrl.searchParams.get("since") ?? undefined;
    const raw = claimsContext.getMessagesSync(since);
    const messages = raw.map(m => ({ ...m, instanceId: m.signingInstanceId ?? m.paymentInstanceId ?? m.id }));
    sendJSON(res, 200, { messages, count: messages.length });
    return;
  }

  // Claim state
  if (method === "GET" && path === "/api/claim/state") {
    sendJSON(res, 200, claimsContext.getClaimState());
    return;
  }

  // File upload (multipart/form-data, field name "file")
  if (method === "POST" && path === "/api/upload") {
    void (async () => {
      try {
        const raw = await readBody(req);
        const ct = req.headers["content-type"] ?? "";
        const boundaryMatch = ct.match(/boundary=(.+)/);
        if (!boundaryMatch) { sendError(res, 400, "multipart/form-data required"); return; }
        const boundary = boundaryMatch[1]!;
        const rawStr = raw.toString("latin1");
        const parts = rawStr.split("--" + boundary);
        let fileBuffer: Buffer | null = null;
        let fileName = "upload.bin";
        let contentType = "application/octet-stream";
        for (const part of parts) {
          if (part.includes('name="file"')) {
            const nameMatch = part.match(/filename="([^"]+)"/);
            if (nameMatch) fileName = nameMatch[1]!;
            const ctMatch = part.match(/Content-Type:\s*(\S+)/i);
            if (ctMatch) contentType = ctMatch[1]!;
            const headerEnd = part.indexOf("\r\n\r\n");
            if (headerEnd >= 0) {
              const bodyStart = headerEnd + 4;
              const bodyEnd = part.lastIndexOf("\r\n");
              fileBuffer = Buffer.from(part.slice(bodyStart, bodyEnd), "latin1");
            }
          }
        }
        if (!fileBuffer || fileBuffer.length === 0) { sendError(res, 400, "No file found"); return; }
        const fileId = createUploadedFileId("file");
        uploadedFiles.set(fileId, {
          fileId, fileName, buffer: fileBuffer, contentType,
          fileSize: fileBuffer.length, uploadedAt: new Date().toISOString(),
        });
        if (contentType.startsWith("image/")) claimsContext.addPhoto(fileId);
        console.log(`[UPLOAD] ${fileName} (${fileBuffer.length} bytes) -> ${fileId}`);
        sendJSON(res, 200, { fileId, fileName, fileSize: fileBuffer.length });
      } catch (err) {
        sendError(res, 500, err instanceof Error ? err.message : String(err));
      }
    })();
    return;
  }

  if (method === "GET" && path === "/api/uploads") {
    const files = Array.from(uploadedFiles.values()).map(f => ({ fileId: f.fileId, fileName: f.fileName, fileSize: f.fileSize, uploadedAt: f.uploadedAt }));
    sendJSON(res, 200, { files, count: files.length });
    return;
  }

  // Serve uploaded / generated file by id
  if (method === "GET" && path.startsWith("/api/files/")) {
    const fileId = path.split("/api/files/")[1] ?? "";
    const file = uploadedFiles.get(fileId);
    if (!file) { sendError(res, 404, "File not found"); return; }
    res.writeHead(200, {
      "Content-Type": file.contentType,
      "Content-Disposition": `inline; filename="${file.fileName}"`,
      "Content-Length": String(file.buffer.length),
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    });
    res.end(file.buffer);
    return;
  }

  // Signing status
  if (method === "GET" && path === "/api/signing-status") {
    const instanceId = parsedUrl.searchParams.get("instance_id") ?? undefined;
    sendJSON(res, 200, claimsContext.getSigningStatus(instanceId));
    return;
  }

  // Mock payout confirmation: the customer confirms the payout card in the chat.
  // Simulated only — no payment rail is contacted and no funds move.
  if (method === "POST" && path === "/api/payment/confirm") {
    void (async () => {
      try {
        const body = await parseJSONBody(req);
        const instanceId = String(body["instanceId"] ?? "");
        if (!instanceId) { sendError(res, 400, "instanceId required"); return; }
        const ref = claimsContext.confirmPayment(instanceId);
        if (!ref) { sendError(res, 404, "Unknown or already-settled payout"); return; }
        // Spare the immediate close-out turn from the auto-reset (see the flag decl).
        paymentJustConfirmed = true;
        console.log(`[payment] SIMULATED payout confirmed instance=${instanceId} ref=${ref}`);
        sendJSON(res, 200, { ok: true, simulated: true, instanceId, transactionRef: ref });
      } catch (err) {
        sendError(res, 500, err instanceof Error ? err.message : "payout confirmation failed");
      }
    })();
    return;
  }

  // In-browser signing: embed the drawn signature PNG into the settlement PDF
  if (method === "POST" && path === "/api/signing/finalize") {
    void (async () => {
      try {
        const body = await parseJSONBody(req);
        const instanceId = String(body["instanceId"] ?? "");
        const signatureImage = String(body["signatureImage"] ?? "");
        const fileId = String(body["fileId"] ?? "");

        const file = uploadedFiles.get(fileId);
        if (!file) { sendError(res, 404, "Original PDF not found"); return; }
        if (!signatureImage.startsWith("data:image")) { sendError(res, 400, "signatureImage required"); return; }

        const base64Data = signatureImage.split(",")[1] ?? "";
        const sigBytes = Buffer.from(base64Data, "base64");

        const { PDFDocument } = await import("pdf-lib");
        // Prefer regenerating a clean SIGNED document from the stored settlement
        // data: no DRAFT stamp / "awaiting", and the drawn signature is placed on
        // the signature line by the same layout code (no fixed-offset drift). Fall
        // back to overlaying on the draft PDF if the data isn't available.
        let signedBuffer: Buffer;
        const settlementData = claimsContext.getClaimState().latestSettlementData;
        if (settlementData) {
          const signedAt = new Date().toISOString().slice(0, 10);
          signedBuffer = await generateSettlement(settlementData, { signaturePng: sigBytes, signedAt });
        } else {
          const pdfDoc = await PDFDocument.load(file.buffer);
          const sigImage = await pdfDoc.embedPng(sigBytes);
          const page = pdfDoc.getPages()[0]!;
          const pageWidth = page.getWidth();
          const sigWidth = 150;
          const sigHeight = (sigImage.height / sigImage.width) * sigWidth;
          page.drawImage(sigImage, { x: pageWidth - sigWidth - 50, y: 95, width: sigWidth, height: sigHeight });

          signedBuffer = Buffer.from(await pdfDoc.save());
        }
        const signedFileId = `signed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        uploadedFiles.set(signedFileId, {
          fileId: signedFileId, fileName: `signed-${file.fileName}`,
          buffer: signedBuffer, contentType: "application/pdf",
          fileSize: signedBuffer.length, uploadedAt: new Date().toISOString(),
        });

        if (instanceId) {
          claimsContext.updateSigningStatus(instanceId, "signed", { signatureImage, signedFileId, fileName: file.fileName });
          signingResults.set(instanceId, { instanceId, status: "signed", filename: file.fileName, signedAt: new Date().toISOString(), signedFileId });
        }
        claimsContext.updateClaimState({ status: "signed" });
        console.log(`[FINALIZE] ${file.fileName} signed -> ${signedFileId} (${signedBuffer.length} bytes)`);

        sendJSON(res, 200, {
          ok: true, signedFileId, signedFileName: `signed-${file.fileName}`,
          signedFileSize: signedBuffer.length, instanceId,
          downloadUrl: `/api/files/${signedFileId}`,
        });
      } catch (err) {
        sendError(res, 500, err instanceof Error ? err.message : String(err));
      }
    })();
    return;
  }

  // Reject the settlement
  if (method === "POST" && path === "/api/conversation/reject") {
    void (async () => {
      try {
        const body = await parseJSONBody(req);
        const instanceId = String(body["instanceId"] ?? "");
        if (instanceId) claimsContext.updateSigningStatus(instanceId, "rejected");
        claimsContext.updateClaimState({ status: "rejected" });
        sendJSON(res, 200, { ok: true });
      } catch (err) {
        sendError(res, 500, err instanceof Error ? err.message : String(err));
      }
    })();
    return;
  }

  // Lightweight document info (UI "AI review" panel)
  if (method === "POST" && path === "/api/ai-review") {
    void (async () => {
      try {
        const body = await parseJSONBody(req);
        const fileId = String(body["fileId"] ?? "");
        const file = uploadedFiles.get(fileId);
        if (!file) { sendError(res, 404, "File not found"); return; }
        sendJSON(res, 200, {
          ok: true, fileId, fileName: file.fileName, fileSize: file.fileSize,
          summary: `Settlement document **${file.fileName}** (${file.fileSize} bytes). Review the PDF, then draw your signature to accept.`,
        });
      } catch (err) {
        sendError(res, 500, err instanceof Error ? err.message : String(err));
      }
    })();
    return;
  }

  // Rate limit status
  if (method === "GET" && path === "/api/security/rate-limit") {
    sendJSON(res, 200, getRateLimitStatus(20, 60_000));
    return;
  }

  // Reset
  if (method === "POST" && (path === "/api/reset" || path === "/api/claim/reset")) {
    claimsContext.clear();
    signingResults.clear();
    uploadedFiles.clear();
    resetRateLimitState();
    sendJSON(res, 200, { ok: true, message: "Insurance claims agent reset" });
    return;
  }

  // Static UI
  serveStatic(req, res);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

server.listen(PORT, () => {
  console.log(`\n  Insurance Claims Agent (starter, no KOBIL SDK) running on http://localhost:${PORT}`);
  console.log(`  Agent: ${agentName}`);
  console.log(`  Open http://localhost:${PORT} in your browser.\n`);
});
