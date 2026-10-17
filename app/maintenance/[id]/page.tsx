/* eslint-disable @next/next/no-img-element -- Existing Supabase photo URLs are not restricted to a configured image host. */
"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { maintenancePhotoUrl } from "@/lib/maintenanceStorage";
import { notifyMaintenanceCompleted } from "@/lib/maintenanceNotificationClient";

type Row = Record<string, unknown>;

type Request = {
  id: string;
  request_number: string;
  resident_id: string | null;
  admission_id: string | null;
  room_id: string | null;
  bed_id: string | null;
  title: string | null;
  description: string | null;
  category: string | null;
  priority: string | null;
  status: string | null;
  assigned_to: string | null;
  estimated_cost: number | null;
  actual_cost: number | null;
  complaint_date: string | null;
  assigned_date: string | null;
  completion_date: string | null;
  completed_at: string | null;
  notes: string | null;
  photo_url: string | null;
  before_photos: unknown;
  during_photos: unknown;
  after_photos: unknown;
  created_at: string;
  updated_at: string;
};

type Photo = {
  id: string;
  photo_type: string | null;
  photo_url: string;
  created_at: string;
};

const text = (value: unknown) => (value == null ? "" : String(value));
const name = (row: Row | null, keys: string[], fallback = "—") =>
  keys.map((key) => text(row?.[key]).trim()).find(Boolean) || fallback;
const list = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
const money = (value: unknown) =>
  new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));

function statusBadgeClass(status: string | null) {
  const s = String(status || "").toLowerCase();
  if (s === "completed") return "bg-emerald-100 text-emerald-800 border-emerald-200";
  if (s === "in progress" || s === "approved") return "bg-blue-100 text-blue-800 border-blue-200";
  if (s === "pending" || s === "open") return "bg-amber-100 text-amber-800 border-amber-200";
  if (s === "cancelled") return "bg-slate-200 text-slate-700 border-slate-300";
  return "bg-slate-100 text-slate-700 border-slate-200";
}

