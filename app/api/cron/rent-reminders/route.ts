import { timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { emailSenderConfigured, sendTransactionalEmail } from "@/lib/email/resendClient";
import { runRentReminders, type RentReminder } from "@/lib/rentReminder";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const provided = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  if (!secret || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!emailSenderConfigured()) return Response.json({ error: "Email configuration required" }, { status: 503 });
  try {
    const result = await runRentReminders({
      async claim() {
        const { data, error } = await supabaseAdmin.rpc("claim_daily_rent_reminder");
        if (error) throw new Error("Reminder claim failed");
        return data as RentReminder | null;
      },
      send: sendTransactionalEmail,
      async complete(id, status, providerMessageId) {
        const { error } = await supabaseAdmin.from("rent_reminder_deliveries").update({
          status, provider_message_id: providerMessageId, completed_at: new Date().toISOString(),
        }).eq("id", id).eq("status", "claimed");
        if (error) throw new Error("Reminder completion failed");
      },
    });
    return Response.json(result, { status: result.budgetReached ? 503 : 200 });
  } catch {
    return Response.json({ error: "Reminder run failed; claimed deliveries retained to prevent duplicates" }, { status: 500 });
  }
}
