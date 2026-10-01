import Link from "next/link";
import { getAdmissionDeposit, depositStateLabel } from "@/lib/contractWorkflow";
import { useMemo } from "react";
import { buildResidentFinancialSummary, type FinancialLineItem, type FinancialRow } from "@/lib/residentFinancialSummary";

function money(value: number) {
  return new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", maximumFractionDigits: 0 }).format(value || 0);
}

function dateLabel(value: string | null) {
  if (!value) return "No deadline";
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString("en-PK", { day: "numeric", month: "short", year: "numeric" });
}

function tone(status: string) {
  const normalized = status.trim().toLowerCase();
  if (["paid", "held", "verified"].includes(normalized)) return "bg-emerald-100 text-emerald-700";
  if (normalized === "overdue") return "bg-red-100 text-red-700";
  if (normalized === "not billed" || normalized === "not required" || normalized === "no deposit required") return "bg-slate-100 text-slate-600";
  if (normalized === "deposit verified") return "bg-emerald-100 text-emerald-700";
  return "bg-amber-100 text-amber-700";
}

export default function FinancialSummary({ admission, room, bed, bills, payments }: { admission: FinancialRow | null; room: FinancialRow | null; bed: FinancialRow | null; bills: FinancialRow[]; payments: FinancialRow[] }) {
  const summary = useMemo(() => buildResidentFinancialSummary({ admission, room, bed, bills, payments }), [admission, bed, bills, payments, room]);

  return (
    <section className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-slate-200 bg-gradient-to-r from-indigo-700 via-blue-700 to-cyan-600 p-5 text-white sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div><p className="text-xs font-bold uppercase tracking-[0.2em] text-blue-100">Account overview</p><h2 className="mt-1 text-2xl font-bold">Financial Summary</h2><p className="mt-1 text-sm text-blue-100">Your current payable amounts and deadlines in one place.</p></div>
        <Link href="/resident-portal/payments" className="inline-flex justify-center rounded-xl bg-white px-4 py-2.5 text-sm font-bold text-indigo-700 shadow-sm">Payments & receipts</Link>
      </div>

      <div className="space-y-5 p-4 sm:p-6">
        <div className={`rounded-2xl border p-4 sm:p-5 ${summary.accountStatus === "Overdue" ? "border-red-200 bg-red-50" : summary.totalOutstanding > 0 ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div><p className="text-sm font-bold uppercase tracking-wide text-slate-600">Total Payable (Rent + Security Deposit)</p><p className={`mt-2 text-2xl font-black sm:text-4xl ${summary.accountStatus === "Overdue" ? "text-red-700" : summary.totalOutstanding > 0 ? "text-amber-700" : "text-emerald-700"}`}>{money(summary.monthlyRentDue + summary.depositBalance)}</p><p className="mt-2 text-sm text-slate-600">Payment deadline: <strong>{summary.totalOutstanding > 0 ? dateLabel(summary.paymentDeadline) : "No payment due"}</strong></p></div>
            <Status value={summary.accountStatus} />
          </div>
          <div className="mt-5 grid grid-cols-1 gap-3 border-t border-slate-200/70 pt-4 sm:grid-cols-3 xl:grid-cols-4"><MiniValue label="Rent Due" value={money(summary.monthlyRentDue)} /><MiniValue label="Security Deposit Due" value={money(summary.depositBalance)} /><MiniValue label="Utilities due" value={money(summary.utilityItems.reduce((sum, item) => sum + item.amount, 0))} /><MiniValue label="Other charges due" value={money(summary.otherItems.reduce((sum, item) => sum + item.amount, 0))} /><MiniValue label="Discount applied" value={`− ${money(summary.discountApplied)}`} /></div>
          <div className="mt-4 grid grid-cols-1 gap-3 border-t border-slate-200/70 pt-4 sm:grid-cols-3"><MiniValue label="Original charges" value={money(summary.totalCharges)} /><MiniValue label="Payments received" value={`− ${money(summary.verifiedPayments)}`} /><MiniValue label="Account outstanding (all charges)" value={money(summary.totalOutstanding)} /></div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <OverviewCard title="Monthly Rent" status={summary.rentStatus}>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Total outstanding rent</p><Amount value={summary.monthlyRentDue} /><div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><MiniValue label="Original rent" value={money(summary.rentCharges)} /><MiniValue label="Verified paid" value={money(summary.rentPaid)} /><MiniValue label="Balance" value={money(summary.monthlyRentDue)} /></div><Detail label="Current monthly rate" value={money(summary.monthlyRent)} /><Detail label="Earliest unpaid due date" value={summary.rentDueDate ? dateLabel(summary.rentDueDate) : summary.rentStatus === "Not Billed" ? "Not billed yet" : "No rent due"} />
          </OverviewCard>
          <OverviewCard title="Security Deposit" status={depositStateLabel(getAdmissionDeposit(admission, bills, payments).state)}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3"><MiniValue label="Required" value={money(summary.depositRequired)} /><MiniValue label="Paid" value={money(summary.depositPaid)} /><MiniValue label="Remaining" value={money(summary.depositBalance)} /></div>
          </OverviewCard>
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          <LineItemsCard title="Utility Bills" subtitle="Electricity and AC charges billed to your account" items={summary.utilityItems} empty="No electricity or AC utility charges are currently due.">
            <div className="mt-3 grid grid-cols-2 gap-2"><UnavailableUtility label="Water" /><UnavailableUtility label="Internet" /></div>
          </LineItemsCard>
          <LineItemsCard title="Other Pending Amounts" subtitle="Maintenance, additional, fine, or miscellaneous charges" items={summary.otherItems} empty="No other pending amounts are currently due." />
        </div>
      </div>
    </section>
  );
}

function Status({ value }: { value: string }) { return <span className={`inline-flex w-fit rounded-full px-3 py-1.5 text-xs font-extrabold uppercase tracking-wide ${tone(value)}`}>{value}</span>; }
function MiniValue({ label, value }: { label: string; value: string }) { return <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p><p className="mt-1 text-sm font-bold text-slate-900 sm:text-base">{value}</p></div>; }
function Amount({ value }: { value: number }) { return <p className="text-3xl font-black text-slate-900">{money(value)}</p>; }
function Detail({ label, value }: { label: string; value: string }) { return <div className="flex items-center justify-between gap-4 border-t border-slate-100 pt-3 text-sm"><span className="text-slate-500">{label}</span><strong className="text-right text-slate-900">{value}</strong></div>; }
function OverviewCard({ title, status, children }: { title: string; status: string; children: React.ReactNode }) { return <article className="rounded-2xl border border-slate-200 p-5"><div className="mb-5 flex items-center justify-between gap-3"><h3 className="text-lg font-bold text-slate-900">{title}</h3><Status value={status} /></div><div className="space-y-3">{children}</div></article>; }
function LineItemsCard({ title, subtitle, items, empty, children }: { title: string; subtitle: string; items: FinancialLineItem[]; empty: string; children?: React.ReactNode }) { return <article className="rounded-2xl border border-slate-200 p-5"><h3 className="text-lg font-bold text-slate-900">{title}</h3><p className="mt-1 text-xs leading-5 text-slate-500">{subtitle}</p><div className="mt-4 space-y-2">{items.length ? items.map((item) => <div key={item.id} className="rounded-xl bg-slate-50 p-3"><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-bold text-slate-900">{item.title}</p><p className="mt-1 text-xs text-slate-500">Due {dateLabel(item.dueDate)}</p></div><div className="text-right"><p className="text-sm font-black text-slate-900">{money(item.amount)}</p><span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${tone(item.status)}`}>{item.status}</span></div></div></div>) : <div className="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">{empty}</div>}</div>{children}</article>; }
function UnavailableUtility({ label }: { label: string }) { return <div className="rounded-lg bg-slate-50 px-3 py-2"><p className="text-xs font-semibold text-slate-500">{label}</p><p className="mt-0.5 text-xs text-slate-400">Not billed separately</p></div>; }
