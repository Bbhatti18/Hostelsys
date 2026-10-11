"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  resolveAuthenticatedResident,
  type AuthenticatedResident,
} from "@/lib/residentPortalAuth";
import { loadResidentPortalData } from "@/lib/residentPortalData";
import {
  deriveBillStatus,
  roundMoney,
  type BillLifecycleStatus,
} from "@/lib/financials";

// The portal API never serves unapproved bills, but the shared lifecycle type
// keeps this page in step with deriveBillStatus.
type BillStatus = BillLifecycleStatus;

type Bill = {
  id: string;
  bill_number: string;
  resident_id: string;
  billing_month: string;
  due_date: string;
  rent_amount: number;
  electricity_amount: number;
  ac_amount: number;
  other_amount: number;
  discount_amount: number;
  total_amount: number;
  paid_amount: number;
  pending_amount?: number;
  balance_amount: number;
  bill_status: BillStatus;
  notes: string | null;
  remaining_payment_date?: string | null;
  remaining_payment_amount?: number | null;
  remaining_payment_note?: string | null;
  remaining_payment_status?: string | null;
};

type Payment = {
  bill_id: string | null;
  amount: number;
  payment_status: string;
  allocations?: Array<{ bill_id: string; amount: number }>;
};

const inputClass =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100";

