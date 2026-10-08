"use client";
import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { usePermissions } from "@/lib/usePermissions";
import { rentPeriodLabel } from "@/lib/paymentReceiptPurpose";

type Obligation = { bill_id: string; bill_type: string; billing_month: string; due_date: string; total: number; verified: number; pending: number; available: number };
type Snapshot = { amount: number; fingerprint: string; obligations: Obligation[]; allocations: { bill_id: string; amount: number }[]; fine_linked: boolean; already_corrected: boolean; receipt: { id: string } | null };
const money = (n: number) => `Rs${Number(n).toLocaleString("en-PK")}`;
const label = (b: Pick<Obligation, "bill_type" | "billing_month">) => b.bill_type === "Rent" ? rentPeriodLabel(b.billing_month) : b.bill_type === "Other Charges" ? "Additional Charges" : b.bill_type;
async function call(path: string, body?: unknown) {
  let session = (await supabase.auth.getSession()).data.session;
  if (!session || (session.expires_at ?? 0) < Date.now() / 1000 + 60) session = (await supabase.auth.refreshSession()).data.session;
  if (!session) throw new Error("Sign in again before continuing.");
  const response = await fetch(path, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}
export default function StaffAllocationEditor({ paymentId, receiptId, correction = false, onSaved }: {
  paymentId?: string | null; receiptId?: string | null; correction?: boolean; onSaved: () => void;
}) {
  const { role, profile } = usePermissions();
  const authorized = profile?.status?.toLowerCase() === "active" && (correction ? ["admin", "super admin"] : ["admin", "super admin", "accountant"]).includes(role.toLowerCase());
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [amounts, setAmounts] = useState<Record<string, string>>({});
  const [reason, setReason] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [exception, setException] = useState(false), [exceptionReason, setExceptionReason] = useState(""), [confirmed, setConfirmed] = useState(false);
  const [requestId, setRequestId] = useState("");
  const [message, setMessage] = useState("");
  if (!authorized) return null;
  const items = snapshot?.obligations.filter(b => Number(amounts[b.bill_id]) > 0).map(b => ({ bill_id: b.bill_id, bill_type: b.bill_type, billing_month: b.billing_month, due_date: b.due_date, amount: Number(amounts[b.bill_id]) })) ?? [];
  const total = items.reduce((s, b) => s + Math.round(b.amount * 100), 0);
  async function open() {
    setBusy(true); setError(""); setMessage("");
    try {
      const params = new URLSearchParams(); if (paymentId) params.set("paymentId", paymentId); if (receiptId) params.set("receiptId", receiptId);
      const data: Snapshot = await call(`/api/staff-payment-allocation?${params}`);
      if (data.fine_linked) throw new Error("This payment includes Late Fee credit. Use the existing Late Fee verification workflow; fine reallocations require separate review.");
      if (data.already_corrected) throw new Error("Previously corrected transactions require separate settlement review.");
      setSnapshot(data); setAmounts(Object.fromEntries(data.allocations.map(a => [a.bill_id, String(a.amount)]))); setRequestId(crypto.randomUUID()); setConfirmed(false);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to load payment."); } finally { setBusy(false); }
  }
  async function save() {
    if (!snapshot || total !== Math.round(Number(snapshot.amount) * 100) || !confirmed || !reason.trim() || (exception && !exceptionReason.trim())) { setError("Confirm the exact total and provide required reasons."); return; }
    setBusy(true); setError("");
    try {
      const result = await call("/api/staff-payment-allocation", { action: correction ? "correct" : "verify", paymentId, receiptId: receiptId || snapshot.receipt?.id,
        requestId, fingerprint: snapshot.fingerprint, items, reason, confirmed, feeExceptionReason: exception ? exceptionReason : null, feeExceptionConfirmed: exception });
      setMessage(`${result.message}${result.notificationWarning ? " Notification delivery needs review; the payment was saved." : ""}`); setSnapshot(null); onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : "Allocation failed; reload before retrying."); } finally { setBusy(false); }
  }
  return <div className="text-xs">
    <button type="button" disabled={busy} onClick={() => void open()} className="rounded border border-indigo-200 px-3 py-2 text-indigo-700">{correction ? "Correct Payment Allocation" : "Select Allocation / Verify"}</button>
    {error && <p role="alert" className="mt-2 text-red-700">{error}</p>}
    {message && <p role="status" className="mt-2">{message}</p>}
    {snapshot && <section className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 p-4" role="dialog" aria-modal="true" aria-label="Payment allocation">
      <div className="mx-auto max-w-3xl space-y-4 rounded-xl bg-white p-5 text-sm">
        <h2 className="text-lg font-bold">{correction ? "Correct Payment Allocation" : "Select exact payment obligations"}</h2>
        <p>Received amount: {money(snapshot.amount)}. Select exact bills and amounts; no billing month will be substituted.</p>
        <p>Before: {snapshot.allocations.map(a => `${label(snapshot.obligations.find(b => b.bill_id === a.bill_id) ?? { bill_type: "Historical bill", billing_month: "" })} ${money(a.amount)}`).join(" + ") || "No bill allocation recorded; choose explicitly."}</p>
        {snapshot.obligations.map(b => <label key={b.bill_id} className="block rounded border p-3">
          <strong>{label(b)}</strong> / Due {b.due_date}<br />Total {money(b.total)} / Verified {money(b.verified)} / Pending {money(b.pending)} / Available for this payment {money(b.available)}
          <input aria-label={`${label(b)} allocation amount`} type="number" min="0" max={b.available} step="0.01" disabled={Number(b.available) <= 0} value={amounts[b.bill_id] ?? ""} onChange={e => { setAmounts(a => ({ ...a, [b.bill_id]: e.target.value })); setConfirmed(false); }} className="ml-3 rounded border p-2" />
        </label>)}
        <p>After: {items.map(i => `${label(i)} ${money(i.amount)}`).join(" + ") || "No allocation selected"}</p>
        <p>Total: {money(total / 100)} / Required: {money(snapshot.amount)}</p>
        <label className="block">Allocation reason<textarea required value={reason} maxLength={2000} onChange={e => { setReason(e.target.value); setConfirmed(false); }} className="block w-full rounded border p-2" /></label>
        {correction && <details><summary>Separate historical late-fee authorization</summary>
          <label><input type="checkbox" checked={exception} onChange={e => { setException(e.target.checked); setConfirmed(false); }} /> Explicitly authorize no correction-generated fee for selected historical rent only</label>
          <p>Existing late-fee history and future rent policy cannot be waived here.</p>
          {exception && <label>Mandatory exception reason<textarea value={exceptionReason} onChange={e => { setExceptionReason(e.target.value); setConfirmed(false); }} className="block w-full rounded border p-2" /></label>}
        </details>}
        <label className="block"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /> I confirm these exact periods and amounts. {correction ? "Reverse the original credit and create one audited replacement." : "Verify this payment once."}</label>
        {error && <p role="alert" className="text-red-700">{error}</p>}
        <button type="button" disabled={busy || !confirmed || total !== Math.round(Number(snapshot.amount) * 100)} onClick={() => void save()} className="rounded bg-indigo-700 px-4 py-2 text-white">{busy ? "Saving…" : correction ? "Confirm Correction" : "Confirm Verification"}</button>
        <button type="button" disabled={busy} onClick={() => setSnapshot(null)} className="ml-3 rounded border px-4 py-2">Close</button>
      </div>
    </section>}
  </div>;
}

export function GenerateMissingRent({ admissionId, onSaved }: { admissionId: string; onSaved: () => void }) {
  const { role, profile } = usePermissions();
  const [month, setMonth] = useState(""), [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  if (profile?.status?.toLowerCase() !== "active" || !["admin", "super admin"].includes(role.toLowerCase())) return null;
  return <details className="mt-2 text-xs"><summary className="cursor-pointer">Generate Missing Rent Bill</summary>
    <input aria-label="Missing rent month" type="month" value={month} onChange={e => setMonth(e.target.value)} />
    <button type="button" disabled={!month || busy} onClick={async () => {
      if (!window.confirm(`Generate missing Rent — ${month} for approval? Existing bills will never be overwritten.`)) return;
      setBusy(true); try { const result = await call("/api/staff-payment-allocation", { action: "generate", admissionId, month }); setMessage(result.message); onSaved(); }
      catch (e) { setMessage(e instanceof Error ? e.message : "Generation failed."); } finally { setBusy(false); }
    }}>Generate for approval</button><p role="status">{message}</p>
  </details>;
}
