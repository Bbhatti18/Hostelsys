"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { roundMoney } from "@/lib/financialMath";

type Followup = { id: string; receipt_id: string | null; kind: string; amount: number; due_date: string; note: string; status: string; receipt_status: string | null };
type Obligation = { bill_id: string; admission_id: string; resident: string; purpose: string; billing_month: string;
  original: number; verified: number; pending: number; remaining: number; available: number;
  followups: Followup[]; pending_receipts: { id: string; amount: number }[] };
const money = (value: number) => `Rs ${Number(value).toLocaleString("en-PK")}`;
const input = "block w-full rounded-lg border p-2 text-sm";

export default function PaymentFollowups({ staff = false, tasks = false, onSubmitted }: {
  staff?: boolean; tasks?: boolean; onSubmitted?: () => Promise<void>;
}) {
  const [rows, setRows] = useState<Obligation[]>([]), [error, setError] = useState("");
  const [amounts, setAmounts] = useState<Record<string,string>>({});
  const [date, setDate] = useState(""), [reason, setReason] = useState(""), [ack, setAck] = useState(false);
  const [method, setMethod] = useState(""), [reference, setReference] = useState("");
  const [file, setFile] = useState<File | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [requestBill, setRequestBill] = useState(""), [requestAmount, setRequestAmount] = useState("");
  const [replace, setReplace] = useState("");
  const [against,setAgainst]=useState("current"), [historyPurpose,setHistoryPurpose]=useState("Previous Rent"), [historyDate,setHistoryDate]=useState("");
  const [evidenceAmount,setEvidenceAmount]=useState("");
  const load = useCallback(async () => {
    const result = await supabase.rpc("payment_followup_data");
    if (result.error) { setError(result.error.message); setRows([]); return; }
    setRows(result.data || []);
  }, []);
  useEffect(() => { void load(); const timer = setInterval(() => void load(),60000);
    window.addEventListener("focus",load); return () => { clearInterval(timer); window.removeEventListener("focus",load); };
  }, [load]);
  const selected = rows.filter(r => Number(amounts[r.bill_id]) > 0);
  const partial = selected.some(r => Number(amounts[r.bill_id]) < Number(r.remaining));
  const total = roundMoney(selected.reduce((sum,r) => sum + Number(amounts[r.bill_id]),0));
  const request = rows.find(r => r.bill_id === requestBill);
  async function submit() {
    setError(""); setMessage("");
    if (!file || !method || (against==="current" && (!selected.length || selected.length>2 || new Set(selected.map(r=>r.admission_id)).size!==1))) { setError("Select one obligation or Rent + Deposit from the same admission, a method and receipt."); return; }
    if (against==="current" && selected.some(r => Number(amounts[r.bill_id])>Number(r.available))) { setError("Submitted amount exceeds available balance. Review pending receipts."); return; }
    if (against==="current" && selected.length===2 && !["Rent","Security Deposit"].every(p=>selected.some(r=>r.purpose===p))) { setError("Combine Rent with Security Deposit, or submit another obligation separately."); return; }
    if (against==="current" && partial && (!ack || !date || !reason.trim())) { setError("Acknowledge the remainder and enter a future commitment date and reason."); return; }
    if (against!=="current" && (!reason.trim() || Number(evidenceAmount)<=0)) { setError("Amount and Description / Notes are required."); return; }
    setBusy(true);
    try {
      const {data} = await supabase.auth.getSession(); if (!data.session) throw new Error("Please sign in again.");
      const body = new FormData(); body.set("admissionId",selected[0]?.admission_id || rows[0]?.admission_id || "");
      if(against==="current")body.set("obligationItems",JSON.stringify(selected.map(r=>({bill_id:r.bill_id,amount:Number(amounts[r.bill_id])}))));
      else if(against==="historical") {body.set("historical","true");body.set("historicalPurpose",historyPurpose);body.set("historicalDate",historyDate);}
      else {body.set("additionalAmount",evidenceAmount);body.set("additionalCategory","Other");body.set("additionalDescription",reason);}
      body.set("notes",reason);body.set("amount",against==="current" ? String(total) : evidenceAmount); body.set("paymentMethod",method); body.set("referenceNumber",reference);
      body.set("commitmentDate",date); body.set("commitmentReason",reason); body.set("acknowledged",String(ack)); body.set("file",file);
      const response = await fetch("/api/resident-portal/combined-payment",{method:"POST",headers:{Authorization:`Bearer ${data.session.access_token}`},body});
      const result=await response.json(); if(!response.ok)throw new Error(result.error);
      setMessage(result.message); setAmounts({}); setAck(false); await load(); await onSubmitted?.();
      window.dispatchEvent(new Event("payment-workflow-changed"));
    } catch(e) { setError(e instanceof Error ? e.message : "Submission failed."); } finally { setBusy(false); }
  }
  async function requestPayment() {
    if (!request || !window.confirm(replace ? "Reject the selected pending receipt (including all its allocations) and request a corrected payment? Its evidence and history will be retained." : "Create a payment request with no financial effect?")) return;
    setBusy(true); setError(""); setMessage("");
    const result = await supabase.rpc("request_obligation_payment",{p_bill:requestBill,p_amount:Number(requestAmount),p_due:date,p_note:reason,p_replace_receipt:replace || null});
    if(result.error)setError(result.error.message); else { setMessage("Payment request recorded. No bill or payment was created."); setReplace(""); await load(); }
    setBusy(false);
  }
  // Staff Payments uses a contained request panel; resident and Dashboard views stay unchanged.
  if (staff && !tasks) return <details className="my-4 rounded-xl border bg-white text-slate-900">
    <summary className="cursor-pointer px-4 py-3 font-semibold text-indigo-700">Request Payment</summary>
    <div className="max-w-2xl space-y-3 border-t p-4">
      {error && <p role="alert" className="text-red-700">{error}</p>}
      {message && <p role="status">{message}</p>}
      <fieldset disabled={busy} className="space-y-3">
        <label className="block">Resident / obligation<select className={input} value={requestBill} onChange={e=>{setRequestBill(e.target.value);setReplace("");setRequestAmount(String(rows.find(r=>r.bill_id===e.target.value)?.remaining || ""));}}>
          <option value="">Select resident and obligation</option>
          {rows.filter(r=>Number(r.remaining)>0).map(r=><option key={r.bill_id} value={r.bill_id}>{r.resident} / {r.purpose} / {r.billing_month}</option>)}
        </select></label>
        {request && <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-3 text-sm sm:grid-cols-4">
          <p>Original: {money(request.original)}</p><p>Paid: {money(request.verified)}</p><p>Pending: {money(request.pending)}</p><p>Remaining: {money(request.remaining)}</p>
        </div>}
        <label className="block">Requested amount<input className={input} type="number" min="0.01" step="0.01" max={request?.remaining} value={requestAmount} onChange={e=>setRequestAmount(e.target.value)}/></label>
        <label className="block">Due date<input className={input} type="date" value={date} onChange={e=>setDate(e.target.value)}/></label>
        <label className="block">Notes<textarea className={input} rows={3} value={reason} onChange={e=>setReason(e.target.value)}/></label>
        {!!request?.pending_receipts.length && <label className="block">Pending receipt / replacement<select className={input} value={replace} onChange={e=>setReplace(e.target.value)}>
          <option value="">Keep pending proof; send follow-up only</option>
          {request.pending_receipts.map((r,i)=><option key={r.id} value={r.id}>Reject / replace pending receipt {i+1} / full receipt {money(r.amount)}</option>)}
        </select><span className="text-xs text-slate-600">Replacement rejects the selected receipt and all its allocations; proof and history are retained.</span></label>}
        {!!request?.followups.length && <details className="rounded-lg border p-3 text-sm"><summary className="cursor-pointer font-medium">Existing requests and commitments</summary>
          {request.followups.map(f=><div key={f.id} className="mt-2 break-words border-t pt-2"><p>{f.kind==='request'?'Payment Requested':'Payment Commitment'} / {f.status} / {money(f.amount)} / {f.due_date}</p><p className="whitespace-pre-wrap">{f.note}</p>{f.receipt_status && <p>Receipt: {f.receipt_status}</p>}</div>)}
        </details>}
        <button className="rounded bg-indigo-600 px-4 py-2 text-white disabled:opacity-50" disabled={!request} type="button" onClick={()=>void requestPayment()}>{busy?'Working...':'Request Payment'}</button>
      </fieldset>
    </div>
  </details>;
  const visible = tasks ? rows.filter(r => Number(r.remaining)>0 && r.followups.some(f => ["Due Today","Overdue"].includes(f.status))) : rows;
  return <section className="my-6 space-y-4 rounded-2xl border bg-white p-5 text-slate-900">
    <h2 className="text-xl font-bold">{tasks ? "Payment Follow-ups Due Today / Overdue" : staff ? "Request Payment / Re-send Due" : "Pay an Obligation / Payment Commitments"}</h2>
    {error && <p role="alert" className="text-red-700">{error}</p>}{message && <p role="status">{message}</p>}
    {!staff && !tasks && <label>Payment Against<select className={input} value={against} disabled={busy} onChange={e=>setAgainst(e.target.value)}><option value="current">Current canonical obligation (full or partial)</option><option value="other">Other Charges (staff classification required)</option><option value="historical">Previous / Historical Payment Receipt (evidence only)</option></select></label>}
    {!tasks && !staff && <p>Original Due: {money(rows.reduce((s,r)=>s+Number(r.original),0))} · Verified: {money(rows.reduce((s,r)=>s+Number(r.verified),0))} · Pending Verification: {money(rows.reduce((s,r)=>s+Number(r.pending),0))} · Remaining Financial Due: {money(rows.reduce((s,r)=>s+Number(r.remaining),0))}</p>}
    {visible.map(row => <article key={row.bill_id} className="space-y-2 rounded-lg border p-3">
      <h3 className="font-semibold">{staff && `${row.resident} — `}{row.purpose} · {row.billing_month}</h3>
      <p>Original: {money(row.original)} · Verified: {money(row.verified)} · Pending Verification: {money(row.pending)} · Remaining Due: {money(row.remaining)} · Available to submit now: {money(row.available)}</p>
      {row.followups.some(f=>f.status!=="Resolved") && <p>Next Commitment / Requested Due Date: {row.followups.filter(f=>f.status!=="Resolved").map(f=>f.due_date).sort()[0]}</p>}
      {row.followups.filter(f=>!tasks || ["Due Today","Overdue"].includes(f.status)).map(f=><div key={f.id} className="rounded bg-slate-50 p-2 text-sm">
        <strong>{f.kind === "request" ? "Payment Requested" : "Payment Commitment"} — {f.status}</strong>
        <p>{f.kind === "request" ? "Requested Now" : "Acknowledged Remainder"}: {money(f.amount)} · Current Outstanding: {money(row.remaining)} · Due: {f.due_date}</p>
        <p>{f.note}{f.receipt_status ? ` · Receipt: ${f.receipt_status}` : ""}</p>
      </div>)}
      {!staff && !tasks && against==="current" && Number(row.available)>0 && <label className="block">Amount being submitted now<input aria-label={`Submit ${row.purpose} ${row.billing_month}`} className={input} type="number" min="0" step="0.01" max={row.available} value={amounts[row.bill_id] || ""} onChange={e=>setAmounts(a=>({...a,[row.bill_id]:e.target.value}))} disabled={busy}/></label>}
      {staff && <Link className="text-indigo-700 underline" href="/payment-verification">Review payments / receipts</Link>}
    </article>)}
    {tasks && !visible.length && !error && <p>No outstanding payment follow-ups due today.</p>}
    {!tasks && <fieldset disabled={busy} className="space-y-3">
      {staff ? <>
        <label>Obligation<select className={input} value={requestBill} onChange={e=>{setRequestBill(e.target.value);setReplace("");setRequestAmount(String(rows.find(r=>r.bill_id===e.target.value)?.remaining || ""));}}><option value="">Select obligation</option>{rows.filter(r=>Number(r.remaining)>0).map(r=><option key={r.bill_id} value={r.bill_id}>{r.resident} — {r.purpose} — {r.billing_month}</option>)}</select></label>
        {request && <p>Verified: {money(request.verified)} · Pending: {money(request.pending)} · Genuine Outstanding: {money(request.remaining)}</p>}
        {!!request?.pending_receipts.length && <label>Pending proof already exists<select className={input} value={replace} onChange={e=>setReplace(e.target.value)}><option value="">Keep pending proof; send follow-up only</option>{request.pending_receipts.map(r=><option key={r.id} value={r.id}>Explicitly reject/replace receipt {r.id} — full receipt {money(r.amount)}</option>)}</select></label>}
        <label>Requested amount<input className={input} type="number" min="0.01" step="0.01" max={request?.remaining} value={requestAmount} onChange={e=>setRequestAmount(e.target.value)}/></label>
      </> : <>
        <p>{against==="historical" ? "Historical evidence verification does not pay any current bill or count as collections." : `Submitting now: ${money(against==="current" ? total : Number(evidenceAmount))}. Only verified payments reduce your financial balance.`}</p>
        {against==="current" && selected.map(r=><p key={r.bill_id}>{r.purpose} remaining after verification: {money(Math.max(Number(r.remaining)-Number(amounts[r.bill_id]),0))}</p>)}
        {against!=="current" && <><label>Amount<input className={input} type="number" min="0.01" step="0.01" value={evidenceAmount} onChange={e=>setEvidenceAmount(e.target.value)}/></label><label>Description / Notes (required)<textarea className={input} value={reason} onChange={e=>setReason(e.target.value)}/></label></>}
        {against==="historical" && <><label>Historical Purpose<select className={input} value={historyPurpose} onChange={e=>setHistoryPurpose(e.target.value)}>{['Previous Rent','Previous Security Deposit','Previous Rent + Security Deposit','Other Charges'].map(p=><option key={p}>{p}</option>)}</select></label><label>Actual receipt/payment date<input className={input} type="date" value={historyDate} onChange={e=>setHistoryDate(e.target.value)}/></label></>}
        <label>Payment method<input className={input} value={method} onChange={e=>setMethod(e.target.value)}/></label>
        <label>Reference<input className={input} value={reference} onChange={e=>setReference(e.target.value)}/></label>
        <label>Receipt (PDF/JPEG/PNG, up to 5 MB)<input className={input} type="file" accept="application/pdf,image/jpeg,image/png" onChange={e=>setFile(e.target.files?.[0] || null)}/></label>
      </>}
      {(staff || (against==="current" && partial)) && <>
        <label>{staff ? "Requested due date" : "I will pay remaining amount by"}<input className={input} type="date" value={date} onChange={e=>setDate(e.target.value)}/></label>
        <label>{staff ? "Message / notes" : "Reason / notes"}<textarea className={input} value={reason} onChange={e=>setReason(e.target.value)}/></label>
        {!staff && <label className="block"><input type="checkbox" checked={ack} onChange={e=>setAck(e.target.checked)}/> I acknowledge the remaining balance above. This commitment is not a payment.</label>}
      </>}
      <button className="rounded bg-indigo-600 px-4 py-2 text-white" type="button" onClick={()=>void (staff ? requestPayment() : submit())}>{busy ? "Working..." : staff ? "Request Payment" : "Submit for Verification"}</button>
    </fieldset>}
  </section>;
}
