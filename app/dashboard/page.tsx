"use client";

import PaymentFollowups from "@/components/payments/PaymentFollowups";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ProfileDropdown from "@/components/layout/ProfileDropdown";
import Sidebar from "@/components/layout/Sidebar";
import DashboardCharts from "@/components/dashboard/DashboardCharts";
import DashboardStats from "@/components/dashboard/DashboardStats";
import { buildDashboardSummary, type DashboardData, type DashboardTask } from "@/lib/dashboardData";
import { supabase } from "@/lib/supabase";
import { getSupabaseErrorMessage } from "@/lib/supabaseErrors";
import { usePermissions } from "@/lib/usePermissions";
import { readDashboardRows } from "@/lib/dashboardRead";
import { normalizeBedLabel } from "@/lib/bedLabels";

const emptyData: DashboardData = {
  residents: [], admissions: [], contracts: [], bills: [], payments: [],
  lateFees: [], lateFeeAllocations: [],
  receipts: [], rooms: [], beds: [], maintenance: [], inspections: [], notices: [],
};

const quickActions = [
  {
    icon: (
      <svg className="h-6 w-6 text-blue-600 dark:text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <line x1="19" y1="8" x2="19" y2="14" />
        <line x1="22" y1="11" x2="16" y2="11" />
      </svg>
    ),
    fallbackIcon: "👤",
    title: "Add Resident",
    description: "Register a new resident.",
    href: "/residents",
    accentColor: "group-hover:border-blue-400/60 dark:group-hover:border-blue-500/40",
    badge: "Registration",
  },
  {
    icon: (
      <svg className="h-6 w-6 text-indigo-600 dark:text-indigo-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M2 4v16" />
        <path d="M2 8h18a2 2 0 0 1 2 2v10" />
        <path d="M2 17h20" />
        <path d="M6 8v9" />
      </svg>
    ),
    fallbackIcon: "🛏️",
    title: "Assign Room",
    description: "Allocate room or bed.",
    href: "/admissions",
    accentColor: "group-hover:border-indigo-400/60 dark:group-hover:border-indigo-500/40",
    badge: "Allocation",
  },
  {
    icon: (
      <svg className="h-6 w-6 text-emerald-600 dark:text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect width="20" height="14" x="2" y="5" rx="2" />
        <line x1="2" x2="22" y1="10" y2="10" />
        <circle cx="7" cy="15" r="1" />
        <circle cx="11" cy="15" r="1" />
      </svg>
    ),
    fallbackIcon: "💳",
    title: "Generate Billing",
    description: "Generate monthly rent and electricity bills.",
    href: "/billing",
    accentColor: "group-hover:border-emerald-400/60 dark:group-hover:border-emerald-500/40",
    badge: "Invoicing",
  },
  {
    icon: (
      <svg className="h-6 w-6 text-violet-600 dark:text-violet-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
    ),
    fallbackIcon: "📄",
    title: "Contracts",
    description: "Manage resident contracts.",
    href: "/contracts",
    accentColor: "group-hover:border-violet-400/60 dark:group-hover:border-violet-500/40",
    badge: "Agreements",
  },
];

const taskTone: Record<DashboardTask["tone"], string> = {
  red: "border-red-200 bg-red-50/80 text-red-900 hover:border-red-300 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200",
  amber: "border-amber-200 bg-amber-50/80 text-amber-900 hover:border-amber-300 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200",
  blue: "border-blue-200 bg-blue-50/80 text-blue-900 hover:border-blue-300 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-200",
  slate: "border-slate-200 bg-white text-slate-800 hover:border-slate-300 dark:border-slate-700 dark:bg-slate-800/80 dark:text-slate-100",
};

const activityTone = {
  blue: "border-blue-600 bg-blue-50/20",
  green: "border-emerald-600 bg-emerald-50/20",
  purple: "border-purple-600 bg-purple-50/20",
  orange: "border-orange-500 bg-orange-50/20",
  slate: "border-slate-500 bg-slate-50/20",
};

function formatActivityDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" });
}

