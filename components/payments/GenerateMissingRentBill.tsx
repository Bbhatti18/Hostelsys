"use client";
import { useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { usePermissions } from "@/lib/usePermissions";
import { rentPeriodLabel } from "@/lib/paymentReceiptPurpose";

type Preview = { admissionId: string; month: string; amount: number; dueDate: string };
async function request(path: string, body?: object) {
  let session = (await supabase.auth.getSession()).data.session;
  if (!session || (session.expires_at ?? 0) < Date.now() / 1000 + 60) session = (await supabase.auth.refreshSession()).data.session;
  if (!session) throw new Error("Sign in again before continuing.");
  const response = await fetch(path, { method: body ? "POST" : "GET", cache: "no-store", headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Missing rent bill could not be loaded.");
  return result;
}

export default function GenerateMissingRentBill({ admissionId, months, existingBills = [], onSaved }: {
  admissionId: string; months: string[]; existingBills?: Record<string, unknown>[]; onSaved: (billId: string) => void | Promise<void>;
}) {
  const { role, profile } = usePermissions();
  const [open, setOpen] = useState(false), [month, setMonth] = useState(months[0] ?? "");
  const [preview, setPreview] = useState<Preview | null>(null), [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false), [message, setMessage] = useState(""), [billId, setBillId] = useState("");
  const existing = existingBills.filter(b => b.admission_id === admissionId && b.bill_type === "Rent");
  const available = months.filter(m => !existing.some(b => b.billing_month === m));
  if (profile?.status?.toLowerCase() !== "active" || !["admin", "super admin"].includes(role.toLowerCase()) || (!available.length && !billId && !existing.length)) return null;
  const selected = available.includes(month) ? month : available[0] ?? "";
  async function load(period: string) {
    setMonth(period); setPreview(null); setConfirmed(false); setMessage(""); setBusy(true); setOpen(true);
    try { setPreview(await request(`/api/staff-payment-allocation?preview=missing-rent&admissionId=${encodeURIComponent(admissionId)}&month=${encodeURIComponent(period)}`)); }
    catch (e) { setMessage(e instanceof Error ? e.message : "Preview failed."); } finally { setBusy(false); }
  }
  return <div className="mt-2 rounded border border-indigo-200 bg-indigo-50 p-3 text-xs">
    {existing.length > 0 && <details className="mb-2"><summary className="cursor-pointer font-medium text-slate-700">Existing rent bills — automatic generation blocked</summary>
      {existing.map(b => <p key={String(b.id)} className="mt-1">{rentPeriodLabel(String(b.billing_month))}: Rent bill already exists for this month. Status: {String(b.bill_status ?? "Unknown")}. <Link href={`/billing?billId=${encodeURIComponent(String(b.id))}`} className="underline">{String(b.bill_number || b.id)}</Link>{b.bill_status === "Cancelled" && " — Replacement requires a separate explicitly authorized, audited workflow."}</p>)}
    </details>}
    {!billId && selected && <button type="button" disabled={busy} onClick={() => void load(selected)} className="rounded bg-indigo-700 px-3 py-2 font-semibold text-white">Generate Missing Rent Bill</button>}
    {open && !billId && <div className="mt-3 space-y-2">
      <label>Missing billing month <select aria-label="Missing rent month" value={selected} disabled={busy} onChange={e => void load(e.target.value)}>{available.map(m => <option key={m} value={m}>{rentPeriodLabel(m)}</option>)}</select></label>
      {preview && <><p>{rentPeriodLabel(preview.month)} — Rs{preview.amount.toLocaleString("en-PK")} — Due {preview.dueDate}</p>
        <p>Rent only. The bill will require approval in Billing.</p>
        <label className="flex gap-2"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => setConfirmed(e.target.checked)} />I confirm this month, amount and due date.</label>
        <button type="button" disabled={busy || !confirmed || preview.month !== selected || preview.admissionId !== admissionId} onClick={async () => {
          if (!confirmed || !window.confirm(`Generate ${rentPeriodLabel(preview.month)} — Rs${preview.amount.toLocaleString("en-PK")} — due ${preview.dueDate} for approval?`)) return;
          setBusy(true);
          try { const result = await request("/api/staff-payment-allocation", { action: "generate", admissionId, month: preview.month, expectedAmount: preview.amount, expectedDueDate: preview.dueDate, confirmed: true }); setBillId(result.billId); setMessage(result.message); await onSaved(result.billId); }
          catch (e) { setMessage(e instanceof Error ? e.message : "Generation failed."); setConfirmed(false); setPreview(null); }
          finally { setBusy(false); }
        }}>Confirm generation</button></>}
      <button type="button" disabled={busy} onClick={() => setOpen(false)}>Close</button>
    </div>}
    {message && <p role="status" className="mt-2">{message}</p>}
    {billId && <Link href={`/billing?billId=${encodeURIComponent(billId)}`} className="mt-2 inline-block font-semibold text-indigo-700 underline">Open generated bill in Billing</Link>}
  </div>;
}