export default function MaintenanceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [request, setRequest] = useState<Request | null>(null);
  const [resident, setResident] = useState<Row | null>(null);
  const [admission, setAdmission] = useState<Row | null>(null);
  const [room, setRoom] = useState<Row | null>(null);
  const [bed, setBed] = useState<Row | null>(null);
  const [photoRows, setPhotoRows] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [updating, setUpdating] = useState(false);

  // Complete Modal
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [completeCost, setCompleteCost] = useState("");
  const [completeDate, setCompleteDate] = useState(new Date().toISOString().slice(0, 10));
  const [completeNotes, setCompleteNotes] = useState("");

  const load = useCallback(async () => {
    try {
      // Query maintenance request without non-existent columns work_performed / parts_replaced
      const [requestResult, photosResult] = await Promise.all([
        supabase
          .from("maintenance_requests")
          .select(
            "id,request_number,resident_id,admission_id,room_id,bed_id,title,description,category,priority,status,assigned_to,estimated_cost,actual_cost,complaint_date,assigned_date,completion_date,completed_at,notes,photo_url,before_photos,during_photos,after_photos,created_at,updated_at"
          )
          .eq("id", id)
          .maybeSingle(),
        supabase
          .from("maintenance_photos")
          .select("id,maintenance_request_id,photo_type,photo_url,created_at")
          .eq("maintenance_request_id", id)
          .order("created_at", { ascending: true }),
      ]);

      if (requestResult.error || !requestResult.data) {
        console.error("Maintenance load error:", requestResult.error);
        setError("The maintenance request could not be loaded. Please refresh and try again.");
        setLoading(false);
        return;
      }

      const item = requestResult.data as Request;

      const [residentResult, admissionResult, roomResult, bedResult] = await Promise.all([
        item.resident_id
          ? supabase
              .from("residents")
              .select("id,full_name,resident_code,phone")
              .eq("id", item.resident_id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        item.admission_id
          ? supabase
              .from("admissions")
              .select("id,admission_date,status")
              .eq("id", item.admission_id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        item.room_id
          ? supabase
              .from("rooms")
              .select("id,room_number,block_name,floor_number")
              .eq("id", item.room_id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        item.bed_id
          ? supabase.from("beds").select("id,bed_number").eq("id", item.bed_id).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);

      setRequest(item);
      setResident((residentResult.data ?? null) as Row | null);
      setAdmission((admissionResult.data ?? null) as Row | null);
      setRoom((roomResult.data ?? null) as Row | null);
      setBed((bedResult.data ?? null) as Row | null);
      setPhotoRows(photosResult.error ? [] : (photosResult.data ?? []) as Photo[]);

      // Default complete modal values
      setCompleteCost(String(item.actual_cost || item.estimated_cost || 0));
      setCompleteNotes(item.notes || "");
    } catch (err) {
      console.error("Unexpected load error:", err);
      setError("Failed to load maintenance request.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleApprove() {
    if (!request) return;
    setUpdating(true);
    setError("");

    try {
      const now = new Date().toISOString();
      const today = now.slice(0, 10);
      const updatePayload = {
        status: "In Progress",
        assigned_date: request.assigned_date || today,
        updated_at: now,
      };

      const { error: updateErr } = await supabase
        .from("maintenance_requests")
        .update(updatePayload)
        .eq("id", request.id);

      if (updateErr) {
        throw new Error(updateErr.message || "Failed to approve maintenance request.");
      }

      setSuccessMessage("Maintenance request approved and marked In Progress!");
      setTimeout(() => setSuccessMessage(""), 5000);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to approve request.");
    } finally {
      setUpdating(false);
    }
  }

  async function handleComplete(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (!request) return;

    setUpdating(true);
    setError("");

    try {
      const now = new Date().toISOString();
      const actualCostNumber = Number(completeCost || 0);

      const updatePayload = {
        status: "Completed",
        completion_date: completeDate || now.slice(0, 10),
        completed_at: now,
        actual_cost: actualCostNumber,
        notes: completeNotes.trim() || request.notes || null,
        updated_at: now,
      };

      const { error: updateErr } = await supabase
        .from("maintenance_requests")
        .update(updatePayload)
        .eq("id", request.id);

      if (updateErr) {
        throw new Error(updateErr.message || "Failed to complete maintenance request.");
      }

      const notif = await notifyMaintenanceCompleted(request.id);
      const emailMsg =
        notif.emailSent && notif.recipientEmail
          ? ` Resolution email sent to ${notif.recipientEmail}.`
          : "";

      setShowCompleteModal(false);
      setSuccessMessage(`Maintenance request marked as Completed!${emailMsg}`);
      setTimeout(() => setSuccessMessage(""), 5000);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to mark as completed.");
    } finally {
      setUpdating(false);
    }
  }

  async function handleCancel() {
    if (!request) return;
    if (!confirm(`Cancel maintenance request ${request.request_number}? Its history will be preserved.`)) {
      return;
    }

    setUpdating(true);
    setError("");

    try {
      const now = new Date().toISOString();
      const { error: updateErr } = await supabase
        .from("maintenance_requests")
        .update({
          status: "Cancelled",
          updated_at: now,
        })
        .eq("id", request.id);

      if (updateErr) {
        throw new Error(updateErr.message || "Failed to cancel request.");
      }

      setSuccessMessage("Maintenance request cancelled.");
      setTimeout(() => setSuccessMessage(""), 5000);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel request.");
    } finally {
      setUpdating(false);
    }
  }

  async function handleReopen() {
    if (!request) return;
    setUpdating(true);
    setError("");

    try {
      const now = new Date().toISOString();
      const { error: updateErr } = await supabase
        .from("maintenance_requests")
        .update({
          status: "In Progress",
          completed_at: null,
          updated_at: now,
        })
        .eq("id", request.id);

      if (updateErr) {
        throw new Error(updateErr.message || "Failed to reopen request.");
      }

      setSuccessMessage("Maintenance request re-opened and set to In Progress.");
      setTimeout(() => setSuccessMessage(""), 5000);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to reopen request.");
    } finally {
      setUpdating(false);
    }
  }

  const galleries = useMemo(() => {
    if (!request) return [];
    const rows = (kind: string) =>
      photoRows
        .filter((photo) => text(photo.photo_type).trim().toLowerCase() === kind)
        .map((photo) => photo.photo_url);
    const unique = (references: string[]) =>
      Array.from(new Set(references.filter(Boolean))).map(maintenancePhotoUrl);

    return [
      {
        title: "Before Photos",
        urls: unique([
          ...list(request.before_photos),
          ...rows("before"),
          ...(request.photo_url ? [request.photo_url] : []),
        ]),
      },
      {
        title: "During Work Photos",
        urls: unique([...list(request.during_photos), ...rows("during")]),
      },
      {
        title: "After Photos",
        urls: unique([...list(request.after_photos), ...rows("after")]),
      },
    ];
  }, [photoRows, request]);

  if (loading) {
    return (
      <main className="min-h-screen bg-slate-50 p-8 text-center">
        <div className="mx-auto max-w-md rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600 text-xl font-bold">
            🔧
          </div>
          <p className="mt-4 font-semibold text-slate-700">Loading maintenance request...</p>
        </div>
      </main>
    );
  }

  if (!request) {
    return (
      <main className="min-h-screen bg-slate-50 p-8">
        <div className="mx-auto max-w-4xl rounded-3xl border border-red-200 bg-red-50 p-6 text-red-800 shadow-sm">
          <h3 className="font-bold text-lg">Unable to Load Request</h3>
          <p className="mt-1 text-sm">{error || "Maintenance request not found."}</p>
          <Link
            href="/maintenance"
            className="mt-4 inline-flex items-center gap-2 rounded-xl bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800"
          >
            ← Back to Maintenance
          </Link>
        </div>
      </main>
    );
  }

  const isPending = request.status === "Pending" || request.status === "Open";
  const isInProgress = request.status === "In Progress" || request.status === "Approved";
  const isCompleted = request.status === "Completed";
  const isCancelled = request.status === "Cancelled";

  return (
    <main className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-5xl space-y-6">
        {/* Alerts */}
        {error && (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800 shadow-sm">
            ⚠️ {error}
          </div>
        )}

        {successMessage && (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm font-medium text-emerald-800 shadow-sm">
            ✓ {successMessage}
          </div>
        )}

        {/* Header and Action Card */}
        <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Link
              href="/maintenance"
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-indigo-600 hover:text-indigo-800 transition"
            >
              ← Back to Maintenance
            </Link>

            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1 text-xs font-bold border ${statusBadgeClass(
                request.status
              )}`}
            >
              {request.status || "Open"}
            </span>
          </div>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-mono text-xs font-bold uppercase tracking-wider text-indigo-600">
                {request.request_number}
              </p>
              <h1 className="mt-1 text-2xl sm:text-3xl font-bold text-slate-900">
                {request.title || "Maintenance Request"}
              </h1>
            </div>
          </div>

          {/* Action Buttons for Approving, Completing, and Cancelling */}
          <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-5">
            {isPending && (
              <>
                <button
                  type="button"
                  disabled={updating}
                  onClick={() => void handleApprove()}
                  className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-50"
                >
                  <span>✓</span> Approve & Start Work
                </button>

                <button
                  type="button"
                  disabled={updating}
                  onClick={() => setShowCompleteModal(true)}
                  className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
                >
                  <span>✓</span> Mark as Completed
                </button>
              </>
            )}

            {isInProgress && (
              <button
                type="button"
                disabled={updating}
                onClick={() => setShowCompleteModal(true)}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-5 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
              >
                <span>✓</span> Mark as Completed
              </button>
            )}

            {isCompleted && (
              <div className="flex flex-wrap items-center gap-3">
                <span className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-50 px-4 py-2 text-xs font-bold text-emerald-800 border border-emerald-200">
                  <span>✓</span> Completed on {request.completion_date || (request.completed_at ? request.completed_at.slice(0, 10) : "Recorded")}
                </span>
                <button
                  type="button"
                  disabled={updating}
                  onClick={() => void handleReopen()}
                  className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition shadow-sm"
                >
                  ↩ Re-open Request
                </button>
              </div>
            )}

            {!isCancelled && !isCompleted && (
              <button
                type="button"
                disabled={updating}
                onClick={() => void handleCancel()}
                className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 transition shadow-sm"
              >
                Cancel Request
              </button>
            )}

            <Link
              href={`/maintenance`}
              className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition shadow-sm"
            >
              Back to Table
            </Link>
          </div>
        </section>

        {/* Key Info Grid */}
        <section className="grid gap-4 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2 sm:p-6 lg:grid-cols-3">
          <Info label="Resident" value={name(resident, ["full_name"])} />
          <Info
            label="Admission"
            value={name(admission, ["admission_date", "id"], "Not linked")}
          />
          <Info label="Room" value={name(room, ["room_number"])} />
          <Info label="Bed" value={name(bed, ["bed_number"], "Not linked")} />
          <Info
            label="Location"
            value={
              [
                name(room, ["block_name"], ""),
                name(room, ["block_name"], ""),
                name(room, ["floor_number"], ""),
              ]
                .filter(Boolean)
                .join(" · ") || "—"
            }
          />
          <Info label="Category / Issue Type" value={request.category || "Other"} />
          <Info label="Priority" value={request.priority || "Medium"} />
          <Info label="Assigned Person / Vendor" value={request.assigned_to || "Not assigned"} />
          <Info
            label="Reported Date"
            value={(request.complaint_date || request.created_at).slice(0, 10)}
          />
          <Info label="Completion Date" value={request.completion_date || "Not completed"} />
          <Info label="Estimated Cost" value={money(request.estimated_cost)} />
          <Info label="Actual Cost" value={money(request.actual_cost)} />
        </section>

        {/* Status Timeline */}
        <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <h2 className="text-xl font-bold text-slate-900">Status Timeline</h2>
          <div className="mt-5 grid gap-3 md:grid-cols-2 lg:grid-cols-5">
            <Timeline label="1. Reported" date={request.complaint_date || request.created_at} />
            <Timeline label="2. Assigned / Approved" date={request.assigned_date} />
            <Timeline
              label="3. In Progress"
              date={
                ["In Progress", "Completed"].includes(request.status || "")
                  ? request.updated_at
                  : null
              }
            />
            <Timeline
              label="4. Completed"
              date={request.completed_at || request.completion_date}
            />
            <Timeline
              label="Cancelled"
              date={request.status === "Cancelled" ? request.updated_at : null}
            />
          </div>
        </section>

        {/* Full Request Details */}
        <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
          <h2 className="text-lg font-bold text-slate-900">Full Request Information</h2>
          <TextBlock
            label="Problem Description"
            value={
              request.description ||
              "No detailed description provided."
            }
          />
          <TextBlock
            label="Resolution & Technician Notes"
            value={request.notes || "No resolution notes recorded yet."}
          />
        </section>

        {/* Photo Galleries */}
        {galleries.map((gallery) => (
          <PhotoGallery key={gallery.title} title={gallery.title} urls={gallery.urls} />
        ))}

        {/* Complete Modal */}
        {showCompleteModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
            <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl border border-slate-200 bg-white p-4 shadow-2xl sm:p-8">
              <div className="flex items-center justify-between border-b border-slate-200 pb-4">
                <div>
                  <h3 className="text-xl font-bold text-slate-900">Mark Maintenance as Completed</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Update the request to Completed status and record final details.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowCompleteModal(false)}
                  className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 transition"
                >
                  ✕
                </button>
              </div>

              <form onSubmit={handleComplete} className="mt-5 space-y-4">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-700">
                    Completion Date *
                  </label>
                  <input
                    type="date"
                    required
                    value={completeDate}
                    onChange={(e) => setCompleteDate(e.target.value)}
                    className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  />
                </div>

                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-700">
                    Actual Cost (PKR)
                  </label>
                  <div className="relative mt-1.5">
                    <span className="absolute inset-y-0 left-0 flex items-center pl-4 font-bold text-slate-400">
                      Rs
                    </span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={completeCost}
                      onChange={(e) => setCompleteCost(e.target.value)}
                      placeholder="0"
                      className="w-full rounded-xl border border-slate-300 bg-white pl-12 pr-4 py-2.5 text-sm font-bold text-slate-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    />
                  </div>
                  <span className="text-[11px] text-slate-400">Estimated cost was {money(request.estimated_cost)}</span>
                </div>

                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-700">
                    Resolution Notes / Work Performed
                  </label>
                  <textarea
                    rows={3}
                    value={completeNotes}
                    onChange={(e) => setCompleteNotes(e.target.value)}
                    placeholder="Describe work completed, parts repaired or replaced..."
                    className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  />
                </div>

                <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 pt-3">
                  <button
                    type="button"
                    onClick={() => setShowCompleteModal(false)}
                    className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={updating}
                    className="rounded-xl bg-emerald-600 px-6 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {updating ? "Completing..." : "Confirm & Complete"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-slate-50 p-4 border border-slate-100">
      <p className="text-xs font-bold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-1.5 font-semibold text-slate-900">{value}</p>
    </div>
  );
}

function Timeline({ label, date }: { label: string; date: string | null }) {
  return (
    <div
      className={`rounded-2xl border p-4 ${
        date ? "border-emerald-200 bg-emerald-50/70" : "border-slate-200 bg-slate-50"
      }`}
    >
      <p className="text-xs font-bold text-slate-800">{label}</p>
      <p className="mt-1 text-xs text-slate-500">{date ? date.slice(0, 10) : "Not reached"}</p>
    </div>
  );
}

function TextBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-5">
      <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500">{label}</h3>
      <p className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-slate-800 bg-slate-50 p-4 rounded-2xl border border-slate-100">
        {value}
      </p>
    </div>
  );
}

function PhotoGallery({ title, urls }: { title: string; urls: string[] }) {
  if (urls.length === 0) return null;
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <h2 className="text-xl font-bold text-slate-900">{title}</h2>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4">
        {urls.map((url, index) => (
          <a
            key={`${url}-${index}`}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="group overflow-hidden rounded-2xl border border-slate-200 shadow-sm"
          >
            <img
              src={url}
              alt={`${title} ${index + 1}`}
              className="h-44 w-full object-cover transition group-hover:scale-105"
            />
          </a>
        ))}
      </div>
    </section>
  );
}
