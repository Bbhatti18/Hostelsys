"use client";

import { useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { buildResidentFinancialSummary, type FinancialRow } from "@/lib/residentFinancialSummary";
import { buildResidentPaymentHistory, type ResidentPaymentHistoryEntry, type ResidentPaymentStatus } from "@/lib/residentPaymentHistory";

function money(value: number) {
  return new Intl.NumberFormat("en-PK", { style: "currency", currency: "PKR", maximumFractionDigits: 0 }).format(value || 0);
}

function statusClass(status: ResidentPaymentStatus) {
  if (status === "Paid") return "bg-emerald-100 text-emerald-700";
  if (status === "Rejected") return "bg-red-100 text-red-700";
  if (status === "Refunded") return "bg-blue-100 text-blue-700";
  return "bg-amber-100 text-amber-700";
}

export default function PaymentHistory({ admission, room, bed, bills, payments, receipts, onViewFinancialSummary }: { admission: FinancialRow | null; room: FinancialRow | null; bed: FinancialRow | null; bills: FinancialRow[]; payments: FinancialRow[]; receipts: FinancialRow[]; onViewFinancialSummary: () => void }) {
  const { entries, summary } = useMemo(() => buildResidentPaymentHistory({ bills, payments, receipts }), [bills, payments, receipts]);
  const financial = useMemo(() => buildResidentFinancialSummary({ admission, room, bed, bills, payments }), [admission, bed, bills, payments, room]);
  const pendingAmount = useMemo(() => {
    return entries
      .filter((entry) => entry.status === "Pending")
      .reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  }, [entries]);
  const [downloading, setDownloading] = useState("");
  const [downloadError, setDownloadError] = useState("");

  async function downloadReceipt(entry: ResidentPaymentHistoryEntry) {
    if (!entry.downloadable || downloading) return;
    setDownloading(entry.key);
    setDownloadError("");
    try {
      const { data, error } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (error || !token) throw new Error("Your session has expired. Please sign in again.");
      const response = await fetch(`/api/resident-portal/payment-receipts/${entry.source}/${entry.sourceId}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || "The receipt could not be generated.");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename = disposition.match(/filename="([^"]+)"/)?.[1] || `University Girls Hostel-Receipt-${entry.sourceId.slice(0, 8)}.pdf`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : "The receipt could not be downloaded.");
    } finally {
      setDownloading("");
    }
  }

  return (
    <section className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="Total Paid" value={money(summary.totalPaid)} note="Lifetime verified payments" />
        <SummaryCard label="Current Year Paid" value={money(summary.currentYearPaid)} note={`${new Date().getFullYear()} verified payments`} />
        <SummaryCard label="Last Payment" value={summary.lastPaymentDate || "No payments"} note={summary.lastPaymentDate ? money(summary.lastPaymentAmount) : "No completed payment yet"} />
        <article className="rounded-2xl border border-indigo-200 bg-indigo-50 p-5"><p className="text-sm font-semibold text-indigo-700">Outstanding Balance</p><p className="mt-2 text-2xl font-black text-indigo-950">{money(financial.totalOutstanding)}</p><button type="button" onClick={onViewFinancialSummary} className="mt-2 inline-flex text-xs font-bold text-indigo-700 hover:text-indigo-900">View Financial Summary →</button></article>
      </div>

      {pendingAmount > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-900 shadow-sm">
          <div className="flex items-center gap-2 font-semibold">
            <span className="flex h-2.5 w-2.5 rounded-full bg-amber-500 animate-pulse" />
            <span>Pending Verification: {money(pendingAmount)}</span>
          </div>
          <p className="mt-1 text-xs text-amber-700">
            You have submitted payment(s) awaiting staff verification. Once approved, your total paid and balance will update automatically.
          </p>
        </div>
      )}

      {downloadError && <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">{downloadError}</div>}

      <div className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 p-5"><h2 className="text-xl font-bold text-slate-900">Payment History</h2><p className="mt-1 text-sm text-slate-500">Verified payments and receipt submissions for your account.</p></div>
        {entries.length === 0 ? (
          <div className="px-5 py-12 text-center"><p className="text-sm font-semibold text-slate-700">No payment history available</p><p className="mt-1 text-xs text-slate-500">Payments and submitted receipts will appear here.</p></div>
        ) : (
          <>
            <div className="divide-y divide-slate-100 md:hidden">{entries.map((entry) => <MobilePayment key={entry.key} entry={entry} downloading={downloading === entry.key} onDownload={downloadReceipt} />)}</div>
            <div className="hidden overflow-x-auto md:block"><table className="min-w-full divide-y divide-slate-200"><thead className="bg-slate-50"><tr>{["Payment date", "Payment type", "Invoice / Bill", "Amount", "Method", "Status", "Receipt"].map((heading) => <th key={heading} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-slate-500">{heading}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{entries.map((entry) => <tr key={entry.key}><td className="whitespace-nowrap px-4 py-4 text-sm text-slate-700">{entry.date || "—"}</td><td className="px-4 py-4 text-sm font-semibold text-slate-900">{entry.paymentType}</td><td className="px-4 py-4 text-sm text-slate-700">{entry.billReference}</td><td className="whitespace-nowrap px-4 py-4 text-sm font-bold text-slate-900">{money(entry.amount)}</td><td className="px-4 py-4 text-sm text-slate-700">{entry.method}</td><td className="px-4 py-4"><Status value={entry.status} /></td><td className="px-4 py-4">{entry.downloadable ? <DownloadButton downloading={downloading === entry.key} onClick={() => void downloadReceipt(entry)} /> : <span className="text-xs text-slate-400">Available when paid</span>}</td></tr>)}</tbody></table></div>
          </>
        )}
      </div>
    </section>
  );
}

function SummaryCard({ label, value, note }: { label: string; value: string; note: string }) { return <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-sm font-semibold text-slate-500">{label}</p><p className="mt-2 text-2xl font-black text-slate-900">{value}</p><p className="mt-1 text-xs text-slate-500">{note}</p></article>; }
function Status({ value }: { value: ResidentPaymentStatus }) { return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${statusClass(value)}`}>{value}</span>; }
function DownloadButton({ downloading, onClick }: { downloading: boolean; onClick: () => void }) { return <button type="button" disabled={downloading} onClick={onClick} className="rounded-lg border border-indigo-200 px-3 py-2 text-xs font-bold text-indigo-700 transition hover:bg-indigo-50 disabled:cursor-wait disabled:opacity-60">{downloading ? "Preparing..." : "Download Receipt"}</button>; }
function MobilePayment({ entry, downloading, onDownload }: { entry: ResidentPaymentHistoryEntry; downloading: boolean; onDownload: (entry: ResidentPaymentHistoryEntry) => void }) { return <article className="p-5"><div className="flex items-start justify-between gap-3"><div><p className="font-bold text-slate-900">{entry.paymentType}</p><p className="mt-1 text-xs text-slate-500">{entry.date || "No date"} · {entry.billReference}</p></div><Status value={entry.status} /></div><div className="mt-4 grid grid-cols-2 gap-3"><div><p className="text-xs text-slate-500">Amount</p><p className="mt-1 font-black text-slate-900">{money(entry.amount)}</p></div><div><p className="text-xs text-slate-500">Method</p><p className="mt-1 text-sm font-semibold text-slate-800">{entry.method}</p></div></div>{entry.downloadable && <div className="mt-4"><DownloadButton downloading={downloading} onClick={() => onDownload(entry)} /></div>}</article>; }
