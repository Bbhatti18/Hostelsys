"use client";
import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { readDashboardRows } from "@/lib/dashboardRead";

/** Lazy read only. Financial balances never come from these historical records. */
export default function PaymentAuditDetails({ paymentIds }: { paymentIds: string[] }) {
  const [history, setHistory] = useState<Record<string, unknown>[] | null>(null), [error, setError] = useState("");
  return <details className="mt-2 text-xs" onToggle={async e => {
    if (!e.currentTarget.open || history || !paymentIds.length) return;
    const result = await readDashboardRows(supabase.from("payment_status_history").select("id,payment_id,previous_status,next_status,actor,reason,created_at").in("payment_id", paymentIds).order("created_at").order("id"));
    if (result.error) setError(result.error.message); else setHistory(result.data ?? []);
  }}><summary className="cursor-pointer">Payment status audit</summary>
    {error && <p role="alert">{error}</p>}
    {history?.map(h => <p key={String(h.id)}>{String(h.created_at)} / {String(h.previous_status ?? "Created")} → {String(h.next_status)} / {String(h.actor ?? "system")} / {String(h.reason ?? "")}</p>)}
  </details>;
}
