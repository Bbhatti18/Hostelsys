"use client";

import { useState, useEffect, FormEvent } from "react";
import { supabase } from "@/lib/supabase";
import {
  DepositRefundType,
  DepositSettlementRecord,
} from "@/lib/depositSettlement";

export type ReleaseDepositModalProps = {
  isOpen: boolean;
  onClose: () => void;
  admissionId?: string;
  billId?: string;
  residentName: string;
  roomBedLabel?: string;
  depositAmount: number;
  existingSettlement?: DepositSettlementRecord | null;
  onSettled: (settlement: DepositSettlementRecord) => void;
};

function formatMoney(amount: number): string {
  return `Rs. ${Number(amount || 0).toLocaleString("en-PK")}`;
}

export default function ReleaseDepositModal({
  isOpen,
  onClose,
  admissionId,
  billId,
  residentName,
  roomBedLabel,
  depositAmount,
  existingSettlement,
  onSettled,
}: ReleaseDepositModalProps) {
  const [refundType, setRefundType] = useState<DepositRefundType>(
    existingSettlement?.refundType || "Fully Refunded",
  );
  const [refundAmount, setRefundAmount] = useState<string>(
    String(existingSettlement ? existingSettlement.refundAmount : depositAmount),
  );
  const [deductedAmount, setDeductedAmount] = useState<string>(
    String(existingSettlement ? existingSettlement.deductedAmount : 0),
  );
  const [deductionReason, setDeductionReason] = useState<string>(
    existingSettlement?.deductionReason || "",
  );
  const [refundMethod, setRefundMethod] = useState<string>(
    existingSettlement?.refundMethod || "Cash",
  );
  const [settlementDate, setSettlementDate] = useState<string>(
    existingSettlement?.settledAt
      ? existingSettlement.settledAt.slice(0, 10)
      : new Date().toISOString().slice(0, 10),
  );
  const [notes, setNotes] = useState<string>(existingSettlement?.notes || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (isOpen) {
      setError("");
      if (existingSettlement) {
        setRefundType(existingSettlement.refundType);
        setRefundAmount(String(existingSettlement.refundAmount));
        setDeductedAmount(String(existingSettlement.deductedAmount));
        setDeductionReason(existingSettlement.deductionReason || "");
        setRefundMethod(existingSettlement.refundMethod || "Cash");
        setSettlementDate(existingSettlement.settledAt.slice(0, 10));
        setNotes(existingSettlement.notes || "");
      } else {
        setRefundType("Fully Refunded");
        setRefundAmount(String(depositAmount));
        setDeductedAmount("0");
        setDeductionReason("");
        setRefundMethod("Cash");
        setSettlementDate(new Date().toISOString().slice(0, 10));
        setNotes("");
      }
    }
  }, [isOpen, existingSettlement, depositAmount]);

  function handleRefundTypeChange(type: DepositRefundType) {
    setRefundType(type);
    setError("");
    if (type === "Fully Refunded") {
      setRefundAmount(String(depositAmount));
      setDeductedAmount("0");
    } else if (type === "No Refund") {
      setRefundAmount("0");
      setDeductedAmount(String(depositAmount));
      if (!deductionReason) {
        setDeductionReason("Forfeited / Withheld according to hostel policy");
      }
    } else if (type === "Partially Refunded") {
      // Default to 50% split if not already customized
      const half = Math.round(depositAmount / 2);
      setRefundAmount(String(half));
      setDeductedAmount(String(depositAmount - half));
    }
  }

  function handleRefundAmountChange(val: string) {
    setRefundAmount(val);
    const num = Number(val || 0);
    if (Number.isFinite(num) && num >= 0 && num <= depositAmount) {
      setDeductedAmount(String(depositAmount - num));
    }
  }

  function handleDeductedAmountChange(val: string) {
    setDeductedAmount(val);
    const num = Number(val || 0);
    if (Number.isFinite(num) && num >= 0 && num <= depositAmount) {
      setRefundAmount(String(depositAmount - num));
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");

    const refNum = Number(refundAmount || 0);
    const dedNum = Number(deductedAmount || 0);

    if (refundType === "Partially Refunded") {
      if (refNum <= 0) {
        setError("Partially Refunded requires a positive refund amount.");
        return;
      }
      if (dedNum <= 0) {
        setError("Partially Refunded requires a positive deducted amount.");
        return;
      }
      if (!deductionReason.trim()) {
        setError("Please specify the reason for the deduction.");
        return;
      }
    }

    if (refundType === "No Refund") {
      if (!deductionReason.trim()) {
        setError("Please state the reason why no refund is being issued.");
        return;
      }
    }

    setLoading(true);

    try {
      let { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session?.access_token) {
        const refreshed = await supabase.auth.refreshSession();
        sessionData = refreshed.data;
      }
      const token = sessionData.session?.access_token;
      if (!token) {
        setError("Your session could not be verified. Please log in again.");
        setLoading(false);
        return;
      }

      const response = await fetch("/api/admissions/deposit/settle", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          admissionId,
          billId,
          refundType,
          refundAmount: refNum,
          deductedAmount: dedNum,
          deductionReason: deductionReason.trim(),
          refundMethod,
          settlementDate,
          notes: notes.trim(),
        }),
      });

      const resData = (await response.json().catch(() => null)) as {
        success?: boolean;
        message?: string;
        settlement?: DepositSettlementRecord;
        error?: string;
      } | null;

      if (!response.ok || !resData?.success) {
        setError(resData?.error || "Failed to settle security deposit.");
        setLoading(false);
        return;
      }

      if (resData.settlement) {
        onSettled(resData.settlement);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setLoading(false);
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in">
      <div className="w-full max-w-xl rounded-3xl bg-white p-6 sm:p-8 shadow-2xl ring-1 ring-black/5 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-start justify-between pb-4 border-b border-slate-100">
          <div>
            <span className="text-xs font-bold uppercase tracking-wider text-indigo-600">
              Security Deposit Settlement
            </span>
            <h2 className="mt-1 text-2xl font-bold text-slate-900">
              Release Deposit Payment
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Resident: <strong className="text-slate-900">{residentName}</strong>
              {roomBedLabel && (
                <span className="text-slate-400"> ({roomBedLabel})</span>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition"
          >
            ✕
          </button>
        </div>

        {/* Deposit Summary Card */}
        <div className="my-5 flex items-center justify-between rounded-2xl bg-indigo-50/70 border border-indigo-100 p-4">
          <div>
            <p className="text-xs font-medium text-indigo-700">Total Security Deposit</p>
            <p className="text-2xl font-black text-indigo-950 mt-0.5">
              {formatMoney(depositAmount)}
            </p>
          </div>
          <span className="rounded-full bg-indigo-600 text-white px-3 py-1 text-xs font-semibold">
            Status: Held
          </span>
        </div>

        {error && (
          <div className="mb-5 rounded-xl bg-red-50 border border-red-200 p-3.5 text-sm font-medium text-red-700">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* 3 Refund Options */}
          <div>
            <label className="block text-sm font-bold text-slate-900 mb-2.5">
              Select Release / Refund Option:
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {/* Option 1: Fully Refunded */}
              <button
                type="button"
                onClick={() => handleRefundTypeChange("Fully Refunded")}
                className={`relative flex flex-col p-4 rounded-2xl border text-left transition ${
                  refundType === "Fully Refunded"
                    ? "border-emerald-500 bg-emerald-50/80 ring-2 ring-emerald-500/20"
                    : "border-slate-200 bg-white hover:border-slate-300"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xl">💰</span>
                  <input
                    type="radio"
                    name="refundType"
                    checked={refundType === "Fully Refunded"}
                    onChange={() => handleRefundTypeChange("Fully Refunded")}
                    className="text-emerald-600 focus:ring-emerald-500"
                  />
                </div>
                <span className="mt-2 text-sm font-bold text-slate-900">
                  Fully Refunded
                </span>
                <span className="mt-1 text-xs text-slate-500 line-clamp-2">
                  Return 100% of the deposit to resident.
                </span>
              </button>

              {/* Option 2: Partially Refunded */}
              <button
                type="button"
                onClick={() => handleRefundTypeChange("Partially Refunded")}
                className={`relative flex flex-col p-4 rounded-2xl border text-left transition ${
                  refundType === "Partially Refunded"
                    ? "border-purple-500 bg-purple-50/80 ring-2 ring-purple-500/20"
                    : "border-slate-200 bg-white hover:border-slate-300"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xl">⚖️</span>
                  <input
                    type="radio"
                    name="refundType"
                    checked={refundType === "Partially Refunded"}
                    onChange={() => handleRefundTypeChange("Partially Refunded")}
                    className="text-purple-600 focus:ring-purple-500"
                  />
                </div>
                <span className="mt-2 text-sm font-bold text-slate-900">
                  Partially Refunded
                </span>
                <span className="mt-1 text-xs text-slate-500 line-clamp-2">
                  Refund part and deduct remainder for dues/damages.
                </span>
              </button>

              {/* Option 3: No Refund */}
              <button
                type="button"
                onClick={() => handleRefundTypeChange("No Refund")}
                className={`relative flex flex-col p-4 rounded-2xl border text-left transition ${
                  refundType === "No Refund"
                    ? "border-rose-500 bg-rose-50/80 ring-2 ring-rose-500/20"
                    : "border-slate-200 bg-white hover:border-slate-300"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xl">🚫</span>
                  <input
                    type="radio"
                    name="refundType"
                    checked={refundType === "No Refund"}
                    onChange={() => handleRefundTypeChange("No Refund")}
                    className="text-rose-600 focus:ring-rose-500"
                  />
                </div>
                <span className="mt-2 text-sm font-bold text-slate-900">
                  No Refund
                </span>
                <span className="mt-1 text-xs text-slate-500 line-clamp-2">
                  Forfeit deposit with Rs. 0 refund.
                </span>
              </button>
            </div>
          </div>

          {/* Amount Breakdown & Reason Fields */}
          <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Refund to Resident (PKR)
                </label>
                <input
                  type="number"
                  min="0"
                  max={depositAmount}
                  step="1"
                  value={refundAmount}
                  onChange={(e) => handleRefundAmountChange(e.target.value)}
                  disabled={refundType === "Fully Refunded" || refundType === "No Refund"}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-bold text-slate-900 disabled:bg-slate-100 disabled:text-slate-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Deducted / Withheld (PKR)
                </label>
                <input
                  type="number"
                  min="0"
                  max={depositAmount}
                  step="1"
                  value={deductedAmount}
                  onChange={(e) => handleDeductedAmountChange(e.target.value)}
                  disabled={refundType === "Fully Refunded" || refundType === "No Refund"}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-bold text-slate-900 disabled:bg-slate-100 disabled:text-slate-500"
                />
              </div>
            </div>

            {/* Deduction Reason input if deducted > 0 */}
            {(refundType === "Partially Refunded" || refundType === "No Refund") && (
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1">
                  Deduction Reason / Policy Rule <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={deductionReason}
                  onChange={(e) => setDeductionReason(e.target.value)}
                  placeholder={
                    refundType === "No Refund"
                      ? "e.g., 30-day notice rule violated, room damages, or forfeiture"
                      : "e.g., Rs. 2,000 for paint touchup, Rs. 3,000 unpaid utility dues"
                  }
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400"
                />
              </div>
            )}
          </div>

          {/* Settlement Details */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Release / Refund Date
              </label>
              <input
                type="date"
                required
                value={settlementDate}
                onChange={(e) => setSettlementDate(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900"
              />
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1">
                Payment / Refund Method
              </label>
              <select
                value={refundMethod}
                onChange={(e) => setRefundMethod(e.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900"
              >
                <option value="Cash">Cash</option>
                <option value="Bank Transfer">Bank Transfer</option>
                <option value="Online / Raast">Online / Raast</option>
                <option value="Cheque">Cheque</option>
                <option value="Adjustment to Dues">Adjustment to Dues</option>
                <option value="Other">Other</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-1">
              Internal Settlement Notes (Optional)
            </label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g., Resident signed clearance form, room key handed over to reception."
              className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2 text-sm text-slate-900 placeholder:text-slate-400"
            />
          </div>

          {/* Action buttons */}
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="rounded-xl px-5 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-100 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="rounded-xl bg-indigo-600 px-6 py-2.5 text-sm font-bold text-white hover:bg-indigo-700 shadow-md transition disabled:opacity-50"
            >
              {loading ? "Processing..." : `Confirm ${refundType}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
