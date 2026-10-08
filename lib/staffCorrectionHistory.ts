import { supabase } from "./supabase";
import type { RentCorrection } from "@/components/payments/RentCorrectionContext";

/** Presentation linkage only. Audit snapshots are never treated as current credit. */
export async function readStaffCorrections() {
  try {
    let session = (await supabase.auth.getSession()).data.session;
    if (!session || (session.expires_at ?? 0) < Date.now() / 1000 + 60) session = (await supabase.auth.refreshSession()).data.session;
    if (!session) throw new Error("Your staff session could not be verified.");
    const response = await fetch("/api/staff-payment-allocation?history=true", { headers: { Authorization: `Bearer ${session.access_token}` }, cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Correction history could not be loaded.");
    return { error: null, data: (result.corrections ?? []) as RentCorrection[] };
  } catch (e) {
    return { error: { message: e instanceof Error ? e.message : "Correction history unavailable." }, data: [] as RentCorrection[] };
  }
}
