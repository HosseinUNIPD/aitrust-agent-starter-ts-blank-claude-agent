/**
 * Insurance Settlement PDF Generator v2 — redesigned layout with visual
 * anti-caching measures: diagonal watermark, colored header bar, prominent
 * timestamp, unique document ID, and "DRAFT - FOR SIGNING" stamp.
 *
 * Every generated PDF is visually unique (timestamp + random doc ID in
 * watermark + header bar) so a signing surface cannot show a cached old version.
 */

import * as pdfLib from "pdf-lib";
import { randomBytes } from "node:crypto";
const { PDFDocument, StandardFonts, rgb, degrees } = pdfLib;
const PDFArray = (pdfLib as unknown as { PDFArray: { withContext: (ctx: unknown) => { push: (v: unknown) => void } } }).PDFArray;
const PDFHexString = (pdfLib as unknown as { PDFHexString: { of: (hex: string) => unknown } }).PDFHexString;

export interface SettlementData {
  claimNumber: string;
  date?: string;
  insurerName: string;
  insurerAddress?: string;
  policyholderName: string;
  policyholderAddress?: string;
  policyNumber: string;
  vehicleInfo?: string;
  accidentDate: string;
  damageDescription: string;
  damageEstimate: number;
  deductible: number;
  settlementAmount: number;
  currency: string;
  repairDeadlineDays?: number;
  approvedShopsOnly?: boolean;
  terms?: string;
  notes?: string;
}