export default function DashboardPage() {
  const { hasPermission, loading: permsLoading, isSuperAdmin } = usePermissions();
  const [data, setData] = useState<DashboardData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAllActivity, setShowAllActivity] = useState(false);
  const [showRentDueToday, setShowRentDueToday] = useState(false);
  const [snapshotTime, setSnapshotTime] = useState(() => new Date());
  const requestInFlight = useRef(false);

  const canAccessDashboard = permsLoading || isSuperAdmin || hasPermission("dashboard");

  const loadDashboardData = useCallback(async () => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setLoading(true);
    setError("");
    try {
      const results = await Promise.all([
        supabase.from("residents").select("id,full_name,resident_code,status,created_at,updated_at").neq("status", "Archived").order("created_at", { ascending: false }),
        supabase.from("admissions").select("id,admission_number,resident_id,room_id,bed_id,allocation_mode,admission_date,monthly_rent,security_deposit,status,deposit_status,expected_leaving_date,created_at,updated_at").neq("status", "Archived").order("created_at", { ascending: false }),
        supabase.from("contracts").select("id,contract_number,resident_id,admission_id,status,resident_signature_url,resident_signature_status,signed_by_resident,signed_at,contract_content,created_at,updated_at").neq("status", "Terminated").order("created_at", { ascending: false }),
        supabase.from("bills").select("id,bill_number,resident_id,admission_id,billing_month,bill_type,rent_amount,electricity_amount,ac_amount,other_amount,discount_amount,total_amount,due_date,bill_status,created_at,updated_at").order("created_at", { ascending: false }),
        supabase.from("payments").select("id,payment_number,bill_id,resident_id,amount,payment_status,verified_at,created_at,updated_at,payment_allocations(payment_id,bill_id,amount)").order("created_at", { ascending: false }),
        supabase.from("payment_receipts").select("id,resident_id,bill_id,payment_id,status,verified_at,created_at,updated_at").order("created_at", { ascending: false }),
        supabase.from("maintenance_requests").select("id,request_number,resident_id,title,priority,status,completed_at,created_at,updated_at").order("created_at", { ascending: false }),
        supabase.from("room_inspections").select("id,inspection_number,resident_id,inspection_type,status,inspection_date,created_at,updated_at").order("created_at", { ascending: false }),
        supabase.from("notices").select("id::text,notice_number,title,status,publish_date,expiry_date,created_at,updated_at").order("created_at", { ascending: false }),
        supabase.from("rooms").select("id,room_number,status"),
        supabase.from("beds").select("id,room_id,bed_number,status"),
        supabase.from("late_fees").select("id,bill_id,payable_amount,status"),
        supabase.from("late_fee_payment_allocations").select("payment_id,amount,applied_at,reversed_at"),
      ].map(query => readDashboardRows<Record<string, unknown>>(query.order("id"))));

      const failed = results.find((result) => result.error)?.error;
      if (failed) {
        setError(getSupabaseErrorMessage(failed, "Dashboard data could not be loaded. Please refresh and try again."));
      } else {
        setData({
          residents: results[0].data ?? [], admissions: results[1].data ?? [],
          contracts: results[2].data ?? [], bills: results[3].data ?? [],
          payments: results[4].data ?? [], receipts: results[5].data ?? [],
          maintenance: results[6].data ?? [], inspections: results[7].data ?? [],
          notices: results[8].data ?? [], rooms: results[9].data ?? [],
          beds: results[10].data ?? [],
          lateFees: results[11].data ?? [],
          lateFeeAllocations: results[12].data ?? [],
        });
      }
      setSnapshotTime(new Date());
    } catch {
      setError("Dashboard data could not be loaded. Please refresh and try again.");
    } finally {
      requestInFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (permsLoading || !canAccessDashboard) return;
    const timeout = window.setTimeout(() => void loadDashboardData(), 0);
    const refreshVisible = () => { if (document.visibilityState === "visible") void loadDashboardData(); };
    const interval = window.setInterval(refreshVisible, 60_000);
    window.addEventListener("focus", refreshVisible);
    return () => {
      window.clearTimeout(timeout);
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshVisible);
    };
  }, [loadDashboardData, canAccessDashboard, permsLoading]);

  const summary = useMemo(() => buildDashboardSummary(data, snapshotTime), [data, snapshotTime]);
  const visibleActivities = showAllActivity
    ? summary.activities
    : summary.activities.slice(0, 3);

  const formattedDate = useMemo(() => {
    return new Intl.DateTimeFormat("en-PK", {
      weekday: "long",
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(snapshotTime);
  }, [snapshotTime]);

  return (
    <main className="min-h-screen bg-slate-50 text-slate-950 dark:bg-slate-950 dark:text-slate-100">
      <div className="flex min-h-screen flex-col lg:flex-row">
        <Sidebar />
        <section className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">
          {/* Executive Header */}
          <header className="mb-6 flex flex-col gap-4 rounded-3xl border border-slate-200/90 bg-white p-5 shadow-xs sm:flex-row sm:items-center sm:justify-between sm:p-6 dark:border-slate-800 dark:bg-slate-900">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 border border-emerald-200/80 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 dark:bg-emerald-950/60 dark:border-emerald-800/80 dark:text-emerald-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  Live Sync Active
                </span>
                <span className="text-xs text-slate-400">•</span>
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  {formattedDate}
                </span>
              </div>
              <h1 className="mt-2 text-2xl font-black tracking-tight text-slate-950 sm:text-3xl dark:text-white">
                Welcome Back 👋
              </h1>
              <p className="mt-1 text-xs text-slate-500 sm:text-sm dark:text-slate-400">
                University Girls Hostel Management • Operations Control
              </p>
            </div>

            <div className="flex items-center gap-3 self-start sm:self-auto">
              <button
                type="button"
                onClick={() => void loadDashboardData()}
                disabled={loading}
                title="Refresh dashboard data"
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 shadow-xs transition hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                <svg
                  className={`h-4 w-4 ${loading ? "animate-spin text-blue-600" : "text-slate-500"}`}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                  <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                  <path d="M16 16h5v5" />
                </svg>
                <span>{loading ? "Refreshing..." : "Refresh"}</span>
              </button>

              <div className="hidden lg:block">
                <ProfileDropdown />
              </div>
            </div>
          </header>

          {error && (
            <div className="mb-6 flex items-center justify-between rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700 shadow-xs dark:border-red-900 dark:bg-red-950/60 dark:text-red-200">
              <div className="flex items-center gap-2.5">
                <span className="text-red-500">⚠</span>
                <span>{error}</span>
              </div>
              <button
                type="button"
                onClick={() => void loadDashboardData()}
                className="text-xs font-bold underline hover:no-underline"
              >
                Retry
              </button>
            </div>
          )}

          {!canAccessDashboard ? (
            <div className="rounded-3xl border border-slate-200 bg-white p-6 text-center shadow-sm sm:p-10 dark:border-slate-800 dark:bg-slate-900">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-100 text-amber-600 dark:bg-amber-950/60 dark:text-amber-400">
                <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <path d="m4.93 4.93 14.14 14.14" />
                </svg>
              </div>
              <h3 className="mt-4 text-xl font-bold text-slate-900 sm:text-2xl dark:text-white">
                Dashboard Access Restricted
              </h3>
              <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
                Your staff account does not have permission to view the main hostel dashboard. Please select an authorized module from the sidebar navigation.
              </p>
            </div>
          ) : (
            <>
              {/* Top Key Metrics */}
              <DashboardStats data={data} />

              {/* Quick Actions Header */}
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-bold text-slate-900 sm:text-xl dark:text-slate-100">
                    Quick Actions
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    Frequent administrative operations and alerts
                  </p>
                </div>
              </div>

              {/* 5-Column Quick Actions Grid */}
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                {/* Rent Due Today Trigger Button */}
                <button
                  type="button"
                  aria-expanded={showRentDueToday}
                  aria-controls="rent-due-today-panel"
                  onClick={() => {
                    setShowRentDueToday((value) => !value);
                    if (!showRentDueToday) void loadDashboardData();
                  }}
                  className={`group relative flex flex-col justify-between rounded-2xl border p-5 text-left shadow-xs transition-all duration-200 hover:-translate-y-1 hover:shadow-md focus:outline-none focus:ring-4 focus:ring-blue-100 dark:focus:ring-blue-900/50 ${
                    showRentDueToday
                      ? "border-blue-500 bg-blue-50/70 ring-2 ring-blue-500/30 dark:border-blue-500 dark:bg-blue-950/40"
                      : "border-slate-200/90 bg-white hover:border-blue-400/60 dark:border-slate-800 dark:bg-slate-900"
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-50 text-amber-700 ring-1 ring-amber-500/20 dark:bg-amber-950/60 dark:text-amber-400">
                        <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect width="18" height="18" x="3" y="4" rx="2" />
                          <line x1="16" y1="2" x2="16" y2="6" />
                          <line x1="8" y1="2" x2="8" y2="6" />
                          <line x1="3" y1="10" x2="21" y2="10" />
                        </svg>
                      </div>
                      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                        {loading ? "…" : error ? "—" : summary.rentDueToday.length} Due
                      </span>
                    </div>

                    <h4 className="mt-4 text-base font-bold text-slate-900 dark:text-white">
                      Rent Due Today
                    </h4>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      View rent due today.
                    </p>
                  </div>

                  <div className="mt-4 flex items-center justify-between pt-3 border-t border-slate-100 dark:border-slate-800/80">
                    <span className="text-[11px] font-semibold text-blue-600 dark:text-blue-400">
                      {showRentDueToday ? "Hide List" : "Inspect Dues"}
                    </span>
                    <span className="text-slate-400 transition-transform group-hover:translate-x-1">→</span>
                  </div>
                </button>

                {/* Other 4 Quick Action Links */}
                {quickActions.map((action) => (
                  <Link
                    key={action.href}
                    href={action.href}
                    className={`group relative flex flex-col justify-between rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs transition-all duration-200 hover:-translate-y-1 hover:shadow-md focus:outline-none focus:ring-4 focus:ring-blue-100 dark:border-slate-800 dark:bg-slate-900 dark:focus:ring-blue-900/50 ${action.accentColor}`}
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-50 ring-1 ring-slate-200/70 dark:bg-slate-800 dark:ring-slate-700">
                          {action.icon}
                        </div>
                        <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                          {action.badge}
                        </span>
                      </div>

                      <h4 className="mt-4 text-base font-bold text-slate-900 dark:text-white">
                        {action.title}
                      </h4>
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                        {action.description}
                      </p>
                    </div>

                    <div className="mt-4 flex items-center justify-between pt-3 border-t border-slate-100 dark:border-slate-800/80">
                      <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                        Launch
                      </span>
                      <span className="text-slate-400 transition-transform group-hover:translate-x-1">→</span>
                    </div>
                  </Link>
                ))}
              </div>

              {/* Payment Followups Section */}
              <div className="mt-8">
                <PaymentFollowups staff tasks />
              </div>

              {/* Rent Due Today Expandable Panel */}
              {showRentDueToday && (
                <section
                  id="rent-due-today-panel"
                  aria-labelledby="rent-due-today-heading"
                  aria-busy={loading}
                  className="mt-6 rounded-3xl border border-blue-200 bg-white p-5 shadow-lg sm:p-6 dark:border-blue-900 dark:bg-slate-900"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4 dark:border-slate-800">
                    <div>
                      <h3 id="rent-due-today-heading" className="text-xl font-bold text-slate-900 dark:text-white">
                        Rent Due Today
                      </h3>
                      <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        Target date: {summary.today}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={loading}
                        onClick={() => void loadDashboardData()}
                        className="rounded-xl border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-bold text-slate-700 shadow-xs hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                      >
                        {loading ? "Refreshing..." : "Refresh"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowRentDueToday(false)}
                        className="rounded-xl border border-slate-200 bg-slate-100 px-3.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-200 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                      >
                        Close
                      </button>
                    </div>
                  </div>

                  {loading ? (
                    <div className="py-8 text-center text-sm text-slate-500">
                      Loading rent due today...
                    </div>
                  ) : error ? (
                    <p role="status" className="py-6 text-sm font-semibold text-red-700 dark:text-red-300">
                      Rent due today is unavailable. Please refresh.
                    </p>
                  ) : summary.rentDueToday.length === 0 ? (
                    <div className="py-8 text-center text-sm text-slate-500">
                      ✓ No outstanding Rent is due today.
                    </div>
                  ) : (
                    <ul className="mt-5 space-y-3">
                      {summary.rentDueToday.map((item) => (
                        <li
                          key={item.billId}
                          className="rounded-2xl border border-slate-200/90 bg-slate-50/60 p-4 transition hover:border-slate-300 dark:border-slate-800 dark:bg-slate-800/40"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <p className="font-bold text-slate-900 dark:text-white">
                                {item.residentName}
                              </p>
                              <p className="text-xs text-slate-500 dark:text-slate-400">
                                Room {item.room} / {item.bed ? normalizeBedLabel(item.bed) : "Bed not allocated"}
                              </p>
                            </div>
                            <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                              {item.paymentState}
                            </span>
                          </div>

                          <dl className="my-3 grid gap-3 text-xs sm:grid-cols-3">
                            <div className="rounded-xl bg-white p-2.5 border border-slate-100 dark:bg-slate-900 dark:border-slate-800">
                              <dt className="text-slate-400">Rent amount</dt>
                              <dd className="mt-0.5 text-sm font-bold text-slate-900 dark:text-white">
                                Rs {item.rentAmount.toLocaleString("en-PK")}
                              </dd>
                            </div>
                            <div className="rounded-xl bg-white p-2.5 border border-slate-100 dark:bg-slate-900 dark:border-slate-800">
                              <dt className="text-slate-400">Outstanding Rent</dt>
                              <dd className="mt-0.5 text-sm font-bold text-rose-600 dark:text-rose-400">
                                Rs {item.outstandingAmount.toLocaleString("en-PK")}
                              </dd>
                            </div>
                            <div className="rounded-xl bg-white p-2.5 border border-slate-100 dark:bg-slate-900 dark:border-slate-800">
                              <dt className="text-slate-400">Due date</dt>
                              <dd className="mt-0.5 text-sm font-bold text-slate-900 dark:text-white">
                                {item.dueDate}
                              </dd>
                            </div>
                          </dl>

                          <Link
                            href={item.href}
                            className="inline-flex rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-xs transition hover:bg-blue-700"
                          >
                            {item.paymentState === "Payment Pending Verification"
                              ? "Review payment"
                              : "Open Rent Billing"}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}

              {/* Tasks & Activity 2-Column Section */}
              <div className="mt-8 grid gap-6 lg:grid-cols-2">
                {/* Today's Tasks */}
                <section className="rounded-3xl border border-slate-200/90 bg-white p-5 shadow-xs sm:p-6 dark:border-slate-800 dark:bg-slate-900">
                  <div className="flex items-center justify-between gap-3 mb-5">
                    <div>
                      <h3 className="text-lg font-bold text-slate-900 sm:text-xl dark:text-white">
                        Today&apos;s Tasks
                      </h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Action items requiring administrative attention
                      </p>
                    </div>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                      {summary.tasks.length} Pending
                    </span>
                  </div>

                  <div className="space-y-2.5">
                    {loading ? (
                      <p className="rounded-2xl border border-slate-200 p-4 text-xs text-slate-500 dark:border-slate-800">
                        Loading current tasks...
                      </p>
                    ) : summary.tasks.length === 0 ? (
                      <div className="rounded-2xl border border-slate-200/80 bg-slate-50/50 p-6 text-center text-xs font-medium text-slate-500 dark:border-slate-800 dark:bg-slate-800/40">
                        ✓ No urgent tasks right now. All items are up to date!
                      </div>
                    ) : (
                      summary.tasks.map((item) => (
                        <Link
                          key={item.id}
                          href={item.href}
                          className={`group flex items-center justify-between gap-4 rounded-2xl border p-4 text-sm font-semibold transition-all duration-150 hover:-translate-y-0.5 hover:shadow-xs ${taskTone[item.tone]}`}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-white/80 text-xs font-bold shadow-xs dark:bg-slate-800">
                              {item.count}
                            </span>
                            <span className="truncate">{item.label}</span>
                          </div>
                          <span
                            aria-hidden="true"
                            className="text-base transition-transform group-hover:translate-x-1"
                          >
                            →
                          </span>
                        </Link>
                      ))
                    )}
                  </div>
                </section>

                {/* Recent Activity */}
                <section className="rounded-3xl border border-slate-200/90 bg-white p-5 shadow-xs sm:p-6 dark:border-slate-800 dark:bg-slate-900">
                  <div className="flex items-center justify-between gap-3 mb-5">
                    <div>
                      <h3 className="text-lg font-bold text-slate-900 sm:text-xl dark:text-white">
                        Recent Activity
                      </h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Timeline of hostel actions and record changes
                      </p>
                    </div>
                    <span className="relative flex h-2 w-2">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
                    </span>
                  </div>

                  <div className="space-y-3">
                    {loading ? (
                      <p className="text-xs text-slate-500">Loading recent activity...</p>
                    ) : summary.activities.length === 0 ? (
                      <p className="text-xs text-slate-500">No recent activity is available.</p>
                    ) : (
                      visibleActivities.map((activity) => (
                        <Link
                          key={activity.id}
                          href={activity.href}
                          className={`group block rounded-xl border-l-4 p-3 transition-all hover:bg-slate-50/80 dark:hover:bg-slate-800/60 ${activityTone[activity.tone]}`}
                        >
                          <p className="text-xs font-semibold text-slate-800 group-hover:text-blue-600 dark:text-slate-100 dark:group-hover:text-blue-400 transition-colors">
                            {activity.description}
                          </p>
                          <p className="mt-1 text-[11px] text-slate-400">
                            {formatActivityDate(activity.occurredAt)}
                          </p>
                        </Link>
                      ))
                    )}
                  </div>

                  {!loading && summary.activities.length > 3 && (
                    <button
                      type="button"
                      onClick={() => setShowAllActivity((current) => !current)}
                      className="mt-5 w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-xs font-bold text-blue-700 shadow-xs transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-blue-300 dark:hover:bg-slate-700"
                    >
                      {showAllActivity ? "Show Less" : "View All Recent Activity"}
                    </button>
                  )}
                </section>
              </div>

              {/* Charts Section */}
              <DashboardCharts data={data} />
            </>
          )}
        </section>
      </div>
    </main>
  );
}
