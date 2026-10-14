"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { loadResidentPortalData, type ResidentPortalData } from "@/lib/residentPortalData";
import { normalizeBedLabel } from "@/lib/bedLabels";

function text(value: unknown) {
  return value == null ? "" : String(value);
}

function money(value: unknown) {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

export default function ResidentRoomPage() {
  const [data, setData] = useState<ResidentPortalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    async function fetchData() {
      setLoading(true);
      setError("");

      const result = await loadResidentPortalData();
      if (!active) return;

      if (result.error || !result.data) {
        setError(result.error || "Unable to load room information.");
      } else {
        setData(result.data);
      }
      setLoading(false);
    }

    void fetchData();

    return () => {
      active = false;
    };
  }, []);

  const room = data?.room;
  const bed = data?.bed;
  const admission = data?.admission;

  const roomNumber = text(room?.room_number) || "—";
  const bedNumber = bed?.bed_number ? normalizeBedLabel(String(bed.bed_number)) : "—";
  const roomType = text(room?.room_type) || "Standard";
  const admissionStatus = text(admission?.status) || "Active";
  const monthlyRent = admission?.monthly_rent ?? room?.monthly_rent ?? 0;
  const admissionDate = text(admission?.admission_date).slice(0, 10) || "—";
  const expectedLeaving = text(admission?.expected_leaving_date).slice(0, 10) || "—";

  return (
    <main className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        {/* Header */}
        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">
            University Girls Hostel
          </p>
          <h1 className="mt-2 text-2xl font-bold text-slate-900 sm:text-3xl">
            My Room & Bed Allocation
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Your current room allocation, bed number, and residency details.
          </p>
        </section>

        {error && (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <div className="rounded-3xl border border-slate-200 bg-white p-12 text-center text-slate-500 shadow-sm">
            Loading your room allocation...
          </div>
        ) : !admission ? (
          <div className="rounded-3xl border border-slate-200 bg-white p-12 text-center shadow-sm">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600 mb-4">
              <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M2 4v16" />
                <path d="M2 8h18a2 2 0 0 1 2 2v10" />
                <path d="M2 17h20" />
                <path d="M6 8v9" />
              </svg>
            </div>
            <h2 className="text-lg font-bold text-slate-900">No Active Room Allocation</h2>
            <p className="mt-2 text-sm text-slate-500 max-w-md mx-auto">
              You do not currently have an active room or bed assignment on file. Please contact the hostel administration.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Primary Details Card */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="rounded-2xl border border-indigo-100 bg-gradient-to-br from-indigo-50/80 to-white p-5 shadow-xs">
                <span className="text-xs font-bold uppercase tracking-wider text-indigo-600">
                  Assigned Room
                </span>
                <p className="mt-2 text-3xl font-black text-slate-900">{roomNumber}</p>
                <p className="mt-1 text-xs text-slate-500">Type: {roomType}</p>
              </div>

              <div className="rounded-2xl border border-indigo-100 bg-gradient-to-br from-indigo-50/80 to-white p-5 shadow-xs">
                <span className="text-xs font-bold uppercase tracking-wider text-indigo-600">
                  Assigned Bed
                </span>
                <p className="mt-2 text-3xl font-black text-slate-900">{bedNumber}</p>
                <p className="mt-1 text-xs text-slate-500">Status: {admissionStatus}</p>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-xs sm:col-span-2 lg:col-span-1">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">
                  Monthly Rent
                </span>
                <p className="mt-2 text-3xl font-black text-indigo-700">{money(monthlyRent)}</p>
                <p className="mt-1 text-xs text-slate-500">Per billing cycle</p>
              </div>
            </div>

            {/* Information Grid */}
            <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              <h2 className="text-lg font-bold text-slate-900 mb-4">Residency Agreement Details</h2>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                  <p className="text-xs font-semibold text-slate-500 uppercase">Admission Date</p>
                  <p className="mt-1.5 font-bold text-slate-900">{admissionDate}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                  <p className="text-xs font-semibold text-slate-500 uppercase">Expected Leaving</p>
                  <p className="mt-1.5 font-bold text-slate-900">{expectedLeaving}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                  <p className="text-xs font-semibold text-slate-500 uppercase">Room Status</p>
                  <span className="mt-1.5 inline-block rounded-md bg-emerald-100 px-2.5 py-0.5 text-xs font-bold text-emerald-800">
                    {admissionStatus}
                  </span>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                  <p className="text-xs font-semibold text-slate-500 uppercase">Security Deposit</p>
                  <p className="mt-1.5 font-bold text-slate-900">{money(admission?.security_deposit || 0)}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                  <p className="text-xs font-semibold text-slate-500 uppercase">Room Type</p>
                  <p className="mt-1.5 font-bold text-slate-900">{roomType}</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                  <p className="text-xs font-semibold text-slate-500 uppercase">Contract Status</p>
                  <p className="mt-1.5 font-bold text-slate-900">{text(data?.contract?.status) || "Active"}</p>
                </div>
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                <Link
                  href="/resident-portal/maintenance"
                  className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700"
                >
                  Report Room Maintenance
                </Link>
                <Link
                  href="/resident-portal/inspections"
                  className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                >
                  View Room Inspections
                </Link>
                <Link
                  href="/resident-portal/contract"
                  className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
                >
                  View Signed Contract
                </Link>
              </div>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}