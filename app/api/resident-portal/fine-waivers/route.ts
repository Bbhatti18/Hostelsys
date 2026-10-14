import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizeIdentityEmail } from "@/lib/identity";
import {
  getResidentWaiverRequests,
  createWaiverRequest,
} from "@/lib/fineWaivers";

function bearerToken(request: NextRequest) {
  const header = request.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

function jsonError(message: string, status: number) {
  return NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}

async function getAuthenticatedResident(request: NextRequest) {
  const token = bearerToken(request);
  if (!token) return { resident: null, error: "Please sign in to access the resident portal." };

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return { resident: null, error: "Resident portal configuration is incomplete." };
  }

  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await authClient.auth.getUser(token);
  const email = authData.user?.email?.trim().toLowerCase() ?? "";

  if (authError || !authData.user || !email) {
    return { resident: null, error: "Please sign in to access the resident portal." };
  }

  const { data: resident, error: resError } = await supabaseAdmin
    .from("residents")
    .select("id, email, full_name, status")
    .eq("email", normalizeIdentityEmail(email))
    .maybeSingle();

  if (resError || !resident || String(resident.status).toLowerCase() === "archived") {
    return { resident: null, error: "Your resident profile could not be verified." };
  }

  return { resident, error: null };
}

export async function GET(request: NextRequest) {
  try {
    const { resident, error } = await getAuthenticatedResident(request);
    if (!resident) return jsonError(error ?? "Unauthorized", 401);

    const requests = await getResidentWaiverRequests(resident.id);
    return NextResponse.json(
      { requests },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to load fine waiver requests.";
    return jsonError(message, 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { resident, error } = await getAuthenticatedResident(request);
    if (!resident) return jsonError(error ?? "Unauthorized", 401);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return jsonError("Invalid request body.", 400);
    }

    const { billId, fineAmount, requestedAmount, reason } = body;
    if (!billId || typeof billId !== "string") {
      return jsonError("Bill ID is required.", 400);
    }
    if (typeof fineAmount !== "number" || fineAmount <= 0) {
      return jsonError("A valid fine amount is required.", 400);
    }
    if (!reason || typeof reason !== "string" || !reason.trim()) {
      return jsonError("Please provide an explanation/reason for the waiver request.", 400);
    }

    // Verify bill belongs to resident
    const { data: bill, error: billError } = await supabaseAdmin
      .from("bills")
      .select("id, resident_id, due_date, bill_status")
      .eq("id", billId)
      .eq("resident_id", resident.id)
      .maybeSingle();

    if (billError || !bill) {
      return jsonError("Bill not found or does not belong to your account.", 404);
    }

    const result = await createWaiverRequest({
      residentId: resident.id,
      billId,
      fineAmount,
      requestedAmount: Number(requestedAmount) || fineAmount,
      reason: reason.trim(),
    });

    if (result.error) {
      return jsonError(result.error, 400);
    }

    return NextResponse.json(
      { success: true, request: result.data },
      { status: 201, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to submit fine waiver request.";
    return jsonError(message, 500);
  }
}
