"use client";

import {
  ChangeEvent,
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { supabase } from "@/lib/supabase";
import { ensureResidentLogin, resetResidentPassword } from "@/lib/residentLogin";
import {
  getSupabaseErrorMessage,
} from "@/lib/supabaseErrors";
import {
  getOperationalResidentStatus,
  RESIDENT_STATUS,
  type ResidentStatus,
} from "@/lib/statuses";

import ProfileDocuments from "@/components/residents/ProfileDocuments";
import { profileDocumentError } from "@/lib/profileDocuments";
import { compressProfileImage } from "@/lib/compressProfileImage";
import EmergencyContacts from "@/components/residents/EmergencyContacts";
import StaffProfileContacts from "@/components/residents/StaffProfileContacts";
import { contactRelationships, type EmergencyContact } from "@/lib/residentProfile";

type GenericRow = Record<string, unknown>;

type Resident = {
  id: string;
  resident_code?: string | null;
  full_name: string;
  resident_identity_type?: string | null;
  guardian_identity_type?: string | null;
  guardian_cnic?: string | null;
  guardian_phone?: string | null;
  father_name?: string | null;
  phone?: string | null;
  email?: string | null;
  cnic?: string | null;
  dob?: string | null;
  gender?: string | null;
  emergency_contact_name?: string | null;
  emergency_contact_relationship?: string | null;
  emergency_contact?: string | null;
  permanent_address?: string | null;
  city?: string | null;
  nationality?: string | null;
  occupation?: string | null;
  company_university?: string | null;
  photo_url?: string | null;
  id_card_url?: string | null;
  status: ResidentStatus;
  created_at: string;
  updated_at: string;
};

type ResidentForm = {
  resident_code: string;
  full_name: string;
  resident_identity_type: string;
  guardian_identity_type: string;
  guardian_cnic: string;
  guardian_phone: string;
  father_name: string;
  cnic: string;
  dob: string;
  gender: string;
  phone: string;
  email: string;
  emergency_contact_name: string;
  emergency_contact_relationship: string;
  emergency_contact: string;
  permanent_address: string;
  city: string;
  nationality: string;
  occupation: string;
  company_university: string;
  photo_url: string;
  id_card_url: string;
  status: ResidentStatus;
};

type ProfileTab =
  | "Personal Information"
  | "Room & Bed"
  | "Admission"
  | "Contract"
  | "Billing"
  | "Payments"
  | "Deposit"
  | "Notices"
  | "Maintenance"
  | "Inspections"
  | "Documents"
  | "Activity Timeline";

type ProfileState = {
  resident: Resident | null;
  admission: GenericRow | null;
  contract: GenericRow | null;
  room: GenericRow | null;
  bed: GenericRow | null;
  bills: GenericRow[];
  payments: GenericRow[];
  notices: GenericRow[];
  maintenance: GenericRow[];
  inspections: GenericRow[];
  timeline: Array<{ title: string; detail: string; date: string }>;
};

const emptyForm: ResidentForm = {
  resident_code: "",
  full_name: "",
  resident_identity_type: "",
  guardian_identity_type: "",
  guardian_cnic: "",
  guardian_phone: "",
  father_name: "",
  cnic: "",
  dob: "",
  gender: "",
  phone: "",
  email: "",
  emergency_contact_name: "",
  emergency_contact_relationship: "",
  emergency_contact: "",
  permanent_address: "",
  city: "",
  nationality: "",
  occupation: "",
  company_university: "",
  photo_url: "",
  id_card_url: "",
  status: RESIDENT_STATUS.INACTIVE,
};

const emergencyRelationships = contactRelationships;

const inputClass =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-slate-100";

function text(value: unknown) {
  return value == null ? "" : String(value);
}

function normalizeEmail(value: unknown) {
  return text(value).trim().toLowerCase();
}

function normalizePhone(value: unknown) {
  return text(value).replace(/[\s()-]/g, "");
}

function normalizeIdentity(value: unknown) {
  return text(value).trim().toLowerCase().replace(/[\s-]/g, "");
}

function firstText(row: GenericRow | null, keys: string[]) {
  if (!row) return "";

  for (const key of keys) {
    const value = row[key];
    if (value !== null && value !== undefined && String(value).trim() !== "") {
      return String(value);
    }
  }

  return "";
}

function statusClass(status: ResidentStatus) {
  if (status === "Active") return "bg-emerald-100 text-emerald-700";
  if (status === "Archived") return "bg-slate-200 text-slate-700";
  if (status === "Checked Out") return "bg-red-100 text-red-700";
  if (status === "Notice Period") return "bg-amber-100 text-amber-700";
  if (status === "Reserved") return "bg-sky-100 text-sky-700";
  return "bg-slate-200 text-slate-700";
}

function generateResidentCode(existing: Resident[]) {
  const year = new Date().getFullYear();
  const next = String(existing.length + 1).padStart(4, "0");
  return `RES-${year}-${next}`;
}

function money(value: unknown) {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

async function readFileAsDataUrl(file: File) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new Error("Unable to read file."));
    reader.readAsDataURL(file);
  });
}

