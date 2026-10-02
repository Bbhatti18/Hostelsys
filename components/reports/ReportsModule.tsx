"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { REPORT_COLUMNS, reportDate, paymentCollectionBreakdown } from "@/lib/reportData";
import { normalizeBedLabel } from "@/lib/bedLabels";
import { deriveBillStatus, roundMoney } from "@/lib/financials";
import { BED_STATUS, isVacantBedStatus } from "@/lib/statuses";
import { supabase } from "@/lib/supabase";
import { getSupabaseErrorMessage } from "@/lib/supabaseErrors";

type Row = Record<string, unknown>;
type ReportType =
  | "Admissions"
  | "Residents"
  | "Occupancy"
  | "Contracts"
  | "Billing"
  | "Payments"
  | "Inspections"
  | "Maintenance"
  | "Notices";
type Amounts = {
  billed?: number;
  paid?: number;
  outstanding?: number;
  estimated?: number;
  actual?: number;
};
type ReportRecord = {
  id: string;
  date: string;
  status: string;
  residentIds: string[];
  roomIds: string[];
  cells: Record<string, string>;
  amounts?: Amounts;
};

const REPORT_TYPES: ReportType[] = [
  "Admissions",
  "Residents",
  "Occupancy",
  "Contracts",
  "Billing",
  "Payments",
  "Inspections",
  "Maintenance",
  "Notices",
];
const inputClass =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100";
const text = (value: unknown) => (value == null ? "" : String(value));
const normalized = (value: unknown) => text(value).trim().toLowerCase();
const day = (value: unknown) => text(value).slice(0, 10);
const numberValue = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const first = (row: Row | undefined, keys: string[], fallback = "—") =>
  keys.map((key) => text(row?.[key]).trim()).find(Boolean) || fallback;
const money = (value: unknown) =>
  new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(numberValue(value));