function normalized(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function money(value: unknown) {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function monthLabel(value: string) {
  const parsed = new Date(`${value.slice(0, 7)}-01T00:00:00`);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString("en-PK", { month: "long", year: "numeric" });
}

function statusClass(status: BillStatus) {
  if (status === "Paid") return "bg-emerald-100 text-emerald-700";
  if (status === "Partially Paid") return "bg-blue-100 text-blue-700";
  if (status === "Overdue") return "bg-red-100 text-red-700";
  if (status === "Cancelled") return "bg-slate-200 text-slate-700";
  return "bg-amber-100 text-amber-700";
}

export default function ResidentBillsPage() {
  const [resident, setResident] = useState<AuthenticatedResident | null>(null);
  const [bills, setBills] = useState<Bill[]>([]);
  const [selectedBill, setSelectedBill] = useState<Bill | null>(null);
  const [statusFilter, setStatusFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadBills = useCallback(async () => {
    setLoading(true);
    setError("");

    const resolved = await resolveAuthenticatedResident();
    if (!resolved.resident) {
      setResident(null);
      setBills([]);
      setError(resolved.error ?? "Your resident profile could not be verified.");
      setLoading(false);
      return;
    }

    const portalResult = await loadResidentPortalData();
    if (
      !portalResult.data ||
      portalResult.data.resident.id !== resolved.resident.id
    ) {
      setError(portalResult.error || "Your resident account could not be verified.");
      setLoading(false);
      return;
    }

    const payments = (portalResult.data.payments ?? []) as Payment[];
    const verifiedByBill = new Map<string, number>();
    const pendingByBill = new Map<string, number>();

    for (const payment of payments) {
      const isVerified = normalized(payment.payment_status) === "verified";
      const isPending = normalized(payment.payment_status) === "pending";
      if (!isVerified && !isPending) continue;

      const targetMap = isVerified ? verifiedByBill : pendingByBill;
      const allocs = (Array.isArray(payment.allocations) && payment.allocations.length > 0)
        ? payment.allocations
        : payment.bill_id
        ? [{ bill_id: payment.bill_id, amount: Number(payment.amount || 0) }]
        : [];

      for (const allocation of allocs) {
        if (!allocation.bill_id) continue;
        targetMap.set(allocation.bill_id, roundMoney((targetMap.get(allocation.bill_id) ?? 0) + Number(allocation.amount || 0)));
      }
    }

    let followupsData: Array<Record<string, unknown>> = [];
    try {
      const followupsResult = await supabase.rpc("payment_followup_data");
      if (Array.isArray(followupsResult.data)) {
        followupsData = followupsResult.data;
      }
    } catch {
      // non-blocking
    }

    const followupsByBill = new Map<string, {
      remaining_payment_date: string | null;
      remaining_payment_amount: number | null;
      remaining_payment_note: string | null;
      remaining_payment_status: string | null;
    }>();

    for (const item of followupsData) {
      const billId = String(item.bill_id || "");
      if (!billId) continue;
      if (Number(item.pending || 0) > 0 && !(pendingByBill.get(billId) ?? 0)) {
        pendingByBill.set(billId, Number(item.pending));
      }
      if (Number(item.verified || 0) > 0 && !(verifiedByBill.get(billId) ?? 0)) {
        verifiedByBill.set(billId, Number(item.verified));
      }
      const followupsList = Array.isArray(item.followups) ? item.followups : [];
      const commitment =
        followupsList.find((f: Record<string, unknown>) => f.kind === "commitment" && f.status !== "Resolved") ||
        followupsList.find((f: Record<string, unknown>) => f.kind === "commitment") ||
        followupsList[0];

      if (commitment) {
        followupsByBill.set(billId, {
          remaining_payment_date: commitment.due_date ? String(commitment.due_date) : null,
          remaining_payment_amount: commitment.amount ? Number(commitment.amount) : null,
          remaining_payment_note: commitment.note ? String(commitment.note) : null,
          remaining_payment_status: commitment.status ? String(commitment.status) : null,
        });
      }
    }

    const calculatedBills = (portalResult.data.bills as Bill[]).map((bill) => {
      const paid = verifiedByBill.get(bill.id) ?? 0;
      const pending = pendingByBill.get(bill.id) ?? 0;
      const total = Number(bill.total_amount || 0);
      const balance = Math.max(roundMoney(total - paid), 0);
      const cancelled = normalized(bill.bill_status) === "cancelled";
      const followup = followupsByBill.get(bill.id);

      let computedStatus: BillStatus;
      if (cancelled) {
        computedStatus = "Cancelled";
      } else if (total > 0 && balance === 0) {
        computedStatus = "Paid";
      } else if (paid > 0 && balance > 0) {
        computedStatus = "Partially Paid";
      } else if (pending > 0 && pending < total) {
        computedStatus = "Partially Paid";
      } else {
        computedStatus = deriveBillStatus(total, paid, bill.due_date, bill.bill_status);
      }

      return {
        ...bill,
        paid_amount: paid,
        pending_amount: pending,
        balance_amount: balance,
        bill_status: computedStatus,
        remaining_payment_date: followup?.remaining_payment_date ?? null,
        remaining_payment_amount: followup?.remaining_payment_amount ?? null,
        remaining_payment_note: followup?.remaining_payment_note ?? null,
        remaining_payment_status: followup?.remaining_payment_status ?? null,
      } as Bill;
    });

    setResident(portalResult.data.resident);
    setBills(calculatedBills);
    setLoading(false);
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void loadBills(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadBills]);

  const filteredBills = useMemo(() => {
    const query = search.trim().toLowerCase();
    return bills.filter((bill) => {
      const isPartiallyPaid =
        bill.bill_status === "Partially Paid" ||
        (Number(bill.paid_amount) > 0 && Number(bill.balance_amount) > 0) ||
        (Number(bill.pending_amount) > 0 && Number(bill.pending_amount) < Number(bill.total_amount)) ||
        (Boolean(bill.remaining_payment_date) && Number(bill.balance_amount) > 0);

      const isCompletelyPaid =
        bill.bill_status === "Paid" ||
        (Number(bill.balance_amount) <= 0 && Number(bill.total_amount) > 0) ||
        (Number(bill.paid_amount) >= Number(bill.total_amount) && Number(bill.total_amount) > 0);

      const matchesStatus =
        statusFilter === "All" ||
        (statusFilter === "Partially Paid"
          ? isPartiallyPaid
          : statusFilter === "Paid"
          ? isCompletelyPaid
          : bill.bill_status === statusFilter);

      const matchesSearch =
        !query ||
        bill.bill_number.toLowerCase().includes(query) ||
        monthLabel(bill.billing_month).toLowerCase().includes(query) ||
        (bill.remaining_payment_date ?? "").toLowerCase().includes(query) ||
        (bill.remaining_payment_note ?? "").toLowerCase().includes(query);
      return matchesStatus && matchesSearch;
    });
  }, [bills, search, statusFilter]);

  async function openBill(billId: string, print = false) {
    const found = bills.find((b) => b.id === billId);
    if (found) {
      setSelectedBill(found);
      if (print) window.setTimeout(() => window.print(), 0);
      return;
    }

    const portalResult = await loadResidentPortalData();
    if (!portalResult.data) {
      setError(portalResult.error);
      return;
    }

    const currentBill = (portalResult.data.bills as Bill[]).find(
      (bill) => bill.id === billId,
    );
    if (!currentBill) {
      setError("This bill could not be opened. Refresh and try again.");
      return;
    }

    const paid = roundMoney(
      (portalResult.data.payments as Payment[])
        .filter(
          (payment) =>
            payment.bill_id === billId &&
            normalized(payment.payment_status) === "verified",
        )
        .reduce(
        (sum, payment) => sum + Number(payment.amount || 0),
        0,
      ),
    );
    const total = Number(currentBill.total_amount || 0);
    const cancelled = normalized(currentBill.bill_status) === "cancelled";
    const calculated: Bill = {
      ...currentBill,
      paid_amount: paid,
      balance_amount: Math.max(roundMoney(total - paid), 0),
      bill_status: cancelled
        ? "Cancelled"
        : deriveBillStatus(total, paid, currentBill.due_date, currentBill.bill_status),
    };

    setSelectedBill(calculated);
    if (print) window.setTimeout(() => window.print(), 0);
  }

  return (
    <main className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 print:border-0 print:shadow-none">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">University Girls Hostel</p>
          <h1 className="mt-2 text-2xl font-bold text-slate-900 sm:text-3xl">My Bills</h1>
          <p className="mt-1 text-sm text-slate-500">
            {resident ? `Financial records for ${resident.full_name ?? "Resident"}.` : "Your bill history and outstanding balances."}
          </p>
          <div className="mt-4 flex flex-wrap gap-3 print:hidden">
            <Link href="/resident-portal" className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700">Portal Home</Link>
            <Link href="/resident-portal/payments" className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white">Payments & Receipts</Link>
          </div>
        </section>

        {error && <section className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{error}</section>}

        <section className="rounded-3xl border border-slate-200 bg-white shadow-sm print:hidden">
          <div className="grid gap-3 border-b border-slate-200 p-4 sm:p-5 md:grid-cols-[1fr_220px_auto]">
            <input value={search} onChange={(event) => setSearch(event.target.value)} className={inputClass} placeholder="Search bill number or month" />
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className={inputClass}>
              {['All', 'Pending', 'Partially Paid', 'Paid', 'Overdue', 'Cancelled'].map((status) => <option key={status}>{status}</option>)}
            </select>
            <button type="button" onClick={() => void loadBills()} className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold">Refresh</button>
          </div>

          {/* Mobile Bill Cards */}
          <div className="divide-y divide-slate-100 md:hidden">
            {loading ? (
              <p className="px-4 py-12 text-center text-sm text-slate-500">Loading your bills...</p>
            ) : filteredBills.length === 0 ? (
              <p className="px-4 py-12 text-center text-sm text-slate-500">No bills found.</p>
            ) : (
              filteredBills.map((bill) => (
                <article key={bill.id} className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-bold text-slate-900">{bill.bill_number}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {monthLabel(bill.billing_month)} · Due {bill.due_date}
                        {bill.remaining_payment_date && (
                          Number(bill.balance_amount) <= 0 ? (
                            <span className="ml-1 text-emerald-700 font-semibold">· Settled ({bill.remaining_payment_date})</span>
                          ) : (
                            <span className="ml-1 text-indigo-700 font-semibold">· Remaining Due: {bill.remaining_payment_date}</span>
                          )
                        )}
                      </p>
                    </div>
                    <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold ${
                      Number(bill.balance_amount) <= 0 && Number(bill.total_amount) > 0
                        ? "bg-emerald-100 text-emerald-800"
                        : statusClass(bill.bill_status)
                    }`}>
                      {Number(bill.balance_amount) <= 0 && Number(bill.total_amount) > 0 ? "✓ Completely Paid" : bill.bill_status}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 rounded-2xl bg-slate-50 p-3 text-xs">
                    <div>
                      <p className="text-slate-500">Total</p>
                      <p className="mt-1 font-bold text-slate-900">{money(bill.total_amount)}</p>
                    </div>
                    <div>
                      <p className="text-slate-500">Paid</p>
                      <p className="mt-1 font-bold text-emerald-700">{money(bill.paid_amount)}</p>
                    </div>
                    <div>
                      <p className="text-slate-500">Balance</p>
                      <p className={`mt-1 font-bold ${Number(bill.balance_amount) <= 0 ? "text-emerald-700" : "text-red-700"}`}>
                        {money(bill.balance_amount)}
                      </p>
                      {Number(bill.pending_amount) > 0 && (
                        <p className="text-[10px] text-amber-700 font-medium">
                          {money(bill.pending_amount)} in review
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => void openBill(bill.id)} className="rounded-lg border border-indigo-200 px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50">View</button>
                    <button type="button" onClick={() => void openBill(bill.id, true)} className="rounded-lg border border-emerald-200 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-50">Print</button>
                    <button type="button" onClick={() => void openBill(bill.id, true)} className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-100">Download Voucher</button>
                  </div>
                </article>
              ))
            )}
          </div>

          {/* Desktop Bills Table */}
          <div className="hidden overflow-x-auto md:block">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50"><tr>{["Bill", "Month", "Due", "Rent", "Electricity", "AC", "Other", "Discount", "Total", "Verified Paid", "Outstanding", "Status", "Actions"].map((heading) => <th key={heading} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{heading}</th>)}</tr></thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? <tr><td colSpan={13} className="px-5 py-12 text-center text-sm text-slate-500">Loading your bills...</td></tr> : filteredBills.length === 0 ? <tr><td colSpan={13} className="px-5 py-12 text-center text-sm text-slate-500">No bills found.</td></tr> : filteredBills.map((bill) => (
                  <tr key={bill.id}>
                    <td className="px-4 py-4 text-sm font-semibold">{bill.bill_number}</td>
                    <td className="px-4 py-4 text-sm">{monthLabel(bill.billing_month)}</td>
                    <td className="px-4 py-4 text-sm">
                      <div>
                        <span>{bill.due_date}</span>
                        {bill.remaining_payment_date && (
                          <div className="mt-1">
                            {Number(bill.balance_amount) <= 0 ? (
                              <span className="inline-flex items-center gap-1 rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-semibold text-emerald-700">
                                ✓ Settled ({bill.remaining_payment_date})
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded bg-indigo-50 px-1.5 py-0.5 text-xs font-semibold text-indigo-700">
                                Remaining Due: {bill.remaining_payment_date}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-4 text-sm">{money(bill.rent_amount)}</td>
                    <td className="px-4 py-4 text-sm">{money(bill.electricity_amount)}</td>
                    <td className="px-4 py-4 text-sm">{money(bill.ac_amount)}</td>
                    <td className="px-4 py-4 text-sm">{money(bill.other_amount)}</td>
                    <td className="px-4 py-4 text-sm">{money(bill.discount_amount)}</td>
                    <td className="px-4 py-4 text-sm font-semibold">{money(bill.total_amount)}</td>
                    <td className="px-4 py-4 text-sm text-emerald-700">{money(bill.paid_amount)}</td>
                    <td className="px-4 py-4 text-sm font-semibold">
                      {Number(bill.balance_amount) <= 0 && Number(bill.total_amount) > 0 ? (
                        <span className="text-emerald-700">✓ Settled</span>
                      ) : (
                        <span className="text-red-700">{money(bill.balance_amount)}</span>
                      )}
                      {Number(bill.pending_amount) > 0 && (
                        <span className="block text-[11px] font-normal text-amber-700">
                          {money(bill.pending_amount)} pending review
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      {Number(bill.balance_amount) <= 0 && Number(bill.total_amount) > 0 ? (
                        <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-bold text-emerald-800">
                          ✓ Completely Paid
                        </span>
                      ) : (
                        <span className={`rounded-full px-3 py-1 text-xs font-bold ${statusClass(bill.bill_status)}`}>
                          {bill.bill_status}
                        </span>
                      )}
                      {Number(bill.pending_amount) > 0 && (
                        <span className="mt-1 block rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">
                          Pending Review ({money(bill.pending_amount)})
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={() => void openBill(bill.id)} className="rounded-lg border border-indigo-200 px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50">View</button>
                        <button type="button" onClick={() => void openBill(bill.id, true)} className="rounded-lg border border-emerald-200 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-50">Print</button>
                        <button type="button" onClick={() => void openBill(bill.id, true)} className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-100">Download Voucher</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {selectedBill && (
          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 print:border-0 print:shadow-none">
            <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-sm font-semibold uppercase tracking-wider text-indigo-600">University Girls Hostel Bill</p><h2 className="mt-2 text-xl font-bold sm:text-2xl">{selectedBill.bill_number}</h2><p className="mt-1 text-sm text-slate-500">{monthLabel(selectedBill.billing_month)} · Due {selectedBill.due_date}</p></div><button type="button" onClick={() => setSelectedBill(null)} className="rounded-lg border px-3 py-2 text-sm print:hidden">Close</button></div>
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[['Monthly Rent', selectedBill.rent_amount], ['Electricity', selectedBill.electricity_amount], ['AC Charges', selectedBill.ac_amount], ['Other Charges', selectedBill.other_amount], ['Discount', -selectedBill.discount_amount], ['Total', selectedBill.total_amount], ['Verified Paid', selectedBill.paid_amount], ['Outstanding', selectedBill.balance_amount]].map(([label, value]) => <article key={String(label)} className="rounded-2xl bg-slate-50 p-4"><p className="text-xs font-semibold uppercase text-slate-500">{label}</p><p className="mt-2 font-bold">{money(value)}</p></article>)}
            </div>
            <p className="mt-5 text-sm font-semibold">Status: {selectedBill.bill_status}</p>
            {selectedBill.notes && <p className="mt-3 text-sm text-slate-600">{selectedBill.notes}</p>}
          </section>
        )}
      </div>
    </main>
  );
}
