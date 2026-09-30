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
import {
  compareBedRecordsAscending,
  normalizeBedLabel,
} from "@/lib/bedLabels";
import {
  ALLOCATABLE_BED_STATUSES,
  BED_STATUS,
  RESIDENT_STATUS,
  isAllocatableBedStatus,
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

type AdmissionOccupant = {
  admission_id: string;
  bed_id: string;
  resident_name: string;
  resident_code: string | null;
  status: string | null;
};

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

function createContractNumber() {
  return `CNT-${new Date().getFullYear()}-${Date.now().toString().slice(-8)}`;
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
  const [admissionDate, setAdmissionDate] = useState("");
  const [monthlyRent, setMonthlyRent] = useState("");
  const [securityDeposit, setSecurityDeposit] = useState("");
  const [specialClauses, setSpecialClauses] = useState("");
  const [residents, setResidents] = useState<Resident[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [beds, setBeds] = useState<Bed[]>([]);
  const [occupants, setOccupants] = useState<Map<string, AdmissionOccupant>>(new Map());
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
        .select("id, bed_id, room_id, status, residents(id, full_name, resident_code)")
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

    const occupantMap = new Map<string, AdmissionOccupant>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ((admissionsResult.data ?? []) as any[]).forEach((item) => {
      if (item.bed_id) {
        occupantMap.set(item.bed_id, {
          admission_id: item.id,
          bed_id: item.bed_id,
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

  const availableBeds = useMemo(
    () =>
      roomBedsList.filter(
        (bed) =>
          isAllocatableBedStatus(bed.status) && !occupants.has(bed.id),
      ),
    [roomBedsList, occupants],
  );

  const roomBedStats = useMemo(() => {
    const stats = new Map<string, { total: number; available: number; occupied: number }>();
    rooms.forEach((r) => {
      const roomAllBeds = beds.filter((b) => String(b.room_id) === String(r.id));
      const available = roomAllBeds.filter(
        (b) => isAllocatableBedStatus(b.status) && !occupants.has(b.id),
      ).length;
      const occupied = roomAllBeds.filter(
        (b) => b.status === BED_STATUS.OCCUPIED || occupants.has(b.id),
      ).length;
      stats.set(r.id, { total: roomAllBeds.length, available, occupied });
    });
    return stats;
  }, [rooms, beds, occupants]);

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

    if (!residentId || !roomId || !bedId || !admissionDate || Number(monthlyRent) <= 0) {
      setError("Resident, room, bed, admission date, and monthly rent are required.");
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

    try {
      const [residentResult, roomResult, currentAdmissionResult] =
        await Promise.all([
          supabase
            .from("residents")
            .select("id, status")
            .eq("id", residentId)
            .maybeSingle(),
          supabase
            .from("rooms")
            .select("id, status")
            .eq("id", roomId)
            .maybeSingle(),
          supabase
            .from("admissions")
            .select("id")
            .eq("resident_id", residentId)
            .in("status", ["Active", "Pending"])
            .limit(1)
            .maybeSingle(),
        ]);

      if (residentResult.error) {
        throw new Error(
          getSupabaseErrorMessage(
            residentResult.error,
            "Unable to verify the selected resident.",
          ),
        );
      }
      if (!residentResult.data || residentResult.data.status === "Archived") {
        await loadResidents();
        setResidentId("");
        throw new Error("The selected resident is no longer available for admission.");
      }

      if (roomResult.error) {
        throw new Error(
          getSupabaseErrorMessage(
            roomResult.error,
            "Unable to verify the selected room.",
          ),
        );
      }
      if (!roomResult.data || !isAdmissionRoomStatus(roomResult.data.status)) {
        await loadRoomsAndBeds();
        setRoomId("");
        setBedId("");
        throw new Error("The selected room is no longer available for admission.");
      }

      const { data: activeAdmission, error: duplicateError } =
        currentAdmissionResult;

      if (duplicateError) {
        throw new Error(
          getSupabaseErrorMessage(
            duplicateError,
            "Unable to verify the resident's current admissions.",
          ),
        );
      }
      if (activeAdmission) {
        throw new Error("This resident already has a current admission.");
      }

      const { data: templates, error: templateError } = await supabase
        .from("contract_templates")
        .select("id, content")
        .eq("is_active", true)
        .order("id", { ascending: false });

      if (templateError) {
        throw new Error(
          getSupabaseErrorMessage(
            templateError,
            "Unable to verify the active contract template. The admission was not created.",
          ),
        );
      }

      if ((templates ?? []).length === 0) {
        throw new Error(
          "No active contract template is available. Activate one standard contract template before creating an admission.",
        );
      }

      if ((templates ?? []).length > 1) {
        throw new Error(
          "Multiple active contract templates are available. Keep exactly one standard template active before creating an admission.",
        );
      }

      const template = templates![0];
      const standardTerms = (template.content ?? "").trim();

      if (!standardTerms) {
        throw new Error(
          "The active contract template has no terms. Complete the standard template before creating an admission.",
        );
      }

      let portalLogin;
      try {
        portalLogin = await ensureResidentLogin(residentId);
      } catch (loginError) {
        throw new Error(
          `Portal access could not be prepared, so the admission was not created. ${
            loginError instanceof Error
              ? loginError.message
              : "Please try again."
          }`,
        );
      }

      if (occupants.has(bedId)) {
        const existing = occupants.get(bedId);
        await loadRoomsAndBeds();
        setBedId("");
        throw new Error(
          `This bed is already occupied by ${existing?.resident_name || "another resident"}. Please select an available bed.`,
        );
      }

      const { data: claimedBed, error: claimError } = await supabase
        .from("beds")
        .update({ status: BED_STATUS.OCCUPIED })
        .eq("id", bedId)
        .eq("room_id", roomId)
        .in("status", [...ALLOCATABLE_BED_STATUSES])
        .select("id")
        .maybeSingle();

      if (claimError) {
        throw new Error(
          getSupabaseErrorMessage(
            claimError,
            "Unable to allocate this bed. Please select another bed.",
          ),
        );
      }
      if (!claimedBed) {
        await loadRoomsAndBeds();
        setBedId("");
        throw new Error(
          "This bed is no longer vacant. Please select another bed.",
        );
      }

      // A previous admission does not waive this admission's deposit.
      const effectiveSecurityDeposit = Number(securityDeposit || 0);

      const { data: admissionData, error: admissionError } = await supabase
        .from("admissions")
        .insert({
          resident_id: residentId,
          room_id: roomId,
          bed_id: bedId,
          admission_date: admissionDate,
          monthly_rent: Number(monthlyRent),
          security_deposit: effectiveSecurityDeposit,
          deposit_status: effectiveSecurityDeposit === 0 ? "Held" : "Pending",
          status: "Pending",
        })
        .select("id")
        .single();

      if (admissionError) {
        const { data: releasedBed, error: rollbackError } = await supabase
          .from("beds")
          .update({ status: BED_STATUS.VACANT })
          .eq("id", bedId)
          .eq("status", BED_STATUS.OCCUPIED)
          .select("id")
          .maybeSingle();
        if (rollbackError || !releasedBed) {
          throw new Error(
            "Admission was not saved, and the bed could not be released automatically. Please contact an administrator.",
          );
        }
        throw new Error(
          getSupabaseErrorMessage(
            admissionError,
            "Unable to save the admission. The selected bed was released.",
          ),
        );
      }

      const now = new Date().toISOString();
      const cleanSpecialClauses = specialClauses.trim();
      const termsSnapshot = `${standardTerms}${
        cleanSpecialClauses
          ? `\n\nSpecial Clauses:\n${cleanSpecialClauses}`
          : ""
      }`;

      const { error: contractError } = await supabase.from("contracts").insert({
        contract_number: createContractNumber(),
        resident_id: residentId,
        admission_id: admissionData.id,
        room_id: roomId,
        bed_id: bedId,
        template_id: template.id,
        contract_content: termsSnapshot,
        start_date: admissionDate,
        end_date: null,
        monthly_rent: Number(monthlyRent),
        security_deposit: Number(securityDeposit || 0),
        notice_period_days: 30,
        status: "Pending Signature",
        resident_signature_status: "Pending",
        owner_signature_status: "Pending",
        signed_by_resident: false,
        signed_at: null,
        notes: cleanSpecialClauses || null,
        created_at: now,
        updated_at: now,
      });

      if (contractError) {
        const { data: rolledBackAdmission, error: admissionRollbackError } =
          await supabase
          .from("admissions")
          .delete()
          .eq("id", admissionData.id)
          .eq("status", "Pending")
          .select("id")
          .maybeSingle();

        if (admissionRollbackError || !rolledBackAdmission) {
          throw new Error(
            "The contract could not be prepared and the admission could not be rolled back. Its occupied bed was preserved; please review this admission before trying again.",
          );
        }

        const { data: releasedBed, error: bedRollbackError } = await supabase
          .from("beds")
          .update({ status: BED_STATUS.VACANT })
          .eq("id", bedId)
          .eq("status", BED_STATUS.OCCUPIED)
          .select("id")
          .maybeSingle();

        if (bedRollbackError || !releasedBed) {
          throw new Error(
            "The contract could not be prepared. The admission was rolled back, but its bed could not be released automatically. Please review the bed allocation before trying again.",
          );
        }

        throw new Error(
          getSupabaseErrorMessage(
            contractError,
            `The contract could not be prepared, so the admission was rolled back. Please try again. Detailed error: ${contractError.message || JSON.stringify(contractError)}`,
            "A non-cancelled contract already exists for this admission.",
          ),
        );
      }

      const initialRent = Number(monthlyRent);
      const admissionMonth = admissionDate.slice(0, 7);
      const { data: initialRentBill, error: rentBillError } = await supabase
        .from("bills")
        .insert({
          bill_number: `RENT-${Math.random().toString(36).substr(2, 9).toUpperCase()}`,
          resident_id: residentId,
          admission_id: admissionData.id,
          billing_month: admissionMonth,
          due_date: admissionDate,
          rent_amount: initialRent,
          total_amount: initialRent,
          balance_amount: initialRent,
          bill_status: "Pending",
          bill_type: "Rent",
          notes: "Initial rent generated with admission. Future rent is generated by monthly billing.",
        })
        .select("id")
        .single();
      if (rentBillError) console.error("Failed to generate initial rent bill:", rentBillError);
      if (initialRentBill?.id) {
        await requestEventNotification("bill_generated", String(initialRentBill.id), { channels: ["email"] });
      }
      if (effectiveSecurityDeposit > 0) {
        const { data: depositBillData, error: billError } = await supabase
          .from("bills")
          .insert({
            bill_number: `DEP-${Math.random().toString(36).substr(2, 9).toUpperCase()}`,
            resident_id: residentId,
            admission_id: admissionData.id,
            billing_month: "Security Deposit",
            due_date: new Date(new Date().setDate(new Date().getDate() + 5)).toISOString().split("T")[0],
            rent_amount: 0,
            total_amount: effectiveSecurityDeposit,
            balance_amount: effectiveSecurityDeposit,
            bill_status: "Pending",
            bill_type: "Security Deposit",
            notes: "Auto-generated Security Deposit bill.",
          })
          .select("id")
          .single();
        if (billError) console.error("Failed to generate security deposit bill:", billError);
        if (depositBillData?.id) {
          await requestEventNotification("bill_generated", String(depositBillData.id), { channels: ["email"] });
        }
      }

      const [notificationResult, loginNotificationResult] = await Promise.all([
        requestEventNotification("admission_created", admissionData.id, {
          channels: communicationChannels,
        }),
        requestEventNotification("resident_login_details_sent", admissionData.id, {
          channels: communicationChannels,
        }),
      ]);

      setResidentId("");
      setRoomId("");
      setBedId("");
      setAdmissionDate("");
      setMonthlyRent("");
      setSecurityDeposit("");
      setSpecialClauses("");
      setMessage(
        `Admission saved as Pending and its contract was prepared for resident signature.${
          portalLogin.created && portalLogin.temporaryPassword
            ? ` Portal login: ${portalLogin.email} | One-time temporary password: ${portalLogin.temporaryPassword} (${portalLogin.emailSent ? "Credentials sent via email" : "Provide to resident now; not stored in database"}).`
            : ` Portal access is ready for ${portalLogin.email}.`
        }${notificationWarning(notificationResult)}${notificationWarning(loginNotificationResult)}`,
      );
      await Promise.all([loadRoomsAndBeds(), onSaved()]);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Unable to save admission.",
      );
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
              Select a resident and manually allocate a vacant bed.
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
                  const isFull = availableCount === 0 && totalCount > 0;
                  return (
                    <option key={room.id} value={room.id}>
                      Room {room.room_number} ({availableCount} of {totalCount} beds available){isFull ? " — FULL" : ""}
                    </option>
                  );
                })}
              </select>
            </label>

            <label>
              <span className="mb-2 block text-sm font-semibold text-slate-700">
                Bed *
              </span>
              <select
                required
                value={bedId}
                onChange={(event) => setBedId(event.target.value)}
                className={inputClass}
                disabled={!roomId || loading || saving}
              >
                <option value="">
                  {!roomId
                    ? "Select a room first"
                    : availableBeds.length === 0
                    ? "No vacant beds in this room"
                    : "Select available bed"}
                </option>
                {roomBedsList.map((bed) => {
                  const occupant = occupants.get(bed.id);
                  const isAvailable =
                    isAllocatableBedStatus(bed.status) && !occupant;
                  if (isAvailable) {
                    return (
                      <option key={bed.id} value={bed.id}>
                        🟢 {normalizeBedLabel(bed.bed_number)} — Available ({bed.status})
                      </option>
                    );
                  }
                  return (
                    <option key={bed.id} value={bed.id} disabled>
                      🔴 {normalizeBedLabel(bed.bed_number)} — Occupied by {occupant?.resident_name || "Resident"} (Unavailable)
                    </option>
                  );
                })}
              </select>
            </label>

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

          {roomId && (
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
                  {availableBeds.length} Available / {roomBedsList.length} Total Beds
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {roomBedsList.map((bed) => {
                  const occupant = occupants.get(bed.id);
                  const isAvailable =
                    isAllocatableBedStatus(bed.status) && !occupant;
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
                          Occupied by {occupant?.resident_name || "Resident"}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              {availableBeds.length === 0 && (
                <p className="mt-2.5 text-xs font-semibold text-amber-800">
                  ⚠️ This room has no available beds. All beds are occupied. Please select another room above.
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
