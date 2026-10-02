"use client";

import { ADDITIONAL_CATEGORIES, additionalChargeError, additionalPaymentTotal } from "@/lib/additionalCharges";
import Link from "next/link";
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { billPaymentObligation, receiptPurposeError, combinedPaymentPreview, combinedPaymentAllocationError } from "@/lib/paymentObligations";
import { paymentBillAmounts } from "@/lib/paymentAllocations";
import { buildResidentFinancialSummary } from "@/lib/residentFinancialSummary";
import { supabase } from "@/lib/supabase";
import {
  resolveAuthenticatedResident,
  type AuthenticatedResident,
} from "@/lib/residentPortalAuth";
import { loadResidentPortalData } from "@/lib/residentPortalData";
import { deriveBillStatus, roundMoney } from "@/lib/financials";
import { getSupabaseErrorMessage } from "@/lib/supabaseErrors";
import {
  notificationWarning,
  requestEventNotification,
} from "@/lib/notifications/client";
import {
  allocatedPaymentLabel,
  securityDepositAdmissionId,
  receiptPaymentMethod,
  residentReceiptNotes,
  securityDepositReceiptNotes,
} from "@/lib/paymentReceiptPurpose";

type GenericRow = Record<string, unknown>;

type Bill = {
  admission_id: string;
  rent_amount: number;
  electricity_amount: number;
  ac_amount: number;
  other_amount: number;
  discount_amount: number;
  id: string;
  resident_id: string;
  bill_number: string;
  billing_month: string;
  due_date: string;
  total_amount: number;
  bill_status: string;
  bill_type?: string;
  paid: number;
  outstanding: number;
  displayStatus: string;
};

type Payment = {
  id: string;
  bill_id: string | null;
  resident_id: string;
  payment_number: string | null;
  payment_date: string;
  amount: number;
  payment_method: string;
  reference_number: string | null;
  payment_status: string;
  verified: boolean;
  notes: string | null;
  created_at: string;
  allocations?: Array<{ bill_id: string; amount: number }>;
};

type Receipt = {
  payment_id: string | null;
  id: string;
  bill_id: string | null;
  resident_id: string;
  amount: number;
  reference_number: string | null;
  status: string;
  notes: string | null;
  created_at: string;
};

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const SAFE_FILE_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);
const SECURITY_DEPOSIT_OPTION = "security-deposit";
const inputClass =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-slate-100";

function text(value: unknown) {
  return value == null ? "" : String(value);
}

function normalized(value: unknown) {
  return text(value).trim().toLowerCase();
}

function isPayableBill(status: unknown) {
  return !["cancelled", "archived", "draft", "pending approval"].includes(normalized(status));
}

