"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import StaffUserManager from "@/components/admin/StaffUserManager";

type ResidentSummary = {
  id: string;
  residentCode: string | null;
  fullName: string;
  email: string | null;
  phone: string | null;
  status: string | null;
  admissionStatus: string;
  room: string | null;
  bed: string | null;
  outstandingBalance: number;
};

type ResultSummary = {
  message: string;
  counts: Record<string, number>;
};

type ModalType = "reset" | "resident" | null;

const countLabels: Record<string, string> = {
  residents: "Resident profiles",
  admissions: "Admissions",
  rooms: "Rooms",
  beds: "Beds",
  bills: "Bills",
  ac_bills: "AC bills",
  payments: "Payments",
  payment_receipts: "Payment receipts",
  contracts: "Contracts",
  room_inspections: "Room inspections",
  inspections: "Legacy inspections",
  maintenance_requests: "Maintenance records",
  maintenance_photos: "Maintenance photos",
  notices: "Notices",
  notice_recipients: "Notice recipients",
  notification_deliveries: "Notification deliveries",
  resident_portal_links: "Resident login links",
  inventory: "Inventory items",
  inventory_assignments: "Inventory assignments",
  inventory_movements: "Inventory movements",
  complaints: "Complaints",
  visitors: "Visitor records",
  payment_followups: "Payment follow-ups",
  rent_reminder_deliveries: "Rent reminders",
  fine_waiver_requests: "Fine waiver requests",
  late_fees: "Late fee records",
  late_fee_payment_allocations: "Late fee allocations",
  late_fee_history: "Late fee history",
  rent_period_corrections: "Rent period corrections",
  staff_payment_allocation_audit: "Staff payment audits",
  payment_allocations: "Payment allocations",
  payment_status_history: "Payment history",
  resident_profile_documents: "Profile documents",
  resident_emergency_contacts: "Emergency contacts",
  resident_profile_corrections: "Profile corrections",
  resident_profile_completions: "Profile completions",
  historical_payment_evidence: "Payment evidence",
  historical_payment_evidence_reviews: "Evidence reviews",
  admission_allocation_history: "Allocation history",
};

function money(value: number) {
  return new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", maximumFractionDigits: 0 }).format(value || 0);
}

export default function DataManagementPage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-slate-50 p-6 dark:bg-slate-950 text-slate-500">Loading admin tools...</main>}>
      <DataManagementContent />
    </Suspense>
  );
}

