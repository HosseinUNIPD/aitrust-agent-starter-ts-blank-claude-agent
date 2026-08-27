/**
 * Claims Agent Context — extends AgentContext with insurance claim state tracking.
 *
 * The claims context tracks:
 *   - All messages (inherited from AgentContext)
 *   - Claim lifecycle (assessment, settlement proposal, negotiation, signing)
 *   - Customer photo evidence
 *   - Signing request tracking (settlement documents)
 */

import { AgentContext, type ContextMessage } from "./agent-context.js";
import type { SettlementData } from "./settlement-generator.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaimState {
  claimId: string;
  status:
    | "new"
    | "assessing"
    | "proposed"
    | "negotiating"
    | "approved"
    | "signing"
    | "signed"
    | "paid"
    | "rejected";
  policyNumber?: string;
  policyholderName?: string;
  vehicleInfo?: string;
  accidentDate?: string;
  accidentDescription?: string;
  damageEstimate?: number;
  policyLimit?: number;
  deductible?: number;
  proposedSettlement?: number;
  agreedSettlement?: number;
  customerPhotos: string[];
  /**
   * fileId of the most recent generate_settlement_document output for THIS claim.
   * The post-loop signing orchestrator uses this to pick the correct PDF instead
   * of `pop()`-ing across all Settlement-*.pdf files in the global upload store
   * (which would leak files from previous claims after an auto-reset).
   */
  latestSettlementFileId?: string;
  /** The data used to generate the latest settlement PDF. Reused at signing
   * time to regenerate a clean SIGNED document (no DRAFT stamp) with the drawn
   * signature placed by the same layout code. */
  latestSettlementData?: SettlementData;
}

// ---------------------------------------------------------------------------
// Claims Context
// ---------------------------------------------------------------------------

export class ClaimsContext extends AgentContext {
  private claim: ClaimState;

  constructor(agentId = "insurance-claims-agent") {
    super(agentId);
    this.claim = {
      claimId: `CLM-${Date.now().toString(36).toUpperCase()}`,
      status: "new",
      customerPhotos: [],
    };
  }

  // ---------------------------------------------------------------------------
  // Claim state
  // ---------------------------------------------------------------------------

  getClaimState(): ClaimState {
    return { ...this.claim, customerPhotos: [...this.claim.customerPhotos] };
  }

  updateClaimState(update: Partial<Omit<ClaimState, "claimId" | "customerPhotos">>): ClaimState {
    Object.assign(this.claim, update);
    return this.getClaimState();
  }

  /**
   * Add a photo file ID to the claim evidence.
   */
  addPhoto(fileId: string): void {
    if (!this.claim.customerPhotos.includes(fileId)) {
      this.claim.customerPhotos.push(fileId);
    }
  }

  // ---------------------------------------------------------------------------
  // Signing status tracking
  // ---------------------------------------------------------------------------

  /**
   * Get all signing requests sent by this agent (settlement documents).
   */
  /** All payout cards raised in this conversation (mock payments). */
  getPaymentRequests(): ContextMessage[] {
    return this.messages.filter(m => m.type === "payment_request");
  }

  /**
   * Mark a payout card confirmed. Returns the simulated transaction reference,
   * or null when the card is unknown or already settled.
   */
  confirmPayment(instanceId: string): string | null {
    const card = this.messages.find(
      m => m.type === "payment_request" && (m.paymentInstanceId === instanceId || m.id === instanceId),
    );
    if (!card || card.status === "paid") return null;
    const ref = `SIM-${Date.now().toString(36).toUpperCase()}`;
    card.status = "paid";
    card.transactionRef = ref;
    this.addOutgoing({
      type: "paid",
      content: `Payout of ${card.amount} ${card.currency} confirmed.`,
      paymentInstanceId: card.paymentInstanceId ?? card.id,
      amount: card.amount,
      currency: card.currency,
      recipientName: card.recipientName,
      ibanMasked: card.ibanMasked,
      transactionRef: ref,
      status: "paid",
    });
    this.updateClaimState({ status: "paid" });
    return ref;
  }

  getSigningRequests(): ContextMessage[] {
    return this.messages.filter(m => m.type === "signing_request");
  }

