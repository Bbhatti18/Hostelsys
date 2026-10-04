"use client";

import { FormEvent, Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { supabase } from "@/lib/supabase";
import {
  addSingleBed,
  prepareRoomBedCapacity,
  provisionRoomBeds,
  removeSingleBed,
  rollbackRoomBedChanges,
  type BedCapacityResult,
} from "@/lib/bedProvisioning";
import { getSupabaseErrorMessage } from "@/lib/supabaseErrors";
import { buildRoomOccupancy, currentBedAssignments, matchesRoomStatus, summarizeRoomOccupancy, type OccupancyAdmission } from "@/lib/roomOccupancy";
import { isOperationalBedStatus } from "@/lib/statuses";
import { getNextCanonicalBedLabels, normalizeBedLabel } from "@/lib/bedLabels";

type RoomStatus =
  | "Available"
  | "Occupied"
  | "Partially Occupied"
  | "Maintenance"
  | "Inactive";

type Room = {
  id: string;
  room_number: string;
  floor_number: number | null;
  block_name: string | null;
  room_type: string;
  total_beds: number;
  monthly_rent: number;
  security_deposit_amount: number;
  has_ac: boolean;
  has_attached_bathroom: boolean;
  has_balcony: boolean;
  description: string | null;
  status: RoomStatus;
  created_at: string;
  updated_at: string;
};

type RoomForm = {
  room_number: string;
  floor_number: string;
  block_name: string;
  room_type: string;
  total_beds: string;
  monthly_rent: string;
  security_deposit_amount: string;
  has_ac: boolean;
  has_attached_bathroom: boolean;
  has_balcony: boolean;
  description: string;
  status: RoomStatus;
};

type BedResident = {
  resident_id: string;
  full_name: string;
  resident_code: string | null;
  phone: string | null;
  admission_date: string | null;
  status: string | null;
};

type RoomBed = {
  id: string;
  room_id: string;
  bed_number: string;
  status: string | null;
  resident?: BedResident | null;
};

const emptyForm: RoomForm = {
  room_number: "",
  floor_number: "",
  block_name: "",
  room_type: "Shared",
  total_beds: "1",
  monthly_rent: "0",
  security_deposit_amount: "0",
  has_ac: false,
  has_attached_bathroom: false,
  has_balcony: false,
  description: "",
  status: "Available",
};

const inputClass =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-slate-100";

function nullable(value: string) {
  const cleaned = value.trim();
  return cleaned === "" ? null : cleaned;
}

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(value || 0);
}

function roomToForm(room: Room): RoomForm {
  return {
    room_number: room.room_number,
    floor_number: room.floor_number === null ? "" : String(room.floor_number),
    block_name: room.block_name ?? "",
    room_type: room.room_type ?? "Shared",
    total_beds: String(room.total_beds ?? 1),
    monthly_rent: String(room.monthly_rent ?? 0),
    security_deposit_amount: String(room.security_deposit_amount ?? 0),
    has_ac: room.has_ac ?? false,
    has_attached_bathroom: room.has_attached_bathroom ?? false,
    has_balcony: room.has_balcony ?? false,
    description: room.description ?? "",
    status: room.status ?? "Available",
  };
}