const csv = (value: string) => '"' + value.replace(/"/g, '""') + '"';
const latestFirst = (left: Row, right: Row) =>
  day(right.admission_date ?? right.created_at).localeCompare(
    day(left.admission_date ?? left.created_at),
  );

export default function ReportsModule() {
  const [reportType, setReportType] = useState<ReportType>("Admissions");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [residentFilter, setResidentFilter] = useState("");
  const [roomFilter, setRoomFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [residents, setResidents] = useState<Row[]>([]);
  const [rooms, setRooms] = useState<Row[]>([]);
  const [beds, setBeds] = useState<Row[]>([]);
  const [admissions, setAdmissions] = useState<Row[]>([]);
  const [contracts, setContracts] = useState<Row[]>([]);
  const [bills, setBills] = useState<Row[]>([]);
  const [payments, setPayments] = useState<Row[]>([]);
  const [inspections, setInspections] = useState<Row[]>([]);
  const [legacyInspections, setLegacyInspections] = useState<Row[]>([]);
  const [maintenance, setMaintenance] = useState<Row[]>([]);
  const [notices, setNotices] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    const results = await Promise.all([
      supabase.from("residents").select(REPORT_COLUMNS.residents),
      supabase.from("rooms").select(REPORT_COLUMNS.rooms),
      supabase.from("beds").select(REPORT_COLUMNS.beds),
      supabase.from("admissions").select(REPORT_COLUMNS.admissions),
      supabase.from("contracts").select(REPORT_COLUMNS.contracts),
      supabase.from("bills").select(REPORT_COLUMNS.bills),
      supabase.from("payments").select(REPORT_COLUMNS.payments),
      supabase.from("room_inspections").select(REPORT_COLUMNS.room_inspections),
      supabase.from("inspections").select(REPORT_COLUMNS.inspections),
      supabase.from("maintenance_requests").select(REPORT_COLUMNS.maintenance_requests),
      supabase.from("notices").select("*"),
    ]);
    const failed = results.find((result) => result.error)?.error;
    if (failed) {
      setError(
        getSupabaseErrorMessage(
          failed,
          "Report data could not be loaded. Please refresh and try again.",
        ),
      );
    } else {
      const setters = [
        setResidents,
        setRooms,
        setBeds,
        setAdmissions,
        setContracts,
        setBills,
        setPayments,
        setInspections,
        setLegacyInspections,
        setMaintenance,
        setNotices,
      ];
      setters.forEach((setter, index) =>
        setter((results[index].data ?? []) as Row[]),
      );
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timeout);
  }, [refresh]);

  const residentMap = useMemo(
    () =>
      new Map(
        residents.map((row) => [
          text(row.id),
          first(row, ["full_name"], "Unknown resident"),
        ]),
      ),
    [residents],
  );
  const roomMap = useMemo(
    () =>
      new Map(
        rooms.map((row) => [
          text(row.id),
          first(row, ["room_number"], "Unknown room"),
        ]),
      ),
    [rooms],
  );
  const bedMap = useMemo(
    () =>
      new Map(
        beds.map((row) => [
          text(row.id),
          normalizeBedLabel(first(row, ["bed_number"], "Bed")),
        ]),
      ),
    [beds],
  );
  const verifiedByBill = useMemo(() => {
    const totals = new Map<string, number>();
    for (const payment of payments) {
      if (normalized(payment.payment_status) !== "verified") continue;
      const billId = text(payment.bill_id);
      if (!billId) continue;
      totals.set(
        billId,
        roundMoney((totals.get(billId) ?? 0) + numberValue(payment.amount)),
      );
    }
    return totals;
  }, [payments]);

  const records = useMemo<ReportRecord[]>(() => {
    const residentName = (id: string) => residentMap.get(id) || "—";
    const roomName = (id: string) => roomMap.get(id) || "—";

    if (reportType === "Admissions") {
      return admissions.map((row) => ({
        id: text(row.id),
        date: day(row.admission_date ?? row.created_at),
        status: first(row, ["status"]),
        residentIds: [text(row.resident_id)].filter(Boolean),
        roomIds: [text(row.room_id)].filter(Boolean),
        cells: {
          Admission: first(row, ["admission_number"]),
          Resident: residentName(text(row.resident_id)),
          Room: roomName(text(row.room_id)),
          Bed: bedMap.get(text(row.bed_id)) || "—",
          "Admission Date": day(row.admission_date) || "—",
          "Expected Leaving":
            day(row.expected_leaving_date) || "—",
          Rent: money(row.monthly_rent),
          "Security Deposit": money(row.security_deposit),
          Status: first(row, ["status"]),
        },
      }));
    }

    if (reportType === "Residents") {
      return residents.map((row) => ({
        id: text(row.id),
        date: day(row.created_at),
        status: first(row, ["status"], "Active"),
        residentIds: [text(row.id)],
        roomIds: admissions
          .filter((admission) => text(admission.resident_id) === text(row.id))
          .map((admission) => text(admission.room_id))
          .filter(Boolean),
        cells: {
          "Resident Code": first(row, ["resident_code"]),
          Resident: first(row, ["full_name"]),
          Email: first(row, ["email"]),
          Phone: first(row, ["phone"]),
          "CNIC / Passport": first(row, ["cnic"]),
          Status: first(row, ["status"], "Active"),
          "Created Date": day(row.created_at) || "—",
        },
      }));
    }

    if (reportType === "Occupancy") {
      return rooms.flatMap((room) => {
        const roomId = text(room.id);
        const roomBeds = beds.filter((bed) => text(bed.room_id) === roomId);
        if (!roomBeds.length) {
          return [{
            id: "room-" + roomId,
            date: "",
            status: "No Beds",
            residentIds: [],
            roomIds: [roomId],
            cells: {
              Room: roomName(roomId),
              Bed: "No bed records",
              "Bed Status": "No Beds",
              "Current Resident": "—",
              "Current Admission": "—",
              "Admission Status": "—",
              "Latest Historical Status": "No history",
            },
          }];
        }

        return roomBeds.map((bed) => {
          const bedAdmissions = admissions
            .filter((admission) => text(admission.bed_id) === text(bed.id))
            .sort(latestFirst);
          const currentAdmission =
            bedAdmissions.find(
              (admission) => normalized(admission.status) === "active",
            ) ??
            bedAdmissions.find(
              (admission) => normalized(admission.status) === "pending",
            );
          const latestAdmission = bedAdmissions[0];
          return {
            id: text(bed.id),
            date: "",
            status: first(bed, ["status"]),
            residentIds: Array.from(
              new Set(
                bedAdmissions
                  .map((admission) => text(admission.resident_id))
                  .filter(Boolean),
              ),
            ),
            roomIds: [roomId],
            cells: {
              Room: roomName(roomId),
              Bed: normalizeBedLabel(first(bed, ["bed_number"], "Bed")),
              "Bed Status": first(bed, ["status"]),
              "Current Resident": currentAdmission
                ? residentName(text(currentAdmission.resident_id))
                : "—",
              "Current Admission": currentAdmission
                ? first(
                    currentAdmission,
                    ["admission_number"],
                    text(currentAdmission.id),
                  )
                : "—",
              "Admission Status": currentAdmission
                ? first(currentAdmission, ["status"])
                : "None",
              "Latest Historical Status": latestAdmission
                ? first(latestAdmission, ["status"])
                : "No history",
            },
          };
        });
      });
    }

    if (reportType === "Contracts") {
      return contracts.map((row) => {
        const admission = admissions.find(
          (item) => text(item.id) === text(row.admission_id),
        );
        const roomId = text(admission?.room_id);
        return {
          id: text(row.id),
          date: day(row.start_date ?? row.created_at),
          status: first(row, ["status"]),
          residentIds: [text(row.resident_id)].filter(Boolean),
          roomIds: [roomId].filter(Boolean),
          cells: {
            Contract: first(row, ["contract_number"]),
            Resident: residentName(text(row.resident_id)),
            Room: roomName(roomId),
            "Start Date": day(row.start_date) || "—",
            "End Date": day(row.end_date) || "—",
            Rent: money(row.monthly_rent),
            "Resident Signature": first(
              row,
              ["resident_signature_status"],
              row.signed_by_resident ? "Signed" : "Pending",
            ),
            "Owner Signature": first(
              row,
              ["owner_signature_status"],
              "Pending",
            ),
            Status: first(row, ["status"]),
          },
        };
      });
    }

    if (reportType === "Billing") {
      return bills.map((row) => {
        const billId = text(row.id);
        const admission = admissions.find(
          (item) => text(item.id) === text(row.admission_id),
        );
        const total = roundMoney(numberValue(row.total_amount));
        const paid = verifiedByBill.get(billId) ?? 0;
        const sourceStatus = normalized(row.bill_status);
        const historicalFinancialRecord = ["cancelled", "archived", "draft", "pending approval"].includes(
          sourceStatus,
        );
        const outstanding = historicalFinancialRecord
          ? 0
          : Math.max(roundMoney(total - paid), 0);
        const status = historicalFinancialRecord
          ? first(row, ["bill_status"])
          : deriveBillStatus(
              total,
              paid,
              text(row.due_date) || null,
              text(row.bill_status),
            );
        const billTypes = [
          numberValue(row.rent_amount) > 0 ? "Rent" : "",
          numberValue(row.electricity_amount) > 0 ? "Electricity" : "",
          numberValue(row.ac_amount) > 0 ? "AC" : "",
          numberValue(row.other_amount) > 0 ? "Other" : "",
        ].filter(Boolean);
        return {
          id: billId,
          date: reportDate({ billing_month: text(row.billing_month), created_at: text(row.created_at) }, "bills"),
          status,
          residentIds: [text(row.resident_id)].filter(Boolean),
          roomIds: [text(admission?.room_id)].filter(Boolean),
          amounts: { billed: total, paid, outstanding },
          cells: {
            Bill: first(row, ["bill_number"]),
            Month: text(row.billing_month) || "—",
            Resident: residentName(text(row.resident_id)),
            Room: roomName(text(admission?.room_id)),
            "Billing Type": row.bill_type === "Security Deposit" ? "Security Deposit" : billTypes.join(", ") || "Unspecified",
            Rent: money(row.rent_amount),
            Electricity: money(row.electricity_amount),
            AC: money(row.ac_amount),
            Other: money(row.other_amount),
            Discount: money(row.discount_amount),
            Billed: money(total),
            "Verified Paid": money(paid),
            Outstanding: historicalFinancialRecord
              ? "Not applicable"
              : money(outstanding),
            "Due Date": day(row.due_date) || "—",
            Status: status,
          },
        };
      });
    }

    if (reportType === "Payments") {
      return payments.map((row) => {
        const split = paymentCollectionBreakdown(row, bills);
        const bill = bills.find(
          (item) => text(item.id) === text(row.bill_id),
        );
        const admission = admissions.find(
          (item) => text(item.id) === text(bill?.admission_id),
        );
        return {
          id: text(row.id),
          date: day(row.payment_date ?? row.created_at),
          status: first(row, ["payment_status"]),
          residentIds: [text(row.resident_id)].filter(Boolean),
          roomIds: [text(admission?.room_id)].filter(Boolean),
          amounts: {
            paid:
              normalized(row.payment_status) === "verified"
                ? numberValue(row.amount)
                : 0,
          },
          cells: {
            Payment: first(row, ["payment_number"]),
            Date: day(row.payment_date ?? row.created_at) || "—",
            Bill: first(bill, ["bill_number"]),
            Resident: residentName(text(row.resident_id)),
            Room: roomName(text(admission?.room_id)),
            Method: first(row, ["payment_method"]),
            Reference: first(row, ["reference_number"]),
            Amount: money(row.amount),
            "Verified Rent Bill Allocation": money(split.rent),
            "Verified Deposit Allocation": money(split.deposit),
            "Verified Other Charges Allocation": money(split.other),
            "Verification Status": first(
              row,
              ["payment_status"],
            ),
            "Verified Date": day(row.verified_at) || "—",
          },
        };
      });
    }

    if (reportType === "Inspections") {
      const current = inspections.map((row) => {
        const damageFound =
          row.damage_found === true || normalized(row.damage_found) === "true";
        const estimated = numberValue(row.estimated_damage_cost);
        const actual = numberValue(row.actual_damage_cost);
        return {
          id: text(row.id),
          date: day(row.inspection_date),
          status: first(row, ["status"], "Completed"),
          residentIds: [text(row.resident_id)].filter(Boolean),
          roomIds: [text(row.room_id)].filter(Boolean),
          amounts: { estimated, actual },
          cells: {
            Inspection: first(
              row,
              ["inspection_number"],
              text(row.id),
            ),
            Date: day(row.inspection_date) || "—",
            Resident: residentName(text(row.resident_id)),
            Room: roomName(text(row.room_id)),
            Bed: bedMap.get(text(row.bed_id)) || "—",
            Type: first(row, ["inspection_type"]),
            Condition: first(row, ["overall_status"]),
            "Damage Found": damageFound ? "Yes" : "No",
            Damage: damageFound
              ? first(row, ["damage_description"], "Recorded")
              : "None",
            "Estimated Damage Cost": money(estimated),
            "Actual Damage Cost":
              row.actual_damage_cost == null ? "Unavailable" : money(actual),
            Status: first(row, ["status"], "Completed"),
          },
        };
      });
      const historical = legacyInspections.map((row) => ({
        id: "legacy-" + text(row.id),
        date: day(row.inspection_date),
        status: "Historical",
        residentIds: [text(row.resident_id)].filter(Boolean),
        roomIds: [text(row.room_id)].filter(Boolean),
        cells: {
          Inspection: text(row.id),
          Date: day(row.inspection_date) || "—",
          Resident: residentName(text(row.resident_id)),
          Room: roomName(text(row.room_id)),
          Bed: "—",
          Type: "Legacy",
          Condition: "—",
          "Damage Found": first(row, ["damage_notes"], "") ? "Recorded" : "—",
          Damage: first(row, ["damage_notes"], "None recorded"),
          "Estimated Damage Cost": "Unavailable",
          "Actual Damage Cost": "Unavailable",
          Status: "Historical",
        },
      }));
      return [...current, ...historical];
    }

    if (reportType === "Maintenance") {
      return maintenance.map((row) => {
        const estimated = numberValue(row.estimated_cost);
        const actual = numberValue(row.actual_cost);
        return {
          id: text(row.id),
          date: day(row.complaint_date ?? row.created_at),
          status: first(row, ["status"]),
          residentIds: [text(row.resident_id)].filter(Boolean),
          roomIds: [text(row.room_id)].filter(Boolean),
          amounts: { estimated, actual },
          cells: {
            Request: first(row, ["request_number"]),
            "Reported Date": day(row.complaint_date ?? row.created_at) || "—",
            "Completion Date":
              day(row.completion_date ?? row.completed_at) || "—",
            Resident: residentName(text(row.resident_id)),
            Room: roomName(text(row.room_id)),
            Bed: bedMap.get(text(row.bed_id)) || "—",
            Category: first(row, ["category"]),
            Priority: first(row, ["priority"]),
            Description: first(
              row,
              ["description"],
            ),
            Assigned: first(row, ["assigned_to"], "Not assigned"),
            "Estimated Cost": money(estimated),
            "Actual Cost": money(actual),
            Status: first(row, ["status"]),
          },
        };
      });
    }

    return notices.map((row) => {
      const audience = first(row, ["audience"], "Legacy");
      const residentId = text(row.resident_id);
      const roomId = text(row.room_id);
      const target =
        residentId
          ? residentName(residentId)
          : roomId
            ? roomName(roomId)
            : audience;
      return {
        id: text(row.id),
        date: day(row.publish_date ?? row.created_at),
        status: first(row, ["status"], "Legacy"),
        residentIds: [residentId].filter(Boolean),
        roomIds: [roomId].filter(Boolean),
        cells: {
          Notice: first(row, ["notice_number"], text(row.id)),
          Title: first(row, ["title"]),
          Type: first(row, ["notice_type"], "General"),
          Priority: first(row, ["priority"], "Normal"),
          Audience: audience,
          Target: target,
          "Publish Date": day(row.publish_date) || "—",
          "Expiry Date": day(row.expiry_date) || "No expiry",
          Popup: row.show_as_popup === true ? "Yes" : "No",
          Pinned: row.pinned === true ? "Yes" : "No",
          Status: first(row, ["status"], "Legacy"),
        },
      };
    });
  }, [
    admissions,
    bedMap,
    beds,
    bills,
    contracts,
    inspections,
    legacyInspections,
    maintenance,
    notices,
    payments,
    reportType,
    residentMap,
    residents,
    roomMap,
    rooms,
    verifiedByBill,
  ]);

  const supportsDate = reportType !== "Occupancy";
  const supportsResident = !["Residents", "Notices"].includes(reportType);
  const supportsRoom = !["Residents", "Notices"].includes(reportType);
  const statuses = useMemo(
    () =>
      Array.from(
        new Set(records.map((record) => record.status).filter(Boolean)),
      ).sort(),
    [records],
  );
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return records.filter(
      (record) =>
        (!supportsDate || !fromDate || !record.date || record.date >= fromDate) &&
        (!supportsDate || !toDate || !record.date || record.date <= toDate) &&
        (!supportsResident ||
          !residentFilter ||
          record.residentIds.includes(residentFilter)) &&
        (!supportsRoom ||
          !roomFilter ||
          record.roomIds.includes(roomFilter)) &&
        (!statusFilter ||
          normalized(record.status) === normalized(statusFilter)) &&
        (!query ||
          Object.values(record.cells).join(" ").toLowerCase().includes(query)),
    );
  }, [
    fromDate,
    records,
    residentFilter,
    roomFilter,
    search,
    statusFilter,
    supportsDate,
    supportsResident,
    supportsRoom,
    toDate,
  ]);

  const summary = useMemo(() => {
    const count = (status: string) =>
      filtered.filter(
        (record) => normalized(record.status) === normalized(status),
      ).length;
    if (reportType === "Residents") {
      return [
        { label: "Filtered Records", value: filtered.length },
        { label: "Active", value: count("Active") },
        { label: "Archived", value: count("Archived") },
      ];
    }
    if (reportType === "Occupancy") {
      return [
        { label: "Bed Records", value: filtered.length },
        {
          label: "Occupied",
          value: filtered.filter(
            (record) =>
              record.cells["Bed Status"] === BED_STATUS.OCCUPIED,
          ).length,
        },
        {
          label: "Vacant",
          value: filtered.filter((record) =>
            isVacantBedStatus(record.cells["Bed Status"]),
          ).length,
        },
      ];
    }
    if (reportType === "Billing") {
      const operational = filtered.filter(
        (record) =>
          !["cancelled", "archived"].includes(normalized(record.status)),
      );
      return [
        { label: "Filtered Bills", value: filtered.length },
        {
          label: "Operational Billed",
          value: money(
            operational.reduce(
              (sum, record) => sum + (record.amounts?.billed ?? 0),
              0,
            ),
          ),
        },
        {
          label: "Verified Paid",
          value: money(
            operational.reduce(
              (sum, record) => sum + (record.amounts?.paid ?? 0),
              0,
            ),
          ),
        },
        {
          label: "Outstanding",
          value: money(
            operational.reduce(
              (sum, record) => sum + (record.amounts?.outstanding ?? 0),
              0,
            ),
          ),
        },
      ];
    }
    if (reportType === "Payments") {
      const verified = filtered.filter(
        (record) => normalized(record.status) === "verified",
      );
      return [
        { label: "Filtered Payments", value: filtered.length },
        { label: "Verified", value: verified.length },
        { label: "Pending", value: count("Pending") },
        {
          label: "Verified Amount",
          value: money(
            verified.reduce(
              (sum, record) => sum + (record.amounts?.paid ?? 0),
              0,
            ),
          ),
        },
      ];
    }
    if (reportType === "Inspections") {
      return [
        { label: "Filtered Inspections", value: filtered.length },
        {
          label: "Damage Found",
          value: filtered.filter(
            (record) => record.cells["Damage Found"] === "Yes",
          ).length,
        },
        {
          label: "Actual Damage Cost",
          value: money(
            filtered.reduce(
              (sum, record) => sum + (record.amounts?.actual ?? 0),
              0,
            ),
          ),
        },
      ];
    }
    if (reportType === "Maintenance") {
      return [
        { label: "Filtered Requests", value: filtered.length },
        { label: "Open", value: count("Open") + count("Pending") },
        { label: "In Progress", value: count("In Progress") },
        { label: "Completed", value: count("Completed") },
      ];
    }
    if (reportType === "Notices") {
      return [
        { label: "Filtered Notices", value: filtered.length },
        { label: "Published", value: count("Published") },
        { label: "Draft", value: count("Draft") },
        { label: "Archived", value: count("Archived") },
      ];
    }
    return [
      { label: "Filtered Records", value: filtered.length },
      { label: "Active", value: count("Active") },
      { label: "Pending", value: count("Pending") },
      { label: "Cancelled", value: count("Cancelled") },
    ];
  }, [filtered, reportType]);

  function exportCsv() {
    if (!filtered.length) {
      window.alert("No report data is available for the selected filters.");
      return;
    }
    const headers = Object.keys(filtered[0].cells);
    const lines = [
      headers.map(csv).join(","),
      ...filtered.map((record) =>
        headers.map((header) => csv(record.cells[header] ?? "")).join(","),
      ),
    ];
    const url = URL.createObjectURL(
      new Blob(["\uFEFF" + lines.join("\r\n")], {
        type: "text/csv;charset=utf-8",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download =
      reportType.toLowerCase().replace(/\s+/g, "-") +
      "-report-" +
      new Date().toISOString().slice(0, 10) +
      ".csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function changeReport(value: ReportType) {
    setReportType(value);
    setFromDate("");
    setToDate("");
    setStatusFilter("");
    setResidentFilter("");
    setRoomFilter("");
    setSearch("");
  }

  const headers = Object.keys(filtered[0]?.cells ?? records[0]?.cells ?? {});

  return (
    <main className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8 print:bg-white print:p-0">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm print:border-0 print:shadow-none">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">
            University Girls Hostel
          </p>
          <h1 className="mt-2 text-3xl font-bold">Reports</h1>
          <p className="mt-1 text-sm text-slate-500">
            Review, filter, export, and print existing operational records.
          </p>
        </section>

        {error && (
          <p className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-700">
            {error}
          </p>
        )}

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 print:hidden">
          {summary.map((item) => (
            <StatCard
              key={item.label}
              label={item.label}
              value={String(item.value)}
            />
          ))}
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm print:hidden">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Field label="Report Type">
              <select
                value={reportType}
                onChange={(event) =>
                  changeReport(event.target.value as ReportType)
                }
                className={inputClass}
              >
                {REPORT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type} Report
                  </option>
                ))}
              </select>
            </Field>

            {supportsDate && (
              <>
                <Field label="From Date">
                  <input
                    type="date"
                    value={fromDate}
                    onChange={(event) => setFromDate(event.target.value)}
                    className={inputClass}
                  />
                </Field>
                <Field label="To Date">
                  <input
                    type="date"
                    value={toDate}
                    onChange={(event) => setToDate(event.target.value)}
                    className={inputClass}
                  />
                </Field>
              </>
            )}

            <Field label="Status">
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
                className={inputClass}
              >
                <option value="">All Statuses</option>
                {statuses.map((status) => (
                  <option key={status}>{status}</option>
                ))}
              </select>
            </Field>

            {supportsResident && (
              <Field label="Resident">
                <select
                  value={residentFilter}
                  onChange={(event) => setResidentFilter(event.target.value)}
                  className={inputClass}
                >
                  <option value="">All Residents</option>
                  {residents.map((resident) => (
                    <option key={text(resident.id)} value={text(resident.id)}>
                      {first(resident, ["full_name"])}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            {supportsRoom && (
              <Field label="Room">
                <select
                  value={roomFilter}
                  onChange={(event) => setRoomFilter(event.target.value)}
                  className={inputClass}
                >
                  <option value="">All Rooms</option>
                  {rooms.map((room) => (
                    <option key={text(room.id)} value={text(room.id)}>
                      {first(room, ["room_number"])}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <Field label="Search" wide>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search the current report"
                className={inputClass}
              />
            </Field>
          </div>

          <div className="mt-5 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-semibold"
            >
              Refresh Data
            </button>
            <button
              type="button"
              onClick={exportCsv}
              disabled={!filtered.length}
              className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              Export CSV
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              disabled={!filtered.length}
              className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              Print / Save PDF
            </button>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white shadow-sm print:border-0 print:shadow-none">
          <div className="border-b p-5">
            <h2 className="text-xl font-bold">{reportType} Report</h2>
            <p className="mt-1 text-sm text-slate-500">
              {supportsDate && (fromDate || toDate)
                ? (fromDate || "Beginning") +
                  " to " +
                  (toDate || "Present") +
                  " · "
                : ""}
              {filtered.length} record(s)
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  {headers.map((header) => (
                    <th
                      key={header}
                      className="whitespace-nowrap px-5 py-3 text-left text-xs font-bold uppercase text-slate-500"
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {loading ? (
                  <tr>
                    <td
                      colSpan={Math.max(headers.length, 1)}
                      className="p-10 text-center text-sm text-slate-500"
                    >
                      Loading report data...
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td
                      colSpan={Math.max(headers.length, 1)}
                      className="p-10 text-center text-sm text-slate-500"
                    >
                      No records found for the selected filters.
                    </td>
                  </tr>
                ) : (
                  filtered.map((record) => (
                    <tr
                      key={record.id}
                      className={
                        ["archived", "cancelled", "historical"].includes(
                          normalized(record.status),
                        )
                          ? "bg-slate-50"
                          : ""
                      }
                    >
                      {headers.map((header) => (
                        <td
                          key={record.id + "-" + header}
                          className="max-w-sm whitespace-pre-wrap px-5 py-4 align-top text-sm text-slate-700"
                        >
                          {record.cells[header] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}

function Field({
  label,
  wide = false,
  children,
}: {
  label: string;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={wide ? "md:col-span-2" : ""}>
      <span className="mb-2 block text-sm font-semibold text-slate-700">
        {label}
      </span>
      {children}
    </label>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold">{value}</p>
    </article>
  );
}
