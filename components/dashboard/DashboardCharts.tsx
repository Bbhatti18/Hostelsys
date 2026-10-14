"use client";

import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";

import type { DashboardData } from "@/lib/dashboardData";
import { summarizeBedInventory } from "@/lib/roomOccupancy";
import { dashboardVerifiedPaymentRevenue } from "@/lib/dashboardFinance";

export default function DashboardCharts({ data }: { data: DashboardData }) {
  const { beds, payments, rooms, admissions, bills, lateFeeAllocations } = data;

  const occupancyData = useMemo(() => {
    const inventory = summarizeBedInventory(
      rooms as Array<{ id: string; status: string | null }>,
      beds as Array<{ id: string; room_id: string; status: string | null }>,
      admissions as Array<{ id: string; room_id: string | null; bed_id: string | null; resident_id: string; status: string | null; allocation_mode?: string | null }>,
    );
    const totalBeds = inventory.total;
    const occupiedBeds = inventory.occupied;
    const availableBeds = inventory.bookable;
    const blockedBeds = inventory.blocked;
    const inactiveBeds = beds.filter((bed: any) => bed.status === "Inactive").length;
    const reviewBeds = Math.max(0, totalBeds - occupiedBeds - availableBeds - blockedBeds - inactiveBeds);

    return [
      { name: "Occupied", value: occupiedBeds },
      { name: "Vacant", value: availableBeds },
      ...(blockedBeds > 0 ? [{ name: "Blocked by Whole-Room Allocation", value: blockedBeds }] : []),
      ...(reviewBeds > 0 ? [{ name: "Unavailable / Review", value: reviewBeds }] : []),
      ...(inactiveBeds > 0 ? [{ name: "Inactive", value: inactiveBeds }] : []),
    ];
  }, [beds, rooms, admissions]);

  const revenueData = useMemo(() => {
    const months = new Map<string, number>();

    // Generate last 6 months labels
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const label = d.toLocaleString("default", { month: "short", year: "numeric" });
      months.set(label, 0);
    }

    for (const payment of dashboardVerifiedPaymentRevenue(payments, bills, lateFeeAllocations)) {
      const date = new Date(payment.date);
      const label = date.toLocaleString("default", { month: "short", year: "numeric" });
      if (months.has(label)) {
        months.set(label, (months.get(label) || 0) + payment.amount);
      }
    }

    return Array.from(months.entries()).map(([month, amount]) => ({
      month,
      amount,
    }));
  }, [payments, bills, lateFeeAllocations]);

  const COLORS = ["#4f46e5", "#10b981", "#f59e0b", "#94a3b8", "#e11d48"];

  const formatCurrency = (value: number) => `Rs ${value.toLocaleString()}`;

  const totalBedsCount = beds.length;

  return (
    <div className="mt-8 grid gap-6 lg:grid-cols-2">
      {/* Revenue Chart */}
      <section className="rounded-3xl border border-slate-200/90 bg-white p-5 shadow-xs sm:p-6 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between gap-3 mb-6">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
              Financial Trend
            </span>
            <h3 className="text-lg font-bold text-slate-900 sm:text-xl dark:text-white">
              Revenue (Last 6 Months)
            </h3>
          </div>
          <span className="rounded-lg bg-indigo-50 border border-indigo-100 px-2.5 py-1 text-xs font-semibold text-indigo-700 dark:bg-indigo-950/60 dark:border-indigo-900/60 dark:text-indigo-300">
            Monthly Verified
          </span>
        </div>

        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={revenueData} margin={{ top: 10, right: 10, left: 10, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" opacity={0.6} />
              <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fill: "#64748b", fontSize: 12 }} dy={10} />
              <YAxis
                axisLine={false}
                tickLine={false}
                tickFormatter={(val: number) => `Rs ${val >= 1000 ? val / 1000 + "k" : val}`}
                tick={{ fill: "#64748b", fontSize: 12 }}
                width={70}
              />
              <Tooltip
                cursor={{ fill: "#f1f5f9" }}
                contentStyle={{
                  borderRadius: "14px",
                  border: "1px solid #e2e8f0",
                  backgroundColor: "#ffffff",
                  boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1)",
                  padding: "10px 14px",
                }}
                formatter={(value: any) => [formatCurrency(Number(value) || 0), "Revenue"]}
              />
              <Bar dataKey="amount" fill="#4f46e5" radius={[8, 8, 0, 0]} barSize={36} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* Bed Occupancy Chart */}
      <section className="rounded-3xl border border-slate-200/90 bg-white p-5 shadow-xs sm:p-6 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex items-center justify-between gap-3 mb-6">
          <div>
            <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
              Capacity Status
            </span>
            <h3 className="text-lg font-bold text-slate-900 sm:text-xl dark:text-white">
              Bed Occupancy
            </h3>
          </div>
          <span className="rounded-lg bg-emerald-50 border border-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:bg-emerald-950/60 dark:border-emerald-900/60 dark:text-emerald-300">
            {totalBedsCount} Total Beds
          </span>
        </div>

        <div className="flex h-[300px] w-full items-center justify-center">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={occupancyData}
                cx="50%"
                cy="50%"
                innerRadius={68}
                outerRadius={96}
                paddingAngle={4}
                dataKey="value"
                stroke="none"
              >
                {occupancyData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  borderRadius: "14px",
                  border: "1px solid #e2e8f0",
                  backgroundColor: "#ffffff",
                  boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1)",
                  padding: "8px 12px",
                }}
              />
              <Legend verticalAlign="bottom" height={36} iconType="circle" />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </section>
    </div>
  );
}
