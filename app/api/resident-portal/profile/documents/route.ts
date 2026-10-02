import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { profileDocumentActor } from "@/lib/profileDocumentAccess";
import { documentSlots, profileDocumentError, type DocumentSlot } from "@/lib/profileDocuments";

const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
const bucket = "resident-documents";

export async function GET(request: NextRequest) {
  try {
    const actor = await profileDocumentActor(request, request.nextUrl.searchParams.get("residentId"));
    if (!actor) return reply({ error: "Document access denied." }, 403);
    const [resident, completion, documents] = await Promise.all([
      supabaseAdmin.from("residents").select("photo_url,id_card_url").eq("id", actor.residentId).single(),
      supabaseAdmin.from("resident_profile_completions").select("submitted_at").eq("resident_id", actor.residentId).maybeSingle(),
      supabaseAdmin.from("resident_profile_documents").select("slot,storage_path,source,content_type").eq("resident_id", actor.residentId),
    ]);
    if (resident.error || completion.error || documents.error) return reply({ error: "Unable to load documents." }, 500);
    const locked = Boolean(completion.data?.submitted_at);
    const entries = await Promise.all(documentSlots.map(async slot => {
      const doc = documents.data?.find(d => d.slot === slot);
      const legacy = slot === "photo" ? resident.data.photo_url : slot === "resident_front" ? resident.data.id_card_url : null;
      const authoritative = Boolean(legacy?.trim()) || doc?.source === "staff";
      let url: string | null = null;
      // The same database resolver governs previews and final submission.
      // It never fetches external URLs or rewrites the stored legacy value.
      if (legacy && legacy !== doc?.storage_path) {
        const resolved = await supabaseAdmin.rpc("resolve_profile_legacy_document", { p_resident_id: actor.residentId, p_slot: slot });
        if (resolved.error) throw new Error("Unable to validate recorded document.");
        if (resolved.data?.kind === "data") url = resolved.data.url;
        else if (resolved.data?.kind === "storage") {
          const signed = await supabaseAdmin.storage.from(resolved.data.bucket).createSignedUrl(resolved.data.path, 60);
          if (signed.error) throw new Error("Unable to sign recorded document.");
          url = signed.data.signedUrl;
        }
      } else if (doc) {
        const signed = await supabaseAdmin.storage.from(bucket).createSignedUrl(doc.storage_path, 60);
        if (signed.error) throw new Error("Unable to sign document.");
        url = signed.data.signedUrl;
      }
      return { slot, url, recorded: Boolean(legacy || doc), needsReview: Boolean((legacy || doc) && !url), editable: actor.staff || (!locked && !authoritative) };
    }));
    return reply({ documents: entries, locked });
  } catch { return reply({ error: "Unable to load private documents." }, 500); }
}

export async function POST(request: NextRequest) {
  try {
    const actor = await profileDocumentActor(request, request.nextUrl.searchParams.get("residentId"));
    if (!actor) return reply({ error: "Document access denied." }, 403);
    const form = await request.formData();
    const slot = String(form.get("slot") || "") as DocumentSlot;
    const file = form.get("file");
    if (!(file instanceof File)) return reply({ error: "Choose a file." }, 400);
    let invalid = profileDocumentError(slot, file.type, file.size);
    if (invalid) return reply({ error: invalid }, 400);
    // Check before upload, and again under the resident row lock in the RPC.
    const [resident, completion, current] = await Promise.all([
      supabaseAdmin.from("residents").select("photo_url,id_card_url").eq("id", actor.residentId).single(),
      supabaseAdmin.from("resident_profile_completions").select("submitted_at").eq("resident_id", actor.residentId).maybeSingle(),
      supabaseAdmin.from("resident_profile_documents").select("source").eq("resident_id", actor.residentId).eq("slot", slot).maybeSingle(),
    ]);
    if (resident.error || completion.error || current.error) return reply({ error: "Unable to check document permissions." }, 500);
    const legacy = slot === "photo" ? resident.data.photo_url : slot === "resident_front" ? resident.data.id_card_url : null;
    if (!actor.staff && (completion.data?.submitted_at || current.data?.source === "staff" || legacy?.trim())) return reply({ error: "Document is locked or recorded by staff." }, 409);
    const bytes = new Uint8Array(await file.arrayBuffer());
    invalid = profileDocumentError(slot, file.type, file.size, bytes);
    if (invalid) return reply({ error: invalid }, 400);
    const extension = file.type === "application/pdf" ? "pdf" : file.type === "image/jpeg" ? "jpg" : file.type.split("/")[1];
    const path = `${actor.residentId}/${slot}/${crypto.randomUUID()}.${extension}`;
    const uploaded = await supabaseAdmin.storage.from(bucket).upload(path, bytes, { contentType: file.type, upsert: false, cacheControl: "0" });
    if (uploaded.error) return reply({ error: "Unable to upload document." }, 500);
    const registered = await supabaseAdmin.rpc("register_resident_profile_document", { p_resident_id: actor.residentId, p_slot: slot, p_path: path, p_content_type: file.type, p_size: bytes.length, p_actor_email: actor.email });
    // A concurrent submission may win. Its record stays unchanged; an unattached
    // private object is retained, never exposed via metadata or overwritten.
    if (registered.error) return reply({ error: registered.error.code === "P0001" ? registered.error.message : "Document could not be attached. Refresh before retrying." }, 409);
    return reply({ saved: true, ...(actor.staff ? { canonicalValue: path } : {}) });
  } catch { return reply({ error: "Unable to upload document." }, 400); }
}
