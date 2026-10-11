"use client";
import StaffAllocationEditor from "@/components/payments/StaffAllocationEditor";
import { readStaffCorrections } from "@/lib/staffCorrectionHistory";
import RentCorrectionContext, { type RentCorrection } from "@/components/payments/RentCorrectionContext";
import { readDashboardRows } from "@/lib/dashboardRead";
import { receiptDisplayStatus } from "@/lib/receiptDisplayStatus";
import HistoricalEvidence from "@/components/payments/HistoricalEvidence";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ADDITIONAL_CATEGORIES, additionalChargeError, type AdditionalCharge } from "@/lib/additionalCharges";
import { receiptAllocation } from "@/lib/paymentObligations";
import PaymentsNavigation from "@/components/payments/PaymentsNavigation";
import { supabase } from "@/lib/supabase";
import { getSupabaseErrorMessage } from "@/lib/supabaseErrors";
import {
  allocatedPaymentLabel,
  rentPeriodLabel,
  isSecurityDepositReceipt,
  securityDepositAdmissionId,
  residentReceiptNotes,
} from "@/lib/paymentReceiptPurpose";

type GenericRow = Record<string, unknown>;

type ReceiptStatus =
  | "Pending Verification"
  | "Verified"
  | "Rejected";

type PaymentReceipt = {
  additional_charge?: AdditionalCharge | null;
  id: string;
  resident_id: string;
  bill_id: string | null;
  receipt_url: string;
  reference_number: string | null;
  amount: number;
  status: ReceiptStatus;
  verified_by: string | null;
  verified_at: string | null;
  notes: string | null;
  remarks: string | null;
  payment_id?: string | null;
  late_fee_payment_allocations?: { payment_id: string }[];
  created_at: string;
};

type PaymentAllocation = { payment_id: string; bill_id: string; amount: number };

const inputClass =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100";

function text(value: unknown) {
  return value == null ? "" : String(value);
}

function firstText(row: GenericRow | undefined, keys: string[]) {
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

function residentName(row: GenericRow | undefined) {
  return String(row?.full_name || "Resident");
}

function money(value: unknown) {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function statusClass(status: ReceiptStatus | "Cancelled") {
  if (status === "Cancelled") return "bg-slate-100 text-slate-700";
  if (status === "Verified") {
    return "bg-emerald-100 text-emerald-700";
  }

  if (status === "Rejected") {
    return "bg-red-100 text-red-700";
  }

  return "bg-amber-100 text-amber-700";
}

function receiptPaymentMethod(notes: string | null) {
  const match = notes?.match(/^Payment method:\s*(.+)$/im);
  return match?.[1]?.trim() || "Receipt submission";
}

function receiptNotes(receipt: PaymentReceipt) {
  const submittedNotes = residentReceiptNotes(receipt.notes);
  return [
    submittedNotes,
    receipt.remarks ? `Review: ${receipt.remarks}` : "",
  ]
    .filter(Boolean)
    .join(" | ") || "—";
}

async function getValidAccessToken() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session?.access_token) return session.access_token;

  const {
    data: { session: refreshedSession },
  } = await supabase.auth.refreshSession();
  return refreshedSession?.access_token ?? null;
}

