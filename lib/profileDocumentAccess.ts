import "server-only";
import type { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizeIdentityEmail } from "@/lib/identity";

export async function profileDocumentActor(request: NextRequest, requestedId?: string | null) {
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user?.email) return null;
  const email = normalizeIdentityEmail(data.user.email);
  if (requestedId) {
    const { data: staff, error: staffError } = await supabaseAdmin.from("staff_users").select("role,status,permissions").eq("email", email).maybeSingle();
    const role = String(staff?.role || "").toLowerCase();
    if (!staffError && String(staff?.status).toLowerCase() === "active" && (["admin", "super admin"].includes(role) || (["manager", "reception"].includes(role) && staff?.permissions?.includes("residents")))) {
      const result = await supabaseAdmin.from("residents").select("id,status").eq("id", requestedId).neq("status", "Archived").maybeSingle();
      return result.error || !result.data ? null : { residentId: result.data.id as string, email, staff: true };
    }
  }
  let query = supabaseAdmin.from("residents").select("id,status").eq("email", email).neq("status", "Archived");
  const mappedId = data.user.user_metadata?.resident_id;
  if (typeof mappedId === "string" && mappedId) query = query.eq("id", mappedId);
  const result = await query.maybeSingle();
  if (result.error || !result.data || (requestedId && requestedId !== result.data.id)) return null;
  return { residentId: result.data.id as string, email, staff: false };
}
