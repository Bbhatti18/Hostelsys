"use client";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { documentLabels, documentSlots, profileDocumentError, type DocumentSlot } from "@/lib/profileDocuments";
import { compressProfileImage } from "@/lib/compressProfileImage";

type DocumentEntry = { slot: DocumentSlot; recorded: boolean; needsReview: boolean; editable: boolean; url: string | null };
export default function ProfileDocuments({ residentId, residentType = "CNIC", guardianType = "CNIC", readOnly = false, onSaved, onBusyChange, slots = documentSlots }: {
  residentId?: string; residentType?: string; guardianType?: string; readOnly?: boolean;
  onSaved?: (slot: DocumentSlot, canonicalValue?: string) => void;
  onBusyChange?: (busy: boolean) => void; slots?: readonly DocumentSlot[];
}) {
  const [documents, setDocuments] = useState<DocumentEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ url: string; label: string } | null>(null);
  const request = useCallback(async (body?: FormData) => {
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw new Error("Please sign in to access documents.");
    const response = await fetch(`/api/resident-portal/profile/documents${residentId ? `?residentId=${encodeURIComponent(residentId)}` : ""}`, {
      method: body ? "POST" : "GET", body, cache: "no-store", headers: { Authorization: `Bearer ${data.session.access_token}` },
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to access documents.");
    return result;
  }, [residentId]);
  const load = useCallback(async () => {
    const result = await request(); setDocuments(result.documents); return result.documents as DocumentEntry[];
  }, [request]);
  useEffect(() => { void load().catch(e => setError(e.message)); }, [load]);
  async function upload(slot: DocumentSlot, file?: File) {
    if (!file) return;
    const invalid = profileDocumentError(slot, file.type, file.size);
    if (invalid) { setError(invalid); return; }
    setBusy(true); onBusyChange?.(true); setError(""); setPreview(null);
    try {
      const prepared = await compressProfileImage(file, slot);
      const outputError = profileDocumentError(slot, prepared.type, prepared.size);
      if (outputError) throw new Error(outputError);
      const body = new FormData(); body.set("slot", slot); body.set("file", prepared);
      const result = await request(body);
      onSaved?.(slot, result.canonicalValue);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Upload failed."); }
    finally { setBusy(false); onBusyChange?.(false); }
  }
  async function view(slot: DocumentSlot) {
    setError("");
    try {
      const entry = (await load()).find(doc => doc.slot === slot);
      if (!entry?.url) throw new Error("This existing document needs staff review; it has not been changed.");
      setPreview({ url: entry.url, label: documentLabels[slot] });
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to view document."); }
  }
  return <div className="space-y-4">
    <p className="text-sm text-slate-600">Private uploads, up to 4 MB each. Photos: JPEG, PNG or WebP. Identity documents also accept PDF. Passport identity pages do not require a back image. Uploads are saved immediately; final submission locks resident changes.</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <div className="grid gap-4 md:grid-cols-2">
      {slots.map(slot => {
        const entry = documents.find(doc => doc.slot === slot);
        const optional = (slot === "resident_back" && residentType === "Passport") || (slot === "guardian_back" && guardianType === "Passport");
        return <div key={slot} className="space-y-2 rounded-xl border p-3">
          <p className="font-medium">{documentLabels[slot]} {optional ? "(Optional for Passport)" : "(Required)"}</p>
          <p className="text-sm text-slate-500">{entry?.needsReview ? "Recorded — staff review needed" : entry?.recorded ? "Recorded" : "Not uploaded"}</p>
          {entry?.recorded && <button type="button" className="mr-3 text-sm font-semibold text-indigo-700" onClick={() => void view(slot)}>View document</button>}
          {!readOnly && entry?.editable && <label className="block text-sm">{entry.recorded ? "Replace upload" : "Upload"}<input aria-label={documentLabels[slot]} type="file" disabled={busy} accept={slot === "photo" ? "image/jpeg,image/png,image/webp" : "image/jpeg,image/png,image/webp,application/pdf"} className="mt-2 block w-full text-sm" onChange={e => { void upload(slot, e.target.files?.[0]); e.target.value = ""; }} /></label>}
        </div>;
      })}
    </div>
    {preview && <div className="rounded-xl border bg-slate-50 p-4">
      <button type="button" className="float-right text-sm" onClick={() => setPreview(null)}>Close preview</button>
      <p className="mb-3 font-medium">{preview.label}</p>
      <iframe title={preview.label} src={preview.url} sandbox="" referrerPolicy="no-referrer" className="h-80 w-full rounded-lg border" />
      <p className="mt-2 text-xs text-slate-500">If the private link expires, select View document again.</p>
    </div>}
  </div>;
}
