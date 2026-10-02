"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { supabase } from "@/lib/supabase";
import { ensureResidentLogin } from "@/lib/residentLogin";
import {
  notificationWarning,
  requestEventNotification,
} from "@/lib/notifications/client";
import type { NotificationChannel } from "@/lib/notifications/types";
import { getSupabaseErrorMessage } from "@/lib/supabaseErrors";
import { buildRoomOccupancy } from "@/lib/roomOccupancy";
import {
  compareBedRecordsAscending,
  normalizeBedLabel,
} from "@/lib/bedLabels";
import {
  isOperationalBedStatus,
  RESIDENT_STATUS,
} from "@/lib/statuses";

type Resident = {
  id: string;
  resident_code: string | null;
  full_name: string;
  phone: string | null;
  email: string | null;
  cnic: string | null;
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
  status: string | null;
};

type AllocationMode = "single_bed" | "whole_room";

type AdmissionOccupant = {
  admission_id: string; bed_id: string; room_id: string; resident_id: string;
  allocation_mode: AllocationMode; resident_name: string;
  resident_code: string | null; status: string | null;
};
type CurrentAdmission = { id: string; room_id: string; bed_id: string; resident_id: string; allocation_mode: AllocationMode; status: string; resident_name: string };

type ResidentForm = {
  fullName: string;
  fatherName: string;
  phone: string;
  email: string;
  cnic: string;
};

const emptyResidentForm: ResidentForm = {
  fullName: "",
  fatherName: "",
  phone: "",
  email: "",
  cnic: "",
};

const inputClass =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-slate-100";

function createResidentCode() {
  const now = new Date();
  return `RES-${now.getFullYear()}-${`${now.getTime()}`.slice(-8)}`;
}

function isAdmissionRoomStatus(status: string | null) {
  return ["Available", "Partially Occupied", "Occupied"].includes(status ?? "");
}

function normalizeEmail(value: string | null) {
  return (value ?? "").trim().toLowerCase();
}

function normalizePhone(value: string | null) {
  return (value ?? "").replace(/[\s()-]/g, "");
}

function normalizeIdentity(value: string | null) {
  return (value ?? "").trim().toLowerCase().replace(/[\s-]/g, "");
}

