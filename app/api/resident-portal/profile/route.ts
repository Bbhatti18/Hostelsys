import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { normalizeIdentityEmail } from "@/lib/identity";
import { profileFields } from "@/lib/residentProfile";

const response = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
async function identity(request: NextRequest) {
  const token = request.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user?.email) return null;
  let query = supabaseAdmin.from("residents").select("id").eq("email", normalizeIdentityEmail(data.user.email)).neq("status", "Archived");
  const metadataId = data.user.user_metadata?.resident_id;
  if (typeof metadataId === "string" && metadataId) query = query.eq("id", metadataId);
  const result = await query.maybeSingle();
  return result.error ? null : result.data?.id;
}
export async function GET(request: NextRequest) {
  try {
    const id = await identity(request);
    if (!id) return response({ error: "Please sign in with your resident account." }, 403);
    const [resident, completion, contacts] = await Promise.all([
      supabaseAdmin.from("residents").select(["id", "full_name", "resident_code", "phone", "email", "emergency_contact", "emergency_contact_name", "emergency_contact_relationship", ...profileFields.map(([key]) => key)].join(",")).eq("id", id).single(),
      supabaseAdmin.from("resident_profile_completions").select("draft,draft_contacts,submitted_at").eq("resident_id", id).maybeSingle(),
      supabaseAdmin.from("resident_emergency_contacts").select("id,contact_name,relationship,phone").eq("resident_id", id).order("created_at"),
    ]);
    if (resident.error || completion.error || contacts.error) return response({ error: "Unable to load profile completion. Please contact staff." }, 500);
    return response({ resident: resident.data, completion: completion.data, contacts: contacts.data });
  } catch { return response({ error: "Unable to load profile." }, 500); }
}
export async function POST(request: NextRequest) {
  try {
    const id = await identity(request);
    if (!id) return response({ error: "Please sign in with your resident account." }, 403);
    const body = await request.json();
    if (!body || !["draft", "submit"].includes(body.action) || (body.action === "submit" && body.confirmed !== true)) return response({ error: "Confirm your final submission first." }, 400);
    const { error } = await supabaseAdmin.rpc("save_resident_profile_completion", { p_resident_id: id, p_details: body.details, p_contacts: body.contacts, p_submit: body.action === "submit" });
    if (error) return response({ error: error.code === "23505" ? "This CNIC / Passport is already recorded. Please contact staff." : error.code === "P0001" ? error.message : "Unable to save profile. Check the entered details." }, 400);
    return response({ saved: true });
  } catch { return response({ error: "Unable to save profile." }, 400); }
}