export default function ResidentsPage() {
  const [extraContacts, setExtraContacts] = useState<EmergencyContact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [documentsUploading, setDocumentsUploading] = useState(false);
  const [contactsVersion, setContactsVersion] = useState(0);
  const retryContactsFor = useRef<string | null>(null);
  const [residents, setResidents] = useState<Resident[]>([]);
  const [form, setForm] = useState<ResidentForm>(emptyForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [sortKey, setSortKey] = useState<"full_name" | "created_at" | "updated_at" | "status">("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);
  const [resettingPasswordId, setResettingPasswordId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [showProfile, setShowProfile] = useState(false);
  const [profileTab, setProfileTab] = useState<ProfileTab>("Personal Information");
  const [profileLoading, setProfileLoading] = useState(false);
  const [selectedResidentId, setSelectedResidentId] = useState<string | null>(null);
  const [profile, setProfile] = useState<ProfileState>({
    resident: null,
    admission: null,
    contract: null,
    room: null,
    bed: null,
    bills: [],
    payments: [],
    notices: [],
    maintenance: [],
    inspections: [],
    timeline: [],
  });
  const [photoFileName, setPhotoFileName] = useState("");
  const [idCardFileName, setIdCardFileName] = useState("");
  const [guardianFrontFile, setGuardianFrontFile] = useState<File | null>(null);
  const [guardianFrontFileName, setGuardianFrontFileName] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");

    const [residentResult, activeAdmissionResult] = await Promise.all([
      supabase
        .from("residents")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase
        .from("admissions")
        .select("resident_id")
        .eq("status", "Active"),
    ]);

    const loadError = residentResult.error || activeAdmissionResult.error;

    if (loadError) {
      setError(getSupabaseErrorMessage(loadError, "Unable to load residents."));
      setResidents([]);
    } else {
      const activeResidentIds = new Set(
        (activeAdmissionResult.data ?? []).map((admission) =>
          String(admission.resident_id),
        ),
      );

      setResidents(
        ((residentResult.data ?? []) as Resident[]).map((resident) => ({
          ...resident,
          status: getOperationalResidentStatus(
            resident.status,
            activeResidentIds.has(resident.id),
          ),
        })),
      );
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    // Loading remote Supabase data is the external synchronization for this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!selectedResidentId) return;

    let active = true;

    async function loadProfile() {
      setProfileLoading(true);
      setError("");

      const { data: residentData, error: residentError } = await supabase
        .from("residents")
        .select("*")
        .eq("id", selectedResidentId)
        .maybeSingle();

      if (!active) return;

      if (residentError || !residentData) {
        setProfile({
          resident: null,
          admission: null,
          contract: null,
          room: null,
          bed: null,
          bills: [],
          payments: [],
          notices: [],
          maintenance: [],
          inspections: [],
          timeline: [],
        });
        setProfileLoading(false);
        return;
      }

      const residentRecord = residentData as Resident;

      const [admissionResult, contractResult, billsResult, paymentsResult, noticesResult, inspectionsResult, maintenanceResult] = await Promise.all([
        supabase.from("admissions").select("*").eq("resident_id", selectedResidentId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("contracts").select("*").eq("resident_id", selectedResidentId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("bills").select("*").eq("resident_id", selectedResidentId).order("billing_month", { ascending: false }),
        supabase.from("payments").select("*").eq("resident_id", selectedResidentId).order("created_at", { ascending: false }),
        supabase.from("notices").select("*").order("publish_date", { ascending: false }),
        supabase.from("room_inspections").select("*").eq("resident_id", selectedResidentId).order("inspection_date", { ascending: false }),
        supabase.from("maintenance_requests").select("*").eq("resident_id", selectedResidentId).order("created_at", { ascending: false }),
      ]);

      if (!active) return;

      const admission = (admissionResult.data ?? null) as GenericRow | null;
      residentRecord.status = getOperationalResidentStatus(
        residentRecord.status,
        firstText(admission, ["status"]) === "Active",
      );
      const roomId = firstText(admission, ["room_id"]);
      const bedId = firstText(admission, ["bed_id"]);

      let room: GenericRow | null = null;
      let bed: GenericRow | null = null;

      if (roomId) {
        const roomResult = await supabase.from("rooms").select("*").eq("id", roomId).maybeSingle();
        room = (roomResult.data ?? null) as GenericRow | null;
      }

      if (bedId) {
        const bedResult = await supabase.from("beds").select("*").eq("id", bedId).maybeSingle();
        bed = (bedResult.data ?? null) as GenericRow | null;
      }

      const noticeRows = ((noticesResult.data ?? []) as GenericRow[]).filter((notice) => {
        const audience = firstText(notice, ["audience"]);
        if (audience !== "Specific Resident") return true;
        return firstText(notice, ["resident_id"]) === selectedResidentId;
      });

      const timeline = [
        { title: "Profile created", detail: residentRecord.full_name, date: residentRecord.created_at },
        { title: "Last profile update", detail: residentRecord.updated_at, date: residentRecord.updated_at },
      ];

      if (admission) {
        timeline.push({
          title: "Admission record",
          detail: `Room ${firstText(admission, ["room_id"]) || "—"}`,
          date: firstText(admission, ["admission_date"]) || residentRecord.created_at,
        });
      }

      const paymentRows = (paymentsResult.data ?? []) as GenericRow[];
      if (paymentRows.length > 0) {
        timeline.push({
          title: "Payments received",
          detail: `${paymentRows.length} payment record(s)`,
          date: firstText(paymentRows[0], ["created_at"]) || residentRecord.updated_at,
        });
      }

      const maintenanceRows = (maintenanceResult.data ?? []) as GenericRow[];
      if (maintenanceRows.length > 0) {
        timeline.push({
          title: "Maintenance requests",
          detail: `${maintenanceRows.length} request(s) logged`,
          date: firstText(maintenanceRows[0], ["created_at"]) || residentRecord.updated_at,
        });
      }

      setProfile({
        resident: residentRecord,
        admission: (admissionResult.data ?? null) as GenericRow | null,
        contract: (contractResult.data ?? null) as GenericRow | null,
        room,
        bed,
        bills: (billsResult.data ?? []) as GenericRow[],
        payments: paymentRows,
        notices: noticeRows,
        maintenance: maintenanceRows,
        inspections: (inspectionsResult.data ?? []) as GenericRow[],
        timeline,
      });
      setProfileLoading(false);
    }

    void loadProfile();

    return () => {
      active = false;
    };
  }, [selectedResidentId]);

  const filteredResidents = useMemo(() => {
    const query = search.trim().toLowerCase();

    return residents.filter((resident) => {
      const matchesSearch =
        !query ||
        resident.full_name.toLowerCase().includes(query) ||
        (resident.phone ?? "").toLowerCase().includes(query) ||
        (resident.email ?? "").toLowerCase().includes(query) ||
        (resident.cnic ?? "").toLowerCase().includes(query) ||
        (resident.resident_code ?? "").toLowerCase().includes(query);

      const matchesStatus = statusFilter === "All" || resident.status === statusFilter;

      return matchesSearch && matchesStatus;
    });
  }, [residents, search, statusFilter]);

  const sortedResidents = useMemo(() => {
    const sorted = [...filteredResidents];

    sorted.sort((left, right) => {
      let leftValue = left[sortKey] ?? "";
      let rightValue = right[sortKey] ?? "";

      if (typeof leftValue === "string") leftValue = leftValue.toLowerCase();
      if (typeof rightValue === "string") rightValue = rightValue.toLowerCase();

      const leftComparable = String(leftValue);
      const rightComparable = String(rightValue);

      if (leftComparable < rightComparable) return sortDir === "asc" ? -1 : 1;
      if (leftComparable > rightComparable) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

    return sorted;
  }, [filteredResidents, sortDir, sortKey]);

  const pagedResidents = useMemo(() => {
    const start = (page - 1) * pageSize;
    return sortedResidents.slice(start, start + pageSize);
  }, [page, pageSize, sortedResidents]);

  const pageCount = Math.max(1, Math.ceil(sortedResidents.length / pageSize));

  const summary = useMemo(
    () => ({
      total: residents.length,
      active: residents.filter((resident) => resident.status === "Active").length,
      inactive: residents.filter((resident) => resident.status === "Inactive").length,
      reserved: residents.filter((resident) => resident.status === "Reserved").length,
      notice: residents.filter((resident) => resident.status === "Notice Period").length,
      checkedOut: residents.filter((resident) => resident.status === "Checked Out").length,
      archived: residents.filter((resident) => resident.status === "Archived").length,
    }),
    [residents]
  );

  useEffect(() => {
    if (!editingId) return;
    if (retryContactsFor.current === editingId) {
      retryContactsFor.current = null;
      setContactsLoading(false);
      return;
    }
    let active = true;
    setContactsLoading(true);
    void supabase.from("resident_emergency_contacts").select("id,contact_name,relationship,phone").eq("resident_id", editingId).order("created_at").then(({ data, error }) => {
      if (!active) return;
      if (error) { setError("Unable to load emergency contacts. Reopen Edit to retry."); return; }
      setExtraContacts(data || []);
      setContactsLoading(false);
    });
    return () => { active = false; };
  }, [editingId, contactsVersion]);

  function updateField<K extends keyof ResidentForm>(key: K, value: ResidentForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function openAddForm() {
    setExtraContacts([]);
    setContactsLoading(false);
    setEditingId(null);
    setForm({
      ...emptyForm,
      resident_code: generateResidentCode(residents),
    });
    setPhotoFileName("");
    setIdCardFileName("");
    setGuardianFrontFile(null);
    setGuardianFrontFileName("");
    setMessage("");
    setError("");
    setShowForm(true);
  }

  function openEditForm(resident: Resident) {
    if (resident.status === "Archived") {
      setError("Archived resident records cannot be edited.");
      return;
    }

    setContactsLoading(true);
    setExtraContacts([]);
    setContactsVersion(value => value + 1);
    setEditingId(resident.id);
    setForm({
      resident_code: resident.resident_code ?? "",
      full_name: resident.full_name,
      resident_identity_type: resident.resident_identity_type ?? "",
      guardian_identity_type: resident.guardian_identity_type ?? "",
      guardian_cnic: resident.guardian_cnic ?? "",
      guardian_phone: resident.guardian_phone ?? "",
      father_name: resident.father_name ?? "",
      cnic: resident.cnic ?? "",
      dob: resident.dob ?? "",
      gender: resident.gender ?? "",
      phone: resident.phone ?? "",
      email: resident.email ?? "",
      emergency_contact_name: resident.emergency_contact_name ?? "",
      emergency_contact_relationship: resident.emergency_contact_relationship ?? "",
      emergency_contact: resident.emergency_contact ?? "",
      permanent_address: resident.permanent_address ?? "",
      city: resident.city ?? "",
      nationality: resident.nationality ?? "",
      occupation: resident.occupation ?? "",
      company_university: resident.company_university ?? "",
      photo_url: resident.photo_url ?? "",
      id_card_url: resident.id_card_url ?? "",
      status: resident.status,
    });
    setPhotoFileName("");
    setIdCardFileName("");
    setGuardianFrontFile(null);
    setGuardianFrontFileName("");
    setMessage("");
    setError("");
    setShowForm(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function closeForm() {
    setEditingId(null);
    setForm(emptyForm);
    setGuardianFrontFile(null);
    setGuardianFrontFileName("");
    setShowForm(false);
  }

  async function uploadGuardianFrontDocument(residentId: string, file: File) {
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw new Error("Please sign in again before uploading the Guardian Front document.");
    const body = new FormData();
    body.set("slot", "guardian_front");
    body.set("file", file);
    const response = await fetch(`/api/resident-portal/profile/documents?residentId=${encodeURIComponent(residentId)}`, {
      method: "POST",
      cache: "no-store",
      headers: { Authorization: `Bearer ${data.session.access_token}` },
      body,
    });
    const result = await response.json().catch(() => null) as { error?: string } | null;
    if (!response.ok) throw new Error(result?.error || "The Guardian Front document could not be uploaded.");
  }

  async function handleGuardianFrontSelection(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const invalid = profileDocumentError("guardian_front", file.type, file.size);
    if (invalid) {
      setGuardianFrontFile(null);
      setGuardianFrontFileName("");
      setError(invalid);
      return;
    }
    try {
      const prepared = await compressProfileImage(file, "guardian_front");
      const outputError = profileDocumentError("guardian_front", prepared.type, prepared.size);
      if (outputError) throw new Error(outputError);
      setGuardianFrontFile(prepared);
      setGuardianFrontFileName(file.name);
      setError("");
    } catch (selectionError) {
      setGuardianFrontFile(null);
      setGuardianFrontFileName("");
      setError(selectionError instanceof Error ? selectionError.message : "Unable to prepare the Guardian Front document.");
    }
  }

  async function saveResident(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (documentsUploading) { setError("Wait for the document upload to finish before saving."); return; }
    if (contactsLoading) {
      setError("Emergency contacts are still loading. Reopen Edit if loading failed.");
      return;
    }
    if (extraContacts.some(contact => !contact.contact_name.trim() || !contact.relationship.trim() || !contact.phone.trim())) {
      setError("Complete each emergency contact name, relationship and phone.");
      return;
    }
    setSaving(true);
    setMessage("");
    setError("");

    if (!form.full_name.trim()) {
      setError("Resident name is required.");
      setSaving(false);
      return;
    }

    if (!form.phone.trim()) {
      setError("Phone number is required.");
      setSaving(false);
      return;
    }

    if (!form.email.trim()) {
      setError("Email is required.");
      setSaving(false);
      return;
    }

    if (!form.cnic.trim()) {
      setError("CNIC / passport is required.");
      setSaving(false);
      return;
    }

    const normalizedEmail = normalizeEmail(form.email);
    const normalizedPhone = normalizePhone(form.phone);
    const normalizedCnic = normalizeIdentity(form.cnic);

    const { data: duplicateRows, error: duplicateError } = await supabase
      .from("residents")
      .select("id, email, phone, cnic")
      .order("created_at", { ascending: false });

    if (duplicateError) {
      setError(
        getSupabaseErrorMessage(
          duplicateError,
          "Unable to verify resident details. Please try again.",
        ),
      );
      setSaving(false);
      return;
    }

    const duplicate = (duplicateRows ?? []).find((row: GenericRow) => {
      const sameId = text(row.id) === editingId;
      const sameEmail = normalizedEmail && normalizeEmail(row.email) === normalizedEmail;
      const samePhone = normalizedPhone && normalizePhone(row.phone) === normalizedPhone;
      const sameCnic = normalizedCnic && normalizeIdentity(row.cnic) === normalizedCnic;
      return !sameId && (sameEmail || samePhone || sameCnic);
    });

    if (duplicate) {
      setError("A resident with the same email, phone, or CNIC already exists.");
      setSaving(false);
      return;
    }

    const now = new Date().toISOString();
    const payload = {
      resident_code: form.resident_code.trim() || generateResidentCode(residents),
      full_name: form.full_name.trim(),
      resident_identity_type: form.resident_identity_type || null,
      guardian_identity_type: form.guardian_identity_type || null,
      guardian_cnic: form.guardian_cnic.trim() || null,
      guardian_phone: form.guardian_phone.trim() || null,
      father_name: form.father_name.trim() || null,
      phone: form.phone.trim() || null,
      email: normalizedEmail || null,
      cnic: form.cnic.trim() || null,
      dob: form.dob || null,
      gender: form.gender || null,
      emergency_contact_name: form.emergency_contact_name.trim() || null,
      emergency_contact_relationship: form.emergency_contact_relationship || null,
      emergency_contact: form.emergency_contact.trim() || null,
      permanent_address: form.permanent_address.trim() || null,
      city: form.city.trim() || null,
      nationality: form.nationality.trim() || null,
      occupation: form.occupation.trim() || null,
      company_university: form.company_university.trim() || null,
      photo_url: form.photo_url.trim() || null,
      id_card_url: form.id_card_url.trim() || null,
      status: editingId ? form.status : RESIDENT_STATUS.INACTIVE,
      updated_at: now,
      ...(editingId ? {} : { created_at: now }),
    };


    let result;
    try {
      result = editingId
        ? await supabase.from("residents").update(payload).eq("id", editingId)
        : await supabase
            .from("residents")
            .insert(payload)
            .select("id, full_name, email")
            .single();

    } catch {
      setError("Unable to save resident. Please try again.");
      setSaving(false);
      return;
    }

    if (result.error) {
      setError(
        getSupabaseErrorMessage(
          result.error,
          "Unable to save resident. Please try again.",
          "A resident with the same email, phone, or CNIC already exists.",
        ),
      );
      setSaving(false);
      return;
    }

    let successMessage = editingId
      ? "Resident updated successfully."
      : "Resident added successfully.";

    if (!editingId && result.data?.id) {
      try {
        const login = await ensureResidentLogin(String(result.data.id));
        successMessage = login.created
          ? `Resident added successfully. Portal login: ${login.email} | One-time temporary password: ${login.temporaryPassword} (${login.emailSent ? "Credentials sent via email" : "Provide to resident now; not stored in database"}).`
          : `Resident added successfully. A portal login already exists for ${login.email}.`;
      } catch (loginError) {
        successMessage = `Resident added successfully, but the portal login could not be created automatically. ${
          loginError instanceof Error ? loginError.message : "Please create the login later."
        }`;
      }
    }

    const savedResidentId = editingId || result.data?.id;
    if (savedResidentId && extraContacts.length) {
      const contactResult = await supabase.rpc("save_resident_emergency_contacts", { p_resident_id: savedResidentId, p_contacts: extraContacts });
      if (contactResult.error) {
        if (!editingId) retryContactsFor.current = String(savedResidentId);
        setEditingId(String(savedResidentId));
        setMessage(successMessage);
        await refresh();
        setError("Resident saved, but additional contacts were not saved. Retry Save Resident; do not create another resident. " + contactResult.error.message);
        setSaving(false);
        return;
      }
    }
    if (savedResidentId && guardianFrontFile) {
      try {
        await uploadGuardianFrontDocument(String(savedResidentId), guardianFrontFile);
        setGuardianFrontFile(null);
        setGuardianFrontFileName("");
      } catch (uploadError) {
        if (!editingId) setEditingId(String(savedResidentId));
        await refresh();
        setMessage(successMessage);
        setError(`Resident was saved, but the Guardian ${form.guardian_identity_type === "Passport" ? "Passport Identity Page" : "CNIC Front"} was NOT uploaded. The selected file is still pending; click Update Resident to retry. ${uploadError instanceof Error ? uploadError.message : "Upload failed."}`);
        setSaving(false);
        return;
      }
    }
    setMessage(successMessage);
    closeForm();
    await refresh();
    setSaving(false);
  }

  async function handleResetPortalPassword(resident: Resident) {
    if (resident.status === "Archived") {
      setError("Archived residents cannot receive a new portal password.");
      return;
    }

    if (!resident.email?.trim()) {
      setError("This resident does not have an email address.");
      return;
    }

    const confirmed = window.confirm(
      `Generate a new temporary portal password for ${resident.full_name}? The resident's previous password will stop working.`,
    );
    if (!confirmed) return;

    setResettingPasswordId(resident.id);
    setMessage("");
    setError("");

    try {
      const result = await resetResidentPassword(resident.id);
      setMessage(
        `Portal password reset successfully. Email: ${result.email} | One-time temporary password: ${result.temporaryPassword} (${result.emailSent ? "Credentials sent via email" : "Provide to resident now; not stored in database"}).`,
      );
    } catch (resetError) {
      setError(
        resetError instanceof Error
          ? resetError.message
          : "Unable to reset the resident portal password.",
      );
    } finally {
      setResettingPasswordId(null);
    }
  }

  async function archiveResident(resident: Resident) {
    if (resident.status === "Archived") return;

    const confirmed = window.confirm(`Archive resident ${resident.full_name}?`);
    if (!confirmed) return;

    setArchivingId(resident.id);
    setMessage("");
    setError("");

    const { data: currentAdmission, error: admissionError } = await supabase
      .from("admissions")
      .select("id")
      .eq("resident_id", resident.id)
      .in("status", ["Pending", "Active"])
      .limit(1)
      .maybeSingle();

    if (admissionError || currentAdmission) {
      setError(
        admissionError
          ? getSupabaseErrorMessage(
              admissionError,
              "Unable to verify this resident's current admission.",
            )
          : "Complete, cancel, or archive the resident's current admission before archiving the resident.",
      );
      setArchivingId(null);
      return;
    }

    const { error: archiveError } = await supabase
      .from("residents")
      .update({ status: "Archived", updated_at: new Date().toISOString() })
      .eq("id", resident.id);

    if (archiveError) {
      setError(
        getSupabaseErrorMessage(
          archiveError,
          "Unable to archive this resident. Please try again.",
        ),
      );
    } else {
      setMessage("Resident archived successfully.");
      await refresh();
    }

    setArchivingId(null);
  }

  function openProfile(resident: Resident) {
    setSelectedResidentId(resident.id);
    setShowProfile(true);
    setProfileTab("Personal Information");
  }

  async function handlePhotoUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    const invalid = profileDocumentError("photo", file.type, file.size);
    if (invalid || file.type === "application/pdf") { setError(invalid || "Use an image for this legacy upload field."); return; }
    try {
      const prepared = await compressProfileImage(file, "photo");
      const outputError = profileDocumentError("photo", prepared.type, prepared.size);
      if (outputError) throw new Error(outputError);
      const dataUrl = await readFileAsDataUrl(prepared);
      setPhotoFileName(file.name);
      updateField("photo_url", dataUrl);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to compress the uploaded image.");
    }
  }

  async function handleIdCardUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    const invalid = profileDocumentError("resident_front", file.type, file.size);
    if (invalid || file.type === "application/pdf") { setError(invalid || "Use an image for this legacy upload field."); return; }
    try {
      const prepared = await compressProfileImage(file, "resident_front");
      const outputError = profileDocumentError("resident_front", prepared.type, prepared.size);
      if (outputError) throw new Error(outputError);
      const dataUrl = await readFileAsDataUrl(prepared);
      setIdCardFileName(file.name);
      updateField("id_card_url", dataUrl);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to compress the uploaded ID card.");
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">Hostel Management System</p>
            <h1 className="mt-2 text-3xl font-bold text-slate-900">Residents</h1>
            <p className="mt-1 text-sm text-slate-500">Manage residents, search records, review profiles, and archive inactive residents safely.</p>
          </div>

          <button type="button" onClick={openAddForm} className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-700">
            + Add Resident
          </button>
        </section>

        {(message || error) && (
          <section className={`rounded-2xl border px-4 py-3 text-sm font-medium ${error ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>
            {error || message}
          </section>
        )}

        {showForm && (
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-6 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-xl font-bold text-slate-900">{editingId ? "Edit Resident" : "Add Resident"}</h2>
                <p className="mt-1 text-sm text-slate-500">Capture complete resident details with validation and soft-archive support.</p>
              </div>
              <button type="button" onClick={closeForm} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600">Close</button>
            </div>

            <form onSubmit={saveResident} className="space-y-6">
              {editingId && <StaffProfileContacts key={editingId} residentId={editingId} statusOnly />}
              <section className="space-y-4">
                <h3 className="text-lg font-semibold text-slate-900">Personal Information</h3>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <Field label="Resident Code">
                  <input value={form.resident_code} onChange={(event) => updateField("resident_code", event.target.value)} className={inputClass} placeholder="Auto-generated code" />
                </Field>
                <Field label="Full Name *">
                  <input required value={form.full_name} onChange={(event) => updateField("full_name", event.target.value)} className={inputClass} placeholder="Resident full name" />
                </Field>
                <Field label="Father / Guardian Name">
                  <input value={form.father_name} onChange={(event) => updateField("father_name", event.target.value)} className={inputClass} placeholder="Guardian name" />
                </Field>
                <Field label="Gender">
                  <select value={form.gender} onChange={(event) => updateField("gender", event.target.value)} className={inputClass}>
                    <option value="">Select gender</option>
                    <option value="Male">Male</option>
                    <option value="Female">Female</option>
                    <option value="Other">Other</option>
                  </select>
                </Field>
                <Field label="CNIC / Passport *">
                  <input required value={form.cnic} onChange={(event) => updateField("cnic", event.target.value)} className={inputClass} placeholder="Identification number" />
                </Field>
                <Field label="Date of Birth">
                  <input type="date" value={form.dob} onChange={(event) => updateField("dob", event.target.value)} className={inputClass} />
                </Field>
                <Field label="Phone *">
                  <input required value={form.phone} onChange={(event) => updateField("phone", event.target.value)} className={inputClass} placeholder="Phone number" />
                </Field>
                <Field label="Email *">
                  <input required type="email" value={form.email} onChange={(event) => updateField("email", event.target.value)} className={inputClass} placeholder="resident@example.com" />
                </Field>
                </div>
              </section>
              <section className="space-y-4">
                <h3 className="text-lg font-semibold text-slate-900">Guardian Information</h3>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <Field label="Guardian CNIC / Passport"><input value={form.guardian_cnic} onChange={event => updateField("guardian_cnic", event.target.value)} className={inputClass} /></Field>
                <Field label="Guardian Phone"><input value={form.guardian_phone} onChange={event => updateField("guardian_phone", event.target.value)} className={inputClass} /></Field>
                </div>
              </section>
              <section className="space-y-4">
                <h3 className="text-lg font-semibold text-slate-900">Emergency Contacts</h3>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <Field label="Emergency Contact Name">
                  <input value={form.emergency_contact_name} onChange={(event) => updateField("emergency_contact_name", event.target.value)} className={inputClass} placeholder="Emergency contact name" />
                </Field>
                <Field label="Relationship">
                  <select value={form.emergency_contact_relationship} onChange={(event) => updateField("emergency_contact_relationship", event.target.value)} className={inputClass}>
                    <option value="">Select relationship</option>
                    {form.emergency_contact_relationship && !emergencyRelationships.includes(form.emergency_contact_relationship) && (
                      <option value={form.emergency_contact_relationship}>{form.emergency_contact_relationship}</option>
                    )}
                    {emergencyRelationships.map((relationship) => <option key={relationship} value={relationship}>{relationship}</option>)}
                  </select>
                </Field>
                <Field label="Emergency Contact / Phone">
                  <input value={form.emergency_contact} onChange={(event) => updateField("emergency_contact", event.target.value)} className={inputClass} placeholder="Emergency phone" />
                </Field>
                </div>
                <fieldset disabled={saving || contactsLoading}><EmergencyContacts contacts={extraContacts} onChange={setExtraContacts} /></fieldset>
              </section>
              <section className="space-y-4">
                <h3 className="text-lg font-semibold text-slate-900">Address & Other Details</h3>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <Field label="Permanent Address" wide>
                  <textarea value={form.permanent_address} onChange={(event) => updateField("permanent_address", event.target.value)} className={`${inputClass} min-h-24`} placeholder="Resident address" />
                </Field>
                <Field label="City">
                  <input value={form.city} onChange={(event) => updateField("city", event.target.value)} className={inputClass} placeholder="City" />
                </Field>
                <Field label="Nationality">
                  <input value={form.nationality} onChange={(event) => updateField("nationality", event.target.value)} className={inputClass} placeholder="Nationality" />
                </Field>
                <Field label="Occupation">
                  <input value={form.occupation} onChange={(event) => updateField("occupation", event.target.value)} className={inputClass} placeholder="Occupation" />
                </Field>
                <Field label="Company / University">
                  <input value={form.company_university} onChange={(event) => updateField("company_university", event.target.value)} className={inputClass} placeholder="Company or university" />
                </Field>
                </div>
              </section>
              <section className="space-y-4">
                <h3 className="text-lg font-semibold text-slate-900">Documents / Photo</h3>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label="Resident Identity Document Type"><select value={form.resident_identity_type} onChange={e => updateField("resident_identity_type", e.target.value)} className={inputClass}><option value="">Not specified (CNIC requirements)</option><option>CNIC</option><option>Passport</option></select></Field>
                  <Field label="Guardian Identity Document Type"><select value={form.guardian_identity_type} onChange={e => updateField("guardian_identity_type", e.target.value)} className={inputClass}><option value="">Not specified (CNIC requirements)</option><option>CNIC</option><option>Passport</option></select></Field>
                </div>
                <div className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
                  <p>Resident: {form.resident_identity_type === "Passport" ? "Passport identity page required; no back required." : "CNIC front and back required."}</p>
                  <p>Guardian: {form.guardian_identity_type === "Passport" ? "Passport identity page required; no back required." : "CNIC front and back required."}</p>
                  <p>Upload backs and guardian documents after saving the resident.</p>
                </div>
                {editingId ? <ProfileDocuments key={editingId} onBusyChange={setDocumentsUploading} residentId={editingId} residentType={form.resident_identity_type || "CNIC"} guardianType={form.guardian_identity_type || "CNIC"} slots={["resident_front", "resident_back", "guardian_front", "guardian_back"]} /> : <p className="text-sm text-slate-500">After saving the resident, use Edit to upload additional private identity documents.</p>}
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <Field label="Resident Photo">
                  <div className="space-y-2">
                    <input type="file" accept="image/jpeg,image/png,image/webp" onChange={handlePhotoUpload} className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-full file:border-0 file:bg-indigo-50 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-indigo-700 hover:file:bg-indigo-100" />
                    {photoFileName ? <p className="text-xs text-slate-500">Selected: {photoFileName}</p> : null}
                  </div>
                </Field>
                {!editingId && <Field label={form.resident_identity_type === "Passport" ? "Resident Passport Identity Page" : "Resident CNIC Front"}>
                  <div className="space-y-2">
                    <input type="file" accept="image/jpeg,image/png,image/webp" onChange={handleIdCardUpload} className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-full file:border-0 file:bg-indigo-50 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-indigo-700 hover:file:bg-indigo-100" />
                    {idCardFileName ? <p className="text-xs text-slate-500">Selected: {idCardFileName}</p> : null}
                  </div>
                </Field>}
                {!editingId && <Field label={form.guardian_identity_type === "Passport" ? "Guardian Passport Identity Page" : "Guardian CNIC Front"}>
                  <div className="space-y-2">
                    <input type="file" accept="image/jpeg,image/png,image/webp" onChange={handleGuardianFrontSelection} className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-full file:border-0 file:bg-indigo-50 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-indigo-700 hover:file:bg-indigo-100" />
                    {guardianFrontFileName ? <p className="text-xs text-slate-500">Selected: {guardianFrontFileName}</p> : null}
                  </div>
                </Field>}
                </div>
              </section>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <Field label="Status">
                  <select value={form.status} onChange={(event) => updateField("status", event.target.value as ResidentStatus)} className={inputClass}>
                    <option value="Active" disabled>Active (managed by Admissions)</option>
                    <option value="Inactive">Inactive</option>
                    <option value="Reserved">Reserved</option>
                    <option value="Notice Period">Notice Period</option>
                    <option value="Checked Out">Checked Out</option>
                    <option value="Archived">Archived</option>
                  </select>
                </Field>
              </div>

              <div className="flex flex-col-reverse gap-3 border-t border-slate-200 pt-6 sm:flex-row sm:justify-end">
                <button type="button" onClick={closeForm} className="rounded-xl border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700">Cancel</button>
                <button type="submit" disabled={saving || documentsUploading} className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white disabled:opacity-60">
                  {saving ? "Saving..." : editingId ? "Update Resident" : "Save Resident"}
                </button>
              </div>
            </form>
          </section>
        )}

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
          <StatCard label="Total Residents" value={String(summary.total)} />
          <StatCard label="Active" value={String(summary.active)} />
          <StatCard label="Inactive" value={String(summary.inactive)} />
          <StatCard label="Reserved" value={String(summary.reserved)} />
          <StatCard label="Notice Period" value={String(summary.notice)} />
          <StatCard label="Archived" value={String(summary.archived)} />
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
          <div className="grid gap-3 border-b border-slate-200 p-5 lg:grid-cols-[1.2fr_220px_220px_auto]">
            <input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} className={inputClass} placeholder="Search name, phone, email, CNIC or resident code" />

            <select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }} className={inputClass}>
              <option value="All">All Statuses</option>
              <option value="Active">Active</option>
              <option value="Inactive">Inactive</option>
              <option value="Reserved">Reserved</option>
              <option value="Notice Period">Notice Period</option>
              <option value="Checked Out">Checked Out</option>
              <option value="Archived">Archived</option>
            </select>

            <select value={`${sortKey}-${sortDir}`} onChange={(event) => { const [key, dir] = event.target.value.split("-"); setSortKey(key as "full_name" | "created_at" | "updated_at" | "status"); setSortDir(dir as "asc" | "desc"); setPage(1); }} className={inputClass}>
              <option value="created_at-desc">Newest first</option>
              <option value="full_name-asc">Name A-Z</option>
              <option value="full_name-desc">Name Z-A</option>
              <option value="status-asc">Status A-Z</option>
              <option value="updated_at-desc">Recently updated</option>
            </select>

            <button type="button" onClick={() => void refresh()} className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700">Refresh</button>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  {['Resident', 'Contact', 'CNIC / Code', 'Status', 'Actions'].map((heading) => (
                    <th key={heading} className="px-5 py-3 text-left text-xs font-bold uppercase tracking-wider text-slate-500">{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 bg-white">
                {loading ? (
                  <tr><td colSpan={5} className="px-5 py-12 text-center text-sm text-slate-500">Loading residents...</td></tr>
                ) : pagedResidents.length === 0 ? (
                  <tr><td colSpan={5} className="px-5 py-12 text-center text-sm text-slate-500">No residents found.</td></tr>
                ) : (
                  pagedResidents.map((resident) => (
                    <tr key={resident.id} className="hover:bg-slate-50/70">
                      <td className="px-5 py-4">
                        <p className="font-semibold text-slate-900">{resident.full_name}</p>
                        <p className="mt-1 text-xs text-slate-500">{resident.father_name || "No guardian recorded"}</p>
                      </td>
                      <td className="px-5 py-4 text-sm text-slate-700">
                        <p>{resident.phone || "No phone"}</p>
                        <p className="mt-1 text-xs text-slate-500">{resident.email || "No email"}</p>
                      </td>
                      <td className="px-5 py-4 text-sm text-slate-700">
                        <p>{resident.cnic || "—"}</p>
                        <p className="mt-1 text-xs text-slate-500">{resident.resident_code || "—"}</p>
                      </td>
                      <td className="px-5 py-4"><span className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${statusClass(resident.status)}`}>{resident.status}</span></td>
                      <td className="px-5 py-4">
                        <div className="flex flex-wrap gap-2">
                          <button type="button" onClick={() => openProfile(resident)} className="rounded-lg border border-indigo-200 px-3 py-2 text-xs font-semibold text-indigo-700">Profile</button>
                          {resident.status !== "Archived" && (
                            <>
                              <button type="button" onClick={() => openEditForm(resident)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700">Edit</button>
                              <button
                                type="button"
                                disabled={resettingPasswordId === resident.id}
                                onClick={() => void handleResetPortalPassword(resident)}
                                className="rounded-lg border border-emerald-200 px-3 py-2 text-xs font-semibold text-emerald-700 disabled:opacity-50"
                              >
                                {resettingPasswordId === resident.id
                                  ? "Resetting..."
                                  : "Reset Portal Password"}
                              </button>
                              <button type="button" disabled={archivingId === resident.id} onClick={() => void archiveResident(resident)} className="rounded-lg border border-amber-200 px-3 py-2 text-xs font-semibold text-amber-700 disabled:opacity-50">{archivingId === resident.id ? "Archiving..." : "Archive"}</button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-5 py-4">
            <p className="text-sm text-slate-500">Showing {pagedResidents.length} of {sortedResidents.length} residents</p>
            <div className="flex items-center gap-2">
              <button type="button" disabled={page === 1} onClick={() => setPage((current) => Math.max(1, current - 1))} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50">Previous</button>
              <span className="text-sm font-semibold text-slate-700">Page {page} of {pageCount}</span>
              <button type="button" disabled={page >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50">Next</button>
            </div>
          </div>
        </section>

        {showProfile && (
          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
              <div>
                <h2 className="text-xl font-bold text-slate-900">Resident Profile</h2>
                <p className="mt-1 text-sm text-slate-500">Review resident information, admissions, billing, service history and activity.</p>
              </div>
              <button type="button" onClick={() => setShowProfile(false)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600">Close</button>
            </div>

            <div className="mb-6 flex flex-wrap gap-2">
              {(["Personal Information", "Room & Bed", "Admission", "Contract", "Billing", "Payments", "Deposit", "Notices", "Maintenance", "Inspections", "Documents", "Activity Timeline"] as ProfileTab[]).map((tab) => (
                <button key={tab} type="button" onClick={() => setProfileTab(tab)} className={`rounded-full px-3 py-2 text-sm font-semibold ${profileTab === tab ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-700"}`}>
                  {tab}
                </button>
              ))}
            </div>

            {profileLoading ? (
              <p className="text-sm text-slate-500">Loading profile details...</p>
            ) : !profile.resident ? (
              <p className="text-sm text-slate-500">No resident profile available.</p>
            ) : (
              <div className="space-y-6">
                {profileTab === "Personal Information" && (
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    <InfoCard label="Resident Code" value={text(profile.resident.resident_code || "—")} />
                    <InfoCard label="Full Name" value={text(profile.resident.full_name)} />
                    <InfoCard label="Father / Guardian" value={text(profile.resident.father_name || "—")} />
                    <InfoCard label="Guardian CNIC / Passport" value={text(profile.resident.guardian_cnic || "Not recorded")} />
                    <InfoCard label="Guardian Phone" value={text(profile.resident.guardian_phone || "Not recorded")} />
                    <StaffProfileContacts key={profile.resident.id} residentId={profile.resident.id} />
                    <InfoCard label="Phone" value={text(profile.resident.phone || "—")} />
                    <InfoCard label="Email" value={text(profile.resident.email || "—")} />
                    <InfoCard label="Emergency Contact Name" value={text(profile.resident.emergency_contact_name || "Not recorded")} />
                    <InfoCard label="Relationship" value={text(profile.resident.emergency_contact_relationship || "Not recorded")} />
                    <InfoCard label="Emergency Contact / Phone" value={text(profile.resident.emergency_contact || "Not recorded")} />
                    <InfoCard label="Portal Access" value={profile.resident.email ? "Configured (Supabase Auth)" : "No email"} />
                    <InfoCard label="CNIC / Passport" value={text(profile.resident.cnic || "—")} />
                    <InfoCard label="Date of Birth" value={text(profile.resident.dob || "—")} />
                    <InfoCard label="Gender" value={text(profile.resident.gender || "—")} />
                    <InfoCard label="Address" value={text(profile.resident.permanent_address || "—")} />
                    <InfoCard label="City" value={text(profile.resident.city || "—")} />
                    <InfoCard label="Nationality" value={text(profile.resident.nationality || "—")} />
                    <InfoCard label="Occupation" value={text(profile.resident.occupation || "—")} />
                    <InfoCard label="Company / University" value={text(profile.resident.company_university || "—")} />
                    <InfoCard label="Status" value={text(profile.resident.status)} />
                  </div>
                )}

                {profileTab === "Room & Bed" && (
                  <div className="grid gap-4 md:grid-cols-2">
                    <InfoCard label="Room" value={firstText(profile.room, ["room_number"]) || "—"} />
                    <InfoCard label="Bed" value={firstText(profile.bed, ["bed_number"]) || "—"} />
                    <InfoCard label="Room Type" value={firstText(profile.room, ["room_type", "type"]) || "—"} />
                    <InfoCard label="Admission Status" value={firstText(profile.admission, ["status"]) || "Active"} />
                  </div>
                )}

                {profileTab === "Admission" && (
                  <div className="grid gap-4 md:grid-cols-2">
                    <InfoCard label="Admission Date" value={text(firstText(profile.admission, ["admission_date"]).slice(0, 10) || "—")} />
                    <InfoCard label="Expected Leaving" value={text(firstText(profile.admission, ["expected_leaving_date"]).slice(0, 10) || "—")} />
                    <InfoCard label="Monthly Rent" value={money(profile.admission?.monthly_rent ?? profile.room?.monthly_rent ?? 0)} />
                    <InfoCard label="Deposit" value={money(profile.admission?.security_deposit ?? 0)} />
                  </div>
                )}

                {profileTab === "Contract" && (
                  <div className="grid gap-4 md:grid-cols-2">
                    <InfoCard label="Contract Number" value={text(firstText(profile.contract, ["contract_number"]) || "—")} />
                    <InfoCard label="Start Date" value={text(firstText(profile.contract, ["start_date"]).slice(0, 10) || "—")} />
                    <InfoCard label="End Date" value={text(firstText(profile.contract, ["end_date"]).slice(0, 10) || "—")} />
                    <InfoCard label="Status" value={text(firstText(profile.contract, ["status"]) || "—")} />
                  </div>
                )}

                {profileTab === "Billing" && (
                    <DataTable headers={["Bill No.", "Month", "Total", "Paid", "Balance", "Status"]} rows={profile.bills.map((bill) => [text(firstText(bill, ["bill_number"]) || "—"), text(firstText(bill, ["billing_month"]).slice(0, 7) || "—"), money(bill.total_amount), money(bill.paid_amount), money(bill.balance_amount), text(firstText(bill, ["bill_status"]) || "Pending")])} />
                )}

                {profileTab === "Payments" && (
                  <DataTable headers={["Payment No.", "Date", "Method", "Reference", "Amount", "Status"]} rows={profile.payments.map((payment) => [text(firstText(payment, ["payment_number"]) || "—"), text(firstText(payment, ["payment_date", "created_at"]).slice(0, 10) || "—"), text(firstText(payment, ["payment_method"]) || "—"), text(firstText(payment, ["reference_number"]) || "—"), money(payment.amount), text(firstText(payment, ["payment_status"]) || "Pending")])} />
                )}

                {profileTab === "Deposit" && (
                  <div className="grid gap-4 md:grid-cols-2">
                    <InfoCard label="Security Deposit" value={money(profile.admission?.security_deposit ?? 0)} />
                    <InfoCard label="Deposit Status" value={text(firstText(profile.admission, ["deposit_status"]) || "Not recorded")} />
                  </div>
                )}

                {profileTab === "Notices" && (
                  <div className="space-y-3">{profile.notices.length === 0 ? <EmptyState text="No notices are available for this resident." /> : profile.notices.map((notice) => <article key={text(notice.id)} className="rounded-2xl border border-slate-200 p-4"><h3 className="font-semibold text-slate-900">{firstText(notice, ["title"]) || "Notice"}</h3><p className="mt-2 text-sm text-slate-600">{firstText(notice, ["description"])}</p></article>)}</div>
                )}

                {profileTab === "Maintenance" && (
                  <DataTable headers={["Request No.", "Date", "Category", "Priority", "Status"]} rows={profile.maintenance.map((request) => [text(firstText(request, ["request_number"]) || "—"), text(firstText(request, ["complaint_date", "created_at"]).slice(0, 10) || "—"), text(firstText(request, ["category"]) || "Other"), text(firstText(request, ["priority"]) || "Medium"), text(firstText(request, ["status"]) || "Pending")])} />
                )}

                {profileTab === "Inspections" && (
                  <DataTable headers={["Inspection No.", "Date", "Type", "Condition", "Status"]} rows={profile.inspections.map((inspection) => [text(firstText(inspection, ["inspection_number"]) || "—"), text(firstText(inspection, ["inspection_date"]).slice(0, 10) || "—"), text(firstText(inspection, ["inspection_type"]) || "Routine"), text(firstText(inspection, ["overall_status"]) || "—"), text(firstText(inspection, ["status"]) || "Pending")])} />
                )}

                {profileTab === "Documents" && (
                  <div className="grid gap-4 md:grid-cols-2">
                    <ProfileDocuments residentId={profile.resident.id} residentType={profile.resident.resident_identity_type || "CNIC"} guardianType={profile.resident.guardian_identity_type || "CNIC"} readOnly />
                  </div>
                )}

                {profileTab === "Activity Timeline" && (
                  <div className="space-y-3">
                    {profile.timeline.map((item, index) => (
                      <div key={`${item.title}-${index}`} className="rounded-2xl border border-slate-200 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h3 className="font-semibold text-slate-900">{item.title}</h3>
                          <span className="text-xs text-slate-500">{item.date.slice(0, 10)}</span>
                        </div>
                        <p className="mt-2 text-sm text-slate-600">{item.detail}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

function Field({ label, wide = false, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return <label className={wide ? "md:col-span-2 xl:col-span-3" : ""}><span className="mb-2 block text-sm font-semibold text-slate-700">{label}</span>{children}</label>;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-sm font-medium text-slate-500">{label}</p><p className="mt-2 text-2xl font-bold text-slate-900">{value}</p></article>;
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return <article className="rounded-2xl border border-slate-200 bg-slate-50 p-4"><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p><p className="mt-2 font-semibold text-slate-900">{value}</p></article>;
}

function DataTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return <div className="overflow-x-auto rounded-2xl border border-slate-200"><table className="min-w-full divide-y divide-slate-200"><thead className="bg-slate-50"><tr>{headers.map((heading) => <th key={heading} className="px-4 py-3 text-left text-xs font-bold uppercase tracking-wide text-slate-500">{heading}</th>)}</tr></thead><tbody className="divide-y divide-slate-100 bg-white">{rows.length === 0 ? <tr><td colSpan={headers.length} className="px-4 py-10 text-center text-sm text-slate-500">No records found.</td></tr> : rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((column, columnIndex) => <td key={`${rowIndex}-${columnIndex}`} className="whitespace-nowrap px-4 py-3 text-sm text-slate-700">{column}</td>)}</tr>)}</tbody></table></div>;
}

function EmptyState({ text: label }: { text: string }) {
  return <div className="rounded-2xl border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">{label}</div>;
}
