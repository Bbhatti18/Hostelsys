"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { legacyEmergencyContact, profileFields, type EmergencyContact } from "@/lib/residentProfile";
import { portalDocumentSlots } from "@/lib/profileDocuments";
import EmergencyContacts from "./EmergencyContacts";
import ProfileDocuments from "./ProfileDocuments";

type ProfileData = {
  resident: Record<string, string | null>;
  contacts: EmergencyContact[];
  completion: {
    draft: Record<string, string>;
    draft_contacts: EmergencyContact[];
    submitted_at: string | null;
  } | null;
};

export default function ProfileCompletion({
  onSubmitted,
}: {
  onSubmitted?: (resident: Record<string, string | null>) => void;
}) {
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
      method: body ? "POST" : "GET",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${session.session.access_token}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to load profile.");
    return result;
  }

  const load = useCallback(async () => {
    const result: ProfileData = await request();
    setData(result);
    setDetails(result.completion?.draft || {});
    setContacts(result.completion?.draft_contacts || []);
    return result;
  }, []);

  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);

  async function save(submit: boolean) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await request({
        action: submit ? "submit" : "draft",
        confirmed: submit && review,
        details: { resident_identity_type: "CNIC", guardian_identity_type: "CNIC", ...details },
        contacts,
      });
      setReview(false);
      const saved = await load();
      if (submit) onSubmitted?.(saved.resident);
      setMessage(
        submit
          ? "Profile submitted and locked. Contact staff for corrections."
          : "Draft saved. You can return and edit it before submission.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save profile.");
    } finally {
      setBusy(false);
    }
  }

  const locked = Boolean(data?.completion?.submitted_at);

  function fields(keys: string[]) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        {keys.map((key) => {
          const label =
            profileFields.find(([field]) => field === key)?.[1] ||
            (({
              full_name: "Full Name",
              phone: "Phone Number",
              email: "Email",
              resident_code: "Resident Code",
            } as Record<string, string>)[key] || key);

          const existing = data?.resident[key] || "";
          const authoritative = Boolean(existing.trim());
          const immutable = ["full_name", "phone", "email", "resident_code"].includes(key);
          const readOnly = authoritative || immutable || locked || review;

          return (
            <label key={key} className="block space-y-1.5 text-xs font-semibold text-slate-700 sm:text-sm">
              <span className="flex items-center justify-between">
                <span>{label}</span>
                {authoritative && !locked && (
                  <span className="text-[11px] font-normal text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-md">
                    Recorded
                  </span>
                )}
              </span>

              {key.endsWith("_identity_type") ? (
                <select
                  aria-label={label}
                  disabled={readOnly}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50/70 px-3.5 py-2.5 text-xs sm:text-sm font-medium text-slate-800 transition-colors focus:border-indigo-500 focus:bg-white focus:outline-none disabled:bg-slate-100 disabled:text-slate-500 shadow-2xs"
                  value={existing || details[key] || "CNIC"}
                  onChange={(e) => setDetails({ ...details, [key]: e.target.value })}
                >
                  <option value="CNIC">CNIC (National ID)</option>
                  <option value="Passport">Passport</option>
                </select>
              ) : (
                <input
                  type={key === "dob" ? "date" : "text"}
                  maxLength={1000}
                  readOnly={readOnly}
                  className="w-full rounded-xl border border-slate-200 bg-slate-50/50 px-3.5 py-2.5 text-xs sm:text-sm text-slate-800 transition-colors focus:border-indigo-500 focus:bg-white focus:outline-none read-only:bg-slate-100 read-only:text-slate-500 shadow-2xs"
                  value={authoritative || immutable ? existing : details[key] || ""}
                  onChange={(e) => setDetails({ ...details, [key]: e.target.value })}
                />
              )}
            </label>
          );
        })}
      </div>
    );
  }

  return (
    <section className="space-y-6 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 lg:p-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b border-slate-100 pb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 sm:text-2xl">
            {locked ? "Profile Submitted / Locked" : "Complete Your Profile"}
          </h2>
          <p className="mt-1 text-xs sm:text-sm text-slate-500">
            {locked
              ? "Your submitted details are read-only. Staff can make corrections. Submission does not mean identity has been verified."
              : "Details already recorded by staff are read-only. Fill the missing details, add emergency contacts, and review before submitting."}
          </p>
        </div>
        {locked ? (
          <span className="inline-flex items-center gap-1.5 self-start rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-800">
            <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
            </svg>
            Profile Locked
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 self-start rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-800">
            Pending Submission
          </span>
        )}
      </div>

      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-xs sm:text-sm font-medium text-red-700">
          <svg className="h-4 w-4 shrink-0 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="flex-1">{error}</span>
        </div>
      )}

      {message && (
        <div role="status" className="flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-xs sm:text-sm font-medium text-emerald-700">
          <svg className="h-4 w-4 shrink-0 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span className="flex-1">{message}</span>
        </div>
      )}

      {!data && !error && (
        <div className="py-8 text-center text-sm text-slate-500">
          Loading profile details...
        </div>
      )}

      {data && (
        <fieldset disabled={busy || uploading} className="space-y-6">
          {/* Personal Information */}
          <div className="space-y-4">
            <div className="border-b border-slate-100 pb-2">
              <h3 className="text-base font-bold text-slate-900 sm:text-lg">Personal Information</h3>
              <p className="text-xs text-slate-500">Basic resident identity details recorded with hostel administration.</p>
            </div>
            {fields(["resident_code", "full_name", "father_name", "gender", "cnic", "dob", "phone", "email"])}
          </div>

          {/* Guardian Information */}
          <div className="space-y-4">
            <div className="border-b border-slate-100 pb-2">
              <h3 className="text-base font-bold text-slate-900 sm:text-lg">Guardian Information</h3>
              <p className="text-xs text-slate-500">Primary guardian or parent contact and CNIC details.</p>
            </div>
            {fields(["guardian_cnic", "guardian_phone"])}
          </div>

          {/* Emergency Contacts */}
          <div className="space-y-4">
            <div className="border-b border-slate-100 pb-2">
              <h3 className="text-base font-bold text-slate-900 sm:text-lg">Emergency Contacts</h3>
              <p className="text-xs text-slate-500">Individuals to contact in case of an emergency or urgent notice.</p>
            </div>
            <EmergencyContacts contacts={[...legacyEmergencyContact(data.resident), ...data.contacts]} readOnly />
            {!locked && <EmergencyContacts contacts={contacts} onChange={setContacts} readOnly={review} />}
          </div>

          {/* Address & Other Details */}
          <div className="space-y-4">
            <div className="border-b border-slate-100 pb-2">
              <h3 className="text-base font-bold text-slate-900 sm:text-lg">Address &amp; Other Details</h3>
              <p className="text-xs text-slate-500">Permanent residence, occupation, and university/work affiliations.</p>
            </div>
            {fields(["permanent_address", "city", "nationality", "occupation", "company_university"])}
          </div>

          {/* Documents & Photo */}
          <div className="space-y-4">
            <div className="border-b border-slate-100 pb-2">
              <h3 className="text-base font-bold text-slate-900 sm:text-lg">Documents &amp; Photo</h3>
              <p className="text-xs text-slate-500">
                Identity documents and profile photo. CNIC requires both front &amp; back in a single file under 400 KB.
              </p>
            </div>
            {fields(["resident_identity_type", "guardian_identity_type"])}
            <ProfileDocuments
              onBusyChange={setUploading}
              readOnly={locked || review}
              residentType={data.resident.resident_identity_type || details.resident_identity_type || "CNIC"}
              guardianType={data.resident.guardian_identity_type || details.guardian_identity_type || "CNIC"}
              slots={portalDocumentSlots}
            />
          </div>

          {/* Bottom Review / Action Buttons */}
          {!locked && (
            review ? (
              <div className="space-y-4 rounded-2xl border-2 border-amber-300 bg-amber-50/70 p-5 shadow-xs">
                <div>
                  <h3 className="text-base font-bold text-amber-950 sm:text-lg">
                    Confirm Final Submission
                  </h3>
                  <p className="mt-1 text-xs sm:text-sm text-amber-900/90 leading-relaxed">
                    Please carefully review all details and documents above. After final submission, your profile will be locked. You cannot change your identity, guardian details, emergency contacts, or uploaded documents. Contact hostel staff for any subsequent corrections.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setReview(false)}
                    disabled={busy || uploading}
                    className="rounded-xl border border-amber-300 bg-white px-5 py-2.5 text-xs sm:text-sm font-semibold text-amber-900 hover:bg-amber-100/50 transition-colors"
                  >
                    ← Back to edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void save(true)}
                    disabled={busy || uploading}
                    className="rounded-xl bg-indigo-600 px-6 py-2.5 text-xs sm:text-sm font-semibold text-white shadow-xs hover:bg-indigo-700 transition-colors disabled:opacity-50"
                  >
                    {busy ? "Submitting..." : "Confirm Final Submission & Lock"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 sm:p-5">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => void save(false)}
                      disabled={busy || uploading}
                      className="inline-flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-xs sm:text-sm font-semibold text-slate-700 shadow-2xs hover:bg-slate-50 transition-colors disabled:opacity-50"
                    >
                      <svg className="h-4 w-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                      </svg>
                      <span>Save draft</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setError("");
                        setReview(true);
                      }}
                      disabled={busy || uploading}
                      className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-6 py-2.5 text-xs sm:text-sm font-semibold text-white shadow-xs hover:bg-indigo-700 transition-colors disabled:opacity-50"
                    >
                      <span>Review and submit</span>
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                      </svg>
                    </button>
                  </div>
                  <p className="text-xs text-slate-500 sm:text-right max-w-md">
                    Final submission requires resident identity, guardian details, at least one emergency contact, a profile photo and identity documents for resident and guardian.
                  </p>
                </div>
              </div>
            )
          )}
        </fieldset>
      )}
    </section>
  );
}
