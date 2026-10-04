"use client";

import {
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
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
import { buildRoomOccupancy, summarizeBedInventory, type OccupancyAdmission } from "@/lib/roomOccupancy";
import {
  canonicalBedLabelKey,
  compareBedRecordsAscending,
  getNextCanonicalBedLabels,
  normalizeBedLabel,
  parseBedNumber,
} from "@/lib/bedLabels";
import {
  BED_STATUS,
  type BedStatus,
  type ReadableBedStatus,
  isOperationalBedStatus,
  isVacantBedStatus,
} from "@/lib/statuses";

type RoomStatus = "Available" | "Occupied" | "Partially Occupied" | "Exclusively Occupied" | "Maintenance" | "Inactive";

type Room = {
  id: string;
  room_number: string;
  block_name: string | null;
  floor_number: number | null;
  room_type: string | null;
  total_beds: number;
  occupied_beds: number;
  status: RoomStatus;
  monthly_rent: number | null;
  description: string | null;
  created_at: string;
  updated_at: string;
};

type BedOccupantInfo = {
  resident_id: string;
  full_name: string;
  resident_code: string | null;
  phone: string | null;
  admission_date: string | null;
  status: string | null;
};

type Bed = {
  id: string;
  room_id: string;
  bed_number: string;
  status: ReadableBedStatus;
  mattress_condition: string | null;
  mattress_cover: string | null;
  created_at: string;
  occupant?: BedOccupantInfo | null;
  blockedByExclusive?: boolean;
};

type RoomForm = {
  room_number: string;
  block_name: string;
  floor_number: string;
  room_type: string;
  total_beds: string;
  status: RoomStatus;
  monthly_rent: string;
  description: string;
};

type BedForm = {
  room_id: string;
  bed_number: string;
  status: BedStatus;
  mattress_condition: string;
  mattress_cover: string;
};

const emptyRoomForm: RoomForm = {
  room_number: "",
  block_name: "",
  floor_number: "",
  room_type: "Shared",
  total_beds: "1",
  status: "Available",
  monthly_rent: "",
  description: "",
};

const emptyBedForm: BedForm = {
  room_id: "",
  bed_number: "",
  status: BED_STATUS.VACANT,
  mattress_condition: "Good",
  mattress_cover: "Available",
};

const inputClass =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-slate-100";

function roomStatusClass(status: RoomStatus) {
  if (status === "Available") return "bg-emerald-100 text-emerald-700";
  if (status === "Occupied") return "bg-blue-100 text-blue-700";
  if (status === "Exclusively Occupied") return "bg-amber-100 text-amber-800";
  if (status === "Maintenance") return "bg-amber-100 text-amber-700";
  return "bg-slate-200 text-slate-700";
}

function bedStatusClass(status: string) {
  if (status === "Vacant") return "bg-emerald-100 text-emerald-700";
  if (status === "Occupied") return "bg-blue-100 text-blue-700";
  if (status.startsWith("Blocked")) return "bg-amber-100 text-amber-800";
  return "bg-slate-200 text-slate-700";
}

function money(value: number | null) {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(value ?? 0);
}

export default function RoomsPage() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [beds, setBeds] = useState<Bed[]>([]);
  const [roomAdmissions, setRoomAdmissions] = useState<OccupancyAdmission[]>([]);
  const [referencedBedIds, setReferencedBedIds] = useState<Set<string>>(
    new Set(),
  );
  const [referencedRoomIds, setReferencedRoomIds] = useState<Set<string>>(
    new Set(),
  );
  const [expandedInactiveRoomIds, setExpandedInactiveRoomIds] = useState<
    Set<string>
  >(new Set());
  const [roomForm, setRoomForm] = useState<RoomForm>(emptyRoomForm);
  const [bedForm, setBedForm] = useState<BedForm>(emptyBedForm);
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const [showRoomForm, setShowRoomForm] = useState(false);
  const [showBedForm, setShowBedForm] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [loading, setLoading] = useState(true);
  const [savingRoom, setSavingRoom] = useState(false);
  const [savingBed, setSavingBed] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");

    const [
      { data: roomsData, error: roomsError },
      { data: bedsData, error: bedsError },
      { data: admissionData, error: admissionError },
    ] = await Promise.all([
        supabase.from("rooms").select("*").order("room_number"),
        supabase.from("beds").select("*").order("bed_number"),
        supabase
          .from("admissions")
          .select("id, bed_id, room_id, resident_id, allocation_mode, status, admission_date, residents(id, full_name, resident_code, phone)")
          .in("status", ["Active", "Pending"]),
      ]);

    if (roomsError) {
      setError(getSupabaseErrorMessage(roomsError, "Rooms could not be loaded."));
      setRooms([]);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mappedRooms = (roomsData ?? []).map((r: any) => ({
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

    const occupantMap = new Map<string, BedOccupantInfo>();
    const activeAdmissions = (admissionData ?? []) as Array<OccupancyAdmission & { residents?: { id?: string; full_name?: string; resident_code?: string; phone?: string } | null }>;
    if (!admissionError && admissionData) {
      setRoomAdmissions(admissionData as OccupancyAdmission[]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (admissionData as any[]).forEach((adm) => {
        if (adm.bed_id && adm.residents) {
          occupantMap.set(adm.bed_id, {
            resident_id: adm.resident_id,
            full_name: adm.residents.full_name || "Resident",
            resident_code: adm.residents.resident_code || null,
            phone: adm.residents.phone || null,
            admission_date: adm.admission_date || null,
            status: adm.status || null,
          });
        }
      });
    }

    if (bedsError) {
      setError((current) =>
        current
          ? `${current} Beds could not be loaded.`
          : getSupabaseErrorMessage(bedsError, "Beds could not be loaded.")
      );
      setBeds([]);
    } else {
      const exclusiveRooms = new Set(activeAdmissions.filter(admission => admission.allocation_mode === "whole_room").map(admission => admission.room_id));
      const mappedBeds: Bed[] = ((bedsData ?? []) as Bed[]).map((bed) => ({
        ...bed,
        occupant: occupantMap.get(bed.id) ?? null,
        blockedByExclusive: exclusiveRooms.has(bed.room_id) && bed.status === BED_STATUS.VACANT && !occupantMap.has(bed.id),
      }));
      setBeds(mappedBeds);
    }

    if (admissionError) {
      setRoomAdmissions([]);
      setError((current) =>
        current
          ? `${current} | Unable to verify room and bed references.`
          : "Unable to verify room and bed references.",
      );
      setReferencedBedIds(new Set());
      setReferencedRoomIds(new Set());
    } else {
      const references = (admissionData ?? []) as Array<{
        bed_id: string | null;
        room_id: string | null;
      }>;
      setReferencedBedIds(
        new Set(
          references
            .map((reference) => reference.bed_id)
            .filter((id): id is string => Boolean(id)),
        ),
      );
      setReferencedRoomIds(
        new Set(
          references
            .map((reference) => reference.room_id)
            .filter((id): id is string => Boolean(id)),
        ),
      );
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    const reload = () => { void refresh(); };
    const changed = (event: StorageEvent) => { if (event.key === "admission-allocation-changed") reload(); };
    window.addEventListener("focus", reload);
    window.addEventListener("admission-allocation-changed", reload);
    window.addEventListener("storage", changed);
    return () => { window.removeEventListener("focus", reload); window.removeEventListener("admission-allocation-changed", reload); window.removeEventListener("storage", changed); };
  }, [refresh]);

  useEffect(() => {
    // Loading remote Supabase data is the external synchronization for this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const filteredRooms = useMemo(() => {
    const query = search.trim().toLowerCase();

    return rooms.filter((room) => {
      const matchesSearch =
        !query ||
        room.room_number.toLowerCase().includes(query) ||
        (room.block_name ?? "").toLowerCase().includes(query) ||
        String(room.floor_number ?? "").toLowerCase().includes(query) ||
        (room.room_type ?? "").toLowerCase().includes(query);

      const matchesStatus = statusFilter === "All" || buildRoomOccupancy(
        room as { id: string; status: string | null }, beds, roomAdmissions,
      ).status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [rooms, beds, roomAdmissions, search, statusFilter]);

  const summary = useMemo(() => {
    const inventory = summarizeBedInventory(rooms as Array<{ id: string; status: string | null }>, beds, roomAdmissions);
    const totalBeds = inventory.active;
    const occupiedBeds = inventory.occupied;
    const vacantBeds = inventory.bookable;
    const blockedBeds = inventory.blocked;

    return {
      totalRooms: rooms.length,
      availableRooms: rooms.filter((room) => buildRoomOccupancy(room as { id: string; status: string | null }, beds, roomAdmissions).available > 0).length,
      totalBeds,
      occupiedBeds,
      vacantBeds,
      blockedBeds,
    };
  }, [rooms, beds, roomAdmissions]);

  const roomsWithBedCapacity = useMemo(
    () =>
      rooms.filter(
        (room) =>
          room.status !== "Inactive" &&
          beds.filter(
            (bed) =>
              bed.room_id === room.id && isOperationalBedStatus(bed.status),
          ).length < room.total_beds,
      ),
    [rooms, beds],
  );

  function updateRoomField<K extends keyof RoomForm>(
    key: K,
    value: RoomForm[K]
  ) {
    setRoomForm((current) => ({ ...current, [key]: value }));
  }

  function updateBedField<K extends keyof BedForm>(
    key: K,
    value: BedForm[K],
  ) {
    if (key === "room_id" && typeof value === "string") {
      const selectedRoom = rooms.find((r) => r.id === value);
      const roomExistingBeds = beds
        .filter((b) => b.room_id === value)
        .map((b) => b.bed_number);
      const nextLabels = getNextCanonicalBedLabels(
        1,
        roomExistingBeds,
        selectedRoom?.room_number,
      );
      const suggested = nextLabels[0] || `${selectedRoom?.room_number ?? ""} A`;
      setBedForm((current) => ({
        ...current,
        room_id: value,
        bed_number: suggested,
      }));
      return;
    }
    setBedForm((current) => ({ ...current, [key]: value }));
  }

  function toggleInactiveBeds(roomId: string) {
    setExpandedInactiveRoomIds((current) => {
      const next = new Set(current);
      if (next.has(roomId)) next.delete(roomId);
      else next.add(roomId);
      return next;
    });
  }

  function openAddRoom() {
    setEditingRoomId(null);
    setRoomForm(emptyRoomForm);
    setShowRoomForm(true);
    setShowBedForm(false);
    setMessage("");
    setError("");
  }

  function openEditRoom(room: Room) {
    setEditingRoomId(room.id);
    setRoomForm({
      room_number: room.room_number,
      block_name: room.block_name ?? "",
      floor_number: room.floor_number == null ? "" : String(room.floor_number),
      room_type: room.room_type ?? "Shared",
      total_beds: String(room.total_beds ?? 1),
      status: room.status,
      monthly_rent: room.monthly_rent ? String(room.monthly_rent) : "",
      description: room.description ?? "",
    });
    setShowRoomForm(true);
    setShowBedForm(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openAddBed(roomId = "") {
    const activeRooms = rooms.filter((room) => room.status !== "Inactive");
    const selectedRoom = roomId
      ? rooms.find((room) => room.id === roomId)
      : activeRooms[0] || rooms[0];

    if (!selectedRoom || selectedRoom.status === "Inactive") {
      setError("Please select an active room before adding a bed.");
      setShowBedForm(false);
      return;
    }

    const roomExistingBeds = beds
      .filter((bed) => bed.room_id === selectedRoom.id)
      .map((bed) => bed.bed_number);

    const nextLabels = getNextCanonicalBedLabels(
      1,
      roomExistingBeds,
      selectedRoom.room_number,
    );
    const suggestedBedNumber =
      nextLabels[0] || `${selectedRoom.room_number} A`;

    setBedForm({
      ...emptyBedForm,
      room_id: selectedRoom.id,
      bed_number: suggestedBedNumber,
    });
    setShowBedForm(true);
    setShowRoomForm(false);
    setMessage("");
    setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function saveRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingRoom(true);
    setMessage("");
    setError("");

    if (!roomForm.room_number.trim()) {
      setError("Room number is required.");
      setSavingRoom(false);
      return;
    }

    const capacity = Math.max(1, Number(roomForm.total_beds) || 1);
    const parsedFloorNumber =
      roomForm.floor_number && /^-?\d+$/.test(roomForm.floor_number.trim())
        ? parseInt(roomForm.floor_number.trim(), 10)
        : null;

    const payload = {
      room_number: roomForm.room_number.trim(),
      block_name: roomForm.block_name.trim() || null,
      floor_number: parsedFloorNumber,
      room_type: roomForm.room_type.trim() || "Shared",
      total_beds: capacity,
      status: roomForm.status,
      monthly_rent: roomForm.monthly_rent
        ? Number(roomForm.monthly_rent)
        : 0,
      description: roomForm.description.trim() || null,
      updated_at: new Date().toISOString(),
    };

    let bedCapacityResult: BedCapacityResult | null = null;
    if (editingRoomId) {
      bedCapacityResult = await prepareRoomBedCapacity({
        roomId: editingRoomId,
        capacity,
        allowIncrease: roomForm.status !== "Inactive",
      });
      if (bedCapacityResult.error) {
        setError(bedCapacityResult.error);
        setSavingRoom(false);
        return;
      }
    }

    const result = editingRoomId
      ? await supabase
          .from("rooms")
          .update(payload)
          .eq("id", editingRoomId)
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
    } else {
      let partialSuccessError = "";
      const savedRoomId = String(result.data.id);
      if (!editingRoomId && roomForm.status !== "Inactive") {
        const provisionResult = await provisionRoomBeds({
          roomId: savedRoomId,
          capacity,
        });

        if (provisionResult.errors.length > 0) {
          partialSuccessError = `Room saved, but only ${provisionResult.created} of ${provisionResult.requested} missing beds were created. Refresh and retry after resolving the database error.`;
        } else {
          setMessage(
            `${editingRoomId ? "Room updated" : "Room added"} successfully.${
              provisionResult.created > 0
                ? ` ${provisionResult.created} vacant bed${
                    provisionResult.created === 1 ? " was" : "s were"
                  } created automatically.`
                : ""
            }`,
          );
        }
      } else if (!editingRoomId) {
        setMessage(
          `${editingRoomId ? "Room updated" : "Room added"} successfully. No beds were created because the room is Inactive.`,
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
      setShowRoomForm(false);
      setRoomForm(emptyRoomForm);
      setEditingRoomId(null);
      await refresh();
      if (partialSuccessError) setError(partialSuccessError);
    }

    setSavingRoom(false);
  }

  async function saveBed(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingBed(true);
    setMessage("");
    setError("");

    if (!bedForm.room_id || !bedForm.bed_number.trim()) {
      setError("Room and bed number are required.");
      setSavingBed(false);
      return;
    }

    const result = await addSingleBed({
      roomId: bedForm.room_id,
      bedNumber: bedForm.bed_number,
      mattressCondition: bedForm.mattress_condition,
      mattressCover: bedForm.mattress_cover,
    });

    if (!result.success) {
      setError(result.error || "The bed could not be added.");
    } else {
      setMessage(
        `Bed "${normalizeBedLabel(bedForm.bed_number)}" added successfully.${
          result.newCapacity
            ? ` Room capacity automatically updated to ${result.newCapacity}.`
            : ""
        }`,
      );
      setShowBedForm(false);
      setBedForm(emptyBedForm);
      await refresh();
    }

    setSavingBed(false);
  }

  async function deleteRoom(room: Room) {
    const hasLinks =
      beds.some((bed) => bed.room_id === room.id) ||
      referencedRoomIds.has(room.id);
    const action = hasLinks ? "mark this room Inactive" : "delete this room";

    if (!window.confirm(`Are you sure you want to ${action}?`)) return;

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
        await refresh();
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
      await refresh();
    }
  }

  async function deleteBed(bed: Bed) {
    if (bed.status === BED_STATUS.OCCUPIED || referencedBedIds.has(bed.id)) {
      setError("Occupied beds with active residents cannot be removed.");
      return;
    }

    const bedLabel = normalizeBedLabel(bed.bed_number);
    const room = rooms.find((r) => r.id === bed.room_id);
    const roomText = room ? ` from Room ${room.room_number}` : "";

    if (
      !window.confirm(
        `Are you sure you want to remove ${bedLabel}${roomText}? The room's capacity will be adjusted automatically.`,
      )
    ) {
      return;
    }

    const result = await removeSingleBed({
      bedId: bed.id,
      roomId: bed.room_id,
    });

    if (!result.success) {
      setError(result.error || "The bed could not be removed.");
    } else {
      setMessage(
        `Bed ${bedLabel} removed successfully.${
          result.newCapacity
            ? ` Room capacity updated to ${result.newCapacity}.`
            : ""
        }`,
      );
      await refresh();
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-7xl space-y-6">

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

        {showRoomForm && (
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-6 flex items-center justify-between gap-4">
              <h2 className="text-xl font-bold text-slate-900">
                {editingRoomId ? "Edit Room" : "Add Room"}
              </h2>
              <button
                type="button"
                onClick={() => setShowRoomForm(false)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                Close
              </button>
            </div>

            <form onSubmit={saveRoom} className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <Field label="Room Number *">
                  <input
                    required
                    value={roomForm.room_number}
                    onChange={(event) =>
                      updateRoomField("room_number", event.target.value)
                    }
                    className={inputClass}
                    placeholder="101"
                  />
                </Field>

                <Field label="Building">
                  <input
                    value={roomForm.block_name}
                    onChange={(event) =>
                      updateRoomField("block_name", event.target.value)
                    }
                    className={inputClass}
                    placeholder="Main Building"
                  />
                </Field>

                <Field label="Floor">
                  <input
                    value={roomForm.floor_number}
                    onChange={(event) =>
                      updateRoomField("floor_number", event.target.value)
                    }
                    className={inputClass}
                    placeholder="Ground Floor"
                  />
                </Field>

                <Field label="Room Type">
                  <select
                    value={roomForm.room_type}
                    onChange={(event) =>
                      updateRoomField("room_type", event.target.value)
                    }
                    className={inputClass}
                  >
                    <option value="2 Sharing">2 Sharing</option>
                    <option value="3 Sharing">3 Sharing</option>
                    <option value="Single Economy">Single Economy</option>
                    <option value="Single Deluxe">Single Deluxe</option>
                    <option value="Single">Single</option>
                    <option value="Shared">Shared</option>
                    <option value="Dormitory">Dormitory</option>
                    <option value="Private">Private</option>
                  </select>
                </Field>

                <Field label="Capacity">
                  <input
                    type="number"
                    min="1"
                    value={roomForm.total_beds}
                    onChange={(event) =>
                      updateRoomField("total_beds", event.target.value)
                    }
                    className={inputClass}
                  />
                </Field>

                <Field label="Status">
                  <select
                    value={roomForm.status}
                    onChange={(event) =>
                      updateRoomField(
                        "status",
                        event.target.value as RoomStatus
                      )
                    }
                    className={inputClass}
                  >
                    <option value="Available">Available</option>
                    <option value="Occupied">Occupied</option>
                    <option value="Maintenance">Maintenance</option>
                    <option value="Inactive">Inactive</option>
                  </select>
                </Field>

                <Field label="Monthly Rent">
                  <input
                    type="number"
                    min="0"
                    value={roomForm.monthly_rent}
                    onChange={(event) =>
                      updateRoomField("monthly_rent", event.target.value)
                    }
                    className={inputClass}
                    placeholder="15000"
                  />
                </Field>

                <Field label="Notes" wide>
                  <textarea
                    value={roomForm.description}
                    onChange={(event) =>
                      updateRoomField("description", event.target.value)
                    }
                    className={`${inputClass} min-h-24`}
                    placeholder="Room notes"
                  />
                </Field>
              </div>

              <div className="flex flex-wrap justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowRoomForm(false)}
                  className="rounded-xl border border-slate-300 px-5 py-3 text-sm font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingRoom}
                  className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {savingRoom
                    ? "Saving..."
                    : editingRoomId
                    ? "Update Room"
                    : "Save Room"}
                </button>
              </div>
            </form>
          </section>
        )}

        {showBedForm && (
          <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
            <div className="mb-6 flex items-center justify-between gap-4">
              <h2 className="text-xl font-bold text-slate-900">
                Add Bed
              </h2>
              <button
                type="button"
                onClick={() => setShowBedForm(false)}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                Close
              </button>
            </div>

            <form onSubmit={saveBed} className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <Field label="Room *">
                  <select
                    required
                    value={bedForm.room_id}
                    onChange={(event) =>
                      updateBedField("room_id", event.target.value)
                    }
                    className={inputClass}
                  >
                    <option value="">Select room</option>
                    {rooms
                      .filter((room) => room.status !== "Inactive")
                      .map((room) => {
                        const roomActiveBeds = beds.filter(
                          (b) =>
                            b.room_id === room.id &&
                            isOperationalBedStatus(b.status),
                        ).length;
                        return (
                          <option key={room.id} value={room.id}>
                            {/^\d+$/.test(room.room_number)
                              ? `Room ${room.room_number}`
                              : room.room_number}{" "}
                            ({roomActiveBeds} / {room.total_beds} beds)
                          </option>
                        );
                      })}
                  </select>
                </Field>

                <Field label="Bed Number *">
                  <input
                    required
                    value={bedForm.bed_number}
                    onChange={(event) =>
                      updateBedField("bed_number", event.target.value)
                    }
                    className={inputClass}
                    placeholder="e.g. 106 E"
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    Auto-suggested for this room. You can also customize the label.
                  </p>
                </Field>

                <Field label="Status">
                  <select
                    value={bedForm.status}
                    disabled
                    className={inputClass}
                  >
                    <option value={BED_STATUS.VACANT}>Vacant</option>
                  </select>
                </Field>

                <Field label="Mattress Condition">
                  <select
                    value={bedForm.mattress_condition}
                    onChange={(event) =>
                      updateBedField(
                        "mattress_condition",
                        event.target.value
                      )
                    }
                    className={inputClass}
                  >
                    <option value="Good">Good</option>
                    <option value="Fair">Fair</option>
                    <option value="Damaged">Damaged</option>
                    <option value="Not Available">Not Available</option>
                  </select>
                </Field>

                <Field label="Mattress Cover">
                  <select
                    value={bedForm.mattress_cover}
                    onChange={(event) =>
                      updateBedField("mattress_cover", event.target.value)
                    }
                    className={inputClass}
                  >
                    <option value="Available">Available</option>
                    <option value="Not Available">Not Available</option>
                    <option value="Damaged">Damaged</option>
                  </select>
                </Field>
              </div>

              <div className="flex flex-wrap justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowBedForm(false)}
                  className="rounded-xl border border-slate-300 px-5 py-3 text-sm font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingBed}
                  className="rounded-xl bg-emerald-600 px-5 py-3 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {savingBed ? "Saving..." : "Save Bed"}
                </button>
              </div>
            </form>
          </section>
        )}

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
          <StatCard label="Total Rooms" value={String(summary.totalRooms)} />
          <StatCard
            label="Available Rooms"
            value={String(summary.availableRooms)}
          />
          <StatCard label="Total Beds" value={String(summary.totalBeds)} />
          <StatCard
            label="Occupied Beds"
            value={String(summary.occupiedBeds)}
          />
          <StatCard label="Bookable Vacant Beds" value={String(summary.vacantBeds)} />
                          <StatCard label="Blocked by Exclusive" value={String(summary.blockedBeds)} />
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
          <div className="grid gap-3 border-b border-slate-200 p-5 lg:grid-cols-[1fr_220px_auto]">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className={inputClass}
              placeholder="Search room, building, floor or type"
            />

            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              className={inputClass}
            >
              <option value="All">All Statuses</option>
              <option value="Available">Available</option>
              <option value="Partially Occupied">Partially Occupied</option>
              <option value="Fully Occupied">Fully Occupied</option>
              <option value="Exclusively Occupied">Exclusively Occupied</option>
              <option value="Occupied">Occupied</option>
              <option value="Maintenance">Maintenance</option>
              <option value="Inactive">Inactive</option>
            </select>

            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold"
            >
              Refresh
            </button>
          </div>

          <div className="space-y-5 p-5">
            {loading ? (
              <p className="py-10 text-center text-sm text-slate-500">
                Loading rooms...
              </p>
            ) : filteredRooms.length === 0 ? (
              <p className="py-10 text-center text-sm text-slate-500">
                No rooms found.
              </p>
            ) : (
              filteredRooms.map((room) => {
                const roomBeds = beds.filter((bed) => bed.room_id === room.id);
                const roomOccupancy = buildRoomOccupancy(room as { id: string; status: string | null }, roomBeds, roomAdmissions);
                const activeRoomBeds = roomBeds
                  .filter((bed) => isOperationalBedStatus(bed.status))
                  .sort(compareBedRecordsAscending);
                const inactiveRoomBeds = roomBeds
                  .filter((bed) => bed.status === BED_STATUS.INACTIVE)
                  .sort(compareBedRecordsAscending);
                const inactiveExpanded = expandedInactiveRoomIds.has(room.id);
                const occupied = roomOccupancy.occupied;
                const roomHasLinks =
                  roomBeds.length > 0 || referencedRoomIds.has(room.id);
                const canAddBed = room.status !== "Inactive";
                const exceedsCapacity = activeRoomBeds.length > room.total_beds;

                return (
                  <article
                    key={room.id}
                    className="rounded-3xl border border-slate-200 p-5"
                  >
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-3">
                          <h2 className="text-2xl font-bold text-slate-900">
                            {/^\d+$/.test(room.room_number)
                              ? `Room ${room.room_number}`
                              : room.room_number}
                          </h2>
                          <span
                            className={`rounded-full px-3 py-1 text-xs font-bold ${roomStatusClass(
                              roomOccupancy.status as RoomStatus
                            )}`}
                          >
                            {roomOccupancy.status}
                          </span>
                        </div>

                        <p className="mt-2 text-sm text-slate-500">
                          {room.block_name || "No building"} ·{" "}
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
                            : "No floor"}{" "}
                          · {room.room_type || "No type"}
                        </p>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        {canAddBed && (
                          <button
                            type="button"
                            onClick={() => openAddBed(room.id)}
                            className="inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 transition"
                          >
                            + Add Bed
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => openEditRoom(room)}
                          className="rounded-lg border border-indigo-200 px-3 py-2 text-xs font-semibold text-indigo-700"
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteRoom(room)}
                          className="rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700"
                        >
                          {roomHasLinks ? "Mark Inactive" : "Delete"}
                        </button>
                      </div>
                    </div>

                    {exceedsCapacity && (
                      <p className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
                        This room has more beds than its configured capacity.
                        Increase the room capacity before adding more beds.
                      </p>
                    )}

                    <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
                      <InfoCard label="Capacity" value={String(room.total_beds)} />
                      <InfoCard
                        label="Beds Added"
                        value={String(activeRoomBeds.length)}
                      />
                      <InfoCard
                        label="Occupied Beds"
                        value={String(occupied)}
                      />
                      <InfoCard label="Blocked by Exclusive" value={String(roomOccupancy.blocked)} />
                      <InfoCard label="Bookable Beds" value={String(roomOccupancy.available)} />
                      <InfoCard
                        label="Monthly Rent"
                        value={money(room.monthly_rent)}
                      />
                    </div>

                    <div className="mt-5">
                      <h3 className="text-sm font-bold text-slate-900">
                        Beds
                      </h3>

                      {activeRoomBeds.length === 0 ? (
                        <p className="mt-3 rounded-2xl bg-slate-50 p-4 text-sm text-slate-500">
                          No operational beds.
                        </p>
                      ) : (
                        <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                          {activeRoomBeds.map((bed) => (
                            <BedCard
                              key={bed.id}
                              bed={bed}
                              canDelete={
                                bed.status !== BED_STATUS.OCCUPIED &&
                                !bed.blockedByExclusive &&
                                !referencedBedIds.has(bed.id)
                              }
                              onDelete={() => void deleteBed(bed)}
                            />
                          ))}
                        </div>
                      )}
                    </div>

                    {inactiveRoomBeds.length > 0 && (
                      <div className="mt-5 border-t border-slate-200 pt-5">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <h3 className="text-sm font-bold text-slate-900">
                            Inactive / Historical Beds ({inactiveRoomBeds.length})
                          </h3>
                          <button
                            type="button"
                            aria-expanded={inactiveExpanded}
                            aria-controls={`inactive-beds-${room.id}`}
                            onClick={() => toggleInactiveBeds(room.id)}
                            className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            {inactiveExpanded
                              ? "Hide Inactive Beds"
                              : "Show Inactive Beds"}
                          </button>
                        </div>

                        {inactiveExpanded && (
                          <div
                            id={`inactive-beds-${room.id}`}
                            className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3"
                          >
                            {inactiveRoomBeds.map((bed) => (
                              <BedCard
                                key={bed.id}
                                bed={bed}
                                canDelete={
                                  bed.status !== BED_STATUS.OCCUPIED &&
                                  !bed.blockedByExclusive &&
                                  !referencedBedIds.has(bed.id)
                                }
                                onDelete={() => void deleteBed(bed)}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </article>
                );
              })
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function BedCard({
  bed,
  canDelete = false,
  onDelete,
}: {
  bed: Bed;
  canDelete?: boolean;
  onDelete?: () => void;
}) {
  const occupant = bed.occupant;
  const isOccupied = bed.status === "Occupied" || Boolean(occupant);
  const blockedByExclusive = Boolean(bed.blockedByExclusive) && !occupant;

  return (
    <div
      className={`rounded-2xl border p-4 transition ${
        isOccupied
          ? "border-blue-200 bg-blue-50/40"
          : blockedByExclusive ? "border-amber-200 bg-amber-50/50"
          : "border-slate-200 bg-slate-50"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="font-bold text-slate-900">
          {normalizeBedLabel(bed.bed_number)}
        </p>
        <span
          className={`rounded-full px-3 py-1 text-xs font-bold ${bedStatusClass(
            blockedByExclusive ? "Blocked by Exclusive" : bed.status,
          )}`}
        >
          {blockedByExclusive ? "Blocked (Exclusive)" : bed.status}
        </span>
      </div>

      {occupant ? (
        <div className="mt-3 rounded-xl border border-blue-100 bg-white p-3 shadow-2xs">
          <p className="text-[10px] font-bold uppercase tracking-wider text-blue-700">
            Occupant Resident
          </p>
          <div className="mt-1 flex items-center gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">
              {occupant.full_name.slice(0, 1).toUpperCase()}
            </span>
            <p className="truncate text-sm font-bold text-slate-900">
              {occupant.full_name}
            </p>
          </div>
          <div className="mt-2 space-y-0.5 text-xs text-slate-600">
            {occupant.resident_code && (
              <p>
                Code:{" "}
                <span className="font-semibold text-slate-800">
                  {occupant.resident_code}
                </span>
              </p>
            )}
            {occupant.phone && (
              <p>
                Phone:{" "}
                <span className="font-semibold text-slate-800">
                  {occupant.phone}
                </span>
              </p>
            )}
            {occupant.admission_date && (
              <p className="text-[11px] text-slate-500">
                Admitted: {occupant.admission_date} ({occupant.status || "Active"})
              </p>
            )}
          </div>
        </div>
      ) : blockedByExclusive ? (
        <p className="mt-3 text-xs font-semibold text-amber-800">
          Blocked by Whole-Room Allocation · not bookable
        </p>
      ) : (
        <p className="mt-3 text-xs font-medium text-emerald-700">
          ✓ Vacant · Available for Admission
        </p>
      )}

      <div className="mt-3 flex items-center justify-between border-t border-slate-200/70 pt-2 text-[11px] text-slate-500">
        <span>Mattress: {bed.mattress_condition || "Standard"}</span>
        <span>Cover: {bed.mattress_cover || "Standard"}</span>
      </div>

      {canDelete && onDelete ? (
        <button
          type="button"
          onClick={onDelete}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50/70 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 hover:border-red-300 transition"
        >
          <svg
            className="h-3.5 w-3.5"
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
          Remove Bed
        </button>
      ) : isOccupied ? (
        <p className="mt-3 text-[11px] font-medium text-slate-400 italic">
          Occupied · Cannot remove
        </p>
      ) : null}
    </div>
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
      <p className="mt-2 font-semibold text-slate-900">{value}</p>
    </article>
  );
}
