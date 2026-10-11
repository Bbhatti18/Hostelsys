import "server-only";

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { buildBillApprovalEmail } from "@/lib/email/billApprovalEmail";
import { gmailSenderConfigured, sendGmailEmail } from "@/lib/email/gmailClient";
import { sendTransactionalEmail } from "@/lib/email/resendClient";
import { securityDepositAdmissionId } from "@/lib/paymentReceiptPurpose";
import type { NotificationChannel, NotificationEventType, NotificationRequestOptions, NotificationRequestResult } from "@/lib/notifications/types";

type Row = Record<string, unknown>;
type ChannelStatus = "sent" | "skipped" | "configuration_required" | "failed";
type ChannelDelivery = { status: ChannelStatus; providerMessageId: string | null };
type EventMessage = {
  eventKey: string;
  residentId: string;
  email: string;
  phone: string;
  subject: string;
  body: string;
  html?: string;
  parameters: string[];
};

const EVENT_MAX_AGE_MS = 15 * 60 * 1000;
const templateEnv: Record<NotificationEventType, string> = {
  admission_created: "WHATSAPP_TEMPLATE_ADMISSION_CREATED",
  bill_generated: "WHATSAPP_TEMPLATE_BILL_GENERATED",
  receipt_submitted: "WHATSAPP_TEMPLATE_RECEIPT_SUBMITTED",
  payment_verified: "WHATSAPP_TEMPLATE_PAYMENT_VERIFIED",
  payment_rejected: "WHATSAPP_TEMPLATE_PAYMENT_REJECTED",
  contract_approved: "WHATSAPP_TEMPLATE_CONTRACT_APPROVED",
  resident_notice_created: "WHATSAPP_TEMPLATE_RESIDENT_NOTICE_CREATED",
  resident_login_details_sent: "WHATSAPP_TEMPLATE_RESIDENT_LOGIN_DETAILS_SENT",
};

const defaultChannels: NotificationChannel[] = ["email"];

function text(value: unknown) {
  return String(value ?? "").trim();
}

function normalized(value: unknown) {
  return text(value).toLowerCase();
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Unknown error";
}

function money(value: unknown) {
  const amount = Number(value ?? 0);
  return `Rs ${Number.isFinite(amount) ? amount.toLocaleString("en-PK", { maximumFractionDigits: 2 }) : "0"}`;
}