  /**
   * Get the signing status for a specific instanceId, or the latest if omitted.
   */
  getSigningStatus(instanceId?: string): {
    instanceId?: string;
    status: string;
    fileName?: string;
    signatureImage?: string;
    signedFileId?: string;
    mediaId?: string;
    downloadUrl?: string;
    recentMessages: Array<{ from: string; content: string; timestamp: string }>;
  } {
    if (instanceId) {
      const sigReq = this.messages.find(m => m.signingInstanceId === instanceId && m.type === "signing_request");
      const sigResult = this.messages.find(m => m.signingInstanceId === instanceId && (m.type === "signed" || m.type === "rejected"));
      // Only honor the instanceId-specific lookup when it actually matches a
      // request/result. The LLM often passes the claim number as instance_id,
      // which does NOT match the signing card's generated instanceId — returning
      // "unknown" there wrongly reports an already-signed claim as unsigned and
      // blocks the payout. When there's no match, fall through to the latest
      // signing status below.
      if (sigReq || sigResult) {
        const signedFileId = sigResult?.fileId;
        const mediaId = sigResult?.mediaId;
        const replies = this.messages.filter(m => m.type === "text").slice(-5);
        return {
          instanceId,
          status: sigResult?.type ?? sigReq?.status ?? "unknown",
          fileName: sigResult?.fileName ?? sigReq?.fileName,
          signatureImage: sigResult?.signatureImage,
          signedFileId,
          mediaId,
          downloadUrl: signedFileId
            ? `/api/files/${signedFileId}`
            : (mediaId ? `/api/files/download/${mediaId}` : undefined),
          recentMessages: replies.map(r => ({ from: r.from, content: r.content, timestamp: r.timestamp })),
        };
      }
    }

    const sigReqs = this.getSigningRequests();
    const sigResults = this.messages.filter(m => m.type === "signed" || m.type === "rejected");
    const latestResult = sigResults[sigResults.length - 1];
    const replies = this.messages.filter(m => m.type === "text").slice(-5);
    return {
      status: latestResult?.type ?? (sigReqs.length > 0 ? "pending" : "none"),
      fileName: latestResult?.fileName,
      signatureImage: latestResult?.signatureImage,
      signedFileId: latestResult?.fileId,
      mediaId: latestResult?.mediaId,
      downloadUrl: latestResult?.fileId
        ? `/api/files/${latestResult.fileId}`
        : (latestResult?.mediaId ? `/api/files/download/${latestResult.mediaId}` : undefined),
      recentMessages: replies.map(r => ({ from: r.from, content: r.content, timestamp: r.timestamp })),
    };
  }

  /**
   * Update signing status when a signing callback arrives with a signed/rejected result.
   */
  updateSigningStatus(instanceId: string, status: "signed" | "rejected", opts?: {
    signatureImage?: string;
    mediaId?: string;
    signedFileId?: string;
    fileName?: string;
  }): void {
    // Update the original signing request
    const sigReq = this.messages.find(m => m.signingInstanceId === instanceId && m.type === "signing_request");
    if (sigReq) {
      sigReq.status = status;
      if (opts?.signatureImage) sigReq.signatureImage = opts.signatureImage;
    }

    // Add the result as an incoming message
    this.addIncoming({
      from: "policyholder",
      type: status,
      content: status === "signed"
        ? `Settlement ${opts?.fileName ?? sigReq?.fileName ?? "document"} has been signed`
        : `Settlement ${opts?.fileName ?? sigReq?.fileName ?? "document"} was rejected`,
      signingInstanceId: instanceId,
      fileId: opts?.signedFileId,
      signatureImage: opts?.signatureImage,
      mediaId: opts?.mediaId,
      fileName: opts?.fileName ?? sigReq?.fileName,
    });

    // Update claim state
    this.claim.status = status === "signed" ? "signed" : "rejected";
  }

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  override clear(): void {
    super.clear();
    this.claim = {
      claimId: `CLM-${Date.now().toString(36).toUpperCase()}`,
      status: "new",
      customerPhotos: [],
    };
  }
}
