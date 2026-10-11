"use client";

import Link from "next/link";
import {
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { supabase } from "@/lib/supabase";
import { getSupabaseErrorMessage } from "@/lib/supabaseErrors";

type ContractStatus =
  | "Draft"
  | "Pending Signature"
  | "Active"
  | "Expired"
  | "Cancelled"
  | "Terminated";
type SignatureStatus =
  | "Pending"
  | "Submitted"
  | "Approved"
  | "Rejected"
  | "Re-sign Required"
  | "Signed";

type Resident = {
  id: string;
  full_name: string;
  status: string | null;
};

type Admission = {
  id: string;
  resident_id: string;
  room_id: string | null;
  bed_id: string | null;
  admission_date: string;
  expected_leaving_date: string | null;
  monthly_rent: number;
  security_deposit: number;
  status: string;
};

type Room = {
  id: string;
  room_number: string;
};

type Bed = {
  id: string;
  bed_number: string;
};

type Contract = {
  id: string;
  contract_number: string;
  resident_id: string;
  admission_id: string | null;
  room_id: string | null;
  bed_id: string | null;
  start_date: string;
  end_date: string | null;
  monthly_rent: number;
  security_deposit: number;
  notice_period_days: number;
  resident_signature_status: SignatureStatus;
  owner_signature_status: SignatureStatus;
  owner_signature_name: string | null;
  signed_at: string | null;
  status: ContractStatus | null;
  contract_content: string | null;
  created_at: string;
  updated_at: string;
};

type ContractForm = {
  contract_number: string;
  resident_id: string;
  admission_id: string;
  room_id: string;
  bed_id: string;
  start_date: string;
  end_date: string;
  monthly_rent: string;
  security_deposit: string;
  notice_period_days: string;
};

type ContractTemplateRecord = {
  id: string;
  template_name: string;
  title: string;
  content: string;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
};

const today = new Date().toISOString().slice(0, 10);

const recommendedStandardTerms = `1. RENT & PAYMENT TERMS:
Monthly rent must be paid in advance by the due date specified in the rent schedule. Late payments may incur administrative charges.

2. SECURITY DEPOSIT & REFUND POLICY:
The security deposit is strictly refundable upon successful vacating procedure, provided:
- The resident serves at least a 30-day prior written notice before departure.
- All pending rent, utility, and damage assessments are fully settled.

3. ROOM & BED ALLOCATION:
Room and bed assignments are allocated by hostel administration. Residents are strictly prohibited from swapping or sub-leasing their assigned bed.

4. MAINTENANCE & DAMAGE LIABILITY:
Residents must maintain cleanliness and keep hostel assets in good order. Any damage identified during routine or checkout room inspections will be deducted from the security deposit.

5. CODE OF CONDUCT & HOSTEL RULES:
Residents must adhere to hostel curfew times, visitor guidelines, and security protocols. Creating disturbances or engaging in prohibited activities will lead to immediate contract termination.`;

const defaultTerms = recommendedStandardTerms;

const emptyForm: ContractForm = {
  contract_number: "",
  resident_id: "",
  admission_id: "",
  room_id: "",
  bed_id: "",
  start_date: today,
  end_date: "",
  monthly_rent: "",
  security_deposit: "",
  notice_period_days: "30",
};

const inputClass =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-slate-100";

function statusClass(status: ContractStatus) {
  if (status === "Active") return "bg-emerald-100 text-emerald-700";
  if (status === "Pending Signature") return "bg-amber-100 text-amber-700";
  if (status === "Expired") return "bg-red-100 text-red-700";
  if (status === "Cancelled") return "bg-slate-200 text-slate-700";
  if (status === "Terminated") return "bg-slate-200 text-slate-700";
  return "bg-blue-100 text-blue-700";
}

function signatureClass(status: SignatureStatus) {
  return status === "Approved" || status === "Signed"
    ? "bg-emerald-100 text-emerald-700"
    : status === "Rejected" || status === "Re-sign Required"
      ? "bg-red-100 text-red-700"
    : "bg-amber-100 text-amber-700";
}

function money(value: number) {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(value || 0);
}

export default function ContractsPage() {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [residents, setResidents] = useState<Resident[]>([]);
  const [admissions, setAdmissions] = useState<Admission[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [beds, setBeds] = useState<Bed[]>([]);
  const [form, setForm] = useState<ContractForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showStandardModal, setShowStandardModal] = useState(false);
  const [standardTemplate, setStandardTemplate] = useState<ContractTemplateRecord | null>(null);
  const [standardTitle, setStandardTitle] = useState("Standard Residency Contract");
  const [standardTemplateName, setStandardTemplateName] = useState("Standard Template");
  const [standardContent, setStandardContent] = useState(defaultTerms);
  const [savingStandard, setSavingStandard] = useState(false);
  const [standardModalError, setStandardModalError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");

    const [
      { data: contractsData, error: contractsError },
      { data: residentsData, error: residentsError },
      { data: admissionsData, error: admissionsError },
      { data: roomsData, error: roomsError },
      { data: bedsData, error: bedsError },
      { data: templatesData, error: templatesError },
    ] = await Promise.all([
      supabase.from("contracts").select("id, contract_number, resident_id, admission_id, room_id, bed_id, start_date, end_date, monthly_rent, security_deposit, notice_period_days, resident_signature_status, owner_signature_status, owner_signature_name, signed_at, status, contract_content, created_at, updated_at").order("created_at", { ascending: false }),
      supabase.from("residents").select("id, full_name, status").order("full_name"),
      supabase.from("admissions").select("*").order("created_at", { ascending: false }),
      supabase.from("rooms").select("id, room_number").order("room_number"),
      supabase.from("beds").select("id, bed_number").order("bed_number"),
      supabase.from("contract_templates").select("*").order("is_active", { ascending: false }).order("created_at", { ascending: false }),
    ]);

    const firstError =
      contractsError ||
      residentsError ||
      admissionsError ||
      roomsError ||
      bedsError ||
      templatesError;

    if (firstError) {
      setError(
        getSupabaseErrorMessage(
          firstError,
          "Unable to load contracts. Please try again.",
        ),
      );
    }

    setContracts((contractsData ?? []) as Contract[]);
    setResidents((residentsData ?? []) as Resident[]);
    setAdmissions((admissionsData ?? []) as Admission[]);
    setRooms((roomsData ?? []) as Room[]);
    setBeds((bedsData ?? []) as Bed[]);

    const loadedTemplates = (templatesData ?? []) as ContractTemplateRecord[];
    const active = loadedTemplates.find((t) => t.is_active) || loadedTemplates[0] || null;
    if (active) {
      setStandardTemplate(active);
      setStandardTitle(active.title || "Standard Residency Contract");
      setStandardTemplateName(active.template_name || "Standard Template");
      setStandardContent(active.content || defaultTerms);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    // Loading Supabase data is the external synchronization for this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const filteredContracts = useMemo(() => {
    const query = search.trim().toLowerCase();

    return contracts.filter((contract) => {
      const residentName =
        residents.find((resident) => resident.id === contract.resident_id)
          ?.full_name ?? "";

      const matchesSearch =
        !query ||
        contract.contract_number.toLowerCase().includes(query) ||
        residentName.toLowerCase().includes(query);

      const matchesStatus =
        statusFilter === "All" || getContractStatus(contract) === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [contracts, residents, search, statusFilter]);

  const summary = useMemo(
    () => ({
      total: contracts.length,
      active: contracts.filter((item) => getContractStatus(item) === "Active").length,
      pending: contracts.filter((item) => getContractStatus(item) === "Pending Signature")
        .length,
      expired: contracts.filter((item) => getContractStatus(item) === "Expired").length,
    }),
    [contracts]
  );

  function updateField<K extends keyof ContractForm>(
    key: K,
    value: ContractForm[K]
  ) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function openStandardContractModal() {
    if (standardTemplate) {
      setStandardTitle(standardTemplate.title || "Standard Residency Contract");
      setStandardTemplateName(standardTemplate.template_name || "Standard Template");
      setStandardContent(standardTemplate.content || defaultTerms);
    }
    setStandardModalError("");
    setShowStandardModal(true);
  }

  async function saveStandardContract(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSavingStandard(true);
    setStandardModalError("");

    const cleanTitle = standardTitle.trim();
    const cleanTemplateName = standardTemplateName.trim() || "Standard Template";
    const cleanContent = standardContent.trim();

    if (!cleanTitle) {
      setStandardModalError("Please enter a title for the Standard Residency Contract.");
      setSavingStandard(false);
      return;
    }

    if (!cleanContent) {
      setStandardModalError("Please enter the contract terms, rules, and conditions.");
      setSavingStandard(false);
      return;
    }

    try {
      const now = new Date().toISOString();
      let targetId = standardTemplate?.id;

      if (targetId) {
        const { error: updateError } = await supabase
          .from("contract_templates")
          .update({
            title: cleanTitle,
            template_name: cleanTemplateName,
            content: cleanContent,
            is_active: true,
            updated_at: now,
          })
          .eq("id", targetId);

        if (updateError) throw updateError;
      } else {
        const { data: newRec, error: insertError } = await supabase
          .from("contract_templates")
          .insert({
            title: cleanTitle,
            template_name: cleanTemplateName,
            content: cleanContent,
            is_active: true,
            created_at: now,
            updated_at: now,
          })
          .select("id")
          .single();

        if (insertError) throw insertError;
        targetId = newRec?.id;
      }

      if (targetId) {
        await supabase
          .from("contract_templates")
          .update({ is_active: false })
          .neq("id", targetId);
      }

      setMessage("Standard Residency Contract format updated successfully. All new contracts will be sent with this standard format.");
      setShowStandardModal(false);
      await refresh();
    } catch (err) {
      setStandardModalError(
        err instanceof Error
          ? err.message
          : getSupabaseErrorMessage(
              err as { code?: string; message?: string },
              "Unable to save standard contract format. Please try again.",
            )
      );
    } finally {
      setSavingStandard(false);
    }
  }

  function openEditForm(contract: Contract) {
    setEditingId(contract.id);
    setForm({
      contract_number: contract.contract_number,
      resident_id: contract.resident_id,
      admission_id: contract.admission_id ?? "",
      room_id: contract.room_id ?? "",
      bed_id: contract.bed_id ?? "",
      start_date: contract.start_date,
      end_date: contract.end_date ?? "",
      monthly_rent: String(contract.monthly_rent ?? 0),
      security_deposit: String(contract.security_deposit ?? 0),
      notice_period_days: String(contract.notice_period_days ?? 30),
    });
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function applyAdmission(admissionId: string) {
    const admission = admissions.find((item) => item.id === admissionId);

    if (!admission) {
      updateField("admission_id", "");
      return;
    }

    setForm((current) => ({
      ...current,
      admission_id: admission.id,
      resident_id: admission.resident_id,
      room_id: admission.room_id ?? "",
      bed_id: admission.bed_id ?? "",
      start_date: admission.admission_date || today,
      end_date: admission.expected_leaving_date ?? "",
      monthly_rent: String(admission.monthly_rent ?? 0),
      security_deposit: String(admission.security_deposit ?? 0),
    }));
  }

  async function saveContract(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    setError("");

    if (!form.contract_number.trim() || !form.resident_id || !form.start_date) {
      setError("Contract number, resident and start date are required.");
      setSaving(false);
      return;
    }

    if (form.end_date && new Date(form.end_date) <= new Date(form.start_date)) {
      setError("End date must be later than the start date.");
      setSaving(false);
      return;
    }

    const [residentResult, admissionResult, duplicateResult] = await Promise.all([
      supabase
        .from("residents")
        .select("id, status")
        .eq("id", form.resident_id)
        .maybeSingle(),
      form.admission_id
        ? supabase
            .from("admissions")
            .select("id, resident_id, room_id, bed_id, status")
            .eq("id", form.admission_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      Promise.resolve({ data: null, error: null }),
    ]);

    const validationError =
      residentResult.error || admissionResult.error || duplicateResult.error;

    if (validationError) {
      setError(
        getSupabaseErrorMessage(
          validationError,
          "Unable to verify the contract details. Please try again.",
        ),
      );
      setSaving(false);
      return;
    }

    if (!residentResult.data || residentResult.data.status === "Archived") {
      setError("The selected resident is no longer available for a contract.");
      await refresh();
      setSaving(false);
      return;
    }

    if (
      form.admission_id &&
      (!admissionResult.data ||
        admissionResult.data.resident_id !== form.resident_id ||
        !["Active", "Pending"].includes(admissionResult.data.status))
    ) {
      setError("The selected admission is no longer current for this resident.");
      await refresh();
      setSaving(false);
      return;
    }

    const existingContract = editingId
      ? contracts.find((contract) => contract.id === editingId)
      : null;

    if (!existingContract) {
      setError("Use Prepare Contract to create a contract from a Pending admission.");
      setSaving(false);
      return;
    }

    // End-date edits must never overwrite a signature, approval or lifecycle transition.
    const result = await supabase.from("contracts")
      .update({ end_date: form.end_date || null, updated_at: new Date().toISOString() })
      .eq("id", existingContract.id).eq("updated_at", existingContract.updated_at)
      .select("id").maybeSingle();

    if (result.error || !result.data) {
      setError(
        getSupabaseErrorMessage(
          result.error,
          "Unable to save this contract. Please try again.",
          "A contract with the same contract number already exists.",
        ),
      );
    } else {
      setMessage(
        editingId
          ? "Contract updated successfully."
          : "Contract created successfully."
      );
      setShowForm(false);
      setEditingId(null);
      setForm(emptyForm);
      await refresh();
    }

    setSaving(false);
  }

  async function cancelContract(contract: Contract) {
    if (getContractStatus(contract) === "Cancelled") return;
    if (!window.confirm(`Cancel contract ${contract.contract_number}?`)) return;

    setMessage("");
    setError("");

    const { data: cancelled, error: cancelError } = await supabase
      .from("contracts")
      .update({
        status: "Cancelled",
        updated_at: new Date().toISOString(),
      })
      .eq("id", contract.id).eq("status", contract.status).eq("updated_at", contract.updated_at).select("id").maybeSingle();

    if (cancelError || !cancelled) {
      setError(
        getSupabaseErrorMessage(
          cancelError,
          "Unable to cancel this contract. Please try again.",
        ),
      );
    } else {
      setMessage("Contract cancelled successfully.");
      await refresh();
    }
  }

  function printContract(contract: Contract) {
    const resident = residents.find(
      (item) => item.id === contract.resident_id
    );
    const room = rooms.find((item) => item.id === contract.room_id);
    const bed = beds.find((item) => item.id === contract.bed_id);

    const printWindow = window.open("", "_blank", "width=900,height=700");

    if (!printWindow) return;

    printWindow.document.write(`
      <html>
        <head>
          <title>${contract.contract_number}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 32px; color: #0f172a; }
            h1 { margin-bottom: 8px; }
            .meta { margin-bottom: 24px; color: #475569; }
            .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 24px; }
            .card { border: 1px solid #cbd5e1; padding: 12px; border-radius: 10px; }
            .label { font-size: 12px; color: #64748b; text-transform: uppercase; }
            .value { margin-top: 6px; font-weight: 700; }
            .terms { white-space: pre-wrap; line-height: 1.7; }
          </style>
        </head>
        <body>
          <h1>University Girls Hostel</h1>
          <div class="meta">Resident Contract</div>
          <div class="grid">
            <div class="card"><div class="label">Contract Number</div><div class="value">${contract.contract_number}</div></div>
            <div class="card"><div class="label">Resident</div><div class="value">${resident?.full_name ?? "Unknown"}</div></div>
            <div class="card"><div class="label">Room</div><div class="value">${room?.room_number ?? "Not allocated"}</div></div>
            <div class="card"><div class="label">Bed</div><div class="value">${bed?.bed_number ?? "Not allocated"}</div></div>
            <div class="card"><div class="label">Start Date</div><div class="value">${contract.start_date}</div></div>
            <div class="card"><div class="label">End Date</div><div class="value">${contract.end_date ?? "Not set"}</div></div>
            <div class="card"><div class="label">Monthly Rent</div><div class="value">${money(contract.monthly_rent)}</div></div>
            <div class="card"><div class="label">Security Deposit</div><div class="value">${money(contract.security_deposit)}</div></div>
          </div>
          <h2>Terms and Conditions</h2>
          <div class="terms">${contract.contract_content ?? ""}</div>
        </body>
      </html>
    `);

    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
  }

  return (
    <main className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">
              University Girls Hostel
            </p>
            <h1 className="mt-2 text-3xl font-bold text-slate-900">
              Contracts
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              Create, sign, print and manage resident contracts.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={openStandardContractModal}
              className="inline-flex items-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-5 py-3 text-sm font-semibold text-indigo-700 shadow-sm transition hover:bg-indigo-100 hover:border-indigo-300"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4 w-4 text-indigo-600"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
              </svg>
              Standard Residency Contract
            </button>

            <Link
              href="/contracts/add"
              className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700"
            >
              + Add Contract
            </Link>
          </div>
        </section>

        {(message || error) && (
          <section
            className={`rounded-2xl border px-4 py-3 text-sm font-medium ${
              error
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-emerald-200 bg-emerald-50 text-emerald-700"
            }`}
          >
            {error || message}
          </section>
        )}

        {showForm && (
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-6 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-slate-900">
                  {editingId ? "Edit Contract" : "Add Contract"}
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  Contract identity, admission terms, resident signature, and activation status are locked. Only the optional end date can be adjusted here.
                </p>
              </div>

              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                Close
              </button>
            </div>

            <form onSubmit={saveContract} className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <Field label="Contract Number *">
                  <input
                    required
                    disabled
                    value={form.contract_number}
                    onChange={(event) =>
                      updateField("contract_number", event.target.value)
                    }
                    className={inputClass}
                  />
                </Field>

                <Field label="Admission">
                  <select
                    disabled
                    value={form.admission_id}
                    onChange={(event) => applyAdmission(event.target.value)}
                    className={inputClass}
                  >
                    <option value="">Select admission</option>
                    {admissions
                      .filter(
                        (admission) =>
                          (["Active", "Pending"].includes(admission.status) &&
                            residents.find(
                              (resident) =>
                                resident.id === admission.resident_id,
                            )?.status !== "Archived") ||
                          (Boolean(editingId) &&
                            admission.id === form.admission_id),
                      )
                      .map((admission) => {
                      const resident = residents.find(
                        (item) => item.id === admission.resident_id
                      );

                      return (
                        <option key={admission.id} value={admission.id}>
                          {resident?.full_name ?? "Unknown"} —{" "}
                          {admission.admission_date}
                        </option>
                      );
                      })}
                  </select>
                </Field>

                <Field label="Resident *">
                  <select
                    required
                    disabled
                    value={form.resident_id}
                    onChange={(event) =>
                      updateField("resident_id", event.target.value)
                    }
                    className={inputClass}
                  >
                    <option value="">Select resident</option>
                    {residents
                      .filter(
                        (resident) =>
                          resident.status !== "Archived" ||
                          (Boolean(editingId) &&
                            resident.id === form.resident_id),
                      )
                      .map((resident) => (
                        <option
                          key={resident.id}
                          value={resident.id}
                          disabled={resident.status === "Archived"}
                        >
                          {resident.full_name}
                          {resident.status === "Archived" ? " (Archived)" : ""}
                        </option>
                      ))}
                  </select>
                </Field>

                <Field label="Room">
                  <select
                    disabled
                    value={form.room_id}
                    onChange={(event) =>
                      updateField("room_id", event.target.value)
                    }
                    className={inputClass}
                  >
                    <option value="">Select room</option>
                    {rooms.map((room) => (
                      <option key={room.id} value={room.id}>
                        {room.room_number}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Bed">
                  <select
                    disabled
                    value={form.bed_id}
                    onChange={(event) =>
                      updateField("bed_id", event.target.value)
                    }
                    className={inputClass}
                  >
                    <option value="">Select bed</option>
                    {beds.map((bed) => (
                      <option key={bed.id} value={bed.id}>
                        {bed.bed_number}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Start Date *">
                  <input
                    required
                    disabled
                    type="date"
                    value={form.start_date}
                    onChange={(event) =>
                      updateField("start_date", event.target.value)
                    }
                    className={inputClass}
                  />
                </Field>

                <Field label="End Date">
                  <input
                    type="date"
                    value={form.end_date}
                    onChange={(event) =>
                      updateField("end_date", event.target.value)
                    }
                    className={inputClass}
                  />
                </Field>

                <Field label="Monthly Rent">
                  <input
                    type="number"
                    min="0"
                    disabled
                    value={form.monthly_rent}
                    onChange={(event) =>
                      updateField("monthly_rent", event.target.value)
                    }
                    className={inputClass}
                  />
                </Field>

                <Field label="Security Deposit">
                  <input
                    type="number"
                    min="0"
                    disabled
                    value={form.security_deposit}
                    onChange={(event) =>
                      updateField("security_deposit", event.target.value)
                    }
                    className={inputClass}
                  />
                </Field>

                <Field label="Notice Period (Days)">
                  <input
                    type="number"
                    min="0"
                    disabled
                    value={form.notice_period_days}
                    onChange={(event) =>
                      updateField("notice_period_days", event.target.value)
                    }
                    className={inputClass}
                  />
                </Field>

                <Field label="Terms and Conditions" wide>
                  <textarea disabled value={defaultTerms} className={`${inputClass} min-h-52`} />
                </Field>
              </div>

              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                Security deposit is refundable only when notice is served at least 30 days before leaving.
              </div>

              <div className="flex flex-wrap justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="rounded-xl border border-slate-300 px-5 py-3 text-sm font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {saving
                    ? "Saving..."
                    : editingId
                    ? "Update Contract"
                    : "Save Contract"}
                </button>
              </div>
            </form>
          </section>
        )}

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Total Contracts" value={String(summary.total)} />
          <StatCard label="Active" value={String(summary.active)} />
          <StatCard label="Pending Signature" value={String(summary.pending)} />
          <StatCard label="Expired" value={String(summary.expired)} />
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
          <div className="grid gap-3 border-b border-slate-200 p-5 lg:grid-cols-[1fr_220px_auto]">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className={inputClass}
              placeholder="Search contract number or resident"
            />

            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className={inputClass}
            >
              <option value="All">All Statuses</option>
              <option value="Draft">Draft</option>
              <option value="Pending Signature">Pending Signature</option>
              <option value="Active">Active</option>
              <option value="Expired">Expired</option>
              <option value="Cancelled">Cancelled</option>
              <option value="Terminated">Terminated (Legacy)</option>
            </select>

            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold"
            >
              Refresh
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  {[
                    "Contract",
                    "Resident",
                    "Room / Bed",
                    "Dates",
                    "Rent / Deposit",
                    "Signatures",
                    "Status",
                    "Actions",
                  ].map((heading) => (
                    <th
                      key={heading}
                      className="px-5 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100 bg-white">
                {loading ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-5 py-12 text-center text-sm text-slate-500"
                    >
                      Loading contracts...
                    </td>
                  </tr>
                ) : filteredContracts.length === 0 ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-5 py-12 text-center text-sm text-slate-500"
                    >
                      No contracts found.
                    </td>
                  </tr>
                ) : (
                  filteredContracts.map((contract) => {
                    const resident = residents.find(
                      (item) => item.id === contract.resident_id
                    );
                    const room = rooms.find(
                      (item) => item.id === contract.room_id
                    );
                    const bed = beds.find(
                      (item) => item.id === contract.bed_id
                    );

                    return (
                      <tr key={contract.id} className="hover:bg-slate-50/70">
                        <td className="px-5 py-4">
                          <p className="font-semibold text-slate-900">
                            {contract.contract_number}
                          </p>
                        </td>

                        <td className="px-5 py-4 text-sm text-slate-700">
                          {resident?.full_name || "Unknown resident"}
                        </td>

                        <td className="px-5 py-4 text-sm text-slate-700">
                          <p>Room: {room?.room_number || "Not allocated"}</p>
                          <p className="mt-1 text-xs text-slate-500">
                            Bed: {bed?.bed_number || "Not allocated"}
                          </p>
                        </td>

                        <td className="px-5 py-4 text-sm text-slate-700">
                          <p>{contract.start_date}</p>
                          <p className="mt-1 text-xs text-slate-500">
                            To: {contract.end_date || "Not set"}
                          </p>
                        </td>

                        <td className="px-5 py-4 text-sm text-slate-700">
                          <p>Rent: {money(contract.monthly_rent)}</p>
                          <p className="mt-1 text-xs text-slate-500">
                            Deposit: {money(contract.security_deposit)}
                          </p>
                        </td>

                        <td className="px-5 py-4">
                          <div className="flex flex-col gap-2">
                            <span
                              className={`w-fit rounded-full px-3 py-1 text-xs font-bold ${signatureClass(
                                contract.resident_signature_status
                              )}`}
                            >
                              Resident: {contract.resident_signature_status}
                            </span>

                            <span
                              className={`w-fit rounded-full px-3 py-1 text-xs font-bold ${signatureClass(
                                (contract.owner_signature_status === "Pending" ? "Signed" : (contract.owner_signature_status || "Signed")) as SignatureStatus
                              )}`}
                            >
                              Owner: {contract.owner_signature_status === "Pending" ? "Signed" : (contract.owner_signature_status || "Signed")}
                            </span>
                          </div>
                        </td>

                        <td className="px-5 py-4">
                          <span
                            className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${statusClass(
                              getContractStatus(contract)
                            )}`}
                          >
                            {getContractStatus(contract)}
                          </span>
                        </td>

                        <td className="px-5 py-4">
                          <div className="flex flex-wrap gap-2">
                            <Link
                              href={`/contracts/${contract.id}`}
                              className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700"
                            >
                              View
                            </Link>

                            <button
                              type="button"
                              onClick={() => printContract(contract)}
                              className="rounded-lg border border-emerald-200 px-3 py-2 text-xs font-semibold text-emerald-700"
                            >
                              Print
                            </button>

                            <button
                              type="button"
                              onClick={() => openEditForm(contract)}
                              className="rounded-lg border border-indigo-200 px-3 py-2 text-xs font-semibold text-indigo-700"
                            >
                              Edit
                            </button>

                            {!["Cancelled", "Terminated"].includes(
                              getContractStatus(contract),
                            ) && (
                              <button
                                type="button"
                                onClick={() => void cancelContract(contract)}
                                className="rounded-lg border border-amber-200 px-3 py-2 text-xs font-semibold text-amber-700"
                              >
                                Cancel
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        {showStandardModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm">
            <div className="relative max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl sm:p-8">
              <div className="mb-6 flex items-start justify-between gap-4 border-b border-slate-100 pb-5">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-600"></span>
                      Active Master Format for All Contracts
                    </span>
                  </div>
                  <h2 className="mt-2 text-2xl font-bold text-slate-900">
                    Set Standard Residency Contract
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Configure the master contract template. All resident contracts created or prepared in the hostel will automatically be sent using this standard format.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowStandardModal(false)}
                  className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>

              {standardModalError && (
                <div className="mb-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-700">
                  {standardModalError}
                </div>
              )}

              <form onSubmit={saveStandardContract} className="space-y-6">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <label className="mb-2 block text-sm font-semibold text-slate-700">
                      Contract Title *
                    </label>
                    <input
                      required
                      value={standardTitle}
                      onChange={(e) => setStandardTitle(e.target.value)}
                      className={inputClass}
                      placeholder="e.g. Standard Residency Contract"
                    />
                  </div>
                  <div>
                    <label className="mb-2 block text-sm font-semibold text-slate-700">
                      Template Identifier
                    </label>
                    <input
                      value={standardTemplateName}
                      onChange={(e) => setStandardTemplateName(e.target.value)}
                      className={inputClass}
                      placeholder="e.g. Standard Template"
                    />
                  </div>
                </div>

                <div>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <label className="text-sm font-semibold text-slate-700">
                      Standard Terms, Rules & Regulations *
                    </label>
                    <button
                      type="button"
                      onClick={() => setStandardContent(recommendedStandardTerms)}
                      className="text-xs font-semibold text-indigo-600 hover:text-indigo-800"
                    >
                      ↺ Reset to Recommended Terms
                    </button>
                  </div>
                  <textarea
                    required
                    rows={14}
                    value={standardContent}
                    onChange={(e) => setStandardContent(e.target.value)}
                    className={`${inputClass} font-mono text-xs leading-relaxed`}
                    placeholder="Enter standard clauses and hostel rules..."
                  />
                  <p className="mt-2 text-xs text-slate-500">
                    These terms are automatically applied when preparing new resident contracts. Residents will review and sign this agreement in the Resident Portal.
                  </p>
                </div>

                <div className="rounded-2xl border border-blue-100 bg-blue-50/70 p-4 text-xs text-blue-800">
                  <p className="font-semibold">ℹ️ How it works:</p>
                  <p className="mt-1">
                    When staff creates or prepares a contract for an admitted resident, this active standard agreement is attached as the binding contract content. Any customized special clauses for a resident can still be added in the notes field during preparation.
                  </p>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-100 pt-5">
                  <button
                    type="button"
                    onClick={() => setShowStandardModal(false)}
                    disabled={savingStandard}
                    className="rounded-xl border border-slate-300 px-5 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={savingStandard}
                    className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-60"
                  >
                    {savingStandard ? "Saving..." : "Save Standard Format"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function Field({
  label,
  wide = false,
  children,
}: {
  label: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={wide ? "md:col-span-2 xl:col-span-3" : ""}>
      <span className="mb-2 block text-sm font-semibold text-slate-700">
        {label}
      </span>
      {children}
    </label>
  );
}

function StatCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold text-slate-900">{value}</p>
    </article>
  );
}

function getContractStatus(contract: Contract) {
  return (contract.status ?? "Draft") as ContractStatus;
}
