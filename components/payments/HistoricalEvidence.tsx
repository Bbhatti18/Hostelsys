"use client";
import {useCallback,useEffect,useState} from "react";
import {supabase} from "@/lib/supabase";
type Evidence={id:string;purpose:string;payment_date:string;created_at:string;amount:number;payment_method:string;reference_number:string;description:string;status:string;review_note:string;residents:{full_name:string}};
export default function HistoricalEvidence({staff=false}:{staff?:boolean}) {
 const [rows,setRows]=useState<Evidence[]>([]),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 const request=useCallback(async (suffix="",body?:unknown)=>{
   const {data}=await supabase.auth.getSession();if(!data.session)throw new Error("Please sign in.");
   const res=await fetch(`/api/payment-evidence${suffix}`,{method:body?"PATCH":"GET",headers:{Authorization:`Bearer ${data.session.access_token}`,"Content-Type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
   const result=await res.json();if(!res.ok)throw new Error(result.error);return result;
 },[]);
 const load=useCallback(async()=>{try{setRows((await request()).rows);}catch(e){setError(e instanceof Error?e.message:"Unable to load evidence.");}},[request]);
 useEffect(()=>{void load();window.addEventListener("focus",load);window.addEventListener("payment-workflow-changed",load);const timer=setInterval(()=>void load(),60000);return()=>{window.removeEventListener("focus",load);window.removeEventListener("payment-workflow-changed",load);clearInterval(timer);};},[load]);
 async function review(row:Evidence,status:string) {
   const note=window.prompt(`${status} historical evidence only. This will NOT pay current bills. Enter review note:`);if(!note?.trim())return;
   setBusy(true);try{await request("",{id:row.id,status,note});await load();}catch(e){setError(e instanceof Error?e.message:"Review failed.");}finally{setBusy(false);}
 }
 return <section className="my-6 space-y-3 rounded-xl border bg-white p-5 text-slate-900"><h2 className="text-xl font-bold">{staff ? 'Historical Payment Evidence \u2014 Not Collections' : 'Previous Payment Receipts'}</h2>
   <p>{staff ? 'Accepted historical receipts do not settle current Rent, Deposit, Additional Charges or Late Fees.' : 'Review the receipts you submitted for earlier payments.'}</p>{error && <p role="alert">{error}</p>}
   {rows.map(r=><article key={r.id} className="space-y-2 rounded border p-3"><strong>{staff?`${r.residents?.full_name} — `:""}{r.purpose} — {r.status === "Verified" ? (staff ? "Evidence Accepted (Non-ledger)" : "Receipt Accepted") : r.status}</strong>
     <p>{r.payment_date} · Rs {Number(r.amount).toLocaleString("en-PK")} · {r.payment_method} · {r.reference_number || "No reference"}</p><p>{r.description}</p><p>{r.review_note}</p>
     <p>{staff?'Historical payment date:':'Payment date:'} {r.payment_date}. {staff?'Submitted to HMS:':'Submitted:'} {new Date(r.created_at).toLocaleString("en-PK",{timeZone:"Asia/Karachi"})} (Asia/Karachi).</p>
     <button type="button" className="mr-3 underline" onClick={()=>void (async()=>{try{const data=await request(`?id=${encodeURIComponent(r.id)}`);window.open(data.url,"_blank","noopener,noreferrer");}catch(e){setError(e instanceof Error?e.message:"Receipt unavailable.");}})()}>Open Receipt</button>
     {staff && r.status==="Pending" && <><button disabled={busy} type="button" className="mr-3 underline" onClick={()=>void review(r,"Verified")}>Accept Historical Evidence</button><button disabled={busy} type="button" className="underline" onClick={()=>void review(r,"Rejected")}>Reject Evidence</button></>}
   </article>)}
 </section>;
}
