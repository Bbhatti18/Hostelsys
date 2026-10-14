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
import { calculateLateFee } from "@/lib/lateFee";
import type { FineWaiverRequest, FineWaiverStatus } from "@/lib/fineWaivers";

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
  accrued_fine: number;
  payable_fine: number;
  overdue_days: number;
  waiver_request?: FineWaiverRequest;
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

function waiverBadgeClass(status: FineWaiverStatus) {
  switch (status) {
    case "Approved":
      return "bg-emerald-100 text-emerald-800 border-emerald-200";
    case "Partially Approved":
      return "bg-blue-100 text-blue-800 border-blue-200";
    case "Rejected":
      return "bg-red-100 text-red-800 border-red-200";
    default:
      return "bg-amber-100 text-amber-800 border-amber-200";
  }
}

export default function ResidentBillsPage() {
  const [resident, setResident] = useState<AuthenticatedResident | null>(null);
  const [bills, setBills] = useState<Bill[]>([]);
  const [waiverRequests, setWaiverRequests] = useState<FineWaiverRequest[]>([]);
  const [selectedBill, setSelectedBill] = useState<Bill | null>(null);
  const [statusFilter, setStatusFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<"bills" | "waivers">("bills");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Waiver request modal state
  const [requestingWaiverBill, setRequestingWaiverBill] = useState<Bill | null>(null);
  const [waiverType, setWaiverType] = useState<"FULL" | "PARTIAL">("FULL");
  const [partialAmount, setPartialAmount] = useState<string>("");
  const [waiverReason, setWaiverReason] = useState<string>("");
  const [submittingWaiver, setSubmittingWaiver] = useState(false);
  const [waiverSuccessMsg, setWaiverSuccessMsg] = useState<string | null>(null);
  const [waiverErrorMsg, setWaiverErrorMsg] = useState<string | null>(null);

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

    // Fetch fine waiver requests for this resident
    let residentWaivers: FineWaiverRequest[] = [];
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (token) {
        const waiverRes = await fetch("/api/resident-portal/fine-waivers", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (waiverRes.ok) {
          const wData = await waiverRes.json();
          residentWaivers = wData.requests || [];
        }
      }
    } catch {
      // non-blocking
    }
    setWaiverRequests(residentWaivers);

    const payments = (portalResult.data.payments ?? []) as Payment[];
    const verifiedByBill = new Map<string, number>();
    const pendingByBill = new Map<string, number>();

    for (const payment of payments) {
      const isVerified = normalized(payment.payment_status) === "verified";
      const isPending = normalized(payment.payment_status) === "pending";
      if (!isVerified && !isPending) continue;

      const targetMap = isVerified ? verifiedByBill : pendingByBill;
      const allocs =
        Array.isArray(payment.allocations) && payment.allocations.length > 0
          ? payment.allocations
          : payment.bill_id
          ? [{ bill_id: payment.bill_id, amount: Number(payment.amount || 0) }]
          : [];

      for (const allocation of allocs) {
        if (!allocation.bill_id) continue;
        targetMap.set(
          allocation.bill_id,
          roundMoney((targetMap.get(allocation.bill_id) ?? 0) + Number(allocation.amount || 0))
        );
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

    const followupsByBill = new Map<
      string,
      {
        remaining_payment_date: string | null;
        remaining_payment_amount: number | null;
        remaining_payment_note: string | null;
        remaining_payment_status: string | null;
      }
    >();

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
        followupsList.find(
          (f: Record<string, unknown>) => f.kind === "commitment" && f.status !== "Resolved"
        ) ||
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

      // Calculate Rs. 300/day late fee if due date has passed and bill has balance
      let accruedFine = 0;
      let overdueDays = 0;
      if (balance > 0 && bill.due_date) {
        accruedFine = calculateLateFee(bill.due_date);
        overdueDays = Math.round(accruedFine / 300);
      }

      // Match waiver request
      const matchingWaiver = residentWaivers.find((w) => w.bill_id === bill.id);
      let payableFine = accruedFine;
      if (matchingWaiver) {
        if (matchingWaiver.status === "Approved") {
          payableFine = 0;
        } else if (matchingWaiver.status === "Partially Approved") {
          payableFine = Math.max(0, accruedFine - Number(matchingWaiver.waived_amount || 0));
        }
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
        accrued_fine: accruedFine,
        payable_fine: payableFine,
        overdue_days: overdueDays,
        waiver_request: matchingWaiver,
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

  function openWaiverModal(bill: Bill) {
    setRequestingWaiverBill(bill);
    setWaiverType("FULL");
    setPartialAmount(String(bill.accrued_fine / 2));
    setWaiverReason("");
    setWaiverErrorMsg(null);
    setWaiverSuccessMsg(null);
  }

  function closeWaiverModal() {
    if (submittingWaiver) return;
    setRequestingWaiverBill(null);
    setWaiverReason("");
    setPartialAmount("");
  }

  async function handleSubmitWaiver(e: React.FormEvent) {
    e.preventDefault();
    if (!requestingWaiverBill) return;

    const fineAmount = requestingWaiverBill.accrued_fine;
    if (fineAmount <= 0) {
      setWaiverErrorMsg("There is no fine on this bill to waive.");
      return;
    }

    if (!waiverReason.trim()) {
      setWaiverErrorMsg("Please enter an explanation or reason for the waiver request.");
      return;
    }

    let reqAmount = fineAmount;
    if (waiverType === "PARTIAL") {
      reqAmount = Number(partialAmount);
      if (!Number.isFinite(reqAmount) || reqAmount <= 0) {
        setWaiverErrorMsg("Please enter a valid partial waiver amount greater than 0.");
        return;
      }
      if (reqAmount > fineAmount) {
        setWaiverErrorMsg(`Partial waiver cannot exceed the total fine of Rs. ${fineAmount}.`);
        return;
      }
    }

    setSubmittingWaiver(true);
    setWaiverErrorMsg(null);
    setWaiverSuccessMsg(null);

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error("Please sign in again to submit your waiver request.");

      const res = await fetch("/api/resident-portal/fine-waivers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          billId: requestingWaiverBill.id,
          fineAmount,
          requestedAmount: reqAmount,
          reason: waiverReason.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to submit waiver request.");
      }

      setWaiverSuccessMsg("Your fine waiver request has been submitted to administration for review.");
      closeWaiverModal();
      await loadBills();
    } catch (err: unknown) {
      setWaiverErrorMsg(err instanceof Error ? err.message : "Failed to submit fine waiver request.");
    } finally {
      setSubmittingWaiver(false);
    }
  }

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

    const currentBill = (portalResult.data.bills as Bill[]).find((bill) => bill.id === billId);
    if (!currentBill) {
      setError("This bill could not be opened. Refresh and try again.");
      return;
    }

    const paid = roundMoney(
      (portalResult.data.payments as Payment[])
        .filter(
          (payment) =>
            payment.bill_id === billId && normalized(payment.payment_status) === "verified"
        )
        .reduce((sum, payment) => sum + Number(payment.amount || 0), 0)
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
      accrued_fine: 0,
      payable_fine: 0,
      overdue_days: 0,
    };

    setSelectedBill(calculated);
    if (print) window.setTimeout(() => window.print(), 0);
  }

  return (
    <main className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        {/* Page Header */}
        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 print:border-0 print:shadow-none">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">
            University Girls Hostel
          </p>
          <h1 className="mt-2 text-2xl font-bold text-slate-900 sm:text-3xl">My Bills & Fines</h1>
          <p className="mt-1 text-sm text-slate-500">
            {resident
              ? `Financial records for ${resident.full_name ?? "Resident"}. Daily late fine of Rs. 300 applies after due date.`
              : "Your bill history and outstanding balances."}
          </p>
          <div className="mt-4 flex flex-wrap gap-3 print:hidden">
            <Link
              href="/resident-portal"
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Portal Home
            </Link>
            <Link
              href="/resident-portal/payments"
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              Payments & Receipts
            </Link>
          </div>
        </section>

        {waiverSuccessMsg && (
          <div className="flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">
            <span>✓ {waiverSuccessMsg}</span>
            <button
              type="button"
              onClick={() => setWaiverSuccessMsg(null)}
              className="text-xs text-emerald-700 underline"
            >
              Dismiss
            </button>
          </div>
        )}

        {error && (
          <section className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            {error}
          </section>
        )}

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-200 gap-2 print:hidden">
          <button
            type="button"
            onClick={() => setActiveTab("bills")}
            className={`pb-3 px-5 text-sm font-bold border-b-2 transition ${
              activeTab === "bills"
                ? "border-indigo-600 text-indigo-600"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            My Bills
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("waivers")}
            className={`pb-3 px-5 text-sm font-bold border-b-2 transition flex items-center gap-2 ${
              activeTab === "waivers"
                ? "border-indigo-600 text-indigo-600"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            Fine Waiver Requests
            {waiverRequests.length > 0 && (
              <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs text-indigo-700 font-bold">
                {waiverRequests.length}
              </span>
            )}
          </button>
        </div>

        {/* TAB 1: MY BILLS */}
        {activeTab === "bills" && (
          <section className="rounded-3xl border border-slate-200 bg-white shadow-sm print:hidden">
            <div className="grid gap-3 border-b border-slate-200 p-4 sm:p-5 md:grid-cols-[1fr_220px_auto]">
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className={inputClass}
                placeholder="Search bill number or month"
              />
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
                className={inputClass}
              >
                {["All", "Pending", "Partially Paid", "Paid", "Overdue", "Cancelled"].map((status) => (
                  <option key={status}>{status}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void loadBills()}
                className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold hover:bg-slate-50"
              >
                Refresh
              </button>
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
                          {bill.remaining_payment_date &&
                            (Number(bill.balance_amount) <= 0 ? (
                              <span className="ml-1 text-emerald-700 font-semibold">
                                · Settled ({bill.remaining_payment_date})
                              </span>
                            ) : (
                              <span className="ml-1 text-indigo-700 font-semibold">
                                · Remaining Due: {bill.remaining_payment_date}
                              </span>
                            ))}
                        </p>
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold ${
                          Number(bill.balance_amount) <= 0 && Number(bill.total_amount) > 0
                            ? "bg-emerald-100 text-emerald-800"
                            : statusClass(bill.bill_status)
                        }`}
                      >
                        {Number(bill.balance_amount) <= 0 && Number(bill.total_amount) > 0
                          ? "✓ Completely Paid"
                          : bill.bill_status}
                      </span>
                    </div>

                    {/* Fine details banner if fine accrued */}
                    {bill.accrued_fine > 0 && Number(bill.balance_amount) > 0 && (
                      <div className="rounded-xl border border-red-200 bg-red-50/70 p-3 text-xs space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-red-800">
                            Late Fine ({bill.overdue_days} days @ Rs. 300/day):
                          </span>
                          <span className="font-bold text-red-900">{money(bill.payable_fine)}</span>
                        </div>
                        {bill.waiver_request ? (
                          <div className="flex items-center justify-between pt-1 border-t border-red-200">
                            <span className="text-slate-600">Waiver Status:</span>
                            <span
                              className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${waiverBadgeClass(
                                bill.waiver_request.status
                              )}`}
                            >
                              {bill.waiver_request.status}
                            </span>
                          </div>
                        ) : null}
                      </div>
                    )}

                    <div className="grid grid-cols-3 gap-2 rounded-2xl bg-slate-50 p-3 text-xs">
                      <div>
                        <p className="text-slate-500">Bill Amount</p>
                        <p className="mt-1 font-bold text-slate-900">{money(bill.total_amount)}</p>
                      </div>
                      <div>
                        <p className="text-slate-500">Paid</p>
                        <p className="mt-1 font-bold text-emerald-700">{money(bill.paid_amount)}</p>
                      </div>
                      <div>
                        <p className="text-slate-500">Balance</p>
                        <p
                          className={`mt-1 font-bold ${
                            Number(bill.balance_amount) <= 0 ? "text-emerald-700" : "text-red-700"
                          }`}
                        >
                          {money(bill.balance_amount)}
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void openBill(bill.id)}
                        className="rounded-lg border border-indigo-200 px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50"
                      >
                        View
                      </button>
                      <button
                        type="button"
                        onClick={() => void openBill(bill.id, true)}
                        className="rounded-lg border border-emerald-200 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                      >
                        Print
                      </button>
                      {bill.accrued_fine > 0 &&
                        Number(bill.balance_amount) > 0 &&
                        bill.waiver_request?.status !== "Pending" &&
                        bill.waiver_request?.status !== "Approved" && (
                          <button
                            type="button"
                            onClick={() => openWaiverModal(bill)}
                            className="rounded-lg border border-purple-300 bg-purple-50 px-3 py-2 text-xs font-semibold text-purple-700 hover:bg-purple-100"
                          >
                            Request Fine Waiver
                          </button>
                        )}
                    </div>
                  </article>
                ))
              )}
            </div>

            {/* Desktop Bills Table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="min-w-full divide-y divide-slate-200 text-left">
                <thead className="bg-slate-50">
                  <tr>
                    {[
                      "Bill",
                      "Month",
                      "Due Date",
                      "Rent",
                      "Electricity",
                      "AC",
                      "Other",
                      "Discount",
                      "Total",
                      "Paid",
                      "Outstanding",
                      "Status",
                      "Actions",
                    ].map((heading) => (
                      <th
                        key={heading}
                        className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-slate-500"
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {loading ? (
                    <tr>
                      <td colSpan={13} className="px-5 py-12 text-center text-sm text-slate-500">
                        Loading your bills...
                      </td>
                    </tr>
                  ) : filteredBills.length === 0 ? (
                    <tr>
                      <td colSpan={13} className="px-5 py-12 text-center text-sm text-slate-500">
                        No bills found.
                      </td>
                    </tr>
                  ) : (
                    filteredBills.map((bill) => (
                      <tr key={bill.id} className="hover:bg-slate-50/70 transition">
                        <td className="px-4 py-4 text-sm font-semibold">{bill.bill_number}</td>
                        <td className="px-4 py-4 text-sm">{monthLabel(bill.billing_month)}</td>
                        <td className="px-4 py-4 text-sm">
                          <div>
                            <span className="font-medium text-slate-800">{bill.due_date}</span>
                            {/* Fine & Waiver Badge */}
                            {bill.accrued_fine > 0 && Number(bill.balance_amount) > 0 && (
                              <div className="mt-1 flex flex-col gap-0.5">
                                <span className="text-[11px] font-bold text-red-600">
                                  Fine: {money(bill.payable_fine)}
                                </span>
                                <span className="text-[10px] text-slate-400">
                                  {bill.overdue_days} days @ Rs. 300
                                </span>
                                {bill.waiver_request && (
                                  <span
                                    className={`inline-flex rounded-full border px-1.5 py-0.2 text-[9px] font-bold ${waiverBadgeClass(
                                      bill.waiver_request.status
                                    )}`}
                                  >
                                    {bill.waiver_request.status === "Approved"
                                      ? "✓ Waived"
                                      : bill.waiver_request.status === "Partially Approved"
                                      ? `Partially Waived (${money(bill.waiver_request.waived_amount)})`
                                      : bill.waiver_request.status}
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
                        </td>
                        <td className="px-4 py-4">
                          <span
                            className={`rounded-full px-3 py-1 text-xs font-bold ${
                              Number(bill.balance_amount) <= 0 && Number(bill.total_amount) > 0
                                ? "bg-emerald-100 text-emerald-800"
                                : statusClass(bill.bill_status)
                            }`}
                          >
                            {Number(bill.balance_amount) <= 0 && Number(bill.total_amount) > 0
                              ? "✓ Completely Paid"
                              : bill.bill_status}
                          </span>
                        </td>
                        <td className="px-4 py-4">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => void openBill(bill.id)}
                              className="rounded-lg border border-indigo-200 px-2.5 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50"
                            >
                              View
                            </button>
                            <button
                              type="button"
                              onClick={() => void openBill(bill.id, true)}
                              className="rounded-lg border border-emerald-200 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                            >
                              Print
                            </button>
                            {bill.accrued_fine > 0 &&
                              Number(bill.balance_amount) > 0 &&
                              bill.waiver_request?.status !== "Pending" &&
                              bill.waiver_request?.status !== "Approved" && (
                                <button
                                  type="button"
                                  onClick={() => openWaiverModal(bill)}
                                  className="rounded-lg border border-purple-300 bg-purple-50 px-2.5 py-1.5 text-xs font-semibold text-purple-700 hover:bg-purple-100 transition whitespace-nowrap"
                                >
                                  Request Waiver
                                </button>
                              )}
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* TAB 2: FINE WAIVER REQUESTS */}
        {activeTab === "waivers" && (
          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 space-y-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b border-slate-100 pb-4">
              <div>
                <h2 className="text-xl font-bold text-slate-900">Fine Waiver Requests</h2>
                <p className="text-xs text-slate-500">
                  Track the status of your fine waiver requests reviewed by administration.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void loadBills()}
                className="rounded-xl border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                ↻ Refresh Status
              </button>
            </div>

            {waiverRequests.length === 0 ? (
              <div className="py-12 text-center text-sm text-slate-500">
                You have not submitted any fine waiver requests yet. Overdue bills with an active fine
                show a &ldquo;Request Waiver&rdquo; button.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
                  <thead className="bg-slate-50 text-xs font-bold uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-4 py-3">Bill Details</th>
                      <th className="px-4 py-3">Accrued Fine</th>
                      <th className="px-4 py-3">Requested</th>
                      <th className="px-4 py-3">My Reason</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Admin Notes / Decision</th>
                      <th className="px-4 py-3">Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {waiverRequests.map((req) => (
                      <tr key={req.id} className="hover:bg-slate-50/70 transition">
                        <td className="px-4 py-3.5 font-medium">
                          <p className="text-slate-900 font-semibold">{req.bill_number || "Bill"}</p>
                          <p className="text-xs text-slate-500">{monthLabel(req.billing_month || "")}</p>
                        </td>

                        <td className="px-4 py-3.5 font-semibold text-red-700">
                          {money(req.fine_amount)}
                        </td>

                        <td className="px-4 py-3.5 font-semibold text-indigo-700">
                          {money(req.requested_amount)}
                        </td>

                        <td className="px-4 py-3.5 max-w-xs text-xs text-slate-700 italic">
                          &ldquo;{req.reason}&rdquo;
                        </td>

                        <td className="px-4 py-3.5">
                          <span
                            className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-bold ${waiverBadgeClass(
                              req.status
                            )}`}
                          >
                            {req.status}
                          </span>
                          {req.status === "Approved" && (
                            <p className="mt-0.5 text-[11px] text-emerald-700 font-semibold">
                              Waived {money(req.waived_amount)} (100%)
                            </p>
                          )}
                          {req.status === "Partially Approved" && (
                            <p className="mt-0.5 text-[11px] text-blue-700 font-semibold">
                              Waived {money(req.waived_amount)}
                            </p>
                          )}
                        </td>

                        <td className="px-4 py-3.5 max-w-xs text-xs">
                          {req.admin_notes ? (
                            <p className="text-slate-800 font-medium">{req.admin_notes}</p>
                          ) : req.status === "Pending" ? (
                            <span className="text-slate-400 italic">Pending review</span>
                          ) : (
                            <span className="text-slate-400 italic">No notes provided</span>
                          )}
                          {req.reviewed_at && (
                            <p className="text-[10px] text-slate-400 mt-0.5">
                              Reviewed on {new Date(req.reviewed_at).toLocaleDateString("en-PK")}
                            </p>
                          )}
                        </td>

                        <td className="px-4 py-3.5 text-xs text-slate-500 whitespace-nowrap">
                          {new Date(req.created_at).toLocaleDateString("en-PK")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {/* Selected Bill Voucher Modal */}
        {selectedBill && (
          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 print:border-0 print:shadow-none">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold uppercase tracking-wider text-indigo-600">
                  University Girls Hostel Bill
                </p>
                <h2 className="mt-2 text-xl font-bold sm:text-2xl">{selectedBill.bill_number}</h2>
                <p className="mt-1 text-sm text-slate-500">
                  {monthLabel(selectedBill.billing_month)} · Due {selectedBill.due_date}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedBill(null)}
                className="rounded-lg border px-3 py-2 text-sm print:hidden"
              >
                Close
              </button>
            </div>
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["Monthly Rent", selectedBill.rent_amount],
                ["Electricity", selectedBill.electricity_amount],
                ["AC Charges", selectedBill.ac_amount],
                ["Other Charges", selectedBill.other_amount],
                ["Discount", -selectedBill.discount_amount],
                ["Total", selectedBill.total_amount],
                ["Verified Paid", selectedBill.paid_amount],
                ["Outstanding", selectedBill.balance_amount],
              ].map(([label, value]) => (
                <article key={String(label)} className="rounded-2xl bg-slate-50 p-4">
                  <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
                  <p className="mt-2 font-bold">{money(value)}</p>
                </article>
              ))}
            </div>
            <p className="mt-5 text-sm font-semibold">Status: {selectedBill.bill_status}</p>
            {selectedBill.notes && <p className="mt-3 text-sm text-slate-600">{selectedBill.notes}</p>}
          </section>
        )}

        {/* Waiver Request Modal */}
        {requestingWaiverBill && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-xs">
            <div className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl space-y-5 animate-in fade-in duration-150">
              <div className="flex items-start justify-between border-b border-slate-100 pb-3">
                <div>
                  <h3 className="text-lg font-bold text-slate-900">Request Fine Waiver</h3>
                  <p className="text-xs text-slate-500">
                    Bill <span className="font-semibold text-slate-700">{requestingWaiverBill.bill_number}</span> ·{" "}
                    {monthLabel(requestingWaiverBill.billing_month)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closeWaiverModal}
                  disabled={submittingWaiver}
                  className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition"
                >
                  ✕
                </button>
              </div>

              {waiverErrorMsg && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs font-semibold text-red-700">
                  ✕ {waiverErrorMsg}
                </div>
              )}

              {/* Fine Details */}
              <div className="rounded-2xl bg-slate-50 p-4 border border-slate-200 text-xs space-y-2">
                <div className="flex justify-between">
                  <span className="text-slate-500">Due Date:</span>
                  <span className="font-semibold text-slate-800">{requestingWaiverBill.due_date}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Overdue Days:</span>
                  <span className="font-bold text-slate-800">{requestingWaiverBill.overdue_days} days</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">Daily Late Fine Rate:</span>
                  <span className="font-semibold text-slate-800">Rs. 300 / day</span>
                </div>
                <div className="flex justify-between border-t border-slate-200 pt-2 text-sm">
                  <span className="font-bold text-slate-700">Total Accrued Fine:</span>
                  <span className="font-bold text-red-700">{money(requestingWaiverBill.accrued_fine)}</span>
                </div>
              </div>

              <form onSubmit={handleSubmitWaiver} className="space-y-4">
                {/* Waiver Type Selection */}
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                    Waiver Request Type
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setWaiverType("FULL")}
                      className={`rounded-xl border p-3 text-left transition ${
                        waiverType === "FULL"
                          ? "border-indigo-600 bg-indigo-50/50 text-indigo-900 font-bold ring-2 ring-indigo-200"
                          : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      <p className="text-xs font-bold">Full Waiver (100%)</p>
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        Waive all {money(requestingWaiverBill.accrued_fine)}
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={() => setWaiverType("PARTIAL")}
                      className={`rounded-xl border p-3 text-left transition ${
                        waiverType === "PARTIAL"
                          ? "border-indigo-600 bg-indigo-50/50 text-indigo-900 font-bold ring-2 ring-indigo-200"
                          : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      <p className="text-xs font-bold">Partial Waiver</p>
                      <p className="mt-0.5 text-[11px] text-slate-500">Specify custom amount</p>
                    </button>
                  </div>
                </div>

                {/* Partial Amount Input */}
                {waiverType === "PARTIAL" && (
                  <div>
                    <label className="block text-xs font-semibold text-slate-700 mb-1">
                      Requested Waiver Amount (PKR) <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="number"
                      required
                      min="1"
                      max={requestingWaiverBill.accrued_fine}
                      step="1"
                      value={partialAmount}
                      onChange={(e) => setPartialAmount(e.target.value)}
                      placeholder="e.g. 600"
                      className={inputClass}
                    />
                    {Number(partialAmount) > 0 && (
                      <p className="mt-1 text-xs text-slate-500">
                        Remaining fine you would pay:{" "}
                        <span className="font-semibold text-slate-800">
                          {money(Math.max(0, requestingWaiverBill.accrued_fine - Number(partialAmount)))}
                        </span>
                      </p>
                    )}
                  </div>
                )}

                {/* Reason Textarea */}
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Reason / Explanation for Delay <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    required
                    rows={3}
                    value={waiverReason}
                    onChange={(e) => setWaiverReason(e.target.value)}
                    placeholder="Please explain the reason for the payment delay (e.g., medical emergency, bank transfer issue, family situation)..."
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 resize-none"
                  />
                </div>

                {/* Modal Action Buttons */}
                <div className="flex justify-end gap-2.5 pt-2 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={closeWaiverModal}
                    disabled={submittingWaiver}
                    className="rounded-xl border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submittingWaiver}
                    className="rounded-xl bg-purple-600 px-5 py-2 text-xs font-semibold text-white shadow-xs hover:bg-purple-700 transition disabled:opacity-50"
                  >
                    {submittingWaiver ? "Submitting..." : "Submit Waiver Request"}
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
