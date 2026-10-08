"use client";
import StaffAllocationEditor from "@/components/payments/StaffAllocationEditor";
import { readStaffCorrections } from "@/lib/staffCorrectionHistory";
import PaymentAuditDetails from "@/components/payments/PaymentAuditDetails";
import RentCorrectionContext, { type RentCorrection } from "@/components/payments/RentCorrectionContext";
import { readDashboardRows } from "@/lib/dashboardRead";
import PaymentFollowups from "@/components/payments/PaymentFollowups";

import {
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import PaymentsNavigation from "@/components/payments/PaymentsNavigation";
import { supabase } from "@/lib/supabase";
import {
  getVerifiedPaymentTotal,
  refreshBillFinancials,
  roundMoney,
} from "@/lib/financials";
import { getSupabaseErrorMessage } from "@/lib/supabaseErrors";
import { rentPeriodLabel } from "@/lib/paymentReceiptPurpose";
import { staffPaymentLabel, type StaffPaymentAllocation } from "@/lib/staffPaymentLabel";

type GenericRow = Record<string, unknown>;

type PaymentStatus = "Pending" | "Verified" | "Rejected" | "Cancelled";

type Payment = {
  id: string;
  payment_number: string | null;
  bill_id: string | null;
  resident_id: string;
  payment_date: string;
  amount: number;
  payment_method: string;
  account_number: string | null;
  reference_number: string | null;
  payment_status: PaymentStatus;
  verified: boolean;
  verified_by: string | null;
  verified_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type PaymentForm = {
  bill_id: string;
  resident_id: string;
  payment_date: string;
  amount: string;
  payment_method: string;
  account_number: string;
  reference_number: string;
  payment_status: PaymentStatus;
  verified_by: string;
  notes: string;
};

const today = new Date().toISOString().slice(0, 10);

const emptyForm: PaymentForm = {
  bill_id: "",
  resident_id: "",
  payment_date: today,
  amount: "0",
  payment_method: "",
  account_number: "",
  reference_number: "",
  payment_status: "Pending",
  verified_by: "",
  notes: "",
};

const inputClass =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-slate-100";

function text(value: unknown) {
  return value == null ? "" : String(value);
}

function firstText(row: GenericRow, keys: string[]) {
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

function residentName(row: GenericRow) { return String(row.full_name || "Resident"); }

function money(value: number) {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function createPaymentNumber() {
  return `PAY-${new Date().getFullYear()}-${Date.now()
    .toString()
    .slice(-8)}`;
}

function statusClass(status: PaymentStatus) {
  switch (status) {
    case "Verified":
      return "bg-emerald-100 text-emerald-700";
    case "Rejected":
      return "bg-red-100 text-red-700";
    case "Cancelled":
      return "bg-slate-200 text-slate-700";
    default:
      return "bg-amber-100 text-amber-700";
  }
}

export default function PaymentsPage() {
  const [payments, setPayments] = useState<Payment[]>([]);
  const [residents, setResidents] = useState<GenericRow[]>([]);
  const [bills, setBills] = useState<GenericRow[]>([]);
  const [allocations, setAllocations] = useState<StaffPaymentAllocation[]>([]);
  const [form, setForm] = useState<PaymentForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [corrections, setCorrections] = useState<RentCorrection[]>([]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");

    const [paymentsResult, residentsResult, billsResult, allocationsResult, correctionsResult] = await Promise.all([
      readDashboardRows(supabase.from("payments").select("*").order("created_at", { ascending: false }).order("id")),
      supabase.from("residents").select("*"),
      readDashboardRows(supabase.from("bills").select("*").order("created_at", { ascending: false }).order("id")),
      readDashboardRows(supabase.from("payment_allocations").select("payment_id,bill_id,amount").order("payment_id").order("bill_id")),
      readStaffCorrections(),
    ]);

    const firstError =
      paymentsResult.error || residentsResult.error || billsResult.error || allocationsResult.error;

    if (firstError) {
      setError(getSupabaseErrorMessage(firstError, "Financial records could not be loaded."));
      setCorrections([]);
      setPayments([]);
      setResidents([]);
      setBills([]);
      setAllocations([]);
    } else {
      if (correctionsResult.error) setError("Financial records loaded. Correction history is unavailable for this session.");
      setCorrections((correctionsResult.data ?? []) as RentCorrection[]);
      setPayments((paymentsResult.data ?? []) as Payment[]);
      setResidents((residentsResult.data ?? []) as GenericRow[]);
      setBills((billsResult.data ?? []) as GenericRow[]);
      setAllocations((allocationsResult.data ?? []) as StaffPaymentAllocation[]);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [refresh]);

  const residentMap = useMemo(
    () =>
      new Map(
        residents.map((resident) => [
          text(resident.id),
          residentName(resident),
        ])
      ),
    [residents]
  );

  const billMap = useMemo(
    () =>
      new Map(
        bills.map((bill) => [
          text(bill.id),
          {
            billNumber:
              firstText(bill, ["bill_number"]) ||
              `Bill ${text(bill.id).slice(0, 8)}`,
            residentId: firstText(bill, ["resident_id"]),
            balance: Number(
              bill.balance_amount ??
                bill.total_amount ??
                0
            ),
          },
        ])
      ),
    [bills]
  );

  useEffect(() => {
    if (loading) return;
    const id = new URLSearchParams(window.location.search).get("billId");
    if (!id) return;
    const bill = billMap.get(id);
    if (!bill) { setError("The selected bill could not be loaded; no other bill was selected."); return; }
    setForm({ ...emptyForm, bill_id: id, resident_id: bill.residentId, amount: String(bill.balance), payment_status: "Pending" });
    setEditingId(null); setShowForm(true);
  }, [loading, billMap]);

  const filteredPayments = useMemo(() => {
    const query = search.trim().toLowerCase();

    return payments.filter((payment) => {
      const resident = residentMap.get(payment.resident_id) ?? "";
      const bill = payment.bill_id ? billMap.get(payment.bill_id)?.billNumber ?? "" : "Combined payment";

      const matchesSearch =
        !query ||
        (payment.payment_number ?? "").toLowerCase().includes(query) ||
        resident.toLowerCase().includes(query) ||
        bill.toLowerCase().includes(query) ||
        (payment.reference_number ?? "").toLowerCase().includes(query);

      const matchesStatus =
        statusFilter === "All" || payment.payment_status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [billMap, payments, residentMap, search, statusFilter]);

  const summary = useMemo(
    () => ({
      total: payments.length,
      verified: payments
        .filter((payment) => payment.payment_status === "Verified")
        .reduce((sum, payment) => sum + Number(payment.amount || 0), 0),
      pending: payments
        .filter((payment) => payment.payment_status === "Pending")
        .reduce((sum, payment) => sum + Number(payment.amount || 0), 0),
      rejected: payments.filter(
        (payment) => payment.payment_status === "Rejected"
      ).length,
    }),
    [payments]
  );

  function updateField<K extends keyof PaymentForm>(
    key: K,
    value: PaymentForm[K]
  ) {
    setForm((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function openAddForm() {
    setEditingId(null);
    setForm(emptyForm);
    setMessage("");
    setError("");
    setShowForm(true);
  }

  function closeForm() {
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(false);
  }

  function openEditForm(payment: Payment) {
    if (payment.payment_status !== "Pending") {
      setError("Only pending payments can be edited. Verified and historical payments are preserved.");
      return;
    }
    if (!payment.bill_id) {
      setError("Combined payments must be managed through the combined payment workflow.");
      return;
    }
    setEditingId(payment.id);
    setForm({
      bill_id: payment.bill_id,
      resident_id: payment.resident_id,
      payment_date: payment.payment_date,
      amount: String(payment.amount ?? 0),
      payment_method: payment.payment_method ?? "",
      account_number: payment.account_number ?? "",
      reference_number: payment.reference_number ?? "",
      payment_status: payment.payment_status,
      verified_by: payment.verified_by ?? "",
      notes: payment.notes ?? "",
    });
    setMessage("");
    setError("");
    setShowForm(true);

    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  }

  function selectBill(billId: string) {
    const selected = billMap.get(billId);

    setForm((current) => ({
      ...current,
      bill_id: billId,
      resident_id: selected?.residentId ?? current.resident_id,
      amount:
        selected && selected.balance > 0
          ? String(selected.balance)
          : current.amount,
    }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setSaving(true);
    setMessage("");
    setError("");

    const amount = Number(form.amount || 0);

    if (!form.bill_id || !form.resident_id) {
      setError("Bill and resident are required.");
      setSaving(false);
      return;
    }

    if (!form.payment_method.trim()) {
      setError("Payment Method is required.");
      setSaving(false);
      return;
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Payment amount must be greater than zero.");
      setSaving(false);
      return;
    }

    const { data: currentBill, error: billError } = await supabase
      .from("bills")
      .select("id, resident_id, total_amount, bill_status")
      .eq("id", form.bill_id)
      .single();

    if (
      billError ||
      !currentBill ||
      text(currentBill.resident_id) !== form.resident_id
    ) {
      setError("The selected bill no longer belongs to this resident. Refresh and select the bill again.");
      setSaving(false);
      return;
    }

    if (["Cancelled", "Draft", "Pending Approval"].includes(currentBill.bill_status)) {
      setError("Payments cannot be recorded against a cancelled bill.");
      setSaving(false);
      return;
    }

    const { data: currentResident, error: residentError } = await supabase
      .from("residents")
      .select("id, status")
      .eq("id", form.resident_id)
      .single();

    if (residentError || !currentResident) {
      setError("The selected resident could not be confirmed.");
      setSaving(false);
      return;
    }

    if (!editingId && currentResident.status === "Archived") {
      setError("Archived residents cannot be selected for new payments.");
      setSaving(false);
      return;
    }

    if (form.reference_number.trim()) {
      let referenceQuery = supabase
        .from("payments")
        .select("id")
        .eq("reference_number", form.reference_number.trim())
        .limit(1);
      if (editingId) referenceQuery = referenceQuery.neq("id", editingId);
      const { data: duplicateReference, error: referenceError } = await referenceQuery;
      if (referenceError) {
        setError("The payment reference could not be checked. Please try again.");
        setSaving(false);
        return;
      }
      if ((duplicateReference ?? []).length > 0) {
        setError("This reference number is already used by another payment.");
        setSaving(false);
        return;
      }
    }

    const verifiedTotal = await getVerifiedPaymentTotal(
      form.bill_id,
      editingId ?? undefined,
    ).catch(() => null);
    if (verifiedTotal === null) {
      setError("The latest verified balance could not be confirmed. Please try again.");
      setSaving(false);
      return;
    }

    const outstanding = Math.max(
      roundMoney(Number(currentBill.total_amount ?? 0) - verifiedTotal),
      0,
    );
    if (amount > outstanding) {
      setError(`Payment exceeds the current outstanding balance of ${money(outstanding)}.`);
      setSaving(false);
      return;
    }

    const isVerified = form.payment_status === "Verified";
    if (isVerified && !window.confirm(`Verify ${money(amount)} against ${staffPaymentLabel({ id: "new", resident_id: form.resident_id, bill_id: form.bill_id }, [], bills)}? This exact bill is selected; no other month will be substituted.`)) {
      setSaving(false);
      return;
    }

    const payload = {
      payment_number: editingId ? undefined : createPaymentNumber(),
      bill_id: form.bill_id,
      resident_id: form.resident_id,
      payment_date: form.payment_date || today,
      amount,
      payment_method: form.payment_method.trim(),
      account_number: form.account_number.trim() || null,
      reference_number: form.reference_number.trim() || null,
      payment_status: form.payment_status,
      verified: isVerified,
      verified_by: isVerified ? form.verified_by.trim() || "Admin" : null,
      verified_at: isVerified ? new Date().toISOString() : null,
      notes: form.notes.trim() || null,
      updated_at: new Date().toISOString(),
    };

    const cleanPayload = Object.fromEntries(
      Object.entries(payload).filter(([, value]) => value !== undefined)
    );

    const result = editingId
      ? await supabase
          .from("payments")
          .update(cleanPayload)
          .eq("id", editingId).eq("payment_status", "Pending").select("id").maybeSingle()
      : await supabase.from("payments").insert(cleanPayload).select("id").single();

    if (result.error || !result.data) {
      setError(getSupabaseErrorMessage(result.error, "The payment could not be saved. Please verify the details and try again.", "This payment or reference already exists."));
      setSaving(false);
      return;
    }

    try {
      await refreshBillFinancials(form.bill_id);
    } catch {
      setError("The payment was saved, but the bill balance could not be refreshed. Refresh the page and retry the bill update.");
      setSaving(false);
      await refresh();
      return;
    }

    setMessage(
      editingId
        ? "Payment updated successfully."
        : "Payment added successfully."
    );

    closeForm();
    await refresh();
    setSaving(false);
  }

  async function cancelPayment(payment: Payment) {
    if (payment.payment_status === "Cancelled") return;
    const confirmed = window.confirm(
      `Cancel payment ${payment.payment_number ?? ""}? Its history will be preserved.`
    );

    if (!confirmed) return;

    setCancellingId(payment.id);
    setMessage("");
    setError("");

    const { data: currentPayment, error: currentPaymentError } = await supabase
      .from("payments")
      .select("id, bill_id, payment_status")
      .eq("id", payment.id)
      .single();
    if (currentPaymentError || !currentPayment) {
      setError("The payment could not be re-checked. Refresh and try again.");
      setCancellingId(null);
      return;
    }
    if (currentPayment.payment_status === "Cancelled") {
      setMessage("This payment is already cancelled.");
      setCancellingId(null);
      await refresh();
      return;
    }

    if (!currentPayment.bill_id) {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setError("Your admin session could not be verified. Refresh and sign in again.");
        setCancellingId(null);
        return;
      }
      const response = await fetch("/api/payment-verification/cancel", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ paymentId: payment.id, reason: "Payment cancelled by staff." }),
      });
      const result = await response.json().catch(() => null) as { error?: string; message?: string } | null;
      if (!response.ok) setError(result?.error || "The combined payment could not be cancelled.");
      else setMessage(result?.message || "Combined payment cancelled and balances recalculated.");
      setCancellingId(null);
      await refresh();
      return;
    }

    const { data: paymentBill, error: paymentBillError } = await supabase.from("bills")
      .select("bill_type, admission_id").eq("id", currentPayment.bill_id).single();
    if (paymentBillError || !paymentBill) { setError("The payment obligation could not be confirmed."); setCancellingId(null); return; }
    if (paymentBill.bill_type === "Security Deposit") {
      const { data: depositAdmission, error: depositError } = await supabase.from("admissions")
        .select("deposit_status").eq("id", paymentBill.admission_id).single();
      if (depositError || !depositAdmission || !["Pending", "Held"].includes(depositAdmission.deposit_status)) {
        setError("A released or deducted deposit requires settlement review before reversing payment."); setCancellingId(null); return;
      }
    }
    const { data: cancelledPayment, error: cancelError } = await supabase
      .from("payments")
      .update({
        payment_status: "Cancelled",
        verified: false,
        verified_at: null,
        verified_by: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", payment.id)
      .eq("payment_status", currentPayment.payment_status)
      .select("id")
      .maybeSingle();

    if (cancelError || !cancelledPayment) {
      setError(getSupabaseErrorMessage(cancelError, "The payment could not be cancelled."));
    } else {
      try {
        await refreshBillFinancials(currentPayment.bill_id);
      } catch {
        setError("The payment was cancelled, but the bill balance could not be refreshed.");
        setCancellingId(null);
        await refresh();
        return;
      }
      setMessage("Payment cancelled. Its history has been preserved.");
      await refresh();
    }

    setCancellingId(null);
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
              Payments
            </h1>

            <p className="mt-1 text-sm text-slate-500">
              Record, verify and manage resident payments.
            </p>
          </div>

          <button
            type="button"
            onClick={openAddForm}
            className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            + Add Payment
          </button>
        </section>

        <PaymentsNavigation active="payments" />
        <PaymentFollowups staff />

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
            <div className="mb-6 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-xl font-bold text-slate-900">
                  {editingId ? "Edit Payment" : "Add Payment"}
                </h2>

                <p className="mt-1 text-sm text-slate-500">
                  Use the generic Payment Method field and optional account
                  number.
                </p>
              </div>

              <button
                type="button"
                onClick={closeForm}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600"
              >
                Close
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <Field label="Bill *">
                  <select
                    required
                    value={form.bill_id}
                    onChange={(event) => selectBill(event.target.value)}
                    className={inputClass}
                  >
                    <option value="">Select bill</option>

                    {bills
                      .filter(
                        (bill) =>
                          bill.bill_status !== "Cancelled" ||
                          text(bill.id) === form.bill_id,
                      )
                      .map((bill) => {
                      const id = text(bill.id);
                      const mapped = billMap.get(id);

                      return (
                        <option key={id} value={id}>
                          {bill.bill_type === "Rent" ? rentPeriodLabel(bill.billing_month) : String(bill.bill_type || "Bill")} / {mapped?.billNumber ?? "Bill"} —{" "}
                          {residentMap.get(mapped?.residentId ?? "") ??
                            "Resident"}
                        </option>
                      );
                    })}
                  </select>
                </Field>

                <Field label="Resident *">
                  <select
                    required
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
                          text(resident.id) === form.resident_id,
                      )
                      .map((resident) => (
                      <option
                        key={text(resident.id)}
                        value={text(resident.id)}
                      >
                        {residentName(resident)}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Payment Date">
                  <input
                    type="date"
                    value={form.payment_date}
                    onChange={(event) =>
                      updateField("payment_date", event.target.value)
                    }
                    className={inputClass}
                  />
                </Field>

                <Field label="Amount *">
                  <input
                    required
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={form.amount}
                    onChange={(event) =>
                      updateField("amount", event.target.value)
                    }
                    className={inputClass}
                  />
                </Field>

                <Field label="Payment Method *">
                  <input
                    required
                    value={form.payment_method}
                    onChange={(event) =>
                      updateField("payment_method", event.target.value)
                    }
                    className={inputClass}
                    placeholder="Cash, bank transfer, card, etc."
                  />
                </Field>

                <Field label="Account Details">
                  <input
                    value={form.account_number}
                    onChange={(event) =>
                      updateField("account_number", event.target.value)
                    }
                    className={inputClass}
                    placeholder="Optional account number"
                  />
                </Field>

                <Field label="Reference Number">
                  <input
                    value={form.reference_number}
                    onChange={(event) =>
                      updateField("reference_number", event.target.value)
                    }
                    className={inputClass}
                    placeholder="Transaction or receipt reference"
                  />
                </Field>

                <Field label="Payment Status">
                  <select
                    value={form.payment_status}
                    onChange={(event) =>
                      updateField(
                        "payment_status",
                        event.target.value as PaymentStatus
                      )
                    }
                    className={inputClass}
                  >
                    <option value="Pending">Pending</option>
                    <option value="Verified">Verified</option>
                  </select>
                </Field>

                <Field label="Verified By">
                  <input
                    value={form.verified_by}
                    onChange={(event) =>
                      updateField("verified_by", event.target.value)
                    }
                    className={inputClass}
                    disabled={form.payment_status !== "Verified"}
                    placeholder="Admin name"
                  />
                </Field>

                <Field label="Notes" wide>
                  <textarea
                    value={form.notes}
                    onChange={(event) =>
                      updateField("notes", event.target.value)
                    }
                    className={`${inputClass} min-h-24`}
                    placeholder="Additional payment details..."
                  />
                </Field>
              </div>

              <div className="flex flex-col-reverse gap-3 border-t border-slate-200 pt-6 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={closeForm}
                  className="rounded-xl border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700"
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
                    ? "Update Payment"
                    : "Save Payment"}
                </button>
              </div>
            </form>
          </section>
        )}

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Total Payments" value={String(summary.total)} />
          <StatCard label="Verified Amount" value={money(summary.verified)} />
          <StatCard label="Pending Amount" value={money(summary.pending)} />
          <StatCard label="Rejected Payments" value={String(summary.rejected)} />
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
          <div className="grid gap-3 border-b border-slate-200 p-5 lg:grid-cols-[1fr_220px_auto]">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className={inputClass}
              placeholder="Search payment, resident, bill or reference"
            />

            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className={inputClass}
            >
              <option value="All">All Statuses</option>
              <option value="Pending">Pending</option>
              <option value="Verified">Verified</option>
              <option value="Rejected">Rejected</option>
              <option value="Cancelled">Cancelled</option>
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
                    "Payment",
                    "Resident / Bill",
                    "Method",
                    "Amount",
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
                      colSpan={6}
                      className="px-5 py-12 text-center text-sm text-slate-500"
                    >
                      Loading payments...
                    </td>
                  </tr>
                ) : filteredPayments.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-5 py-12 text-center text-sm text-slate-500"
                    >
                      No payments found.
                    </td>
                  </tr>
                ) : (
                  filteredPayments.map((payment) => (
                    <tr key={payment.id} className="hover:bg-slate-50/70">
                      <td className="px-5 py-4">
                        <p className="font-semibold text-slate-900">
                          {corrections.some(c => c.original_payment_id === payment.id) ? "Original payment" : corrections.some(c => c.replacement_payment_id === payment.id) ? "Replacement payment" : payment.payment_number ?? "No payment number"}
                        </p>

                        <p className="mt-1 text-xs text-slate-500">
                          {payment.payment_date}
                        </p>
                        <details className="mt-2 text-xs"><summary className="cursor-pointer">Transaction details</summary>
                          <p>Payment: {payment.payment_number} / {payment.id}</p>
                          <p>Financial status: {payment.payment_status}</p>
                          <p>Verified by: {payment.verified_by || "unavailable"} / At: {payment.verified_at || "unavailable"}</p>
                          <p>{payment.notes}</p>
                          {!corrections.some(c => c.original_payment_id === payment.id || c.replacement_payment_id === payment.id) && <PaymentAuditDetails paymentIds={[payment.id]} />}
                        </details>
                      </td>

                      <td className="px-5 py-4 text-sm text-slate-700">
                        <p className="font-semibold text-slate-900">
                          {residentMap.get(payment.resident_id) ??
                            "Unknown resident"}
                        </p>

                        <p className="mt-1 text-xs text-slate-500">
                          {corrections.some(c => c.original_payment_id === payment.id) && "Historical allocation: "}{staffPaymentLabel(payment, allocations, bills)}
                        </p>
                        <RentCorrectionContext paymentId={payment.id} corrections={corrections} payments={payments} allocations={allocations} bills={bills} />
                      </td>

                      <td className="px-5 py-4 text-sm text-slate-700">
                        {payment.payment_method}

                        <p className="mt-1 text-xs text-slate-500">
                          Ref: {payment.reference_number || "—"}
                        </p>
                      </td>

                      <td className="px-5 py-4 text-sm font-semibold text-slate-900">
                        {money(payment.amount)}
                      </td>

                      <td className="px-5 py-4">
                        <span
                          className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${statusClass(
                            payment.payment_status
                          )}`}
                        >
                          {corrections.some(c => c.original_payment_id === payment.id) ? "Corrected" : payment.payment_status}
                        </span>
                      </td>

                      <td className="px-5 py-4">
                        <div className="flex flex-wrap gap-2">
                          {(payment.payment_status === "Pending" || (payment.payment_status === "Verified" && !corrections.some(c => c.original_payment_id === payment.id || c.replacement_payment_id === payment.id))) && <StaffAllocationEditor paymentId={payment.id} correction={payment.payment_status === "Verified"} onSaved={() => void refresh()} />}
                          {payment.payment_status === "Pending" && (
                            <button
                              type="button"
                              onClick={() => openEditForm(payment)}
                              className="rounded-lg border border-indigo-200 px-3 py-2 text-xs font-semibold text-indigo-700"
                            >
                              Edit
                            </button>
                          )}

                          {payment.payment_status !== "Cancelled" && <button
                            type="button"
                            disabled={
                              cancellingId === payment.id
                            }
                            onClick={() => void cancelPayment(payment)}
                            className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 disabled:opacity-50"
                          >
                            {cancellingId === payment.id
                              ? "Cancelling..."
                              : "Cancel"}
                          </button>}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
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
