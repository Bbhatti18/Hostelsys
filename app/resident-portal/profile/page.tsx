"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import ProfileCompletion from "@/components/residents/ProfileCompletion";
import { supabase } from "@/lib/supabase";
import {
  resolveAuthenticatedResident,
} from "@/lib/residentPortalAuth";

type Resident = {
  id: string;
  full_name?: string | null;
  phone?: string | null;
  email?: string | null;
  cnic?: string | null;
  emergency_contact?: string | null;
  emergency_contact_name?: string | null;
  emergency_contact_relationship?: string | null;
  permanent_address?: string | null;
  status?: string | null;
  photo_url?: string | null;
};

function residentName(resident: Resident | null) { return resident?.full_name || "Resident"; }

export default function ResidentProfilePage() {
  const [resident, setResident] = useState<Resident | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sessionMissing, setSessionMissing] = useState(false);

  useEffect(() => {
    async function loadProfile() {
      const authenticated = await resolveAuthenticatedResident();

      if (!authenticated.resident) {
        setError(authenticated.error ?? "Please sign in to access your profile.");
        setSessionMissing(true);
        setLoading(false);
        return;
      }

      const { data, error: profileError } = await supabase
        .from("residents")
        .select("*")
        .eq("id", authenticated.resident.id)
        .maybeSingle();

      if (profileError) {
        setError("Your resident profile could not be loaded. Please try again.");
      } else if (!data) {
        setError("Resident profile was not found.");
      } else {
        setResident(data as Resident);
      }

      setLoading(false);
    }

    void loadProfile();
  }, []);

  if (loading) {
    return (
      <main className="min-h-screen bg-slate-50 p-4 sm:p-8">
        <div className="mx-auto max-w-4xl rounded-3xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm sm:p-8">
          Loading resident profile...
        </div>
      </main>
    );
  }

  if (sessionMissing) {
    return (
      <main className="min-h-screen bg-slate-50 p-4 sm:p-8">
        <div className="mx-auto max-w-xl rounded-3xl border border-amber-200 bg-amber-50 p-6 sm:p-8">
          <h1 className="text-2xl font-bold text-slate-900">
            Portal login required
          </h1>

          <p className="mt-2 text-sm text-slate-600">
            Please login to the Resident Portal first.
          </p>

          <Link
            href="/resident-portal"
            className="mt-5 inline-flex rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white"
          >
            Go to Resident Login
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">
            Hostel Management System
          </p>

          <h1 className="mt-2 text-2xl font-bold text-slate-900 sm:text-3xl">
            Resident Profile
          </h1>

          <p className="mt-1 text-sm text-slate-500">
            This information is loaded from your resident record.
          </p>
          <Link
            href="/resident-portal"
            className="mt-4 inline-flex text-sm font-semibold text-indigo-700 hover:underline"
          >
            ← Back to portal
          </Link>
        </section>

        {error && (
          <section className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            {error}
          </section>
        )}

        {resident && <ProfileCompletion onSubmitted={values => setResident(current => current ? { ...current, ...values, id: current.id } : current)} />}

        {resident && (
          <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
            <div className="flex flex-col gap-6 md:flex-row">
              <div className="flex h-24 w-24 shrink-0 items-center justify-center overflow-hidden rounded-3xl bg-indigo-100 text-3xl font-bold text-indigo-700 sm:h-28 sm:w-28 sm:text-4xl">
                {resident.photo_url ? (
                  <Image
                    src={resident.photo_url}
                    alt={residentName(resident)}
                    width={112}
                    height={112}
                    unoptimized
                    className="h-full w-full object-cover"
                  />
                ) : (
                  residentName(resident).charAt(0).toUpperCase()
                )}
              </div>

              <div className="min-w-0 flex-1">
                <h2 className="text-xl font-bold text-slate-900 sm:text-2xl">
                  {residentName(resident)}
                </h2>

                <div className="mt-5 grid gap-3 sm:mt-6 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3">
                  <InfoCard
                    label="Phone"
                    value={
                      resident.phone ||

                      "Not recorded"
                    }
                  />

                  <InfoCard
                    label="Email"
                    value={resident.email || "Not recorded"}
                  />

                  <InfoCard
                    label="CNIC"
                    value={
                      resident.cnic ||

                      "Not recorded"
                    }
                  />

                  <InfoCard
                    label="Emergency Contact Name"
                    value={resident.emergency_contact_name || "Not recorded"}
                  />

                  <InfoCard
                    label="Relationship"
                    value={resident.emergency_contact_relationship || "Not recorded"}
                  />

                  <InfoCard
                    label="Emergency Contact / Phone"
                    value={
                      resident.emergency_contact ||

                      "Not recorded"
                    }
                  />

                  <InfoCard
                    label="Admission Status"
                    value={resident.status || "Active"}
                  />

                  <InfoCard
                    label="Address"
                    value={resident.permanent_address || "Not recorded"}
                  />
                </div>
              </div>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

function InfoCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </p>

      <p className="mt-2 break-words font-semibold text-slate-900">
        {value}
      </p>
    </article>
  );
}