function DataManagementContent() {
  const searchParams = useSearchParams();
  const initialTab = searchParams.get("tab") === "data" ? "data" : "staff";
  const [activeTab, setActiveTab] = useState<"staff" | "data">(initialTab);
  const [residents, setResidents] = useState<ResidentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [accessError, setAccessError] = useState("");
  const [modal, setModal] = useState<ModalType>(null);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [actionError, setActionError] = useState("");
  const [result, setResult] = useState<ResultSummary | null>(null);

  const authenticatedFetch = useCallback(async (method: "GET" | "POST", body?: object) => {
    const { data, error } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (error || !token) throw new Error("Your administrator session has expired. Please sign in again.");
    const response = await fetch("/api/admin/data-management", {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: string; residents?: ResidentSummary[]; message?: string; counts?: Record<string, number> };
    if (!response.ok) throw new Error(payload.error || "The request could not be completed.");
    return payload;
  }, []);

  const loadResidents = useCallback(async () => {
    setLoading(true);
    setAccessError("");
    try {
      const payload = await authenticatedFetch("GET");
      setResidents(payload.residents ?? []);
    } catch (error) {
      setAccessError(error instanceof Error ? error.message : "The admin tools could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [authenticatedFetch]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadResidents(), 0);
    return () => window.clearTimeout(timeout);
  }, [loadResidents]);

  const filteredResidents = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return residents;
    return residents.filter((resident) =>
      [resident.fullName, resident.email, resident.phone, resident.residentCode]
        .some((value) => String(value ?? "").toLowerCase().includes(query)),
    );
  }, [residents, search]);

  const selectedResident = residents.find((resident) => resident.id === selectedId) ?? null;
  const canReset = acknowledged && confirmation === "RESET HOSTEL DATA" && !processing;
  const canDeleteResident = Boolean(
    selectedResident && acknowledged && confirmation.trim().toLowerCase() === selectedResident.fullName.trim().toLowerCase() && !processing,
  );

  function openModal(type: Exclude<ModalType, null>) {
    setModal(type);
    setConfirmation("");
    setAcknowledged(false);
    setActionError("");
    setResult(null);
    if (type === "reset") setSelectedId("");
  }

  function closeModal() {
    if (processing) return;
    setModal(null);
    setConfirmation("");
    setAcknowledged(false);
    setActionError("");
  }

  async function runFullReset() {
    if (!canReset) return;
    setProcessing(true);
    setActionError("");
    try {
      const payload = await authenticatedFetch("POST", { action: "FULL_RESET", confirmation, acknowledged });
      setResult({ message: payload.message || "System reset completed successfully", counts: payload.counts ?? {} });
      setResidents([]);
      setConfirmation("");
      setAcknowledged(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The hostel reset could not be completed.");
    } finally {
      setProcessing(false);
    }
  }

  async function deleteResident() {
    if (!canDeleteResident || !selectedResident) return;
    if (!window.confirm(`Final confirmation: permanently delete ${selectedResident.fullName} and all linked records?`)) return;
    setProcessing(true);
    setActionError("");
    try {
      const payload = await authenticatedFetch("POST", {
        action: "RESIDENT_DELETE",
        residentId: selectedResident.id,
        residentName: confirmation.trim(),
        acknowledged,
      });
      setResult({ message: payload.message || "Resident removed successfully", counts: payload.counts ?? {} });
      setResidents((current) => current.filter((resident) => resident.id !== selectedResident.id));
      setSelectedId("");
      setConfirmation("");
      setAcknowledged(false);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The resident could not be removed.");
    } finally {
      setProcessing(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8 dark:bg-slate-950">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="rounded-3xl bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 p-6 text-white shadow-xl sm:p-8">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-300">Admin tools</p>
          <h1 className="mt-2 text-3xl font-bold">Admin Tools & System Control</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">Manage staff login accounts and granular sidebar permissions, or securely reset hostel operational data.</p>

          <div className="mt-6 flex flex-wrap gap-3 border-t border-slate-800/80 pt-6">
            <button
              type="button"
              onClick={() => setActiveTab("staff")}
              className={`flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold transition ${
                activeTab === "staff"
                  ? "bg-blue-600 text-white shadow"
                  : "bg-slate-800/80 text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              Staff Users & Permissions
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("data")}
              className={`flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-bold transition ${
                activeTab === "data"
                  ? "bg-blue-600 text-white shadow"
                  : "bg-slate-800/80 text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
              </svg>
              Hostel Data Management
            </button>
          </div>
        </section>

        {activeTab === "staff" && <StaffUserManager />}

        {activeTab === "data" && (
          <>
            {accessError && <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200">{accessError}</div>}

            <div className="grid gap-6 lg:grid-cols-2">
              <ToolCard
                tone="red"
                title="Reset Hostel Data"
                description="Clear all resident, room, billing and operational data to start fresh."
                details="Preserves authentication, staff users, settings, roles, templates, and configuration."
                button="Reset & Start Fresh"
                disabled={loading || Boolean(accessError)}
                onClick={() => openModal("reset")}
              />
              <ToolCard
                tone="amber"
                title="Delete Resident Data"
                description="Remove a specific resident and all related records."
                details={`${loading ? "Loading" : residents.length} resident${residents.length === 1 ? "" : "s"} available for review.`}
                button="Manage Resident Deletion"
                disabled={loading || Boolean(accessError)}
                onClick={() => openModal("resident")}
              />
            </div>

            <section className="rounded-2xl border border-blue-200 bg-blue-50 p-5 dark:border-blue-900 dark:bg-blue-950/40">
              <h2 className="font-bold text-blue-900 dark:text-blue-100">Protected data</h2>
              <p className="mt-2 text-sm leading-6 text-blue-800 dark:text-blue-200">These tools never delete Supabase Auth users, staff/admin records, roles, system settings, notification provider configuration, contract templates, schema, or migrations. Every attempted destructive action is audit logged.</p>
            </section>
          </>
        )}
      </div>

      {modal && (
        <div role="dialog" aria-modal="true" aria-labelledby="data-action-title" className="fixed inset-0 z-[100] flex items-end justify-center bg-slate-950/65 p-0 backdrop-blur-sm sm:items-center sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) closeModal(); }}>
          <div className="max-h-[94vh] w-full max-w-3xl overflow-y-auto rounded-t-3xl border border-slate-200 bg-white shadow-2xl sm:rounded-3xl dark:border-slate-700 dark:bg-slate-900">
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-5 py-4 sm:px-6 dark:border-slate-700 dark:bg-slate-900">
              <div><p className="text-xs font-bold uppercase tracking-[0.18em] text-red-600 dark:text-red-300">Destructive action</p><h2 id="data-action-title" className="mt-1 text-xl font-bold text-slate-900 dark:text-white">{modal === "reset" ? "Reset Hostel Data" : "Delete Resident Data"}</h2></div>
              <button type="button" aria-label="Close" disabled={processing} onClick={closeModal} className="flex h-10 w-10 items-center justify-center rounded-xl text-2xl text-slate-500 hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800">×</button>
            </div>

            <div className="space-y-5 p-5 sm:p-6">
              {result ? (
                <ResultPanel result={result} onDone={() => { closeModal(); void loadResidents(); }} />
              ) : modal === "reset" ? (
                <>
                  <Warning>This will permanently remove all hostel operational data including residents, rooms, admissions, billing records and notifications. This action cannot be undone.</Warning>
                  <div className="rounded-2xl border border-slate-200 p-4 dark:border-slate-700"><p className="text-sm font-bold text-slate-900 dark:text-white">Data preserved</p><p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">Supabase Auth users, admin/staff users, roles, permissions, settings, configuration, notification provider settings, templates, schema, and migrations.</p></div>
                  <ConfirmationCheckbox checked={acknowledged} disabled={processing} onChange={setAcknowledged}>I understand this reset is permanent and cannot be undone.</ConfirmationCheckbox>
                  <label className="block"><span className="mb-2 block text-sm font-semibold text-slate-700 dark:text-slate-200">Type <strong>RESET HOSTEL DATA</strong> to continue</span><input value={confirmation} disabled={processing} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" className="w-full rounded-xl border border-slate-300 px-4 py-3 font-mono text-sm outline-none focus:border-red-500 focus:ring-4 focus:ring-red-100 disabled:bg-slate-100 dark:border-slate-600 dark:bg-slate-800 dark:text-white dark:focus:ring-red-950" /></label>
                  {actionError && <ErrorMessage>{actionError}</ErrorMessage>}
                  <div className="flex flex-col-reverse gap-3 border-t border-slate-200 pt-5 sm:flex-row sm:justify-end dark:border-slate-700"><button type="button" disabled={processing} onClick={closeModal} className="rounded-xl border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700 dark:border-slate-600 dark:text-slate-200">Cancel</button><button type="button" disabled={!canReset} onClick={() => void runFullReset()} className="rounded-xl bg-red-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40">{processing ? "Resetting hostel data..." : "Permanently reset hostel"}</button></div>
                </>
              ) : (
                <>
                  <Warning>This will permanently remove this resident and all related records including admissions, payments, notices, contracts and communication history.</Warning>
                  <label className="block"><span className="mb-2 block text-sm font-semibold text-slate-700 dark:text-slate-200">Search residents</span><input value={search} disabled={processing} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, email, phone, or resident code" className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none focus:border-amber-500 focus:ring-4 focus:ring-amber-100 dark:border-slate-600 dark:bg-slate-800 dark:text-white dark:focus:ring-amber-950" /></label>
                  <div className="max-h-48 space-y-2 overflow-y-auto rounded-2xl border border-slate-200 p-2 dark:border-slate-700">
                    {filteredResidents.length ? filteredResidents.map((resident) => <button key={resident.id} type="button" disabled={processing} onClick={() => { setSelectedId(resident.id); setConfirmation(""); setAcknowledged(false); setActionError(""); }} className={`flex w-full items-center justify-between gap-3 rounded-xl p-3 text-left transition ${selectedId === resident.id ? "bg-amber-100 ring-2 ring-amber-400 dark:bg-amber-950/70" : "hover:bg-slate-50 dark:hover:bg-slate-800"}`}><span className="min-w-0"><span className="block truncate text-sm font-bold text-slate-900 dark:text-white">{resident.fullName}</span><span className="block truncate text-xs text-slate-500 dark:text-slate-400">{resident.residentCode || "No code"} · {resident.email || resident.phone || "No contact"}</span></span><span className="text-xs font-semibold text-slate-500">{resident.status || "—"}</span></button>) : <p className="p-4 text-center text-sm text-slate-500">No matching residents found.</p>}
                  </div>

                  {selectedResident && <ResidentDetails resident={selectedResident} />}
                  {selectedResident && <><ConfirmationCheckbox checked={acknowledged} disabled={processing} onChange={setAcknowledged}>I understand this permanently deletes only the selected resident and every linked record.</ConfirmationCheckbox><label className="block"><span className="mb-2 block text-sm font-semibold text-slate-700 dark:text-slate-200">Type <strong>{selectedResident.fullName}</strong> to confirm</span><input value={confirmation} disabled={processing} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" className="w-full rounded-xl border border-slate-300 px-4 py-3 text-sm outline-none focus:border-red-500 focus:ring-4 focus:ring-red-100 dark:border-slate-600 dark:bg-slate-800 dark:text-white dark:focus:ring-red-950" /></label></>}
                  {actionError && <ErrorMessage>{actionError}</ErrorMessage>}
                  <div className="flex flex-col-reverse gap-3 border-t border-slate-200 pt-5 sm:flex-row sm:justify-end dark:border-slate-700"><button type="button" disabled={processing} onClick={closeModal} className="rounded-xl border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700 dark:border-slate-600 dark:text-slate-200">Cancel</button><button type="button" disabled={!canDeleteResident} onClick={() => void deleteResident()} className="rounded-xl bg-red-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40">{processing ? "Deleting resident..." : "Delete Resident Permanently"}</button></div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function ToolCard({ tone, title, description, details, button, disabled, onClick }: { tone: "red" | "amber"; title: string; description: string; details: string; button: string; disabled: boolean; onClick: () => void }) {
  const red = tone === "red";
  return <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900"><div className={`flex h-14 w-14 items-center justify-center rounded-2xl ${red ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"}`}><svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg></div><h2 className="mt-5 text-xl font-bold text-slate-900 dark:text-white">{title}</h2><p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{description}</p><p className="mt-3 text-xs leading-5 text-slate-500 dark:text-slate-400">{details}</p><button type="button" disabled={disabled} onClick={onClick} className={`mt-6 w-full rounded-xl px-5 py-3 text-sm font-bold text-white transition disabled:cursor-not-allowed disabled:opacity-40 ${red ? "bg-red-600 hover:bg-red-700" : "bg-amber-600 hover:bg-amber-700"}`}>{button}</button></section>;
}

function Warning({ children }: { children: React.ReactNode }) { return <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-medium leading-6 text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200">{children}</div>; }
function ErrorMessage({ children }: { children: React.ReactNode }) { return <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-200">{children}</div>; }
function ConfirmationCheckbox({ checked, disabled, onChange, children }: { checked: boolean; disabled: boolean; onChange: (checked: boolean) => void; children: React.ReactNode }) { return <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-slate-200 p-4 dark:border-slate-700"><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="mt-0.5 h-5 w-5 rounded accent-red-600"/><span className="text-sm font-medium leading-6 text-slate-700 dark:text-slate-200">{children}</span></label>; }

function ResidentDetails({ resident }: { resident: ResidentSummary }) {
  const details = [["Name", resident.fullName], ["Email", resident.email || "Not recorded"], ["Phone", resident.phone || "Not recorded"], ["Room / Bed", resident.room ? `${resident.room} / ${resident.bed || "No bed"}` : "Not assigned"], ["Admission", resident.admissionStatus], ["Outstanding", money(resident.outstandingBalance)]];
  return <div className="grid gap-3 rounded-2xl bg-slate-50 p-4 sm:grid-cols-2 dark:bg-slate-800/70">{details.map(([label, value]) => <div key={label}><p className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</p><p className="mt-1 break-words text-sm font-semibold text-slate-900 dark:text-white">{value}</p></div>)}</div>;
}

function ResultPanel({ result, onDone }: { result: ResultSummary; onDone: () => void }) {
  const rows = Object.entries(result.counts).filter(([, count]) => count > 0).sort(([a], [b]) => (countLabels[a] ?? a).localeCompare(countLabels[b] ?? b));
  return <div className="space-y-5"><div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200"><h3 className="text-lg font-bold">{result.message}</h3><p className="mt-1 text-sm">The operation finished and affected pages were revalidated.</p></div><div><h4 className="font-bold text-slate-900 dark:text-white">Deleted records</h4>{rows.length ? <div className="mt-3 grid gap-2 sm:grid-cols-2">{rows.map(([key, count]) => <div key={key} className="flex items-center justify-between rounded-xl border border-slate-200 px-4 py-3 text-sm dark:border-slate-700"><span className="text-slate-600 dark:text-slate-300">{countLabels[key] ?? key.replaceAll("_", " ")}</span><strong className="text-slate-900 dark:text-white">{count}</strong></div>)}</div> : <p className="mt-2 text-sm text-slate-500">No matching records required deletion.</p>}</div><div className="flex justify-end"><button type="button" onClick={onDone} className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-bold text-white hover:bg-indigo-700">Done</button></div></div>;
}
