"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  documentLabel,
  documentSlotsForIdentityType,
  portalDocumentSlots,
  profileDocumentError,
  type DocumentSlot,
} from "@/lib/profileDocuments";
import { compressProfileImage } from "@/lib/compressProfileImage";

export type DocumentEntry = {
  slot: DocumentSlot;
  recorded: boolean;
  needsReview: boolean;
  editable: boolean;
  url: string | null;
};

function getSlotDisplayTitle(slot: DocumentSlot, residentType = "CNIC", guardianType = "CNIC") {
  if (slot === "photo") return "Resident Profile Photo";
  if (slot === "resident_front") {
    return residentType === "Passport" ? "Resident Passport Identity Page" : "Resident CNIC (Front + Back)";
  }
  if (slot === "guardian_front") {
    return guardianType === "Passport" ? "Guardian Passport Identity Page" : "Guardian CNIC (Front + Back)";
  }
  return documentLabel(slot, residentType, guardianType);
}

function getSlotHint(slot: DocumentSlot, residentType = "CNIC", guardianType = "CNIC") {
  if (slot === "photo") {
    return "Recent passport-style photo with clear face visibility • JPEG, PNG, WebP • Max 400 KB";
  }
  if (slot === "resident_front") {
    return residentType === "Passport"
      ? "Passport identity page showing full name & photo • JPEG, PNG, WebP, PDF • Max 400 KB"
      : "Single image or PDF with BOTH Front & Back of CNIC clearly visible • Max 400 KB";
  }
  if (slot === "guardian_front") {
    return guardianType === "Passport"
      ? "Passport identity page showing full name & photo • JPEG, PNG, WebP, PDF • Max 400 KB"
      : "Single image or PDF with BOTH Front & Back of CNIC clearly visible • Max 400 KB";
  }
  return "Document file • Max 400 KB";
}

function SlotIcon({ slot }: { slot: DocumentSlot }) {
  if (slot === "photo") {
    return (
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 border border-indigo-100 shrink-0">
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.121 17.804A13.937 13.937 0 0112 16c2.5 0 4.847.655 6.879 1.804M15 10a3 3 0 11-6 0 3 3 0 016 0zm6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </div>
    );
  }

  if (slot === "resident_front") {
    return (
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600 border border-blue-100 shrink-0">
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2h-5m-4 0V5a2 2 0 114 0v1m-4 0a2 2 0 104 0m-5 8a2 2 0 100-4 2 2 0 000 4zm0 0c1.306 0 2.417.835 2.83 2M9 14a3.001 3.001 0 00-2.83 2M15 11h3m-3 4h2" />
        </svg>
      </div>
    );
  }

  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-purple-50 text-purple-600 border border-purple-100 shrink-0">
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
      </svg>
    </div>
  );
}