function isSecurityDepositBill(bill: {
  bill_type?: unknown;
  billing_month?: unknown;
  bill_number?: unknown;
}) {
  return (
    normalized(bill.bill_type) === "security deposit"
  );
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

function statusClass(status: string) {
  const value = normalized(status);
  if (value === "verified" || value === "paid") return "bg-emerald-100 text-emerald-700";
  if (value === "rejected" || value === "overdue") return "bg-red-100 text-red-700";
  if (value === "cancelled") return "bg-slate-200 text-slate-700";
  if (value === "partially paid") return "bg-blue-100 text-blue-700";
  return "bg-amber-100 text-amber-700";
}

function firstText(row: GenericRow | undefined, keys: string[]) {
  if (!row) return "";
  for (const key of keys) {
    const value = row[key];
    if (value !== null && value !== undefined && text(value).trim()) return text(value);
  }
  return "";
}

export default function ResidentPaymentsPage() {
  const [resident, setResident] = useState<AuthenticatedResident | null>(null);
  const [admission, setAdmission] = useState<GenericRow | null>(null);
  const [bills, setBills] = useState<Bill[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [selectedBillId, setSelectedBillId] = useState("");
  const [amount, setAmount] = useState("");
  const [withAdditional, setWithAdditional] = useState(false);
  const [additionalAmount, setAdditionalAmount] = useState("");
  const [additionalCategory, setAdditionalCategory] = useState<string>(ADDITIONAL_CATEGORIES[0]);
  const [additionalDescription, setAdditionalDescription] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");

    const resolved = await resolveAuthenticatedResident();
    if (!resolved.resident) {
      setResident(null);
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

    const paymentRows = portalResult.data.payments as Payment[];
    const verifiedByBill = new Map<string, number>();
    for (const payment of paymentRows) {
      if (normalized(payment.payment_status) !== "verified") continue;
      for (const allocation of paymentBillAmounts(payment, payment.allocations ?? [])) {
        verifiedByBill.set(allocation.bill_id, roundMoney((verifiedByBill.get(allocation.bill_id) ?? 0) + Number(allocation.amount || 0)));
      }
    }

    const calculatedBills = portalResult.data.bills.map((row) => {
      const id = text(row.id);
      const paid = verifiedByBill.get(id) ?? 0;
      const total = Number(row.total_amount || 0);
      const cancelled = normalized(row.bill_status) === "cancelled";
      return {
        ...row,
        id,
        resident_id: text(row.resident_id),
        bill_number: firstText(row, ["bill_number"]) || "Bill",
        billing_month: firstText(row, ["billing_month"]),
        due_date: firstText(row, ["due_date"]),
        total_amount: total,
        bill_status: firstText(row, ["bill_status"]),
        bill_type: firstText(row, ["bill_type"]),
        paid,
        outstanding: Math.max(roundMoney(total - paid), 0),
        displayStatus: cancelled ? "Cancelled" : deriveBillStatus(total, paid, firstText(row, ["due_date"]), firstText(row, ["bill_status"])),
      } as Bill;
    });

    setResident(portalResult.data.resident);
    setAdmission(portalResult.data.admission);
    setBills(calculatedBills);
    setPayments(paymentRows);
    setReceipts(portalResult.data.receipts as Receipt[]);
    setSelectedBillId("");
    setAmount("");
    setLoading(false);
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void loadData(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [loadData]);

  const depositBill = useMemo(
    () => bills.find(bill => isSecurityDepositBill(bill) && bill.admission_id === admission?.id && isPayableBill(bill.bill_status)) ?? null,
    [bills, admission],
  );
  const regularBills = useMemo(
    () => bills.filter((bill) => !isSecurityDepositBill(bill) && bill.admission_id === admission?.id),
    [bills, admission],
  );

  const selectedBill = useMemo(
    () => bills.find((bill) => bill.id === selectedBillId),
    [bills, selectedBillId],
  );

  const financial = useMemo(() => buildResidentFinancialSummary({ admission, room: null, bed: null, bills, payments }), [admission, bills, payments]);
  const selectedObligation = selectedBill ? billPaymentObligation(selectedBill, payments) : null;
  const combined = combinedPaymentPreview(financial);
  const canonicalAmount = selectedBillId === "combined" ? combined.total : selectedObligation?.amount ?? 0;
  const actualTotal = additionalPaymentTotal(canonicalAmount, Number(additionalAmount) || 0);
  const depositOutstanding = financial.depositBalance;

  const pendingDepositReceipt = receipts.some(
    (receipt) =>
      ((depositBill && receipt.bill_id === depositBill.id) ||
        (!receipt.bill_id && securityDepositAdmissionId(receipt.notes) === admission?.id)) &&
      normalized(receipt.status) === "pending verification",
  );

  const verifiedDepositReceipts = useMemo(
    () =>
      Array.from(
        new Map(
          receipts
            .filter(
              (receipt) =>
                ((depositBill && receipt.bill_id === depositBill.id) ||
                  (!receipt.bill_id && securityDepositAdmissionId(receipt.notes) === admission?.id)) &&
                normalized(receipt.status) === "verified",
            )
            .map((receipt) => [receipt.id, receipt]),
        ).values(),
      ),
    [depositBill, receipts, admission],
  );

  const summary = {
    outstanding: financial.totalOutstanding,
    pendingBills: regularBills.filter(bill => isPayableBill(bill.bill_status) && bill.outstanding > 0).length,
    overdueBills: regularBills.filter(bill => bill.displayStatus === "Overdue").length,
    verifiedPayments: financial.appliedPayments,
    pendingReceipts: receipts.filter(receipt => normalized(receipt.status) === "pending verification" && ((!receipt.bill_id && payments.some(payment => payment.id === receipt.payment_id && (payment.allocations ?? []).some(allocation => bills.some(bill => bill.id === allocation.bill_id && bill.admission_id === admission?.id)))) || bills.some(bill => bill.id === receipt.bill_id && bill.admission_id === admission?.id))).length,
  };

  const paymentHistoryRows = useMemo(() => {
    const entries: { id: string; sortDate: string; row: React.ReactNode[] }[] = [];
    for (const payment of payments) {
      if (normalized(payment.payment_status) !== "verified") continue;
      const bill = bills.find((item) => item.id === payment.bill_id);
      const isDeposit = bill && isSecurityDepositBill(bill);
      entries.push({
        id: `payment-${payment.id}`,
        sortDate: payment.payment_date || payment.created_at,
        row: [
          payment.payment_number ?? "—",
          isDeposit
            ? `Security Deposit (${bill.bill_number})`
            : payment.notes?.match(/^Payment purpose:[ \t]*(.+)$/im)?.[1] || allocatedPaymentLabel(payment.allocations ?? [], bills) || bill?.bill_number || "Historical bill",
          payment.payment_date,
          money(payment.amount),
          payment.payment_method || "Payment Method",
          payment.reference_number ?? "—",
          <Status key="status" value={payment.payment_status} />,
          payment.payment_status,
          payment.notes ?? "—",
        ],
      });
    }
    for (const receipt of verifiedDepositReceipts) {
      if (receipt.payment_id && payments.some(payment => payment.id === receipt.payment_id)) continue;
entries.push({
        id: `deposit-${receipt.id}`,
        sortDate: receipt.created_at,
        row: [
          "—",
          "Security Deposit",
          receipt.created_at.slice(0, 10),
          money(receipt.amount),
          receiptPaymentMethod(receipt.notes) || "Payment Method",
          receipt.reference_number ?? "—",
          <Status key="status" value="Pending Verification" />,
          "Needs payment reconciliation",
          residentReceiptNotes(receipt.notes) || "—",
        ],
      });
    }
    return entries
      .sort((left, right) => {
        const dateDifference =
          new Date(right.sortDate).getTime() - new Date(left.sortDate).getTime();
        return dateDifference || right.id.localeCompare(left.id);
      })
      .map((entry) => entry.row);
  }, [bills, payments, verifiedDepositReceipts]);

  function selectBill(billId: string) {
    setWithAdditional(false);
    const bill = bills.find((item) => item.id === billId);
    setSelectedBillId(billId);
    setAmount(
      billId === "combined" ? String(combined.total) :
      billId === SECURITY_DEPOSIT_OPTION || (depositBill && billId === depositBill.id)
        ? String(depositOutstanding)
        : bill
          ? String(billPaymentObligation(bill, payments).amount)
          : "",
    );
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setMessage("");
    setError("");
    if (!file) {
      setSelectedFile(null);
      return;
    }
    if (!SAFE_FILE_TYPES.has(file.type)) {
      setSelectedFile(null);
      event.target.value = "";
      setError("Receipt files must be PDF, JPEG, or PNG.");
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setSelectedFile(null);
      event.target.value = "";
      setError("Receipt files must not exceed 5 MB.");
      return;
    }
    setSelectedFile(file);
  }

  async function uploadReceipt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (uploading) return;
    setUploading(true);
    setMessage("");
    setError("");

    if (!selectedBillId || !paymentMethod.trim() || !selectedFile) {
      setError("Payment obligation, payment method, and receipt file are required.");
      setUploading(false);
      return;
    }
    const submittedAmount = roundMoney(Number(amount));
    if (!Number.isFinite(submittedAmount) || submittedAmount <= 0) {
      setError("Payment amount must be greater than zero.");
      setUploading(false);
      return;
    }
    if (!SAFE_FILE_TYPES.has(selectedFile.type) || selectedFile.size > MAX_FILE_SIZE) {
      setError("Receipt files must be PDF, JPEG, or PNG and no larger than 5 MB.");
      setUploading(false);
      return;
    }

    const resolved = await resolveAuthenticatedResident();
    if (!resolved.resident) {
      setError(resolved.error ?? "Your resident profile could not be verified.");
      setUploading(false);
      return;
    }
    const residentId = resolved.resident.id;
    if (withAdditional) {
      try {
        const invalid = additionalChargeError(additionalAmount, additionalCategory, additionalDescription);
        if (invalid) throw new Error(invalid);
        const rentBill = selectedBillId === "combined" ? regularBills.find(bill => bill.bill_type === "Rent" && billPaymentObligation(bill, payments).amount === financial.monthlyRentDue) : selectedBill?.bill_type === "Rent" ? selectedBill : null;
        const selectedDeposit = selectedBillId === "combined" || selectedBillId === depositBill?.id ? depositBill : null;
        if (!admission?.id || (!rentBill && !selectedDeposit) || !(canonicalAmount > 0)) throw new Error("Select current Rent and/or Security Deposit.");
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error("Please sign in again.");
        const formData = new FormData();
        formData.set("file", selectedFile);
        formData.set("admissionId", text(admission.id));
        if (rentBill) formData.set("rentBillId", rentBill.id);
        if (selectedDeposit) formData.set("depositBillId", selectedDeposit.id);
        formData.set("amount", String(actualTotal));
        formData.set("additionalAmount", additionalAmount);
        formData.set("additionalCategory", additionalCategory);
        formData.set("additionalDescription", additionalDescription.trim());
        formData.set("paymentMethod", paymentMethod.trim());
        formData.set("referenceNumber", referenceNumber.trim());
        formData.set("notes", notes.trim());
        const response = await fetch("/api/resident-portal/combined-payment", { method: "POST", headers: { Authorization: "Bearer " + session.access_token }, body: formData });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Payment could not be submitted.");
        setMessage("Actual total submitted for staff verification. No balance changes until verification.");
        setWithAdditional(false); setAdditionalAmount(""); setAdditionalDescription(""); setSelectedFile(null); setSelectedBillId(""); setAmount("");
        await loadData();
      } catch (error) { setError(error instanceof Error ? error.message : "Payment could not be submitted."); }
      finally { setUploading(false); }
      return;
    }
    if (selectedBillId === "combined") {
      const combinedError = combinedPaymentAllocationError(financial, submittedAmount);
      const rentBill = regularBills.find((bill) => {
        const obligation = billPaymentObligation(bill, payments);
        return obligation.purpose === "Rent" && obligation.amount === financial.monthlyRentDue;
      });
      if (combinedError || !admission?.id || !depositBill || !rentBill) {
        setError(combinedError || "Both current Rent and Security Deposit obligations must be available.");
        setUploading(false);
        return;
      }
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setError("Your resident session could not be verified. Please sign in again.");
        setUploading(false);
        return;
      }
      if (!rentBill) {
        setError("The current Rent obligation could not be identified. Refresh and try again.");
        setUploading(false);
        return;
      }
      const formData = new FormData();
      formData.set("file", selectedFile);
      formData.set("admissionId", text(admission.id));
      formData.set("rentBillId", rentBill.id);
      formData.set("depositBillId", depositBill.id);
      formData.set("amount", String(submittedAmount));
      formData.set("paymentMethod", paymentMethod.trim());
      formData.set("referenceNumber", referenceNumber.trim());
      formData.set("notes", notes.trim());
      const response = await fetch("/api/resident-portal/combined-payment", { method: "POST", headers: { Authorization: `Bearer ${session.access_token}` }, body: formData });
      const payload = await response.json().catch(() => null) as { message?: string; error?: string } | null;
      if (!response.ok) {
        setError(payload?.error || "The combined payment could not be submitted.");
        setUploading(false);
        return;
      }
      setMessage(payload?.message || "Combined payment submitted for verification.");
      setSelectedBillId(""); setAmount(""); setPaymentMethod(""); setReferenceNumber(""); setNotes(""); setSelectedFile(null);
      const input = document.getElementById("payment-receipt-file") as HTMLInputElement | null;
      if (input) input.value = "";
      await loadData();
      setUploading(false);
      return;
    }
    if (selectedBillId === SECURITY_DEPOSIT_OPTION) {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const accessToken = session?.access_token;
      if (!accessToken) {
        setError("Your resident session could not be verified. Please sign in again.");
        setUploading(false);
        return;
      }

      const formData = new FormData();
      formData.set("file", selectedFile);
      formData.set("admissionId", text(admission?.id));
      formData.set("amount", String(submittedAmount));
      formData.set("paymentMethod", paymentMethod.trim());
      formData.set("referenceNumber", referenceNumber.trim());
      formData.set("notes", notes.trim());
      const response = await fetch("/api/resident-portal/deposit-receipts", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: formData,
      });
      const payload = (await response.json().catch(() => null)) as
        | { message?: string; error?: string; notificationWarning?: boolean }
        | null;
      if (!response.ok) {
        setError(payload?.error || "The security deposit receipt could not be submitted.");
        setUploading(false);
        return;
      }

      setMessage(
        `${payload?.message || "Security deposit receipt submitted for verification."}${
          payload?.notificationWarning
            ? " The record was saved, but its notification could not be delivered."
            : ""
        }`,
      );
      setSelectedBillId("");
      setAmount("");
      setPaymentMethod("");
      setReferenceNumber("");
      setNotes("");
      setSelectedFile(null);
      const input = document.getElementById("payment-receipt-file") as HTMLInputElement | null;
      if (input) input.value = "";
      await loadData();
      setUploading(false);
      return;
    }

    const { data: currentBill, error: billError } = await supabase
      .from("bills")
      .select("id, resident_id, admission_id, total_amount, bill_status, bill_type, rent_amount, electricity_amount, ac_amount, other_amount, discount_amount")
      .eq("id", selectedBillId)
      .eq("resident_id", residentId)
      .maybeSingle();
    if (billError || !currentBill || currentBill.admission_id !== admission?.id) {
      setError("The selected bill could not be verified. Refresh and try again.");
      setUploading(false);
      return;
    }
    const { data: currentAdmission, error: admissionError } = await supabase.from("admissions")
      .select("id").eq("id", currentBill.admission_id).eq("resident_id", residentId).in("status", ["Pending", "Active"]).maybeSingle();
    if (admissionError || !currentAdmission) {
      setError("This admission is no longer current. Refresh before submitting."); setUploading(false); return;
    }
    if (!isPayableBill(currentBill.bill_status)) {
      setError("Receipts cannot be submitted for a cancelled or archived bill.");
      setUploading(false);
      return;
    }

    const { data: verifiedRows, error: paymentError } = await supabase
      .from("payments")
      .select("amount, bill_id, payment_status")
      .eq("resident_id", residentId)
      .eq("bill_id", selectedBillId)
      .eq("payment_status", "Verified");
    if (paymentError) {
      setError("The current outstanding balance could not be verified. Please try again.");
      setUploading(false);
      return;
    }
    const verifiedPaid = roundMoney((verifiedRows ?? []).reduce((sum, row) => sum + Number(row.amount || 0), 0));
    const outstanding = Math.max(roundMoney(Number(currentBill.total_amount || 0) - verifiedPaid), 0);
    if (submittedAmount > outstanding) {
      setError(`Amount cannot exceed the current outstanding balance of ${money(outstanding)}.`);
      setUploading(false);
      return;
    }

    const purposeError = receiptPurposeError(currentBill, verifiedRows ?? [], submittedAmount, selectedObligation?.purpose ?? "");
    if (purposeError) { setError(purposeError); setUploading(false); return; }
    const reference = referenceNumber.trim();
    if (reference) {
      const [paymentReference, receiptReference] = await Promise.all([
        supabase.from("payments").select("id").eq("resident_id", residentId).eq("reference_number", reference).limit(1),
        supabase.from("payment_receipts").select("id").eq("resident_id", residentId).eq("reference_number", reference).limit(1),
      ]);
      if (paymentReference.error || receiptReference.error) {
        setError("The payment reference could not be checked. Please try again.");
        setUploading(false);
        return;
      }
      if ((paymentReference.data ?? []).length || (receiptReference.data ?? []).length) {
        setError("This reference number has already been submitted.");
        setUploading(false);
        return;
      }
    }

    const safeName = selectedFile.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filePath = `${residentId}/${Date.now()}-${safeName}`;
    const { error: uploadError } = await supabase.storage
      .from("payment-receipts")
      .upload(filePath, selectedFile, { cacheControl: "3600", upsert: false });
    if (uploadError) {
      setError(getSupabaseErrorMessage(uploadError, "The receipt file could not be uploaded. Please try again."));
      setUploading(false);
      return;
    }

    const isDepositSubmission =
      selectedBillId === SECURITY_DEPOSIT_OPTION ||
      (depositBill && selectedBillId === depositBill.id);
    const receiptNotes =
      isDepositSubmission && admission?.id
        ? securityDepositReceiptNotes(text(admission.id), paymentMethod.trim(), notes.trim())
        : [`Payment purpose: ${selectedObligation?.purpose}`, `Admission ID: ${currentBill.admission_id}`, `Payment method: ${paymentMethod.trim()}`, notes.trim()].filter(Boolean).join("\n");
    const { data: insertedReceipt, error: insertError } = await supabase
      .from("payment_receipts")
      .insert({
        resident_id: residentId,
        bill_id: selectedBillId,
        receipt_url: filePath,
        original_file_name: selectedFile.name,
        reference_number: reference || null,
        amount: submittedAmount,
        status: "Pending Verification",
        verified: false,
        notes: receiptNotes || null,
        uploaded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (insertError || !insertedReceipt) {
      setError("The receipt file was uploaded, but the submission could not be linked to your bill. It was not marked complete; please contact an administrator for review.");
      setUploading(false);
      return;
    }

    const notificationResult = await requestEventNotification(
      "receipt_submitted",
      insertedReceipt.id,
    );
    setMessage(
      `Receipt submitted for verification. Your balance will change only after admin approval.${notificationWarning(notificationResult)}`,
    );
    setSelectedBillId("");
    setAmount("");
    setPaymentMethod("");
    setReferenceNumber("");
    setNotes("");
    setSelectedFile(null);
    const input = document.getElementById("payment-receipt-file") as HTMLInputElement | null;
    if (input) input.value = "";
    await loadData();
    setUploading(false);
  }

  return (
    <main className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">University Girls Hostel</p>
          <h1 className="mt-2 text-2xl font-bold text-slate-900 sm:text-3xl">Payments & Receipts</h1>
          <p className="mt-1 text-sm text-slate-500">{resident ? `Financial activity for ${resident.full_name ?? "Resident"}.` : "Submit receipts and review verification history."}</p>
          <div className="mt-4 flex flex-wrap gap-3"><Link href="/resident-portal" className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold">Portal Home</Link><Link href="/resident-portal/bills" className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white">My Bills</Link></div>
        </section>

        {(message || error) && <section className={`rounded-2xl border px-4 py-3 text-sm font-medium ${error ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>{error || message}</section>}

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
          {[['Rent Due', money(financial.monthlyRentDue)], ['Total Payable (Rent + Security Deposit)', money(combined.total)], ['Account Outstanding (all charges)', money(summary.outstanding)], ['Security Deposit Due', money(depositOutstanding)], ['Current Pending Bills', String(summary.pendingBills)], ['Overdue Bills', String(summary.overdueBills)], ['Verified Payments', money(summary.verifiedPayments)], ['Pending Verification', String(summary.pendingReceipts)]].map(([label, value]) => <article key={label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"><p className="text-sm text-slate-500">{label}</p><p className="mt-2 text-xl font-bold sm:text-2xl">{value}</p></article>)}
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <h2 className="text-xl font-bold">Upload Payment Receipt</h2>
          <p className="mt-1 text-sm text-slate-500">PDF, JPEG, or PNG; maximum 5 MB. Submission remains pending until verified.</p>
          {selectedBillId === "combined" && <p className="mt-4 text-sm text-amber-800">Rent: {money(financial.monthlyRentDue)}. Security Deposit: {money(depositOutstanding)}. Submit one receipt for the exact combined amount; it will remain pending until admin verification.</p>}
          {!regularBills.length && financial.monthlyRentDue > 0 && <p className="mt-4 text-sm">Rent is due. Contact management to issue your rent bill before submitting payment.</p>}
          <form onSubmit={uploadReceipt} className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
            <label className="min-w-0"><span className="mb-2 block text-sm font-semibold">Payment For *</span><select required value={selectedBillId} onChange={(event) => selectBill(event.target.value)} disabled={loading || uploading} className={inputClass}><option value="">Select an outstanding obligation</option>{financial.monthlyRentDue > 0 && !regularBills.some(bill => isPayableBill(bill.bill_status)) && <option disabled>Rent — {money(financial.monthlyRentDue)} due (awaiting bill)</option>}{depositOutstanding > 0 && <option value={depositBill ? depositBill.id : SECURITY_DEPOSIT_OPTION} disabled={pendingDepositReceipt || !depositBill}>{depositBill ? `Security Deposit (${depositBill.bill_number})` : "Security Deposit"} — {money(depositOutstanding)}{pendingDepositReceipt ? " — Pending Verification" : ""}</option>}{regularBills.filter((bill) => isPayableBill(bill.bill_status) && bill.outstanding > 0).map((bill) => <option key={bill.id} value={bill.id}>{bill.bill_number} — {monthLabel(bill.billing_month)} — {money(bill.outstanding)}</option>)}{financial.monthlyRentDue > 0 && depositOutstanding > 0 && <option value="combined">Rent + Security Deposit — {money(combined.total)} total due</option>}</select></label>
            <label className="min-w-0"><span className="mb-2 block text-sm font-semibold">Amount *</span><input required type="number" min="0.01" step="0.01" max={selectedBillId === SECURITY_DEPOSIT_OPTION || selectedBillId === depositBill?.id ? depositOutstanding : selectedObligation?.amount} value={withAdditional ? canonicalAmount : amount} onChange={(event) => setAmount(event.target.value)} readOnly={withAdditional || selectedBillId === "combined"} disabled={uploading || (!selectedBill && selectedBillId !== SECURITY_DEPOSIT_OPTION && selectedBillId !== "combined")} className={inputClass} /></label>
            <label className="min-w-0"><span className="mb-2 block text-sm font-semibold">Payment Method *</span><input required value={paymentMethod} onChange={(event) => setPaymentMethod(event.target.value)} disabled={uploading} className={inputClass} placeholder="Cash deposit, bank transfer, card, etc." /></label>
            <label className="min-w-0"><span className="mb-2 block text-sm font-semibold">Reference Number</span><input value={referenceNumber} onChange={(event) => setReferenceNumber(event.target.value)} disabled={uploading} className={inputClass} placeholder="Transaction reference" /></label>
            <label className="min-w-0 md:col-span-2"><span className="mb-2 block text-sm font-semibold">Receipt File *</span><input id="payment-receipt-file" required type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" onChange={handleFileChange} disabled={uploading} className={inputClass} /></label>
            <label className="min-w-0 md:col-span-2"><span className="mb-2 block text-sm font-semibold">Notes</span><textarea value={notes} onChange={(event) => setNotes(event.target.value)} disabled={uploading} className={`${inputClass} min-h-24`} /></label>
            {(selectedBillId === "combined" || selectedObligation?.purpose === "Rent" || selectedObligation?.purpose === "Security Deposit") && <div className="space-y-3 rounded-xl border border-slate-200 p-4 md:col-span-2">
              <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={withAdditional} disabled={uploading} onChange={event => setWithAdditional(event.target.checked)} />I paid additional charges with this payment</label>
              {withAdditional && <>
                <p className="text-sm">{selectedBillId === "combined" ? `Rent: ${money(financial.monthlyRentDue)} + Security Deposit: ${money(depositOutstanding)}` : `${selectedObligation?.purpose}: ${money(canonicalAmount)}`}</p>
                <label className="block text-sm">Additional Charges Amount (PKR)<input required type="number" min="0.01" step="0.01" value={additionalAmount} onChange={e => setAdditionalAmount(e.target.value)} disabled={uploading} className={inputClass} /></label>
                <label className="block text-sm">Additional Charges For<select value={additionalCategory} onChange={e => setAdditionalCategory(e.target.value)} disabled={uploading} className={inputClass}>{ADDITIONAL_CATEGORIES.map(category => <option key={category}>{category}</option>)}</select></label>
                <label className="block text-sm">Description{additionalCategory === "Other" ? " (required)" : " (optional)"}<input maxLength={500} required={additionalCategory === "Other"} value={additionalDescription} onChange={e => setAdditionalDescription(e.target.value)} disabled={uploading} className={inputClass} /></label>
                <p className="font-semibold">Total Amount Paid: {money(actualTotal)}</p>
                <p className="text-xs text-slate-500">Additional charges are a declaration pending staff confirmation. Late Fee payments remain separate.</p>
              </>}
            </div>}
            <p className="break-words text-sm md:col-span-2">Purpose: {selectedBillId === "combined" ? "Rent + Security Deposit" : selectedBillId === depositBill?.id ? "Security Deposit" : selectedBill ? selectedObligation?.purpose : "Not selected"} — Amount: {money(amount)} — Method: {paymentMethod || "Not selected"} — Reference: {referenceNumber || "None"} — Proof: {selectedFile?.name || "Not selected"}</p>
            <div className="md:col-span-2"><button type="submit" disabled={uploading || loading || !selectedBill && selectedBillId !== "combined" && selectedBillId !== SECURITY_DEPOSIT_OPTION} className="w-full rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white disabled:opacity-60 sm:w-auto">{uploading ? "Submitting..." : "Submit for Verification"}</button></div>
          </form>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <h2 className="text-xl font-bold text-slate-900">Security Deposit</h2>
          <p className="mt-1 text-sm text-slate-500">Your security deposit obligation and verification status.</p>
          <div className="mt-4">
            {loading ? (
              <p className="py-6 text-center text-sm text-slate-500">Loading...</p>
            ) : bills.filter((b) => isSecurityDepositBill(b)).length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
                No security deposit on record.
              </div>
            ) : (
              <div className="space-y-3">
                {bills
                  .filter((b) => isSecurityDepositBill(b))
                  .map((dep) => (
                    <div
                      key={dep.id}
                      className="flex flex-col gap-3 rounded-2xl border border-indigo-100 bg-indigo-50/50 p-4 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div>
                        <p className="font-semibold text-slate-900">
                          Security Deposit Bill ({dep.bill_number})
                        </p>
                        <p className="mt-1 text-sm text-slate-600">
                          Total: {money(dep.total_amount)} · Paid: {money(dep.paid)} · Balance: {money(dep.outstanding)}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Status value={dep.displayStatus} />
                        {isPayableBill(dep.bill_status) && dep.outstanding > 0 && (
                          <button
                            type="button"
                            onClick={() => selectBill(dep.id)}
                            className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-700"
                          >
                            Select for Payment
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </section>

        <HistoryTable
          title="My Bills"
          headers={["Bill No.", "Month", "Due Date", "Rent", "Electricity", "AC", "Other", "Discount", "Total", "Verified Paid", "Outstanding", "Status"]}
          loading={loading}
          empty="No bills found."
          rows={bills.map((bill) => [
            bill.bill_number,
            isSecurityDepositBill(bill) ? "Security Deposit" : monthLabel(bill.billing_month),
            bill.due_date || "—",
            money(bill.rent_amount),
            money(bill.electricity_amount),
            money(bill.ac_amount),
            money(bill.other_amount),
            money(bill.discount_amount),
            money(bill.total_amount),
            money(bill.paid),
            money(bill.outstanding),
            <Status key="status" value={bill.displayStatus} />,
          ])}
        />

        <HistoryTable title="Payment History (all admissions)" headers={["Payment", "Type / Purpose", "Date", "Amount", "Method", "Reference", "Status", "Verification", "Notes"]} loading={loading} empty="No payment history found." rows={paymentHistoryRows} />
        <HistoryTable title="Receipt History" headers={["Date", "Payment For", "Amount", "Reference", "Status", "Notes"]} loading={loading} empty="No receipt submissions found." rows={receipts.map((receipt) => { const bill = bills.find((item) => item.id === receipt.bill_id); const depositReceipt = (!receipt.bill_id && securityDepositAdmissionId(receipt.notes) === admission?.id) || (bill && isSecurityDepositBill(bill)); return [receipt.created_at.slice(0, 10), depositReceipt ? `Security Deposit${bill ? ` (${bill.bill_number})` : ""}` : receipt.notes?.match(/^Payment purpose:[ \t]*(.+)$/im)?.[1] || bill?.bill_number || "Historical bill", money(receipt.amount), receipt.reference_number ?? "—", <Status key="status" value={receipt.status} />, residentReceiptNotes(receipt.notes) || "—"]; })} />
      </div>
    </main>
  );
}

function Status({ value }: { value: string }) {
  return <span className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${statusClass(value)}`}>{value}</span>;
}

function HistoryTable({ title, headers, rows, loading, empty }: { title: string; headers: string[]; rows: React.ReactNode[][]; loading: boolean; empty: string }) {
  return <section className="rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-200 p-5"><h2 className="text-xl font-bold">{title}</h2></div><div className="overflow-x-auto"><table className="min-w-full divide-y divide-slate-200"><thead className="bg-slate-50"><tr>{headers.map((header) => <th key={header} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{header}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{loading ? <tr><td colSpan={headers.length} className="px-5 py-10 text-center text-sm text-slate-500">Loading...</td></tr> : rows.length === 0 ? <tr><td colSpan={headers.length} className="px-5 py-10 text-center text-sm text-slate-500">{empty}</td></tr> : rows.map((row, index) => <tr key={`${title}-${index}`}>{row.map((cell, cellIndex) => <td key={`${title}-${index}-${cellIndex}`} className="px-4 py-4 text-sm text-slate-700">{cell}</td>)}</tr>)}</tbody></table></div></section>;
}
