import "server-only";

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export type ResidentReceiptPdfData = {
  hostelName: string;
  hostelAddress?: string;
  hostelContact?: string;
  hostelEmail?: string;
  logoUrl?: string;
  residentName: string;
  residentId: string;
  room: string;
  bed: string;
  paymentDate: string;
  receiptNumber: string;
  billReference: string;
  paymentType: string;
  amount: number;
  lateFeeAmount?: number;
  paymentMethod: string;
  paymentStatus: string;
  verifiedBy: string;
  verifiedAt?: string;
};

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;

function formatAmount(value: number) {
  return `PKR ${new Intl.NumberFormat("en-PK", { maximumFractionDigits: 2 }).format(value || 0)}`;
}

function formatDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value || "Not recorded"
    : parsed.toLocaleDateString("en-PK", { day: "2-digit", month: "long", year: "numeric" });
}

function fitText(value: string, font: PDFFont, size: number, maxWidth: number) {
  if (font.widthOfTextAtSize(value, size) <= maxWidth) return value;
  let shortened = value;
  while (shortened.length > 1 && font.widthOfTextAtSize(`${shortened}...`, size) > maxWidth) {
    shortened = shortened.slice(0, -1);
  }
  return `${shortened}...`;
}

function drawDetail(page: PDFPage, font: PDFFont, bold: PDFFont, label: string, value: string, x: number, y: number, width: number) {
  page.drawText(label.toUpperCase(), { x, y, size: 8, font: bold, color: rgb(0.39, 0.45, 0.55) });
  page.drawText(fitText(value || "—", font, 11, width), { x, y: y - 17, size: 11, font, color: rgb(0.08, 0.12, 0.2) });
}

async function embedLogo(pdf: PDFDocument, logoUrl: string) {
  try {
    const url = new URL(logoUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > 2_000_000) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 2_000_000) return null;
    const type = response.headers.get("content-type")?.toLowerCase() ?? "";
    return type.includes("png") || url.pathname.toLowerCase().endsWith(".png")
      ? await pdf.embedPng(bytes)
      : await pdf.embedJpg(bytes);
  } catch {
    return null;
  }
}

export async function createResidentReceiptPdf(data: ResidentReceiptPdfData) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${data.hostelName} receipt ${data.receiptNumber}`);
  pdf.setAuthor(data.hostelName);
  pdf.setSubject("Resident payment receipt");
  const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const logo = data.logoUrl ? await embedLogo(pdf, data.logoUrl) : null;

  page.drawRectangle({ x: 0, y: PAGE_HEIGHT - 168, width: PAGE_WIDTH, height: 168, color: rgb(0.18, 0.14, 0.45) });
  if (logo) {
    const scale = Math.min(70 / logo.width, 56 / logo.height);
    page.drawImage(logo, { x: 42, y: PAGE_HEIGHT - 102, width: logo.width * scale, height: logo.height * scale });
  }
  const headingX = logo ? 130 : 42;
  page.drawText(fitText(data.hostelName || "StayHub", bold, 22, 370), { x: headingX, y: PAGE_HEIGHT - 65, size: 22, font: bold, color: rgb(1, 1, 1) });
  page.drawText("PAYMENT RECEIPT", { x: headingX, y: PAGE_HEIGHT - 91, size: 10, font: bold, color: rgb(0.78, 0.76, 0.96) });
  page.drawText(`Receipt # ${data.receiptNumber}`, { x: 42, y: PAGE_HEIGHT - 133, size: 11, font, color: rgb(1, 1, 1) });
  page.drawText(`Generated ${formatDate(new Date().toISOString())}`, { x: 350, y: PAGE_HEIGHT - 133, size: 9, font, color: rgb(0.88, 0.87, 0.98) });

  let y = PAGE_HEIGHT - 215;
  page.drawText("RESIDENT & ALLOCATION", { x: 42, y, size: 10, font: bold, color: rgb(0.18, 0.14, 0.45) });
  y -= 30;
  drawDetail(page, font, bold, "Resident", data.residentName, 42, y, 235);
  drawDetail(page, font, bold, "Resident ID", data.residentId, 312, y, 240);
  y -= 62;
  drawDetail(page, font, bold, "Room", data.room, 42, y, 235);
  drawDetail(page, font, bold, "Bed", data.bed, 312, y, 240);

  y -= 82;
  page.drawLine({ start: { x: 42, y: y + 25 }, end: { x: 553, y: y + 25 }, thickness: 1, color: rgb(0.88, 0.9, 0.93) });
  page.drawText("PAYMENT DETAILS", { x: 42, y, size: 10, font: bold, color: rgb(0.18, 0.14, 0.45) });
  y -= 30;
  drawDetail(page, font, bold, "Payment date", formatDate(data.paymentDate), 42, y, 235);
  drawDetail(page, font, bold, "Invoice / bill", data.billReference, 312, y, 240);
  y -= 62;
  drawDetail(page, font, bold, "Payment type", data.paymentType, 42, y, 235);
  drawDetail(page, font, bold, "Payment method", data.paymentMethod, 312, y, 240);
  y -= 72;
  if (data.lateFeeAmount && data.lateFeeAmount > 0) {
    page.drawText(`Late Fee / Fine: ${formatAmount(data.lateFeeAmount)}`, { x: 42, y: y + 30, size: 10, font: bold });
    page.drawText(`Other allocated obligations: ${formatAmount(data.amount - data.lateFeeAmount)}`, { x: 42, y: y + 14, size: 10, font });
    y -= 35;
  }
  page.drawRectangle({ x: 42, y: y - 25, width: 511, height: 64, color: rgb(0.94, 0.95, 1) });
  page.drawText("AMOUNT PAID", { x: 60, y: y + 12, size: 9, font: bold, color: rgb(0.39, 0.45, 0.55) });
  page.drawText(formatAmount(data.amount), { x: 60, y: y - 12, size: 20, font: bold, color: rgb(0.18, 0.14, 0.45) });
  page.drawText(data.paymentStatus.toUpperCase(), { x: 455, y: y - 6, size: 10, font: bold, color: rgb(0.05, 0.55, 0.35) });

  y -= 90;
  page.drawText("VERIFICATION", { x: 42, y, size: 10, font: bold, color: rgb(0.18, 0.14, 0.45) });
  y -= 30;
  drawDetail(page, font, bold, "Verified by", data.verifiedBy, 42, y, 235);
  drawDetail(page, font, bold, "Verified at", data.verifiedAt ? formatDate(data.verifiedAt) : "Recorded as paid", 312, y, 240);

  const contact = [data.hostelAddress, data.hostelContact, data.hostelEmail].filter(Boolean).join(" | ");
  page.drawLine({ start: { x: 42, y: 66 }, end: { x: 553, y: 66 }, thickness: 1, color: rgb(0.88, 0.9, 0.93) });
  page.drawText("This computer-generated receipt confirms the payment recorded in StayHub.", { x: 42, y: 46, size: 8, font, color: rgb(0.39, 0.45, 0.55) });
  if (contact) page.drawText(fitText(contact, font, 8, 511), { x: 42, y: 31, size: 8, font, color: rgb(0.39, 0.45, 0.55) });

  return pdf.save();
}