export default function RoomsPage() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomBeds, setRoomBeds] = useState<RoomBed[]>([]);
  const [roomAdmissions, setRoomAdmissions] = useState<OccupancyAdmission[]>([]);
  const [referencedRoomIds, setReferencedRoomIds] = useState<Set<string>>(
    new Set(),
  );
  const [relationshipsVerified, setRelationshipsVerified] = useState(false);
  const [expandedRoomIds, setExpandedRoomIds] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<RoomForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function toggleRoomExpansion(roomId: string) {
    setExpandedRoomIds((prev) => {
      const next = new Set(prev);
      if (next.has(roomId)) next.delete(roomId);
      else next.add(roomId);
      return next;
    });
  }

  function toggleExpandAll(currentRooms: Room[]) {
    if (expandedRoomIds.size === currentRooms.length) {
      setExpandedRoomIds(new Set());
    } else {
      setExpandedRoomIds(new Set(currentRooms.map((r) => r.id)));
    }
  }

  const loadRooms = useCallback(async () => {
    setLoading(true);
    setError("");

    const [roomResult, bedResult, admissionResult] = await Promise.all([
      supabase.from("rooms").select("*").order("room_number", {
        ascending: true,
      }),
      supabase
        .from("beds")
        .select("id, room_id, bed_number, status")
        .order("bed_number", { ascending: true }),
      supabase
        .from("admissions")
        .select("id, room_id, bed_id, resident_id, allocation_mode, status, admission_date, residents(id, full_name, resident_code, phone)")
        .in("status", ["Active", "Pending"]),
    ]);

    if (roomResult.error) {
      setError(getSupabaseErrorMessage(roomResult.error, "Rooms could not be loaded."));
      setRooms([]);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mappedRooms = (roomResult.data ?? []).map((r: any) => ({
        ...r,
        block_name: r.block_name ?? null,
        floor_number: r.floor_number ?? null,
        description: r.description ?? null,
        total_beds: r.total_beds ?? 1,
      })) as Room[];
      mappedRooms.sort((a, b) => {
        const floorDiff = (a.floor_number ?? 999) - (b.floor_number ?? 999);
        if (floorDiff !== 0) return floorDiff;
        return a.room_number.localeCompare(b.room_number, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      });
      setRooms(mappedRooms);
    }

    if (bedResult.error || admissionResult.error) {
      setError((current) =>
        current
          ? `${current} | Unable to verify room relationships.`
          : "Unable to verify room relationships.",
      );
      setRoomBeds([]);
      setRoomAdmissions([]);
      setReferencedRoomIds(new Set());
      setRelationshipsVerified(false);
    } else {
      const assignments = currentBedAssignments(bedResult.data ?? [], admissionResult.data ?? []);
      setRoomAdmissions(admissionResult.data ?? []);
      const occupantMap = new Map<string, BedResident>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((admissionResult.data ?? []) as any[]).forEach((adm) => {
        if (adm.bed_id && assignments.get(adm.bed_id)?.id === adm.id) {
          occupantMap.set(adm.bed_id, {
            resident_id: adm.resident_id,
            full_name: adm.residents?.full_name || "Resident",
            resident_code: adm.residents?.resident_code || null,
            phone: adm.residents?.phone || null,
            admission_date: adm.admission_date || null,
            status: adm.status || null,
          });
        }
      });

      const processedBeds: RoomBed[] = ((bedResult.data ?? []) as Array<{
        id: string;
        room_id: string | null;
        bed_number: string;
        status: string | null;
      }>)
        .filter(
          (bed): bed is { id: string; room_id: string; bed_number: string; status: string | null } =>
            Boolean(bed.room_id),
        )
        .map((bed) => ({
          ...bed,
          resident: occupantMap.get(bed.id) ?? null,
        }));

      setRoomBeds(processedBeds);
      setReferencedRoomIds(
        new Set(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ((admissionResult.data ?? []) as any[])
            .map((admission) => admission.room_id)
            .filter((id): id is string => Boolean(id)),
        ),
      );
      setRelationshipsVerified(true);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    const reload = () => { void loadRooms(); };
    const changed = (event: StorageEvent) => { if (event.key === "admission-allocation-changed") reload(); };
    window.addEventListener("focus", reload);
    window.addEventListener("admission-allocation-changed", reload);
    window.addEventListener("storage", changed);
    return () => { window.removeEventListener("focus", reload); window.removeEventListener("admission-allocation-changed", reload); window.removeEventListener("storage", changed); };
  }, [loadRooms]);

  useEffect(() => {
    // Loading remote Supabase data is the external synchronization for this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRooms();
  }, [loadRooms]);

  const occupancy = useMemo(() => new Map(rooms.map(room => [room.id,
    buildRoomOccupancy(room, roomBeds, roomAdmissions),
  ])), [rooms, roomBeds, roomAdmissions]);

  const filteredRooms = useMemo(() => {
    const query = search.trim().toLowerCase();

    return rooms.filter((room) => {
      if (String(room.status) === "Archived") return false;
      const matchesSearch =
        query === "" ||
        room.room_number.toLowerCase().includes(query) ||
        (room.block_name ?? "").toLowerCase().includes(query) ||
        room.room_type.toLowerCase().includes(query);

      const matchesStatus =
        matchesRoomStatus(occupancy.get(room.id)!, statusFilter);

      return matchesSearch && matchesStatus;
    });
  }, [rooms, search, statusFilter, occupancy]);

  const stats = useMemo(() => summarizeRoomOccupancy([...occupancy.values()]), [occupancy]);

  function updateField<K extends keyof RoomForm>(
    key: K,
    value: RoomForm[K]
  ) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function openAddForm() {
    setEditingId(null);
    setForm(emptyForm);
    setMessage("");
    setError("");
    setShowForm(true);
  }

  function openEditForm(room: Room) {
    setEditingId(room.id);
    setForm(roomToForm(room));
    setMessage("");
    setError("");
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(emptyForm);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    setError("");

    if (!form.room_number.trim()) {
      setError("Room number is required.");
      setSaving(false);
      return;
    }

    const totalBeds = Number(form.total_beds);
    const monthlyRent = Number(form.monthly_rent);
    const securityDeposit = Number(form.security_deposit_amount);
    const floorNumber =
      form.floor_number.trim() === "" ? null : Number(form.floor_number);

    if (!Number.isInteger(totalBeds) || totalBeds <= 0) {
      setError("Total beds must be a whole number greater than zero.");
      setSaving(false);
      return;
    }

    if (Number.isNaN(monthlyRent) || monthlyRent < 0) {
      setError("Monthly rent must be zero or greater.");
      setSaving(false);
      return;
    }

    if (Number.isNaN(securityDeposit) || securityDeposit < 0) {
      setError("Security deposit must be zero or greater.");
      setSaving(false);
      return;
    }

    if (
      floorNumber !== null &&
      (!Number.isInteger(floorNumber) || floorNumber < 0)
    ) {
      setError("Floor number must be a whole number.");
      setSaving(false);
      return;
    }

    const payload = {
      room_number: form.room_number.trim(),
      floor_number: floorNumber,
      block_name: nullable(form.block_name),
      room_type: form.room_type.trim() || "Shared",
      total_beds: totalBeds,
      monthly_rent: monthlyRent,
      security_deposit_amount: securityDeposit,
      has_ac: form.has_ac,
      has_attached_bathroom: form.has_attached_bathroom,
      has_balcony: form.has_balcony,
      description: nullable(form.description),
      status: form.status,
    };

    let bedCapacityResult: BedCapacityResult | null = null;
    if (editingId) {
      bedCapacityResult = await prepareRoomBedCapacity({
        roomId: editingId,
        capacity: totalBeds,
        allowIncrease: form.status !== "Inactive",
      });
      if (bedCapacityResult.error) {
        setError(bedCapacityResult.error);
        setSaving(false);
        return;
      }
    }

    const result = editingId
      ? await supabase
          .from("rooms")
          .update(payload)
          .eq("id", editingId)
          .select("id")
          .single()
      : await supabase.from("rooms").insert(payload).select("id").single();

    if (result.error || !result.data) {
      const rolledBack = bedCapacityResult
        ? await rollbackRoomBedChanges(bedCapacityResult)
        : true;
      setError(
        rolledBack
          ? getSupabaseErrorMessage(result.error, "The room could not be saved. No bed changes were kept.")
          : "The room could not be saved, and some bed statuses could not be restored. Refresh and review this room before trying again.",
      );
      setSaving(false);
      return;
    }

    const savedRoomId = String(result.data.id);
    let partialSuccessError = "";
    if (!editingId && form.status !== "Inactive") {
      const provisionResult = await provisionRoomBeds({
        roomId: savedRoomId,
        capacity: totalBeds,
      });

      if (provisionResult.errors.length > 0) {
        partialSuccessError = `Room saved, but only ${provisionResult.created} of ${provisionResult.requested} missing beds were created. Refresh and retry after resolving the database error.`;
      } else {
        setMessage(
          `${editingId ? "Room updated" : "Room added"} successfully.${
            provisionResult.created > 0
              ? ` ${provisionResult.created} vacant bed${
                  provisionResult.created === 1 ? " was" : "s were"
                } created automatically.`
              : ""
          }`,
        );
      }
    } else if (!editingId) {
      setMessage(
        `${editingId ? "Room updated" : "Room added"} successfully. No beds were created because the room is Inactive.`,
      );
    } else {
      const changes = bedCapacityResult!;
      setMessage(
        `Room updated successfully.${
          changes.deactivated > 0
            ? ` ${changes.deactivated} surplus bed${changes.deactivated === 1 ? " was" : "s were"} marked Inactive.`
            : ""
        }${
          changes.restored > 0
            ? ` ${changes.restored} inactive bed${changes.restored === 1 ? " was" : "s were"} restored as Vacant.`
            : ""
        }${
          changes.created > 0
            ? ` ${changes.created} new vacant bed${changes.created === 1 ? " was" : "s were"} created.`
            : ""
        }`,
      );
    }
    closeForm();
    await loadRooms();
    if (partialSuccessError) setError(partialSuccessError);
    setSaving(false);
  }

  async function handleDelete(room: Room) {
    if (!relationshipsVerified) {
      setError("Room relationships could not be verified. Nothing was deleted.");
      return;
    }

    const hasLinks =
      roomBeds.some((bed) => bed.room_id === room.id) ||
      referencedRoomIds.has(room.id);
    const confirmed = window.confirm(
      hasLinks
        ? `Mark room ${room.room_number} Inactive? Linked records will be preserved.`
        : `Delete room ${room.room_number}? This action cannot be undone.`,
    );

    if (!confirmed) return;

    setDeletingId(room.id);
    setMessage("");
    setError("");

    const result = hasLinks
      ? await supabase
          .from("rooms")
          .update({ status: "Inactive" })
          .eq("id", room.id)
      : await supabase.from("rooms").delete().eq("id", room.id);

    if (
      result.error &&
      !hasLinks &&
      /foreign key|constraint|23503/i.test(result.error.message)
    ) {
      const { error: inactiveError } = await supabase
        .from("rooms")
        .update({ status: "Inactive" })
        .eq("id", room.id);

      if (!inactiveError) {
        setMessage("Room marked Inactive. Linked records were preserved.");
        await loadRooms();
        setDeletingId(null);
        return;
      }
    }

    if (result.error) {
      setError(
        /foreign key|constraint|23503/i.test(result.error.message)
          ? "This room is linked to beds, admissions, or other records and cannot be deleted. Mark it Inactive instead."
          : "The room could not be updated. Please try again.",
      );
    } else {
      setMessage(
        hasLinks
          ? "Room marked Inactive. Linked records were preserved."
          : "Room deleted successfully.",
      );
      await loadRooms();
    }

    setDeletingId(null);
  }

  async function handleAddBedToRoom(room: Room) {
    const existingRoomBeds = roomBeds
      .filter((b) => b.room_id === room.id)
      .map((b) => b.bed_number);
    const nextLabels = getNextCanonicalBedLabels(
      1,
      existingRoomBeds,
      room.room_number,
    );
    const suggested = nextLabels[0] || `${room.room_number} A`;

    const userLabel = window.prompt(
      `Add a new bed to Room ${room.room_number}.\nEnter bed label:`,
      suggested,
    );
    if (!userLabel || !userLabel.trim()) return;

    setError("");
    setMessage("");

    const result = await addSingleBed({
      roomId: room.id,
      bedNumber: userLabel.trim(),
    });

    if (!result.success) {
      setError(result.error || "The bed could not be added.");
    } else {
      setMessage(
        `Bed "${normalizeBedLabel(userLabel)}" added to Room ${room.room_number}.${
          result.newCapacity
            ? ` Room capacity automatically updated to ${result.newCapacity}.`
            : ""
        }`,
      );
      await loadRooms();
    }
  }

  async function handleRemoveBedFromRoom(bed: RoomBed, room: Room) {
    const label = normalizeBedLabel(bed.bed_number);
    if (
      !window.confirm(
        `Are you sure you want to remove ${label} from Room ${room.room_number}? The room's capacity will be adjusted automatically.`,
      )
    ) {
      return;
    }

    setError("");
    setMessage("");

    const result = await removeSingleBed({
      bedId: bed.id,
      roomId: room.id,
    });

    if (!result.success) {
      setError(result.error || "The bed could not be removed.");
    } else {
      setMessage(
        `Bed ${label} removed from Room ${room.room_number}.${
          result.newCapacity
            ? ` Room capacity updated to ${result.newCapacity}.`
            : ""
        }`,
      );
      await loadRooms();
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">
              Hostel Management System
            </p>
            <h1 className="mt-2 text-3xl font-bold text-slate-900">Rooms</h1>
            <p className="mt-1 text-sm text-slate-500">
              Add, update, search and manage hostel rooms.
            </p>
          </div>

          <button
            type="button"
            onClick={openAddForm}
            className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700"
          >
            + Add Room
          </button>
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

        {showForm && (
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-6 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-bold text-slate-900">
                  {editingId ? "Edit Room" : "Add Room"}
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  Room number is required.
                </p>
              </div>

              <button
                type="button"
                onClick={closeForm}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Close
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <Field label="Room Number *">
                  <input
                    required
                    value={form.room_number}
                    onChange={(event) =>
                      updateField("room_number", event.target.value)
                    }
                    className={inputClass}
                    placeholder="101"
                  />
                </Field>

                <Field label="Floor Number">
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={form.floor_number}
                    onChange={(event) =>
                      updateField("floor_number", event.target.value)
                    }
                    className={inputClass}
                    placeholder="1"
                  />
                </Field>

                <Field label="Block Name">
                  <input
                    value={form.block_name}
                    onChange={(event) =>
                      updateField("block_name", event.target.value)
                    }
                    className={inputClass}
                    placeholder="Block A"
                  />
                </Field>

                <Field label="Room Type">
                  <select
                    value={form.room_type}
                    onChange={(event) =>
                      updateField("room_type", event.target.value)
                    }
                    className={inputClass}
                  >
                    <option value="2 Sharing">2 Sharing</option>
                    <option value="3 Sharing">3 Sharing</option>
                    <option value="Single Economy">Single Economy</option>
                    <option value="Single Deluxe">Single Deluxe</option>
                    <option value="Shared">Shared</option>
                    <option value="Single">Single</option>
                    <option value="Double">Double</option>
                    <option value="Triple">Triple</option>
                    <option value="Dormitory">Dormitory</option>
                  </select>
                </Field>

                <Field label="Total Beds">
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={form.total_beds}
                    onChange={(event) =>
                      updateField("total_beds", event.target.value)
                    }
                    className={inputClass}
                  />
                </Field>

                <Field label="Status">
                  <select
                    value={form.status}
                    onChange={(event) =>
                      updateField("status", event.target.value as RoomStatus)
                    }
                    className={inputClass}
                  >
                    <option value="Available">Available</option>
                    <option value="Occupied">Occupied</option>
                    <option value="Partially Occupied">
                      Partially Occupied
                    </option>
                    <option value="Maintenance">Maintenance</option>
                    <option value="Inactive">Inactive</option>
                  </select>
                </Field>

                <Field label="Monthly Rent">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.monthly_rent}
                    onChange={(event) =>
                      updateField("monthly_rent", event.target.value)
                    }
                    className={inputClass}
                  />
                </Field>

                <Field label="Security Deposit">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.security_deposit_amount}
                    onChange={(event) =>
                      updateField(
                        "security_deposit_amount",
                        event.target.value
                      )
                    }
                    className={inputClass}
                  />
                </Field>

                <Field label="Facilities">
                  <div className="space-y-2 rounded-xl border border-slate-300 p-3">
                    <Checkbox
                      label="Air Conditioning"
                      checked={form.has_ac}
                      onChange={(checked) => updateField("has_ac", checked)}
                    />
                    <Checkbox
                      label="Attached Bathroom"
                      checked={form.has_attached_bathroom}
                      onChange={(checked) =>
                        updateField("has_attached_bathroom", checked)
                      }
                    />
                    <Checkbox
                      label="Balcony"
                      checked={form.has_balcony}
                      onChange={(checked) =>
                        updateField("has_balcony", checked)
                      }
                    />
                  </div>
                </Field>

                <Field label="Description" wide>
                  <textarea
                    value={form.description}
                    onChange={(event) =>
                      updateField("description", event.target.value)
                    }
                    className={`${inputClass} min-h-24`}
                    placeholder="Room details..."
                  />
                </Field>
              </div>

              <div className="flex flex-col-reverse gap-3 border-t border-slate-200 pt-6 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={closeForm}
                  className="rounded-xl border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving
                    ? "Saving..."
                    : editingId
                    ? "Update Room"
                    : "Save Room"}
                </button>
              </div>
            </form>
          </section>
        )}

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard label="Total Rooms" value={loading ? "..." : stats.total} />
          <StatCard label="Available" value={loading || !relationshipsVerified ? "..." : stats.available} />
          <StatCard label="Occupied" value={loading || !relationshipsVerified ? "..." : stats.occupied} />
          <StatCard label="Maintenance" value={loading ? "..." : stats.maintenance} />
          <StatCard label="Exclusive Rooms" value={loading || !relationshipsVerified ? "..." : stats.exclusive} />
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
          <div className="grid gap-3 border-b border-slate-200 p-5 md:grid-cols-[1fr_220px_auto_auto]">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className={inputClass}
              placeholder="Search by room number, block or type"
            />

            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className={inputClass}
            >
              <option value="All">All Statuses</option>
              <option value="Available">Available</option>
              <option value="Fully Occupied">Fully Occupied</option>
              <option value="Partially Occupied">
                Partially Occupied
              </option>
              <option value="Exclusively Occupied">Exclusively Occupied</option>
              <option value="Maintenance">Maintenance</option>
              <option value="Inactive">Inactive</option>
            </select>

            <button
              type="button"
              onClick={() => toggleExpandAll(filteredRooms)}
              className="rounded-xl border border-indigo-200 bg-indigo-50/60 px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-100 transition whitespace-nowrap"
            >
              {expandedRoomIds.size === filteredRooms.length && filteredRooms.length > 0
                ? "Collapse All Beds"
                : "Expand All Beds"}
            </button>

            <button
              type="button"
              onClick={() => void loadRooms()}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Refresh
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  {[
                    "Room",
                    "Type",
                    "Beds & Occupants",
                    "Rent",
                    "Facilities",
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
                      colSpan={7}
                      className="px-5 py-12 text-center text-sm text-slate-500"
                    >
                      Loading rooms...
                    </td>
                  </tr>
                ) : !relationshipsVerified ? (
                  <tr><td colSpan={7} className="px-5 py-12 text-center text-sm text-red-700">Room occupancy could not be verified. Please reload before relying on availability.</td></tr>
                ) : filteredRooms.length === 0 ? (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-5 py-12 text-center text-sm text-slate-500"
                    >
                      No rooms found.
                    </td>
                  </tr>
                ) : (
                  filteredRooms.map((room) => {
                    const roomOccupancy = occupancy.get(room.id)!;
                    const currentRoomBeds = roomOccupancy.beds;
                    const occupiedCount = roomOccupancy.occupied;
                    const isExpanded = expandedRoomIds.has(room.id);

                    return (
                      <Fragment key={room.id}>
                        <tr className="hover:bg-slate-50/70">
                          <td className="whitespace-nowrap px-5 py-4">
                            <p className="font-semibold text-slate-900">
                              {/^\d+$/.test(room.room_number)
                                ? `Room ${room.room_number}`
                                : room.room_number}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              {room.block_name || "No block"} ·{" "}
                              {room.floor_number === 0
                                ? "Ground Floor"
                                : room.floor_number === 1
                                ? "1st Floor"
                                : room.floor_number === 2
                                ? "2nd Floor"
                                : room.floor_number === 3
                                ? "3rd Floor"
                                : room.floor_number !== null
                                ? `Floor ${room.floor_number}`
                                : "No floor"}
                            </p>
                          </td>

                          <td className="whitespace-nowrap px-5 py-4 text-sm text-slate-600">
                            {room.room_type}
                          </td>

                          <td className="whitespace-nowrap px-5 py-4">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-bold text-slate-900">
                                {occupiedCount} resident{occupiedCount === 1 ? "" : "s"} · {roomOccupancy.unavailable}/{roomOccupancy.capacity} unavailable · {roomOccupancy.available} available
                              </span>
                              <button
                                type="button"
                                onClick={() => toggleRoomExpansion(room.id)}
                                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-semibold text-indigo-600 hover:bg-indigo-50 hover:border-indigo-200 transition"
                              >
                                {isExpanded
                                  ? "Hide Beds ▲"
                                  : `View Beds (${currentRoomBeds.length}) ▼`}
                              </button>
                            </div>
                            {currentRoomBeds.length > 0 && (
                              <div className="mt-1.5 flex flex-wrap gap-1">
                                {currentRoomBeds.map((bed) => {
                                  const hasResident = bed.occupied;
                                  return (
                                    <span
                                      key={bed.id}
                                      title={
                                        hasResident
                                          ? `${normalizeBedLabel(bed.bed_number)}: Occupied by ${bed.resident?.full_name} (${bed.resident?.resident_code || "Active"})`
                                          : `${normalizeBedLabel(bed.bed_number)}: ${bed.displayStatus}`
                                      }
                                      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-bold ${
                                        bed.occupied
                                          ? "bg-blue-100 text-blue-800"
                                          : bed.assignable ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"
                                      }`}
                                    >
                                      {normalizeBedLabel(bed.bed_number).replace(/^Bed\s+/i, "")}
                                      {hasResident ? " (👤)" : ""}
                                    </span>
                                  );
                                })}
                              </div>
                            )}
                            {currentRoomBeds.filter((bed) =>
                              isOperationalBedStatus(bed.status),
                            ).length > room.total_beds && (
                              <p className="mt-1 max-w-48 whitespace-normal text-xs font-medium text-amber-700">
                                Existing beds exceed capacity. Increase capacity
                                before adding more.
                              </p>
                            )}
                          </td>

                          <td className="whitespace-nowrap px-5 py-4">
                            <p className="text-sm font-semibold text-slate-800">
                              {formatMoney(room.monthly_rent)}
                            </p>
                            <p className="mt-1 text-xs text-slate-500">
                              Deposit:{" "}
                              {formatMoney(room.security_deposit_amount)}
                            </p>
                          </td>

                          <td className="px-5 py-4 text-xs text-slate-600">
                            <div className="flex flex-wrap gap-1.5">
                              {room.has_ac && <Tag label="AC" />}
                              {room.has_attached_bathroom && (
                                <Tag label="Attached Bath" />
                              )}
                              {room.has_balcony && <Tag label="Balcony" />}
                              {!room.has_ac &&
                                !room.has_attached_bathroom &&
                                !room.has_balcony && <span>Standard</span>}
                            </div>
                          </td>

                          <td className="whitespace-nowrap px-5 py-4">
                            <span
                              className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${statusClass(
                                roomOccupancy.status,
                              )}`}
                            >
                              {roomOccupancy.status}
                            </span>
                          </td>

                          <td className="whitespace-nowrap px-5 py-4">
                            <div className="flex gap-2">
                              <button
                                type="button"
                                onClick={() => openEditForm(room)}
                                className="rounded-lg border border-indigo-200 px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50"
                              >
                                Edit
                              </button>

                              <button
                                type="button"
                                disabled={deletingId === room.id}
                                onClick={() => void handleDelete(room)}
                                className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                              >
                                {deletingId === room.id
                                  ? "Updating..."
                                  : "Archive / Delete"}
                              </button>
                            </div>
                          </td>
                        </tr>

                        {isExpanded && (
                          <tr className="border-b border-slate-200 bg-slate-50/70">
                            <td colSpan={7} className="px-5 py-4">
                              <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-xs">
                                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                                  <div>
                                    <h4 className="text-sm font-bold text-slate-900">
                                      Room {room.room_number} — Beds & Occupants
                                    </h4>
                                    <p className="mt-0.5 text-xs text-slate-500">
                                      {roomOccupancy.capacity} active beds · {room.total_beds} configured capacity
                                    </p>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                                      {
                                        roomOccupancy.available
                                      }{" "}
                                      Assignable
                                    </span>
                                    <span className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-700">
                                      {occupiedCount} Occupied
                                    </span>
                                    {roomOccupancy.blocked > 0 && <span className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800">{roomOccupancy.blocked} Blocked by Exclusive</span>}
                                    {room.status !== "Inactive" && (
                                      <button
                                        type="button"
                                        onClick={() => void handleAddBedToRoom(room)}
                                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1 text-xs font-semibold text-white shadow-xs hover:bg-emerald-700 transition"
                                      >
                                        + Add Bed
                                      </button>
                                    )}
                                  </div>
                                </div>

                                {currentRoomBeds.length === 0 ? (
                                  <p className="py-4 text-center text-xs text-slate-400">
                                    No beds configured for this room yet. Click "+ Add Bed" above to add one.
                                  </p>
                                ) : (
                                  <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                                    {currentRoomBeds.map((bed) => {
                                      const res = bed.resident;
                                      const isOccupied = bed.occupied;
                                      return (
                                        <div
                                          key={bed.id}
                                          className={`rounded-xl border p-3 text-xs transition ${
                                            isOccupied
                                              ? "border-blue-200 bg-blue-50/40"
                                              : bed.assignable ? "border-emerald-200 bg-emerald-50/40" : "border-slate-200 bg-slate-50"
                                          }`}
                                        >
                                          <div className="flex items-center justify-between gap-2">
                                            <span className="text-sm font-bold text-slate-900">
                                              {normalizeBedLabel(bed.bed_number)}
                                            </span>
                                            <span
                                              className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                                isOccupied
                                                  ? "bg-blue-100 text-blue-700"
                                                  : bed.assignable ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"
                                              }`}
                                            >
                                              {bed.displayStatus}
                                            </span>
                                          </div>

                                          {res ? (
                                            <div className="mt-2.5 space-y-1 rounded-lg border border-blue-100 bg-white p-2.5 shadow-2xs">
                                              <div className="flex items-center gap-1.5 font-bold text-slate-900">
                                                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[10px] font-bold text-indigo-700">
                                                  {res.full_name
                                                    .slice(0, 1)
                                                    .toUpperCase()}
                                                </span>
                                                <span className="truncate">
                                                  {res.full_name}
                                                </span>
                                              </div>
                                              {res.resident_code && (
                                                <p className="text-[11px] text-slate-500">
                                                  Resident Code:{" "}
                                                  <span className="font-semibold text-slate-700">
                                                    {res.resident_code}
                                                  </span>
                                                </p>
                                              )}
                                              {res.phone && (
                                                <p className="text-[11px] text-slate-500">
                                                  Phone:{" "}
                                                  <span className="font-semibold text-slate-700">
                                                    {res.phone}
                                                  </span>
                                                </p>
                                              )}
                                              {res.admission_date && (
                                                <p className="text-[10px] text-slate-400">
                                                  Admitted: {res.admission_date}{" "}
                                                  ({res.status || "Active"})
                                                </p>
                                              )}
                                            </div>
                                          ) : (
                                            <div className="mt-2.5 flex items-center justify-between gap-1 border-t border-emerald-100 pt-2">
                                              <span className="text-[11px] font-medium text-emerald-700">
                                                {bed.displayStatus}
                                              </span>
                                              <button
                                                type="button"
                                                disabled={bed.blockedByExclusive}
                                                onClick={() => void handleRemoveBedFromRoom(bed, room)}
                                                title={bed.blockedByExclusive ? "This bed is reserved while the room has a current exclusive admission." : "Remove bed"}
                                                className="inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50/70 px-2 py-0.5 text-[10px] font-semibold text-red-700 hover:bg-red-100 hover:border-red-300 transition disabled:cursor-not-allowed disabled:opacity-40"
                                              >
                                                <svg
                                                  className="h-3 w-3"
                                                  fill="none"
                                                  viewBox="0 0 24 24"
                                                  stroke="currentColor"
                                                >
                                                  <path
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                    strokeWidth={2}
                                                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                                  />
                                                </svg>
                                                Remove
                                              </button>
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
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

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-3 text-sm text-slate-700">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-4 w-4"
      />
      {label}
    </label>
  );
}

function StatCard({ label, value, description }: { label: string; value: number | string; description?: string }) {
  return (
    <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <p className="mt-2 text-3xl font-bold text-slate-900">{value}</p>
      {description && <p className="mt-1 text-xs text-slate-500">{description}</p>}
    </article>
  );
}

function Tag({ label }: { label: string }) {
  return (
    <span className="rounded-full bg-slate-100 px-2 py-1 font-medium text-slate-700">
      {label}
    </span>
  );
}

function statusClass(status: string) {
  switch (status) {
    case "Available":
      return "bg-emerald-100 text-emerald-700";
    case "Fully Occupied":
      return "bg-red-100 text-red-700";
    case "Exclusively Occupied":
      return "bg-amber-100 text-amber-800";
    case "Partially Occupied":
      return "bg-amber-100 text-amber-700";
    case "Maintenance":
      return "bg-orange-100 text-orange-700";
    default:
      return "bg-slate-200 text-slate-700";
  }
}
