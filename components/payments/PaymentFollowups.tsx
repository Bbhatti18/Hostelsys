"use client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { roundMoney } from "@/lib/financialMath";
import { paymentSubmissionPreview } from "@/lib/paymentSubmissionPreview";

type Followup = { id: string; receipt_id: string | null; kind: string; amount: number; due_date: string; note: string; status: string; receipt_status: string | null };
type Obligation = { bill_id: string; admission_id: string; resident: string; purpose: string; billing_month: string;
  original: number; verified: number; pending: number; remaining: number; available: number;
  followups: Followup[]; pending_receipts: { id: string; amount: number }[] };
const money = (value: number) => `Rs ${Number(value).toLocaleString("en-PK")}`;
const input = "block w-full rounded-lg border p-2 text-sm";

export default function PaymentFollowups({ staff = false, tasks = false, onSubmitted, additionalPaymentForm, onSelectAdditional }: {
  staff?: boolean; tasks?: boolean; onSubmitted?: () => Promise<void>; additionalPaymentForm?: ReactNode; onSelectAdditional?: () => void;
}) {
  const [residentPurpose,setResidentPurpose]=useState("");
  const [rows, setRows] = useState<Obligation[]>([]), [error, setError] = useState("");
  const [amounts, setAmounts] = useState<Record<string,string>>({});
  const [date, setDate] = useState(""), [reason, setReason] = useState(""), [ack, setAck] = useState(false);
  const [method, setMethod] = useState(""), [reference, setReference] = useState("");
  const [file, setFile] = useState<File | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [requestBill, setRequestBill] = useState(""), [requestAmount, setRequestAmount] = useState("");
  const [replace, setReplace] = useState("");
  const [against,setAgainst]=useState("current"), [historyPurpose,setHistoryPurpose]=useState("Previous Rent"), [historyDate,setHistoryDate]=useState("");
  const [evidenceAmount,setEvidenceAmount]=useState("");
  const [formVersion,setFormVersion]=useState(0);
  const load = useCallback(async () => {
    const result = await supabase.rpc("payment_followup_data");
    if (result.error) { setError(result.error.message); setRows([]); return; }
    setRows(result.data || []);
  }, []);
  useEffect(() => { void load(); const timer = setInterval(() => void load(),60000);
    window.addEventListener("focus",load); return () => { clearInterval(timer); window.removeEventListener("focus",load); };
  }, [load]);
  const selected = rows.filter(r => Number(amounts[r.bill_id]) > 0);
  const preview = (r:Obligation) => paymentSubmissionPreview(Number(r.remaining),Number(r.pending),Number(amounts[r.bill_id]));
  const partial = selected.some(r => preview(r).requiresCommitment);
  const total = roundMoney(selected.reduce((sum,r) => sum + Number(amounts[r.bill_id]),0));
  const request = rows.find(r => r.bill_id === requestBill);
  const payable = rows.filter(r=>Number(r.remaining)>0);
  const rents = payable.filter(r=>r.purpose==='Rent');
  const deposits = payable.filter(r=>r.purpose==='Security Deposit');
  const month = (value:string) => /^\d{4}-\d{2}$/.test(value) ? new Date(value+'-01T12:00:00Z').toLocaleDateString('en-PK',{month:'long',year:'numeric',timeZone:'Asia/Karachi'}) : value;
  function choosePurpose(value:string, billId?:string) {
    setResidentPurpose(value);setAgainst(value==='historical'?'historical':value==='other'?'other':'current');
    setAck(false);setError('');setMessage('');
    const selectedRentId=value.startsWith('rent:')?value.slice(5):value.startsWith('combined:')?value.split(':')[1]:billId;
    const rent=rents.find(r=>r.bill_id===selectedRentId);
    const deposit=value.startsWith('combined:')?deposits.find(r=>r.bill_id===value.split(':')[2]&&r.admission_id===rent?.admission_id):deposits.find(r=>r.bill_id===billId)||deposits.find(r=>Number(r.available)>0)||deposits[0];
    const chosen=value==='rent'||value.startsWith('rent:')?[rent]:value==='deposit'?[deposit]:value==='combined'||value.startsWith('combined:')?(rent&&deposit?[rent,deposit]:[]):value.startsWith('bill:')?[rows.find(r=>r.bill_id===value.slice(5))]:[];
    setAmounts(Object.fromEntries(chosen.filter((r):r is Obligation=>!!r).map(r=>[r.bill_id,Number(r.available)>0?String(r.available):''])));
    if(value==='additional')onSelectAdditional?.();
  }
  useEffect(()=>{
    if(staff || tasks)return;
    const select=(event:Event)=>{
      const id=(event as CustomEvent<string>).detail;const row=rows.find(r=>r.bill_id===id);
      if(row) { choosePurpose(row.purpose==='Rent'?'rent:'+id:row.purpose==='Security Deposit'?'deposit':'bill:'+id,id);document.getElementById('make-payment')?.scrollIntoView({behavior:'smooth',block:'start'}); }
    };
    window.addEventListener('select-payment-obligation',select);
    return()=>window.removeEventListener('select-payment-obligation',select);
  },[rows,staff,tasks]);
  async function submit() {
    setError(""); setMessage("");
    if (!file || !method || (against==="current" && (!selected.length || selected.length>2 || new Set(selected.map(r=>r.admission_id)).size!==1))) { setError("Select one obligation or Rent + Deposit from the same admission, a method and receipt."); return; }
    if (against==='current' && (residentPurpose.startsWith('combined:')
      ? selected.length!==2 || !residentPurpose.split(':').slice(1).every(id=>selected.some(r=>r.bill_id===id))
      : residentPurpose.startsWith('rent:') && (selected.length!==1 || selected[0].bill_id!==residentPurpose.slice(5)))) { setError("The selected obligations changed. Select the exact Rent month again."); return; }
    if (against==="current" && selected.some(r => Number(amounts[r.bill_id])>Number(r.available))) { setError("Submitted amount exceeds available balance. Review pending receipts."); return; }
    if (against==="current" && selected.length===2 && !["Rent","Security Deposit"].every(p=>selected.some(r=>r.purpose===p))) { setError("Combine Rent with Security Deposit, or submit another obligation separately."); return; }
    if (against==="current" && partial && (!ack || !date || !reason.trim())) { setError("Acknowledge the remainder and enter a future commitment date and reason."); return; }
    if (against!=="current" && (!reason.trim() || Number(evidenceAmount)<=0)) { setError("Amount and Description / Notes are required."); return; }
    setBusy(true);
    try {
      const {data} = await supabase.auth.getSession(); if (!data.session) throw new Error("Please sign in again.");
      const body = new FormData(); body.set("admissionId",selected[0]?.admission_id || rows[0]?.admission_id || "");
      if(against==="current")body.set("obligationItems",JSON.stringify(selected.map(r=>({bill_id:r.bill_id,amount:Number(amounts[r.bill_id]),purpose:r.purpose,billing_month:r.billing_month}))));
      else if(against==="historical") {body.set("historical","true");body.set("historicalPurpose",historyPurpose);body.set("historicalDate",historyDate);}
      else {body.set("additionalAmount",evidenceAmount);body.set("additionalCategory","Other");body.set("additionalDescription",reason);}
      body.set("notes",reason);body.set("amount",against==="current" ? String(total) : evidenceAmount); body.set("paymentMethod",method); body.set("referenceNumber",reference);
      body.set("commitmentDate",date); body.set("commitmentReason",reason); body.set("acknowledged",String(ack)); body.set("file",file);
      const response = await fetch("/api/resident-portal/combined-payment",{method:"POST",headers:{Authorization:`Bearer ${data.session.access_token}`},body});
      const result=await response.json(); if(!response.ok)throw new Error(result.error);
      setMessage(against==='historical'?'Your previous payment receipt has been submitted for review.':'Your receipt has been submitted for verification.');
      setResidentPurpose('');setAgainst('current');setAmounts({});setMethod('');setReference('');setFile(null);
      setReason('');setDate('');setAck(false);setHistoryPurpose('Previous Rent');setHistoryDate('');setEvidenceAmount('');
      setFormVersion(version=>version+1);await load();await onSubmitted?.();
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
  if (!staff && !tasks) {
    const chosen=rows.filter(r=>Object.prototype.hasOwnProperty.call(amounts,r.bill_id));
    const remainder=roundMoney(selected.reduce((sum,r)=>sum+preview(r).projectedAvailableRemainder,0));
    return <div className="space-y-5">
      <section id="make-payment" className="scroll-mt-6 rounded-3xl border border-indigo-100 bg-white p-5 shadow-sm sm:p-7">
        <div className="mb-6"><p className="text-xs font-semibold uppercase tracking-widest text-indigo-600">Payments &amp; Receipts</p><h2 className="mt-2 text-2xl font-bold text-slate-900">Make a Payment</h2><p className="mt-2 text-sm text-slate-500">Select what you&apos;re paying for and upload your payment receipt.</p></div>
        {error && <p role="alert" className="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        {message && <p role="status" className="mb-4 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-700">{message}</p>}
        <label className="block text-sm font-semibold text-slate-700">What are you paying for?<select className={input+' mt-2 rounded-xl py-3'} value={residentPurpose} disabled={busy} onChange={e=>choosePurpose(e.target.value)}>
          <option value="">Select a payment</option>
          {rents.map(r=><option key={'rent:'+r.bill_id} value={'rent:'+r.bill_id} disabled={Number(r.available)<=0}>Rent — {month(r.billing_month)} — {money(r.available)}{Number(r.available)<=0?' — Pending Verification':''}</option>)}{!!deposits.length && <option value="deposit">Security Deposit — {money(deposits[0].available)}</option>}
          {rents.filter(r=>Number(r.available)>0).map(r=>{const d=deposits.find(d=>d.admission_id===r.admission_id&&Number(d.available)>0);return d?<option key={'combined:'+r.bill_id} value={'combined:'+r.bill_id+':'+d.bill_id}>Rent — {month(r.billing_month)} + Security Deposit — {money(Number(r.available)+Number(d.available))}</option>:null;})}
          <option value="other">Other Charges</option><option value="historical">Previous Payment Receipt</option>
          {payable.filter(r=>!['Rent','Security Deposit'].includes(r.purpose)).map(r=><option value={'bill:'+r.bill_id} key={r.bill_id}>{r.purpose} / {month(r.billing_month)}</option>)}
          {additionalPaymentForm && <option value="additional">Include Other Charges</option>}
        </select></label>
        {residentPurpose==='additional' ? additionalPaymentForm : residentPurpose && <form key={formVersion} className="mt-5 space-y-5" onSubmit={e=>{e.preventDefault();void submit();}}>
          <fieldset disabled={busy} className="space-y-5">
            {against==='current' && <>
              <div className="grid gap-3 sm:grid-cols-2">{chosen.map(r=><div key={r.bill_id} className="min-w-0 rounded-2xl bg-indigo-50/60 p-4"><h3 className="font-semibold text-slate-900">{r.purpose}{r.purpose==='Rent'?' / '+month(r.billing_month):''}</h3><p className="mt-1 text-sm text-slate-600">{Number(r.pending)>0?'Financial balance:':'Amount due:'} <strong>{money(r.remaining)}</strong></p>{Number(r.pending)>0 && <div className="mt-1 space-y-1 text-xs text-amber-800"><p>Awaiting verification: {money(r.pending)}</p><p>Available to pay now: {money(preview(r).available)}</p><p>Your financial balance changes only after verification.</p><p>Amount still available to pay after this submission: {money(preview(r).projectedAvailableRemainder)}</p></div>}
                {Number(r.available)>0 ? <label className="mt-4 block text-sm font-medium">Amount you are paying<input required className={input+' mt-2 rounded-xl bg-white py-3'} type="number" min="0.01" step="0.01" max={r.available} value={amounts[r.bill_id]||''} onChange={e=>setAmounts(a=>({...a,[r.bill_id]:e.target.value}))}/></label>:<p className="mt-3 text-sm">Your receipt is awaiting review. No further payment is needed right now.</p>}
              </div>)}</div>
              <div className="flex justify-between gap-3 text-lg font-bold text-slate-900"><span>Total Payment</span><span>{money(total)}</span></div>
              {partial && <div className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50/60 p-4"><h3 className="font-semibold text-amber-950">Amount still available to pay after this submission: {money(remainder)}</h3>
                {selected.filter(r=>preview(r).requiresCommitment).map(r=><p key={r.bill_id} className="text-sm">{r.purpose}: {money(preview(r).projectedAvailableRemainder)} remaining</p>)}
                <label className="block text-sm font-medium">When will you pay the remaining amount?<input required type="date" className={input+' mt-2 bg-white'} value={date} onChange={e=>setDate(e.target.value)}/></label>
                <label className="block text-sm font-medium">Reason / note<textarea required rows={2} className={input+' mt-2 bg-white'} value={reason} onChange={e=>setReason(e.target.value)}/></label>
                <label className="flex items-start gap-2 text-sm"><input required type="checkbox" className="mt-1" checked={ack} onChange={e=>setAck(e.target.checked)}/>I understand that {money(remainder)} will still be available to pay.</label>
              </div>}
            </>}
            {against==='historical' && <><p className="text-sm text-slate-500">Use this option to submit a receipt for a payment made before your current portal payment record.</p><label className="block text-sm font-medium">Previous payment was for<select className={input+' mt-2'} value={historyPurpose} onChange={e=>setHistoryPurpose(e.target.value)}>{['Previous Rent','Previous Security Deposit','Previous Rent + Security Deposit','Other Charges'].map(p=><option key={p}>{p}</option>)}</select></label><label className="block text-sm font-medium">Payment Date<input required type="date" className={input+' mt-2'} value={historyDate} onChange={e=>setHistoryDate(e.target.value)}/></label></>}
            {against!=='current' && <div className="grid gap-4 sm:grid-cols-2"><label className="block text-sm font-medium sm:col-span-2">{against==='other'?'What is this payment for? *':'Notes / Description *'}<textarea required rows={2} className={input+' mt-2'} value={reason} onChange={e=>setReason(e.target.value)}/></label><label className="block text-sm font-medium">Amount *<input required className={input+' mt-2'} type="number" min="0.01" step="0.01" value={evidenceAmount} onChange={e=>setEvidenceAmount(e.target.value)}/></label></div>}
            <div className="border-t border-slate-100 pt-5"><h3 className="mb-4 font-semibold text-slate-900">Payment Details</h3><div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm font-medium">Payment Method *<select required className={input+' mt-2'} value={method} onChange={e=>setMethod(e.target.value)}><option value="">Select method</option>{['Cash Deposit','Bank Transfer','Card / Online Payment','Other'].map(m=><option key={m}>{m}</option>)}</select></label>
              <label className="block text-sm font-medium">Reference Number<input className={input+' mt-2'} value={reference} onChange={e=>setReference(e.target.value)}/></label>
              <label className="block min-w-0 text-sm font-medium sm:col-span-2">Upload Payment Receipt *<input required className={input+' mt-2 bg-slate-50 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-100 file:px-3 file:py-2 file:text-indigo-700'} type="file" accept="application/pdf,image/jpeg,image/png" onChange={e=>setFile(e.target.files?.[0]||null)}/><span className="mt-2 block text-xs font-normal text-slate-500">PDF, JPEG or PNG / maximum 5 MB</span></label>
            </div></div>
            <button disabled={busy || (against==='current' && (!selected.length || chosen.some(r=>Number(r.available)<=0)))} className="w-full rounded-xl bg-indigo-600 px-5 py-3 font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-50 sm:w-auto" type="submit">{busy?'Submitting...':'Submit for Verification'}</button>
          </fieldset>
        </form>}
        <p className="mt-4 text-xs text-slate-500">For late fees and your full bill details, visit <Link href="/resident-portal/bills" className="font-semibold text-indigo-700 underline">My Bills</Link>.</p>
      </section>
      {payable.some(r=>r.followups.some(f=>f.status!=='Resolved')) && <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="text-lg font-bold text-slate-900">Payment Requests &amp; Plans</h2><div className="mt-3 space-y-3">{payable.map(r=>r.followups.filter(f=>f.status!=='Resolved').map(f=><article key={f.id} className="rounded-xl border border-slate-100 p-4"><div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{f.kind==='request'?'Payment Requested':'Your payment plan'} / {r.purpose}</h3><span className="text-xs font-medium text-amber-700">{f.status}</span></div><p className="mt-1 text-sm">{money(f.amount)} / Due {f.due_date}</p><p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-600">{f.note}</p><button type="button" className="mt-3 text-sm font-semibold text-indigo-700" onClick={()=>{choosePurpose(r.purpose==='Rent'?'rent:'+r.bill_id:r.purpose==='Security Deposit'?'deposit':'bill:'+r.bill_id,r.bill_id);document.getElementById('make-payment')?.scrollIntoView({behavior:'smooth'});}}>Make this payment</button></article>))}</div></section>}
    </div>;
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
