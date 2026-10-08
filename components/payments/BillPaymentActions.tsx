"use client";
import Link from "next/link";
import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { usePermissions } from "@/lib/usePermissions";
import { rentPeriodLabel } from "@/lib/paymentReceiptPurpose";

export default function BillPaymentActions({ billId, month }: { billId: string; month: unknown }) {
  const { role, profile } = usePermissions();
  const [open, setOpen] = useState(false), [amount, setAmount] = useState(""), [due, setDue] = useState(""), [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const allowed = profile?.status?.toLowerCase() === "active" && ["admin", "super admin", "accountant"].includes(role.toLowerCase());
  return <div className="mt-1 flex flex-wrap gap-2 text-xs">
    <Link href={`/billing?billId=${encodeURIComponent(billId)}`} className="text-indigo-700 underline">View Bill</Link>
    {allowed && <><Link href={`/payments?billId=${encodeURIComponent(billId)}`} className="text-indigo-700 underline">Receive Payment</Link>
      <button type="button" className="text-indigo-700 underline" disabled={busy} onClick={async () => {
        setBusy(true); setMessage("");
        const result = await supabase.rpc("payment_followup_data");
        const row = result.data?.find((r: { bill_id: string }) => r.bill_id === billId);
        if (result.error || !row || Number(row.remaining) <= 0) setMessage(result.error?.message || "This bill is no longer outstanding. Refresh the page.");
        else { setAmount(String(row.remaining)); setOpen(true); }
        setBusy(false);
      }}>Request Payment</button>
    </>}
    {open && <form className="w-full space-y-2 rounded border bg-white p-3" onSubmit={async e => {
      e.preventDefault(); if (!window.confirm(`Request Rs${amount} for ${rentPeriodLabel(month)}?`)) return;
      setBusy(true); const result = await supabase.rpc("request_obligation_payment", { p_bill: billId, p_amount: Number(amount), p_due: due, p_note: reason, p_replace_receipt: null });
      setMessage(result.error?.message || "Payment requested for this exact bill/month."); if (!result.error) setOpen(false); setBusy(false);
    }}>
      <p className="font-semibold">{rentPeriodLabel(month)}</p>
      <label>Amount<input required aria-label="Request amount" type="number" min="0.01" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} className="ml-2 rounded border" /></label>
      <label>Due<input required aria-label="Request due date" type="date" value={due} onChange={e => setDue(e.target.value)} className="ml-2 rounded border" /></label>
      <label>Reason<input required aria-label="Request reason" value={reason} onChange={e => setReason(e.target.value)} className="ml-2 rounded border" /></label>
      <button disabled={busy} type="submit">Send request</button><button type="button" onClick={() => setOpen(false)}>Close</button>
    </form>}
    {message && <p role="status" className="w-full">{message}</p>}
  </div>;
}
