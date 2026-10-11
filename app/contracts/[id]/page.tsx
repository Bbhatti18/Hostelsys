"use client";

import { reviewContractSignature } from "@/lib/contractActions";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { getLatestContractAgreement } from "@/lib/contractStorage";
import { getSupabaseErrorMessage } from "@/lib/supabaseErrors";

type Contract = {
  id: string;
  contract_number: string | null;
  resident_id: string;
  admission_id: string | null;
  start_date: string;
  end_date: string | null;
  monthly_rent: number;
  security_deposit: number;
  status: string | null;
  resident_signature_url: string | null;
  resident_signature_status: string | null;
  signed_at: string | null;
  owner_signature_status: string | null;
  notes: string | null;
  residents: { full_name: string } | null;
};

function money(value: number) {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(value || 0);
}

export default function ViewContractPage() {
  const params = useParams();
  const contractId = String(params.id ?? "");
  const [contract, setContract] = useState<Contract | null>(null);
  const [agreementUrl, setAgreementUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reviewing, setReviewing] = useState(false);
  const [signatureDisplayUrl, setSignatureDisplayUrl] = useState("");
  const [message, setMessage] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    if (!contractId) return;
    let active = true;

    async function fetchContract() {
      setLoading(true);
      setMessage("");

      const { data, error } = await supabase
        .from("contracts")
        .select(`
          id,
          contract_number,
          resident_id,
          admission_id,
          start_date,
          end_date,
          monthly_rent,
          security_deposit,
          status,
          resident_signature_url,
          resident_signature_status,
          signed_at,
          owner_signature_status,
          notes,
          residents (full_name)
        `)
        .eq("id", contractId)
        .maybeSingle();

      if (!active) return;

      if (error || !data) {
        setMessage(
          getSupabaseErrorMessage(error, "Unable to load this contract."),
        );
        setContract(null);
        setLoading(false);
        return;
      }

      setContract(data as unknown as Contract);

      try {
        setAgreementUrl(await getLatestContractAgreement(contractId));
      } catch (agreementError) {
        setMessage(
          agreementError instanceof Error
            ? agreementError.message
            : "Unable to load the contract agreement.",
        );
      }

      if (active) setLoading(false);
    }

    void fetchContract();
    return () => {
      active = false;
    };
  }, [contractId]);

  async function reviewSignature(
    action: "Approved" | "Rejected" | "Re-sign Required",
  ) {
    if (!contract || reviewing) return;
    setReviewing(true);
    setActionMessage("");
    setActionError("");

    try {
      const { data: current, error: currentError } = await supabase
        .from("contracts")
        .select(
          "id, resident_signature_url, resident_signature_status, signed_by_resident, signed_at, status",
        )
        .eq("id", contract.id)
        .maybeSingle();

      if (currentError || !current) {
        throw new Error("The contract signature could not be re-checked. Refresh and try again.");
      }
      if ((current.status) !== "Pending Signature") {
        throw new Error("Only a Pending Signature contract can be reviewed.");
      }

      const currentStatus = current.resident_signature_status || "Pending";
      const hasStoredSignature = Boolean(
        (current.resident_signature_url) &&
          current.signed_by_resident &&
          current.signed_at,
      );

      if (action === "Approved") {
        if (!["Submitted", "Signed"].includes(currentStatus) || !hasStoredSignature) {
          throw new Error("Only a complete submitted signature can be approved.");
        }
      } else if (action === "Rejected") {
        if (!["Submitted", "Signed"].includes(currentStatus)) {
          throw new Error("Only a submitted signature can be rejected.");
        }
      } else if (!["Submitted", "Signed", "Rejected"].includes(currentStatus)) {
        throw new Error("A re-sign can only be requested for a submitted or rejected signature.");
      }

      const updated = await reviewContractSignature(contract.id, action);

      setContract((existing) =>
        existing
          ? { ...existing, resident_signature_status: updated.resident_signature_status }
          : existing,
      );
      setActionMessage(
        action === "Approved"
          ? "Resident signature approved. Admission activation still requires a verified deposit."
          : action === "Rejected"
            ? "Resident signature rejected."
            : "The resident may now submit a replacement signature.",
      );
    } catch (reviewError) {
      setActionError(
        reviewError instanceof Error
          ? reviewError.message
          : "Unable to review the resident signature.",
      );
    } finally {
      setReviewing(false);
    }
  }

  const signatureUrl = contract?.resident_signature_url ?? null;

  useEffect(() => {
    let active = true;

    async function loadSignatureUrl() {
      if (!signatureUrl) {
        if (active) setSignatureDisplayUrl("");
        return;
      }

      if (/^https?:\/\//i.test(signatureUrl)) {
        if (active) setSignatureDisplayUrl(signatureUrl);
        return;
      }

      const { data, error } = await supabase.storage
        .from("contract-signature")
        .createSignedUrl(signatureUrl, 60 * 5);

      if (active) {
        setSignatureDisplayUrl(error || !data?.signedUrl ? "" : data.signedUrl);
      }
    }

    void loadSignatureUrl();
    return () => {
      active = false;
    };
  }, [signatureUrl]);

  if (loading) {
    return <div className="p-6 text-gray-600">Loading contract...</div>;
  }

  if (!contract) {
    return (
      <div className="p-6">
        <p className="mb-4 text-red-600">{message || "Contract not found."}</p>
        <Link href="/contracts" className="rounded-lg bg-gray-200 px-4 py-2 text-gray-700">Back to Contracts</Link>
      </div>
    );
  }
  const displayedStatus = contract.status ?? "Draft";

  return (
    <div className="min-h-screen bg-gray-50 p-4 sm:p-6">
      <div className="mx-auto max-w-4xl rounded-xl bg-white p-4 shadow sm:p-6">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">University Girls Hostel</p>
            <h1 className="mt-2 text-2xl font-bold text-gray-800">Contract Details</h1>
            <p className="mt-1 text-sm text-gray-500">{contract.contract_number || `Contract ${contract.id}`}</p>
          </div>
          <Link href={`/contracts/edit/${contract.id}`} className="rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-700">Edit Contract</Link>
        </div>

        {message && <div className="mb-5 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{message}</div>}
        {(actionMessage || actionError) && (
          <div className={`mb-5 rounded-lg p-3 text-sm ${actionError ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>
            {actionError || actionMessage}
          </div>
        )}

        <div className="grid gap-5 md:grid-cols-2">
          <Info label="Resident" value={contract.residents?.full_name || "Unknown resident"} />
          <Info label="Status" value={displayedStatus} />
          <Info label="Start Date" value={contract.start_date} />
          <Info label="End Date" value={contract.end_date || "Not set"} />
          <Info label="Monthly Rent" value={money(contract.monthly_rent)} />
          <Info label="Security Deposit" value={money(contract.security_deposit)} />
          <Info label="Resident Signature" value={contract.resident_signature_status || "Pending"} />
          <Info label="Submitted Date" value={contract.signed_at ? new Date(contract.signed_at).toLocaleString("en-PK") : "Not submitted"} />
          <Info label="Owner Signature" value={contract.owner_signature_status === "Pending" ? "Signed" : (contract.owner_signature_status || "Signed")} />
        </div>

        <div className="mt-5 rounded-lg border p-4">
          <p className="text-sm text-gray-500">Notes</p>
          <p className="mt-1 whitespace-pre-wrap text-gray-800">{contract.notes || "No notes available."}</p>
        </div>

        <div className="mt-5 rounded-lg border p-4">
          <p className="mb-3 text-sm text-gray-500">Agreement File</p>
          {agreementUrl ? (
            <a href={agreementUrl} target="_blank" rel="noopener noreferrer" className="inline-block rounded-lg bg-green-600 px-4 py-2 text-white hover:bg-green-700">Download Agreement PDF</a>
          ) : (
            <p className="text-gray-600">No agreement file uploaded.</p>
          )}
        </div>

        {signatureUrl && (
          <div className="mt-5 rounded-lg border p-4">
            <p className="mb-3 text-sm text-gray-500">Resident Signature</p>
            {/* Existing signature URLs are preserved and rendered as stored. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {signatureDisplayUrl ? (
              <img src={signatureDisplayUrl} alt="Resident Signature" className="max-w-full rounded border" />
            ) : (
              <p className="text-sm text-amber-700">Loading secure signature preview...</p>
            )}
          </div>
        )}

        {signatureUrl && ["Submitted", "Signed", "Rejected"].includes(contract.resident_signature_status || "") && (
          <div className="mt-5 flex flex-wrap gap-3 rounded-lg border p-4">
            {["Submitted", "Signed"].includes(contract.resident_signature_status || "") && (
              <>
                <button type="button" onClick={() => void reviewSignature("Approved")} disabled={reviewing} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                  {reviewing ? "Saving..." : "Approve Signature"}
                </button>
                <button type="button" onClick={() => void reviewSignature("Rejected")} disabled={reviewing} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
                  Reject Signature
                </button>
              </>
            )}
            <button type="button" onClick={() => void reviewSignature("Re-sign Required")} disabled={reviewing} className="rounded-lg border border-amber-300 px-4 py-2 text-sm font-semibold text-amber-700 disabled:opacity-50">
              Request Re-sign
            </button>
          </div>
        )}

        <div className="mt-6">
          <Link href="/contracts" className="inline-block rounded-lg bg-gray-200 px-5 py-2 text-gray-700 hover:bg-gray-300">Back to Contracts</Link>
        </div>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-4">
      <p className="text-sm text-gray-500">{label}</p>
      <p className="mt-1 font-semibold text-gray-800">{value}</p>
    </div>
  );
}