export default function PaymentVerificationPage() {
  const [confirmations, setConfirmations] = useState<Record<string, { amount: string; category: string; description: string; confirmed: boolean }>>({});
  const [receipts, setReceipts] = useState<PaymentReceipt[]>([]);
  const [residents, setResidents] = useState<GenericRow[]>([]);
  const [payments, setPayments] = useState<GenericRow[]>([]);
  const [allocations, setAllocations] = useState<PaymentAllocation[]>([]);
  const [followupBills,setFollowupBills]=useState<Array<{bill_id:string;purpose:string;original:number;verified:number;remaining:number;followups:Array<{receipt_id:string;due_date:string;note:string;amount:number}>}>>([]);
  const [bills, setBills] = useState<GenericRow[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [corrections, setCorrections] = useState<RentCorrection[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");

    const [
      receiptsResult,
      residentsResult,
      billsResult,
      paymentsResult,
      allocationsResult,
      followupsResult,
      correctionsResult,
    ] = await Promise.all([
      readDashboardRows(supabase.from("payment_receipts").select("*,late_fee_payment_allocations(payment_id)").order("created_at", { ascending: false }).order("id")),
      supabase.from("residents").select("*"),
      readDashboardRows(supabase.from("bills").select("*").order("id")),
      readDashboardRows(supabase.from("payments").select("id,resident_id,bill_id,amount,payment_status").order("id")),
      readDashboardRows(supabase.from("payment_allocations").select("payment_id,bill_id,amount").order("payment_id").order("bill_id")),
      supabase.rpc("payment_followup_data"),
      readStaffCorrections(),
    ]);

    const firstError =
      receiptsResult.error ||
      residentsResult.error ||
      billsResult.error || paymentsResult.error || allocationsResult.error || followupsResult.error;

    if (firstError) {
      setError(getSupabaseErrorMessage(firstError, "Payment receipts could not be loaded."));
    } else {
      if (correctionsResult.error) setError("Payment receipts loaded. Correction history is unavailable for this session.");
      setCorrections((correctionsResult.data ?? []) as RentCorrection[]);
      setReceipts((receiptsResult.data ?? []) as PaymentReceipt[]);
      setResidents((residentsResult.data ?? []) as GenericRow[]);
      setBills((billsResult.data ?? []) as GenericRow[]);
      setPayments(paymentsResult.data ?? []);
      setAllocations((allocationsResult.data ?? []) as PaymentAllocation[]);
      setFollowupBills(followupsResult.data || []);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [refresh]);

  const displayStatus = useCallback((receipt: PaymentReceipt) => receiptDisplayStatus(receipt, payments), [payments]);

  const filteredReceipts = useMemo(() => {
    const query = search.trim().toLowerCase();

    return receipts.filter((receipt) => {
      const resident = residents.find(
        (item) => text(item.id) === receipt.resident_id
      );

      const bill = bills.find(
        (item) => text(item.id) === receipt.bill_id
      );

      const searchable = [
        residentName(resident),
        receipt.reference_number ?? "",
        firstText(bill, ["bill_number"]),
        !receipt.bill_id && isSecurityDepositReceipt(receipt.notes)
          ? "Security Deposit"
          : "",
      ]
        .join(" ")
        .toLowerCase();

      const matchesSearch =
        !query || searchable.includes(query);

      const matchesStatus =
        statusFilter === "All" ||
        displayStatus(receipt) === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [bills, receipts, residents, search, statusFilter, displayStatus]);

  const summary = useMemo(
    () => ({
      total: receipts.length,
      cancelled: receipts.filter(item => displayStatus(item) === "Cancelled").length,
      pending: receipts.filter(
        (item) => displayStatus(item) === "Pending Verification"
      ).length,
      verified: receipts.filter(
        (item) => displayStatus(item) === "Verified"
      ).length,
      rejected: receipts.filter(
        (item) => displayStatus(item) === "Rejected"
      ).length,
    }),
    [receipts, displayStatus]
  );

  async function updateReceiptStatus(
    receipt: PaymentReceipt,
    nextStatus: "Verified" | "Rejected"
  ) {
    if (displayStatus(receipt) !== "Pending Verification") return;
    const rejectionReason =
      nextStatus === "Rejected"
        ? window.prompt("Enter the reason for rejecting this receipt:")?.trim()
        : "";
    if (nextStatus === "Rejected" && !rejectionReason) return;

    const additionalConfirmation = confirmations[receipt.id];
    if (nextStatus === "Verified" && receipt.additional_charge) {
      const invalid = additionalChargeError(additionalConfirmation?.amount, additionalConfirmation?.category, additionalConfirmation?.description);
      if (!additionalConfirmation?.confirmed || invalid) { setError(invalid || "Confirm the Additional Charges against the receipt before verifying."); return; }
    }
    setUpdatingId(receipt.id);
    setMessage("");
    setError("");

    try {
      const accessToken = await getValidAccessToken();
      if (!accessToken) {
        throw new Error(
          "Your admin session could not be verified. Please sign in again.",
        );
      }

      const response = await fetch("/api/payment-verification", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          receiptId: receipt.id,
          action: nextStatus === "Verified" ? "Verify" : "Reject",
          rejectionReason,
          additionalConfirmation,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { message?: string; error?: string; notificationWarning?: boolean }
        | null;
      if (!response.ok) {
        throw new Error(
          payload?.error || "The receipt verification request failed.",
        );
      }

      setMessage(
        `${payload?.message || "Receipt status updated successfully."}${
          payload?.notificationWarning
            ? " The record was saved, but its notification could not be delivered."
            : ""
        }`,
      );
      await refresh();
    } catch (updateError) {
      setError(
        updateError instanceof Error
          ? updateError.message
          : "The receipt verification request failed.",
      );
    } finally {
      setUpdatingId(null);
    }
  }
  return (
    <main className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">
            University Girls Hostel
          </p>

          <h1 className="mt-2 text-3xl font-bold text-slate-900">
            Payment Verification
          </h1>

          <p className="mt-1 text-sm text-slate-500">
            Verify or reject resident payment receipts.
          </p>
        </section>

        <details className="rounded-xl border bg-white"><summary className="cursor-pointer px-4 py-3 font-semibold text-slate-700">Historical Payment Evidence (Non-ledger)</summary><HistoricalEvidence staff /></details>
        <PaymentsNavigation active="verification" />

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

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard label="Total Receipts" value={String(summary.total)} />
          <StatCard label="Pending" value={String(summary.pending)} />
          <StatCard label="Verified" value={String(summary.verified)} />
          <StatCard label="Rejected" value={String(summary.rejected)} />
          <StatCard label="Cancelled" value={String(summary.cancelled)} />
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
          <div className="grid gap-3 border-b border-slate-200 p-5 lg:grid-cols-[1fr_220px_auto]">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className={inputClass}
              placeholder="Search resident, purpose or reference"
            />

            <select
              value={statusFilter}
              onChange={(event) =>
                setStatusFilter(event.target.value)
              }
              className={inputClass}
            >
              <option value="All">All Statuses</option>
              <option value="Pending Verification">
                Pending Verification
              </option>
              <option value="Verified">Verified</option>
              <option value="Cancelled">Cancelled</option>
              <option value="Rejected">Rejected</option>
            </select>

            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700"
            >
              Refresh
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  {[
                    "Resident",
                    "Payment For",
                    "Billing Month",
                    "Amount",
                    "Method",
                    "Submitted",
                    "Receipt",
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
                      colSpan={9}
                      className="px-5 py-12 text-center text-sm text-slate-500"
                    >
                      Loading receipts...
                    </td>
                  </tr>
                ) : filteredReceipts.length === 0 ? (
                  <tr>
                    <td
                      colSpan={9}
                      className="px-5 py-12 text-center text-sm text-slate-500"
                    >
                      No payment receipts found.
                    </td>
                  </tr>
                ) : (
                  filteredReceipts.map((receipt) => {
                    const resident = residents.find(
                      (item) =>
                        text(item.id) === receipt.resident_id
                    );

                    const bill = bills.find(
                      (item) => text(item.id) === receipt.bill_id
                    );

                    const paymentAllocationRows = receipt.payment_id
                      ? allocations.filter((allocation) => allocation.payment_id === receipt.payment_id)
                      : [];
                    const allocationBills = paymentAllocationRows
                      .map((allocation) => bills.find((item) => text(item.id) === allocation.bill_id))
                      .filter(Boolean);

                    const extra = receipt.additional_charge;
                    const confirmation = confirmations[receipt.id] ?? { amount: String(extra?.amount ?? ""), category: extra?.category ?? ADDITIONAL_CATEGORIES[0], description: extra?.description ?? "", confirmed: false };
                    const editConfirmation = (change: Partial<typeof confirmation>) => setConfirmations(current => ({ ...current, [receipt.id]: { ...confirmation, ...change } }));
                    const allocation = bill ? receiptAllocation(bill, payments.filter(payment => payment.id !== receipt.payment_id), Number(receipt.amount)) : null;
                    return (
                      <tr
                        key={receipt.id}
                        className="align-top hover:bg-slate-50/70"
                      >
                        <td className="px-3 py-3">
                          <p className="font-semibold text-slate-900">
                            {residentName(resident)}
                          </p>

                          <p className="mt-1 text-xs text-slate-500">
                            {receipt.created_at.slice(0, 10)}
                          </p>
                        </td>

                        <td className="px-3 py-3 text-sm text-slate-700">
                          <p className="font-medium">{corrections.some(c => c.original_payment_id === receipt.payment_id) && "Historical allocation: "}{paymentAllocationRows.length
                            ? allocatedPaymentLabel(paymentAllocationRows,bills)
                            : !receipt.bill_id && isSecurityDepositReceipt(receipt.notes) ? 'Security Deposit' : firstText(bill,['bill_type'])==='Rent' ? rentPeriodLabel(bill?.billing_month) : firstText(bill,['bill_type']) || 'Bill payment'}</p>
                          {paymentAllocationRows.length>1 && <div className="mt-1 text-xs text-slate-500">{paymentAllocationRows.map(a=><p key={a.bill_id}>{bills.find(b=>b.id===a.bill_id)?.bill_type==='Other Charges'?'Additional Charges':String(bills.find(b=>b.id===a.bill_id)?.bill_type || 'Bill')}: {money(a.amount)}</p>)}</div>}
                          <p className="mt-1 line-clamp-1 max-w-56 break-words text-xs text-slate-500">{receiptNotes(receipt)}</p>
                          <RentCorrectionContext paymentId={receipt.payment_id} corrections={corrections} payments={payments} allocations={allocations} bills={bills} />
                          <details className="mt-2 max-w-md">
                            <summary className="cursor-pointer text-xs font-semibold text-indigo-700">View Details{extra && displayStatus(receipt)==='Pending Verification' ? ' / Classify Additional Charges' : ''}</summary>
                            <div className="mt-2 max-h-96 space-y-2 overflow-y-auto break-words rounded-lg border bg-white p-3 text-sm">
                              <p>Receipt Verification: {receipt.status}</p>
                              <p>Receipt verified by: {receipt.verified_by || "unavailable"} / At: {receipt.verified_at || "unavailable"}</p>
                              {displayStatus(receipt) === "Cancelled" && <p>Payment Status: Cancelled. This payment is not credited.</p>}
                              <p>Reference: {receipt.reference_number || '\u2014'}</p>
                              <p className="break-all">Admission: {firstText(bill,['admission_id']) || firstText(allocationBills[0],['admission_id']) || securityDepositAdmissionId(receipt.notes) || '\u2014'}</p>
                              {paymentAllocationRows.map(a=><p className="break-all" key={a.bill_id}>Bill: {a.bill_id} / {money(a.amount)}</p>)}

                          <p className="whitespace-pre-wrap break-words">{receiptNotes(receipt) || "No notes"}</p>
                          {followupBills.filter(b=>receipt.bill_id===b.bill_id || paymentAllocationRows.some(a=>a.bill_id===b.bill_id)).map(b=><div key={b.bill_id} className="mt-2 rounded border p-2">
                            <h4 className="font-semibold text-slate-900">{b.purpose === 'Other Charges' ? 'Additional Charges' : b.purpose}{b.purpose === 'Rent' && firstText(bills.find(item=>text(item.id)===b.bill_id),['billing_month']) ? ' — '+new Date(firstText(bills.find(item=>text(item.id)===b.bill_id),['billing_month']).slice(0,7)+'-01T12:00:00Z').toLocaleDateString('en-GB',{month:'long',year:'numeric',timeZone:'UTC'}) : ''}</h4>
                            <p>{b.purpose === 'Security Deposit' ? 'Total Deposit' : b.purpose === 'Rent' ? 'Total Rent' : 'Total Bill'}: {money(b.original)}</p>
                            <p>Previously Verified: {money(Math.max(Number(b.verified)-(displayStatus(receipt)==="Verified" ? Number(paymentAllocationRows.find(a=>a.bill_id===b.bill_id)?.amount ?? (receipt.bill_id===b.bill_id ? receipt.amount : 0)) : 0),0))}</p>
                            <p>This Payment: {money(paymentAllocationRows.find(a=>a.bill_id===b.bill_id)?.amount ?? (receipt.bill_id===b.bill_id ? receipt.amount : 0))}</p>
                            <p className="font-semibold">{displayStatus(receipt)==="Pending Verification" ? "Balance After Verification" : "Remaining Balance"}: {money(Math.max(Number(b.remaining)-(displayStatus(receipt)==="Pending Verification" ? Number(paymentAllocationRows.find(a=>a.bill_id===b.bill_id)?.amount ?? (receipt.bill_id===b.bill_id ? receipt.amount : 0)) : 0),0))}</p>
                            {b.followups.filter(f=>f.receipt_id===receipt.id).map((f,i)=><div key={i} className="mt-2 border-t pt-2"><p>Payment Plan: {money(f.amount)} due by {new Date(f.due_date+'T12:00:00Z').toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric',timeZone:'UTC'})}</p><p>Reason: {f.note}</p></div>)}
                          </div>)}
                          {extra && <div className="mt-3 min-w-56 space-y-2 rounded-lg border p-3">
                            {paymentAllocationRows.map(item => <p key={item.bill_id}>{bills.find(b => b.id === item.bill_id)?.bill_type === "Other Charges" ? "Additional Charges" : String(bills.find(b => b.id === item.bill_id)?.bill_type || "Bill")}: {money(item.amount)}</p>)}
                            <p>Declared Additional Charges: {money(extra.amount)} + {extra.category}</p>
                            <p>Description: {extra.description || "None"}</p>
                            <p className="font-semibold">Submitted Total: {money(receipt.amount)}</p>
                            {extra.confirmed && <p>Staff classification: {extra.confirmed.category} + {money(extra.confirmed.amount)} + {extra.confirmed.description}</p>}
                            {displayStatus(receipt) === "Pending Verification" && <>
                              <label className="block">Confirm Additional Amount (PKR)<input type="number" min="0.01" step="0.01" value={confirmation.amount} onChange={e => editConfirmation({ amount: e.target.value, confirmed: false })} className={inputClass} /></label>
                              <label className="block">Confirm Category<select value={confirmation.category} onChange={e => editConfirmation({ category: e.target.value, confirmed: false })} className={inputClass}>{ADDITIONAL_CATEGORIES.map(category => <option key={category}>{category}</option>)}</select></label>
                              <label className="block">Description<input maxLength={500} value={confirmation.description} onChange={e => editConfirmation({ description: e.target.value, confirmed: false })} className={inputClass} /></label>
                              <label className="flex gap-2"><input type="checkbox" checked={confirmation.confirmed} onChange={e => editConfirmation({ confirmed: e.target.checked })} />I checked the receipt total and confirm this classification.</label>
                            </>}
                          </div>}

                            </div>
                          </details>
                        </td>

                        <td className="px-3 py-3 text-sm text-slate-700">
                          {paymentAllocationRows.length > 0
                            ? [...new Set(allocationBills.map((item) => firstText(item, ["billing_month"])).filter(Boolean))].join(" + ") || "—"
                            : firstText(bill, ["billing_month"]) || "—"}
                        </td>

                        <td className="px-3 py-3 text-sm font-semibold text-slate-900">
                          {money(receipt.amount)}
                        </td>

                        <td className="px-3 py-3 text-sm text-slate-700">
                          {receiptPaymentMethod(receipt.notes)}
                        </td>

                        <td className="px-3 py-3 text-sm text-slate-700">
                          {new Date(receipt.created_at).toLocaleString("en-PK")}
                        </td>

                        <td className="px-3 py-3">
                          <button
                            type="button"
                            onClick={async () => {
                              const storedPath = receipt.receipt_url;
                              if (/^https?:\/\//i.test(storedPath)) {
                                window.open(storedPath, "_blank", "noopener,noreferrer");
                                return;
                              }
                              const { data, error } = await supabase.storage
                                .from("payment-receipts")
                                .createSignedUrl(storedPath, 60 * 5);
                              if (error || !data?.signedUrl) {
                                setError(getSupabaseErrorMessage(error, "Unable to open this receipt."));
                                return;
                              }
                              window.open(data.signedUrl, "_blank", "noopener,noreferrer");
                            }}
                            className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700"
                          >
                            Open Receipt
                          </button>
                        </td>

                        <td className="px-3 py-3">
                          <span
                            className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${statusClass(
                              displayStatus(receipt)
                            )}`}
                          >
                            {corrections.some(c => c.original_payment_id === receipt.payment_id) ? "Corrected" : displayStatus(receipt)}
                          </span>
                        </td>

                        <td className="px-3 py-3">
                          <div className="flex flex-wrap gap-2">
                            {displayStatus(receipt) === "Pending Verification" && (
                              <button
                                type="button"
                                disabled={updatingId === receipt.id}
                                onClick={() =>
                                  void updateReceiptStatus(
                                    receipt,
                                    "Verified"
                                  )
                                }
                                className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50"
                              >
                                {updatingId === receipt.id ? "Verifying..." : "Verify Receipt"}
                              </button>
                            )}

                            {displayStatus(receipt) === "Pending Verification" && !receipt.additional_charge && !receipt.late_fee_payment_allocations?.length && (
                              <StaffAllocationEditor paymentId={receipt.payment_id} receiptId={receipt.id} onSaved={() => void refresh()} />
                            )}

                            {displayStatus(receipt) === "Pending Verification" && (
                              <button
                                type="button"
                                disabled={updatingId === receipt.id}
                                onClick={() =>
                                  void updateReceiptStatus(
                                    receipt,
                                    "Rejected"
                                  )
                                }
                                className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                              >
                                Reject
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
      </div>
    </main>
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
      <p className="mt-2 text-2xl font-bold text-slate-900">
        {value}
      </p>
    </article>
  );
}
