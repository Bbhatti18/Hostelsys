import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const reply = (data: unknown,status=200) => NextResponse.json(data,{status,headers:{"Cache-Control":"private, no-store"}});
async function actor(request: NextRequest) {
 const token=request.headers.get("authorization")?.replace(/^Bearer\s+/i,"") || "";
 const {data,error}=await supabaseAdmin.auth.getUser(token); if(error || !data.user?.email)throw new Error("Authentication required.");
 const email=data.user.email.trim().toLowerCase();
 const staff=await supabaseAdmin.from("staff_users").select("role,status,permissions").eq("email",email).maybeSingle();
 const role=String(staff.data?.role || "").toLowerCase();
 const allowed=staff.data?.status?.toLowerCase()==="active" && (["admin","super admin"].includes(role) || (role==="accountant" && staff.data?.permissions?.includes("payments")));
 const resident=await supabaseAdmin.from("residents").select("id,status").eq("email",email).maybeSingle();
 const own=resident.data?.status!=="Archived" && (!data.user.user_metadata?.resident_id || data.user.user_metadata.resident_id===resident.data?.id) ? resident.data?.id : null;
 if(!allowed && !own)throw new Error("Access denied.");
 return {email,staff:allowed,residentId:own};
}
export async function GET(request:NextRequest) {
 try {
  const user=await actor(request); let query=supabaseAdmin.from("historical_payment_evidence").select("*,residents(full_name)").order("created_at",{ascending:false});
  if(!user.staff)query=query.eq("resident_id",user.residentId);
  const id=request.nextUrl.searchParams.get("id"); if(id)query=query.eq("id",id);
  const result=await query; if(result.error)return reply({error:result.error.message},400);
  if(id) {
    if(result.data?.length!==1)return reply({error:"Evidence unavailable."},404);
    const signed=await supabaseAdmin.storage.from("payment-receipts").createSignedUrl(result.data[0].receipt_path,60);
    if(signed.error)return reply({error:"Receipt unavailable."},400);
    return reply({url:signed.data.signedUrl});
  }
  return reply({rows:(result.data || []).map(({receipt_path,...row})=>row)});
 } catch {return reply({error:"Evidence access denied."},403);}
}
export async function PATCH(request:NextRequest) {
 try {
  const user=await actor(request);if(!user.staff)return reply({error:"Verifier permission required."},403);
  const body=await request.json();const result=await supabaseAdmin.rpc("review_historical_evidence",{p_id:body.id,p_status:body.status,p_note:body.note,p_actor:user.email});
  return result.error ? reply({error:result.error.message},409) : reply({message:"Evidence reviewed only; no financial effect."});
 } catch {return reply({error:"Evidence review denied."},403);}
}
