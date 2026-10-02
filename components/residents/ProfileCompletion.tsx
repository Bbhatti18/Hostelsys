"use client";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { legacyEmergencyContact, profileFields, type EmergencyContact } from "@/lib/residentProfile";
import EmergencyContacts from "./EmergencyContacts";
import ProfileDocuments from "./ProfileDocuments";

type ProfileData = { resident: Record<string, string | null>; contacts: EmergencyContact[]; completion: { draft: Record<string, string>; draft_contacts: EmergencyContact[]; submitted_at: string | null } | null };
export default function ProfileCompletion({ onSubmitted }: { onSubmitted?: (resident: Record<string, string | null>) => void }) {
  const [data, setData] = useState<ProfileData | null>(null);
  const [details, setDetails] = useState<Record<string, string>>({});
  const [contacts, setContacts] = useState<EmergencyContact[]>([]);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function request(body?: unknown) {
    const { data: session } = await supabase.auth.getSession();
    if (!session.session) throw new Error("Please sign in to complete your profile.");
    const response = await fetch("/api/resident-portal/profile", {
      method: body ? "POST" : "GET", cache: "no-store",
      headers: { Authorization: `Bearer ${session.session.access_token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to load profile.");
    return result;
  }
  const load = useCallback(async () => {
    const result: ProfileData = await request();
    setData(result); setDetails(result.completion?.draft || {}); setContacts(result.completion?.draft_contacts || []);
    return result;
  }, []);
  useEffect(() => { void load().catch(e => setError(e.message)); }, [load]);
  async function save(submit: boolean) {
    setBusy(true); setError(""); setMessage("");
    try {
      await request({ action: submit ? "submit" : "draft", confirmed: submit && review, details: { resident_identity_type: "CNIC", guardian_identity_type: "CNIC", ...details }, contacts });
      setReview(false);
      const saved = await load();
      if (submit) onSubmitted?.(saved.resident);
      setMessage(submit ? "Profile submitted and locked. Contact staff for corrections." : "Draft saved. You can return and edit it before submission.");
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to save profile."); }
    finally { setBusy(false); }
  }
  const locked = Boolean(data?.completion?.submitted_at);
  function fields(keys: string[]) {
    return <div className="grid gap-4 sm:grid-cols-2">{keys.map(key => {
      const label = profileFields.find(([field]) => field === key)?.[1] || ({ full_name: "Full Name", phone: "Phone Number", email: "Email", resident_code: "Resident Code" } as Record<string,string>)[key];
      const existing = data?.resident[key] || "";
      const authoritative = Boolean(existing.trim());
      const immutable = ["full_name", "phone", "email", "resident_code"].includes(key);
      const readOnly = authoritative || immutable || locked || review;
      return <label key={key} className="text-sm font-medium">{label}{authoritative && !locked ? " (Recorded)" : ""}
        {key.endsWith("_identity_type") ? <select aria-label={label} disabled={readOnly} className="mt-1 w-full rounded-lg border p-2 disabled:bg-slate-100" value={existing || details[key] || "CNIC"} onChange={e => setDetails({ ...details, [key]: e.target.value })}><option>CNIC</option><option>Passport</option></select> :
          <input type={key === "dob" ? "date" : "text"} maxLength={1000} readOnly={readOnly} className="mt-1 w-full rounded-lg border p-2 read-only:bg-slate-100" value={authoritative || immutable ? existing : details[key] || ""} onChange={e => setDetails({ ...details, [key]: e.target.value })} />}
      </label>;
    })}</div>;
  }
  return <section className="space-y-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
    <h2 className="text-xl font-bold">{locked ? "Profile Submitted / Locked" : "Complete Your Profile"}</h2>
    <p className="text-sm text-slate-600">{locked ? "Your submitted details are read-only. Staff can make corrections. Submission does not mean identity has been verified." : "Details already recorded by staff are read-only. Fill the missing details, add emergency contacts, and review before submitting."}</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {message && <p role="status" className="text-sm text-emerald-700">{message}</p>}
    {!data && !error && <p>Loading profile...</p>}
    {data && <>
      <fieldset disabled={busy || uploading} className="space-y-4">
        <h3 className="text-lg font-semibold">Personal Information</h3>
        {fields(["resident_code", "full_name", "father_name", "gender", "cnic", "dob", "phone", "email"])}
        <h3 className="text-lg font-semibold">Guardian Information</h3>
        {fields(["guardian_cnic", "guardian_phone"])}
        <h3 className="text-lg font-semibold">Emergency Contacts</h3>
        <EmergencyContacts contacts={[...legacyEmergencyContact(data.resident), ...data.contacts]} readOnly />
        {!locked && <EmergencyContacts contacts={contacts} onChange={setContacts} readOnly={review} />}
        <h3 className="text-lg font-semibold">Address &amp; Other Details</h3>
        {fields(["permanent_address", "city", "nationality", "occupation", "company_university"])}
        <h3 className="text-lg font-semibold">Documents &amp; Photo</h3>
        {fields(["resident_identity_type", "guardian_identity_type"])}
        <ProfileDocuments onBusyChange={setUploading} readOnly={locked || review} residentType={data.resident.resident_identity_type || details.resident_identity_type || "CNIC"} guardianType={data.resident.guardian_identity_type || details.guardian_identity_type || "CNIC"} />
        {!locked && (review ? <div className="space-y-3 rounded-xl bg-amber-50 p-4">
          <h3 className="text-lg font-semibold">Review</h3>
          <p className="font-semibold">Review the details and documents above. After final submission, you cannot change your identity, guardian details, emergency contacts, documents or photo. Contact staff for corrections.</p>
          <button type="button" onClick={() => setReview(false)} className="mr-3 rounded-lg border px-4 py-2">Back to edit</button>
          <button type="button" onClick={() => void save(true)} className="rounded-lg bg-indigo-600 px-4 py-2 text-white">Confirm final submission</button>
        </div> : <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => void save(false)} className="rounded-lg border px-4 py-2">Save draft</button>
          <button type="button" onClick={() => { setError(""); setReview(true); }} className="rounded-lg bg-indigo-600 px-4 py-2 text-white">Review and submit</button>
          <p className="w-full text-sm text-slate-500">Final submission requires resident identity, guardian details, a contact with name, relationship and phone, a profile photo and identity documents for resident and guardian.</p>
        </div>)}
      </fieldset>
    </>}
  </section>;
}
