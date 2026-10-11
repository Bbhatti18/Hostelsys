"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import ResidentNoticePopup from "@/components/notices/ResidentNoticePopup";
import ResidentDuesPopup from "@/components/resident/ResidentDuesPopup";
import FinancialSummary from "@/components/resident/FinancialSummary";
import PaymentHistory from "@/components/resident/PaymentHistory";
import { supabase } from "@/lib/supabase";
import { normalizeBedLabel } from "@/lib/bedLabels";
import {
  isContractSignedAndAccepted,
  getAdmissionDeposit,
  depositStateLabel,
} from "@/lib/contractWorkflow";
import { resolveAuthenticatedResident } from "@/lib/residentPortalAuth";
import { loadResidentPortalData } from "@/lib/residentPortalData";
import {
  isNoticeVisibleToResident,
  type NoticeVisibilityRecord,
} from "@/lib/noticeVisibility";

type GenericRow = Record<string, unknown>;
type PortalNotice = GenericRow & NoticeVisibilityRecord;

type PortalTab =
  | "Overview"
  | "Profile"
  | "Room"
  | "Contract"
  | "Payments"
  | "Notices"
  | "Inspections"
  | "Maintenance";

function text(value: unknown) {
  return value == null ? "" : String(value);
}

function firstText(row: GenericRow | null, keys: string[]) {
  if (!row) return "";

  for (const key of keys) {
    const value = row[key];

    if (
      value !== null &&
      value !== undefined &&
      String(value).trim() !== ""
    ) {
      return String(value);
    }
  }

  return "";
}

function residentName(row: GenericRow | null) {
  return String(row?.full_name || "Resident");
}

function roomName(row: GenericRow | null) {
  return firstText(row, ["room_number"]) || "—";
}

function bedName(row: GenericRow | null) {
  const value = firstText(row, ["bed_number"]);
  return value ? normalizeBedLabel(value) : "—";
}

