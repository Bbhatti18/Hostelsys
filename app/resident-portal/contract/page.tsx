"use client";

import Link from "next/link";
import {
  ChangeEvent,
  FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import SignatureCanvas from "react-signature-canvas";
import { normalizeBedLabel } from "@/lib/bedLabels";
import ContractTermsViewer from "@/components/contract/ContractTermsViewer";
import {
  getLatestContractAgreement,
  uploadResidentSignature,
} from "@/lib/contractStorage";
import { getContractTerms, hasResidentSignature } from "@/lib/contractWorkflow";
import { resolveAuthenticatedResident } from "@/lib/residentPortalAuth";
import { loadResidentPortalData } from "@/lib/residentPortalData";
import { supabase } from "@/lib/supabase";
import { getSupabaseErrorMessage } from "@/lib/supabaseErrors";

type Contract = {
  id: string;
  contract_number: string;
  resident_id: string;
  admission_id: string | null;
  template_id: number | null;
  contract_content: string | null;
  start_date: string;
  end_date: string | null;
  monthly_rent: number | null;
  security_deposit: number | null;
  notice_period_days: number;
  status: string | null;
  resident_signature_url: string | null;
  resident_signature_status: string | null;
  owner_signature_status: string | null;
  signed_by_resident: boolean | null;
  signed_at: string | null;
};

type Admission = {
  id: string;
  resident_id: string;
  room_id: string | null;
  bed_id: string | null;
  admission_date: string;
  monthly_rent: number;
  security_deposit: number;
  status: string;
};

type PortalContract = {
  contract: Contract;
  admission: Admission;
  residentName: string;
  roomNumber: string;
  bedNumber: string;
  agreementUrl: string | null;
};

const signatureUploadTypes = new Set(["image/png", "image/jpeg"]);
const maxSignatureBytes = 5 * 1024 * 1024;

function money(value: number) {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(value || 0);
}

export default function ResidentContractPage() {
  const signatureRef = useRef<SignatureCanvas | null>(null);
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const [canvasWidth, setCanvasWidth] = useState(600);
  const [data, setData] = useState<PortalContract | null>(null);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [signatureFile, setSignatureFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    const container = canvasContainerRef.current;
    if (!container) return;

    const updateSize = () => {
      const nextWidth = Math.max(Math.floor(container.clientWidth), 260);
      setCanvasWidth((prev) => (prev !== nextWidth ? nextWidth : prev));
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(container);
    window.addEventListener("resize", updateSize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateSize);
    };
  }, [data, loading]);

  const loadContract = useCallback(async () => {
    setLoading(true);
    setError("");

    const auth = await resolveAuthenticatedResident();
    if (!auth.resident) {
      setData(null);
      setError(auth.error || "Your resident account could not be verified.");
      setLoading(false);
      return;
    }

    const portalResult = await loadResidentPortalData();
    if (!portalResult.data || portalResult.data.resident.id !== auth.resident.id) {
      setData(null);
      setError(portalResult.error || "Your resident account could not be verified.");
      setLoading(false);
      return;
    }

    const admission = portalResult.data.admission as Admission | null;
    if (!admission) {
      setData(null);
      setError("No current admission is available for your resident account.");
      setLoading(false);
      return;
    }

    const contract = portalResult.data.contract as Contract | null;

    if (!contract) {
      setData(null);
      setError("No contract is currently prepared for your admission.");
      setLoading(false);
      return;
    }

    let agreementUrl: string | null = null;
    try {
      agreementUrl = await getLatestContractAgreement(contract.id);
    } catch {
      // The agreement PDF is optional; the immutable contract terms remain available.
    }

    setData({
      contract,
      admission: admission as Admission,
      residentName: auth.resident.full_name || "Resident",
      roomNumber: String(portalResult.data.room?.room_number || "Not allocated"),
      bedNumber: portalResult.data.bed?.bed_number
        ? normalizeBedLabel(String(portalResult.data.bed.bed_number))
        : "Not allocated",
      agreementUrl,
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    // Loading the authenticated resident contract is the external synchronization.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadContract();
  }, [loadContract]);

  function selectSignatureFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setError("");
    if (!file) {
      setSignatureFile(null);
      return;
    }
    if (!signatureUploadTypes.has(file.type)) {
      setSignatureFile(null);
      event.target.value = "";
      setError("Upload a PNG, JPG, or JPEG signature image.");
      return;
    }
    if (file.size > maxSignatureBytes) {
      setSignatureFile(null);
      event.target.value = "";
      setError("The signature image must be 5 MB or smaller.");
      return;
    }
    setSignatureFile(file);
  }

  async function signContract(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data) return;

    setSaving(true);
    setError("");
    setMessage("");

    try {
      if (!acceptedTerms) throw new Error("Accept the contract terms before signing.");
      const hasDrawnSignature = !signatureRef.current?.isEmpty();
      if (!hasDrawnSignature && !signatureFile) {
        throw new Error("Draw or upload your signature before submitting.");
      }

      const auth = await resolveAuthenticatedResident();
      if (!auth.resident || auth.resident.id !== data.contract.resident_id) {
        throw new Error("Your resident account could not be verified for this contract.");
      }

      const [contractResult, admissionResult] = await Promise.all([
        supabase
          .from("contracts")
          .select(
            "id, resident_id, admission_id, template_id, contract_content, status, resident_signature_url, resident_signature_status, signed_by_resident, signed_at",
          )
          .eq("id", data.contract.id)
          .eq("resident_id", auth.resident.id)
          .maybeSingle(),
        supabase
          .from("admissions")
          .select("id, resident_id, status")
          .eq("id", data.admission.id)
          .eq("resident_id", auth.resident.id)
          .maybeSingle(),
      ]);

      const verificationError = contractResult.error || admissionResult.error;
      if (verificationError) {
        throw new Error(
          getSupabaseErrorMessage(verificationError, "Unable to verify the contract before signing."),
        );
      }

      const current = contractResult.data as Contract | null;
      if (!current || current.admission_id !== data.admission.id) {
        throw new Error("This contract is no longer available for your admission.");
      }
      if (!admissionResult.data || admissionResult.data.status !== "Pending") {
        throw new Error("Only a Pending admission contract can be signed.");
      }
      if (!current.template_id || !getContractTerms(current)) {
        throw new Error("This contract does not contain complete terms. Please contact management.");
      }
      if ((current.status) !== "Pending Signature") {
        throw new Error("This contract is not awaiting a resident signature.");
      }
      const signatureStatus = current.resident_signature_status || "Pending";
      if (!["Pending", "Re-sign Required"].includes(signatureStatus)) {
        throw new Error("This contract has already been signed.");
      }

      let signatureBlob: Blob;
      let signatureFileName = "resident-signature.png";
      if (signatureFile) {
        if (
          !signatureUploadTypes.has(signatureFile.type) ||
          signatureFile.size > maxSignatureBytes
        ) {
          throw new Error("Upload a PNG, JPG, or JPEG signature image no larger than 5 MB.");
        }
        signatureBlob = signatureFile;
        signatureFileName = signatureFile.name;
      } else {
        const dataUrl = signatureRef.current!
          .getTrimmedCanvas()
          .toDataURL("image/png");
        signatureBlob = await fetch(dataUrl).then((response) => response.blob());
      }
      const signatureUrl = await uploadResidentSignature(
        current.id,
        signatureBlob,
        signatureFileName,
      );
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) throw new Error("Please sign in to sign the contract.");

      const response = await fetch("/api/resident-portal/contract/sign", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          contractId: current.id,
          signatureUrl,
        }),
      });

      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.success) {
        throw new Error(result?.error || "Unable to sign this contract. Please try again.");
      }

      setAcceptedTerms(false);
      setSignatureFile(null);
      setMessage("Contract signed successfully! Your resident account and admission are now active.");
      await loadContract();
    } catch (signError) {
      setError(signError instanceof Error ? signError.message : "Unable to sign this contract.");
    } finally {
      setSaving(false);
    }
  }
  if (loading) {
    return <main className="min-h-screen bg-slate-50 p-4 text-slate-600 sm:p-8">Loading your contract...</main>;
  }

  if (!data) {
    return (
      <main className="min-h-screen bg-slate-50 p-4 sm:p-6">
        <div className="mx-auto max-w-3xl rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8">
          <h1 className="text-2xl font-bold text-slate-900">Resident Contract</h1>
          <p className="mt-4 rounded-2xl bg-red-50 p-4 text-sm text-red-700">{error}</p>
          <Link href="/resident-portal" className="mt-6 inline-block text-sm font-semibold text-indigo-700">← Back to portal</Link>
        </div>
      </main>
    );
  }

  const terms = getContractTerms(data.contract);
  const signed = hasResidentSignature(data.contract);
  const signatureStatus = data.contract.resident_signature_status || "Pending";
  const isContractActive = data.contract.status === "Active" || data.admission.status === "Active";
  const canSubmitSignature =
    !isContractActive &&
    data.admission.status === "Pending" &&
    data.contract.status === "Pending Signature" &&
    ["Pending", "Re-sign Required"].includes(signatureStatus);
  const displayStatus = isContractActive
    ? "Active"
    : signed && data.admission.status === "Pending"
    ? "Signed"
    : data.contract.status || "Pending Signature";

  return (
    <main className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">Hostel Management System</p>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">Resident Contract</h1>
            <span className={`rounded-full px-4 py-2 text-xs font-bold sm:text-sm ${
              isContractActive ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
            }`}>
              {displayStatus}
            </span>
          </div>
          <p className="mt-2 text-sm text-slate-500">
            {isContractActive
              ? "Your contract is signed and active. Your resident profile and admission are active."
              : "Signing confirms acceptance of terms and activates your resident account and admission automatically."}
          </p>
          <Link href="/resident-portal" className="mt-4 inline-flex text-sm font-semibold text-indigo-700 hover:underline">
            ← Back to portal
          </Link>
        </section>

        {(message || error) && <div className={`rounded-2xl border p-4 text-sm font-medium ${error ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>{error || message}</div>}

        <section className="grid gap-3 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2 sm:gap-4 sm:p-6 xl:grid-cols-3">
          <InfoCard label="Contract Number" value={data.contract.contract_number} />
          <InfoCard label="Resident" value={data.residentName} />
          <InfoCard label="Room / Bed" value={`${data.roomNumber} / ${data.bedNumber}`} />
          <InfoCard label="Admission Date" value={data.admission.admission_date} />
          <InfoCard label="Start / End" value={`${data.contract.start_date} / ${data.contract.end_date || "Open-ended"}`} />
          <InfoCard label="Monthly Rent" value={money(data.contract.monthly_rent ?? data.admission.monthly_rent)} />
          <InfoCard label="Security Deposit" value={money(data.contract.security_deposit ?? data.admission.security_deposit)} />
          <InfoCard label="Notice Period" value={`${data.contract.notice_period_days || 30} days`} />
          <InfoCard label="Resident Signature" value={signatureStatus === "Signed" ? "Signed" : signatureStatus} />
          <InfoCard label="Owner Signature" value="Signed" />
        </section>

        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 px-1">
            <div>
              <h2 className="text-xl font-bold text-slate-900 sm:text-2xl">Terms & Conditions</h2>
              <p className="text-sm text-slate-500">Please review all hostel accommodation rules, notice policies, and timings.</p>
            </div>
            {data.agreementUrl && (
              <a
                href={data.agreementUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-xl border border-indigo-200 bg-indigo-50 px-3.5 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 transition-colors"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Download Agreement PDF
              </a>
            )}
          </div>

          {terms ? (
            <ContractTermsViewer content={terms} maxHeight="max-h-[600px]" />
          ) : (
            <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
              No immutable contract terms are available. Signing is blocked. Please contact management.
            </div>
          )}
        </section>

        {canSubmitSignature && (
          <form onSubmit={signContract} className="space-y-5 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
            <div>
              <h2 className="text-xl font-bold text-slate-900">Resident Declaration</h2>
              <p className="mt-2 text-sm text-slate-600">Confirm your acceptance and provide either a drawn or uploaded handwritten signature.</p>
            </div>
            <label className="flex items-start gap-3 text-sm text-slate-700">
              <input type="checkbox" checked={acceptedTerms} onChange={(event) => setAcceptedTerms(event.target.checked)} disabled={saving || !terms} className="mt-1 h-4 w-4 shrink-0" />
              <span>I have read and agree to all contract terms and hostel rules.</span>
            </label>
            <div>
              <p className="mb-2 text-sm font-semibold text-slate-700">Draw digital signature</p>
              <div ref={canvasContainerRef} className="overflow-hidden rounded-xl border border-slate-300 bg-white">
                <SignatureCanvas ref={signatureRef} penColor="black" canvasProps={{ width: canvasWidth, height: 200, className: "block h-[200px] w-full touch-none" }} />
              </div>
              <button type="button" onClick={() => signatureRef.current?.clear()} disabled={saving} className="mt-3 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700">Clear</button>
            </div>
            <div className="rounded-2xl border border-slate-200 p-4">
              <p className="text-center text-sm font-bold uppercase tracking-wide text-slate-500">OR</p>
              <label className="mt-3 block">
                <span className="mb-2 block text-sm font-semibold text-slate-700">Upload handwritten signature</span>
                <input type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" onChange={selectSignatureFile} disabled={saving} className="w-full rounded-xl border border-slate-300 p-2 text-sm" />
                <span className="mt-2 block text-xs text-slate-500">PNG, JPG, or JPEG; maximum 5 MB.</span>
              </label>
            </div>
            <button type="submit" disabled={saving || !terms} className="w-full rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto">{saving ? "Submitting Signature & Activating..." : "Sign Contract & Activate"}</button>
          </form>
        )}

        {!canSubmitSignature && isContractActive && (
          <section className="rounded-3xl border border-emerald-200 bg-emerald-50/50 p-5 shadow-sm sm:p-6">
            <h2 className="text-xl font-bold text-emerald-900">Contract Signed & Active</h2>
            <p className="mt-2 text-sm text-emerald-700">Your contract has been signed and your account is active. No owner signature is pending.</p>
          </section>
        )}

        {!canSubmitSignature && signed && !isContractActive && (
          <section className="rounded-3xl border border-amber-200 bg-amber-50 p-5 shadow-sm sm:p-6">
            <h2 className="text-xl font-bold text-amber-900">Signature Recorded</h2>
            <p className="mt-2 text-sm text-amber-700">Your signature is recorded. Click below to activate your account and contract immediately.</p>
            <button
              type="button"
              onClick={async () => {
                setSaving(true);
                setError("");
                setMessage("");
                try {
                  const { data: { session } } = await supabase.auth.getSession();
                  const token = session?.access_token;
                  if (!token) throw new Error("Please sign in to activate.");
                  const res = await fetch("/api/resident-portal/contract/sign", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ contractId: data.contract.id, signatureUrl: data.contract.resident_signature_url || "signed" }),
                  });
                  const resData = await res.json().catch(() => null);
                  if (!res.ok || !resData?.success) throw new Error(resData?.error || "Activation failed.");
                  setMessage("Your account and contract are now active!");
                  await loadContract();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Activation failed.");
                } finally {
                  setSaving(false);
                }
              }}
              disabled={saving}
              className="mt-4 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              {saving ? "Activating..." : "Activate Account Now"}
            </button>
          </section>
        )}
      </div>
    </main>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p><p className="mt-2 font-semibold text-slate-900">{value}</p></article>;
}