export default function AdmissionForm({
  onSaved,
  refreshKey,
}: {
  onSaved: () => Promise<void>;
  refreshKey: number;
}) {
  const [residentId, setResidentId] = useState("");
  const [roomId, setRoomId] = useState("");
  const [bedId, setBedId] = useState("");
  const [allocationMode, setAllocationMode] = useState<AllocationMode>("single_bed");
  const [admissionDate, setAdmissionDate] = useState("");
  const [monthlyRent, setMonthlyRent] = useState("");
  const [securityDeposit, setSecurityDeposit] = useState("");
  const [specialClauses, setSpecialClauses] = useState("");
  const [residents, setResidents] = useState<Resident[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [beds, setBeds] = useState<Bed[]>([]);
  const [occupants, setOccupants] = useState<Map<string, AdmissionOccupant>>(new Map());
  const [currentAdmissions, setCurrentAdmissions] = useState<CurrentAdmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [showResidentModal, setShowResidentModal] = useState(false);
  const [residentForm, setResidentForm] =
    useState<ResidentForm>(emptyResidentForm);
  const [savingResident, setSavingResident] = useState(false);
  const [residentError, setResidentError] = useState("");
  const [communicationChannels, setCommunicationChannels] =
    useState<NotificationChannel[]>(["email", "whatsapp"]);

  function toggleCommunicationChannel(channel: NotificationChannel) {
    setCommunicationChannels((current) =>
      current.includes(channel)
        ? current.filter((item) => item !== channel)
        : [...current, channel],
    );
  }

  const loadResidents = useCallback(async () => {
    const { data, error: residentLoadError } = await supabase
      .from("residents")
      .select("id, resident_code, full_name, phone, email, cnic, status")
      .order("full_name", { ascending: true });

    if (residentLoadError) {
      throw new Error(
        getSupabaseErrorMessage(
          residentLoadError,
          "Unable to load residents for admission.",
        ),
      );
    }

    const activeResidents = ((data ?? []) as Resident[]).filter(
      (resident) => resident.status !== "Archived",
    );
    setResidents(activeResidents);
    return activeResidents;
  }, []);

  const loadRoomsAndBeds = useCallback(async () => {
    const [roomResult, bedResult, admissionsResult] = await Promise.all([
      supabase
        .from("rooms")
        .select("id, room_number, status")
        .order("room_number", { ascending: true }),
      supabase
        .from("beds")
        .select("id, room_id, bed_number, status")
        .order("bed_number", { ascending: true }),
      supabase
        .from("admissions")
        .select("id, bed_id, room_id, allocation_mode, status, residents(id, full_name, resident_code)")
        .in("status", ["Active", "Pending"]),
    ]);

    if (roomResult.error) {
      throw new Error(
        getSupabaseErrorMessage(
          roomResult.error,
          "Unable to load rooms for admission.",
        ),
      );
    }
    if (bedResult.error) {
      throw new Error(
        getSupabaseErrorMessage(
          bedResult.error,
          "Unable to load beds for admission.",
        ),
      );
    }
    if (admissionsResult.error) {
      throw new Error(getSupabaseErrorMessage(admissionsResult.error, "Unable to verify current room allocations."));
    }

    const occupantMap = new Map<string, AdmissionOccupant>();
    const currentRoomAdmissions: CurrentAdmission[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((admissionsResult.data ?? []) as any[]).forEach((item) => {
      currentRoomAdmissions.push({ id: item.id, room_id: item.room_id, bed_id: item.bed_id, resident_id: item.residents?.id || "", allocation_mode: item.allocation_mode === "whole_room" ? "whole_room" : "single_bed", status: item.status, resident_name: item.residents?.full_name || "Resident" });
      if (item.bed_id) {
        occupantMap.set(item.bed_id, {
          admission_id: item.id,
          bed_id: item.bed_id,
          room_id: item.room_id,
          resident_id: item.residents?.id || "",
          allocation_mode: item.allocation_mode === "whole_room" ? "whole_room" : "single_bed",
          resident_name: item.residents?.full_name || "Resident",
          resident_code: item.residents?.resident_code || null,
          status: item.status,
        });
      }
    });

    setRooms(
      ((roomResult.data ?? []) as Room[]).filter(
        (room) => isAdmissionRoomStatus(room.status),
      ),
    );
    setBeds((bedResult.data ?? []) as Bed[]);
    setOccupants(occupantMap);
    setCurrentAdmissions(currentRoomAdmissions);
  }, []);

  useEffect(() => {
    let active = true;

    // Loading remote Supabase data is the external synchronization for this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    Promise.all([loadResidents(), loadRoomsAndBeds()])
      .catch((loadError: unknown) => {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Unable to load admission form data.",
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [loadResidents, loadRoomsAndBeds, refreshKey]);

  useEffect(() => {
    if (!showResidentModal) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [showResidentModal]);

  const roomBedsList = useMemo(
    () =>
      beds
        .filter((bed) => String(bed.room_id) === roomId)
        .sort(compareBedRecordsAscending),
    [beds, roomId],
  );

  const availableBeds = useMemo(() => {
    const room = rooms.find(item => item.id === roomId);
    return room ? buildRoomOccupancy(room, roomBedsList, currentAdmissions).beds.filter(bed => bed.assignable) : [];
  }, [rooms, roomBedsList, currentAdmissions, roomId]);

  const occupantsByRoom = useMemo(() => {
    const grouped = new Map<string, typeof currentAdmissions>();
    currentAdmissions.forEach(admission => grouped.set(admission.room_id, [...(grouped.get(admission.room_id) ?? []), admission]));
    return grouped;
  }, [currentAdmissions]);

  const roomBedStats = useMemo(() => {
    const stats = new Map<string, { total: number; available: number; occupied: number }>();
    rooms.forEach((r) => {
      const roomAllBeds = beds.filter((b) => String(b.room_id) === String(r.id));
      const occupancy = buildRoomOccupancy(r, roomAllBeds, currentAdmissions);
      stats.set(r.id, { total: occupancy.capacity, available: occupancy.available, occupied: occupancy.occupied });
    });
    return stats;
  }, [rooms, beds, currentAdmissions]);

  function closeResidentModal() {
    if (savingResident) return;
    setShowResidentModal(false);
    setResidentError("");
    setResidentForm(emptyResidentForm);
  }

  async function saveResident(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingResident(true);
    setResidentError("");

    const fullName = residentForm.fullName.trim();
    const fatherName = residentForm.fatherName.trim();
    const phone = residentForm.phone.trim();
    const email = residentForm.email.trim().toLowerCase();
    const cnic = residentForm.cnic.trim();

    if (!fullName || !phone || !email || !cnic) {
      setResidentError("Full name, phone, email, and CNIC are required.");
      setSavingResident(false);
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setResidentError("Enter a valid email address.");
      setSavingResident(false);
      return;
    }

    try {
      const { data: residentRows, error: duplicateError } = await supabase
        .from("residents")
        .select("id, email, phone, cnic");

      if (duplicateError) {
        throw new Error(
          getSupabaseErrorMessage(
            duplicateError,
            "Unable to verify resident details. Please try again.",
          ),
        );
      }

      const duplicate = ((residentRows ?? []) as Pick<
        Resident,
        "id" | "email" | "phone" | "cnic"
      >[]).some(
        (resident) =>
          normalizeEmail(resident.email) === email ||
          normalizePhone(resident.phone) === normalizePhone(phone) ||
          normalizeIdentity(resident.cnic) === normalizeIdentity(cnic),
      );

      if (duplicate) {
        throw new Error(
          "A resident with the same email, phone, or CNIC already exists.",
        );
      }

      const now = new Date().toISOString();
      const { data: newResident, error: insertError } = await supabase
        .from("residents")
        .insert({
          resident_code: createResidentCode(),
          full_name: fullName,
          father_name: fatherName || null,
          phone,
          email,
          cnic,
          status: RESIDENT_STATUS.INACTIVE,
          created_at: now,
          updated_at: now,
        })
        .select("id, resident_code, full_name, phone, email, cnic, status")
        .single();

      if (insertError || !newResident) {
        throw new Error(
          getSupabaseErrorMessage(
            insertError,
            "Resident could not be saved. Please try again.",
            "A resident with the same email, phone, or CNIC already exists.",
          ),
        );
      }

      let loginMessage = "";
      try {
        const login = await ensureResidentLogin(String(newResident.id));
        loginMessage = login.created
          ? ` Portal login: ${login.email} | One-time temporary password: ${login.temporaryPassword} (${login.emailSent ? "Credentials sent via email" : "Provide to resident now; not stored in database"}).`
          : ` A portal login already exists for ${login.email}.`;
      } catch (loginError) {
        loginMessage = ` Portal login was not created automatically. ${
          loginError instanceof Error ? loginError.message : "Please create it later."
        }`;
      }

      const refreshedResidents = await loadResidents();
      if (!refreshedResidents.some((resident) => resident.id === newResident.id)) {
        setResidents((current) => [...current, newResident as Resident]);
      }
      setResidentId(String(newResident.id));
      setResidentForm(emptyResidentForm);
      setShowResidentModal(false);
      setMessage(`${newResident.full_name} was added and selected.${loginMessage}`);
    } catch (saveError) {
      setResidentError(
        saveError instanceof Error
          ? saveError.message
          : "Unable to save resident.",
      );
    } finally {
      setSavingResident(false);
    }
  }

  async function saveAdmission(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    setError("");

    if (!residentId || !roomId || (allocationMode === "single_bed" && !bedId) || !admissionDate || Number(monthlyRent) <= 0) {
      setError(`Resident, room, ${allocationMode === "single_bed" ? "bed, " : ""}admission date, and monthly rent are required.`);
      setSaving(false);
      return;
    }
    if (Number(securityDeposit || 0) < 0) {
      setError("Security deposit cannot be negative.");
      setSaving(false);
      return;
    }
    if (communicationChannels.length === 0) {
      setError("Select at least one communication channel for resident access details.");
      setSaving(false);
      return;
    }

    let packageSaved = false;
    try {
      const { data: admissionPackage, error: packageError } = await supabase.rpc("create_admission_package", {
        p_resident_id: residentId,
        p_room_id: roomId,
        p_bed_id: allocationMode === "whole_room" ? null : bedId,
        p_admission_date: admissionDate,
        p_monthly_rent: Number(monthlyRent),
        p_security_deposit: Number(securityDeposit || 0),
        p_special_clauses: specialClauses.trim(),
        p_allocation_mode: allocationMode,
      });
      if (packageError) {
        throw new Error(["22023", "23514", "23505", "42501"].includes(packageError.code)
          ? packageError.message
          : getSupabaseErrorMessage(packageError, "The admission could not be confirmed. Refresh Admissions before retrying."));
      }
      if (!admissionPackage?.admission_id || !admissionPackage?.rent_bill_id || !admissionPackage?.contract_id) {
        throw new Error("The admission result could not be confirmed. Refresh Admissions before retrying.");
      }
      packageSaved = true;
      // Required records have committed. External failures must never undo them.
      setResidentId("");
      setRoomId("");
      setBedId("");
      setAllocationMode("single_bed");
      setAdmissionDate("");
      setMonthlyRent("");
      setSecurityDeposit("");
      setSpecialClauses("");

      let portalMessage = "";
      let portalReady = false;
      try {
        const portalLogin = await ensureResidentLogin(residentId);
        portalReady = true;
        portalMessage = portalLogin.created && portalLogin.temporaryPassword
          ? ` Portal login: ${portalLogin.email} | One-time temporary password: ${portalLogin.temporaryPassword} (${portalLogin.emailSent ? "Credentials sent via email" : "Provide to resident now; not stored in database"}).`
          : ` Portal access is ready for ${portalLogin.email}.`;
      } catch (loginError) {
        portalMessage = ` Admission was saved, but portal access could not be prepared. ${loginError instanceof Error ? loginError.message : "Please provision access later."}`;
      }
      const notificationResults = await Promise.all([
        requestEventNotification("bill_generated", admissionPackage.rent_bill_id, { channels: ["email"] }),
        ...(admissionPackage.deposit_bill_id
          ? [requestEventNotification("bill_generated", admissionPackage.deposit_bill_id, { channels: ["email"] })] : []),
        requestEventNotification("admission_created", admissionPackage.admission_id, { channels: communicationChannels }),
        ...(portalReady ? [requestEventNotification("resident_login_details_sent", admissionPackage.admission_id, { channels: communicationChannels })] : []),
      ]);
      setMessage(`Admission saved as Pending and its contract was prepared for resident signature.${portalMessage}${notificationResults.some(result => result.warning) ? notificationWarning({ delivered: false, configurationRequired: false, warning: true }) : ""}`);
      await Promise.all([loadRoomsAndBeds(), onSaved()]);
    } catch (saveError) {
      if (packageSaved) {
        setMessage(current => (current || "Admission and required bills/contract were saved as Pending.") + " A follow-up action failed. Refresh Admissions; do not create this admission again.");
      } else {
        setError(saveError instanceof Error ? saveError.message : "Unable to save admission.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-bold text-slate-900">New Admission</h2>
            <p className="mt-1 text-sm text-slate-500">
              Choose an allocation type and eligible room for the resident.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setResidentError("");
              setResidentForm(emptyResidentForm);
              setShowResidentModal(true);
            }}
            className="rounded-xl border border-indigo-200 px-4 py-2.5 text-sm font-semibold text-indigo-700 hover:bg-indigo-50"
          >
            + Add New Resident
          </button>
        </div>

        {(message || error) && (
          <div
            className={`mb-5 rounded-2xl border px-4 py-3 text-sm font-medium ${
              error
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-emerald-200 bg-emerald-50 text-emerald-700"
            }`}
          >
            {error || message}
          </div>
        )}

        <form onSubmit={saveAdmission} className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <label>
              <span className="mb-2 block text-sm font-semibold text-slate-700">
                Resident *
              </span>
              <select
                required
                value={residentId}
                onChange={(event) => setResidentId(event.target.value)}
                className={inputClass}
                disabled={loading || saving}
              >
                <option value="">Select resident</option>
                {residents.map((resident) => (
                  <option key={resident.id} value={resident.id}>
                    {resident.full_name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span className="mb-2 block text-sm font-semibold text-slate-700">Monthly Rent *</span>
              <input required type="number" min="0.01" step="0.01" value={monthlyRent} onChange={(event) => setMonthlyRent(event.target.value)} className={inputClass} disabled={loading || saving} />
            </label>

            <label>
              <span className="mb-2 block text-sm font-semibold text-slate-700">Security Deposit</span>
              <input type="number" min="0" step="0.01" value={securityDeposit} onChange={(event) => setSecurityDeposit(event.target.value)} className={inputClass} disabled={loading || saving} />
            </label>

            <label>
              <span className="mb-2 block text-sm font-semibold text-slate-700">Allocation Type *</span>
              <select required value={allocationMode} onChange={(event) => { setAllocationMode(event.target.value as AllocationMode); setRoomId(""); setBedId(""); }} className={inputClass} disabled={loading || saving}>
                <option value="single_bed">Single Bed</option>
                <option value="whole_room">Whole Room (Exclusive)</option>
              </select>
              {allocationMode === "whole_room" && <span className="mt-2 block text-xs text-slate-600">Books the entire room for this resident. No other bed in this room can be allocated while this admission is current.</span>}
            </label>

            <label>
              <span className="mb-2 block text-sm font-semibold text-slate-700">
                Room *
              </span>
              <select
                required
                value={roomId}
                onChange={(event) => {
                  setRoomId(event.target.value);
                  setBedId("");
                }}
                className={inputClass}
                disabled={loading || saving}
              >
                <option value="">Select room</option>
                {rooms.map((room) => {
                  const stat = roomBedStats.get(room.id);
                  const availableCount = stat ? stat.available : 0;
                  const totalCount = stat ? stat.total : 0;
                  const currentRoomAdmissions = occupantsByRoom.get(room.id) ?? [];
                  const exclusive = currentRoomAdmissions.some(admission => admission.allocation_mode === "whole_room");
                  const roomHasCurrentAdmission = currentRoomAdmissions.length > 0;
                  const eligible = allocationMode === "whole_room"
                    ? availableCount === totalCount && totalCount > 0 && !roomHasCurrentAdmission
                    : availableCount > 0 && !exclusive;
                  const isFull = !eligible && totalCount > 0;
                  return (
                    <option key={room.id} value={room.id} disabled={!eligible}>
                      Room {room.room_number} ({allocationMode === "whole_room" ? `${totalCount} beds` : `${availableCount} of ${totalCount} beds available`}){exclusive ? " — WHOLE ROOM RESERVED" : isFull ? " — UNAVAILABLE" : ""}
                    </option>
                  );
                })}
              </select>
            </label>

            {allocationMode === "single_bed" ? (
              <label>
                <span className="mb-2 block text-sm font-semibold text-slate-700">Bed *</span>
                <select required value={bedId} onChange={(event) => setBedId(event.target.value)} className={inputClass} disabled={!roomId || loading || saving}>
                  <option value="">{!roomId ? "Select a room first" : availableBeds.length === 0 ? "No vacant beds in this room" : "Select available bed"}</option>
                  {roomBedsList.map((bed) => {
                    const occupant = occupants.get(bed.id);
                    const isAvailable = availableBeds.some(item => item.id === bed.id);
                    return isAvailable
                      ? <option key={bed.id} value={bed.id}>🟢 {normalizeBedLabel(bed.bed_number)} — Available ({bed.status})</option>
                      : <option key={bed.id} value={bed.id} disabled>🔴 {normalizeBedLabel(bed.bed_number)} — {occupant ? `Occupied by ${occupant.resident_name}` : currentAdmissions.some(admission => admission.room_id === roomId && admission.allocation_mode === "whole_room") ? "Blocked by Whole-Room Allocation" : `${bed.status} (Unavailable)`}</option>;
                  })}
                </select>
              </label>
            ) : (
              <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 md:col-span-2" aria-live="polite">
                <h3 className="font-semibold">Whole Room Reservation</h3>
                {!roomId ? <p className="mt-1">Select an eligible room to preview the beds reserved.</p> : <>
                  <p className="mt-1">{roomBedStats.get(roomId)?.total ?? 0} active beds will be reserved exclusively for this resident.</p>
                  <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    {roomBedsList.filter(bed => isOperationalBedStatus(bed.status)).map(bed => <li key={bed.id}>{normalizeBedLabel(bed.bed_number)} — Will be reserved</li>)}
                  </ul>
                </>}
              </section>
            )}

            <label>
              <span className="mb-2 block text-sm font-semibold text-slate-700">
                Admission Date *
              </span>
              <input
                required
                type="date"
                value={admissionDate}
                onChange={(event) => setAdmissionDate(event.target.value)}
                className={inputClass}
                disabled={loading || saving}
              />
            </label>

            <label>
              <span className="mb-2 block text-sm font-semibold text-slate-700">
                Deposit Status
              </span>
              <input
                value="Pending — verify a submitted receipt in Payment Verification"
                className={inputClass}
                disabled
              />
            </label>
          </div>

              {roomId && allocationMode === "single_bed" && (
            <div
              className={`rounded-2xl border p-4 text-sm ${
                availableBeds.length === 0
                  ? "border-amber-200 bg-amber-50 text-amber-900"
                  : "border-indigo-100 bg-indigo-50/70 text-indigo-900"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold">
                  Room {rooms.find((r) => r.id === roomId)?.room_number} Bed Allocation Status:
                </p>
                <span className="rounded-full bg-white px-3 py-1 text-xs font-bold uppercase tracking-wider text-slate-700 shadow-xs">
                  {availableBeds.length} Available / {roomBedStats.get(roomId)?.total ?? 0} Active Beds
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {roomBedsList.map((bed) => {
                  const occupant = occupants.get(bed.id);
                  const isAvailable = availableBeds.some(item => item.id === bed.id);
                  const isSelected = bedId === bed.id;
                  return (
                    <button
                      type="button"
                      key={bed.id}
                      disabled={!isAvailable || saving}
                      onClick={() => {
                        if (isAvailable && !saving) setBedId(bed.id);
                      }}
                      className={`inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-xs font-medium transition ${
                        isAvailable
                          ? isSelected
                            ? "border-emerald-600 bg-emerald-600 text-white font-bold ring-2 ring-emerald-300"
                            : "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 cursor-pointer"
                          : "border-slate-200 bg-slate-100 text-slate-500 cursor-not-allowed"
                      }`}
                    >
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${
                          isAvailable
                            ? isSelected
                              ? "bg-white"
                              : "bg-emerald-500"
                            : "bg-red-400"
                        }`}
                      />
                      <span className="font-bold">
                        {normalizeBedLabel(bed.bed_number)}:
                      </span>
                      {isAvailable ? (
                        <span>{isSelected ? "Selected ✓" : "Available"}</span>
                      ) : (
                        <span className="font-semibold text-slate-700">
                          {occupant ? `Occupied by ${occupant.resident_name}` : allocationMode === "single_bed" && occupantsByRoom.get(roomId)?.some(admission => admission.allocation_mode === "whole_room") ? "Blocked by Whole-Room Allocation" : "Unavailable"}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              {availableBeds.length === 0 && (
                <p className="mt-2.5 text-xs font-semibold text-amber-800">
                  This room has no beds available under the selected allocation type. Select another eligible room.
                </p>
              )}
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <label className="md:col-span-2 xl:col-span-4">
              <span className="mb-2 block text-sm font-semibold text-slate-700">
                Special Contract Clauses (Optional)
              </span>
              <textarea
                rows={4}
                value={specialClauses}
                onChange={(event) => setSpecialClauses(event.target.value)}
                className={inputClass}
                disabled={loading || saving}
                placeholder="Leave blank to apply only the standard active contract template. Add resident-specific clauses here when required."
              />
              <span className="mt-2 block text-xs text-slate-500">
                These clauses will be appended to the saved standard template
                and preserved in this resident&apos;s contract snapshot.
              </span>
            </label>

            <fieldset className="md:col-span-2 xl:col-span-4">
              <legend className="mb-2 block text-sm font-semibold text-slate-700">
                Send resident access details via *
              </legend>
              <div className="flex flex-wrap gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
                {(
                  [
                    ["whatsapp", "WhatsApp"],
                    ["email", "Email"],
                    ["sms", "SMS / Text Message"],
                  ] as const
                ).map(([channel, label]) => (
                  <label key={channel} className="flex items-center gap-2 text-sm font-medium text-slate-700">
                    <input
                      type="checkbox"
                      checked={communicationChannels.includes(channel)}
                      onChange={() => toggleCommunicationChannel(channel)}
                      disabled={loading || saving}
                      className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                    />
                    {label}
                  </label>
                ))}
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Email and WhatsApp use the configured providers. SMS delivery is logged as configuration required until an SMS provider is connected.
              </p>
            </fieldset>
          </div>

          <div className="flex justify-end border-t border-slate-200 pt-5">
            <button
              type="submit"
              disabled={loading || saving}
              className="rounded-xl bg-indigo-600 px-6 py-3 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "Saving Admission..." : "Save Admission"}
            </button>
          </div>
        </form>
      </section>

      {showResidentModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-resident-title"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) closeResidentModal();
          }}
        >
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl bg-white p-4 shadow-2xl sm:p-8">
            <div className="mb-6 flex items-start justify-between gap-4">
              <div>
                <h3
                  id="new-resident-title"
                  className="text-2xl font-bold text-slate-900"
                >
                  Add New Resident
                </h3>
                <p className="mt-1 text-sm text-slate-500">
                  The new resident will be selected automatically.
                </p>
              </div>
              <button
                type="button"
                onClick={closeResidentModal}
                disabled={savingResident}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600"
              >
                Close
              </button>
            </div>

            {residentError && (
              <div className="mb-5 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
                {residentError}
              </div>
            )}

            <form onSubmit={saveResident} className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                {(
                  [
                    ["fullName", "Full Name *", "text"],
                    ["fatherName", "Father Name", "text"],
                    ["phone", "Phone *", "tel"],
                    ["email", "Email *", "email"],
                    ["cnic", "CNIC *", "text"],
                  ] as const
                ).map(([field, label, type]) => (
                  <label key={field}>
                    <span className="mb-2 block text-sm font-semibold text-slate-700">
                      {label}
                    </span>
                    <input
                      required={label.endsWith("*")}
                      type={type}
                      value={residentForm[field]}
                      onChange={(event) =>
                        setResidentForm((current) => ({
                          ...current,
                          [field]: event.target.value,
                        }))
                      }
                      className={inputClass}
                      disabled={savingResident}
                    />
                  </label>
                ))}
              </div>

              <div className="flex flex-col-reverse gap-3 border-t border-slate-200 pt-5 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={closeResidentModal}
                  disabled={savingResident}
                  className="rounded-xl border border-slate-300 px-5 py-2.5 text-sm font-semibold text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={savingResident}
                  className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {savingResident ? "Saving Resident..." : "Save Resident"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
