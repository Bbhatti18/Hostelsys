"use client";
import BillPaymentActions from "@/components/payments/BillPaymentActions";
import GenerateMissingRentBill from "@/components/payments/GenerateMissingRentBill";
import { isCurrentRentAdmission, missingRentMonths } from "@/lib/missingRentPeriods";

import {
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  Suspense,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { billingMonth as canonicalBillingMonth } from "@/lib/canonical";
import { supabase } from "@/lib/supabase";
import {
  deriveBillStatus,
  getVerifiedPaymentTotal,
  roundMoney,
  refreshBillFinancials,
} from "@/lib/financials";
import { getSupabaseErrorMessage } from "@/lib/supabaseErrors";
import { paymentBillAmounts } from "@/lib/paymentAllocations";
import {
  notificationWarning,
  requestEventNotification,
} from "@/lib/notifications/client";
import {
  billingMonthOf,
  isUnapprovedBill,
  UNAPPROVED_BILL_STATUSES,
} from "@/lib/billApproval";
import {
  approveBills,
  generateBillsForMonth,
  type ApprovalResult,
  type BulkGenerateResult,
} from "@/lib/billingActions";
import { usePermissions } from "@/lib/usePermissions";
import Link from "next/link";
import {
  getMeterReadingConfig,
  isResidentElectricityEnabled,
  type MeterReadingConfig,
  DEFAULT_UNIT_RATE,
} from "@/lib/meterReading";

type GenericRow = Record<string, unknown>;

type BillStatus =
  | "Draft"
  | "Pending Approval"
  | "Pending"
  | "Partially Paid"
  | "Paid"
  | "Overdue"
  | "Cancelled";

type Toast = {
  id: number;
  tone: "success" | "error" | "info";
  title: string;
  detail?: string;
};

type Bill = {
  id: string;
  bill_number: string;
  resident_id: string;
  admission_id: string | null;
  billing_month: string;
  rent_amount: number;
  electricity_amount: number;
  ac_amount: number;
  other_amount: number;
  discount_amount: number;
  total_amount: number;
  paid_amount: number;
  balance_amount: number;
  due_date: string;
  bill_status: BillStatus;
  bill_type: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type BillForm = {
  resident_id: string;
  admission_id: string;
  room_id: string;
  billing_month: string;
  rent_amount: string;
  electricity_amount: string;
  ac_amount: string;
  other_amount: string;
  discount_amount: string;
  paid_amount: string;
  due_date: string;
  bill_status: BillStatus;
  bill_type: string;
  notes: string;
  previous_reading: string;
  current_reading: string;
  rate_per_unit: string;
};

type AcBill = {
  id: string;
  bill_id: string | null;
  resident_id: string;
  admission_id: string | null;
  billing_month: string;
  previous_reading: number;
  current_reading: number;
  units_consumed: number;
  rate_per_unit: number;
  total_amount: number;
  remarks: string | null;
};

const currentMonth = new Date().toISOString().slice(0, 7);

function monthInputValue(value: string) {
  return value ? value.slice(0, 7) : "";
}

function monthStartDate(value: string) {
  const month = monthInputValue(value);
  return month ? `${month}-01` : "";
}

function monthEndDate(value: string) {
  const month = monthInputValue(value);
  const [year, monthNumber] = month.split("-").map(Number);
  if (!year || !monthNumber || monthNumber < 1 || monthNumber > 12) return "";

  return new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
}

const today = new Date().toISOString().slice(0, 10);

const emptyForm: BillForm = {
  resident_id: "",
  admission_id: "",
  room_id: "",
  billing_month: currentMonth,
  rent_amount: "",
  electricity_amount: "",
  ac_amount: "",
  other_amount: "",
  discount_amount: "",
  paid_amount: "0",
  due_date: monthEndDate(currentMonth),
  bill_status: "Pending",
  bill_type: "Rent",
  notes: "",
  previous_reading: "",
  current_reading: "",
  rate_per_unit: "",
};

const inputClass =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-slate-100";

const acBillColumns =
  "id, bill_id, resident_id, admission_id, billing_month, previous_reading, current_reading, units_consumed, rate_per_unit, total_amount, remarks";

function text(value: unknown) {
  return value == null ? "" : String(value);
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizedStatus(value: unknown) {
  return text(value).trim().toLowerCase();
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
  }).format(numberValue(value));
}

function statusClass(status: BillStatus) {
  if (status === "Pending Approval") return "bg-violet-100 text-violet-700";
  if (status === "Draft") return "bg-slate-100 text-slate-600";
  if (status === "Paid") return "bg-emerald-100 text-emerald-700";
  if (status === "Partially Paid") return "bg-blue-100 text-blue-700";
  if (status === "Overdue") return "bg-red-100 text-red-700";
  if (status === "Cancelled") return "bg-slate-200 text-slate-700";
  return "bg-amber-100 text-amber-700";
}

function makeBillNumber(prefix = "BILL") {
  return `${prefix}-${new Date().getFullYear()}-${Date.now()
    .toString()
    .slice(-7)}`;
}

function monthLabel(value: string) {
  if (!value) return "No month";

  const parsed = new Date(`${monthStartDate(value)}T00:00:00`);

  if (Number.isNaN(parsed.getTime())) return value;

  return parsed.toLocaleDateString("en-PK", {
    month: "long",
    year: "numeric",
  });
}

export default function BillingPage() {
  return (
    <Suspense>
      <BillingContent />
    </Suspense>
  );
}

function BillingContent() {
  const { canViewRevenue, role, profile } = usePermissions();
  const [bills, setBills] = useState<Bill[]>([]);
  const [residents, setResidents] = useState<GenericRow[]>([]);
  const [admissions, setAdmissions] = useState<GenericRow[]>([]);
  const [rooms, setRooms] = useState<GenericRow[]>([]);
  const [beds, setBeds] = useState<GenericRow[]>([]);
  const [acBills, setAcBills] = useState<AcBill[]>([]);
  const [meterConfig, setMeterConfig] = useState<MeterReadingConfig | null>(null);
  const [payments, setPayments] = useState<GenericRow[]>([]);
  const [receipts, setReceipts] = useState<GenericRow[]>([]);
  const [form, setForm] = useState<BillForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingAcBillId, setEditingAcBillId] = useState<string | null>(null);
  const [recordingPaymentBill, setRecordingPaymentBill] = useState<Bill | null>(null);
  const [paymentForm, setPaymentForm] = useState({
    payment_date: today,
    amount: "",
    payment_method: "Bank Transfer",
    reference_number: "",
    notes: ""
  });
  const [editingWithoutMeterRecord, setEditingWithoutMeterRecord] =
    useState(false);
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [monthFilter, setMonthFilter] = useState("All");
  const searchParams = useSearchParams();
  const [typeFilter, setTypeFilter] = useState(searchParams.get("type") || "Rent");
  const [ledgerResidentId, setLedgerResidentId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previousReadingEdited, setPreviousReadingEdited] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [generating, setGenerating] = useState(false);
  const [approvingIds, setApprovingIds] = useState<string[]>([]);
  const [selectedForApproval, setSelectedForApproval] = useState<string[]>([]);
  const [billEmailStatus, setBillEmailStatus] = useState<Record<string, string>>({});
  const [sendingEmailBillId, setSendingEmailBillId] = useState<string | null>(null);
  const editRequestId = useRef(0);
  const toastId = useRef(0);

  const pushToast = useCallback(
    (tone: Toast["tone"], title: string, detail?: string) => {
      toastId.current += 1;
      const id = toastId.current;
      setToasts((current) => [...current, { id, tone, title, detail }]);
      window.setTimeout(
        () => setToasts((current) => current.filter((item) => item.id !== id)),
        tone === "error" ? 9000 : 6000,
      );
    },
    [],
  );

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const loadBillEmailStatuses = useCallback(async () => {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) return;
      const response = await fetch("/api/notifications/events?eventType=bill_generated", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!response.ok) return;
      const payload = (await response.json().catch(() => null)) as {
        logs?: Array<{ entity_id?: string; email_status?: string | null }>;
      } | null;
      const map: Record<string, string> = {};
      for (const row of payload?.logs ?? []) {
        const entityId = text(row.entity_id);
        const status = text(row.email_status).toLowerCase();
        if (!entityId) continue;
        if (!map[entityId] || status === "sent") {
          map[entityId] = status || "not_sent";
        }
      }
      setBillEmailStatus(map);
    } catch {
      // Ignore non-fatal email status lookup errors
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");

    const [billsResult, residentsResult, admissionsResult, roomsResult, acBillsResult, paymentsResult, receiptsResult, loadedMeterConfig] =
      await Promise.all([
        supabase
          .from("bills")
          .select("*")
          .order("created_at", { ascending: false }),
        supabase
          .from("residents")
          .select("*")
          .order("created_at", { ascending: false }),
        supabase
          .from("admissions")
          .select("*")
          .order("created_at", { ascending: false }),
        supabase.from("rooms").select("id, room_number, status"),
        supabase
          .from("ac_bills")
          .select(acBillColumns)
          .order("billing_month", { ascending: false }),
        supabase
          .from("payments")
          .select("id, bill_id, resident_id, payment_number, payment_date, amount, payment_status, reference_number, payment_allocations(payment_id,bill_id,amount)")
          .order("payment_date", { ascending: false }),
        supabase
          .from("payment_receipts")
          .select("id, bill_id, resident_id, status, receipt_url, amount, created_at"),
        getMeterReadingConfig(supabase),
      ]);

    const firstError =
      billsResult.error ||
      residentsResult.error ||
      admissionsResult.error ||
      roomsResult.error ||
      acBillsResult.error ||
      paymentsResult.error ||
      receiptsResult.error;

    if (firstError) {
      setError(getSupabaseErrorMessage(firstError, "Billing records could not be loaded."));
    } else {
      const verifiedByBill = new Map<string, number>();
      for (const payment of paymentsResult.data ?? []) {
        if (payment.payment_status !== "Verified") continue;
        for (const allocation of paymentBillAmounts(payment, payment.payment_allocations ?? [])) {
          const billId = text(allocation.bill_id);
          if (!billId) continue;
          verifiedByBill.set(billId, roundMoney((verifiedByBill.get(billId) ?? 0) + numberValue(allocation.amount)));
        }
      }
      setBills(
        ((billsResult.data ?? []) as Bill[]).map((bill) => {
          const paid = verifiedByBill.get(bill.id) ?? 0;
          const balance = Math.max(roundMoney(numberValue(bill.total_amount) - paid), 0);
          const currentStatus =
            normalizedStatus(bill.bill_status) === "cancelled"
              ? "Cancelled"
              : bill.bill_status;
          return {
            ...bill,
            paid_amount: paid,
            balance_amount: balance,
            bill_status: deriveBillStatus(
              numberValue(bill.total_amount),
              paid,
              bill.due_date,
              currentStatus,
            ),
          };
        }),
      );
      setResidents((residentsResult.data ?? []) as GenericRow[]);
      setAdmissions((admissionsResult.data ?? []) as GenericRow[]);
      setRooms((roomsResult.data ?? []) as GenericRow[]);
      setAcBills((acBillsResult.data ?? []) as AcBill[]);
      setMeterConfig(loadedMeterConfig);
      setPayments((paymentsResult.data ?? []) as GenericRow[]);
      setReceipts((receiptsResult.data ?? []) as GenericRow[]);
      await loadBillEmailStatuses();
    }

    setLoading(false);
  }, [loadBillEmailStatuses]);

  useEffect(() => {
    setTypeFilter(searchParams.get("type") || "Rent");
    const id = searchParams.get("billId");
    if (id) setSearch(id);
  }, [searchParams]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void refresh(), 0);
    const refreshOnFocus = () => void refresh();
    window.addEventListener("focus", refreshOnFocus);
    return () => { window.clearTimeout(timeoutId); window.removeEventListener("focus", refreshOnFocus); };
  }, [refresh]);

  const isElectricityEnabled = Boolean(
    form.resident_id && isResidentElectricityEnabled(meterConfig, form.resident_id)
  );

  const computed = useMemo(() => {
    const units = Math.max(
      roundMoney(numberValue(form.current_reading) - numberValue(form.previous_reading)),
      0,
    );
    const meterAmount = roundMoney(units * numberValue(form.rate_per_unit));
    const acAmount = !isElectricityEnabled && form.resident_id
      ? 0
      : form.current_reading || form.previous_reading || form.rate_per_unit
      ? meterAmount
      : numberValue(form.ac_amount);
    const electricityAmount = !isElectricityEnabled && form.resident_id
      ? 0
      : numberValue(form.electricity_amount);
    const subtotal =
      numberValue(form.rent_amount) +
      electricityAmount +
      acAmount +
      numberValue(form.other_amount);

    const total = Math.max(
      subtotal - numberValue(form.discount_amount),
      0
    );

    const paid = Math.min(numberValue(form.paid_amount), total);
    const balance = Math.max(total - paid, 0);

    return { subtotal, total, paid, balance, units, acAmount, electricityAmount };
  }, [form, isElectricityEnabled]);

  const filteredBills = useMemo(() => {
    const query = search.trim().toLowerCase();

    return bills.filter((bill) => {
      const resident = residents.find(
        (item) => text(item.id) === bill.resident_id
      );

      const searchable = [
        bill.id,
        bill.bill_number,
        residentName(resident),
        bill.billing_month,
      ]
        .join(" ")
        .toLowerCase();

      const matchesSearch =
        !query || searchable.includes(query);

      const matchesStatus =
        statusFilter === "All" ||
        bill.bill_status === statusFilter;

      const matchesMonth =
        monthFilter === "All" || bill.billing_month === monthFilter;

      const matchesType =
        typeFilter === "All" || (typeFilter === "Rent" && (!bill.bill_type || bill.bill_type === "Rent")) || bill.bill_type === typeFilter;

      return matchesSearch && matchesStatus && matchesMonth && matchesType;
    });
  }, [bills, residents, search, statusFilter, monthFilter, typeFilter]);

  const availableMonths = useMemo(
    () => [...new Set(bills.map((bill) => bill.billing_month))].sort().reverse(),
    [bills],
  );

  const ledgerBills = useMemo(
    () => bills.filter((bill) => bill.resident_id === ledgerResidentId),
    [bills, ledgerResidentId],
  );

  const summary = useMemo(() => {
    // Bills still awaiting approval are not receivables yet, and cancelled
    // bills never were, so neither belongs in the collection figures.
    const operationalBills = bills.filter(
      (bill) =>
        normalizedStatus(bill.bill_status) !== "cancelled" &&
        !isUnapprovedBill(bill.bill_status),
    );

    const pendingBalance = operationalBills.reduce(
      (sum, bill) => sum + numberValue(bill.balance_amount),
      0,
    );

    const collected = operationalBills.reduce(
      (sum, bill) => sum + numberValue(bill.paid_amount),
      0
    );

    return {
      total: bills.length,
      awaitingApproval: bills.filter((bill) =>
        isUnapprovedBill(bill.bill_status),
      ).length,
      pending: operationalBills.filter(
        (bill) => normalizedStatus(bill.bill_status) === "pending"
      ).length,
      overdue: operationalBills.filter(
        (bill) => normalizedStatus(bill.bill_status) === "overdue"
      ).length,
      pendingBalance,
      collected,
    };
  }, [bills]);

  const pendingApprovalBills = useMemo(
    () => bills.filter((bill) => isUnapprovedBill(bill.bill_status)),
    [bills],
  );

  const pendingApprovalIds = useMemo(
    () => pendingApprovalBills.map((bill) => bill.id),
    [pendingApprovalBills],
  );

  // Derived rather than synced: bills approved elsewhere or dropped by a
  // refresh fall out of the selection without an extra render pass.
  const approvalSelection = useMemo(
    () => selectedForApproval.filter((id) => pendingApprovalIds.includes(id)),
    [selectedForApproval, pendingApprovalIds],
  );

  const allPendingSelected =
    pendingApprovalIds.length > 0 &&
    approvalSelection.length === pendingApprovalIds.length;

  function toggleApprovalSelection(billId: string) {
    setSelectedForApproval((current) =>
      current.includes(billId)
        ? current.filter((id) => id !== billId)
        : [...current, billId],
    );
  }

  function toggleAllApprovalSelection() {
    setSelectedForApproval(allPendingSelected ? [] : pendingApprovalIds);
  }

  function describeApproval(result: ApprovalResult) {
    const failures = result.outcomes.filter((outcome) => !outcome.approved);
    const parts: string[] = [];

    if (result.emailedCount > 0) {
      parts.push(
        `${result.emailedCount} email${result.emailedCount === 1 ? "" : "s"} dispatched`,
      );
    }
    if (result.emailConfigurationRequired) {
      parts.push("email sending is not configured on the server");
    }
    const emailFailures = result.outcomes.filter(
      (outcome) => outcome.approved && outcome.emailStatus === "failed",
    ).length;
    if (emailFailures > 0) {
      parts.push(
        `${emailFailures} email${emailFailures === 1 ? "" : "s"} could not be sent`,
      );
    }
    const skippedEmails = result.outcomes.filter(
      (outcome) => outcome.approved && outcome.emailStatus === "skipped",
    ).length;
    if (skippedEmails > 0) {
      parts.push(`${skippedEmails} resident(s) had no reachable email`);
    }
    if (failures.length > 0) {
      parts.push(
        `${failures.length} bill${failures.length === 1 ? "" : "s"} were not approved (${failures[0].reason ?? "unknown reason"})`,
      );
    }

    return parts.join(" · ");
  }

  async function handleApprove(billIds: string[]) {
    if (billIds.length === 0 || approvingIds.length > 0) return;

    setMessage("");
    setError("");
    setApprovingIds(billIds);

    try {
      const result = await approveBills(billIds);

      if (result.approvedCount === 0) {
        const reason =
          result.outcomes.find((outcome) => !outcome.approved)?.reason ??
          "No bills were approved.";
        pushToast("error", "Nothing was approved", reason);
      } else {
        pushToast(
          result.emailConfigurationRequired ||
            result.outcomes.some(
              (outcome) => outcome.approved && outcome.emailStatus === "failed",
            )
            ? "info"
            : "success",
          `${result.approvedCount} bill${result.approvedCount === 1 ? "" : "s"} approved and released`,
          describeApproval(result) || undefined,
        );
      }

      setSelectedForApproval((current) =>
        current.filter((id) => !billIds.includes(id)),
      );
      await refresh();
    } catch (approvalError) {
      const detail =
        approvalError instanceof Error
          ? approvalError.message
          : "The bills could not be approved.";
      setError(detail);
      pushToast("error", "Approval failed", detail);
    } finally {
      setApprovingIds([]);
    }
  }

  function describeGeneration(result: BulkGenerateResult) {
    const parts = [
      `${result.activeAdmissionCount} active admission${result.activeAdmissionCount === 1 ? "" : "s"} reviewed`,
    ];
    if (result.createdCount > 0) parts.push("due dates follow each admission cycle");
    if (result.skipped.length > 0) {
      parts.push(
        `${result.skipped.length} skipped (${result.skipped[0].reason})`,
      );
    }
    return parts.join(" · ");
  }

  async function handleGenerateAll() {
    if (generating) return;

    const billingMonth = billingMonthOf();
    const confirmed = window.confirm(
      `Generate bills for every active admission for ${monthLabel(billingMonth)}?\n\n` +
        "Each bill is created as \"Pending Approval\" and stays hidden from residents " +
        "until you approve it. Residents with a bill for this month are skipped.",
    );
    if (!confirmed) return;

    setMessage("");
    setError("");
    setGenerating(true);

    try {
      const result = await generateBillsForMonth(billingMonth);

      if (result.createdCount === 0) {
        pushToast(
          "info",
          `No new bills for ${monthLabel(result.billingMonth)}`,
          describeGeneration(result),
        );
      } else {
        pushToast(
          "success",
          `${result.createdCount} bill${result.createdCount === 1 ? "" : "s"} generated for ${monthLabel(result.billingMonth)}`,
          describeGeneration(result),
        );
        setStatusFilter("Pending Approval");
      }

      await refresh();
    } catch (generateError) {
      const detail =
        generateError instanceof Error
          ? generateError.message
          : "Bills could not be generated.";
      setError(detail);
      pushToast("error", "Bulk generation failed", detail);
    } finally {
      setGenerating(false);
    }
  }

  function updateField<K extends keyof BillForm>(
    key: K,
    value: BillForm[K]
  ) {
    setForm((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function latestPreviousReading(admissionId: string, billingMonth: string, residentId?: string) {
    const selectedMonthStart = monthStartDate(billingMonth);
    const previousMeterBill = acBills.find(
      (item) =>
        ((admissionId && item.admission_id === admissionId) || (residentId && item.resident_id === residentId)) &&
        monthStartDate(item.billing_month) < selectedMonthStart,
    );
    return previousMeterBill ? String(previousMeterBill.current_reading) : "0";
  }

  function findRecordedMeterReading(admissionId: string, residentId: string, billingMonth: string) {
    const selectedMonthStart = monthStartDate(billingMonth);
    return acBills.find(
      (item) =>
        ((admissionId && item.admission_id === admissionId) || (residentId && item.resident_id === residentId)) &&
        monthStartDate(item.billing_month) === selectedMonthStart,
    );
  }

  const [verifyingReceipt, setVerifyingReceipt] = useState<GenericRow | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);

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

  async function updateReceiptStatus(
    receipt: GenericRow,
    nextStatus: "Verified" | "Rejected"
  ) {
    const rejectionReason =
      nextStatus === "Rejected"
        ? window.prompt("Enter the reason for rejecting this receipt:")?.trim()
        : "";
    if (nextStatus === "Rejected" && !rejectionReason) return;

    setIsVerifying(true);
    setMessage("");
    setError("");

    try {
      const accessToken = await getValidAccessToken();
      if (!accessToken) {
        throw new Error("Your admin session could not be verified. Please sign in again.");
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
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || "The receipt verification request failed.");
      }

      setMessage(
        `${payload?.message || `Receipt has been successfully ${nextStatus.toLowerCase()}.`}${
          payload?.notificationWarning ? " (Resident notification failed)" : ""
        }`
      );
      setVerifyingReceipt(null);
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An unexpected verification error occurred.");
    } finally {
      setIsVerifying(false);
    }
  }

  async function handleRecordPayment(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!recordingPaymentBill) return;

    setSaving(true);
    setMessage("");
    setError("");

    try {
      const amount = Number(paymentForm.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error("Payment amount must be greater than zero.");
      }
      const { data: currentBill, error: billError } = await supabase.from("bills")
        .select("id, resident_id, total_amount, bill_status").eq("id", recordingPaymentBill.id).single();
      if (billError || !currentBill || currentBill.resident_id !== recordingPaymentBill.resident_id ||
          ["Cancelled", "Draft", "Pending Approval"].includes(currentBill.bill_status)) {
        throw new Error("The selected bill is no longer payable. Refresh before recording payment.");
      }
      const paidNow = await getVerifiedPaymentTotal(recordingPaymentBill.id);
      const outstandingNow = Math.max(0, Number(currentBill.total_amount) - paidNow);
      if (amount > outstandingNow) {
        throw new Error(`Payment exceeds the current outstanding balance of ${money(outstandingNow)}.`);
      }

      // Check for duplicate reference
      if (paymentForm.reference_number.trim()) {
        const { data: duplicate } = await supabase
          .from("payments")
          .select("id")
          .eq("reference_number", paymentForm.reference_number.trim())
          .limit(1);
        if (duplicate && duplicate.length > 0) {
          throw new Error("This reference number is already used by another payment.");
        }
      }

      // Generate payment number format: PAY-YYYYMMDD-XXXX
      const datePart = today.replace(/-/g, "");
      const randomPart = Math.floor(1000 + Math.random() * 9000);
      const paymentNumber = `PAY-${datePart}-${randomPart}`;

      const { error: insertError } = await supabase.from("payments").insert({
        payment_number: paymentNumber,
        bill_id: recordingPaymentBill.id,
        resident_id: recordingPaymentBill.resident_id,
        payment_date: paymentForm.payment_date || today,
        amount,
        payment_method: paymentForm.payment_method,
        reference_number: paymentForm.reference_number || null,
        notes: paymentForm.notes || null,
        payment_status: "Verified",
        verified: true,
        verified_by: "Admin",
        verified_at: new Date().toISOString(),
      });

      if (insertError) throw insertError;

      await refreshBillFinancials(recordingPaymentBill.id);

      setMessage("Payment successfully recorded.");
      setRecordingPaymentBill(null);
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : getSupabaseErrorMessage(err as any, "Failed to record payment."));
    } finally {
      setSaving(false);
    }
  }

  function openPaymentForm(bill: Bill) {
    setRecordingPaymentBill(bill);
    setPaymentForm({
      payment_date: today,
      amount: String(bill.balance_amount),
      payment_method: "Bank Transfer",
      reference_number: "",
      notes: ""
    });
    setMessage("");
    setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openAddForm() {
    editRequestId.current += 1;
    setEditingId(null);
    setEditingAcBillId(null);
    setEditingWithoutMeterRecord(false);
    setForm({
      ...emptyForm,
      bill_type: typeFilter === "Security Deposit" ? "Security Deposit" : "Rent",
      billing_month: typeFilter === "Security Deposit" ? "Security Deposit" : billingMonthOf(),
    });
    setPreviousReadingEdited(false);
    setShowForm(true);
    setMessage("");
    setError("");
  }

  async function openEditForm(bill: Bill) {
    const requestId = editRequestId.current + 1;
    editRequestId.current = requestId;
    setShowForm(false);
    setMessage("");
    setError("");

    const baseForm: BillForm = {
      resident_id: bill.resident_id,
      admission_id: bill.admission_id ?? "",
      room_id: firstText(
        admissions.find((item) => text(item.id) === bill.admission_id),
        ["room_id"],
      ),
      billing_month: monthInputValue(bill.billing_month),
      rent_amount: String(bill.rent_amount ?? 0),
      electricity_amount: String(bill.electricity_amount ?? 0),
      ac_amount: String(bill.ac_amount ?? 0),
      other_amount: String(bill.other_amount ?? 0),
      discount_amount: String(bill.discount_amount ?? 0),
      paid_amount: String(bill.paid_amount ?? 0),
      due_date: bill.due_date ?? "",
      bill_status: bill.bill_status,
      bill_type: bill.bill_type || "Rent",
      notes: bill.notes ?? "",
      previous_reading: "",
      current_reading: "",
      rate_per_unit: "",
    };

    const { data: linkedMeterRows, error: linkedMeterError } = await supabase
      .from("ac_bills")
      .select(acBillColumns)
      .eq("bill_id", bill.id);

    if (requestId !== editRequestId.current) return;

    if (linkedMeterError) {
      setEditingId(bill.id);
      setEditingAcBillId(null);
      setEditingWithoutMeterRecord(false);
      setForm(baseForm);
      setPreviousReadingEdited(true);
      setShowForm(true);
      setError("Bill loaded, but its AC meter details could not be retrieved. Please refresh and try again.");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    const expectedMonth = canonicalBillingMonth(bill.billing_month);
    const exactLinkedRows = (linkedMeterRows ?? []) as AcBill[];
    let meterBill: AcBill | null = exactLinkedRows[0] ?? null;

    if (exactLinkedRows.length > 1) {
      setEditingId(bill.id);
      setEditingAcBillId(null);
      setEditingWithoutMeterRecord(false);
      setForm(baseForm);
      setPreviousReadingEdited(true);
      setShowForm(true);
      setError("Multiple AC meter records were found for this bill. Please review the AC records.");
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }

    if (!meterBill && bill.admission_id) {
      const { data: admissionRows, error: admissionLookupError } = await supabase
        .from("ac_bills")
        .select(acBillColumns)
        .eq("admission_id", bill.admission_id)
        .eq("resident_id", bill.resident_id)
        .eq("billing_month", expectedMonth);

      if (requestId !== editRequestId.current) return;

      if (admissionLookupError) {
        setEditingId(bill.id);
        setEditingAcBillId(null);
        setEditingWithoutMeterRecord(false);
        setForm(baseForm);
        setPreviousReadingEdited(true);
        setShowForm(true);
        setError("Bill loaded, but its AC meter details could not be retrieved. Please refresh and try again.");
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }

      const exactAdmissionRows = (admissionRows ?? []) as AcBill[];
      if (exactAdmissionRows.length > 1) {
        setEditingId(bill.id);
        setEditingAcBillId(null);
        setEditingWithoutMeterRecord(false);
        setForm(baseForm);
        setPreviousReadingEdited(true);
        setShowForm(true);
        setError("Multiple AC meter records were found for this bill. Please review the AC records.");
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      meterBill = exactAdmissionRows[0] ?? null;
    }

    if (!meterBill) {
      const { data: residentRows, error: residentLookupError } = await supabase
        .from("ac_bills")
        .select(acBillColumns)
        .eq("resident_id", bill.resident_id)
        .eq("billing_month", expectedMonth);

      if (requestId !== editRequestId.current) return;

      if (residentLookupError) {
        setEditingId(bill.id);
        setEditingAcBillId(null);
        setEditingWithoutMeterRecord(false);
        setForm(baseForm);
        setPreviousReadingEdited(true);
        setShowForm(true);
        setError("Bill loaded, but its AC meter details could not be retrieved. Please refresh and try again.");
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }

      const exactResidentRows = (residentRows ?? []) as AcBill[];
      if (exactResidentRows.length > 1) {
        setEditingId(bill.id);
        setEditingAcBillId(null);
        setEditingWithoutMeterRecord(false);
        setForm(baseForm);
        setPreviousReadingEdited(true);
        setShowForm(true);
        setError("Multiple AC meter records were found for this bill. Please review the AC records.");
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      meterBill = exactResidentRows.length === 1 ? exactResidentRows[0] : null;
    }

    if (requestId !== editRequestId.current) return;

    setEditingId(bill.id);
    setEditingAcBillId(meterBill?.id ?? null);
    setEditingWithoutMeterRecord(!meterBill);
    setForm({
      ...baseForm,
      ac_amount: meterBill
        ? String(meterBill.total_amount ?? bill.ac_amount ?? 0)
        : baseForm.ac_amount,
      previous_reading: meterBill ? String(meterBill.previous_reading) : "",
      current_reading: meterBill ? String(meterBill.current_reading) : "",
      rate_per_unit: meterBill ? String(meterBill.rate_per_unit) : "",
    });
    setPreviousReadingEdited(true);
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function applyAdmission(admissionId: string) {
    const admission = admissions.find(
      (item) => text(item.id) === admissionId
    );

    if (!admission) {
      updateField("admission_id", "");
      return;
    }

    setPreviousReadingEdited(false);
    const residentId = firstText(admission, ["resident_id"]);
    const isElectricityEnabled = isResidentElectricityEnabled(meterConfig, residentId);
    const currentMonth = form.billing_month || billingMonthOf();
    const recordedMeter = isElectricityEnabled
      ? findRecordedMeterReading(admissionId, residentId, currentMonth)
      : null;

    setForm((current) => ({
      ...current,
      admission_id: admissionId,
      resident_id: residentId,
      room_id: firstText(admission, ["room_id"]),
      rent_amount: firstText(admission, [
        "monthly_rent",
        "rent_amount",
      ]),
      previous_reading: recordedMeter
        ? String(recordedMeter.previous_reading)
        : isElectricityEnabled
        ? latestPreviousReading(admissionId, current.billing_month, residentId)
        : "",
      current_reading: recordedMeter
        ? String(recordedMeter.current_reading)
        : "",
      rate_per_unit: recordedMeter
        ? String(recordedMeter.rate_per_unit)
        : isElectricityEnabled
        ? String(meterConfig?.default_unit_rate || DEFAULT_UNIT_RATE)
        : "",
      ac_amount: recordedMeter
        ? String(recordedMeter.total_amount)
        : isElectricityEnabled
        ? ""
        : "0",
      electricity_amount: isElectricityEnabled ? current.electricity_amount : "0",
    }));
  }

  async function saveBill(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setSaving(true);
    setMessage("");
    setError("");

    if (
      !form.resident_id ||
      !form.admission_id ||
      !form.billing_month ||
      !form.due_date
    ) {
      setError(
        "Resident, current admission, billing month and due date are required."
      );
      setSaving(false);
      return;
    }

    const meterSupplied = Boolean(
      form.previous_reading || form.current_reading || form.rate_per_unit,
    );
    const acBillingMonth = canonicalBillingMonth(form.billing_month);
    const preExistingReading = acBills.find(
      (item) =>
        ((form.admission_id && item.admission_id === form.admission_id) ||
          (form.resident_id && item.resident_id === form.resident_id)) &&
        item.billing_month === acBillingMonth,
    );
    const currentMeterBillId = editingId
      ? editingAcBillId ?? acBills.find((item) => item.bill_id === editingId)?.id
      : preExistingReading?.id;
    if (
      meterSupplied &&
      (numberValue(form.previous_reading) < 0 ||
        numberValue(form.current_reading) < numberValue(form.previous_reading) ||
        numberValue(form.rate_per_unit) <= 0)
    ) {
      setError("Current reading must be at least the previous reading, and the rate must be greater than zero.");
      setSaving(false);
      return;
    }

    const { data: currentAdmission, error: admissionError } = await supabase
      .from("admissions")
      .select("id, resident_id, room_id, status")
      .eq("id", form.admission_id)
      .single();

    if (
      admissionError ||
      !currentAdmission ||
      text(currentAdmission.resident_id) !== form.resident_id ||
      (!editingId && currentAdmission.status !== "Active")
    ) {
      setError("The selected resident no longer has this active admission. Refresh and select a current admission.");
      setSaving(false);
      return;
    }

    {
      let duplicateQuery = supabase
        .from("bills")
        .select("id")
        .eq("admission_id", form.admission_id)
        .eq("billing_month", form.bill_type === "Security Deposit" ? "Security Deposit" : form.billing_month)
        .neq("bill_status", "Cancelled")
        .limit(1);
      duplicateQuery = form.bill_type === "Security Deposit" ? duplicateQuery.eq("bill_type", "Security Deposit") : duplicateQuery.neq("bill_type", "Security Deposit");
      if (editingId) duplicateQuery = duplicateQuery.neq("id", editingId);
      const { data: duplicate, error: duplicateError } = await duplicateQuery;
      if (duplicateError) {
        setError(getSupabaseErrorMessage(duplicateError, "Unable to check for an existing monthly bill."));
        setSaving(false);
        return;
      }

      if (meterSupplied) {
        let duplicateMeterQuery = supabase
          .from("ac_bills")
          .select("id, bill_id")
          .eq("admission_id", form.admission_id)
          .eq("billing_month", acBillingMonth)
          .limit(1);
        if (currentMeterBillId) {
          duplicateMeterQuery = duplicateMeterQuery.neq("id", currentMeterBillId);
        }
        const { data: duplicateMeter, error: meterDuplicateError } =
          await duplicateMeterQuery;
        if (meterDuplicateError) {
          setError("Unable to check for an existing AC bill for this month.");
          setSaving(false);
          return;
        }
        if ((duplicateMeter ?? []).some((row) => row.bill_id && row.bill_id !== editingId)) {
          setError("An AC bill already exists for this admission and billing month.");
          setSaving(false);
          return;
        }
      }
      if ((duplicate ?? []).length > 0) {
        setError("A non-cancelled bill already exists for this admission and billing month.");
        setSaving(false);
        return;
      }
    }

    if (editingId) {
      const { data: existingBill, error: existingError } = await supabase.from("bills")
        .select("resident_id, admission_id, bill_type").eq("id", editingId).single();
      if (existingError || !existingBill || existingBill.resident_id !== form.resident_id ||
          existingBill.admission_id !== (form.admission_id || null) || existingBill.bill_type !== form.bill_type) {
        setError("An existing bill cannot be moved to another resident, admission or obligation. Cancel it and issue the correct bill.");
        setSaving(false); return;
      }
    }
    const verifiedPaid = editingId
      ? await getVerifiedPaymentTotal(editingId).catch(() => null)
      : 0;
    if (verifiedPaid === null) {
      setError("Unable to confirm the verified payments for this bill.");
      setSaving(false);
      return;
    }
    if (verifiedPaid > computed.total) {
      setError("The revised bill total cannot be lower than its verified payments.");
      setSaving(false);
      return;
    }

    let finalStatus = deriveBillStatus(
      computed.total,
      verifiedPaid,
      form.due_date,
      form.bill_status,
    );

    if (form.bill_status === "Cancelled") {
      if (verifiedPaid > 0) { setError("Cancel or reconcile verified payments before cancelling their bill."); setSaving(false); return; }
      finalStatus = "Cancelled";
    }

    const payload = {
      resident_id: form.resident_id,
      admission_id: form.admission_id || null,
      billing_month: form.bill_type === "Security Deposit" ? "Security Deposit" : form.billing_month,
      bill_type: form.bill_type || "Rent",
      rent_amount: numberValue(form.rent_amount),
      electricity_amount: numberValue(
        form.electricity_amount
      ),
      ac_amount: computed.acAmount,
      other_amount: numberValue(form.other_amount),
      discount_amount: numberValue(form.discount_amount),
      total_amount: computed.total,
      paid_amount: verifiedPaid,
      balance_amount: Math.max(roundMoney(computed.total - verifiedPaid), 0),
      due_date: form.due_date,
      bill_status: finalStatus,
      notes: form.notes.trim() || null,
      updated_at: new Date().toISOString(),
    };

    const result = editingId
      ? await supabase
          .from("bills")
          .update(payload)
          .eq("id", editingId)
          .select("id")
          .single()
      : await supabase.from("bills").insert({
          ...payload,
          bill_number: makeBillNumber(form.bill_type === "Security Deposit" ? "DEP" : "BILL"),
        }).select("id").single();

    if (result.error) {
      setError(getSupabaseErrorMessage(result.error, "The bill could not be saved. Please verify the details and try again.", "A bill with these details already exists."));
    } else {
      const savedBillId = text(result.data?.id);
      if (form.bill_type === "Security Deposit") {
        try { await refreshBillFinancials(savedBillId); }
        catch { setError("Bill saved, but deposit status needs reconciliation. Refresh before proceeding."); setSaving(false); await refresh(); return; }
      }
      const existingMeterBillId =
        currentMeterBillId ??
        preExistingReading?.id ??
        acBills.find((item) => item.bill_id === savedBillId)?.id;
      if (meterSupplied) {
        const meterPayload = {
          resident_id: form.resident_id,
          admission_id: form.admission_id,
          bill_id: savedBillId,
          billing_month: acBillingMonth,
          previous_reading: numberValue(form.previous_reading),
          current_reading: numberValue(form.current_reading),
          units_consumed: computed.units,
          rate_per_unit: numberValue(form.rate_per_unit),
          total_amount: computed.acAmount,
          remarks: form.notes.trim() || null,
        };
        const meterOperation = existingMeterBillId ? "update" : "insert";

        console.info(`[Billing] ac_bills ${meterOperation} payload`, meterPayload);

        const meterResult = existingMeterBillId
          ? await supabase
              .from("ac_bills")
              .update(meterPayload)
              .eq("id", existingMeterBillId)
              .select("id, bill_id")
              .single()
          : await supabase
              .from("ac_bills")
              .insert(meterPayload)
              .select("id, bill_id")
              .single();
        if (meterResult.error || !meterResult.data) {
          console.error(`[Billing] ac_bills ${meterOperation} failed`, {
            payload: meterPayload,
            error: meterResult.error
              ? {
                  code: meterResult.error.code,
                  message: meterResult.error.message,
                  details: meterResult.error.details,
                  hint: meterResult.error.hint,
                }
              : {
                  code: "NO_INSERTED_ROW",
                  message: "Supabase returned no AC meter row after saving.",
                  details: null,
                  hint: null,
                },
          });
          setError(
            editingId
              ? "The monthly bill was saved, but its meter-reading record could not be saved. Please edit the bill and try again."
              : "The bill was saved, but its AC meter details were not linked. Please review this bill.",
          );
          setSaving(false);
          await refresh();
          return;
        }

        if (text(meterResult.data.bill_id) !== savedBillId) {
          const { data: linkedMeterBill, error: linkError } = await supabase
            .from("ac_bills")
            .update({ bill_id: savedBillId, updated_at: new Date().toISOString() })
            .eq("id", meterResult.data.id)
            .select("id, bill_id")
            .single();

          if (linkError || text(linkedMeterBill?.bill_id) !== savedBillId) {
            setError("The bill was saved, but its AC meter details were not linked. Please review this bill.");
            setSaving(false);
            await refresh();
            return;
          }
        }

        const { data: verifiedMeterBill, error: meterVerificationError } =
          await supabase
            .from("ac_bills")
            .select(acBillColumns)
            .eq("id", meterResult.data.id)
            .maybeSingle();

        if (meterVerificationError || !verifiedMeterBill) {
          console.error("[Billing] ac_bills read-back failed", {
            inserted_id: meterResult.data.id,
            expected_bill_id: savedBillId,
            error: meterVerificationError
              ? {
                  code: meterVerificationError.code,
                  message: meterVerificationError.message,
                  details: meterVerificationError.details,
                  hint: meterVerificationError.hint,
                }
              : {
                  code: "INSERTED_ROW_NOT_FOUND",
                  message: "The inserted AC meter row was not found by its id.",
                  details: null,
                  hint: null,
                },
          });
          setError("The bill was saved, but its AC meter details were not linked. Please review this bill.");
          setSaving(false);
          await refresh();
          return;
        }

        const persistedMeterValuesMatch =
          text(verifiedMeterBill.bill_id) === savedBillId &&
          numberValue(verifiedMeterBill.previous_reading) ===
            numberValue(meterPayload.previous_reading) &&
          numberValue(verifiedMeterBill.current_reading) ===
            numberValue(meterPayload.current_reading) &&
          numberValue(verifiedMeterBill.units_consumed) ===
            numberValue(meterPayload.units_consumed) &&
          numberValue(verifiedMeterBill.rate_per_unit) ===
            numberValue(meterPayload.rate_per_unit) &&
          numberValue(verifiedMeterBill.total_amount) ===
            numberValue(meterPayload.total_amount) &&
          verifiedMeterBill.billing_month === acBillingMonth;

        if (!persistedMeterValuesMatch) {
          console.error("[Billing] ac_bills read-back did not match the insert payload", {
            payload: meterPayload,
            persisted: verifiedMeterBill,
          });
          setError("The bill was saved, but its AC meter details were not linked. Please review this bill.");
          setSaving(false);
          await refresh();
          return;
        }
      }
      const notificationResult = editingId
        ? null
        : await requestEventNotification("bill_generated", savedBillId, { channels: ["email"] });
      setMessage(
        editingId
          ? "Bill updated successfully."
          : `Bill generated successfully.${
              notificationResult
                ? notificationResult.delivered
                  ? " Bill email sent to resident."
                  : notificationWarning(notificationResult)
                : ""
            }`,
      );
      setEditingId(null);
      setEditingAcBillId(null);
      setEditingWithoutMeterRecord(false);
      setForm(emptyForm);
      setShowForm(false);
      await refresh();
    }

    setSaving(false);
  }

  async function sendBillEmail(bill: Bill) {
    if (sendingEmailBillId) return;
    setSendingEmailBillId(bill.id);
    setMessage("");
    setError("");
    try {
      const result = await requestEventNotification("bill_generated", bill.id, {
        channels: ["email"],
      });
      await loadBillEmailStatuses();
      if (result.delivered) {
        setMessage(`Bill ${bill.bill_number} email sent successfully via Resend.`);
      } else {
        setError(`Bill ${bill.bill_number} email could not be delivered. Check resident email and Resend sender domain.`);
      }
    } finally {
      setSendingEmailBillId(null);
    }
  }

  async function cancelBill(bill: Bill) {
    if (bill.bill_status === "Cancelled") return;
    if (!window.confirm(`Cancel bill ${bill.bill_number}? Its financial history will be preserved.`)) {
      return;
    }

    setMessage("");
    setError("");

    const verifiedPaid = await getVerifiedPaymentTotal(bill.id).catch(() => null);
    if (verifiedPaid === null || verifiedPaid > 0) {
      setError("Cancel or reconcile verified payments before cancelling their bill."); return;
    }
    const { error: cancelError } = await supabase
      .from("bills")
      .update({ bill_status: "Cancelled", updated_at: new Date().toISOString() })
      .eq("id", bill.id);

    if (cancelError) {
      setError(getSupabaseErrorMessage(cancelError, "The bill could not be cancelled."));
    } else {
      try { await refreshBillFinancials(bill.id); }
      catch { setError("Bill cancelled, but deposit status needs reconciliation. Refresh before proceeding."); await refresh(); return; }
      setMessage("Bill cancelled. Its payment and billing history has been preserved.");
      await refresh();
    }
  }

  async function deleteBill(bill: Bill) {
    const { data: currentBill, error: currentError } = await supabase.from("bills").select("bill_type").eq("id", bill.id).single();
    if (currentError || !currentBill || currentBill.bill_type === "Security Deposit") {
      setError("Security deposit history must be preserved. Use cancellation after reconciling payments."); return;
    }
    if (!window.confirm(`Permanently delete bill ${bill.bill_number}? This cannot be undone.`)) {
      return;
    }

    setMessage("");
    setError("");

    const { error: deleteError } = await supabase
      .from("bills")
      .delete()
      .eq("id", bill.id);

    if (deleteError) {
      setError(getSupabaseErrorMessage(deleteError, "The bill could not be deleted. It may have linked records."));
    } else {
      setMessage("Bill permanently deleted.");
      await refresh();
    }
  }

  function printBill(bill: Bill) {
    const resident = residents.find(
      (item) => text(item.id) === bill.resident_id
    );

    const printWindow = window.open(
      "",
      "_blank",
      "width=900,height=700"
    );

    if (!printWindow) return;

    printWindow.document.write(`
      <html>
        <head>
          <title>${bill.bill_number}</title>
          <style>
            body { font-family: Arial, sans-serif; padding: 32px; color: #0f172a; }
            h1 { margin-bottom: 6px; }
            .meta { color: #475569; margin-bottom: 24px; }
            table { width: 100%; border-collapse: collapse; margin-top: 20px; }
            th, td { border: 1px solid #cbd5e1; padding: 12px; text-align: left; }
            th { background: #f8fafc; }
            .totals { margin-top: 24px; margin-left: auto; width: 320px; }
            .row { display: flex; justify-content: space-between; padding: 8px 0; }
            .strong { font-weight: 700; }
          </style>
        </head>
        <body>
          <h1>University Girls Hostel</h1>
          <div class="meta">Monthly Bill</div>
          <p><strong>Bill Number:</strong> ${bill.bill_number}</p>
          <p><strong>Resident:</strong> ${residentName(resident)}</p>
          <p><strong>Month:</strong> ${monthLabel(bill.billing_month)}</p>
          <p><strong>Due Date:</strong> ${bill.due_date}</p>

          <table>
            <thead>
              <tr><th>Charge</th><th>Amount</th></tr>
            </thead>
            <tbody>
              <tr><td>Monthly Rent</td><td>${money(bill.rent_amount)}</td></tr>
              <tr><td>Electricity</td><td>${money(bill.electricity_amount)}</td></tr>
              <tr><td>AC Charges</td><td>${money(bill.ac_amount)}</td></tr>
              <tr><td>Other Charges</td><td>${money(bill.other_amount)}</td></tr>
              <tr><td>Discount</td><td>- ${money(bill.discount_amount)}</td></tr>
            </tbody>
          </table>

          <div class="totals">
            <div class="row strong"><span>Total</span><span>${money(bill.total_amount)}</span></div>
            <div class="row"><span>Paid</span><span>${money(bill.paid_amount)}</span></div>
            <div class="row strong"><span>Balance</span><span>${money(bill.balance_amount)}</span></div>
          </div>
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
        {profile?.status?.toLowerCase() === "active" && ["admin", "super admin"].includes(role.toLowerCase()) && typeFilter !== "Security Deposit" && <section className="rounded-xl border border-indigo-200 bg-white p-4">
          <h2 className="font-semibold">Missing Rent Bills</h2>
          <p className="text-sm text-slate-600">Generate an exact missing period, including initial rent for Pending admissions.</p>
          {admissions.filter(a => isCurrentRentAdmission(a, admissions) && missingRentMonths(a, bills).length > 0 && residents.some(r => r.id === a.resident_id && r.status !== "Archived")).map(a => <div key={text(a.id)} className="mt-3">
            <p className="text-sm font-medium">{text(residents.find(r => r.id === a.resident_id)?.full_name)} — Admission {text(a.admission_date)}</p>
            <GenerateMissingRentBill admissionId={text(a.id)} months={missingRentMonths(a, bills)} onSaved={async generatedId => { setSearch(generatedId); setStatusFilter("Pending Approval"); setMonthFilter("All"); await refresh(); }} />
          </div>)}
        </section>}
        <section className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">
              University Girls Hostel
            </p>

            <h1 className="mt-2 text-3xl font-bold text-slate-900">
              {typeFilter === "Security Deposit" ? "Security Deposits" : "Rent Bills"}
            </h1>

            <p className="mt-1 text-sm text-slate-500">
              {typeFilter === "Security Deposit"
                ? "Manage resident security deposits and record payments."
                : "Generate monthly bills and manage outstanding balances."}
            </p>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            {typeFilter !== "Security Deposit" && (
              <button
                type="button"
                onClick={() => void handleGenerateAll()}
                disabled={generating}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 px-5 py-3 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {generating ? (
                  <>
                    <Spinner />
                    Generating bills...
                  </>
                ) : (
                  <>Generate All Bills</>
                )}
              </button>
            )}

            <button
              type="button"
              onClick={openAddForm}
              className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700"
            >
              + {typeFilter === "Security Deposit" ? "Add Deposit" : "Add Bill"}
            </button>
          </div>
        </section>

        {toasts.length > 0 && (
          <div
            aria-live="polite"
            className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col gap-3 sm:inset-x-auto sm:right-6 sm:w-96"
          >
            {toasts.map((toast) => (
              <div
                key={toast.id}
                role="status"
                className={`pointer-events-auto flex items-start gap-3 rounded-2xl border p-4 shadow-lg backdrop-blur ${
                  toast.tone === "success"
                    ? "border-emerald-200 bg-emerald-50/95 text-emerald-800"
                    : toast.tone === "error"
                      ? "border-red-200 bg-red-50/95 text-red-800"
                      : "border-indigo-200 bg-indigo-50/95 text-indigo-800"
                }`}
              >
                <span aria-hidden className="mt-0.5 text-base leading-none">
                  {toast.tone === "success"
                    ? "\u2713"
                    : toast.tone === "error"
                      ? "\u26a0"
                      : "\u2139"}
                </span>

                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{toast.title}</p>
                  {toast.detail && (
                    <p className="mt-1 break-words text-xs opacity-90">
                      {toast.detail}
                    </p>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => dismissToast(toast.id)}
                  aria-label="Dismiss notification"
                  className="rounded-lg px-2 text-sm font-bold opacity-60 transition hover:opacity-100"
                >
                  {"\u00d7"}
                </button>
              </div>
            ))}
          </div>
        )}

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

        {verifyingReceipt && (
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-6 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-xl font-bold text-slate-900">
                  {verifyingReceipt.status === "Pending Verification" ? "Verify Receipt" : "View Receipt"}
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  {verifyingReceipt.status === "Pending Verification" 
                    ? "Review the uploaded receipt and approve or reject it." 
                    : "Review the verified receipt document."}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setVerifyingReceipt(null)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                Close
              </button>
            </div>

            <div className="flex flex-col gap-6 md:flex-row">
              <div className="flex-1 rounded-xl border border-slate-200 bg-slate-50 p-2">
                {String(verifyingReceipt.receipt_url).toLowerCase().includes(".pdf") ? (
                  <iframe
                    src={String(verifyingReceipt.receipt_url)}
                    className="h-[55vh] w-full rounded-lg sm:h-[600px]"
                  />
                ) : (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={String(verifyingReceipt.receipt_url)}
                    alt="Payment Receipt"
                    className="max-h-[600px] w-full rounded-lg object-contain"
                  />
                )}
              </div>
              
              {verifyingReceipt.status === "Pending Verification" && (
                <div className="flex flex-col gap-3 md:w-64">
                  <button
                    type="button"
                    onClick={() => void updateReceiptStatus(verifyingReceipt, "Verified")}
                    disabled={isVerifying}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isVerifying ? <Spinner /> : "Approve"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void updateReceiptStatus(verifyingReceipt, "Rejected")}
                    disabled={isVerifying}
                    className="flex w-full items-center justify-center gap-2 rounded-xl bg-red-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isVerifying ? <Spinner /> : "Reject"}
                  </button>
                </div>
              )}
            </div>
          </section>
        )}


        {recordingPaymentBill && (
          <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
            <div className="mb-6 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-xl font-bold text-slate-900">Record Payment</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Manually record a payment for bill {recordingPaymentBill.bill_number}.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRecordingPaymentBill(null)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                Close
              </button>
            </div>

            <form onSubmit={(e) => void handleRecordPayment(e)} className="grid gap-6 md:grid-cols-2">
              <Field label="Payment Date *">
                <input
                  required
                  type="date"
                  max={today}
                  value={paymentForm.payment_date}
                  onChange={(e) => setPaymentForm({ ...paymentForm, payment_date: e.target.value })}
                  className={inputClass}
                />
              </Field>

              <Field label="Amount *">
                <input
                  required
                  type="number"
                  min="0.01"
                  step="0.01"
                  max={recordingPaymentBill.balance_amount}
                  value={paymentForm.amount}
                  onChange={(e) => setPaymentForm({ ...paymentForm, amount: e.target.value })}
                  className={inputClass}
                  placeholder={`Max: ${recordingPaymentBill.balance_amount}`}
                />
              </Field>

              <Field label="Payment Method *">
                <select
                  required
                  value={paymentForm.payment_method}
                  onChange={(e) => setPaymentForm({ ...paymentForm, payment_method: e.target.value })}
                  className={inputClass}
                >
                  <option value="Bank Transfer">Bank Transfer</option>
                  <option value="Cash">Cash</option>
                  <option value="Credit Card">Credit Card</option>
                  <option value="Check">Check</option>
                  <option value="Other">Other</option>
                </select>
              </Field>

              <Field label="Reference Number">
                <input
                  type="text"
                  value={paymentForm.reference_number}
                  onChange={(e) => setPaymentForm({ ...paymentForm, reference_number: e.target.value })}
                  className={inputClass}
                  placeholder="e.g. Transaction ID"
                />
              </Field>

              <Field label="Notes" wide>
                <input
                  type="text"
                  value={paymentForm.notes}
                  onChange={(e) => setPaymentForm({ ...paymentForm, notes: e.target.value })}
                  className={inputClass}
                  placeholder="Optional notes"
                />
              </Field>

              <div className="flex flex-wrap items-center gap-3 md:col-span-2">
                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving ? (
                    <span className="flex items-center gap-2">
                      <Spinner /> Recording...
                    </span>
                  ) : (
                    "Record Payment"
                  )}
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setRecordingPaymentBill(null)}
                  className="rounded-xl bg-slate-100 px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-200"
                >
                  Cancel
                </button>
              </div>
            </form>
          </section>
        )}

        {showForm && (
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-6 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-xl font-bold text-slate-900">
                  {editingId 
                    ? (form.bill_type === "Security Deposit" ? "Edit Deposit" : "Edit Bill") 
                    : (form.bill_type === "Security Deposit" ? "Record Deposit" : "Generate Bill")}
                </h2>

                <p className="mt-1 text-sm text-slate-500">
                  {form.bill_type === "Security Deposit" 
                    ? "Create a manual record for a security deposit obligation." 
                    : "Add rent, electricity, AC and other monthly charges."}
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

            <form onSubmit={saveBill} className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <Field label="Admission">
                  <select
                    value={form.admission_id}
                    onChange={(event) =>
                      applyAdmission(event.target.value)
                    }
                    className={inputClass}
                  >
                    <option value="">Select admission</option>

                    {admissions
                      .filter(
                        (admission) =>
                          admission.status === "Active" ||
                          admission.status === "Pending" ||
                          text(admission.id) === form.admission_id,
                      )
                      .map((admission) => {
                      const resident = residents.find(
                        (item) =>
                          text(item.id) ===
                          firstText(admission, ["resident_id"])
                      );

                      return (
                        <option
                          key={text(admission.id)}
                          value={text(admission.id)}
                        >
                          {residentName(resident)} —{" "}
                          {firstText(admission, [
                            "admission_date",
                          ])}
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
                      updateField(
                        "resident_id",
                        event.target.value
                      )
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

                <Field label="Room *">
                  <select value={form.room_id} disabled className={inputClass}>
                    <option value="">Selected from current admission</option>
                    {rooms.map((room) => (
                      <option key={text(room.id)} value={text(room.id)}>
                        {firstText(room, ["room_number"]) || text(room.id)}
                      </option>
                    ))}
                  </select>
                </Field>

                {typeFilter !== "Security Deposit" && (
                  <Field label="Bill Type">
                    <select
                      required
                      value={form.bill_type || "Rent"}
                      onChange={(event) =>
                        updateField("bill_type", event.target.value)
                      }
                      className={inputClass}
                    >
                      <option value="Rent">Rent</option>
                      <option value="Security Deposit">Security Deposit</option>
                    </select>
                  </Field>
                )}

                {form.bill_type !== "Security Deposit" && (
                  <Field label="Billing Month (YYYY-MM)">
                    <input
                      required
                      value={form.billing_month}
                      onChange={(event) => {
                        const newMonth = event.target.value;
                        const residentId = form.resident_id;
                        const admissionId = form.admission_id;
                        const isElecEnabled = Boolean(
                          residentId && isResidentElectricityEnabled(meterConfig, residentId)
                        );
                        const recordedMeter = isElecEnabled
                          ? findRecordedMeterReading(admissionId, residentId, newMonth)
                          : null;

                        setForm((current) => ({
                          ...current,
                          billing_month: newMonth,
                          due_date: monthEndDate(newMonth),
                          previous_reading: recordedMeter
                            ? String(recordedMeter.previous_reading)
                            : previousReadingEdited
                            ? current.previous_reading
                            : isElecEnabled
                            ? latestPreviousReading(current.admission_id, newMonth, residentId)
                            : "",
                          current_reading: recordedMeter
                            ? String(recordedMeter.current_reading)
                            : isElecEnabled
                            ? current.current_reading
                            : "",
                          rate_per_unit: recordedMeter
                            ? String(recordedMeter.rate_per_unit)
                            : isElecEnabled
                            ? current.rate_per_unit || String(meterConfig?.default_unit_rate || DEFAULT_UNIT_RATE)
                            : "",
                          ac_amount: recordedMeter
                            ? String(recordedMeter.total_amount)
                            : isElecEnabled
                            ? current.ac_amount
                            : "0",
                          electricity_amount: isElecEnabled ? current.electricity_amount : "0",
                        }));
                      }}
                      className={inputClass}
                    />
                  </Field>
                )}

                {form.bill_type !== "Security Deposit" && (
                  <>
                    <Field label="Monthly Rent">
                      <input
                        type="number"
                        min="0"
                        value={form.rent_amount}
                        onChange={(event) =>
                          updateField(
                            "rent_amount",
                            event.target.value
                          )
                        }
                        className={inputClass}
                        placeholder="15000"
                      />
                    </Field>

                    <Field label="Electricity Charges">
                      <input
                        type="number"
                        min="0"
                        value={form.electricity_amount}
                        disabled={!isElectricityEnabled && Boolean(form.resident_id)}
                        onChange={(event) =>
                          updateField(
                            "electricity_amount",
                            event.target.value
                          )
                        }
                        className={inputClass}
                        placeholder={!isElectricityEnabled && Boolean(form.resident_id) ? "Not enabled (0)" : "1200"}
                      />
                    </Field>

                    <Field
                      label={
                        editingId && editingWithoutMeterRecord
                          ? "Manual AC Charge"
                          : "AC / Electricity Charges (Meter Based)"
                      }
                    >
                      <input
                        type="number"
                        min="0"
                        value={form.ac_amount}
                        disabled={!isElectricityEnabled && Boolean(form.resident_id)}
                        onChange={(event) =>
                          updateField(
                            "ac_amount",
                            event.target.value
                          )
                        }
                        className={inputClass}
                        placeholder={!isElectricityEnabled && Boolean(form.resident_id) ? "Not enabled (0)" : "800"}
                      />
                    </Field>

                    {form.resident_id && !isElectricityEnabled && (
                      <Field label="Electricity Status" wide>
                        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
                          ⚡ <strong>Electricity billing is not enabled</strong> for this student. Only selected students are charged electricity bills. (To enable this student, visit the{" "}
                          <Link href="/meter-reading" className="font-bold underline text-blue-600 dark:text-blue-400">
                            Meter Reading Module
                          </Link>).
                        </div>
                      </Field>
                    )}

                    {form.resident_id && isElectricityEnabled && (
                      <Field label="Electricity Meter Status" wide>
                        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300">
                          <span>
                            {findRecordedMeterReading(form.admission_id, form.resident_id, form.billing_month) ? (
                              <>✓ <strong>Meter reading auto-loaded</strong> from Meter Reading module for {form.billing_month} ({computed.units.toFixed(2)} units = {money(computed.acAmount)}).</>
                            ) : (
                              <>⚡ Electricity billing enabled for this student. Any reading entered below will be recorded.</>
                            )}
                          </span>
                          <Link href="/meter-reading" className="font-bold underline text-emerald-700 dark:text-emerald-400 whitespace-nowrap">
                            Meter Module →
                          </Link>
                        </div>
                      </Field>
                    )}

                    {editingId && editingWithoutMeterRecord && (
                      <Field label="AC Meter Details" wide>
                        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                          No meter-reading record is linked to this historical bill.
                        </div>
                      </Field>
                    )}

                    <Field label="Previous Meter Reading">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={form.previous_reading}
                        disabled={!isElectricityEnabled && Boolean(form.resident_id)}
                        onChange={(event) => {
                          setPreviousReadingEdited(true);
                          updateField("previous_reading", event.target.value);
                        }}
                        className={inputClass}
                        placeholder={!isElectricityEnabled && Boolean(form.resident_id) ? "Disabled" : "Previous reading"}
                      />
                    </Field>

                    <Field label="Current Meter Reading">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={form.current_reading}
                        disabled={!isElectricityEnabled && Boolean(form.resident_id)}
                        onChange={(event) => updateField("current_reading", event.target.value)}
                        className={inputClass}
                        placeholder={!isElectricityEnabled && Boolean(form.resident_id) ? "Disabled" : "Current reading"}
                      />
                    </Field>

                    <Field label="Rate per Unit">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={form.rate_per_unit}
                        disabled={!isElectricityEnabled && Boolean(form.resident_id)}
                        onChange={(event) => updateField("rate_per_unit", event.target.value)}
                        className={inputClass}
                        placeholder={!isElectricityEnabled && Boolean(form.resident_id) ? "Disabled" : "Rate per unit"}
                      />
                    </Field>

                    <Field label="Units / Calculated Meter Charge">
                      <input
                        readOnly
                        value={
                          !isElectricityEnabled && Boolean(form.resident_id)
                            ? "0.00 units — Rs 0 (Not Enabled)"
                            : `${computed.units.toFixed(2)} units — ${money(computed.acAmount)}`
                        }
                        className={inputClass}
                      />
                    </Field>
                  </>
                )}

                <Field label={form.bill_type === "Security Deposit" ? "Deposit Amount" : "Other Charges"}>
                  <input
                    type="number"
                    min="0"
                    value={form.other_amount}
                    onChange={(event) =>
                      updateField(
                        "other_amount",
                        event.target.value
                      )
                    }
                    className={inputClass}
                    placeholder="0"
                  />
                </Field>

                {form.bill_type !== "Security Deposit" && (
                  <Field label="Discount">
                    <input
                      type="number"
                      min="0"
                      value={form.discount_amount}
                      onChange={(event) =>
                        updateField(
                          "discount_amount",
                          event.target.value
                        )
                      }
                      className={inputClass}
                      placeholder="0"
                    />
                  </Field>
                )}

                <Field label="Verified Payments">
                  <input
                    type="number"
                    min="0"
                    value={form.paid_amount}
                    readOnly
                    className={inputClass}
                  />
                </Field>

                <Field label="Due Date *">
                  <input
                    required
                    type="date"
                    value={form.due_date}
                    onChange={(event) =>
                      updateField(
                        "due_date",
                        event.target.value
                      )
                    }
                    className={inputClass}
                  />
                </Field>

                <Field label="Bill Status (calculated)">
                  <select
                    value={deriveBillStatus(
                      computed.total,
                      computed.paid,
                      form.due_date,
                      form.bill_status,
                    )}
                    disabled
                    className={inputClass}
                  >
                    <option value="Pending">Pending</option>
                    <option value="Partially Paid">
                      Partially Paid
                    </option>
                    <option value="Paid">Paid</option>
                    <option value="Overdue">Overdue</option>
                    <option value="Cancelled">Cancelled</option>
                  </select>
                </Field>

                <Field label="Notes" wide>
                  <textarea
                    value={form.notes}
                    onChange={(event) =>
                      updateField("notes", event.target.value)
                    }
                    className={`${inputClass} min-h-24`}
                    placeholder="Bill notes"
                  />
                </Field>
              </div>

              <section className="grid gap-4 rounded-2xl border border-indigo-100 bg-indigo-50 p-4 sm:grid-cols-2 xl:grid-cols-4">
                <TotalCard
                  label="Subtotal"
                  value={money(computed.subtotal)}
                />
                <TotalCard
                  label="Final Total"
                  value={money(computed.total)}
                />
                <TotalCard
                  label="Paid"
                  value={money(computed.paid)}
                />
                <TotalCard
                  label="Balance"
                  value={money(computed.balance)}
                />
              </section>

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
                    ? "Update Bill"
                    : "Generate Bill"}
                </button>
              </div>
            </form>
          </section>
        )}

        <section className={`grid gap-4 sm:grid-cols-2 ${canViewRevenue ? "xl:grid-cols-6" : "xl:grid-cols-4"}`}>
          <StatCard
            label="Total Bills"
            value={String(summary.total)}
          />
          <StatCard
            label="Awaiting Approval"
            value={String(summary.awaitingApproval)}
          />
          <StatCard
            label="Pending Bills"
            value={String(summary.pending)}
          />
          <StatCard
            label="Overdue"
            value={String(summary.overdue)}
          />
          {canViewRevenue && (
            <>
              <StatCard
                label="Pending Balance"
                value={money(summary.pendingBalance)}
              />
              <StatCard
                label="Collected"
                value={money(summary.collected)}
              />
            </>
          )}
        </section>

        {pendingApprovalBills.length > 0 && (
          <section className="overflow-hidden rounded-3xl border border-violet-200 bg-white shadow-sm">
          <div className="flex flex-col gap-4 border-b border-violet-100 bg-violet-50/70 p-5 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-xl font-bold text-slate-900">
                Bills Awaiting Approval
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Residents cannot see these bills yet. Approving a bill releases
                it for payment and emails the resident a copy.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <span className="rounded-full bg-white px-3 py-1 text-xs font-bold text-violet-700 ring-1 ring-violet-200">
                {approvalSelection.length} of {pendingApprovalBills.length}{" "}
                selected
              </span>

              <button
                type="button"
                onClick={() => void handleApprove(approvalSelection)}
                disabled={
                  approvalSelection.length === 0 || approvingIds.length > 0
                }
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {approvingIds.length > 1 ? (
                  <>
                    <Spinner />
                    Approving {approvingIds.length}...
                  </>
                ) : (
                  <>
                    Bulk Approve
                    {approvalSelection.length > 0
                      ? ` (${approvalSelection.length})`
                      : ""}
                  </>
                )}
              </button>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-3 p-12 text-sm text-slate-500">
              <Spinner />
              Loading bills...
            </div>
          ) : pendingApprovalBills.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-12 text-center">
              <span
                aria-hidden
                className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-xl text-emerald-600"
              >
                {"\u2713"}
              </span>
              <p className="text-sm font-semibold text-slate-900">
                Nothing is waiting on you
              </p>
              <p className="max-w-md text-sm text-slate-500">
                Every generated bill has been approved and released. Use
                <span className="font-semibold"> Generate All Bills </span>
                to raise this month&apos;s rent for all active admissions.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-violet-100">
                <thead className="bg-white">
                  <tr>
                    <th className="px-5 py-3 text-left">
                      <label className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-500">
                        <input
                          type="checkbox"
                          checked={allPendingSelected}
                          onChange={toggleAllApprovalSelection}
                          className="h-4 w-4 rounded border-slate-300 text-violet-600"
                          aria-label="Select all bills awaiting approval"
                        />
                        All
                      </label>
                    </th>
                    {["Bill", "Resident", "Month", "Total", "Due Date", "Status", ""].map(
                      (heading, index) => (
                        <th
                          key={heading || `col-${index}`}
                          className="px-5 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500"
                        >
                          {heading}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>

                <tbody className="divide-y divide-violet-50 bg-white">
                  {pendingApprovalBills.map((bill) => {
                    const resident = residents.find(
                      (item) => text(item.id) === bill.resident_id,
                    );
                    const busy = approvingIds.includes(bill.id);
                    const residentEmail = text(resident?.email);

                    return (
                      <tr key={bill.id} className="hover:bg-violet-50/40">
                        <td className="px-5 py-4">
                          <input
                            type="checkbox"
                            checked={approvalSelection.includes(bill.id)}
                            onChange={() => toggleApprovalSelection(bill.id)}
                            className="h-4 w-4 rounded border-slate-300 text-violet-600"
                            aria-label={`Select bill ${bill.bill_number}`}
                          />
                        </td>

                        <td className="px-5 py-4 text-sm font-semibold text-slate-900">
                          {bill.bill_number}
                        </td>

                        <td className="px-5 py-4 text-sm text-slate-700">
                          <p>{residentName(resident)}</p>
                          <p className="text-xs text-slate-500">
                            {residentEmail || "No email on file"}
                          </p>
                        </td>

                        <td className="px-5 py-4 text-sm text-slate-700">
                          {monthLabel(bill.billing_month)}
                        </td>

                        <td className="px-5 py-4 text-sm font-semibold text-slate-900">
                          {money(bill.total_amount)}
                        </td>

                        <td className="px-5 py-4 text-sm text-slate-700">
                          {bill.due_date}
                        </td>

                        <td className="px-5 py-4">
                          <span
                            className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${statusClass(
                              bill.bill_status,
                            )}`}
                          >
                            {bill.bill_status}
                          </span>
                        </td>

                        <td className="px-5 py-4 text-right">
                          <button
                            type="button"
                            onClick={() => void handleApprove([bill.id])}
                            disabled={approvingIds.length > 0}
                            className="inline-flex items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {busy ? (
                              <>
                                <Spinner />
                                Approving
                              </>
                            ) : (
                              <>Approve</>
                            )}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
        )}

        <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
          <div className="grid gap-3 border-b border-slate-200 p-5 lg:grid-cols-[1fr_200px_180px_auto]">
            <input
              value={search}
              onChange={(event) =>
                setSearch(event.target.value)
              }
              className={inputClass}
              placeholder="Search bill number, resident or month"
            />

            <select
              value={statusFilter}
              onChange={(event) =>
                setStatusFilter(event.target.value)
              }
              className={inputClass}
            >
              <option value="All">All Statuses</option>
              {UNAPPROVED_BILL_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
              <option value="Pending">Pending</option>
              <option value="Partially Paid">
                Partially Paid
              </option>
              <option value="Paid">Paid</option>
              <option value="Overdue">Overdue</option>
              <option value="Pending Approval">Pending Approval</option>
              <option value="Cancelled">Cancelled</option>
            </select>


            <select
              value={monthFilter}
              onChange={(event) => setMonthFilter(event.target.value)}
              className={inputClass}
            >
              <option value="All">All Months</option>
              {availableMonths.map((month) => (
                <option key={month} value={month}>
                  {monthLabel(month)}
                </option>
              ))}
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
                    "Bill",
                    "Resident",
                    "Month",
                    "Charges",
                    "Total",
                    "Balance",
                    "Due Date",
                    "Status",
                    "Email",
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
                    <td colSpan={10} className="px-5 py-12">
                      <div className="flex items-center justify-center gap-3 text-sm text-slate-500">
                        <Spinner />
                        Loading bills...
                      </div>
                    </td>
                  </tr>
                ) : filteredBills.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-5 py-16">
                      <div className="flex flex-col items-center gap-2 text-center">
                        <span
                          aria-hidden
                          className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-xl text-slate-400"
                        >
                          {"\u25a4"}
                        </span>
                        <p className="text-sm font-semibold text-slate-900">
                          {bills.length === 0
                            ? "No bills have been generated yet"
                            : "No bills match these filters"}
                        </p>
                        <p className="max-w-md text-sm text-slate-500">
                          {bills.length === 0
                            ? "Use Generate All Bills to raise this month\u2019s rent for every active admission, or add a single bill manually."
                            : "Try a different status, month or search term."}
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredBills.map((bill) => {
                    const resident = residents.find(
                      (item) =>
                        text(item.id) === bill.resident_id
                    );
                    const receipt = receipts.find(
                      (r) => text(r.bill_id) === bill.id
                    );
                    const isEmailSent = billEmailStatus[bill.id] === "sent";

                    return (
                      <tr
                        key={bill.id}
                        className="hover:bg-slate-50/70"
                      >
                        <td className="px-5 py-4">
                          <p className="font-semibold text-slate-900">
                            {bill.bill_number}
                          </p>
                        </td>

                        <td className="px-5 py-4 text-sm text-slate-700">
                          {residentName(resident)}
                        </td>

                        <td className="px-5 py-4 text-sm text-slate-700">
                          {bill.bill_type === "Security Deposit" ? "N/A" : monthLabel(bill.billing_month)}
                        </td>

                        <td className="px-5 py-4 text-xs text-slate-600">
                          {bill.bill_type === "Security Deposit" ? (
                            <p>Deposit: {money(bill.other_amount)}</p>
                          ) : (
                            <>
                              <p>Rent: {money(bill.rent_amount)}</p>
                              <p>
                                Electricity:{" "}
                                {money(bill.electricity_amount)}
                              </p>
                              <p>AC: {money(bill.ac_amount)}</p>
                              <p>Other: {money(bill.other_amount)}</p>
                            </>
                          )}
                        </td>

                        <td className="px-5 py-4 text-sm font-semibold text-slate-900">
                          {money(bill.total_amount)}
                        </td>

                        <td className="px-5 py-4 text-sm font-semibold text-red-700">
                          {money(bill.balance_amount)}
                        </td>

                        <td className="px-5 py-4 text-sm text-slate-700">
                          {bill.due_date}
                        </td>

                        <td className="px-5 py-4">
                          <span
                            className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${statusClass(
                              bill.bill_status
                            )}`}
                          >
                            {bill.bill_status}
                          </span>
                        </td>

                        <td className="px-5 py-4">
                          <span
                            className={`inline-flex whitespace-nowrap rounded-full px-3 py-1 text-xs font-bold ${
                              isEmailSent
                                ? "bg-emerald-100 text-emerald-700"
                                : "bg-amber-100 text-amber-800"
                            }`}
                          >
                            {isEmailSent ? "Email Sent" : "Not Sent"}
                          </span>
                        </td>

                        <td className="px-5 py-4">
                          <div className="flex flex-wrap gap-2">
                            {bill.bill_type === "Rent" && Number(bill.balance_amount) > 0 && bill.bill_status !== "Cancelled" && <BillPaymentActions billId={bill.id} month={bill.billing_month} />}
                            {!isEmailSent && bill.bill_status !== "Cancelled" && (
                              <button
                                type="button"
                                onClick={() => void sendBillEmail(bill)}
                                disabled={sendingEmailBillId === bill.id}
                                className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 transition hover:bg-blue-100 disabled:opacity-50"
                              >
                                {sendingEmailBillId === bill.id ? "Sending..." : "Send Email"}
                              </button>
                            )}
                            {receipt && receipt.status === "Pending Verification" && (
                              <button
                                type="button"
                                onClick={() => setVerifyingReceipt(receipt)}
                                className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-700"
                              >
                                Verify Receipt
                              </button>
                            )}

                            {receipt && receipt.status === "Verified" && (
                              <button
                                type="button"
                                onClick={() => setVerifyingReceipt(receipt)}
                                className="rounded-lg border border-emerald-200 px-3 py-2 text-xs font-semibold text-emerald-700"
                              >
                                View Receipt
                              </button>
                            )}

                            {isUnapprovedBill(bill.bill_status) && (
                              <button
                                type="button"
                                onClick={() => void handleApprove([bill.id])}
                                disabled={approvingIds.length > 0}
                                className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {approvingIds.includes(bill.id) ? (
                                  <>
                                    <Spinner />
                                    Approving
                                  </>
                                ) : (
                                  <>Approve</>
                                )}
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() => printBill(bill)}
                              className="rounded-lg border border-emerald-200 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-50"
                            >
                              Print
                            </button>

                            <button
                              type="button"
                              onClick={() => printBill(bill)}
                              className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-100"
                            >
                              Download Voucher
                            </button>

                            {Number(bill.balance_amount) > 0 && bill.bill_status !== "Cancelled" && (
                              <button
                                type="button"
                                onClick={() => openPaymentForm(bill)}
                                className="rounded-lg bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-100"
                              >
                                + Payment
                              </button>
                            )}

                            <button
                              type="button"
                              onClick={() => void openEditForm(bill)}
                              className="rounded-lg border border-indigo-200 px-3 py-2 text-xs font-semibold text-indigo-700"
                            >
                              Edit
                            </button>

                            <button
                              type="button"
                              onClick={() => void cancelBill(bill)}
                              disabled={bill.bill_status === "Cancelled"}
                              className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700"
                            >
                              {bill.bill_status === "Cancelled" ? "Cancelled" : "Cancel"}
                            </button>

                            <button
                              type="button"
                              onClick={() => void deleteBill(bill)}
                              className="rounded-lg border border-red-600 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 transition hover:bg-red-100"
                            >
                              Delete
                            </button>
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

        <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 p-5">
            <h2 className="text-xl font-bold text-slate-900">Resident Financial Ledger</h2>
            <p className="mt-1 text-sm text-slate-500">
              Bills and complete payment history, with only verified payments applied to balances.
            </p>
            <select
              value={ledgerResidentId}
              onChange={(event) => setLedgerResidentId(event.target.value)}
              className={`${inputClass} mt-4 max-w-md`}
            >
              <option value="">Select resident</option>
              {residents.map((resident) => (
                <option key={text(resident.id)} value={text(resident.id)}>
                  {residentName(resident)}
                  {resident.status === "Archived" ? " (Archived)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  {["Month / Due", "Rent", "AC", "Total", "Verified", "Outstanding", "Status", "Payment History"].map((heading) => (
                    <th key={heading} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {!ledgerResidentId || ledgerBills.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-5 py-10 text-center text-sm text-slate-500">
                      {ledgerResidentId ? "No bills found for this resident." : "Select a resident to view the ledger."}
                    </td>
                  </tr>
                ) : (
                  ledgerBills.map((bill) => {
                    const billPayments = payments.filter(
                      (payment) => text(payment.bill_id) === bill.id,
                    );
                    return (
                      <tr key={bill.id} className="align-top">
                        <td className="px-4 py-4 text-sm text-slate-700">
                          <p className="font-semibold text-slate-900">{monthLabel(bill.billing_month)}</p>
                          <p className="mt-1 text-xs">Due {bill.due_date}</p>
                        </td>
                        <td className="px-4 py-4 text-sm">{money(bill.rent_amount)}</td>
                        <td className="px-4 py-4 text-sm">{money(bill.ac_amount)}</td>
                        <td className="px-4 py-4 text-sm font-semibold">{money(bill.total_amount)}</td>
                        <td className="px-4 py-4 text-sm text-emerald-700">{money(bill.paid_amount)}</td>
                        <td className="px-4 py-4 text-sm font-semibold text-red-700">{money(bill.balance_amount)}</td>
                        <td className="px-4 py-4 text-sm">{bill.bill_status}</td>
                        <td className="px-4 py-4 text-xs text-slate-600">
                          {billPayments.length === 0
                            ? "No payments"
                            : billPayments.map((payment) => (
                                <p key={text(payment.id)} className="mb-1">
                                  {firstText(payment, ["payment_date"])} · {money(payment.amount)} · {firstText(payment, ["payment_status"])}
                                </p>
                              ))}
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

function Spinner() {
  return (
    <span
      aria-hidden
      className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
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
      <p className="text-sm font-medium text-slate-500">
        {label}
      </p>

      <p className="mt-2 text-2xl font-bold text-slate-900">
        {value}
      </p>
    </article>
  );
}

function TotalCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <article>
      <p className="text-xs font-bold uppercase tracking-wider text-indigo-600">
        {label}
      </p>

      <p className="mt-2 text-lg font-bold text-slate-900">
        {value}
      </p>
    </article>
  );
}
