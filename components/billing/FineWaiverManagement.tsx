"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { FineWaiverRequest, FineWaiverStatus } from "@/lib/fineWaivers";

function money(value: unknown) {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function monthLabel(value: string | undefined) {
  if (!value) return "—";
  const parsed = new Date(`${value.slice(0, 7)}-01T00:00:00`);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleDateString("en-PK", { month: "short", year: "numeric" });
}

function statusBadge(status: FineWaiverStatus) {
  switch (status) {
    case "Approved":
      return "bg-emerald-100 text-emerald-800 border-emerald-200";
    case "Partially Approved":
      return "bg-blue-100 text-blue-800 border-blue-200";
    case "Rejected":
      return "bg-red-100 text-red-800 border-red-200";
    default:
      return "bg-amber-100 text-amber-800 border-amber-200";
  }
}

type ModalAction = {
  request: FineWaiverRequest;
  action: "FULL_WAIVER" | "PARTIAL_WAIVER" | "REJECT";
};

type Props = {
  onWaiverUpdated?: () => void;
};

export default function FineWaiverManagement({ onWaiverUpdated }: Props) {
  const [requests, setRequests] = useState<FineWaiverRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("All");

  const [modalAction, setModalAction] = useState<ModalAction | null>(null);
  const [partialAmount, setPartialAmount] = useState<string>("");
  const [adminNotes, setAdminNotes] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  async function getAccessToken() {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session?.access_token) return session.access_token;
    const {
      data: { session: refreshedSession },
    } = await supabase.auth.refreshSession();
    return refreshedSession?.access_token ?? null;
  }

  const loadRequests = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getAccessToken();
      if (!token) {
        setError("Your admin session is expired. Please sign in again.");
        setLoading(false);
        return;
      }

      const res = await fetch("/api/admin/fine-waivers", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to load waiver requests.");
      }
      setRequests(data.requests || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load fine waiver requests.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRequests();
  }, [loadRequests]);

  function openAction(request: FineWaiverRequest, action: "FULL_WAIVER" | "PARTIAL_WAIVER" | "REJECT") {
    setModalAction({ request, action });
    setPartialAmount(action === "PARTIAL_WAIVER" ? String(request.requested_amount || request.fine_amount / 2) : "");
    setAdminNotes("");
    setError(null);
    setSuccessMsg(null);
  }

  function closeModal() {
    if (submitting) return;
    setModalAction(null);
    setPartialAmount("");
    setAdminNotes("");
  }

  async function handleConfirmAction() {
    if (!modalAction) return;
    const { request, action } = modalAction;

    let waivedNum: number | undefined;
    if (action === "PARTIAL_WAIVER") {
      waivedNum = Number(partialAmount);
      if (!Number.isFinite(waivedNum) || waivedNum <= 0) {
        setError("Please enter a valid partial waiver amount greater than 0.");
        return;
      }
      if (waivedNum > request.fine_amount) {
        setError(`Partial waiver cannot exceed the total fine of Rs. ${request.fine_amount}.`);
        return;
      }
    }

    setSubmitting(true);
    setError(null);

    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Your session is expired. Please sign in again.");

      const res = await fetch("/api/admin/fine-waivers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          requestId: request.id,
          action,
          waivedAmount: waivedNum,
          adminNotes: adminNotes.trim() || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to update fine waiver.");
      }

      const actionText =
        action === "FULL_WAIVER"
          ? "Full waiver approved (100% fine waived)."
          : action === "PARTIAL_WAIVER"
          ? `Partial waiver of ${money(waivedNum)} approved.`
          : "Waiver request rejected.";

      setSuccessMsg(`Decision applied: ${actionText}`);
      closeModal();
      await loadRequests();
      onWaiverUpdated?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to apply decision.");
    } finally {
      setSubmitting(false);
    }
  }

  const counts = useMemo(() => {
    let pending = 0;
    let approved = 0;
    let partial = 0;
    let rejected = 0;
    for (const r of requests) {
      if (r.status === "Pending") pending++;
      else if (r.status === "Approved") approved++;
      else if (r.status === "Partially Approved") partial++;
      else if (r.status === "Rejected") rejected++;
    }
    return { total: requests.length, pending, approved, partial, rejected };
  }, [requests]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return requests.filter((r) => {
      const matchesStatus =
        statusFilter === "All" ||
        r.status === statusFilter ||
        (statusFilter === "Approved" && (r.status === "Approved" || r.status === "Partially Approved"));

      const matchesSearch =
        !q ||
        (r.resident_name ?? "").toLowerCase().includes(q) ||
        (r.resident_email ?? "").toLowerCase().includes(q) ||
        (r.bill_number ?? "").toLowerCase().includes(q) ||
        (r.reason ?? "").toLowerCase().includes(q) ||
        (r.room_number ?? "").toLowerCase().includes(q);

      return matchesStatus && matchesSearch;
    });
  }, [requests, search, statusFilter]);

  return (
    <section className="space-y-6">
      {/* Top Banner / Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-amber-700">Pending Review</p>
          <p className="mt-2 text-2xl font-bold text-amber-900">{counts.pending}</p>
          <p className="mt-1 text-xs text-amber-600">Awaiting admin decision</p>
        </div>
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-emerald-700">Full Waivers</p>
          <p className="mt-2 text-2xl font-bold text-emerald-900">{counts.approved}</p>
          <p className="mt-1 text-xs text-emerald-600">100% fine waived</p>
        </div>
        <div className="rounded-2xl border border-blue-200 bg-blue-50/70 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-blue-700">Partial Waivers</p>
          <p className="mt-2 text-2xl font-bold text-blue-900">{counts.partial}</p>
          <p className="mt-1 text-xs text-blue-600">Reduced fine charges</p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Rejected</p>
          <p className="mt-2 text-2xl font-bold text-slate-800">{counts.rejected}</p>
          <p className="mt-1 text-xs text-slate-500">Requests turned down</p>
        </div>
      </div>

      {successMsg && (
        <div className="flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800">
          <span>✓ {successMsg}</span>
          <button
            type="button"
            onClick={() => setSuccessMsg(null)}
            className="text-xs text-emerald-700 underline hover:text-emerald-900"
          >
            Dismiss
          </button>
        </div>
      )}

      {error && (
        <div className="flex items-center justify-between rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
          <span>✕ {error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-xs text-red-700 underline hover:text-red-900"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Main Table Container */}
      <div className="rounded-3xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        {/* Controls Header */}
        <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search resident, room, bill #, or reason..."
              className="w-full sm:w-72 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
            />
            <div className="flex flex-wrap items-center gap-1">
              {["All", "Pending", "Approved", "Partially Approved", "Rejected"].map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setStatusFilter(tab)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                    statusFilter === tab
                      ? "bg-indigo-600 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={() => void loadRequests()}
            disabled={loading}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            {loading ? "Refreshing..." : "↻ Refresh"}
          </button>
        </div>

        {/* Requests List */}
        {loading ? (
          <div className="p-12 text-center text-sm text-slate-500">Loading fine waiver requests...</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center text-sm text-slate-500">
            {search || statusFilter !== "All"
              ? "No waiver requests match your current filters."
              : "No fine waiver requests submitted yet."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
              <thead className="bg-slate-50 text-xs font-bold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3">Resident</th>
                  <th className="px-4 py-3">Bill Details</th>
                  <th className="px-4 py-3">Fine (Rs. 300/day)</th>
                  <th className="px-4 py-3">Requested & Reason</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Review Notes</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((req) => (
                  <tr key={req.id} className="hover:bg-slate-50/70 transition">
                    <td className="px-4 py-3.5">
                      <p className="font-semibold text-slate-900">{req.resident_name || "Resident"}</p>
                      <p className="text-xs text-slate-500">
                        {req.room_number ? `Room ${req.room_number}` : "No room"}
                        {req.bed_number ? ` · Bed ${req.bed_number}` : ""}
                      </p>
                      {req.resident_email && (
                        <p className="text-[11px] text-slate-400">{req.resident_email}</p>
                      )}
                    </td>

                    <td className="px-4 py-3.5">
                      <p className="font-semibold text-slate-800">{req.bill_number || "Bill"}</p>
                      <p className="text-xs text-slate-500">{monthLabel(req.billing_month)}</p>
                      <p className="text-[11px] text-slate-400">Due: {req.due_date || "—"}</p>
                    </td>

                    <td className="px-4 py-3.5 font-medium">
                      <p className="text-red-700 font-bold">{money(req.fine_amount)}</p>
                      <p className="text-[10px] text-slate-400">
                        {Math.round(req.fine_amount / 300)} days overdue
                      </p>
                    </td>

                    <td className="px-4 py-3.5 max-w-xs">
                      <p className="text-xs font-semibold text-slate-900">
                        Requested: {money(req.requested_amount)}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-600 line-clamp-2" title={req.reason}>
                        &ldquo;{req.reason}&rdquo;
                      </p>
                      <p className="mt-1 text-[10px] text-slate-400">
                        Submitted {new Date(req.created_at).toLocaleDateString("en-PK")}
                      </p>
                    </td>

                    <td className="px-4 py-3.5">
                      <span
                        className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-bold ${statusBadge(
                          req.status
                        )}`}
                      >
                        {req.status}
                      </span>
                      {req.status === "Approved" && (
                        <p className="mt-1 text-[11px] text-emerald-700 font-semibold">
                          Waived {money(req.waived_amount)} (100%)
                        </p>
                      )}
                      {req.status === "Partially Approved" && (
                        <p className="mt-1 text-[11px] text-blue-700 font-semibold">
                          Waived {money(req.waived_amount)} · Payable{" "}
                          {money(Math.max(0, req.fine_amount - req.waived_amount))}
                        </p>
                      )}
                    </td>

                    <td className="px-4 py-3.5 max-w-xs">
                      {req.reviewed_by ? (
                        <>
                          <p className="text-xs text-slate-700 italic">
                            {req.admin_notes || "No notes provided"}
                          </p>
                          <p className="mt-1 text-[10px] text-slate-400">
                            By {req.reviewed_by} on{" "}
                            {req.reviewed_at ? new Date(req.reviewed_at).toLocaleDateString("en-PK") : ""}
                          </p>
                        </>
                      ) : (
                        <span className="text-xs text-slate-400">Awaiting review</span>
                      )}
                    </td>

                    <td className="px-4 py-3.5 text-right">
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => openAction(req, "FULL_WAIVER")}
                          className="rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white shadow-xs hover:bg-emerald-700 transition"
                        >
                          Full Waiver
                        </button>
                        <button
                          type="button"
                          onClick={() => openAction(req, "PARTIAL_WAIVER")}
                          className="rounded-lg bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white shadow-xs hover:bg-blue-700 transition"
                        >
                          Partial Waiver
                        </button>
                        <button
                          type="button"
                          onClick={() => openAction(req, "REJECT")}
                          className="rounded-lg bg-red-100 text-red-700 border border-red-200 px-2.5 py-1 text-xs font-semibold hover:bg-red-200 transition"
                        >
                          Reject
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Decision Modal */}
      {modalAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-xs">
          <div className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl space-y-5 animate-in fade-in duration-150">
            <div className="flex items-start justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-lg font-bold text-slate-900">
                  {modalAction.action === "FULL_WAIVER"
                    ? "Grant Full Fine Waiver"
                    : modalAction.action === "PARTIAL_WAIVER"
                    ? "Grant Partial Fine Waiver"
                    : "Reject Fine Waiver Request"}
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  Resident: <span className="font-semibold text-slate-700">{modalAction.request.resident_name}</span>{" "}
                  · Bill: <span className="font-semibold text-slate-700">{modalAction.request.bill_number}</span>
                </p>
              </div>
              <button
                type="button"
                onClick={closeModal}
                disabled={submitting}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition"
              >
                ✕
              </button>
            </div>

            {/* Resident Request Overview */}
            <div className="rounded-2xl bg-slate-50 p-4 text-xs space-y-2 border border-slate-100">
              <div className="flex justify-between">
                <span className="text-slate-500">Total Accrued Fine:</span>
                <span className="font-bold text-red-700">{money(modalAction.request.fine_amount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Resident Requested:</span>
                <span className="font-bold text-indigo-700">{money(modalAction.request.requested_amount)}</span>
              </div>
              <div>
                <span className="text-slate-500">Resident Reason:</span>
                <p className="mt-1 font-medium text-slate-800 italic bg-white p-2.5 rounded-xl border border-slate-200">
                  &ldquo;{modalAction.request.reason}&rdquo;
                </p>
              </div>
            </div>

            {/* Action Specific Fields */}
            {modalAction.action === "FULL_WAIVER" && (
              <div className="rounded-2xl bg-emerald-50 border border-emerald-200 p-4 text-xs text-emerald-800 space-y-1">
                <p className="font-bold">Full Waiver (100%):</p>
                <p>
                  This will waive the entire fine of <span className="font-bold">{money(modalAction.request.fine_amount)}</span>.
                  The resident&apos;s late fine payable balance will become Rs. 0.
                </p>
              </div>
            )}

            {modalAction.action === "PARTIAL_WAIVER" && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Waived Amount (PKR) <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="number"
                    min="1"
                    max={modalAction.request.fine_amount}
                    step="1"
                    value={partialAmount}
                    onChange={(e) => setPartialAmount(e.target.value)}
                    placeholder="Enter amount to waive"
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
                  />
                </div>
                {Number(partialAmount) > 0 && (
                  <div className="flex items-center justify-between rounded-xl bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-900 border border-blue-200">
                    <span>Remaining Payable Fine:</span>
                    <span>
                      {money(Math.max(0, modalAction.request.fine_amount - Number(partialAmount)))}
                    </span>
                  </div>
                )}
              </div>
            )}

            {modalAction.action === "REJECT" && (
              <div className="rounded-2xl bg-red-50 border border-red-200 p-4 text-xs text-red-800 space-y-1">
                <p className="font-bold">Reject Request:</p>
                <p>
                  The full fine of <span className="font-bold">{money(modalAction.request.fine_amount)}</span> will
                  remain payable by the resident.
                </p>
              </div>
            )}

            {/* Admin Notes */}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Admin Notes / Explanation to Resident
              </label>
              <textarea
                rows={3}
                value={adminNotes}
                onChange={(e) => setAdminNotes(e.target.value)}
                placeholder={
                  modalAction.action === "REJECT"
                    ? "Explain why the waiver request was rejected..."
                    : "Add any internal note or message to resident (optional)..."
                }
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 resize-none"
              />
            </div>

            {/* Modal Actions */}
            <div className="flex justify-end gap-2.5 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={closeModal}
                disabled={submitting}
                className="rounded-xl border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmAction}
                disabled={submitting}
                className={`rounded-xl px-5 py-2 text-xs font-semibold text-white shadow-xs transition ${
                  modalAction.action === "FULL_WAIVER"
                    ? "bg-emerald-600 hover:bg-emerald-700"
                    : modalAction.action === "PARTIAL_WAIVER"
                    ? "bg-blue-600 hover:bg-blue-700"
                    : "bg-red-600 hover:bg-red-700"
                } disabled:opacity-50`}
              >
                {submitting
                  ? "Applying..."
                  : modalAction.action === "FULL_WAIVER"
                  ? "Confirm Full Waiver"
                  : modalAction.action === "PARTIAL_WAIVER"
                  ? "Confirm Partial Waiver"
                  : "Confirm Rejection"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
