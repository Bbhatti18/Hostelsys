"use client";

import { useMemo, useState, useEffect } from "react";
import Link from "next/link";
import {
  buildResidentFinancialSummary,
  type FinancialRow,
} from "@/lib/residentFinancialSummary";
import { rentPeriodLabel } from "@/lib/paymentReceiptPurpose";

function money(value: number) {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(value || 0);
}

function formatDateLabel(dateStr: string | null) {
  if (!dateStr) return "No deadline set";
  const parsed = new Date(`${dateStr}T00:00:00`);
  return Number.isNaN(parsed.getTime())
    ? dateStr
    : parsed.toLocaleDateString("en-PK", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
}

function getDaysDiff(dueDateStr: string | null, today: string) {
  if (!dueDateStr) return null;
  const due = new Date(`${dueDateStr.slice(0, 10)}T00:00:00`);
  const cur = new Date(`${today}T00:00:00`);
  if (Number.isNaN(due.getTime()) || Number.isNaN(cur.getTime())) return null;
  const diffTime = due.getTime() - cur.getTime();
  return Math.round(diffTime / (1000 * 60 * 60 * 24));
}

export default function ResidentDuesPopup({
  residentId,
  residentName = "Resident",
  roomName,
  bedName,
  admission,
  room,
  bed,
  bills,
  payments,
}: {
  residentId: string;
  residentName?: string;
  roomName?: string;
  bedName?: string;
  admission: FinancialRow | null;
  room: FinancialRow | null;
  bed: FinancialRow | null;
  bills: FinancialRow[];
  payments: FinancialRow[];
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  const todayStr = useMemo(() => {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Karachi",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }, []);

  const financial = useMemo(
    () => buildResidentFinancialSummary({ admission, room, bed, bills, payments }),
    [admission, room, bed, bills, payments]
  );

  const totalOutstanding = financial.totalOutstanding;
  const hasDues = totalOutstanding > 0;

  // Earliest deadline calculation & urgency level
  const paymentDeadline = financial.paymentDeadline;
  const daysDiff = getDaysDiff(paymentDeadline, todayStr);

  const isOverdue =
    financial.accountStatus === "Overdue" ||
    (daysDiff !== null && daysDiff < 0);
  const isDueToday = daysDiff === 0;
  const isUpcoming = !isOverdue && !isDueToday && hasDues;

  const sessionKey = `stayhub:dues-popup:${residentId}:${totalOutstanding}:${paymentDeadline || "none"}`;

  useEffect(() => {
    if (!hasDues) {
      setIsOpen(false);
      return;
    }
    const alreadySeen = window.sessionStorage.getItem(sessionKey);
    if (alreadySeen === "acknowledged") {
      setAcknowledged(true);
      setIsOpen(false);
    } else {
      setIsOpen(true);
    }
  }, [hasDues, sessionKey]);

  function handleDismiss() {
    window.sessionStorage.setItem(sessionKey, "acknowledged");
    setAcknowledged(true);
    setIsOpen(false);
  }

  function handleOpen() {
    setIsOpen(true);
  }

  if (!hasDues) return null;

  return (
    <>
      {/* Sticky Top Banner if modal was closed */}
      {!isOpen && acknowledged && (
        <div
          role="status"
          className={`mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4 shadow-xs transition ${
            isOverdue
              ? "border-red-300 bg-red-50 text-red-900"
              : isDueToday
                ? "border-amber-300 bg-amber-50 text-amber-900"
                : "border-blue-300 bg-blue-50 text-blue-900"
          }`}
        >
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white shadow-xs text-xl">
              {isOverdue ? "⚠️" : isDueToday ? "⏰" : "📅"}
            </span>
            <div>
              <p className="font-bold text-sm sm:text-base">
                {isOverdue
                  ? "Overdue Payment Notice"
                  : isDueToday
                    ? "Payment Due Today"
                    : "Upcoming Payment Reminder"}
                : <span className="ml-1 text-base sm:text-lg font-black">{money(totalOutstanding)}</span>
              </p>
              <p className="text-xs opacity-90">
                Deadline: {formatDateLabel(paymentDeadline)}
                {daysDiff !== null && (
                  <span className="ml-1 font-semibold">
                    ({daysDiff < 0
                      ? `${Math.abs(daysDiff)} day${Math.abs(daysDiff) > 1 ? "s" : ""} overdue`
                      : daysDiff === 0
                        ? "Due today"
                        : `Due in ${daysDiff} day${daysDiff > 1 ? "s" : ""}`})
                  </span>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleOpen}
              className="rounded-xl border border-current px-3 py-1.5 text-xs font-bold transition hover:bg-white/60"
            >
              View Breakdown
            </button>
            <Link
              href="/resident-portal/payments"
              className="rounded-xl bg-indigo-600 px-3.5 py-1.5 text-xs font-bold text-white shadow-xs transition hover:bg-indigo-700"
            >
              Pay Now
            </Link>
          </div>
        </div>
      )}

      {/* Main Dues Popup Modal */}
      {isOpen && (
        <div
          role="presentation"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-xs animate-in fade-in duration-200"
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="dues-popup-title"
            className="w-full max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl sm:p-8 dark:border-slate-800 dark:bg-slate-900"
          >
            {/* Header Badge */}
            <div className="flex items-center justify-between gap-3">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-extrabold uppercase tracking-wide ${
                  isOverdue
                    ? "bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300"
                    : isDueToday
                      ? "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
                      : "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300"
                }`}
              >
                <span className="h-2 w-2 rounded-full bg-current animate-pulse" />
                {isOverdue ? "Payment Overdue" : isDueToday ? "Due Today" : "Upcoming Due"}
              </span>

              <button
                type="button"
                onClick={handleDismiss}
                className="rounded-full p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                aria-label="Close dialog"
              >
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Title & Greeting */}
            <div className="mt-4">
              <h2 id="dues-popup-title" className="text-2xl font-black text-slate-900 dark:text-white sm:text-3xl">
                {isOverdue
                  ? "Outstanding Dues Notice"
                  : isDueToday
                    ? "Hostel Dues Payable Today"
                    : "Hostel Dues Reminder"}
              </h2>
              <p className="mt-1.5 text-sm text-slate-600 dark:text-slate-300">
                Hello <strong className="text-slate-900 dark:text-white">{residentName}</strong>
                {roomName ? ` (Room ${roomName}${bedName ? `, ${bedName}` : ""})` : ""}, you have pending dues on your account.
              </p>
            </div>

            {/* Hero Amount Box */}
            <div
              className={`mt-6 rounded-2xl border p-5 ${
                isOverdue
                  ? "border-red-200 bg-red-50/70 dark:border-red-900/60 dark:bg-red-950/40"
                  : isDueToday
                    ? "border-amber-200 bg-amber-50/70 dark:border-amber-900/60 dark:bg-amber-950/40"
                    : "border-indigo-100 bg-indigo-50/70 dark:border-indigo-900/60 dark:bg-indigo-950/40"
              }`}
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
                <div>
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    Total Amount Due
                  </span>
                  <div className={`mt-1 text-3xl font-black sm:text-4xl ${
                    isOverdue
                      ? "text-red-700 dark:text-red-400"
                      : isDueToday
                        ? "text-amber-700 dark:text-amber-400"
                        : "text-indigo-700 dark:text-indigo-400"
                  }`}>
                    {money(totalOutstanding)}
                  </div>
                </div>

                <div className="text-left sm:text-right">
                  <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                    Due Date / Deadline
                  </span>
                  <p className="text-sm font-bold text-slate-900 dark:text-white sm:text-base">
                    {formatDateLabel(paymentDeadline)}
                  </p>
                  {daysDiff !== null && (
                    <span className={`inline-block text-xs font-extrabold ${
                      daysDiff < 0
                        ? "text-red-600 dark:text-red-400"
                        : daysDiff === 0
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-blue-600 dark:text-blue-400"
                    }`}>
                      {daysDiff < 0
                        ? `(${Math.abs(daysDiff)} day${Math.abs(daysDiff) > 1 ? "s" : ""} overdue)`
                        : daysDiff === 0
                          ? "(Due today)"
                          : `(Due in ${daysDiff} day${daysDiff > 1 ? "s" : ""})`}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Pending Dues Breakdown */}
            <div className="mt-5">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Pending Charges Breakdown
              </h3>
              <div className="mt-2.5 max-h-48 space-y-2 overflow-y-auto pr-1 text-sm">
                {/* Monthly Rent */}
                {financial.monthlyRentDue > 0 && (
                  <div className="flex items-center justify-between rounded-xl bg-slate-50 p-3 dark:bg-slate-800/80">
                    <div>
                      <p className="font-semibold text-slate-900 dark:text-white">
                        🏠 Monthly Rent
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {financial.rentDueDate ? `Due by ${formatDateLabel(financial.rentDueDate)}` : "Current cycle"}
                      </p>
                    </div>
                    <span className="font-black text-slate-900 dark:text-white">
                      {money(financial.monthlyRentDue)}
                    </span>
                  </div>
                )}

                {/* Security Deposit */}
                {financial.depositBalance > 0 && (
                  <div className="flex items-center justify-between rounded-xl bg-slate-50 p-3 dark:bg-slate-800/80">
                    <div>
                      <p className="font-semibold text-slate-900 dark:text-white">
                        🛡️ Security Deposit
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Admission Deposit ({financial.depositStatus})
                      </p>
                    </div>
                    <span className="font-black text-slate-900 dark:text-white">
                      {money(financial.depositBalance)}
                    </span>
                  </div>
                )}

                {/* Utility Line Items */}
                {financial.utilityItems
                  .filter((item) => item.amount > 0)
                  .map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between rounded-xl bg-slate-50 p-3 dark:bg-slate-800/80"
                    >
                      <div>
                        <p className="font-semibold text-slate-900 dark:text-white">
                          ⚡ {item.title}
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          Due {formatDateLabel(item.dueDate)}
                        </p>
                      </div>
                      <span className="font-black text-slate-900 dark:text-white">
                        {money(item.amount)}
                      </span>
                    </div>
                  ))}

                {/* Other Line Items */}
                {financial.otherItems
                  .filter((item) => item.amount > 0)
                  .map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between rounded-xl bg-slate-50 p-3 dark:bg-slate-800/80"
                    >
                      <div>
                        <p className="font-semibold text-slate-900 dark:text-white">
                          📋 {item.title}
                        </p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          Due {formatDateLabel(item.dueDate)}
                        </p>
                      </div>
                      <span className="font-black text-slate-900 dark:text-white">
                        {money(item.amount)}
                      </span>
                    </div>
                  ))}
              </div>
            </div>

            {/* Action Buttons */}
            <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-end">
              <button
                type="button"
                onClick={handleDismiss}
                className="rounded-xl border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800 sm:w-auto"
              >
                Remind Me Later
              </button>

              <Link
                href="/resident-portal/bills"
                onClick={handleDismiss}
                className="rounded-xl border border-indigo-200 bg-indigo-50 px-5 py-3 text-center text-sm font-bold text-indigo-700 transition hover:bg-indigo-100 dark:border-indigo-900 dark:bg-indigo-950/60 dark:text-indigo-300 sm:w-auto"
              >
                View Bills
              </Link>

              <Link
                href="/resident-portal/payments"
                onClick={handleDismiss}
                className="rounded-xl bg-indigo-600 px-6 py-3 text-center text-sm font-bold text-white shadow-md shadow-indigo-600/20 transition hover:bg-indigo-700 sm:w-auto"
              >
                Pay Now / Submit Receipt →
              </Link>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
