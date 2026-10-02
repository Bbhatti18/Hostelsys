import { buildResidentFinancialSummary } from "@/lib/residentFinancialSummary";
import { summarizeBedInventory } from "@/lib/roomOccupancy";
import { useMemo } from "react";
import type { DashboardData } from "@/lib/dashboardData";

export default function DashboardStats({ data }: { data: DashboardData }) {
  const { residents, bills, payments, beds, admissions, rooms } = data;

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

    // 3. Revenue (All verified payments)
    const totalRevenue = payments
      .filter(p => String(p.payment_status || "").toLowerCase() === "verified")
      .reduce((sum, p) => sum + Number(p.amount || 0), 0);

    // Current account obligations share the portal calculation, including unbilled initial rent.
    const totalOutstanding = admissions.filter(admission => ["Pending", "Active"].includes(String(admission.status)))
      .reduce((sum, admission) => sum + buildResidentFinancialSummary({ admission, room: null, bed: null, bills, payments }).totalOutstanding, 0);

    return {
      totalResidents,
      occupiedBeds,
      bookableBeds,
      totalBeds,
      bedOccupancyRate,
      totalRevenue,
      totalOutstanding,
    };
  }, [residents, bills, payments, beds, admissions, rooms]);

  const money = (val: number) => `Rs ${val.toLocaleString()}`;

  const cards = [
    { label: "Active Residents", value: stats.totalResidents, color: "text-blue-600 dark:text-blue-400" },
    { label: "Total Revenue", value: money(stats.totalRevenue), color: "text-emerald-600 dark:text-emerald-400" },
    { label: "Current Admission Dues", value: money(stats.totalOutstanding), color: "text-red-600 dark:text-red-400" },
    { label: "Bed Occupancy", value: `${stats.bedOccupancyRate}%`, sub: `${stats.occupiedBeds} physically occupied / ${stats.bookableBeds} bookable`, color: "text-indigo-600 dark:text-indigo-400" },
  ];

  return (
    <div className="mb-10 grid gap-6 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => (
        <article key={card.label} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6 dark:border-slate-700 dark:bg-slate-800">
          <p className="text-sm font-medium text-slate-500 dark:text-slate-400">{card.label}</p>
          <div className="mt-2 flex flex-wrap items-baseline gap-2">
            <p className={`text-2xl font-bold sm:text-3xl ${card.color}`}>{card.value}</p>
            {card.sub && <p className="text-sm font-medium text-slate-500 dark:text-slate-400">({card.sub})</p>}
          </div>
        </article>
      ))}
    </div>
  );
}
