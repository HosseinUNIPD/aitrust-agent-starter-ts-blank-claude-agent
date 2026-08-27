/**
 * Insurance Claims Agent — declarative tool definitions (zero KOBIL SDK).
 *
 * Single source of truth for the agent's claims tools. Each tool colocates:
 *   - LLM-facing name and description
 *   - Zod parameter shape (the Claude Agent SDK derives the tool's JSON Schema from it)
 *   - The actual `execute` implementation
 *
 * In this starter the tools run DIRECTLY — there is no authorization, no human
 * approval, no audit. The integration guide adds those by switching
 * `defineTool` to `@kobil/aitrust` and adding `scopes` / `needsApproval`.
 *
 * Everything the user does happens in the browser: chat, photo upload, and
 * settlement signing. This build is deliberately self-contained — it needs no
 * external messaging, payment, or signing infrastructure at any point.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { defineTool } from "./tools-runtime.js";
import type { ToolDefinition, ToolInput } from "./tools-runtime.js";
import type { ClaimsContext } from "./claims-context.js";
import { generateSettlement, type SettlementData } from "./settlement-generator.js";

// ---------------------------------------------------------------------------
// A stored file (uploaded photo / generated PDF). Mirrors the server's store.
// ---------------------------------------------------------------------------

export interface StoredFile {
  fileId: string;
  fileName: string;
  buffer: Buffer;
  contentType: string;
}

// ---------------------------------------------------------------------------
// Context — everything the tool implementations need at runtime.
//
// The server owns the file store and Anthropic client and passes accessors in,
// so the tools stay free of HTTP self-calls and global state.
// ---------------------------------------------------------------------------

export interface InsuranceToolContext {
  /** Per-conversation claim state store (photos, status, settlement file id). */
  claimsCtx: ClaimsContext;
  /** Lazy Anthropic client factory (used by assess_damage's Vision call). */
  getAnthropic: () => Anthropic;
  /** Model id for the Vision assessment. */
  visionModel: string;
  /** Resolve an uploaded/generated file by id. */
  getFile: (fileId: string) => StoredFile | undefined;
  /** Persist a generated file (e.g. settlement PDF); returns the new fileId. */
  saveFile: (fileName: string, buffer: Buffer, contentType: string) => string;
}

// ---------------------------------------------------------------------------
// Demo policyholder identities — rotated by check_policy each call so every
// generated settlement PDF has visibly different content.
// ---------------------------------------------------------------------------

const DEMO_IDENTITIES = [
  { name: "Max Mustermann", email: "max.mustermann@example.com", vehicle: "2023 BMW 320i, Plate: M-AB 1234" },
  { name: "Anna Schmidt", email: "anna.schmidt@example.com", vehicle: "2024 Audi A4 Avant, Plate: B-AS 4321" },
  { name: "Lukas Becker", email: "lukas.becker@example.com", vehicle: "2022 Mercedes C-Class, Plate: M-LB 9012" },
  { name: "Sophie Wagner", email: "sophie.wagner@example.com", vehicle: "2023 VW Golf GTI, Plate: HH-SW 5678" },
  { name: "Jonas Fischer", email: "jonas.fischer@example.com", vehicle: "2024 Porsche Macan, Plate: S-JF 2468" },
  { name: "Marie Hoffmann", email: "marie.hoffmann@example.com", vehicle: "2023 Audi Q5, Plate: K-MH 1357" },
  { name: "Felix Weber", email: "felix.weber@example.com", vehicle: "2022 BMW 530i, Plate: F-FW 8642" },
  { name: "Lena Schäfer", email: "lena.schaefer@example.com", vehicle: "2024 Mercedes GLC, Plate: D-LS 3691" },
];

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the registry of insurance-claims-agent tool definitions. Pass the
 * runtime context once; the returned object is consumed by the agent loop,
 * which dispatches `tools[name].execute(input)` directly.
 */
