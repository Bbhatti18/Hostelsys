import "server-only";

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { sendTransactionalEmail } from "@/lib/email/resendClient";

export type MaintenanceCompletedEmailDetails = {
  residentName: string;
  residentEmail: string;
  requestNumber: string;
  title: string;
  category?: string | null;
  priority?: string | null;
  roomNumber?: string | null;
  bedNumber?: string | null;
  complaintDate?: string | null;
  completionDate?: string | null;
  assignedTo?: string | null;
  notes?: string | null;
  portalUrl: string;
  hostelName?: string;
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(value?: string | null) {
  const raw = text(value);
  if (!raw) return "Not recorded";
  const parsed = new Date(raw.length === 10 ? `${raw}T00:00:00Z` : raw);
  return Number.isNaN(parsed.getTime())
    ? raw
    : parsed.toLocaleDateString("en-PK", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
}

function siteUrl() {
  const envUrl = text(
    process.env.NEXT_PUBLIC_SITE_URL ||
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.SITE_URL ||
      "",
  );
  if (envUrl) return envUrl.replace(/\/$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`.replace(/\/$/, "");
  return "http://localhost:3000";
}

export function buildMaintenanceCompletedEmail(details: MaintenanceCompletedEmailDetails) {
  const hostelName =
    details.hostelName?.trim() ||
    process.env.NEXT_PUBLIC_HOSTEL_NAME?.trim() ||
    process.env.NOTIFICATION_EMAIL_FROM_NAME?.trim() ||
    "University Girls Hostel";

  const subject = `${hostelName} — Maintenance Request Resolved (${details.requestNumber})`;
  const reportedLabel = formatDate(details.complaintDate);
  const resolvedLabel = formatDate(details.completionDate);
  const locationLabel = [
    details.roomNumber ? `Room ${details.roomNumber}` : "",
    details.bedNumber ? `Bed ${details.bedNumber}` : "",
  ]
    .filter(Boolean)
    .join(", ");

  const textLines = [
    `Hello ${details.residentName || "Resident"},`,
    "",
    `Your maintenance request has been resolved and marked as Completed by hostel administration.`,
    "",
    `Request Number: ${details.requestNumber}`,
    `Issue: ${details.title}`,
    details.category ? `Category: ${details.category}` : "",
    locationLabel ? `Location: ${locationLabel}` : "",
    `Reported On: ${reportedLabel}`,
    `Completed On: ${resolvedLabel}`,
    details.assignedTo ? `Attended By: ${details.assignedTo}` : "",
    details.notes ? `Resolution Notes: ${details.notes}` : "",
    "",
    `You can review your request details and history in the Resident Portal: ${details.portalUrl}`,
    "",
    `If you have any further questions or if the issue is not fully resolved, please submit a follow-up request via the Resident Portal or visit reception.`,
    "",
    hostelName,
  ].filter((line) => line !== "");

  const textBody = textLines.join("\n");

  const htmlBody = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;box-shadow:0 4px 6px -1px rgba(0,0,0,0.05)">
      <!-- Header -->
      <tr>
        <td style="padding:28px 32px;background:linear-gradient(135deg,#059669 0%,#047857 100%);color:#ffffff">
          <p style="margin:0;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;font-weight:700;opacity:0.9">${escapeHtml(hostelName)}</p>
          <h1 style="margin:8px 0 0;font-size:22px;font-weight:800;letter-spacing:-0.01em">Maintenance Request Resolved</h1>
          <p style="margin:6px 0 0;font-size:14px;opacity:0.95">Request #${escapeHtml(details.requestNumber)} • Completed</p>
        </td>
      </tr>

      <!-- Body Content -->
      <tr>
        <td style="padding:32px">
          <p style="margin:0 0 16px;font-size:15px;font-weight:600;color:#0f172a">
            Hello ${escapeHtml(details.residentName || "Resident")},
          </p>
          <p style="margin:0 0 24px;font-size:14px;color:#475569;line-height:1.6">
            We are pleased to inform you that your maintenance request has been successfully inspected, resolved, and marked as <strong>Completed</strong>.
          </p>

          <!-- Details Card -->
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:20px;margin:0 0 24px">
            <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:14px">
              <tr>
                <td style="padding:6px 0;color:#166534;font-weight:600;width:38%">Request ID:</td>
                <td style="padding:6px 0;color:#0f172a;font-family:monospace;font-weight:700">${escapeHtml(details.requestNumber)}</td>
              </tr>
              <tr>
                <td style="padding:6px 0;color:#166534;font-weight:600">Issue / Title:</td>
                <td style="padding:6px 0;color:#0f172a;font-weight:600">${escapeHtml(details.title)}</td>
              </tr>
              ${
                details.category
                  ? `<tr>
                <td style="padding:6px 0;color:#166534;font-weight:600">Category:</td>
                <td style="padding:6px 0;color:#334155">${escapeHtml(details.category)}</td>
              </tr>`
                  : ""
              }
              ${
                locationLabel
                  ? `<tr>
                <td style="padding:6px 0;color:#166534;font-weight:600">Location:</td>
                <td style="padding:6px 0;color:#334155">${escapeHtml(locationLabel)}</td>
              </tr>`
                  : ""
              }
              <tr>
                <td style="padding:6px 0;color:#166534;font-weight:600">Reported Date:</td>
                <td style="padding:6px 0;color:#334155">${escapeHtml(reportedLabel)}</td>
              </tr>
              <tr>
                <td style="padding:6px 0;color:#166534;font-weight:600">Completion Date:</td>
                <td style="padding:6px 0;color:#15803d;font-weight:700">${escapeHtml(resolvedLabel)}</td>
              </tr>
              ${
                details.assignedTo
                  ? `<tr>
                <td style="padding:6px 0;color:#166534;font-weight:600">Attended By:</td>
                <td style="padding:6px 0;color:#334155">${escapeHtml(details.assignedTo)}</td>
              </tr>`
                  : ""
              }
            </table>

            ${
              details.notes
                ? `<div style="margin-top:16px;padding-top:14px;border-top:1px dashed #86efac">
                <p style="margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:#166534;font-weight:700">Resolution Notes</p>
                <p style="margin:0;font-size:13px;color:#14532d;line-height:1.5;background:#ffffff;padding:10px 14px;border-radius:8px;border:1px solid #dcfce7">
                  ${escapeHtml(details.notes)}
                </p>
              </div>`
                : ""
            }
          </div>

          <!-- Action Button -->
          <div style="margin:28px 0 24px;text-align:center">
            <a href="${escapeHtml(details.portalUrl)}"
               style="display:inline-block;padding:13px 28px;background:#059669;color:#ffffff;font-size:14px;font-weight:700;border-radius:10px;text-decoration:none;box-shadow:0 2px 4px rgba(5,150,105,0.2)">
              View in Resident Portal
            </a>
          </div>

          <p style="margin:0 0 10px;font-size:13px;color:#64748b;line-height:1.6">
            If the issue persists or if you require any additional maintenance assistance, you can reopen or submit a new request anytime from your portal dashboard.
          </p>
        </td>
      </tr>

      <!-- Footer -->
      <tr>
        <td style="padding:20px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;color:#64748b;line-height:1.5">
          This is an automated maintenance resolution notification from <strong>${escapeHtml(hostelName)}</strong>. Please do not reply directly to this email.
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return {
    subject,
    text: textBody,
    html: htmlBody,
    to: details.residentEmail,
  };
}

export type MaintenanceNotificationResult = {
  success: boolean;
  emailSent: boolean;
  recipientEmail?: string;
  provider?: "resend" | "gmail" | null;
  providerMessageId?: string | null;
  error?: string | null;
  reason?: string;
};

/**
 * Loads the maintenance request, identifies the resident, and sends the completion notification email.
 */
export async function sendMaintenanceCompletedNotification(
  requestId: string,
): Promise<MaintenanceNotificationResult> {
  const cleanId = text(requestId);
  if (!cleanId) {
    return { success: false, emailSent: false, error: "Invalid maintenance request ID." };
  }

  // 1. Fetch maintenance request
  const { data: request, error: reqError } = await supabaseAdmin
    .from("maintenance_requests")
    .select(
      "id, request_number, resident_id, admission_id, room_id, bed_id, title, description, category, priority, status, assigned_to, complaint_date, completion_date, completed_at, notes",
    )
    .eq("id", cleanId)
    .maybeSingle();

  if (reqError || !request) {
    console.warn("[maintenance-email] Request not found.", { requestId: cleanId, error: reqError?.message });
    return { success: false, emailSent: false, error: "Maintenance request not found." };
  }

  // Confirm request is completed
  if (text(request.status).toLowerCase() !== "completed") {
    console.info("[maintenance-email] Skipped notification: request status is not Completed.", {
      requestId: cleanId,
      status: request.status,
    });
    return {
      success: true,
      emailSent: false,
      reason: "request_not_completed",
    };
  }

  // 2. Resolve resident ID
  let targetResidentId = text(request.resident_id);
  if (!targetResidentId && request.admission_id) {
    const { data: admission } = await supabaseAdmin
      .from("admissions")
      .select("resident_id")
      .eq("id", request.admission_id)
      .maybeSingle();
    if (admission?.resident_id) {
      targetResidentId = text(admission.resident_id);
    }
  }

  if (!targetResidentId) {
    console.info("[maintenance-email] Skipped notification: no resident associated with this maintenance request.", {
      requestId: cleanId,
    });
    return {
      success: true,
      emailSent: false,
      reason: "no_resident_associated",
    };
  }

  // 3. Fetch resident details
  const { data: resident, error: resError } = await supabaseAdmin
    .from("residents")
    .select("id, full_name, email, status")
    .eq("id", targetResidentId)
    .maybeSingle();

  if (resError || !resident) {
    console.warn("[maintenance-email] Resident record not found.", { residentId: targetResidentId });
    return { success: false, emailSent: false, error: "Resident record not found." };
  }

  const residentEmail = text(resident.email).toLowerCase();
  if (!residentEmail || !residentEmail.includes("@")) {
    console.info("[maintenance-email] Skipped notification: resident has no valid email address.", {
      residentId: targetResidentId,
    });
    return {
      success: true,
      emailSent: false,
      reason: "resident_has_no_email",
    };
  }

  // 4. Optionally fetch room and bed info for friendly display
  let roomNumber: string | null = null;
  let bedNumber: string | null = null;

  if (request.room_id) {
    const { data: room } = await supabaseAdmin
      .from("rooms")
      .select("room_number")
      .eq("id", request.room_id)
      .maybeSingle();
    roomNumber = room?.room_number ?? null;
  }

  if (request.bed_id) {
    const { data: bed } = await supabaseAdmin
      .from("beds")
      .select("bed_number")
      .eq("id", request.bed_id)
      .maybeSingle();
    bedNumber = bed?.bed_number ?? null;
  }

  // 5. Construct email details
  const portalUrl = `${siteUrl()}/resident-portal/maintenance`;
  const emailPayload = buildMaintenanceCompletedEmail({
    residentName: text(resident.full_name) || "Resident",
    residentEmail,
    requestNumber: text(request.request_number) || cleanId,
    title: text(request.title) || "Maintenance Request",
    category: text(request.category) || null,
    priority: text(request.priority) || null,
    roomNumber,
    bedNumber,
    complaintDate: text(request.complaint_date) || null,
    completionDate: text(request.completion_date) || text(request.completed_at)?.slice(0, 10) || null,
    assignedTo: text(request.assigned_to) || null,
    notes: text(request.notes) || null,
    portalUrl,
  });

  // Stable idempotency key
  const completionStamp = text(request.completed_at) || text(request.completion_date) || "done";
  const idempotencyKey = `mnt-completed-${cleanId}-${completionStamp}`;

  // 6. Send transactional email
  console.info("[maintenance-email] Dispatching completion email...", {
    requestId: cleanId,
    to: residentEmail,
    requestNumber: request.request_number,
  });

  const dispatch = await sendTransactionalEmail({
    to: residentEmail,
    subject: emailPayload.subject,
    text: emailPayload.text,
    html: emailPayload.html,
    idempotencyKey,
  });

  if (dispatch.status === "sent") {
    console.info("[maintenance-email] Successfully sent resolution email to resident.", {
      requestId: cleanId,
      to: residentEmail,
      providerMessageId: dispatch.providerMessageId,
    });
    return {
      success: true,
      emailSent: true,
      recipientEmail: residentEmail,
      providerMessageId: dispatch.providerMessageId,
      error: null,
    };
  }

  console.warn("[maintenance-email] Failed or skipped sending completion email.", {
    requestId: cleanId,
    to: residentEmail,
    status: dispatch.status,
    error: dispatch.error,
  });

  return {
    success: true,
    emailSent: false,
    recipientEmail: residentEmail,
    error: dispatch.error,
    reason: dispatch.status,
  };
}