export default function ProfileDocuments({
  residentId,
  residentType = "CNIC",
  guardianType = "CNIC",
  readOnly = false,
  onSaved,
  onBusyChange,
  onDocumentsLoaded,
  slots = portalDocumentSlots,
}: {
  residentId?: string;
  residentType?: string;
  guardianType?: string;
  readOnly?: boolean;
  onSaved?: (slot: DocumentSlot, canonicalValue?: string) => void;
  onBusyChange?: (busy: boolean) => void;
  onDocumentsLoaded?: (documents: DocumentEntry[]) => void;
  slots?: readonly DocumentSlot[];
}) {
  const [documents, setDocuments] = useState<DocumentEntry[]>([]);
  const [busySlot, setBusySlot] = useState<DocumentSlot | null>(null);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ url: string; label: string } | null>(null);

  const request = useCallback(
    async (body?: FormData) => {
      const { data } = await supabase.auth.getSession();
      if (!data.session) throw new Error("Please sign in to access documents.");
      const response = await fetch(
        `/api/resident-portal/profile/documents${residentId ? `?residentId=${encodeURIComponent(residentId)}` : ""}`,
        {
          method: body ? "POST" : "GET",
          body,
          cache: "no-store",
          headers: { Authorization: `Bearer ${data.session.access_token}` },
        },
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to access documents.");
      return result;
    },
    [residentId],
  );

  const load = useCallback(async () => {
    const result = await request();
    setDocuments(result.documents);
    onDocumentsLoaded?.(result.documents);
    return result.documents as DocumentEntry[];
  }, [request, onDocumentsLoaded]);

  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);

  async function upload(slot: DocumentSlot, file?: File) {
    if (!file) return;

    if (file.size > 400 * 1024 && file.type === "application/pdf") {
      setError("PDF document exceeds 400 KB limit. Please select a PDF file of 400 KB or smaller.");
      return;
    }

    setBusySlot(slot);
    onBusyChange?.(true);
    setError("");
    setPreview(null);

    try {
      const prepared = await compressProfileImage(file, slot);
      const outputError = profileDocumentError(slot, prepared.type, prepared.size);
      if (outputError) throw new Error(outputError);

      const body = new FormData();
      body.set("slot", slot);
      body.set("file", prepared);

      const result = await request(body);
      onSaved?.(slot, result.canonicalValue);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setBusySlot(null);
      onBusyChange?.(false);
    }
  }

  async function view(slot: DocumentSlot) {
    setError("");
    try {
      const entry = (await load()).find((doc) => doc.slot === slot);
      if (!entry?.url) throw new Error("This existing document needs staff review; it has not been changed.");
      setPreview({ url: entry.url, label: getSlotDisplayTitle(slot, residentType, guardianType) });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to view document.");
    }
  }

  // Filter slots using documentSlotsForIdentityType while maintaining single-document front requirement
  const renderedSlots = documentSlotsForIdentityType(slots, residentType, guardianType).filter(
    (slot) => slot !== "resident_back" && slot !== "guardian_back",
  );

  return (
    <div className="space-y-4">
      {/* Informative Requirements Card */}
      <div className="rounded-2xl border border-indigo-100 bg-linear-to-r from-indigo-50/70 to-blue-50/40 p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-indigo-600/10 p-2 text-indigo-600 shrink-0 mt-0.5">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div className="space-y-1.5 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-bold text-slate-900">
                Identity Document & Photo Requirements
              </h4>
              <span className="inline-flex rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-bold text-indigo-800">
                Max 400 KB per file
              </span>
              <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800">
                Single Document (Front + Back)
              </span>
            </div>
            <div className="space-y-1 text-xs sm:text-sm text-slate-600 leading-relaxed">
              <p>
                <strong>Resident:</strong>{" "}
                {residentType === "Passport"
                  ? "Passport identity page only; no back required."
                  : "CNIC front + back in a single document required."}
              </p>
              <p>
                <strong>Guardian:</strong>{" "}
                {guardianType === "Passport"
                  ? "Passport identity page only; no back required."
                  : "CNIC front + back in a single document required."}
              </p>
              <p className="text-xs text-slate-500 pt-0.5">
                Private uploads, up to 400 KB each. Photos: JPEG, PNG or WebP. Identity documents also accept PDF. Single document for front + back. Uploads are saved immediately; final submission locks resident changes.
              </p>
              <div className="mt-2 flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 border border-emerald-200">
                <svg className="h-4 w-4 shrink-0 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span>Documents are uploaded and saved automatically upon selection. You do not need to confirm final submission just to save a document.</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-3.5 text-xs sm:text-sm font-medium text-red-700">
          <svg className="h-4 w-4 shrink-0 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError("")} className="text-red-400 hover:text-red-600 text-xs">✕</button>
        </div>
      )}

      {/* Modern Upload Cards Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {renderedSlots.map((slot) => {
          const entry = documents.find((doc) => doc.slot === slot);
          const isBusy = busySlot === slot;
          const title = getSlotDisplayTitle(slot, residentType, guardianType);
          const hint = getSlotHint(slot, residentType, guardianType);
          const isRecorded = Boolean(entry?.recorded);
          const isReview = Boolean(entry?.needsReview);
          const isEditable = !readOnly && Boolean(entry?.editable);

          return (
            <div
              key={slot}
              className={`relative flex flex-col justify-between rounded-2xl border p-4 sm:p-5 transition-all duration-200 bg-white shadow-2xs ${
                isRecorded
                  ? "border-emerald-200/90 bg-linear-to-b from-emerald-50/20 to-white"
                  : "border-slate-200/90 hover:border-slate-300"
              }`}
            >
              <div>
                {/* Header row with icon & status badge */}
                <div className="flex items-start justify-between gap-3">
                  <SlotIcon slot={slot} />
                  {isRecorded ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800 border border-emerald-200">
                      <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                      </svg>
                      {isReview ? "Recorded (Review)" : "Recorded"}
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
                      Required
                    </span>
                  )}
                </div>

                {/* Title & guidance */}
                <div className="mt-3.5 space-y-1">
                  <h4 className="text-sm font-bold text-slate-900 leading-snug">
                    {title}
                  </h4>
                  <p className="text-xs text-slate-500 leading-relaxed">
                    {hint}
                  </p>
                </div>
              </div>

              {/* Bottom Actions Area */}
              <div className="mt-5 pt-3.5 border-t border-slate-100 space-y-2">
                {isBusy ? (
                  <div className="flex items-center justify-center gap-2 rounded-xl bg-indigo-50 py-3 text-xs font-semibold text-indigo-700">
                    <svg className="h-4 w-4 animate-spin text-indigo-600" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    <span>Compressing &amp; uploading...</span>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      {isRecorded && (
                        <button
                          type="button"
                          onClick={() => void view(slot)}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-indigo-200 bg-indigo-50/80 px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 transition-colors"
                        >
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                          </svg>
                          View document
                        </button>
                      )}

                      {isEditable && (
                        <label className={`inline-flex items-center gap-1.5 cursor-pointer rounded-xl border px-3 py-1.5 text-xs font-semibold transition-colors ${
                          isRecorded
                            ? "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                            : "w-full justify-center border-indigo-600 bg-indigo-600 text-white hover:bg-indigo-700 shadow-2xs py-2.5"
                        }`}>
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                          </svg>
                          <span>{isRecorded ? "Replace upload" : "Upload Document"}</span>
                          <input
                            aria-label={title}
                            type="file"
                            disabled={Boolean(busySlot)}
                            accept={
                              slot === "photo"
                                ? "image/jpeg,image/png,image/webp"
                                : "image/jpeg,image/png,image/webp,application/pdf"
                            }
                            className="sr-only"
                            onChange={(e) => {
                              void upload(slot, e.target.files?.[0]);
                              e.target.value = "";
                            }}
                          />
                        </label>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Document Preview Lightbox */}
      {preview && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 shadow-lg">
          <div className="flex items-center justify-between gap-3 pb-3 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <h4 className="text-sm font-bold text-slate-900">{preview.label}</h4>
            </div>
            <div className="flex items-center gap-2">
              <a
                href={preview.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-semibold text-indigo-600 hover:underline inline-flex items-center gap-1"
              >
                Open in new tab
                <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50 transition-colors"
                onClick={() => setPreview(null)}
              >
                Close preview
              </button>
            </div>
          </div>
          <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
            <iframe
              title={preview.label}
              src={preview.url}
              sandbox="allow-scripts allow-same-origin"
              referrerPolicy="no-referrer"
              className="h-96 w-full"
            />
          </div>
          <p className="mt-2 text-[11px] text-slate-400">
            Secure temporary preview link. If it expires, click View document again.
          </p>
        </div>
      )}
    </div>
  );
}