export function createInsuranceTools(
  ctx: InsuranceToolContext,
): Record<string, ToolDefinition<ToolInput>> {
  const { claimsCtx, getAnthropic, visionModel, getFile, saveFile } = ctx;

  return {
    // ===== ASSESSMENT — Claude Vision over the uploaded photos =====

    assess_damage: defineTool({
      name: "assess_damage",
      description:
        "Analyze uploaded damage photos using AI vision to estimate repair costs. " +
        "Provide the photo file IDs (received from the policyholder's uploads) along with " +
        "optional context about the accident. Returns a structured damage assessment " +
        "with estimated repair cost, severity rating, and itemized damage breakdown.",
      parameters: {
        photo_ids: z.array(z.string()).describe("Array of fileId strings for the uploaded damage photos"),
        accident_description: z.string().optional().describe("Description of the accident (optional)"),
        vehicle_info: z.string().optional().describe("Vehicle make, model, year (optional)"),
      },
      execute: async (input) => {
        const photoIds = Array.isArray(input["photo_ids"]) ? (input["photo_ids"] as string[]) : [];
        const accidentDesc = typeof input["accident_description"] === "string" ? input["accident_description"] : undefined;
        const vehicleInfo = typeof input["vehicle_info"] === "string" ? input["vehicle_info"] : undefined;

        for (const id of photoIds) claimsCtx.addPhoto(String(id));
        claimsCtx.updateClaimState({ status: "assessing" });

        const imageBlocks: Anthropic.ImageBlockParam[] = [];
        for (const photoId of photoIds) {
          const file = getFile(photoId);
          if (file && file.contentType.startsWith("image/")) {
            imageBlocks.push({
              type: "image",
              source: {
                type: "base64",
                media_type: file.contentType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                data: file.buffer.toString("base64"),
              },
            });
          }
        }

        if (imageBlocks.length === 0) {
          return JSON.stringify({
            error: "No valid images found for the provided photo IDs. Please upload damage photos first.",
            photoIds,
          });
        }

        const visionPrompt = [
          "You are an expert automotive insurance damage assessor. Analyze these vehicle damage photos and provide a detailed assessment.",
          accidentDesc ? `Accident description: ${accidentDesc}` : "",
          "Identify the vehicle SOLELY from the photos — for \"vehicleIdentified\" state only its make, model, colour and approximate year. Do NOT compare it to any expected or on-file vehicle, and NEVER mention a discrepancy, mismatch, or that it differs from anything.",
          "",
          "Respond ONLY with a JSON object (no markdown, no code fences) in this exact structure:",
          "{",
          '  "vehicleIdentified": "make, model, color, approximate year",',
          '  "overallSeverity": "minor | moderate | major | total_loss",',
          '  "itemizedDamage": [',
          '    { "part": "part name", "damage": "description of damage", "repairMethod": "repair | replace", "estimatedCost": number_in_EUR }',
          "  ],",
          '  "laborHours": estimated_total_hours,',
          '  "paintRequired": true_or_false,',
          '  "safetyImpact": "none | low | medium | high",',
          '  "driveable": true_or_false,',
          '  "notes": "additional observations relevant to the claim"',
          "}",
          "",
          "Base cost estimates on current European (German) repair shop rates. Be thorough but realistic.",
        ].filter(Boolean).join("\n");

        console.log(`[ASSESS] Running Claude Vision on ${imageBlocks.length} photos`);

        const anthropic = getAnthropic();
        const visionContent: Anthropic.ContentBlockParam[] = [...imageBlocks, { type: "text", text: visionPrompt }];
        const visionRes = await anthropic.messages.create({
          model: visionModel,
          // 8000, not 2000: a total_loss with a long itemizedDamage list was
          // truncated -> JSON parse failed -> "0 items, EUR 0" zeroed the claim.
          max_tokens: 8000,
          messages: [{ role: "user", content: visionContent }],
        });

        const visionText = visionRes.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");

        let parsed: Record<string, unknown>;
        try {
          // Tolerate markdown code fences and any prose around the JSON: pull the
          // outermost { ... } object out of the response before parsing.
          let cleaned = visionText.trim();
          const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
          if (fenced) cleaned = fenced[1]!.trim();
          const start = cleaned.indexOf("{");
          const end = cleaned.lastIndexOf("}");
          if (start !== -1 && end > start) cleaned = cleaned.slice(start, end + 1);
          parsed = JSON.parse(cleaned) as Record<string, unknown>;
        } catch {
          console.error(`[ASSESS] Failed to parse Vision response: ${visionText.slice(0, 200)}`);
          parsed = { raw: visionText };
        }

        const items = Array.isArray(parsed["itemizedDamage"])
          ? (parsed["itemizedDamage"] as Array<{ part: string; estimatedCost: number }>)
          : [];
        const totalCost = items.reduce((sum, item) => sum + (item.estimatedCost ?? 0), 0);

        const assessment = {
          assessmentId: `ASM-${Date.now().toString(36).toUpperCase()}`,
          photosAnalyzed: imageBlocks.length,
          photoIds,
          accidentDescription: accidentDesc ?? "Not provided",
          vehicleInfo: typeof parsed["vehicleIdentified"] === "string" ? parsed["vehicleIdentified"] : (vehicleInfo ?? "See photos"),
          severity: parsed["overallSeverity"] ?? (totalCost > 5000 ? "major" : totalCost > 2000 ? "moderate" : "minor"),
          itemizedDamage: parsed["itemizedDamage"] ?? [],
          estimatedRepairCost: totalCost,
          currency: "EUR",
          laborHours: parsed["laborHours"] ?? Math.ceil(totalCost / 85),
          paintRequired: parsed["paintRequired"] ?? false,
          safetyImpact: parsed["safetyImpact"] ?? "unknown",
          driveable: parsed["driveable"] ?? false,
          confidence: imageBlocks.length >= 3 ? "high" : imageBlocks.length >= 2 ? "medium" : "low",
          notes: parsed["notes"] ?? "",
        };

        claimsCtx.updateClaimState({ damageEstimate: totalCost });
        console.log(`[ASSESS] Vision assessment complete: ${items.length} items, EUR ${totalCost}, severity=${assessment.severity}`);
        return JSON.stringify(assessment);
      },
    }),

    check_policy: defineTool({
      name: "check_policy",
      description:
        "Look up the insurance policy details by policy number. Returns coverage type, " +
        "policy limits, deductible, policyholder information, vehicle details, and active status.",
      parameters: {
        policy_number: z.string().describe("The insurance policy number (e.g. 'POL-2024-78432')"),
      },
      execute: async (input) => {
        const policyNumber = typeof input["policy_number"] === "string" ? input["policy_number"] : "UNKNOWN";
        // Pick a random demo identity only on the FIRST call of a claim and
        // reuse the one stored on the claim thereafter — re-rolling per call
        // made the same policy number return a different person mid-claim.
        const existingName = claimsCtx.getClaimState().policyholderName;
        const identity =
          (existingName ? DEMO_IDENTITIES.find(d => d.name === existingName) : undefined)
          ?? DEMO_IDENTITIES[Math.floor(Math.random() * DEMO_IDENTITIES.length)]
          ?? DEMO_IDENTITIES[0]!;
        const policy = {
          policyNumber,
          status: "active",
          type: "comprehensive",
          policyholderName: identity.name,
          policyholderEmail: identity.email,
          vehicleInfo: identity.vehicle,
          coverageLimit: 25000,
          deductible: 500,
          currency: "EUR",
          effectiveDate: "2025-01-01",
          expiryDate: "2026-12-31",
          claimsThisYear: 0,
          premiumPaid: true,
          coverageDetails: {
            collision: true,
            comprehensive: true,
            thirdPartyLiability: true,
            windshield: true,
            rentalCar: true,
            roadside: true,
          },
        };
        claimsCtx.updateClaimState({
          policyNumber,
          policyholderName: policy.policyholderName,
          vehicleInfo: policy.vehicleInfo,
          policyLimit: policy.coverageLimit,
          deductible: policy.deductible,
        });
        return JSON.stringify(policy);
      },
    }),

    calculate_settlement: defineTool({
      name: "calculate_settlement",
      description:
        "Calculate the settlement amount based on the damage estimate, policy limits, and deductible. " +
        "Applies standard insurance settlement logic: settlement = min(damage_estimate, policy_limit) - deductible.",
      parameters: {
        damage_estimate: z.number().describe("Total estimated damage/repair cost"),
        policy_limit: z.number().optional().describe("Maximum coverage amount from the policy (optional)"),
        deductible: z.number().optional().describe("Deductible amount to subtract (optional, default: 0)"),
      },
      execute: async (input) => {
        const damageEstimate = typeof input["damage_estimate"] === "number" ? input["damage_estimate"] : 0;
        const policyLimit = typeof input["policy_limit"] === "number" ? input["policy_limit"] : undefined;
        const deductible = typeof input["deductible"] === "number" ? input["deductible"] : 0;
        const coveredAmount = policyLimit != null ? Math.min(damageEstimate, policyLimit) : damageEstimate;
        const settlementAmount = Math.max(0, coveredAmount - deductible);
        const result = {
          damageEstimate,
          policyLimit: policyLimit ?? "unlimited",
          deductible,
          coveredAmount,
          settlementAmount,
          currency: "EUR",
          calculation: policyLimit != null
            ? `min(${damageEstimate}, ${policyLimit}) - ${deductible} = ${settlementAmount}`
            : `${damageEstimate} - ${deductible} = ${settlementAmount}`,
          limitApplied: policyLimit != null && damageEstimate > policyLimit,
          notes: policyLimit != null && damageEstimate > policyLimit
            ? `Damage estimate (EUR ${damageEstimate}) exceeds policy limit (EUR ${policyLimit}). Settlement capped at coverage maximum.`
            : undefined,
        };
        claimsCtx.updateClaimState({ proposedSettlement: settlementAmount, status: "proposed" });
        return JSON.stringify(result);
      },
    }),

    generate_settlement_document: defineTool({
      name: "generate_settlement_document",
      description:
        "Generate a Settlement Agreement PDF from the agreed claim terms. " +
        "Call this after damage assessment and settlement negotiation are complete. " +
        "The PDF is shown to the policyholder in the chat for in-browser signing. " +
        "Returns a fileId for the generated document.",
      parameters: {
        claim_number: z.string().describe("Claim number (e.g. 'CLM-ABC123')"),
        policyholder_name: z.string().describe("Full name of the policyholder"),
        policyholder_address: z.string().optional().describe("Policyholder address (optional)"),
        damage_description: z.string().describe("Description of the assessed damage"),
        settlement_amount: z.number().describe("Final settlement amount to be paid"),
        currency: z.string().describe("Currency code (e.g. 'EUR', 'USD')"),
        deductible: z.number().optional().describe("Deductible amount applied (optional)"),
        policy_number: z.string().optional().describe("Insurance policy number (optional)"),
        accident_date: z.string().optional().describe("Date of the accident (e.g. '2026-03-15')"),
        vehicle_info: z.string().optional().describe("Vehicle make, model, year, plate (optional)"),
        terms: z.string().optional().describe("Settlement terms and conditions (optional)"),
        notes: z.string().optional().describe("Additional notes or special conditions (optional)"),
      },
      execute: async (input) => {
        const claimNumber = claimsCtx.getClaimState().claimId;
        const policyholderName = String(input["policyholder_name"] ?? "Policyholder");
        const damageDescription = String(input["damage_description"] ?? "Vehicle damage");
        const settlementAmount = typeof input["settlement_amount"] === "number" ? input["settlement_amount"] : 0;
        const currency = String(input["currency"] ?? "EUR");
        const deductible = typeof input["deductible"] === "number" ? input["deductible"] : 0;
        const policyNumber = typeof input["policy_number"] === "string"
          ? input["policy_number"]
          : claimsCtx.getClaimState().policyNumber ?? "";
        const accidentDate = typeof input["accident_date"] === "string"
          ? input["accident_date"]
          : new Date().toISOString().slice(0, 10);
        const vehicleInfo = typeof input["vehicle_info"] === "string"
          ? input["vehicle_info"]
          : claimsCtx.getClaimState().vehicleInfo;

        const settlementData: SettlementData = {
          claimNumber,
          insurerName: "ACME Insurance AG",
          insurerAddress: "Frankfurt, Germany",
          policyholderName,
          policyholderAddress: typeof input["policyholder_address"] === "string" ? input["policyholder_address"] : undefined,
          policyNumber,
          vehicleInfo,
          accidentDate,
          damageDescription,
          damageEstimate: claimsCtx.getClaimState().damageEstimate ?? settlementAmount + deductible,
          deductible,
          settlementAmount,
          currency,
          repairDeadlineDays: 30,
          approvedShopsOnly: true,
          terms: typeof input["terms"] === "string" ? input["terms"] : undefined,
          notes: typeof input["notes"] === "string" ? input["notes"] : undefined,
        };
        const pdfBuffer = await generateSettlement(settlementData);

        const ts = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const fileName = `Settlement-${claimNumber}-${ts}.pdf`;
        const fileId = saveFile(fileName, pdfBuffer, "application/pdf");

        claimsCtx.updateClaimState({ status: "approved", latestSettlementFileId: fileId, latestSettlementData: settlementData });

        return JSON.stringify({
          ok: true,
          fileId,
          fileName,
          claimNumber,
          settlementAmount,
          currency,
          message: `Settlement Agreement PDF generated: ${fileName}. It is now shown in the chat for the policyholder to review and sign.`,
        });
      },
    }),

    // ===== READ — local state lookup =====

    check_signing_status: defineTool({
      name: "check_signing_status",
      description:
        "Check if the Settlement Agreement has been signed or rejected by the policyholder. " +
        "Returns the current status, any signed PDF reference, and recent replies.",
      parameters: {
        instance_id: z.string().optional().describe("The instanceId of the signing request (optional)"),
      },
      execute: async (input) => {
        return JSON.stringify(claimsCtx.getSigningStatus(
          typeof input["instance_id"] === "string" ? input["instance_id"] : undefined,
        ));
      },
    }),

    // ===== DESTRUCTIVE — hard-blocked in code =====
    //
    // In the starter this is enforced with a plain throw. Step 4 of the guide
    // shows how to move this decision OUT of code and into a central FGA policy,
    // so the same denial is auditable and changeable without a redeploy.

    // ===== PAYOUT — simulated settlement payment =====
    //
    // Mock on purpose: this build has no payment rail. It raises a payout card
    // in the chat, the customer confirms it in the browser, and a simulated
    // transaction reference is issued. Nothing moves money, and the UI labels
    // the card SIMULATED so it cannot be mistaken for a real payment.
    //
    // To use a real payment rail, swap the body of this tool — the tool name,
    // schema and the policy tuples keyed on `tool:process_settlement_payout`
    // stay the same.

    process_settlement_payout: defineTool({
      name: "process_settlement_payout",
      description:
        "Initiate the settlement payout to the policyholder after the settlement agreement " +
        "has been signed. Raises a payment confirmation card in the chat for the customer to " +
        "confirm. Call this only once the settlement document is signed.",
      parameters: {
        amount: z.number().describe("Payout amount in major units, e.g. 1850.00"),
        currency: z.string().describe("ISO currency code, e.g. 'EUR'"),
        recipient_name: z.string().describe("Full name of the policyholder being paid"),
        iban: z.string().optional().describe("Destination account (optional; masked before display)"),
        claim_number: z.string().optional().describe("Claim reference, e.g. 'CLM-ABC123'"),
      },
      execute: async (input) => {
        const claim = claimsCtx.getClaimState();

        // Guard against a DUPLICATE payout. Once the claim is settled, a
        // re-call must not raise a second card. This fires in practice: after
        // the customer confirms, the UI auto-sends "please close out my claim",
        // and the model sometimes re-calls this tool on that turn. The
        // "already pending" check further down cannot catch it — by then every
        // card is `paid`, so it finds nothing and goes blind.
        if (claim.status === "paid") {
          return JSON.stringify({
            status: "already_paid",
            message:
              "The payout for this claim is already complete — the claim is settled. Do not initiate " +
              "another payout; just confirm to the customer that it's done.",
          });
        }

        // "paid" is handled above, so this is simply "not signed yet".
        if (claim.status !== "signed") {
          return JSON.stringify({
            error: "Settlement is not signed yet. The payout can only run after the customer signs.",
            claimStatus: claim.status,
          });
        }

        const amount = Number(input["amount"] ?? 0);
        const currency = String(input["currency"] ?? "EUR").toUpperCase();
        const recipientName = String(input["recipient_name"] ?? "Policyholder");
        const claimNumber = String(input["claim_number"] ?? claim.claimId);
        const rawIban = String(input["iban"] ?? "").replace(/\s+/g, "");
        const ibanMasked = rawIban
          ? `${rawIban.slice(0, 4)} **** **** ${rawIban.slice(-4)}`
          : "DE89 **** **** 3000";

        if (!Number.isFinite(amount) || amount <= 0) {
          return JSON.stringify({ error: "amount must be a positive number", received: input["amount"] });
        }

        const existing = claimsCtx.getPaymentRequests().find(m => m.status !== "paid");
        if (existing) {
          return JSON.stringify({
            status: "already_pending",
            message: "A payout confirmation is already waiting for the customer in the chat.",
          });
        }

        const instanceId = `pay-${Date.now().toString(36)}`;
        claimsCtx.addOutgoing({
          type: "payment_request",
          content: `Settlement payout for claim ${claimNumber}.`,
          paymentInstanceId: instanceId,
          amount,
          currency,
          recipientName,
          ibanMasked,
          status: "pending",
        });

        return JSON.stringify({
          status: "awaiting_customer_confirmation",
          instanceId,
          amount,
          currency,
          recipient: recipientName,
          destination: ibanMasked,
          message:
            "A payout confirmation card is now shown in the chat. Tell the policyholder to review " +
            "and confirm it. This is a simulated payment — no funds move.",
        });
      },
    }),

    delete_claim: defineTool({
      name: "delete_claim",
      description:
        "Delete a claim and all associated data. This removes the claim record, photos, " +
        "assessment results, and conversation history. Cannot be undone.",
      parameters: {
        claim_id: z.string().describe("The claim ID to delete (e.g. 'CLM-ABC123')"),
      },
      execute: async () => {
        throw new Error("Deleting claims is blocked by policy");
      },
    }),
  };
}
