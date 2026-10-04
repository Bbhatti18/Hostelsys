"use client";

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

function statusClass(status: ReceiptStatus) {
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
  const [bills, setBills] = useState<GenericRow[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");

    const [
      receiptsResult,
      residentsResult,
      billsResult,
      paymentsResult,
      allocationsResult,
    ] = await Promise.all([
      supabase
        .from("payment_receipts")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase.from("residents").select("*"),
      supabase.from("bills").select("*"),
      supabase.from("payments").select("id,bill_id,amount,payment_status"),
      supabase.from("payment_allocations").select("payment_id,bill_id,amount"),
    ]);

    const firstError =
      receiptsResult.error ||
      residentsResult.error ||
      billsResult.error || paymentsResult.error || allocationsResult.error;

    if (firstError) {
      setError(getSupabaseErrorMessage(firstError, "Payment receipts could not be loaded."));
    } else {
      setReceipts((receiptsResult.data ?? []) as PaymentReceipt[]);
      setResidents((residentsResult.data ?? []) as GenericRow[]);
      setBills((billsResult.data ?? []) as GenericRow[]);
      setPayments(paymentsResult.data ?? []);
      setAllocations((allocationsResult.data ?? []) as PaymentAllocation[]);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [refresh]);

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
        receipt.status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [bills, receipts, residents, search, statusFilter]);

  const summary = useMemo(
    () => ({
      total: receipts.length,
      pending: receipts.filter(
        (item) => item.status === "Pending Verification"
      ).length,
      verified: receipts.filter(
        (item) => item.status === "Verified"
      ).length,
      rejected: receipts.filter(
        (item) => item.status === "Rejected"
      ).length,
    }),
    [receipts]
  );

  async function updateReceiptStatus(
    receipt: PaymentReceipt,
    nextStatus: "Verified" | "Rejected"
  ) {
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

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Total Receipts" value={String(summary.total)} />
          <StatCard label="Pending" value={String(summary.pending)} />
          <StatCard label="Verified" value={String(summary.verified)} />
          <StatCard label="Rejected" value={String(summary.rejected)} />
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
                    "Admission / Allocation",
                    "Billing Month",
                    "Amount",
                    "Method",
                    "Reference",
                    "Submitted",
                    "Notes",
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
                      colSpan={12}
                      className="px-5 py-12 text-center text-sm text-slate-500"
                    >
                      Loading receipts...
                    </td>
                  </tr>
                ) : filteredReceipts.length === 0 ? (
                  <tr>
                    <td
                      colSpan={12}
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
                        className="hover:bg-slate-50/70"
                      >
                        <td className="px-5 py-4">
                          <p className="font-semibold text-slate-900">
                            {residentName(resident)}
                          </p>

                          <p className="mt-1 text-xs text-slate-500">
                            {receipt.created_at.slice(0, 10)}
                          </p>
                        </td>

                        <td className="px-5 py-4 text-sm text-slate-700">
                          {paymentAllocationRows.length > 1
                            ? allocationBills.map(item => item?.bill_type === "Other Charges" && extra ? "Additional Charges" : String(item?.bill_type || "Bill payment")).join(" + ")
                            : !receipt.bill_id && isSecurityDepositReceipt(receipt.notes)
                            ? "Security Deposit"
                            : firstText(bill, ["bill_number"]) || "No bill"}
                        </td>

                        <td className="px-5 py-4 text-sm text-slate-700">
                          {paymentAllocationRows.length > 1
                            ? allocationBills.map((item) => firstText(item, ["bill_number"])).filter(Boolean).join(" + ")
                            : firstText(bill, ["admission_id"]) || securityDepositAdmissionId(receipt.notes) || "—"}
                        </td>

                        <td className="px-5 py-4 text-sm text-slate-700">
                          {paymentAllocationRows.length > 1
                            ? [...new Set(allocationBills.map((item) => firstText(item, ["billing_month"])).filter(Boolean))].join(" + ") || "—"
                            : firstText(bill, ["billing_month"]) || "—"}
                        </td>

                        <td className="px-5 py-4 text-sm font-semibold text-slate-900">
                          {money(receipt.amount)}
                        </td>

                        <td className="px-5 py-4 text-sm text-slate-700">
                          {receiptPaymentMethod(receipt.notes)}
                        </td>

                        <td className="px-5 py-4 text-sm text-slate-700">
                          {receipt.reference_number || "—"}
                        </td>

                        <td className="px-5 py-4 text-sm text-slate-700">
                          {new Date(receipt.created_at).toLocaleString("en-PK")}
                        </td>

                        <td className="max-w-xs px-5 py-4 text-sm text-slate-700">
                          {receiptNotes(receipt)}
                          {extra && <div className="mt-3 min-w-56 space-y-2 rounded-lg border p-3">
                            {paymentAllocationRows.map(item => <p key={item.bill_id}>{bills.find(b => b.id === item.bill_id)?.bill_type === "Other Charges" ? "Additional Charges" : String(bills.find(b => b.id === item.bill_id)?.bill_type || "Bill")}: {money(item.amount)}</p>)}
                            <p>Declared Additional Charges: {money(extra.amount)} + {extra.category}</p>
                            <p>Description: {extra.description || "None"}</p>
                            <p className="font-semibold">Submitted Total: {money(receipt.amount)}</p>
                            {extra.confirmed && <p>Staff classification: {extra.confirmed.category} + {money(extra.confirmed.amount)} + {extra.confirmed.description}</p>}
                            {receipt.status === "Pending Verification" && <>
                              <label className="block">Confirm Additional Amount (PKR)<input type="number" min="0.01" step="0.01" value={confirmation.amount} onChange={e => editConfirmation({ amount: e.target.value, confirmed: false })} className={inputClass} /></label>
                              <label className="block">Confirm Category<select value={confirmation.category} onChange={e => editConfirmation({ category: e.target.value, confirmed: false })} className={inputClass}>{ADDITIONAL_CATEGORIES.map(category => <option key={category}>{category}</option>)}</select></label>
                              <label className="block">Description<input maxLength={500} value={confirmation.description} onChange={e => editConfirmation({ description: e.target.value, confirmed: false })} className={inputClass} /></label>
                              <label className="flex gap-2"><input type="checkbox" checked={confirmation.confirmed} onChange={e => editConfirmation({ confirmed: e.target.checked })} />I checked the receipt total and confirm this classification.</label>
                            </>}
                          </div>}
                        </td>

                        <td className="px-5 py-4">
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

                        <td className="px-5 py-4">
                          <span
                            className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${statusClass(
                              receipt.status
                            )}`}
                          >
                            {receipt.status}
                          </span>
                        </td>

                        <td className="px-5 py-4">
                          <div className="flex flex-wrap gap-2">
                            {receipt.status === "Pending Verification" && <button
                              type="button"
                              disabled={updatingId === receipt.id}
                              onClick={() =>
                                void updateReceiptStatus(
                                  receipt,
                                  "Verified"
                                )
                              }
                              className="rounded-lg border border-emerald-200 px-3 py-2 text-xs font-semibold text-emerald-700 disabled:opacity-50"
                            >
                              Verify
                            </button>}

                            {receipt.status === "Pending Verification" && <button
                              type="button"
                              disabled={updatingId === receipt.id}
                              onClick={() =>
                                void updateReceiptStatus(
                                  receipt,
                                  "Rejected"
                                )
                              }
                              className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 disabled:opacity-50"
                            >
                              Reject
                            </button>}
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