function displayDate(value: unknown) {
  const raw = text(value);
  if (!raw) return "Not recorded";
  const parsed = new Date(raw.length === 10 ? `${raw}T00:00:00Z` : raw);
  return Number.isNaN(parsed.getTime())
    ? raw
    : parsed.toLocaleDateString("en-PK", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

function siteUrl() {
  const envUrl = text(process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.SITE_URL || "");
  if (envUrl) return envUrl.replace(/\/$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`.replace(/\/$/, "");
  return "";
}

function portalUrl(path = "") {
  const base = siteUrl();
  return base ? `${base}/resident-portal${path}` : `/resident-portal${path}`;
}

function recent(value: unknown) {
  const timestamp = new Date(text(value)).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp <= EVENT_MAX_AGE_MS;
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function normalizePhone(value: string) {
  const compact = value.trim().replace(/[\s().-]/g, "");
  if (!compact) return "";
  if (compact.startsWith("+")) {
    const digits = compact.slice(1);
    return /^\d{8,15}$/.test(digits) ? digits : "";
  }
  if (compact.startsWith("00")) {
    const digits = compact.slice(2);
    return /^\d{8,15}$/.test(digits) ? digits : "";
  }
  const country = text(process.env.WHATSAPP_DEFAULT_COUNTRY_CODE).replace(/^\+/, "");
  if (!/^\d{1,3}$/.test(country)) return "";
  const digits = `${country}${compact.replace(/^0+/, "")}`;
  return /^\d{8,15}$/.test(digits) ? digits : "";
}

async function loadResident(residentId: string) {
  const { data, error } = await supabaseAdmin
    .from("residents")
    .select("id, full_name, email, phone, status")
    .eq("id", residentId)
    .maybeSingle();
  if (error || !data || normalized(data.status) === "archived") throw new Error("recipient_unavailable");
  return data as Row;
}

function message(
  eventType: NotificationEventType,
  entityId: string,
  resident: Row,
  subject: string,
  lines: string[],
  parameters: string[],
): EventMessage {
  const name = text(resident.full_name) || "Resident";
  return {
    eventKey: `${eventType}:${entityId}`,
    residentId: text(resident.id),
    email: text(resident.email),
    phone: text(resident.phone),
    subject,
    body: [`Hello ${name},`, "", ...lines, "", `Resident Portal: ${portalUrl()}`, "", "StayHub / Hostel Management System"].join("\n"),
    parameters,
  };
}

async function resolveAdmission(entityId: string) {
  const { data: admission, error } = await supabaseAdmin.from("admissions")
    .select("id, resident_id, room_id, bed_id, admission_date, monthly_rent, security_deposit, status, created_at")
    .eq("id", entityId).maybeSingle();
  if (error || !admission || !recent(admission.created_at)) throw new Error("event_unavailable");
  const [{ data: room }, { data: bed }, { data: contract }, resident] = await Promise.all([
    supabaseAdmin.from("rooms").select("room_number").eq("id", admission.room_id).maybeSingle(),
    supabaseAdmin.from("beds").select("bed_number").eq("id", admission.bed_id).maybeSingle(),
    supabaseAdmin.from("contracts").select("status").eq("admission_id", admission.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    loadResident(text(admission.resident_id)),
  ]);
  if (!contract) throw new Error("event_unavailable");
  const values = [text(resident.full_name) || "Resident", text(room?.room_number) || "—", text(bed?.bed_number) || "—", displayDate(admission.admission_date), money(admission.monthly_rent), money(admission.security_deposit), text(admission.status) || "Pending", text(contract.status) || "Pending Signature"];
  return message("admission_created", entityId, resident, "Your StayHub admission and contract are ready", [
    `Admission created for: ${values[0]}`,
    `Room / Bed: ${values[1]} / ${values[2]}`,
    `Admission date: ${values[3]}`,
    `Monthly rent: ${values[4]}`,
    `Security deposit: ${values[5]}`,
    `Admission status: ${values[6]}`,
    `Contract status: ${values[7]}. Your contract is ready for review and signature.`,
  ], values);
}

async function resolveBill(entityId: string) {
  const { data: bill, error } = await supabaseAdmin.from("bills")
    .select("id, resident_id, bill_number, billing_month, total_amount, rent_amount, electricity_amount, ac_amount, other_amount, discount_amount, paid_amount, due_date, balance_amount, bill_status, created_at")
    .eq("id", entityId).maybeSingle();
  if (error || !bill || ["cancelled", "archived"].includes(normalized(bill.bill_status))) throw new Error("event_unavailable");
  const resident = await loadResident(text(bill.resident_id));
  const components = [Number(bill.rent_amount) > 0 ? "Rent" : "", Number(bill.electricity_amount) > 0 ? "Electricity" : "", Number(bill.ac_amount) > 0 ? "AC" : "", Number(bill.other_amount) > 0 ? "Other" : ""].filter(Boolean).join(", ") || "Monthly bill";
  const values = [text(resident.full_name) || "Resident", text(bill.bill_number) || entityId, displayDate(bill.billing_month), money(bill.total_amount), components, displayDate(bill.due_date), money(bill.balance_amount)];
  const hostelName = text(process.env.NEXT_PUBLIC_HOSTEL_NAME || process.env.NOTIFICATION_EMAIL_FROM_NAME) || "University Girls Hostel";
  const billEmail = buildBillApprovalEmail({
    residentName: values[0],
    billNumber: values[1],
    billingMonth: text(bill.billing_month).slice(0, 7) || text(bill.billing_month),
    dueDate: text(bill.due_date).slice(0, 10),
    rentAmount: Number(bill.rent_amount ?? 0),
    electricityAmount: Number(bill.electricity_amount ?? 0),
    acAmount: Number(bill.ac_amount ?? 0),
    otherAmount: Number(bill.other_amount ?? 0),
    discountAmount: Number(bill.discount_amount ?? 0),
    totalAmount: Number(bill.total_amount ?? 0),
    paidAmount: Number(bill.paid_amount ?? 0),
    balanceAmount: Number(bill.balance_amount ?? 0),
    portalUrl: portalUrl("/payments"),
    hostelName,
  });
  return {
    eventKey: `bill_generated:${entityId}`,
    residentId: text(resident.id),
    email: text(resident.email),
    phone: text(resident.phone),
    subject: billEmail.subject,
    body: billEmail.text,
    html: billEmail.html,
    parameters: values,
  };
}

async function resolveReceipt(eventType: "receipt_submitted" | "payment_verified" | "payment_rejected", entityId: string) {
  const { data: receipt, error } = await supabaseAdmin.from("payment_receipts")
    .select("id, resident_id, bill_id, amount, status, notes, remarks, created_at, updated_at")
    .eq("id", entityId).maybeSingle();
  const expected = eventType === "receipt_submitted" ? "pending verification" : eventType === "payment_verified" ? "verified" : "rejected";
  const eventTime = eventType === "receipt_submitted" ? receipt?.created_at : receipt?.updated_at;
  if (error || !receipt || !recent(eventTime) || normalized(receipt.status) !== expected) throw new Error("event_unavailable");
  const depositAdmissionId = receipt.bill_id
    ? null
    : securityDepositAdmissionId(receipt.notes);
  const [{ data: bill }, { data: depositAdmission }, resident] = await Promise.all([
    receipt.bill_id ? supabaseAdmin.from("bills").select("bill_number, paid_amount, balance_amount, bill_status").eq("id", receipt.bill_id).maybeSingle() : Promise.resolve({ data: null }),
    depositAdmissionId ? supabaseAdmin.from("admissions").select("id, resident_id, deposit_status, status").eq("id", depositAdmissionId).maybeSingle() : Promise.resolve({ data: null }),
    loadResident(text(receipt.resident_id)),
  ]);
  const isDeposit = Boolean(
    depositAdmission &&
    depositAdmission.resident_id === receipt.resident_id &&
    !receipt.bill_id,
  );
  if (!bill && !isDeposit) throw new Error("event_unavailable");
  const name = text(resident.full_name) || "Resident";
  const billNumber = isDeposit ? "Security Deposit" : text(bill?.bill_number) || "Bill";
  const amount = money(receipt.amount);
  if (eventType === "receipt_submitted") {
    return message(eventType, entityId, resident, `Receipt received for ${billNumber}`, [`Receipt received for: ${billNumber}`, `Amount: ${amount}`, "Status: Pending Verification", "Your balance or deposit status will change only after admin verification."], [name, billNumber, amount, "Pending Verification"]);
  }
  if (eventType === "payment_verified") {
    if (isDeposit) {
      const status = text(depositAdmission?.deposit_status) || "Received";
      const admissionStatus = text(depositAdmission?.status) || "Pending";
      const state = admissionStatus === "Active"
        ? "Your admission is Active."
        : "Your admission remains Pending until an admin explicitly activates it.";
      const values = [name, billNumber, amount, amount, money(0), status, state];
      return message(eventType, entityId, resident, "Security Deposit verified", [`Verified deposit: ${amount}`, `Deposit status: ${status}`, `Admission status: ${admissionStatus}`, state], values);
    }
    const balance = money(bill?.balance_amount);
    const status = text(bill?.bill_status) || "Updated";
    const fullyPaid = Number(bill?.balance_amount ?? 0) <= 0 ? "This bill is fully paid." : "A balance remains outstanding.";
    const values = [name, billNumber, amount, money(bill?.paid_amount), balance, status, fullyPaid];
    return message(eventType, entityId, resident, `Payment verified for ${billNumber}`, [`Verified amount: ${amount}`, `Updated paid total: ${values[3]}`, `Outstanding: ${balance}`, `Bill status: ${status}`, fullyPaid], values);
  }
  const reason = text(receipt.remarks) || "Please contact hostel administration for details.";
  return message(eventType, entityId, resident, `Payment receipt rejected for ${billNumber}`, [`Rejected amount: ${amount}`, `Reason: ${reason}`, "Please review the reason and submit a corrected receipt through the Resident Portal."], [name, billNumber, amount, reason]);
}

async function resolveContract(entityId: string) {
  const { data: contract, error } = await supabaseAdmin.from("contracts")
    .select("id, resident_id, admission_id, resident_signature_status, status, updated_at")
    .eq("id", entityId).maybeSingle();
  if (error || !contract || !recent(contract.updated_at) || normalized(contract.resident_signature_status) !== "approved") throw new Error("event_unavailable");
  const [{ data: admission }, resident] = await Promise.all([
    supabaseAdmin.from("admissions").select("status, deposit_status").eq("id", contract.admission_id).maybeSingle(),
    loadResident(text(contract.resident_id)),
  ]);
  if (!admission) throw new Error("event_unavailable");
  const active = normalized(admission.status) === "active";
  const state = active ? "Your admission is Active." : normalized(admission.deposit_status) !== "held" ? "Your admission remains Pending until the security deposit is received." : "Your admission remains Pending while activation is finalized.";
  const values = [text(resident.full_name) || "Resident", text(contract.status) || "Approved", text(admission.deposit_status) || "Pending", text(admission.status) || "Pending", state];
  return message("contract_approved", entityId, resident, "Your StayHub contract signature was approved", ["Your resident contract signature has been approved by hostel administration.", `Deposit status: ${values[2]}`, `Admission status: ${values[3]}`, state], values);
}

async function resolveNotice(entityId: string, requestedRecipientIds: string[]) {
  const { data: notice, error } = await supabaseAdmin
    .from("notices")
    .select("id, title, description, audience, resident_id, room_id, status, publish_date, expiry_date, created_at")
    .eq("id", entityId)
    .maybeSingle();
  const today = new Date().toISOString().slice(0, 10);
  if (error || !notice || !recent(notice.created_at) || notice.status !== "Published" || !notice.publish_date || notice.publish_date > today || (notice.expiry_date && notice.expiry_date < today)) throw new Error("event_unavailable");

  const audience = normalized(notice.audience);
  let recipientIds: string[] = [];
  if (audience === "all residents") {
    const { data, error: residentError } = await supabaseAdmin
      .from("residents")
      .select("id")
      .ilike("status", "Active");
    if (residentError) throw new Error("recipient_unavailable");
    recipientIds = (data ?? []).map((row) => text(row.id));
  } else if (audience === "selected residents") {
    const { data, error: recipientError } = await supabaseAdmin
      .from("notice_recipients")
      .select("resident_id")
      .eq("notice_id", entityId);
    if (recipientError) throw new Error("recipient_unavailable");
    recipientIds = (data ?? []).map((row) => text(row.resident_id));
  } else if (audience === "specific resident" && notice.resident_id) {
    recipientIds = [text(notice.resident_id)];
  } else if (audience === "specific room" && notice.room_id) {
    const { data, error: admissionError } = await supabaseAdmin
      .from("admissions")
      .select("resident_id")
      .eq("room_id", notice.room_id)
      .eq("status", "Active");
    if (admissionError) throw new Error("recipient_unavailable");
    recipientIds = (data ?? []).map((row) => text(row.resident_id));
  }

  if (requestedRecipientIds.length) {
    const requested = new Set(requestedRecipientIds);
    recipientIds = recipientIds.filter((id) => requested.has(id));
  }
  recipientIds = [...new Set(recipientIds.filter(Boolean))];
  if (!recipientIds.length) throw new Error("recipient_unavailable");

  const { data: residents, error: residentError } = await supabaseAdmin
    .from("residents")
    .select("id, full_name, email, phone, status")
    .in("id", recipientIds);
  if (residentError) throw new Error("recipient_unavailable");

  const summary = text(notice.description).slice(0, 240);
  const published = displayDate(notice.publish_date || notice.created_at);
  return (residents ?? [])
    .filter((resident) => normalized(resident.status) !== "archived")
    .map((resident) => {
      const event = message(
        "resident_notice_created",
        entityId,
        resident,
        `StayHub notice: ${text(notice.title) || "New notice"}`,
        [
          `Notice: ${text(notice.title) || "New notice"}`,
          summary,
          `Published: ${published}`,
          `View the complete notice: ${portalUrl("/notices")}`,
        ],
        [text(resident.full_name) || "Resident", text(notice.title) || "New notice", summary, published, portalUrl("/notices")],
      );
      return { ...event, eventKey: `resident_notice_created:${entityId}:${text(resident.id)}` };
    });
}

async function resolveLoginDetails(entityId: string) {
  const { data: admission, error } = await supabaseAdmin
    .from("admissions")
    .select("id, resident_id, created_at")
    .eq("id", entityId)
    .maybeSingle();
  if (error || !admission || !recent(admission.created_at)) throw new Error("event_unavailable");
  const resident = await loadResident(text(admission.resident_id));
  const email = text(resident.email).toLowerCase();
  if (!email) throw new Error("recipient_unavailable");

  const configuredSiteUrl = siteUrl() || "http://localhost:3000";
  const options = { redirectTo: `${configuredSiteUrl}/resident-portal/change-password` };
  const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
    type: "recovery",
    email,
    options,
  });
  if (linkError || !linkData.properties?.action_link) throw new Error("setup_link_unavailable");
  const setupLink = linkData.properties.action_link;
  const event = message(
    "resident_login_details_sent",
    entityId,
    resident,
    "Set up your StayHub Resident Portal password",
    [
      `Login email: ${email}`,
      `Set or reset your password securely: ${setupLink}`,
      `After setting your password, sign in at: ${portalUrl()}`,
      "This setup link is private. Do not forward it.",
    ],
    [text(resident.full_name) || "Resident", email, setupLink, portalUrl()],
  );
  return event;
}

async function resolveEvent(eventType: NotificationEventType, entityId: string) {
  if (eventType === "admission_created") return resolveAdmission(entityId);
  if (eventType === "bill_generated") return resolveBill(entityId);
  if (eventType === "contract_approved") return resolveContract(entityId);
  if (eventType === "resident_login_details_sent") return resolveLoginDetails(entityId);
  if (eventType === "receipt_submitted" || eventType === "payment_verified" || eventType === "payment_rejected") {
    return resolveReceipt(eventType, entityId);
  }
  throw new Error("event_unavailable");
}

async function sendEmail(event: EventMessage): Promise<ChannelDelivery> {
  const gmailConfigured = gmailSenderConfigured();
  const apiKey = text(process.env.RESEND_API_KEY);
  const fromAddress = text(process.env.NOTIFICATION_EMAIL_FROM);
  const resendConfigured = Boolean(apiKey && fromAddress);
  const configured = resendConfigured || gmailConfigured;

  if (!event.email) {
    console.info("[notifications:diagnostic] Email delivery.", {
      configured,
      status: "skipped",
      errorMessage: "resident_email_missing",
    });
    return { status: "skipped", providerMessageId: null };
  }

  const html = event.html || `<div style="font-family:Arial,sans-serif;white-space:pre-line">${escapeHtml(event.body)}</div>`;

  if (resendConfigured) {
    const dispatch = await sendTransactionalEmail({
      to: event.email,
      subject: event.subject,
      html,
      text: event.body,
    });

    console.info("[notifications:diagnostic] Email delivery.", {
      configured: true,
      provider: "resend",
      status: dispatch.status,
      errorMessage: dispatch.error,
    });

    if (dispatch.status === "sent" || !gmailConfigured) {
      return {
        status: dispatch.status,
        providerMessageId: dispatch.providerMessageId,
      };
    }
  }

  if (gmailConfigured) {
    try {
      const result = await sendGmailEmail({
        to: event.email,
        subject: event.subject,
        text: event.body,
        html,
      });

      console.info("[notifications:diagnostic] Email delivery.", {
        configured: true,
        provider: "gmail",
        status: "sent",
        errorMessage: null,
      });

      return { status: "sent", providerMessageId: result.messageId };
    } catch (error) {
      console.warn("[notifications:diagnostic] Email delivery.", {
        configured: true,
        provider: "gmail",
        status: "failed",
        errorMessage: safeErrorMessage(error),
      });
      return { status: "failed", providerMessageId: null };
    }
  }

  console.info("[notifications:diagnostic] Email delivery.", {
    configured: false,
    status: "configuration_required",
    errorMessage: "email_configuration_missing",
  });
  return { status: "configuration_required", providerMessageId: null };
}
async function sendWhatsApp(eventType: NotificationEventType, event: EventMessage): Promise<ChannelDelivery> {
  const token = text(process.env.WHATSAPP_ACCESS_TOKEN);
  const phoneId = text(process.env.WHATSAPP_PHONE_NUMBER_ID);
  const template = text(process.env[templateEnv[eventType]]);
  const configured = Boolean(token && phoneId && template);
  const recipient = normalizePhone(event.phone);
  if (!recipient) {
    console.info("[notifications:diagnostic] WhatsApp delivery.", { configured, status: "skipped", errorMessage: "resident_phone_missing_or_invalid" });
    return { status: "skipped", providerMessageId: null };
  }
  if (!configured) {
    console.info("[notifications:diagnostic] WhatsApp delivery.", { configured, status: "configuration_required", errorMessage: "whatsapp_configuration_missing" });
    return { status: "configuration_required", providerMessageId: null };
  }
  const version = text(process.env.WHATSAPP_API_VERSION) || "v23.0";
  const language = text(process.env.WHATSAPP_TEMPLATE_LANGUAGE_CODE) || "en_US";
  try {
    const response = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: recipient,
        type: "template",
        template: {
          name: template,
          language: { code: language },
          components: [{ type: "body", parameters: event.parameters.map((parameter) => ({ type: "text", text: parameter })) }],
        },
      }),
    });
    const payload = (await response.json().catch(() => null)) as { messages?: Array<{ id?: unknown }>; error?: { message?: unknown } } | null;
    console.info("[notifications:diagnostic] WhatsApp delivery.", {
      configured,
      status: response.ok ? "sent" : "failed",
      errorMessage: response.ok ? null : text(payload?.error?.message) || `whatsapp_http_${response.status}`,
    });
    return {
      status: response.ok ? "sent" : "failed",
      providerMessageId: response.ok ? text(payload?.messages?.[0]?.id) || null : null,
    };
  } catch (error) {
    console.warn("[notifications:diagnostic] WhatsApp delivery.", { configured, status: "failed", errorMessage: safeErrorMessage(error) });
    return { status: "failed", providerMessageId: null };
  }
}

async function sendSms(event: EventMessage): Promise<ChannelDelivery> {
  const delivery: ChannelDelivery = event.phone
    ? { status: "configuration_required", providerMessageId: null }
    : { status: "skipped", providerMessageId: null };
  console.info("[notifications:diagnostic] SMS delivery.", {
    configured: false,
    status: delivery.status,
    errorMessage: event.phone ? "sms_provider_not_implemented" : "resident_phone_missing",
  });
  return delivery;
}

function publicResult(emailStatus: ChannelStatus, whatsappStatus: ChannelStatus, smsStatus: ChannelStatus = "skipped"): NotificationRequestResult {
  const statuses = [emailStatus, whatsappStatus, smsStatus];
  return {
    delivered: statuses.includes("sent"),
    configurationRequired: statuses.includes("configuration_required"),
    warning:
      statuses.includes("failed") ||
      statuses.includes("configuration_required") ||
      statuses.every((status) => status === "skipped"),
  };
}

export async function notifyResidentEvent(
  eventType: NotificationEventType,
  entityId: string,
  options: NotificationRequestOptions = {},
): Promise<NotificationRequestResult> {
  try {
    const channels = [...new Set(options.channels?.length ? options.channels : defaultChannels)];
    console.info("[notifications:diagnostic] Requested channels.", { eventType, channels });
    const events = eventType === "resident_notice_created"
      ? await resolveNotice(entityId, options.recipientIds ?? [])
      : [await resolveEvent(eventType, entityId)];
    const results: NotificationRequestResult[] = [];

    for (const event of events) {
    const insert = await supabaseAdmin.from("notification_deliveries").insert({
      event_key: event.eventKey,
      event_type: eventType,
      entity_id: entityId,
      resident_id: event.residentId,
      requested_channels: channels,
      status: "processing",
    }).select("id, email_status, whatsapp_status, sms_status, email_provider_message_id, whatsapp_provider_message_id, sms_provider_message_id, status, attempt_count").single();

    let delivery = insert.data;
    if (insert.error?.code === "23505") {
      const existing = await supabaseAdmin.from("notification_deliveries")
        .select("id, email_status, whatsapp_status, sms_status, email_provider_message_id, whatsapp_provider_message_id, sms_provider_message_id, status, attempt_count")
        .eq("event_key", event.eventKey)
        .maybeSingle();
      if (existing.error || !existing.data) throw new Error("ledger_unavailable");
      delivery = existing.data;
      const emailAlreadySent = !channels.includes("email") || delivery.email_status === "sent";
      if (delivery.status === "processing" || (delivery.status === "complete" && emailAlreadySent)) {
        results.push(publicResult(delivery.email_status as ChannelStatus, delivery.whatsapp_status as ChannelStatus, delivery.sms_status as ChannelStatus));
        continue;
      }
      const { data: reclaimed } = await supabaseAdmin
        .from("notification_deliveries")
        .update({
          status: "processing",
          attempt_count: Number(delivery.attempt_count ?? 1) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq("id", delivery.id)
        .eq("status", delivery.status)
        .select("id")
        .maybeSingle();
      if (!reclaimed) {
        results.push(publicResult(
          delivery.email_status as ChannelStatus,
          delivery.whatsapp_status as ChannelStatus,
          delivery.sms_status as ChannelStatus,
        ));
        continue;
      }
    } else if (insert.error || !delivery) {
      throw new Error("ledger_unavailable");
    }

    const priorEmail = delivery.email_status as ChannelStatus | null;
    const priorWhatsApp = delivery.whatsapp_status as ChannelStatus | null;
    const priorSms = delivery.sms_status as ChannelStatus | null;
    const emailDelivery = channels.includes("email")
      ? priorEmail === "sent" ? { status: priorEmail, providerMessageId: text(delivery.email_provider_message_id) || null } : await sendEmail(event)
      : { status: "skipped" as const, providerMessageId: null };
    const whatsappDelivery = channels.includes("whatsapp")
      ? priorWhatsApp === "sent" || priorWhatsApp === "skipped" ? { status: priorWhatsApp, providerMessageId: text(delivery.whatsapp_provider_message_id) || null } : await sendWhatsApp(eventType, event)
      : { status: "skipped" as const, providerMessageId: null };
    const smsDelivery = channels.includes("sms")
      ? priorSms === "sent" || priorSms === "skipped" ? { status: priorSms, providerMessageId: text(delivery.sms_provider_message_id) || null } : await sendSms(event)
      : { status: "skipped" as const, providerMessageId: null };
    const result = publicResult(emailDelivery.status, whatsappDelivery.status, smsDelivery.status);
    console.info("[notifications:diagnostic] Delivery statuses.", {
      eventType,
      emailStatus: emailDelivery.status,
      whatsappStatus: whatsappDelivery.status,
      smsStatus: smsDelivery.status,
    });
    const complete = [emailDelivery.status, whatsappDelivery.status, smsDelivery.status].every((status) => status === "sent" || status === "skipped");

    await supabaseAdmin.from("notification_deliveries").update({
      email_status: emailDelivery.status,
      whatsapp_status: whatsappDelivery.status,
      sms_status: smsDelivery.status,
      email_provider_message_id: emailDelivery.providerMessageId,
      whatsapp_provider_message_id: whatsappDelivery.providerMessageId,
      sms_provider_message_id: smsDelivery.providerMessageId,
      status: complete ? "complete" : result.delivered ? "partial" : result.configurationRequired ? "configuration_required" : "failed",
      last_error_code: result.warning ? "notification_delivery_incomplete" : null,
      completed_at: complete ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    }).eq("id", delivery.id);

    if (result.warning) {
      console.warn("[notifications] Delivery incomplete.", { eventType, emailStatus: emailDelivery.status, whatsappStatus: whatsappDelivery.status, smsStatus: smsDelivery.status });
    }
    results.push(result);
    }

    const deliveredCount = results.filter((result) => result.delivered).length;
    return {
      delivered: deliveredCount > 0,
      deliveredCount,
      recipientCount: results.length,
      configurationRequired: results.some((result) => result.configurationRequired),
      warning: results.some((result) => result.warning),
    };
  } catch (error) {
    console.warn("[notifications] Event notification could not be completed.", { eventType, errorMessage: safeErrorMessage(error) });
    return { delivered: false, configurationRequired: false, warning: true };
  }
}
