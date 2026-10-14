import { dashboardCurrentAdmissionDues, dashboardOperatingRevenue, dashboardSecurityDepositsHeld } from "@/lib/dashboardFinance";
import { summarizeBedInventory } from "@/lib/roomOccupancy";
import { useMemo } from "react";
import type { DashboardData } from "@/lib/dashboardData";

export default function DashboardStats({ data }: { data: DashboardData }) {
  const { residents, bills, payments, beds, admissions, rooms, lateFees, lateFeeAllocations } = data;

  const stats = useMemo(() => {
    // 1. Total Residents (Active)
    const totalResidents = residents.filter(r => r.status === "Active").length;

    // 2. Room Occupancy & Bed Occupancy
    const bedInventory = summarizeBedInventory(
      rooms as Array<{ id: string; status: string | null }>,
      beds as Array<{ id: string; room_id: string; status: string | null }>,
      admissions as Array<{ id: string; room_id: string | null; bed_id: string | null; resident_id: string; status: string | null; allocation_mode?: string | null }>,
    );
    const occupiedBeds = bedInventory.occupied;
    const bookableBeds = bedInventory.bookable;
    const totalBeds = beds.length;
    const bedOccupancyRate = totalBeds > 0 ? Math.round((occupiedBeds / totalBeds) * 100) : 0;

    const totalRevenue = dashboardOperatingRevenue(payments, bills, lateFeeAllocations);
    const totalOutstanding = dashboardCurrentAdmissionDues(admissions, bills, payments, lateFees);
    const securityDepositsHeld = dashboardSecurityDepositsHeld(admissions, bills, payments);

    return {
      totalResidents,
      occupiedBeds,
      bookableBeds,
      totalBeds,
      bedOccupancyRate,
      totalRevenue,
      totalOutstanding,
      securityDepositsHeld,
    };
  }, [residents, bills, payments, beds, admissions, rooms, lateFees, lateFeeAllocations]);

  const money = (val: number) => `Rs ${val.toLocaleString()}`;

  const cards = [
    {
      label: "Active Residents",
      value: stats.totalResidents,
      subtext: "Currently enrolled",
      color: "text-blue-600 dark:text-blue-400",
      accentBg: "bg-blue-50 text-blue-600 ring-1 ring-blue-500/20 dark:bg-blue-950/60 dark:text-blue-400 dark:ring-blue-500/30",
      borderTop: "border-t-blue-500",
      icon: (
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      ),
    },
    {
      label: "Total Revenue",
      value: money(stats.totalRevenue),
      subtext: "Verified receipts & collections",
      color: "text-emerald-600 dark:text-emerald-400",
      accentBg: "bg-emerald-50 text-emerald-600 ring-1 ring-emerald-500/20 dark:bg-emerald-950/60 dark:text-emerald-400 dark:ring-emerald-500/30",
      borderTop: "border-t-emerald-500",
      icon: (
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect width="20" height="14" x="2" y="5" rx="2" />
          <line x1="2" x2="22" y1="10" y2="10" />
          <circle cx="7" cy="15" r="1" />
          <circle cx="11" cy="15" r="1" />
        </svg>
      ),
    },
    {
      label: "Current Admission Dues",
      value: money(stats.totalOutstanding),
      subtext: "Unsettled rent & pending bills",
      color: "text-red-600 dark:text-red-400",
      accentBg: "bg-red-50 text-red-600 ring-1 ring-red-500/20 dark:bg-red-950/60 dark:text-red-400 dark:ring-red-500/30",
      borderTop: "border-t-red-500",
      icon: (
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="12" y1="18" x2="12" y2="12" />
          <line x1="12" y1="9" x2="12.01" y2="9" />
        </svg>
      ),
    },
    {
      label: "Security Deposits Held",
      value: money(stats.securityDepositsHeld),
      subtext: "Held in reserve escrow",
      color: "text-amber-700 dark:text-amber-400",
      accentBg: "bg-amber-50 text-amber-700 ring-1 ring-amber-500/20 dark:bg-amber-950/60 dark:text-amber-400 dark:ring-amber-500/30",
      borderTop: "border-t-amber-500",
      icon: (
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      ),
    },
    {
      label: "Bed Occupancy",
      value: `${stats.bedOccupancyRate}%`,
      subtext: `${stats.occupiedBeds} of ${stats.totalBeds} beds occupied`,
      color: "text-indigo-600 dark:text-indigo-400",
      accentBg: "bg-indigo-50 text-indigo-600 ring-1 ring-indigo-500/20 dark:bg-indigo-950/60 dark:text-indigo-400 dark:ring-indigo-500/30",
      borderTop: "border-t-indigo-500",
      hasProgress: true,
      progressPercent: stats.bedOccupancyRate,
      icon: (
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M2 4v16" />
          <path d="M2 8h18a2 2 0 0 1 2 2v10" />
          <path d="M2 17h20" />
          <path d="M6 8v9" />
        </svg>
      ),
    },
  ];

  return (
    <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {cards.map((card) => (
        <article
          key={card.label}
          className="group relative flex flex-col justify-between rounded-2xl border border-slate-200/90 bg-white p-5 shadow-xs transition-all duration-200 hover:-translate-y-1 hover:shadow-md dark:border-slate-800 dark:bg-slate-900"
        >
          <div>
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                {card.label}
              </p>
              <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${card.accentBg}`}>
                {card.icon}
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-baseline gap-2">
              <p className={`text-2xl font-black tracking-tight sm:text-3xl ${card.color}`}>
                {card.value}
              </p>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800/80">
            {card.hasProgress && (
              <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-indigo-600 transition-all duration-500"
                  style={{ width: `${Math.min(card.progressPercent || 0, 100)}%` }}
                />
              </div>
            )}
            <p className="text-xs text-slate-400 dark:text-slate-400">
              {card.subtext}
            </p>
          </div>
        </article>
      ))}
    </div>
  );
}