function money(value: unknown) {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

export default function ResidentPortalPage() {
  const router = useRouter();
  const [resident, setResident] = useState<GenericRow | null>(null);
  const [admission, setAdmission] = useState<GenericRow | null>(null);
  const [room, setRoom] = useState<GenericRow | null>(null);
  const [bed, setBed] = useState<GenericRow | null>(null);
  const [contract, setContract] = useState<GenericRow | null>(null);
  const [bills, setBills] = useState<GenericRow[]>([]);
  const [payments, setPayments] = useState<GenericRow[]>([]);
  const [receipts, setReceipts] = useState<GenericRow[]>([]);
  const [notices, setNotices] = useState<PortalNotice[]>([]);
  const [inspections, setInspections] = useState<GenericRow[]>([]);
  const [maintenance, setMaintenance] = useState<GenericRow[]>([]);
  const [activeTab, setActiveTab] = useState<PortalTab>("Overview");
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const loadPortalData = useCallback(async (residentId: string) => {
    setLoading(true);
    setError("");

    const portalResult = await loadResidentPortalData();
    if (!portalResult.data) {
      setError(portalResult.error);
      setLoading(false);
      return;
    }

    const protectedData = portalResult.data;
    if (protectedData.resident.id !== residentId) {
      setError("Your resident account could not be verified.");
      setLoading(false);
      return;
    }

    const [
      noticesResult,
      noticeRecipientsResult,
      inspectionsResult,
      maintenanceResult,
    ] = await Promise.all([
      supabase
        .from("notices")
        .select("id::text,title,description,notice_type,audience,resident_id,room_id,status,publish_date,expiry_date,priority,pinned,show_as_popup,created_at")
        .eq("status", "Published")
        .order("pinned", { ascending: false })
        .order("publish_date", { ascending: false }),
      supabase
        .from("notice_recipients")
        .select("notice_id::text")
        .eq("resident_id", residentId),
      supabase
        .from("room_inspections")
        .select("*")
        .eq("resident_id", residentId)
        .order("inspection_date", { ascending: false }),
      supabase
        .from("maintenance_requests")
        .select("*")
        .eq("resident_id", residentId)
        .order("created_at", { ascending: false }),
    ]);

    const activeAdmission = protectedData.admission;

    if (
      noticesResult.error ||
      noticeRecipientsResult.error ||
      inspectionsResult.error ||
      maintenanceResult.error
    ) {
      setError("Your portal activity could not be loaded. Please refresh and try again.");
      setLoading(false);
      return;
    }

    const currentRoomId = firstText(activeAdmission, ["room_id"]);
    const selectedNoticeIds = new Set(
      (noticeRecipientsResult.data ?? []).map((row) => text(row.notice_id)),
    );
    const filteredNotices = ((noticesResult.data ?? []) as PortalNotice[]).filter(
      (notice) =>
        isNoticeVisibleToResident(notice, residentId, currentRoomId, undefined, selectedNoticeIds),
    );

    setResident(protectedData.resident);
    setAdmission(activeAdmission);
    setRoom(protectedData.room);
    setBed(protectedData.bed);
    setContract(protectedData.contract);
    setBills(protectedData.bills);
    setPayments(protectedData.payments);
    setReceipts(protectedData.receipts);
    setNotices(filteredNotices);
    setInspections((inspectionsResult.data ?? []) as GenericRow[]);
    setMaintenance((maintenanceResult.data ?? []) as GenericRow[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    let active = true;

    async function initializePortal() {
      setLoading(true);
      setError("");
      setMessage("");

      try {
        const resolved = await resolveAuthenticatedResident();
        if (!active) return;
        if (!resolved.resident) {
          setResident(null);
          setLoading(false);
          setError(
            resolved.error ||
              "No resident record exists for your account. Please contact the hostel administrator.",
          );
          return;
        }

        await loadPortalData(resolved.resident.id);
      } catch {
        if (active) {
          setError("Unable to load your resident portal right now. Please try again.");
          setLoading(false);
        }
      }
    }

    initializePortal();

    return () => {
      active = false;
    };
  }, [loadPortalData]);

  async function logout() {
    setLoading(true);
    setMessage("");
    setError("");
    await supabase.auth.signOut();
    router.replace("/login");
  }

  const isReadOnlyView = false;
  const admissionStatus = firstText(admission, ["status"]);
  const hasActiveAdmission = admissionStatus === "Active";
  const contractSigned = Boolean(firstText(contract, ["resident_signature_url"]));
  const deposit = getAdmissionDeposit(admission, bills, payments);
  const portalTabs: PortalTab[] = hasActiveAdmission
    ? ["Overview", "Profile", "Room", "Contract", "Payments", "Notices", "Inspections", "Maintenance"]
    : ["Overview", "Profile", "Contract", "Payments", "Notices"];

  const verifiedByBill = useMemo(() => {
    const totals = new Map<string, number>();
    for (const payment of payments) {
      if (
        firstText(payment, ["payment_status"])
          .trim()
          .toLowerCase() !== "verified"
      ) {
        continue;
      }

      const billId = firstText(payment, ["bill_id"]);
      totals.set(
        billId,
        (totals.get(billId) ?? 0) + Number(payment.amount || 0)
      );
    }
    return totals;
  }, [payments]);

  if (loading) {
    return (
      <main className="min-h-screen bg-slate-100 p-4 sm:p-6">
        <div className="mx-auto flex min-h-[90vh] max-w-md items-center">
          <section className="w-full rounded-3xl border border-slate-200 bg-white p-8 shadow-xl">
            <div className="flex flex-col items-center justify-center text-center">
              <img src="/logo.jpg" alt="Logo" className="w-20 h-20 rounded-full object-cover shadow-sm mb-4" />
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">
                University Girls Hostel
              </p>
              <h1 className="mt-2 text-3xl font-bold text-slate-900">
                Resident Portal
              </h1>
              <p className="mt-2 text-sm text-slate-500">
                Loading your profile and account details...
              </p>
            </div>
          </section>
        </div>
      </main>
    );
  }

  if (!resident) {
    return (
      <main className="min-h-screen bg-slate-100 p-4 sm:p-6">
        <div className="mx-auto flex min-h-[90vh] max-w-md items-center">
          <section className="w-full rounded-3xl border border-slate-200 bg-white p-8 shadow-xl">
            <div className="flex flex-col items-center justify-center text-center">
              <img src="/logo.jpg" alt="Logo" className="w-20 h-20 rounded-full object-cover shadow-sm mb-4" />
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">
                University Girls Hostel
              </p>
              <h1 className="mt-2 text-3xl font-bold text-slate-900">
                Resident Portal
              </h1>
              <p className="mt-2 text-sm text-slate-500">
                {error || "Sign in with your Supabase account to access your resident portal."}
              </p>
            </div>

            <div className="mt-6 space-y-3">
              <button
                type="button"
                onClick={() => router.replace("/login")}
                className="w-full rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white"
              >
                Go to Login
              </button>
              <button
                type="button"
                onClick={logout}
                className="w-full rounded-xl border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700"
              >
                Logout
              </button>
            </div>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50">
      <ResidentNoticePopup notices={notices} residentId={text(resident.id)} />
      <ResidentDuesPopup
        residentId={text(resident.id)}
        residentName={residentName(resident)}
        roomName={roomName(room)}
        bedName={bedName(bed)}
        admission={admission}
        room={room}
        bed={bed}
        bills={bills}
        payments={payments}
      />
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-4 sm:gap-4 sm:px-6 sm:py-5 lg:px-8">
          <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-4">
            <img src="/logo.jpg" alt="Logo" className="h-11 w-11 shrink-0 rounded-full object-cover shadow-sm sm:h-14 sm:w-14" />
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold uppercase tracking-[0.14em] text-indigo-600 sm:text-sm sm:tracking-[0.2em]">
                University Girls Hostel
              </p>
              <h1 className="mt-0.5 truncate text-xl font-bold text-slate-900 sm:mt-1 sm:text-2xl">
                Resident Portal
              </h1>
              <p className="mt-0.5 truncate text-xs text-slate-500 sm:mt-1 sm:text-sm">
                Welcome, {residentName(resident)}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={logout}
            className="shrink-0 rounded-xl border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 sm:px-4 sm:text-sm"
          >
            Logout
          </button>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-4 px-4 py-4 sm:gap-6 sm:px-6 sm:py-6 lg:grid-cols-[240px_1fr] lg:px-8">
        <aside className="min-w-0 rounded-2xl border border-slate-200 bg-white p-2.5 shadow-sm sm:rounded-3xl sm:p-4 lg:sticky lg:top-6 lg:self-start">
          <nav className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:space-y-1.5 lg:overflow-visible lg:pb-0" aria-label="Resident portal navigation">
            {portalTabs.map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                className={`shrink-0 whitespace-nowrap rounded-xl px-3.5 py-2.5 text-left text-sm font-semibold transition lg:w-full lg:px-4 lg:py-3 ${
                  activeTab === tab
                    ? "bg-indigo-600 text-white shadow-xs"
                    : "text-slate-700 hover:bg-slate-100"
                }`}
              >
                {tab}
              </button>
            ))}
          </nav>
        </aside>

        <section className="min-w-0 space-y-6">
          <Link href="/resident-portal/profile" className="block rounded-2xl border border-indigo-200 bg-indigo-50 px-5 py-4 font-semibold text-indigo-800">Complete Your Profile / View Submitted Details</Link>
          {(message || error) && (
            <div
              className={`rounded-2xl border px-4 py-3 text-sm font-medium ${
                error
                  ? "border-red-200 bg-red-50 text-red-700"
                  : "border-emerald-200 bg-emerald-50 text-emerald-700"
              }`}
            >
              {error || message}
            </div>
          )}

          {activeTab === "Overview" && (
            <>
              {!hasActiveAdmission && (
                <Card title="Pending Onboarding">
                  <InfoGrid
                    items={[
                      ["Admission Status", admissionStatus || "Pending"],
                      ["Contract", contractSigned ? "Signed" : "Unsigned"],
                      ["Security Deposit", depositStateLabel(deposit.state)],
                      ["Overall Status", "Awaiting Admin Activation"],
                    ]}
                  />
                  <p className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                    Your admission requires an approved signature, satisfaction of any required deposit, and admin activation.
                  </p>
                </Card>
              )}
              <div id="financial-summary"><FinancialSummary admission={admission} room={room} bed={bed} bills={bills} payments={payments} /></div>
              
              <Card title="Current Admission">
                <InfoGrid
                  items={[
                    [
                      "Admission Date",
                      firstText(admission, ["admission_date"]).slice(0, 10) || "—",
                    ],
                    [
                      "Expected Leaving",
                      firstText(admission, ["expected_leaving_date"]).slice(0, 10) || "—",
                    ],
                    ["Room", roomName(room)],
                    ["Bed", bedName(bed)],
                    [
                      "Monthly Rent",
                      money(
                        admission?.monthly_rent ??
                          room?.monthly_rent ??

                          0
                      ),
                    ],
                    [
                      "Security Deposit",
                      money(admission?.security_deposit ?? 0),
                    ],
                  ]}
                />
              </Card>
            </>
          )}

          {activeTab === "Profile" && (
            <Card title="My Profile">
              <Link href="/resident-portal/profile" className="mb-4 inline-flex rounded-xl bg-indigo-600 px-4 py-2 font-semibold text-white">Complete Your Profile / View Submitted Details</Link>
              <InfoGrid
                items={[
                  ["Name", residentName(resident)],
                  ["Phone", firstText(resident, ["phone"]) || "—"],
                  ["Email", firstText(resident, ["email"]) || "—"],
                  ["CNIC", firstText(resident, ["cnic"]) || "—"],
                  ["Profile Status", hasActiveAdmission ? "Active Resident" : "Pending Onboarding"],
                  ["Address", firstText(resident, ["permanent_address"]) || "—"],
                ]}
              />
            </Card>
          )}

          {activeTab === "Room" && (
            <Card title="My Room">
              <InfoGrid
                items={[
                  ["Room", roomName(room)],
                  ["Bed", bedName(bed)],
                  ["Room Type", firstText(room, ["room_type"]) || "—"],
                  ["Bed Type", firstText(bed, ["bed_number"]) || "—"],
                  [
                    "Monthly Rent",
                    money(
                      admission?.monthly_rent ??
                        room?.monthly_rent ??

                        0
                    ),
                  ],
                  [
                    "Admission Status",
                    firstText(admission, ["status"]) || "Active",
                  ],
                ]}
              />
            </Card>
          )}

          {activeTab === "Contract" && (
            <Card title="My Contract">
              <InfoGrid
                items={[
                  ["Contract Number", firstText(contract, ["contract_number"]) || "—"],
                  ["Start Date", firstText(contract, ["start_date"]).slice(0, 10) || "—"],
                  ["End Date", firstText(contract, ["end_date"]).slice(0, 10) || "—"],
                  ["Monthly Rent", money(contract?.monthly_rent ?? admission?.monthly_rent ?? 0)],
                  ["Security Deposit", money(contract?.security_deposit ?? admission?.security_deposit ?? 0)],
                  ["Status", firstText(contract, ["status"]) || "—"],
                  [
                    "Resident Signature",
                    firstText(contract, ["resident_signature_url"]) ? "Signed" : "Pending",
                  ],
                  [
                    "Owner Signature",
                    firstText(contract, ["owner_signature_status"]) === "Pending"
                      ? "Signed"
                      : firstText(contract, ["owner_signature_status"]) || "Signed",
                  ],
                ]}
              />

              {firstText(contract, ["contract_content"]) && (
                <div className="mt-5 rounded-2xl bg-slate-50 p-4 text-sm text-slate-700">
                  {firstText(contract, ["contract_content"])}
                </div>
              )}
              <Link
                href="/resident-portal/contract"
                className="mt-5 inline-flex w-full justify-center rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white sm:w-auto"
              >
                {firstText(contract, ["status"]) === "Active"
                  ? "View Active Contract"
                  : "Review and Sign Contract"}
              </Link>
            </Card>
          )}

          {activeTab === "Payments" && (
            <>
              <Card title="Security Deposit">
                {bills.filter(b => b.bill_type === "Security Deposit").length === 0 ? (
                  <EmptyState text="No security deposit on record." />
                ) : (
                  bills.filter(b => b.bill_type === "Security Deposit").map(dep => (
                    <div key={text(dep.id)} className="mb-4 rounded-xl border border-indigo-100 bg-indigo-50/50 p-4 last:mb-0">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <p className="font-semibold text-slate-900">Security Deposit Bill ({text(dep.bill_number)})</p>
                          <p className="mt-1 text-sm text-slate-600">Total: Rs {money(dep.total_amount)} | Balance: Rs {money(dep.balance_amount)}</p>
                          <p className="mt-1 text-sm font-medium">
                            Status: <span className={dep.bill_status === "Paid" ? "text-emerald-600" : "text-amber-600"}>{text(dep.bill_status)}</span>
                          </p>
                        </div>
                        {dep.bill_status !== "Paid" && (
                          <Link href="/resident-portal/payments" className="inline-flex items-center justify-center rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700 sm:shrink-0">
                            Submit Proof
                          </Link>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </Card>

              <Card title="My Bills">
                <DataTable
                  headers={["Bill No.", "Month", "Total", "Paid", "Balance", "Due Date", "Status"]}
                  rows={bills.map((bill) => [
                    firstText(bill, ["bill_number"]) || "—",
                    firstText(bill, ["billing_month"]).slice(0, 7) || "—",
                    money(bill.total_amount),
                    money(verifiedByBill.get(text(bill.id)) ?? 0),
                    money(
                      Math.max(
                        Number(bill.total_amount || 0) -
                          (verifiedByBill.get(text(bill.id)) ?? 0),
                        0
                      )
                    ),
                    firstText(bill, ["due_date"]).slice(0, 10) || "—",
                    firstText(bill, ["bill_status"]) || "Pending",
                  ])}
                />

                {!isReadOnlyView && (
                  <div className="mt-6 flex flex-col gap-3 rounded-2xl border border-slate-200 p-4 sm:flex-row sm:flex-wrap sm:p-5">
                    <Link href="/resident-portal/bills" className="rounded-xl border border-indigo-200 px-5 py-3 text-center text-sm font-semibold text-indigo-700">
                      Open My Bills
                    </Link>
                    <Link href="/resident-portal/payments" className="rounded-xl bg-indigo-600 px-5 py-3 text-center text-sm font-semibold text-white">
                      Upload Payment Receipt
                    </Link>
                  </div>
                )}
              </Card>

              <PaymentHistory
                admission={admission}
                room={room}
                bed={bed}
                bills={bills}
                payments={payments}
                receipts={receipts}
                onViewFinancialSummary={() => {
                  setActiveTab("Overview");
                  window.setTimeout(() => document.getElementById("financial-summary")?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
                }}
              />
            </>
          )}

          {activeTab === "Notices" && (
            <Card title="Notices">
              <div className="space-y-4">
                {notices.length === 0 ? (
                  <EmptyState text="No notices available." />
                ) : (
                  notices.map((notice) => (
                    <article key={text(notice.id)} className="rounded-2xl border border-slate-200 p-4 sm:p-5">
                      <div className="flex flex-wrap items-center gap-2">
                        {Boolean(notice.pinned) && <span>📌</span>}

                        <h3 className="text-lg font-bold text-slate-900">
                          {firstText(notice, ["title"]) || "Notice"}
                        </h3>
                      </div>

                      <p className="mt-2 text-sm leading-6 text-slate-600">
                        {firstText(notice, ["description"])}
                      </p>

                      <p className="mt-3 text-xs text-slate-500">
                        Published: {firstText(notice, ["publish_date"]).slice(0, 10) || "—"}
                      </p>
                    </article>
                  ))
                )}
              </div>
            </Card>
          )}

          {activeTab === "Inspections" && (
            <Card title="Inspection History">
              <DataTable
                headers={["Inspection No.", "Date", "Type", "Overall Condition", "Status", "Action"]}
                rows={inspections.map((inspection) => [
                  firstText(inspection, ["inspection_number"]) || "—",
                  firstText(inspection, ["inspection_date"]).slice(0, 10) || "—",
                  firstText(inspection, ["inspection_type"]) || "Routine",
                  firstText(inspection, ["overall_status"]) || "Good",
                  firstText(inspection, ["status"]) || "Completed",
                  <Link
                    key={text(inspection.id)}
                    href={`/resident-portal/inspections/${inspection.id}`}
                    className="inline-flex items-center rounded-lg bg-indigo-50 px-3 py-1.5 text-xs font-bold text-indigo-700 hover:bg-indigo-100 transition"
                  >
                    View Report →
                  </Link>,
                ])}
              />
              {!isReadOnlyView && (
                <Link href="/resident-portal/inspections" className="mt-5 inline-flex w-full justify-center rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700 sm:w-auto">
                  View Full Inspection History
                </Link>
              )}
            </Card>
          )}

          {activeTab === "Maintenance" && (
            <Card title="Maintenance Requests">
              <DataTable
                headers={["Request No.", "Date", "Category", "Priority", "Status"]}
                rows={maintenance.map((request) => [
                  firstText(request, ["request_number"]) || "—",
                  firstText(request, ["complaint_date", "created_at"]).slice(0, 10) || "—",
                  firstText(request, ["category"]) || "Other",
                  firstText(request, ["priority"]) || "Medium",
                  firstText(request, ["status"]) || "Pending",
                ])}
              />

              {!isReadOnlyView && (
                <Link href="/resident-portal/maintenance" className="mt-5 inline-flex w-full justify-center rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white sm:w-auto">
                  Submit or View Maintenance Requests
                </Link>
              )}
            </Card>
          )}
        </section>
      </div>
    </main>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:rounded-3xl sm:p-6">
      <h2 className="mb-4 text-lg font-bold text-slate-900 sm:mb-5 sm:text-xl">{title}</h2>
      {children}
    </section>
  );
}


function InfoGrid({ items }: { items: [string, string][] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3">
      {items.map(([label, value]) => (
        <article key={label} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
          <p className="mt-2 break-words font-semibold text-slate-900">{value}</p>
        </article>
      ))}
    </div>
  );
}

function DataTable({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200">
      <table className="min-w-full divide-y divide-slate-200">
        <thead className="bg-slate-50">
          <tr>
            {headers.map((heading) => (
              <th key={heading} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-slate-500">
                {heading}
              </th>
            ))}
          </tr>
        </thead>

        <tbody className="divide-y divide-slate-100 bg-white">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={headers.length} className="px-4 py-10 text-center text-sm text-slate-500">
                No records found.
              </td>
            </tr>
          ) : (
            rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((column, columnIndex) => (
                  <td key={`${rowIndex}-${columnIndex}`} className="whitespace-nowrap px-4 py-3 text-sm text-slate-700">
                    {column}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function EmptyState({ text: label }: { text: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">
      {label}
    </div>
  );
}