function formatCurrency(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Generate a short unique document ID for visual identification. */
function generateDocId(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `DOC-${ts}-${rand}`;
}

/**
 * Generate the settlement PDF.
 *
 * When `signed` is provided, the document is rendered as the FINAL executed
 * agreement rather than a draft: the red "DRAFT - FOR SIGNING" stamp becomes a
 * green "SIGNED" stamp, the policyholder box shows the drawn signature sitting
 * on the line with a green "Signed <date>" caption (instead of "... awaiting").
 * Signing regenerates from the same data + layout so the signature is always
 * placed correctly — no fixed-offset overlay drift.
 */
export async function generateSettlement(
  data: SettlementData,
  signed?: { signaturePng: Buffer; signedAt: string },
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const fontOblique = await doc.embedFont(StandardFonts.HelveticaOblique);

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 50;
  const contentWidth = pageWidth - 2 * margin;

  // Colors
  const white = rgb(1, 1, 1);
  const black = rgb(0, 0, 0);
  const darkGray = rgb(0.3, 0.3, 0.3);
  const midGray = rgb(0.55, 0.55, 0.55);
  const headerBlue = rgb(0.05, 0.15, 0.45);
  const accentBlue = rgb(0.12, 0.35, 0.7);
  const lightBlueBg = rgb(0.92, 0.95, 1.0);
  const tableHeaderBg = rgb(0.08, 0.2, 0.55);
  const tableBorderGray = rgb(0.75, 0.75, 0.75);
  const stampRed = rgb(0.85, 0.15, 0.1);
  const watermarkGray = rgb(0.88, 0.88, 0.88);

  const docId = generateDocId();
  const now = new Date();
  const dateStr = data.date ?? now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 19);
  const fullTimestamp = `${dateStr} ${timeStr} UTC`;

  // =========================================================================
  // Layer 1: Diagonal watermark across the entire page
  // =========================================================================
  const watermarkText = `${data.claimNumber}  ${docId}`;
  page.drawText(watermarkText, {
    x: 40,
    y: 350,
    size: 52,
    font: fontBold,
    color: watermarkGray,
    rotate: degrees(35),
    opacity: 0.35,
  });

  // =========================================================================
  // Layer 2: Header bar — solid blue rectangle across the top
  // =========================================================================
  const headerBarHeight = 80;
  const headerBarY = pageHeight - headerBarHeight;
  page.drawRectangle({
    x: 0,
    y: headerBarY,
    width: pageWidth,
    height: headerBarHeight,
    color: headerBlue,
  });

  // Title inside header bar
  page.drawText("INSURANCE SETTLEMENT AGREEMENT", {
    x: margin,
    y: headerBarY + 45,
    size: 19,
    font: fontBold,
    color: white,
  });

  // Claim number + Document ID on the right
  const claimLabel = `${data.claimNumber}`;
  const claimLabelW = fontBold.widthOfTextAtSize(claimLabel, 11);
  page.drawText(claimLabel, {
    x: pageWidth - margin - claimLabelW,
    y: headerBarY + 50,
    size: 11,
    font: fontBold,
    color: rgb(0.8, 0.85, 1.0),
  });

  const docIdW = font.widthOfTextAtSize(docId, 9);
  page.drawText(docId, {
    x: pageWidth - margin - docIdW,
    y: headerBarY + 35,
    size: 9,
    font,
    color: rgb(0.7, 0.75, 0.9),
  });

  // Subtitle line below title
  page.drawText("KOBIL AI Trust Platform  |  Secure Digital Settlement", {
    x: margin,
    y: headerBarY + 22,
    size: 9,
    font,
    color: rgb(0.7, 0.75, 0.9),
  });

  // Thin accent line below header bar
  page.drawRectangle({
    x: 0,
    y: headerBarY - 3,
    width: pageWidth,
    height: 3,
    color: accentBlue,
  });

  // =========================================================================
  // Layer 3: "DRAFT — FOR SIGNING" stamp (rotated, top-right area)
  // =========================================================================
  page.drawText(signed ? "SIGNED" : "DRAFT - FOR SIGNING", {
    x: signed ? 380 : 310,
    y: headerBarY - 55,
    size: 26,
    font: fontBold,
    color: signed ? rgb(0.05, 0.45, 0.15) : stampRed,
    rotate: degrees(-12),
    opacity: 0.6,
  });

  // =========================================================================
  // Content area starts below header
  // =========================================================================
  let y = headerBarY - 30;

  // Prominent timestamp bar
  const tsBarHeight = 22;
  page.drawRectangle({
    x: margin,
    y: y - tsBarHeight,
    width: contentWidth,
    height: tsBarHeight,
    color: lightBlueBg,
  });
  page.drawText(`Generated: ${fullTimestamp}`, {
    x: margin + 8,
    y: y - tsBarHeight + 6,
    size: 9,
    font: fontBold,
    color: accentBlue,
  });
  const dateLabel = `Date: ${dateStr}`;
  const dateLabelW = font.widthOfTextAtSize(dateLabel, 9);
  page.drawText(dateLabel, {
    x: pageWidth - margin - dateLabelW - 8,
    y: y - tsBarHeight + 6,
    size: 9,
    font,
    color: darkGray,
  });
  y -= tsBarHeight + 18;

  // =========================================================================
  // Parties — two-column layout with background boxes
  // =========================================================================
  const colWidth = (contentWidth - 16) / 2;
  const partyBoxHeight = 72;

  // Insurer box
  page.drawRectangle({ x: margin, y: y - partyBoxHeight, width: colWidth, height: partyBoxHeight, color: lightBlueBg, borderColor: tableBorderGray, borderWidth: 0.5 });
  page.drawText("INSURER", { x: margin + 10, y: y - 16, size: 8, font: fontBold, color: accentBlue });
  page.drawText(data.insurerName, { x: margin + 10, y: y - 30, size: 11, font: fontBold, color: black });
  if (data.insurerAddress) {
    const addrLines = data.insurerAddress.split("\n").slice(0, 2);
    let addrY = y - 44;
    for (const line of addrLines) {
      page.drawText(line.slice(0, 40), { x: margin + 10, y: addrY, size: 9, font, color: darkGray });
      addrY -= 12;
    }
  }

  // Policyholder box
  const phX = margin + colWidth + 16;
  page.drawRectangle({ x: phX, y: y - partyBoxHeight, width: colWidth, height: partyBoxHeight, color: lightBlueBg, borderColor: tableBorderGray, borderWidth: 0.5 });
  page.drawText("POLICYHOLDER", { x: phX + 10, y: y - 16, size: 8, font: fontBold, color: accentBlue });
  page.drawText(data.policyholderName, { x: phX + 10, y: y - 30, size: 11, font: fontBold, color: black });
  if (data.policyholderAddress) {
    const addrLines = data.policyholderAddress.split("\n").slice(0, 2);
    let addrY = y - 44;
    for (const line of addrLines) {
      page.drawText(line.slice(0, 40), { x: phX + 10, y: addrY, size: 9, font, color: darkGray });
      addrY -= 12;
    }
  }

  y -= partyBoxHeight + 18;

  // =========================================================================
  // Claim Details — key-value pairs with separator
  // =========================================================================
  page.drawText("CLAIM DETAILS", { x: margin, y, size: 10, font: fontBold, color: headerBlue });
  y -= 4;
  page.drawLine({ start: { x: margin, y }, end: { x: pageWidth - margin, y }, thickness: 1, color: accentBlue });
  y -= 16;

  const details: [string, string][] = [
    ["Policy Number:", data.policyNumber],
    ["Accident Date:", data.accidentDate],
  ];
  if (data.vehicleInfo) {
    details.splice(1, 0, ["Vehicle:", data.vehicleInfo]);
  }

  for (const [label, value] of details) {
    page.drawText(label, { x: margin, y, size: 9, font: fontBold, color: darkGray });
    page.drawText(value, { x: margin + 105, y, size: 9, font, color: black });
    y -= 14;
  }

  // Damage description
  y -= 4;
  page.drawText("Damage Description:", { x: margin, y, size: 9, font: fontBold, color: darkGray });
  y -= 14;
  const descLines = data.damageDescription.split("\n");
  for (const rawLine of descLines.slice(0, 4)) {
    page.drawText(rawLine.slice(0, 85), { x: margin, y, size: 9, font, color: black });
    y -= 12;
  }

  y -= 12;

  // =========================================================================
  // Financial Summary Table — styled with colored header row
  // =========================================================================
  page.drawText("FINANCIAL SUMMARY", { x: margin, y, size: 10, font: fontBold, color: headerBlue });
  y -= 4;
  page.drawLine({ start: { x: margin, y }, end: { x: pageWidth - margin, y }, thickness: 1, color: accentBlue });
  y -= 2;

  const labelX = margin;
  const amountX = margin + contentWidth * 0.68;
  const tableRowH = 22;

  // Table header row
  page.drawRectangle({ x: margin, y: y - tableRowH, width: contentWidth, height: tableRowH, color: tableHeaderBg });
  page.drawText("Item", { x: labelX + 8, y: y - tableRowH + 6, size: 9, font: fontBold, color: white });
  page.drawText("Amount", { x: amountX, y: y - tableRowH + 6, size: 9, font: fontBold, color: white });
  y -= tableRowH;

  // Row: Estimated Repair Cost
  page.drawRectangle({ x: margin, y: y - tableRowH, width: contentWidth, height: tableRowH, color: rgb(0.97, 0.97, 0.97) });
  page.drawText("Estimated Repair Cost", { x: labelX + 8, y: y - tableRowH + 6, size: 10, font, color: black });
  page.drawText(formatCurrency(data.damageEstimate, data.currency), { x: amountX, y: y - tableRowH + 6, size: 10, font, color: black });
  y -= tableRowH;

  // Row: Deductible
  page.drawRectangle({ x: margin, y: y - tableRowH, width: contentWidth, height: tableRowH, color: white });
  page.drawText("Deductible", { x: labelX + 8, y: y - tableRowH + 6, size: 10, font, color: black });
  page.drawText(`-${formatCurrency(data.deductible, data.currency)}`, { x: amountX, y: y - tableRowH + 6, size: 10, font, color: rgb(0.7, 0.15, 0.1) });
  y -= tableRowH;

  // Separator
  page.drawLine({ start: { x: amountX - 10, y }, end: { x: pageWidth - margin, y }, thickness: 1.2, color: headerBlue });
  y -= 4;

  // Row: Settlement Amount (highlighted)
  const totalRowH = 26;
  page.drawRectangle({ x: margin, y: y - totalRowH, width: contentWidth, height: totalRowH, color: lightBlueBg, borderColor: accentBlue, borderWidth: 1 });
  page.drawText("SETTLEMENT AMOUNT", { x: labelX + 8, y: y - totalRowH + 8, size: 12, font: fontBold, color: headerBlue });
  page.drawText(formatCurrency(data.settlementAmount, data.currency), { x: amountX, y: y - totalRowH + 8, size: 12, font: fontBold, color: headerBlue });
  y -= totalRowH + 16;

  // =========================================================================
  // Settlement Terms
  // =========================================================================
  page.drawText("SETTLEMENT TERMS", { x: margin, y, size: 10, font: fontBold, color: headerBlue });
  y -= 4;
  page.drawLine({ start: { x: margin, y }, end: { x: pageWidth - margin, y }, thickness: 1, color: accentBlue });
  y -= 16;

  const termItems: [string, string][] = [];
  if (data.repairDeadlineDays != null) {
    termItems.push(["Repair Deadline:", `${data.repairDeadlineDays} days from settlement date`]);
  }
  if (data.approvedShopsOnly != null) {
    termItems.push(["Repair Facility:", data.approvedShopsOnly ? "Approved repair shops only" : "Any licensed repair shop"]);
  }
  termItems.push([
    "Release:",
    "Upon payment, the policyholder releases the insurer from further claims related to this incident.",
  ]);

  for (const [label, value] of termItems) {
    page.drawText(label, { x: margin, y, size: 9, font: fontBold, color: darkGray });

    const valueMaxWidth = contentWidth - 115;
    if (font.widthOfTextAtSize(value, 9) > valueMaxWidth) {
      const words = value.split(" ");
      let line1 = "";
      let rest = "";
      let hitLimit = false;
      for (const word of words) {
        if (!hitLimit && font.widthOfTextAtSize(line1 + word + " ", 9) <= valueMaxWidth) {
          line1 += word + " ";
        } else {
          hitLimit = true;
          rest += word + " ";
        }
      }
      page.drawText(line1.trim(), { x: margin + 110, y, size: 9, font, color: black });
      y -= 12;
      page.drawText(rest.trim().slice(0, 85), { x: margin + 110, y, size: 9, font, color: black });
    } else {
      page.drawText(value, { x: margin + 110, y, size: 9, font, color: black });
    }
    y -= 14;
  }

  if (data.terms) {
    y -= 4;
    page.drawText("Additional Terms:", { x: margin, y, size: 9, font: fontBold, color: darkGray });
    y -= 14;
    for (const line of data.terms.split("\n").slice(0, 3)) {
      page.drawText(line.slice(0, 85), { x: margin, y, size: 9, font, color: darkGray });
      y -= 12;
    }
  }

  if (data.notes) {
    y -= 4;
    page.drawText("Notes:", { x: margin, y, size: 9, font: fontBold, color: darkGray });
    y -= 14;
    for (const line of data.notes.split("\n").slice(0, 3)) {
      page.drawText(line.slice(0, 80), { x: margin, y, size: 9, font, color: darkGray });
      y -= 12;
    }
  }

  // =========================================================================
  // Signature Blocks
  //
  // Maximum-variation strategy: every generated PDF has different content
  // around the policyholder signature box so a signing widget cannot match
  // it as "the same document I already signed". On top of the unique /ID
  // trailer (PDF 1.7 § 14.4) we vary:
  //   - signature line Y position by up to ±1 pt (sub-visible jitter)
  //   - millisecond-precision timestamp printed inside the signature box
  //   - random nonce string printed inside the signature box
  //   - randomized "AWAITING …" footer text below the line
  // These are visible-but-inconsequential differences whose only purpose is
  // to defeat any form of content-hash caching a signing widget might do.
  // =========================================================================
  const sigJitter = (Math.random() - 0.5) * 2; // ±1 pt
  const sigNonce = randomBytes(6).toString("hex").toUpperCase();
  const msStamp = `${dateStr}T${new Date().toISOString().slice(11, 23)}Z`; // ms-precision
  // Place the signature block a modest gap BELOW the content, not pinned near
  // the page bottom (Math.min forced it to y=175 leaving a big empty gap).
  // Floor at 130 so a long body can't push the block off the bottom margin.
  y = Math.max(y - 30, 130) + sigJitter;
  page.drawLine({ start: { x: margin, y }, end: { x: pageWidth - margin, y }, thickness: 1, color: accentBlue });
  y -= 28;

  // Left: Insurance company — pre-signed by the agent
  page.drawText("Insurance Company", { x: margin, y, size: 9, font: fontBold, color: darkGray });

  // Stylized signature on the line (italic, brand color) — give it room
  page.drawText("KOBIL Insurance AG", {
    x: margin + 4,
    y: y - 28,
    size: 13,
    font: fontOblique,
    color: accentBlue,
  });
  page.drawLine({ start: { x: margin, y: y - 36 }, end: { x: margin + 180, y: y - 36 }, thickness: 0.8, color: midGray });

  // "APPROVED" red badge — placed BELOW the signature line so it doesn't overlap text
  const badgeX = margin;
  const badgeY = y - 70;
  page.drawRectangle({
    x: badgeX, y: badgeY, width: 60, height: 18,
    borderColor: stampRed, borderWidth: 1.2, color: rgb(1, 0.96, 0.95),
  });
  page.drawText("APPROVED", {
    x: badgeX + 6, y: badgeY + 5,
    size: 9, font: fontBold, color: stampRed,
  });

  page.drawText(`Digitally signed by KOBIL Insurance AG`, {
    x: margin + 70, y: y - 60, size: 7, font: fontBold, color: rgb(0.05, 0.45, 0.15),
  });
  page.drawText(msStamp, {
    x: margin + 70, y: y - 70, size: 7, font, color: midGray,
  });

  // Right: Policyholder — left blank for the signing surface to overlay the signature.
  // Embed the unique nonce + ms timestamp + claim ID into the signature area so
  // every signing surface is byte-different. A signing widget will see a fresh
  // document with a unique signing region every time.
  const sigRightX = pageWidth - margin - 180;
  page.drawText("Policyholder", { x: sigRightX, y, size: 9, font: fontBold, color: darkGray });
  if (signed) {
    // Draw the customer's drawn signature sitting ON the line, fitted into the
    // signature band (preserve aspect, cap size) so it reads clearly.
    const sigPng = await doc.embedPng(signed.signaturePng);
    const maxW = pageWidth - margin - sigRightX - 6;
    const maxH = 34;
    const ar = sigPng.width / sigPng.height || 3;
    let sw = maxW;
    let sh = sw / ar;
    if (sh > maxH) { sh = maxH; sw = sh * ar; }
    page.drawImage(sigPng, { x: sigRightX + 6, y: y - 36, width: sw, height: sh });
  }
  page.drawLine({ start: { x: sigRightX, y: y - 36 }, end: { x: pageWidth - margin, y: y - 36 }, thickness: 0.8, color: midGray });
  page.drawText("Digital Signature / Date", { x: sigRightX, y: y - 48, size: 8, font: fontOblique, color: midGray });
  if (signed) {
    page.drawText(`Signed ${signed.signedAt}`, {
      x: sigRightX, y: y - 58, size: 7, font: fontBold, color: rgb(0.05, 0.45, 0.15),
    });
  } else {
    page.drawText(`Sign field ${sigNonce} · awaiting`, {
      x: sigRightX, y: y - 58, size: 7, font: fontOblique, color: midGray,
    });
  }
  page.drawText(`(${data.claimNumber} · ${msStamp})`, {
    x: sigRightX, y: y - 68, size: 6, font, color: midGray,
  });

  // =========================================================================
  // Footer bar
  // =========================================================================
  const footerBarH = 28;
  page.drawRectangle({ x: 0, y: 0, width: pageWidth, height: footerBarH, color: headerBlue });
  page.drawText("KOBIL AI Trust Platform  |  Secure Settlement Processing", {
    x: margin,
    y: 10,
    size: 7,
    font,
    color: rgb(0.7, 0.75, 0.9),
  });

  const footerRef = `${data.claimNumber}  |  ${docId}  |  ${fullTimestamp}`;
  const footerRefW = font.widthOfTextAtSize(footerRef, 7);
  page.drawText(footerRef, {
    x: pageWidth - margin - footerRefW,
    y: 10,
    size: 7,
    font,
    color: rgb(0.7, 0.75, 0.9),
  });

  // ---------------------------------------------------------------------------
  // Force a UNIQUE PDF /ID per document (PDF 1.7 § 14.4).
  //
  // Without this, pdf-lib writes no /ID entry, and downstream signing widgets
  // key their local signature cache
  // on document identity and replay the last-drawn signature across runs.
  // A fresh random /ID makes every generated PDF a distinct document to any
  // spec-compliant consumer and forces the pad to start blank.
  // ---------------------------------------------------------------------------
  const idBytes = randomBytes(16).toString("hex").toUpperCase();
  const ctx = doc.context as unknown as { trailerInfo: { ID: unknown } };
  const idArray = PDFArray.withContext(doc.context);
  idArray.push(PDFHexString.of(idBytes));
  idArray.push(PDFHexString.of(idBytes));
  ctx.trailerInfo.ID = idArray;

  const pdfBytes = await doc.save({ useObjectStreams: false });
  return Buffer.from(pdfBytes);
}
