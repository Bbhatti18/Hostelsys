"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { uploadContractAgreement } from "@/lib/contractStorage";
import { normalizeBedLabel } from "@/lib/bedLabels";
import { supabase } from "@/lib/supabase";
import { getSupabaseErrorMessage } from "@/lib/supabaseErrors";

type Resident = { id: string; full_name: string; status: string | null };
type Admission = {
  id: string;
  resident_id: string;
  room_id: string | null;
  bed_id: string | null;
  admission_date: string;
  expected_leaving_date: string | null;
  monthly_rent: number;
  security_deposit: number;
  notice_period_days: number;
  status: string;
};
type ContractTemplate = { id: string; title: string; content: string };
type Room = { id: string; room_number: string };
type Bed = { id: string; bed_number: string };

function makeContractNumber() {
  return `CNT-${new Date().getFullYear()}-${Date.now().toString().slice(-8)}`;
}

function money(value: number) {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(value || 0);
}

export default function AddContractPage() {
  const router = useRouter();
  const [residents, setResidents] = useState<Resident[]>([]);
  const [admissions, setAdmissions] = useState<Admission[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [beds, setBeds] = useState<Bed[]>([]);
  const [activeTemplate, setActiveTemplate] = useState<ContractTemplate | null>(null);
  const [templateMessage, setTemplateMessage] = useState("");
  const [admissionId, setAdmissionId] = useState("");
  const [endDate, setEndDate] = useState("");
  const [notes, setNotes] = useState("");
  const [agreementFile, setAgreementFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    async function loadPageData() {
      const [residentResult, admissionResult, contractResult, templateResult, roomResult, bedResult] = await Promise.all([
        supabase.from("residents").select("id, full_name, status").order("full_name"),
        supabase
          .from("admissions")
          .select("id, resident_id, room_id, bed_id, admission_date, expected_leaving_date, monthly_rent, security_deposit, notice_period_days, status")
          .eq("status", "Pending")
          .order("created_at", { ascending: false }),
        supabase.from("contracts").select("id, admission_id, status"),
        supabase.from("contract_templates").select("id, title, content").eq("is_active", true).order("created_at", { ascending: false }),
        supabase.from("rooms").select("id, room_number"),
        supabase.from("beds").select("id, bed_number"),
      ]);

      if (!active) return;
      const firstError = residentResult.error || admissionResult.error || contractResult.error || templateResult.error || roomResult.error || bedResult.error;
      if (firstError) {
        setMessage(getSupabaseErrorMessage(firstError, "Unable to load contract form data. Please try again."));
      }

      const existingAdmissionIds = new Set(
        (contractResult.data ?? [])
          .filter((item) => (item.status) !== "Cancelled")
          .map((item) => item.admission_id)
          .filter(Boolean),
      );
      const residentRows = (residentResult.data ?? []) as Resident[];
      setResidents(residentRows);
      setAdmissions(
        ((admissionResult.data ?? []) as Admission[]).filter(
          (admission) =>
            !existingAdmissionIds.has(admission.id) &&
            residentRows.find((resident) => resident.id === admission.resident_id)?.status !== "Archived",
        ),
      );
      setRooms((roomResult.data ?? []) as Room[]);
      setBeds((bedResult.data ?? []) as Bed[]);
      const activeTemplates = (templateResult.data ?? []) as unknown as ContractTemplate[];
      if (templateResult.error) {
        setActiveTemplate(null);
        setTemplateMessage("The active contract template could not be verified. Please try again.");
      } else if (activeTemplates.length > 0) {
        const standardChoice =
          activeTemplates.find((t) => t.title?.toLowerCase().includes("standard")) ||
          activeTemplates[0];

        if (standardChoice && standardChoice.content?.trim()) {
          setActiveTemplate(standardChoice);
          setTemplateMessage("");
        } else {
          setActiveTemplate(null);
          setTemplateMessage("The standard contract template has no terms configured. Please update the Standard Residency Contract from the Contracts page.");
        }
      } else {
        setActiveTemplate(null);
        setTemplateMessage("No active contract template is available. Please set the Standard Residency Contract from the Contracts page.");
      }
      setLoading(false);
    }
    void loadPageData();
    return () => { active = false; };
  }, []);

  const admission = useMemo(
    () => admissions.find((item) => item.id === admissionId) ?? null,
    [admissionId, admissions],
  );
  const resident = residents.find((item) => item.id === admission?.resident_id);
  const room = rooms.find((item) => item.id === admission?.room_id);
  const bed = beds.find((item) => item.id === admission?.bed_id);

  function selectAdmission(value: string) {
    setAdmissionId(value);
    setEndDate(admissions.find((item) => item.id === value)?.expected_leaving_date ?? "");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage("");

    if (!admission || !resident) {
      setMessage("Select a Pending admission before creating the contract.");
      setSaving(false);
      return;
    }
    if (!activeTemplate?.content.trim()) {
      setMessage(templateMessage || "No active contract template is available. Please activate the standard contract template first.");
      setSaving(false);
      return;
    }
    if (endDate && new Date(endDate) <= new Date(admission.admission_date)) {
      setMessage("End date must be later than the admission date.");
      setSaving(false);
      return;
    }

    const [residentResult, admissionResult, duplicateResult] = await Promise.all([
      supabase.from("residents").select("id, status").eq("id", admission.resident_id).maybeSingle(),
      supabase
        .from("admissions")
        .select("id, resident_id, room_id, bed_id, admission_date, monthly_rent, security_deposit, notice_period_days, status")
        .eq("id", admission.id)
        .maybeSingle(),
      supabase.from("contracts").select("id, status").eq("admission_id", admission.id),
    ]);
    const validationError = residentResult.error || admissionResult.error || duplicateResult.error;
    if (validationError) {
      setMessage(getSupabaseErrorMessage(validationError, "Unable to verify the admission before creating the contract."));
      setSaving(false);
      return;
    }
    const currentAdmission = admissionResult.data;
    if (!residentResult.data || residentResult.data.status === "Archived") {
      setMessage("The admission resident is no longer eligible for a contract.");
      setSaving(false);
      return;
    }
    if (!currentAdmission || currentAdmission.status !== "Pending" || currentAdmission.resident_id !== admission.resident_id) {
      setMessage("The selected admission is no longer Pending. Refresh and try again.");
      setSaving(false);
      return;
    }
    if ((duplicateResult.data ?? []).some((item) => (item.status) !== "Cancelled")) {
      setMessage("A contract already exists for this admission.");
      setSaving(false);
      return;
    }

    const now = new Date().toISOString();
    const specialClauses = notes.trim();
    const termsSnapshot = `${activeTemplate.content.trim()}${
      specialClauses ? `\n\nSpecial Clauses:\n${specialClauses}` : ""
    }`;
    const { data: contractData, error: contractError } = await supabase
      .from("contracts")
      .insert({
        contract_number: makeContractNumber(),
        resident_id: currentAdmission.resident_id,
        admission_id: currentAdmission.id,
        room_id: currentAdmission.room_id,
        bed_id: currentAdmission.bed_id,
        template_id: activeTemplate.id,
        contract_content: termsSnapshot,
        start_date: currentAdmission.admission_date,
        end_date: endDate || null,
        monthly_rent: Number(currentAdmission.monthly_rent) || 0,
        security_deposit: Number(currentAdmission.security_deposit) || 0,
        notice_period_days: Number(currentAdmission.notice_period_days) || 30,
        status: "Pending Signature",
        resident_signature_status: "Pending",
        owner_signature_status: "Signed",
        owner_signature_name: "Hostel Administration",
        signed_by_resident: false,
        signed_at: null,
        notes: notes.trim() || null,
        created_at: now,
        updated_at: now,
      })
      .select("id")
      .single();

    if (contractError || !contractData) {
      setMessage(`DB Error: ${contractError?.message} || Unable to save the contract.`);
      setSaving(false);
      return;
    }

    if (agreementFile) {
      try {
        await uploadContractAgreement(String(contractData.id), agreementFile);
      } catch (agreementError) {
        setMessage(agreementError instanceof Error ? `Contract created, but ${agreementError.message.toLowerCase()}` : "Contract created, but the agreement PDF could not be uploaded.");
        setSaving(false);
        return;
      }
    }

    router.push(`/contracts/${contractData.id}`);
    router.refresh();
  }

  return (
    <main className="min-h-screen bg-gray-50 p-4 sm:p-6">
      <div className="mx-auto max-w-4xl rounded-xl bg-white p-4 shadow sm:p-6">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">University Girls Hostel</p>
        <h1 className="mt-2 text-2xl font-bold text-gray-800">Prepare Contract</h1>
        <p className="mt-1 text-sm text-gray-500">Admission details are authoritative. The resident signs later in their portal.</p>

        {message && <div className="mt-5 rounded-lg bg-red-50 p-3 text-sm text-red-700">{message}</div>}
        {!loading && !activeTemplate && <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">{templateMessage}</div>}

        <form onSubmit={handleSubmit} className="mt-6 space-y-6">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-700">Pending Admission *</span>
            <select value={admissionId} onChange={(event) => selectAdmission(event.target.value)} required disabled={loading || saving} className="w-full rounded-lg border px-3 py-2 text-slate-900 bg-white">
              <option value="">{loading ? "Loading admissions..." : "Select Pending admission"}</option>
              {admissions.map((item) => <option key={item.id} value={item.id}>{residents.find((residentItem) => residentItem.id === item.resident_id)?.full_name || "Unknown resident"} — {item.admission_date}</option>)}
            </select>
          </label>

          {admission && <section className="grid gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2 lg:grid-cols-3">
            <Info label="Resident" value={resident?.full_name || "Unknown"} />
            <Info label="Room / Bed" value={`${room?.room_number || "Not allocated"} / ${bed ? normalizeBedLabel(bed.bed_number) : "Not allocated"}`} />
            <Info label="Admission / Start" value={admission.admission_date} />
            <Info label="Monthly Rent" value={money(admission.monthly_rent)} />
            <Info label="Security Deposit" value={money(admission.security_deposit)} />
            <Info label="Contract Status" value="Pending Signature" />
          </section>}

          <label className="block"><span className="mb-2 block text-sm font-medium text-slate-700">End Date (optional)</span><input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} disabled={saving} className="w-full rounded-lg border px-3 py-2 text-slate-900 bg-white" /></label>

          {activeTemplate && (
            <section className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-indigo-100 pb-3">
                <div>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-600"></span>
                    Standard Residency Contract Format
                  </span>
                  <h2 className="mt-1 text-base font-bold text-gray-900">{activeTemplate.title}</h2>
                </div>
                <Link
                  href="/contracts"
                  className="text-xs font-semibold text-indigo-600 hover:text-indigo-800"
                >
                  Configure Standard Format →
                </Link>
              </div>
              <div className="mt-3 max-h-56 overflow-y-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-gray-700 bg-white p-3.5 rounded-lg border border-slate-200">
                {activeTemplate.content}
              </div>
              <p className="mt-3 text-xs text-gray-500">
                These terms are automatically applied to this contract. Residents will review and sign this agreement in the Resident Portal.
              </p>
            </section>
          )}

          <label className="block"><span className="mb-2 block text-sm font-medium text-slate-700">Special Clauses / Notes</span><textarea rows={4} value={notes} onChange={(event) => setNotes(event.target.value)} disabled={saving} className="w-full rounded-lg border px-3 py-2 text-slate-900 bg-white" /></label>
          <label className="block"><span className="mb-2 block text-sm font-medium text-slate-700">Agreement PDF (optional)</span><input type="file" accept="application/pdf,.pdf" onChange={(event) => setAgreementFile(event.target.files?.[0] ?? null)} disabled={saving} className="w-full rounded-lg border p-2 text-slate-900 bg-white" /></label>

          <div className="flex flex-wrap gap-3"><button type="submit" disabled={loading || saving || !activeTemplate} className="rounded-lg bg-blue-600 px-5 py-2 text-white disabled:opacity-50">{saving ? "Preparing..." : "Prepare Contract for Resident Signature"}</button><Link href="/contracts" className="rounded-lg bg-gray-300 px-5 py-2 text-slate-900">Cancel</Link></div>
        </form>
      </div>
    </main>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p><p className="mt-1 font-semibold text-slate-900">{value}</p></div>;
}
