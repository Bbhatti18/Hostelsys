"use client";

import { requireContractStaff, reviewContractSignature } from "@/lib/contractActions";
import Link from "next/link";
import {
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import AdmissionForm from "@/components/admissions/AdmissionForm";
import {
  compareBedRecordsAscending,
  normalizeBedLabel,
} from "@/lib/bedLabels";
import {
  isAdmissionActivationReady,
  isContractSignedAndAccepted,
  getAdmissionDeposit,
  getAdmissionRent,
  depositStateLabel,
} from "@/lib/contractWorkflow";
import { readDashboardRows } from "@/lib/dashboardRead";
import { supabase } from "@/lib/supabase";
import { getSupabaseErrorMessage } from "@/lib/supabaseErrors";
import {
  notificationWarning,
  requestEventNotification,
} from "@/lib/notifications/client";
import {
  ALLOCATABLE_BED_STATUSES,
  BED_STATUS,
  RESIDENT_STATUS,
  isAllocatableBedStatus,
} from "@/lib/statuses";

type AdmissionStatus =
  | "Active"
  | "Pending"
  | "Completed"
  | "Cancelled"
  | "Archived";

type DepositStatus = "Pending" | "Held" | "Released" | "Deducted";

type Resident = {
  id: string;
  full_name: string;
  status: string | null;
};

type Room = {
  id: string;
  room_number: string;
  status: string | null;
};

type Bed = {
  id: string;
  room_id: string;
  bed_number: string;
  status: string;
};

type Admission = {
  id: string;
  resident_id: string;
  room_id: string | null;
  bed_id: string | null;
  allocation_mode?: "single_bed" | "whole_room" | null;
  admission_date: string;
  expected_leaving_date: string | null;
  actual_leaving_date?: string | null;
  monthly_rent: number;
  security_deposit: number;
  deposit_status: DepositStatus;
  notice_period_days: number;
  status: AdmissionStatus;
  notes: string | null;
  created_at: string;
};

type AdmissionContract = {
  id: string;
  admission_id: string | null;
  status: string | null;
  resident_signature_url: string | null;
  resident_signature_status: string | null;
  signed_by_resident: boolean | null;
  signed_at: string | null;
  contract_content: string | null;
};

type AdmissionForm = {
  resident_id: string;
  room_id: string;
  bed_id: string;
  allocation_mode: "single_bed" | "whole_room";
  admission_date: string;
  expected_leaving_date: string;
  monthly_rent: string;
  security_deposit: string;
  deposit_status: DepositStatus;
  notice_period_days: string;
  status: Exclude<AdmissionStatus, "Archived">;
  notes: string;
};

const emptyForm: AdmissionForm = {
  resident_id: "",
  room_id: "",
  bed_id: "",
  allocation_mode: "single_bed",
  admission_date: "",
  expected_leaving_date: "",
  monthly_rent: "",
  security_deposit: "",
  deposit_status: "Pending",
  notice_period_days: "30",
  status: "Active",
  notes: "",
};

const inputClass =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-slate-100";

function admissionStatusClass(status: AdmissionStatus) {
  if (status === "Active") return "bg-emerald-100 text-emerald-700";
  if (status === "Pending") return "bg-amber-100 text-amber-700";
  if (status === "Completed") return "bg-blue-100 text-blue-700";
  if (status === "Archived") return "bg-slate-200 text-slate-700";
  return "bg-red-100 text-red-700";
}

function depositStatusClass(status: string) {
  if (status === "verified") return "bg-emerald-100 text-emerald-700";
  if (status === "not_required") return "bg-slate-100 text-slate-600";
  if (status === "Released") return "bg-blue-100 text-blue-700";
  if (status === "Deducted") return "bg-red-100 text-red-700";
  return "bg-amber-100 text-amber-700";
}

function money(value: number) {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(value || 0);
}

export default function AdmissionsPage() {
  const [admissions, setAdmissions] = useState<Admission[]>([]);
  const [residents, setResidents] = useState<Resident[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [beds, setBeds] = useState<Bed[]>([]);
  const [contracts, setContracts] = useState<AdmissionContract[]>([]);

  const [depositBills, setDepositBills] = useState<Record<string, unknown>[] | undefined>();
  const [depositPayments, setDepositPayments] = useState<Record<string, unknown>[] | undefined>();

  const [form, setForm] = useState<AdmissionForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showEditForm, setShowEditForm] = useState(false);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("Current");

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [lifecycleActionId, setLifecycleActionId] = useState<string | null>(null);

  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [admissionDataVersion, setAdmissionDataVersion] = useState(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");

    const [
      { data: admissionsData, error: admissionsError },
      { data: residentsData, error: residentsError },
      { data: roomsData, error: roomsError },
      { data: bedsData, error: bedsError },
      { data: contractsData, error: contractsError },
      billsResult,
      paymentsResult,
    ] = await Promise.all([
      supabase
        .from("admissions")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase
        .from("residents")
        .select("id, full_name, status")
        .order("full_name"),
      supabase
        .from("rooms")
        .select("id, room_number, status")
        .order("room_number"),
      supabase
        .from("beds")
        .select("id, room_id, bed_number, status")
        .order("bed_number"),
      supabase
        .from("contracts")
        .select(
          "id, admission_id, status, resident_signature_url, resident_signature_status, signed_by_resident, signed_at, contract_content",
        )
        .order("created_at", { ascending: false }),
      readDashboardRows(supabase.from("bills").select("*").in("bill_type", ["Rent", "Security Deposit"]).order("id")),
      readDashboardRows(supabase.from("payments").select("id, resident_id, bill_id, amount, payment_status, payment_allocations(bill_id, amount)").order("id")),
    ]);

    const firstError =
      admissionsError || residentsError || roomsError || bedsError || contractsError || billsResult.error || paymentsResult.error;

    if (firstError) {
      setError(
        getSupabaseErrorMessage(
          firstError,
          "Unable to load admissions. Please try again.",
        ),
      );
    }

    setDepositBills(billsResult.error ? undefined : billsResult.data ?? []);
    setDepositPayments(paymentsResult.error ? undefined : paymentsResult.data ?? []);
    setAdmissions((admissionsData ?? []) as Admission[]);
    setResidents((residentsData ?? []) as Resident[]);
    setRooms((roomsData ?? []) as Room[]);
    setBeds((bedsData ?? []) as Bed[]);
    setContracts((contractsData ?? []) as AdmissionContract[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    // Loading remote Supabase data is the external synchronization for this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();

    const url = new URL(window.location.href);
    if (url.searchParams.get("created") === "1") {
      setMessage("Admission saved successfully.");
      url.searchParams.delete("created");
      window.history.replaceState(null, "", `${url.pathname}${url.search}`);
    }
  }, [refresh]);

  const filteredBeds = useMemo(() => {
    if (!form.room_id) return [];
    const currentEditingBedId = editingId
      ? admissions.find((admission) => admission.id === editingId)?.bed_id ?? null
      : null;
    const otherExclusive = admissions.some(admission => admission.id !== editingId && admission.room_id === form.room_id && admission.allocation_mode === "whole_room");

    return beds
      .filter((bed) => bed.room_id === form.room_id)
      .sort(compareBedRecordsAscending)
      .map((bed) => {
        const isCurrentBed = bed.id === currentEditingBedId;
        const otherAdmission = admissions.find(
          (a) =>
            a.bed_id === bed.id &&
            a.id !== editingId &&
            (a.status === "Active" || a.status === "Pending"),
        );
        const occupantResident = otherAdmission
          ? residents.find((r) => r.id === otherAdmission.resident_id)
          : null;
        const isAllocatable =
          isCurrentBed ||
          (isAllocatableBedStatus(bed.status) && !otherAdmission && !otherExclusive &&
            (form.allocation_mode !== "whole_room" || !admissions.some(admission => admission.id !== editingId && admission.room_id === form.room_id)));

        return {
          ...bed,
          isCurrentBed,
          isAllocatable,
          occupantName: occupantResident?.full_name ?? null,
        };
      });
  }, [admissions, beds, editingId, form.room_id, residents]);

  const filteredAdmissions = useMemo(() => {
    const query = search.trim().toLowerCase();

    return admissions.filter((admission) => {
      const residentName =
        residents.find((resident) => resident.id === admission.resident_id)
          ?.full_name ?? "";

      const roomNumber =
        rooms.find((room) => room.id === admission.room_id)?.room_number ?? "";

      const bedNumber =
        beds.find((bed) => bed.id === admission.bed_id)?.bed_number ?? "";

      const matchesSearch =
        !query ||
        residentName.toLowerCase().includes(query) ||
        roomNumber.toLowerCase().includes(query) ||
        bedNumber.toLowerCase().includes(query);

      let matchesStatus = true;

      if (statusFilter === "Current") {
        matchesStatus = isCurrentAdmissionStatus(admission.status);
      } else if (statusFilter !== "All") {
        matchesStatus = admission.status === statusFilter;
      }

      return matchesSearch && matchesStatus;
    });
  }, [admissions, residents, rooms, beds, search, statusFilter]);

  const summary = useMemo(
    () => ({
      total: admissions.length,
      active: admissions.filter((item) => item.status === "Active")
        .length,
      pending: admissions.filter((item) => item.status === "Pending")
        .length,
      depositsHeld: admissions.filter(
        (item) => getAdmissionDeposit(item, depositBills, depositPayments).state === "verified"
      ).length,
    }),
    [admissions, depositBills, depositPayments]
  );

  function updateField<K extends keyof AdmissionForm>(
    key: K,
    value: AdmissionForm[K]
  ) {
    setForm((current) => ({
      ...current,
      [key]: value,
      ...(key === "room_id" || key === "allocation_mode" && value === "single_bed" ? { bed_id: "" } : {}),
    }));
  }

  function closeEditForm() {
    setShowEditForm(false);
    setEditingId(null);
    setForm(emptyForm);
    setError("");
  }

  function openEditForm(admission: Admission) {
    if (admission.status === "Archived") {
      setError("Archived admissions cannot be edited.");
      return;
    }

    setEditingId(admission.id);
    setForm({
      resident_id: admission.resident_id,
      room_id: admission.room_id ?? "",
      bed_id: admission.bed_id ?? "",
      allocation_mode: admission.allocation_mode === "whole_room" ? "whole_room" : "single_bed",
      admission_date: admission.admission_date,
      expected_leaving_date: admission.expected_leaving_date ?? "",
      monthly_rent: String(admission.monthly_rent ?? 0),
      security_deposit: String(admission.security_deposit ?? 0),
      deposit_status: admission.deposit_status,
      notice_period_days: String(admission.notice_period_days ?? 30),
      status: admission.status,
      notes: admission.notes ?? "",
    });

    setMessage("");
    setError("");
    setShowEditForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function saveAdmission(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!editingId) {
      setError("No admission selected for editing.");
      return;
    }

    if (
      !form.resident_id ||
      !form.room_id ||
      (form.allocation_mode === "single_bed" && !form.bed_id) ||
      !form.admission_date
    ) {
      setError(`Resident, room, ${form.allocation_mode === "single_bed" ? "bed, " : ""}and admission date are required.`);
      return;
    }

    setSaving(true);
    setMessage("");
    setError("");

    const { data: currentAdmissionData, error: currentAdmissionError } =
      await supabase
        .from("admissions")
        .select("*")
        .eq("id", editingId)
        .maybeSingle();

    if (currentAdmissionError || !currentAdmissionData) {
      setError(
        currentAdmissionError
          ? getSupabaseErrorMessage(
              currentAdmissionError,
              "Unable to verify this admission.",
            )
          : "Admission record could not be found.",
      );
      setSaving(false);
      return;
    }

    const previousAdmission = currentAdmissionData as Admission;
    const residentId = previousAdmission.resident_id;

    const nextStatus: AdmissionStatus = previousAdmission.status;
    const targetIsCurrent = isCurrentAdmissionStatus(nextStatus);
    const previousWasCurrent = isCurrentAdmissionStatus(
      previousAdmission.status,
    );
    const bedChanged = previousAdmission.bed_id !== (form.bed_id || null);

    const [
      residentResult,
      roomResult,
      selectedBedResult,
      duplicateResult,
      bedConflictResult,
    ] = await Promise.all([
        supabase
          .from("residents")
          .select("id, status")
          .eq("id", residentId)
          .maybeSingle(),
        supabase
          .from("rooms")
          .select("id, status")
          .eq("id", form.room_id)
          .maybeSingle(),
        form.bed_id
          ? supabase.from("beds").select("id, room_id, status").eq("id", form.bed_id).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        targetIsCurrent && form.bed_id
          ? supabase
              .from("admissions")
              .select("id")
              .eq("resident_id", residentId)
              .in("status", ["Active", "Pending"])
              .neq("id", editingId)
              .limit(1)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        targetIsCurrent
          ? supabase
              .from("admissions")
              .select("id")
              .eq("bed_id", form.bed_id)
              .in("status", ["Active", "Pending"])
              .neq("id", editingId)
              .limit(1)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);

    const validationError =
      residentResult.error ||
      roomResult.error ||
      selectedBedResult.error ||
      duplicateResult.error ||
      bedConflictResult.error;

    if (validationError) {
      setError(
        getSupabaseErrorMessage(
          validationError,
          "Unable to verify the admission details. Please try again.",
        ),
      );
      setSaving(false);
      return;
    }

    if (!residentResult.data || residentResult.data.status === "Archived") {
      setError("The selected resident is no longer available for admission.");
      await refresh();
      setSaving(false);
      return;
    }

    const roomIsCurrent = previousAdmission.room_id === form.room_id;
    if (
      !roomResult.data ||
      (!isAdmissionRoomStatus(roomResult.data.status) && !roomIsCurrent)
    ) {
      setError("The selected room is no longer available for admission.");
      await refresh();
      setSaving(false);
      return;
    }

    if (
      (form.allocation_mode === "single_bed" || form.bed_id) && (
        !selectedBedResult.data ||
        selectedBedResult.data.room_id !== form.room_id ||
        selectedBedResult.data.status === BED_STATUS.INACTIVE
      )
    ) {
      setError("The selected bed is not available for this admission.");
      await refresh();
      setSaving(false);
      return;
    }

    if (duplicateResult.data) {
      setError("This resident already has another current admission.");
      setSaving(false);
      return;
    }

    if (bedConflictResult.data) {
      setError("This bed belongs to another current admission.");
      await refresh();
      setSaving(false);
      return;
    }

    const payload = {
      resident_id: residentId,
      room_id: form.room_id || null,
      bed_id: form.bed_id || null,
      allocation_mode: form.allocation_mode,
      admission_date: form.admission_date,
      expected_leaving_date: form.expected_leaving_date || null,
      monthly_rent: Number(form.monthly_rent) || 0,
      security_deposit: Number(form.security_deposit) || 0,
      deposit_status: previousAdmission.deposit_status,
      notice_period_days: Number(form.notice_period_days) || 30,
      status: nextStatus,
      notes: form.notes.trim() || null,
      updated_at: new Date().toISOString(),
    };

    const needsNewBedClaim =
      targetIsCurrent &&
      form.allocation_mode === "single_bed" &&
      (bedChanged ||
        !previousWasCurrent ||
        selectedBedResult.data?.status !== BED_STATUS.OCCUPIED);

    if (needsNewBedClaim) {
      const { data: claimedBed, error: claimError } = await supabase
        .from("beds")
        .update({ status: BED_STATUS.OCCUPIED })
        .eq("id", form.bed_id)
        .eq("room_id", form.room_id)
        .in("status", [...ALLOCATABLE_BED_STATUSES])
        .select("id")
        .maybeSingle();

      if (claimError || !claimedBed) {
        setError(
          claimError
            ? getSupabaseErrorMessage(
                claimError,
                "Unable to allocate this bed. Please select another bed.",
              )
            : "This bed is no longer vacant. Please select another bed.",
        );
        await refresh();
        setSaving(false);
        return;
      }
    }

    const { data: updatedAdmission, error: updateError } = await supabase
      .from("admissions")
      .update(payload)
      .eq("id", editingId)
      .eq("status", previousAdmission.status)
      .select("id")
      .maybeSingle();

    if (updateError || !updatedAdmission) {
      if (needsNewBedClaim) {
        const { error: rollbackError } = await supabase
          .from("beds")
          .update({ status: BED_STATUS.VACANT })
          .eq("id", form.bed_id)
          .eq("status", BED_STATUS.OCCUPIED);

        if (rollbackError) {
          setError(
            "Admission was not updated, and the newly selected bed could not be released automatically. Please contact an administrator.",
          );
          await refresh();
          setSaving(false);
          return;
        }
      }
      setError(
        updateError
          ? getSupabaseErrorMessage(
              updateError,
              "Unable to update this admission. Please try again.",
            )
          : "The admission status changed before the update completed. Refresh and try again.",
      );
      setSaving(false);
      return;
    }

    if (
      previousWasCurrent &&
      previousAdmission.bed_id &&
      (bedChanged || !targetIsCurrent)
    ) {
      const oldBedError = await releaseBedWhenUnallocated(
        previousAdmission.bed_id,
      );

      if (oldBedError) {
        const { data: restoredAllocation, error: allocationRollbackError } =
          await supabase
            .from("admissions")
            .update({
              room_id: previousAdmission.room_id,
              bed_id: previousAdmission.bed_id,
              updated_at: new Date().toISOString(),
            })
            .eq("id", editingId)
            .eq("room_id", form.room_id)
            .eq("bed_id", form.bed_id)
            .select("id")
            .maybeSingle();

        if (allocationRollbackError || !restoredAllocation) {
          setError(
            "Admission updated, but the previous bed could not be released and the room move could not be rolled back. Please contact an administrator.",
          );
          await refresh();
          setSaving(false);
          return;
        }

        const { data: releasedNewBed, error: newBedReleaseError } =
          await supabase
            .from("beds")
            .update({ status: BED_STATUS.VACANT })
            .eq("id", form.bed_id)
            .eq("status", BED_STATUS.OCCUPIED)
            .select("id")
            .maybeSingle();

        setError(
          newBedReleaseError || !releasedNewBed
            ? "The room move was rolled back, but the newly selected bed could not be released automatically. Please contact an administrator."
            : "The previous bed could not be released, so the room and bed move was rolled back. Other admission changes were saved.",
        );
        await refresh();
        setSaving(false);
        return;
      }
    }
    setMessage("Admission updated successfully.");
    closeEditForm();
    await refresh();
    setAdmissionDataVersion((current) => current + 1);
    setSaving(false);
  }

  async function loadLifecycleContext(admissionId: string) {
      const { data: admission, error: admissionError } = await supabase
        .from("admissions")
        .select(
          "id, resident_id, room_id, bed_id, status, deposit_status, security_deposit, actual_leaving_date",
        )
      .eq("id", admissionId)
      .maybeSingle();

    if (admissionError) {
      throw new Error(
        getSupabaseErrorMessage(
          admissionError,
          "Unable to verify this admission.",
        ),
      );
    }

    if (!admission?.resident_id || !admission.room_id || !admission.bed_id) {
      throw new Error(
        "This admission does not have a complete resident, room, and bed allocation.",
      );
    }

    const [residentResult, roomResult, bedResult, contractResult] = await Promise.all([
      supabase
        .from("residents")
        .select("id, status")
        .eq("id", admission.resident_id)
        .maybeSingle(),
      supabase.from("rooms").select("id, status").eq("id", admission.room_id).maybeSingle(),
      supabase
        .from("beds")
        .select("id, room_id, status")
        .eq("id", admission.bed_id)
        .maybeSingle(),
      supabase
        .from("contracts")
        .select(
          "id, admission_id, status, resident_signature_url, resident_signature_status, signed_by_resident, signed_at, contract_content",
        )
        .eq("admission_id", admission.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const contextError =
      residentResult.error || roomResult.error || bedResult.error || contractResult.error;
    if (contextError) {
      throw new Error(
        getSupabaseErrorMessage(
          contextError,
          "Unable to verify the admission allocation.",
        ),
      );
    }

    if (!residentResult.data) {
      throw new Error("The admission resident no longer exists.");
    }

    if (!roomResult.data) {
      throw new Error("The assigned room no longer exists.");
    }

    if (
      !bedResult.data ||
      bedResult.data.room_id !== admission.room_id
    ) {
      throw new Error("The assigned bed no longer exists in this room.");
    }

    return {
      admission,
      bed: bedResult.data,
      room: roomResult.data,
      resident: residentResult.data,
      contract: contractResult.data as AdmissionContract | null,
    };
  }

  async function activateAdmission(admissionId: string) {
    setLifecycleActionId(admissionId);
    setMessage("");
    setError("");

    try {
      const { data, error: sessionError } = await supabase.auth.getSession();
      if (sessionError || !data.session) throw new Error("Your staff session could not be verified.");
      const response = await fetch("/api/admissions/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + data.session.access_token },
        body: JSON.stringify({ admissionId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to activate this admission.");
      setMessage(result.message);
      await refresh();
      setAdmissionDataVersion((current) => current + 1);
    } catch (activationError) {
      setError(
        activationError instanceof Error
          ? activationError.message
          : "Unable to activate this admission.",
      );
      await refresh();
      setAdmissionDataVersion((current) => current + 1);
    } finally {
      setLifecycleActionId(null);
    }
  }

  async function approveContractFromAdmission(admissionId: string) {
    const confirmed = window.confirm(
      "Approve the resident signature for this admission?",
    );
    if (!confirmed) return;

    setLifecycleActionId(admissionId);
    setMessage("");
    setError("");

    try {
      const { data: admission, error: admissionError } = await supabase
        .from("admissions")
        .select("id, status, deposit_status")
        .eq("id", admissionId)
        .maybeSingle();

      if (admissionError || !admission) {
        throw new Error(
          admissionError
            ? getSupabaseErrorMessage(
                admissionError,
                "Unable to verify this admission.",
              )
            : "The admission could not be found.",
        );
      }

      if (admission.status !== "Pending") {
        throw new Error(
          "Only a Pending admission can have its resident signature approved here.",
        );
      }

      const { data: currentContract, error: contractError } = await supabase
        .from("contracts")
        .select(
          "id, admission_id, status, resident_signature_url, resident_signature_status, signed_by_resident, signed_at, contract_content",
        )
        .eq("admission_id", admissionId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (contractError || !currentContract) {
        throw new Error(
          contractError
            ? getSupabaseErrorMessage(
                contractError,
                "Unable to verify the contract for this admission.",
              )
            : "No contract is linked to this admission.",
        );
      }

      if (
        (currentContract.status) !==
        "Pending Signature"
      ) {
        throw new Error(
          "Only a Pending Signature contract can be approved from Admissions.",
        );
      }

      const currentSignatureStatus =
        currentContract.resident_signature_status || "Pending";

      const hasStoredSignature = Boolean(
        (currentContract.resident_signature_url) &&
          currentContract.signed_by_resident &&
          currentContract.signed_at,
      );

      if (
        !["Submitted", "Signed"].includes(currentSignatureStatus) ||
        !hasStoredSignature
      ) {
        throw new Error(
          "Only a complete submitted resident signature can be approved.",
        );
      }

      await reviewContractSignature(currentContract.id, "Approved");

      const notificationResult = await requestEventNotification(
        "contract_approved",
        currentContract.id,
      );
      setMessage(`Resident signature approved. Activation still requires fully verified initial Rent, a satisfied deposit prerequisite, and a valid allocation; use Activate Admission as a separate staff action.${notificationWarning(notificationResult)}`);
      await refresh();
      setAdmissionDataVersion((current) => current + 1);
    } catch (approvalError) {
      setError(
        approvalError instanceof Error
          ? approvalError.message
          : "Unable to approve the resident signature.",
      );
      await refresh();
      setAdmissionDataVersion((current) => current + 1);
    } finally {
      setLifecycleActionId(null);
    }
  }

  async function finishAdmission(
    admissionId: string,
    nextStatus: "Completed" | "Cancelled",
  ) {
    const actionLabel = nextStatus === "Completed" ? "complete" : "cancel";
    const completedActionLabel =
      nextStatus === "Completed" ? "completed" : "cancelled";
    const confirmed = window.confirm(
      `${nextStatus === "Completed" ? "Complete" : "Cancel"} this admission? The record will be preserved and its bed will be released when safe.`,
    );
    if (!confirmed) return;

    setLifecycleActionId(admissionId);
    setMessage("");
    setError("");

    try {
      const context = await loadLifecycleContext(admissionId);
      const allowed =
        nextStatus === "Completed"
          ? context.admission.status === "Active"
          : ["Pending", "Active"].includes(context.admission.status);

      if (!allowed) {
        throw new Error(
          `This admission cannot be ${completedActionLabel} from its current status.`,
        );
      }

      const payload = {
        status: nextStatus,
        updated_at: new Date().toISOString(),
        ...(nextStatus === "Completed"
          ? { actual_leaving_date: new Date().toISOString().slice(0, 10) }
          : {}),
      };
      const { data: updated, error: updateError } = await supabase
        .from("admissions")
        .update(payload)
        .eq("id", admissionId)
        .eq("status", context.admission.status)
        .select("id")
        .maybeSingle();

      if (updateError || !updated) {
        throw new Error(
          updateError
            ? getSupabaseErrorMessage(
                updateError,
                `Unable to ${actionLabel} this admission. Please try again.`,
              )
            : "The admission status changed before this action completed. Refresh and try again.",
        );
      }

      const bedError = await releaseBedWhenUnallocated(
        context.admission.bed_id,
      );
      if (bedError) {
        const { data: restoredAdmission, error: restoreError } = await supabase
          .from("admissions")
          .update({
            status: context.admission.status,
            actual_leaving_date:
              context.admission.actual_leaving_date ?? null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", admissionId)
          .eq("status", nextStatus)
          .select("id")
          .maybeSingle();

        throw new Error(
          restoreError || !restoredAdmission
            ? `Admission was marked ${nextStatus}, but its bed could not be released and its previous status could not be restored. Please contact an administrator.`
            : `The bed could not be released, so the admission was returned to ${context.admission.status}. No lifecycle change was kept.`,
        );
      }

      if (editingId === admissionId) closeEditForm();
      setMessage(`Admission ${nextStatus.toLowerCase()} successfully.`);
      await refresh();
      setAdmissionDataVersion((current) => current + 1);
    } catch (finishError) {
      setError(
        finishError instanceof Error
          ? finishError.message
          : `Unable to ${actionLabel} this admission.`,
      );
      await refresh();
      setAdmissionDataVersion((current) => current + 1);
    } finally {
      setLifecycleActionId(null);
    }
  }

  async function archiveAdmission(admissionId: string) {
    const confirmed = window.confirm(
      "Archive this admission? The record will be preserved and its bed will be released when safe.",
    );
    if (!confirmed) return;

    setArchivingId(admissionId);
    setMessage("");
    setError("");

    try {
      const context = await loadLifecycleContext(admissionId);
      if (!["Pending", "Active"].includes(context.admission.status)) {
        throw new Error(
          "Only a Pending or Active admission can be archived. Completed and Cancelled history is preserved unchanged.",
        );
      }

      const { data: archived, error: archiveError } = await supabase
        .from("admissions")
        .update({ status: "Archived", updated_at: new Date().toISOString() })
        .eq("id", admissionId)
        .eq("status", context.admission.status)
        .select("id")
        .maybeSingle();

      if (archiveError || !archived) {
        throw new Error(
          archiveError
            ? getSupabaseErrorMessage(
                archiveError,
                "Unable to archive this admission. Please try again.",
              )
            : "The admission status changed before it could be archived.",
        );
      }

      const bedError = await releaseBedWhenUnallocated(
        context.admission.bed_id,
      );
      if (bedError) {
        const { data: restoredAdmission, error: restoreError } = await supabase
          .from("admissions")
          .update({
            status: context.admission.status,
            updated_at: new Date().toISOString(),
          })
          .eq("id", admissionId)
          .eq("status", "Archived")
          .select("id")
          .maybeSingle();

        throw new Error(
          restoreError || !restoredAdmission
            ? "Admission was archived, but its bed could not be released and its previous status could not be restored. Please contact an administrator."
            : `The bed could not be released, so the admission was returned to ${context.admission.status}. No archive change was kept.`,
        );
      }

      if (editingId === admissionId) closeEditForm();
      setMessage("Admission archived successfully.");
      await refresh();
      setAdmissionDataVersion((current) => current + 1);
    } catch (archiveFailure) {
      setError(
        archiveFailure instanceof Error
          ? archiveFailure.message
          : "Unable to archive this admission.",
      );
      await refresh();
      setAdmissionDataVersion((current) => current + 1);
    } finally {
      setArchivingId(null);
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">
              University Girls Hostel
            </p>

            <h1 className="mt-2 text-3xl font-bold text-slate-900">
              Admissions
            </h1>

            <p className="mt-1 text-sm text-slate-500">
              Manage admissions, manual room allocation and security deposits.
            </p>
          </div>
        </section>

        {(message || error) && (
          <section
            className={`rounded-2xl border px-4 py-3 text-sm font-medium ${
              error
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-emerald-200 bg-emerald-50 text-emerald-700"
            }`}
          >
            {error || message}
          </section>
        )}

        <AdmissionForm
          onSaved={refresh}
          refreshKey={admissionDataVersion}
        />

        {showEditForm && (
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-6 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-bold text-slate-900">
                  Edit Admission
                </h2>

                <p className="mt-1 text-sm text-slate-500">
                  Update admission details and manually manage room and bed
                  allocation.
                </p>
              </div>

              <button
                type="button"
                onClick={closeEditForm}
                disabled={saving}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Close
              </button>
            </div>

            <form onSubmit={saveAdmission} className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <Field label="Resident *">
                  <select
                    required
                    value={form.resident_id}
                    className={inputClass}
                    disabled
                  >
                    <option value="">Select resident</option>
                    {residents
                      .filter((resident) => resident.status !== "Archived")
                      .map((resident) => (
                        <option
                          key={resident.id}
                          value={resident.id}
                        >
                          {resident.full_name}
                        </option>
                      ))}
                  </select>
                </Field>

                <Field label="Room *">
                  <select
                    required
                    value={form.room_id}
                    onChange={(event) =>
                      updateField("room_id", event.target.value)
                    }
                    className={inputClass}
                    disabled={saving}
                  >
                    <option value="">Select room</option>
                    {rooms
                      .filter(
                        (room) =>
                          isAdmissionRoomStatus(room.status) ||
                          room.id === form.room_id,
                      )
                      .map((room) => {
                        const otherCurrent = admissions.filter(item => item.id !== editingId && item.room_id === room.id);
                        const modeConflict = form.allocation_mode === "whole_room"
                          ? otherCurrent.length > 0
                          : otherCurrent.some(item => item.allocation_mode === "whole_room");
                        const disabled = !isAdmissionRoomStatus(room.status) || modeConflict;
                        return <option key={room.id} value={room.id} disabled={disabled}>
                          {room.room_number}{modeConflict ? " (Conflicts with current room allocation)" : !isAdmissionRoomStatus(room.status) ? ` (${room.status ?? "Unavailable"})` : ""}
                        </option>;
                      })}
                  </select>
                </Field>

                <Field label="Allocation Type *">
                  <select value={form.allocation_mode} onChange={event => updateField("allocation_mode", event.target.value as AdmissionForm["allocation_mode"])} className={inputClass} disabled={saving}>
                    <option value="single_bed">Single Bed</option>
                    <option value="whole_room">Whole Room (Exclusive)</option>
                  </select>
                  {form.allocation_mode === "whole_room" && <span className="mt-2 block text-xs text-slate-600">Books the entire room while this admission is Pending or Active.</span>}
                </Field>

                {form.allocation_mode === "single_bed" ? <Field label="Bed *">
                  <select required value={form.bed_id} onChange={event => updateField("bed_id", event.target.value)} className={inputClass} disabled={!form.room_id || saving}>
                    <option value="">{form.room_id ? "Select bed" : "Select a room first"}</option>
                    {filteredBeds.map(bed => bed.isAllocatable
                      ? <option key={bed.id} value={bed.id}>🟢 {normalizeBedLabel(bed.bed_number)} — {bed.isCurrentBed ? "Currently Assigned Bed ✓" : "Available"}</option>
                      : <option key={bed.id} value={bed.id} disabled>🔴 {normalizeBedLabel(bed.bed_number)} — {bed.occupantName ? `Occupied by ${bed.occupantName}` : admissions.some(item => item.room_id === form.room_id && item.allocation_mode === "whole_room") ? "Blocked by Whole-Room Allocation" : `${bed.status} (Unavailable)`}</option>)}
                  </select>
                </Field> : <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 md:col-span-2" aria-live="polite">
                  <h3 className="font-semibold">Whole Room Reservation</h3>
                  <p className="mt-1">{form.room_id ? `${beds.filter(bed => bed.room_id === form.room_id && bed.status !== BED_STATUS.INACTIVE).length} active beds will be reserved exclusively for this resident.` : "Select an eligible room to preview the reserved beds."}</p>
                  {form.room_id && <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">{beds.filter(bed => bed.room_id === form.room_id && bed.status !== BED_STATUS.INACTIVE).map(bed => {
                    const primary = bed.id === form.bed_id;
                    const existingExclusive = admissions.some(admission => admission.id === editingId && admission.allocation_mode === "whole_room" && admission.room_id === form.room_id);
                    return <li key={bed.id}>{normalizeBedLabel(bed.bed_number)} — {primary ? "Primary bed" : existingExclusive ? "Blocked by Whole-Room Allocation" : "Will be reserved"}</li>;
                  })}</ul>}
                </section>}

                <Field label="Admission Date *">
                  <input
                    required
                    type="date"
                    value={form.admission_date}
                    onChange={(event) =>
                      updateField("admission_date", event.target.value)
                    }
                    className={inputClass}
                    disabled={saving}
                  />
                </Field>

                <Field label="Expected Leaving Date">
                  <input
                    type="date"
                    value={form.expected_leaving_date}
                    onChange={(event) =>
                      updateField(
                        "expected_leaving_date",
                        event.target.value
                      )
                    }
                    className={inputClass}
                    disabled={saving}
                  />
                </Field>

                <Field label="Monthly Rent">
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={form.monthly_rent}
                    onChange={(event) =>
                      updateField("monthly_rent", event.target.value)
                    }
                    className={inputClass}
                    placeholder="15000"
                    disabled={saving}
                  />
                </Field>

                <Field label="Security Deposit">
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={form.security_deposit}
                    onChange={(event) =>
                      updateField("security_deposit", event.target.value)
                    }
                    className={inputClass}
                    placeholder="15000"
                    disabled={saving}
                  />
                </Field>

                <Field label="Deposit Status">
                  <select
                    value={form.deposit_status}
                    onChange={(event) =>
                      updateField("deposit_status", event.target.value as DepositStatus)
                    }
                    className={inputClass}
                    disabled={saving}
                  >
                    <option value="Pending">Pending</option>
                    <option value="Held">Held</option>
                    <option value="Released">Released</option>
                    <option value="Deducted">Deducted</option>
                  </select>
                </Field>

                <Field label="Notice Period (Days)">
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={form.notice_period_days}
                    onChange={(event) =>
                      updateField("notice_period_days", event.target.value)
                    }
                    className={inputClass}
                    disabled={saving}
                  />
                </Field>

                <Field label="Admission Status">
                  <select
                    value={form.status}
                    className={inputClass}
                    disabled
                  >
                    <option value="Active">Active</option>
                    <option value="Pending">Pending</option>
                    <option value="Completed">Completed</option>
                    <option value="Cancelled">Cancelled</option>
                  </select>
                </Field>

                <Field label="Notes" wide>
                  <textarea
                    value={form.notes}
                    onChange={(event) =>
                      updateField("notes", event.target.value)
                    }
                    className={`${inputClass} min-h-24 resize-y`}
                    placeholder="Admission notes"
                    disabled={saving}
                  />
                </Field>
              </div>

              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                Security deposit is refundable only when the resident serves
                notice at least 30 days before leaving. Otherwise, the deposit
                may be forfeited.
              </div>

              <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={closeEditForm}
                  disabled={saving}
                  className="rounded-xl border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving ? "Updating..." : "Update Admission"}
                </button>
              </div>
            </form>
          </section>
        )}

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Total Admissions" value={String(summary.total)} />
          <StatCard label="Active" value={String(summary.active)} />
          <StatCard label="Pending" value={String(summary.pending)} />
          <StatCard
            label="Deposits Held"
            value={String(summary.depositsHeld)}
          />
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
          <div className="grid gap-3 border-b border-slate-200 p-5 lg:grid-cols-[1fr_220px_auto]">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className={inputClass}
              placeholder="Search resident, room or bed"
            />

            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className={inputClass}
            >
              <option value="Current">Current Admissions</option>
              <option value="All">All Admissions</option>
              <option value="Active">Active</option>
              <option value="Pending">Pending</option>
              <option value="Completed">Completed</option>
              <option value="Cancelled">Cancelled</option>
              <option value="Archived">Archived</option>
            </select>

            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? "Refreshing..." : "Refresh"}
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  {[
                    "Resident",
                    "Room / Bed",
                    "Dates",
                    "Rent / Deposit",
                    "Contract Signed",
                    "Ready",
                    "Status",
                    "Actions",
                  ].map((heading) => (
                    <th
                      key={heading}
                      className="px-5 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100 bg-white">
                {loading ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-5 py-12 text-center text-sm text-slate-500"
                    >
                      Loading admissions...
                    </td>
                  </tr>
                ) : filteredAdmissions.length === 0 ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-5 py-12 text-center text-sm text-slate-500"
                    >
                      No admissions found.
                    </td>
                  </tr>
                ) : (
                  filteredAdmissions.map((admission) => {
                    const resident = residents.find(
                      (item) => item.id === admission.resident_id
                    );

                    const room = rooms.find(
                      (item) => item.id === admission.room_id
                    );

                    const bed = beds.find(
                      (item) => item.id === admission.bed_id
                    );

                    const isArchived = admission.status === "Archived";
                    const isArchiving = archivingId === admission.id;
                    const isLifecycleAction =
                      lifecycleActionId === admission.id;
                    const isHistorical = ["Completed", "Cancelled"].includes(
                      admission.status,
                    );
const contract = contracts.find(
  (item) => item.admission_id === admission.id,
);

const contractSigned = isContractSignedAndAccepted(contract);

const signatureStatus =
  contract?.resident_signature_status ?? "Pending";

const contractSignatureLabel = contractSigned
  ? "Yes"
  : signatureStatus === "Submitted" || signatureStatus === "Signed"
    ? "Awaiting Approval"
    : signatureStatus === "Rejected"
      ? "Rejected"
      : signatureStatus === "Re-sign Required"
        ? "Re-sign Required"
        : "No";

const deposit = getAdmissionDeposit(admission, depositBills, depositPayments);
const rent = getAdmissionRent(admission, depositBills, depositPayments);
                    const readyForActivation = isAdmissionActivationReady({
                      admission, resident, room, bed, contract,
                      depositState: deposit.state, admissions, bills: depositBills, payments: depositPayments,
                    });

                    return (
                      <tr
                        key={admission.id}
                        className={`hover:bg-slate-50/70 ${
                          isArchived ? "bg-slate-50/60" : ""
                        }`}
                      >
     <td className="px-5 py-4">
  <p className="font-semibold text-slate-900">
    {resident?.full_name || "Unknown resident"}
  </p>
</td>

<td className="px-5 py-4 text-sm text-slate-700">
  <p>Room: {room?.room_number || "Not allocated"}</p>
  <p className="mt-1 text-xs text-slate-500">
    {admission.allocation_mode === "whole_room" ? "Whole Room (Exclusive)" : "Single Bed"} · {bed ? normalizeBedLabel(bed.bed_number) : "Not allocated"}
  </p>
</td>

<td className="px-5 py-4 text-sm text-slate-700">
  <p>Admission: {admission.admission_date}</p>
  <p className="mt-1 text-xs text-slate-500">
    Leaving: {admission.expected_leaving_date || "Not set"}
  </p>
</td>

<td className="px-5 py-4 text-sm text-slate-700">
  <p>Rent: {money(admission.monthly_rent)}</p>
  <p className="mt-1 text-xs font-semibold">Rent: {rent.state === "verified" ? "Verified" : "Pending"}</p>

  <p className="mt-1 text-xs text-slate-500">
    Deposit: {money(deposit.required)}
  </p>

  <span
    className={`mt-2 inline-flex rounded-full px-3 py-1 text-xs font-bold ${depositStatusClass(
      deposit.state
    )}`}
  >
    {depositStateLabel(deposit.state)}
  </span>
</td>

<td className="px-5 py-4 text-sm">
  <span
    className={`rounded-full px-3 py-1 text-xs font-bold ${
      contractSigned
        ? "bg-emerald-100 text-emerald-700"
        : signatureStatus === "Submitted" || signatureStatus === "Signed"
          ? "bg-blue-100 text-blue-700"
          : signatureStatus === "Rejected"
            ? "bg-red-100 text-red-700"
            : "bg-amber-100 text-amber-700"
    }`}
  >
    {contractSignatureLabel}
  </span>
</td>

<td className="px-5 py-4 text-sm">
  <span
    className={`rounded-full px-3 py-1 text-xs font-bold ${
      readyForActivation
        ? "bg-emerald-100 text-emerald-700"
        : "bg-slate-100 text-slate-600"
    }`}
  >
    {admission.status === "Active" ? "Active" : readyForActivation ? "Ready" : "Not Ready"}
  </span>
</td>
                         <td className="px-5 py-4">
                          <span
                            className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${admissionStatusClass(
                              admission.status
                            )}`}
                          >
                            {admission.status}
                          </span>
                        </td>

                        <td className="px-5 py-4">
                          {isArchived || isHistorical ? (
                            <span className="text-xs font-medium text-slate-500">
                              {isArchived ? "Archived record" : "Historical record"}
                            </span>
                          ) : (
                            <div className="flex flex-wrap gap-2">
                              {admission.status === "Pending" &&
                                contract &&
                                ["Submitted", "Signed"].includes(
                                  signatureStatus,
                                ) && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void approveContractFromAdmission(
                                        admission.id,
                                      )
                                    }
                                    disabled={isLifecycleAction || isArchiving}
                                    className="rounded-lg border border-blue-200 px-3 py-2 text-xs font-semibold text-blue-700 transition hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
                                  >
                                    {isLifecycleAction
                                      ? "Working..."
                                      : "Approve Contract"}
                                  </button>
                                )}

                              {admission.status === "Pending" &&
                                deposit.state === "pending" && (
                                  <Link
                                    href="/payment-verification"
                                    className="rounded-lg border border-amber-200 px-3 py-2 text-xs font-semibold text-amber-700 transition hover:bg-amber-50"
                                    title="The resident must submit payment evidence through the portal before verification."
                                  >
                                    Review Deposit Receipts
                                  </Link>
                                )}

                              {admission.status === "Pending" &&
                                readyForActivation && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void activateAdmission(admission.id)
                                    }
                                    disabled={isLifecycleAction || isArchiving}
                                    className="rounded-lg border border-emerald-200 px-3 py-2 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-60"
                                  >
                                    {isLifecycleAction
                                      ? "Activating..."
                                      : "Activate Admission"}
                                  </button>
                                )}

                              {admission.status === "Pending" && !contract && (
                                <Link
                                  href="/contracts/add"
                                  className="rounded-lg border border-amber-200 px-3 py-2 text-xs font-semibold text-amber-700 transition hover:bg-amber-50"
                                >
                                  Prepare Contract
                                </Link>
                              )}

                              <button
                                type="button"
                                onClick={() => openEditForm(admission)}
                                disabled={isArchiving || isLifecycleAction}
                                className="rounded-lg border border-indigo-200 px-3 py-2 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                Edit
                              </button>

                              {admission.status === "Active" && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    void finishAdmission(
                                      admission.id,
                                      "Completed",
                                    )
                                  }
                                  disabled={isLifecycleAction || isArchiving}
                                  className="rounded-lg border border-blue-200 px-3 py-2 text-xs font-semibold text-blue-700 transition hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {isLifecycleAction ? "Working..." : "Complete"}
                                </button>
                              )}

                              <button
                                type="button"
                                onClick={() =>
                                  void finishAdmission(
                                    admission.id,
                                    "Cancelled",
                                  )
                                }
                                disabled={isLifecycleAction || isArchiving}
                                className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {isLifecycleAction ? "Working..." : "Cancel"}
                              </button>

                              <button
                                type="button"
                                onClick={() =>
                                  void archiveAdmission(admission.id)
                                }
                                disabled={isArchiving || isLifecycleAction}
                                className="rounded-lg border border-amber-200 px-3 py-2 text-xs font-semibold text-amber-700 transition hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {isArchiving ? "Archiving..." : "Archive"}
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })
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
    <label className={wide ? "md:col-span-2 xl:col-span-3" : ""}>
      <span className="mb-2 block text-sm font-semibold text-slate-700">
        {label}
      </span>
      {children}
    </label>
  );
}

function StatCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-bold text-slate-900">{value}</p>
    </article>
  );
}

function isCurrentAdmissionStatus(status: AdmissionStatus) {
  return status === "Active" || status === "Pending";
}

function isAdmissionRoomStatus(status: string | null) {
  return ["Available", "Partially Occupied", "Occupied"].includes(status ?? "");
}

async function releaseBedWhenUnallocated(bedId: string) {
  const { data: currentReference, error: referenceError } = await supabase
    .from("admissions")
    .select("id")
    .eq("bed_id", bedId)
    .in("status", ["Active", "Pending"])
    .limit(1)
    .maybeSingle();

  if (referenceError || currentReference) return referenceError;

  const { error: releaseError } = await supabase
    .from("beds")
    .update({ status: BED_STATUS.VACANT })
    .eq("id", bedId)
    .eq("status", BED_STATUS.OCCUPIED);

  return releaseError;
}
