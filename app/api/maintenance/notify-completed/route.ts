import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizeIdentityEmail } from "@/lib/identity";
import { sendMaintenanceCompletedNotification } from "@/lib/email/maintenanceCompletedEmail";

function bearerToken(request: NextRequest) {
  const header = request.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
}

function json(body: object, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(request: NextRequest) {
  try {
    const token = bearerToken(request);
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!token || !supabaseUrl || !anonKey) {
      return json({ error: "Your session could not be verified." }, 401);
    }

    const authClient = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await authClient.auth.getUser(token);
    const email = authData.user?.email?.trim().toLowerCase() ?? "";

    if (authError || !email) {
      return json({ error: "Your session could not be verified." }, 401);
    }

    // Verify caller is active staff
    const { data: staff } = await supabaseAdmin
      .from("staff_users")
      .select("role, status")
      .eq("email", normalizeIdentityEmail(email))
      .maybeSingle();

    if (!staff || String(staff.status).toLowerCase() !== "active") {
      return json(
        { error: "You do not have permission to trigger maintenance notifications." },
        403,
      );
    }

    const body = (await request.json().catch(() => null)) as { requestId?: unknown } | null;
    const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";

    if (!requestId) {
      return json({ error: "A valid maintenance requestId is required." }, 400);
    }

    const result = await sendMaintenanceCompletedNotification(requestId);

    return json(result, result.success ? 200 : 500);
  } catch (error) {
    console.error("[maintenance-api] Unexpected error sending completion email.", error);
    return json({ success: false, emailSent: false, error: "Internal server error." }, 500);
  }
}
