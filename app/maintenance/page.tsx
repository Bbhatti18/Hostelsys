"use client";

import {
  ChangeEvent,
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { supabase } from "@/lib/supabase";
import Link from "next/link";
import { getSupabaseErrorMessage } from "@/lib/supabaseErrors";
import { optimizeImageForUpload, safeStorageFileName, validateImageFile } from "@/lib/imageValidation";
import { MAINTENANCE_PHOTO_BUCKET, maintenancePhotoUrl } from "@/lib/maintenanceStorage";
import PrivateStorageLinks from "@/components/storage/PrivateStorageLinks";
import { notifyMaintenanceCompleted } from "@/lib/maintenanceNotificationClient";

type GenericRow = Record<string, unknown>;

type Priority = "Low" | "Medium" | "High" | "Emergency";
type RequestStatus = "Open" | "Pending" | "In Progress" | "Completed" | "Cancelled" | "Archived";

type MaintenanceRequest = {
  id: string;
  request_number: string;
  resident_id: string | null;
  admission_id: string | null;
  room_id: string | null;
  bed_id: string | null;
  title: string | null;
  category: string | null;
  description: string | null;
  priority: Priority;
  status: RequestStatus;
  assigned_to: string | null;
  estimated_cost: number;
  actual_cost: number;
  photo_url: string | null;
  complaint_date: string | null;
  completion_date: string | null;
  completed_at: string | null;
  assigned_date: string | null;
  before_photos: unknown;
  during_photos: unknown;
  after_photos: unknown;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type MaintenanceForm = {
  resident_id: string;
  admission_id: string;
  room_id: string;
  bed_id: string;
  title: string;
  category: string;
  description: string;
  priority: Priority;
  status: RequestStatus;
  assigned_to: string;
  estimated_cost: string;
  actual_cost: string;
  reported_date: string;
  completion_date: string;
  notes: string;
};

type CurrentMaintenanceRequest = {
  status: RequestStatus;
  resident_id: string | null;
  admission_id: string | null;
  room_id: string | null;
  bed_id: string | null;
  assigned_date: string | null;
  completion_date: string | null;
  completed_at: string | null;
};

const emptyForm: MaintenanceForm = {
  resident_id: "",
  admission_id: "",
  room_id: "",
  bed_id: "",
  title: "",
  category: "Other",
  description: "",
  priority: "Medium",
  status: "Open",
  assigned_to: "",
  estimated_cost: "0",
  actual_cost: "0",
  reported_date: new Date().toISOString().slice(0, 10),
  completion_date: "",
  notes: "",
};

const inputClass =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 disabled:cursor-not-allowed disabled:bg-slate-100";

function text(value: unknown) {
  return value == null ? "" : String(value);
}

function photoList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function photoUrls(value: unknown) {
  return photoList(value).map(maintenancePhotoUrl);
}

const MAX_FILES_PER_CATEGORY = 12;

function firstText(row: GenericRow | undefined, keys: string[]) {
  if (!row) return "";

  for (const key of keys) {
    const value = row[key];

    if (
      value !== null &&
      value !== undefined &&
      String(value).trim() !== ""
    ) {
      return String(value);
    }
  }

  return "";
}

function residentName(row: GenericRow | undefined) {
  return String(row?.full_name || "Resident");
}

function roomNumber(row: GenericRow | undefined) {
  return (
    firstText(row, ["room_number","room_no"]) ||
    "No room"
  );
}

function money(value: unknown) {
  return new Intl.NumberFormat("en-PK", {
    style: "currency",
    currency: "PKR",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function priorityClass(priority: Priority) {
  if (priority === "Emergency") return "bg-red-100 text-red-700";
  if (priority === "High") return "bg-orange-100 text-orange-700";
  if (priority === "Medium") return "bg-amber-100 text-amber-700";
  return "bg-slate-200 text-slate-700";
}

function statusClass(status: RequestStatus) {
  if (status === "Completed") return "bg-emerald-100 text-emerald-700";
  if (status === "In Progress") return "bg-blue-100 text-blue-700";
  if (status === "Cancelled") return "bg-slate-200 text-slate-700";
  if (status === "Archived") return "bg-slate-300 text-slate-700";
  return "bg-amber-100 text-amber-700";
}

function requestNumber() {
  return `MNT-${new Date().getFullYear()}-${Date.now()
    .toString()
    .slice(-7)}`;
}

export default function MaintenancePage() {
  const [requests, setRequests] = useState<MaintenanceRequest[]>([]);
  const [residents, setResidents] = useState<GenericRow[]>([]);
  const [rooms, setRooms] = useState<GenericRow[]>([]);
  const [beds, setBeds] = useState<GenericRow[]>([]);
  const [admissions, setAdmissions] = useState<GenericRow[]>([]);
  const [form, setForm] = useState<MaintenanceForm>(emptyForm);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [beforeFiles, setBeforeFiles] = useState<File[]>([]);
  const [duringFiles, setDuringFiles] = useState<File[]>([]);
  const [afterFiles, setAfterFiles] = useState<File[]>([]);
  const [existingPhoto, setExistingPhoto] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("Current");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [roomFilter, setRoomFilter] = useState("All");
  const [residentFilter, setResidentFilter] = useState("All");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [completeModalRequest, setCompleteModalRequest] = useState<MaintenanceRequest | null>(null);
  const [completeCostInput, setCompleteCostInput] = useState("");
  const [completeNotesInput, setCompleteNotesInput] = useState("");
  const [completing, setCompleting] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");

    const [requestsResult, residentsResult, roomsResult, bedsResult, admissionsResult] = await Promise.all([
      supabase
        .from("maintenance_requests")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase
        .from("residents")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase
        .from("rooms")
        .select("*")
        .order("created_at", { ascending: false }),
      supabase.from("beds").select("id,room_id,bed_number,status"),
      supabase.from("admissions").select("id,resident_id,room_id,bed_id,status,admission_date"),
    ]);

    const firstError =
      requestsResult.error ||
      residentsResult.error ||
      roomsResult.error ||
      bedsResult.error;

    const loadError = firstError || admissionsResult.error;

    if (loadError) {
      setError(getSupabaseErrorMessage(loadError, "Maintenance requests could not be loaded. Please refresh and try again."));
    } else {
      setRequests(
        (requestsResult.data ?? []) as MaintenanceRequest[]
      );
      setResidents((residentsResult.data ?? []) as GenericRow[]);
      setRooms((roomsResult.data ?? []) as GenericRow[]);
      setBeds((bedsResult.data ?? []) as GenericRow[]);
      setAdmissions((admissionsResult.data ?? []) as GenericRow[]);
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timeout);
  }, [refresh]);

  const filteredRequests = useMemo(() => {
    const query = search.trim().toLowerCase();

    return requests.filter((request) => {
      const resident = residents.find(
        (item) => text(item.id) === request.resident_id
      );

      const room = rooms.find(
        (item) => text(item.id) === request.room_id
      );

      const searchable = [
        request.request_number,
        request.title,
        request.category,
        request.assigned_to ?? "",
        residentName(resident),
        roomNumber(room),
      ]
        .join(" ")
        .toLowerCase();

      const matchesSearch =
        !query || searchable.includes(query);

      const matchesPriority =
        priorityFilter === "All" ||
        request.priority === priorityFilter;

      const matchesStatus =
        statusFilter === "All" ||
        (statusFilter === "Current"
          ? request.status !== "Archived"
          : request.status === statusFilter);

      const matchesCategory = categoryFilter === "All" || request.category === categoryFilter;
      const matchesRoom = roomFilter === "All" || request.room_id === roomFilter;
      const matchesResident = residentFilter === "All" || request.resident_id === residentFilter;

      return matchesSearch && matchesPriority && matchesStatus && matchesCategory && matchesRoom && matchesResident;
    });
  }, [
    priorityFilter,
    requests,
    residents,
    rooms,
    search,
    statusFilter,
    categoryFilter,
    roomFilter,
    residentFilter,
  ]);

  const summary = useMemo(
    () => ({
      total: requests.length,
      pending: requests.filter((item) => item.status === "Pending")
        .length,
      inProgress: requests.filter(
        (item) => item.status === "In Progress"
      ).length,
      completed: requests.filter(
        (item) => item.status === "Completed"
      ).length,
      highPriority: requests.filter(
        (item) =>
          item.priority === "High" ||
          item.priority === "Emergency"
      ).length,
    }),
    [requests]
  );

  function updateField<K extends keyof MaintenanceForm>(
    key: K,
    value: MaintenanceForm[K]
  ) {
    setForm((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function resetForm() {
    setForm(emptyForm);
    setPhotoFile(null);
    setBeforeFiles([]);
    setDuringFiles([]);
    setAfterFiles([]);
    setExistingPhoto(null);
    setEditingId(null);

    const input = document.getElementById(
      "maintenance-photo-input"
    ) as HTMLInputElement | null;

    if (input) input.value = "";
  }

  function openAddForm() {
    resetForm();
    setShowForm(true);
    setMessage("");
    setError("");
  }

  function openEditForm(request: MaintenanceRequest) {
    setEditingId(request.id);
    setForm({
      resident_id: request.resident_id ?? "",
      admission_id: request.admission_id ?? "",
      room_id: request.room_id ?? "",
      bed_id: request.bed_id ?? "",
      title: request.title ?? "",
      category: request.category ?? "Other",
      description: request.description ?? "",
      priority: request.priority,
      status: request.status,
      assigned_to: request.assigned_to ?? "",
      estimated_cost: String(request.estimated_cost ?? 0),
      actual_cost: String(request.actual_cost ?? 0),
      reported_date: request.complaint_date ?? request.created_at.slice(0, 10),
      completion_date: request.completion_date ?? "",
      notes: request.notes ?? "",
    });
    setExistingPhoto(request.photo_url);
    setPhotoFile(null);
    setShowForm(true);
    setMessage("");
    setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function uploadPhotos(
    files: File[],
    requestId: string,
    kind: "before" | "during" | "after"
  ) {
    const paths: string[] = [];

    for (let index = 0; index < files.length; index += 1) {
      setUploading(`Optimizing and uploading ${kind} photo ${index + 1} of ${files.length}...`);
      const optimized = await optimizeImageForUpload(files[index]);
      const path = `maintenance/${requestId}/${kind}/${Date.now()}-${index}-${safeStorageFileName(optimized.file)}`;
      const { error: uploadError } = await supabase.storage
        .from(MAINTENANCE_PHOTO_BUCKET)
        .upload(path, optimized.file, { cacheControl: "31536000", contentType: optimized.file.type, upsert: false });

      if (uploadError) throw new Error("PHOTO_UPLOAD");

      paths.push(path);
    }

    return paths;
  }

  async function saveRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setSaving(true);
    setMessage("");
    setError("");

    if (!form.title.trim() || !form.room_id || !form.reported_date) {
      setError("Request title, room, and reported date are required.");
      setSaving(false);
      return;
    }

    try {
      const estimatedCost = Number(form.estimated_cost || 0);
      const actualCost = Number(form.actual_cost || 0);
      if (!Number.isFinite(estimatedCost) || estimatedCost < 0 || !Number.isFinite(actualCost) || actualCost < 0) {
        throw new Error("COST");
      }

      let currentRequest: CurrentMaintenanceRequest | null = null;
      if (editingId) {
        const current = await supabase.from("maintenance_requests").select("id,status,resident_id,admission_id,room_id,bed_id,assigned_date,completion_date,completed_at").eq("id", editingId).maybeSingle();
        if (current.error || !current.data) throw new Error("STALE");
        const snapshot = requests.find((request) => request.id === editingId);
        if (current.data.status === "Archived" || !snapshot || current.data.status !== snapshot.status) throw new Error("STALE");
        currentRequest = current.data as CurrentMaintenanceRequest;
      }

      const residentId = currentRequest?.resident_id ?? (form.resident_id || null);
      const admissionId = currentRequest?.admission_id ?? (form.admission_id || null);
      const roomId = currentRequest?.room_id ?? form.room_id;
      const bedId = currentRequest?.bed_id ?? (form.bed_id || null);

      const [roomResult, bedResult, admissionResult] = await Promise.all([
        supabase.from("rooms").select("id").eq("id", roomId).maybeSingle(),
        bedId ? supabase.from("beds").select("id,room_id").eq("id", bedId).maybeSingle() : Promise.resolve({ data: null, error: null }),
        admissionId ? supabase.from("admissions").select("id,resident_id,room_id,bed_id").eq("id", admissionId).maybeSingle() : Promise.resolve({ data: null, error: null }),
      ]);
      if (roomResult.error || !roomResult.data) throw new Error("ROOM");
      if (bedResult.error || (bedId && (!bedResult.data || text(bedResult.data.room_id) !== roomId))) throw new Error("BED");
      if (admissionResult.error || (admissionId && (!admissionResult.data || text(admissionResult.data.room_id) !== roomId || (residentId && text(admissionResult.data.resident_id) !== residentId) || (bedId && text(admissionResult.data.bed_id) !== bedId)))) throw new Error("RELATIONSHIP");

      if (residentId) {
        const resident = await supabase.from("residents").select("id,status").eq("id", residentId).maybeSingle();
        if (resident.error || !resident.data || (!editingId && text(resident.data.status).trim().toLowerCase() === "archived")) throw new Error("RESIDENT");
      }

      const finalCompletionDate =
        form.completion_date ||
        currentRequest?.completion_date ||
        (form.status === "Completed" ? new Date().toISOString().slice(0, 10) : null);

      const payload = {
        resident_id: residentId,
        admission_id: admissionId,
        room_id: roomId,
        bed_id: bedId,
        title: form.title.trim(),
        category: form.category,
        description: form.description.trim() || null,
        priority: form.priority,
        status: form.status,
        assigned_to: form.assigned_to.trim() || null,
        estimated_cost: estimatedCost,
        actual_cost: actualCost,
        complaint_date: form.reported_date,
        photo_url: existingPhoto,
        assigned_date:
          currentRequest?.assigned_date ||
          (form.assigned_to.trim() ? new Date().toISOString().slice(0, 10) : null),
        completion_date: finalCompletionDate,
        completed_at:
          currentRequest?.completed_at ||
          (form.status === "Completed" ? new Date().toISOString() : null),
        notes: form.notes.trim() || null,
        updated_at: new Date().toISOString(),
      };

      let result;
      if (editingId && currentRequest) {
        result = await supabase
          .from("maintenance_requests")
          .update(payload)
          .eq("id", editingId)
          .eq("status", currentRequest.status)
          .select("*")
          .single();
      } else {
        result = await supabase.from("maintenance_requests").insert({
            ...payload,
            request_number: requestNumber(),
          }).select("*").single();
      }

      if (result.error || !result.data) {
        throw new Error("DATABASE");
      }

      const saved = result.data as MaintenanceRequest;
      const newBeforeFiles = photoFile ? [photoFile, ...beforeFiles] : beforeFiles;
      let beforePhotos = photoList(saved.before_photos);
      let duringPhotos = photoList(saved.during_photos);
      let afterPhotos = photoList(saved.after_photos);

      try {
        beforePhotos = [...beforePhotos, ...(await uploadPhotos(newBeforeFiles, saved.id, "before"))];
        duringPhotos = [...duringPhotos, ...(await uploadPhotos(duringFiles, saved.id, "during"))];
        afterPhotos = [...afterPhotos, ...(await uploadPhotos(afterFiles, saved.id, "after"))];
      } catch {
        setError("The maintenance request was saved, but one or more photos could not be uploaded. Existing photos were preserved.");
        await refresh();
        setUploading("");
        setSaving(false);
        return;
      }

      if (newBeforeFiles.length || duringFiles.length || afterFiles.length) {
        const linked = await supabase.from("maintenance_requests").update({
          before_photos: beforePhotos,
          during_photos: duringPhotos,
          after_photos: afterPhotos,
        photo_url: existingPhoto || beforePhotos[0] || null,
          updated_at: new Date().toISOString(),
        }).eq("id", saved.id);

        if (linked.error) {
          setError("The maintenance request and photos were saved, but the photo links could not be attached. Existing history was not deleted.");
          await refresh();
          setUploading("");
          setSaving(false);
          return;
        }
      }

      let emailNotice = "";
      const wasCompleted = currentRequest?.status === "Completed";
      const isNowCompleted = form.status === "Completed";
      if (isNowCompleted && !wasCompleted) {
        const notif = await notifyMaintenanceCompleted(saved.id);
        if (notif.emailSent && notif.recipientEmail) {
          emailNotice = ` Resolution email sent to ${notif.recipientEmail}.`;
        }
      }

      setMessage(
        editingId
          ? `Maintenance request updated successfully.${emailNotice}`
          : `Maintenance request added successfully.${emailNotice}`
      );

      resetForm();
      setShowForm(false);
      await refresh();
    } catch (saveError) {
      const code = saveError instanceof Error ? saveError.message : "";
      const messages: Record<string, string> = {
        PHOTO_UPLOAD: "The maintenance photo could not be uploaded. The request was not changed.",
        COST: "Estimated and actual costs must be valid non-negative amounts.",
        STALE: "This maintenance request no longer exists. Please refresh and try again.",
        RESIDENT: "The selected resident is no longer available for a new maintenance request.",
        ROOM: "The selected room could not be verified.",
        BED: "The selected bed does not belong to the selected room.",
        RELATIONSHIP: "The selected admission, resident, room, and bed relationship does not match.",
        DATABASE: "The maintenance request could not be saved. Please review the form and try again.",
      };
      setError(messages[code] || "The maintenance request could not be saved. Please try again.");
    }

    setUploading("");
    setSaving(false);
  }

  async function cancelRequest(request: MaintenanceRequest) {
    if (
      !window.confirm(
        `Cancel maintenance request ${request.request_number}? Its history will be preserved.`
      )
    ) {
      return;
    }

    const current = await supabase.from("maintenance_requests").select("id,status").eq("id", request.id).maybeSingle();
    if (current.error || !current.data) {
      setError("This maintenance request could not be refreshed. Please try again.");
      return;
    }
    if (["cancelled", "archived"].includes(text(current.data.status).trim().toLowerCase())) {
      setError("This maintenance request is already cancelled or archived.");
      return;
    }
    const { data: cancelled, error: cancelError } = await supabase
      .from("maintenance_requests")
      .update({ status: "Cancelled", updated_at: new Date().toISOString() })
      .eq("id", request.id)
      .eq("status", current.data.status)
      .select("id")
      .maybeSingle();

    if (cancelError || !cancelled) {
      setError(cancelError ? getSupabaseErrorMessage(cancelError, "The maintenance request could not be cancelled. Please try again.") : "The maintenance status changed before cancellation completed. Refresh and try again.");
    } else {
      setMessage("Maintenance request cancelled. Its history has been preserved.");
      await refresh();
    }
  }

  async function archiveRequest(request: MaintenanceRequest) {
    if (!window.confirm(`Archive maintenance request ${request.request_number}? Its full record and evidence will remain preserved.`)) return;
    setMessage("");
    setError("");
    const current = await supabase.from("maintenance_requests").select("id,status").eq("id", request.id).maybeSingle();
    if (current.error || !current.data) {
      setError("This maintenance request could not be refreshed. Please try again.");
      return;
    }
    if (current.data.status === "Archived") {
      setError("This maintenance request is already archived.");
      return;
    }
    const { data: archived, error: archiveError } = await supabase.from("maintenance_requests").update({ status: "Archived", updated_at: new Date().toISOString() }).eq("id", request.id).eq("status", current.data.status).select("id").maybeSingle();
    if (archiveError || !archived) {
      setError(archiveError ? getSupabaseErrorMessage(archiveError, "The maintenance request could not be archived.") : "The maintenance status changed before archival completed. Refresh and try again.");
      await refresh();
      return;
    }
    if (editingId === request.id) { resetForm(); setShowForm(false); }
    setMessage("Maintenance request archived. Its history and evidence were preserved.");
    await refresh();
  }

  async function quickApprove(request: MaintenanceRequest) {
    setApprovingId(request.id);
    setMessage("");
    setError("");

    try {
      const now = new Date().toISOString();
      const today = now.slice(0, 10);
      const { error: updateErr } = await supabase
        .from("maintenance_requests")
        .update({
          status: "In Progress",
          assigned_date: request.assigned_date || today,
          updated_at: now,
        })
        .eq("id", request.id);

      if (updateErr) {
        setError(getSupabaseErrorMessage(updateErr, "Failed to approve maintenance request."));
      } else {
        setMessage(`Maintenance request ${request.request_number} approved and marked In Progress.`);
        await refresh();
      }
    } catch (err) {
      setError("Failed to approve request.");
    } finally {
      setApprovingId(null);
    }
  }

  function openQuickCompleteModal(request: MaintenanceRequest) {
    setCompleteModalRequest(request);
    setCompleteCostInput(String(request.actual_cost || request.estimated_cost || 0));
    setCompleteNotesInput(request.notes || "");
  }

  async function submitQuickComplete(e: FormEvent) {
    e.preventDefault();
    if (!completeModalRequest) return;
    setCompleting(true);
    setError("");
    setMessage("");

    try {
      const now = new Date().toISOString();
      const today = now.slice(0, 10);
      const cost = Number(completeCostInput || 0);

      const { error: updateErr } = await supabase
        .from("maintenance_requests")
        .update({
          status: "Completed",
          completion_date: today,
          completed_at: now,
          actual_cost: Number.isFinite(cost) && cost >= 0 ? cost : 0,
          notes: completeNotesInput.trim() || completeModalRequest.notes || null,
          updated_at: now,
        })
        .eq("id", completeModalRequest.id);

      if (updateErr) {
        setError(getSupabaseErrorMessage(updateErr, "Failed to mark maintenance request as completed."));
      } else {
        const notif = await notifyMaintenanceCompleted(completeModalRequest.id);
        const emailMsg =
          notif.emailSent && notif.recipientEmail
            ? ` Resolution email sent to ${notif.recipientEmail}.`
            : "";
        setMessage(`Maintenance request ${completeModalRequest.request_number} marked as Completed.${emailMsg}`);
        setCompleteModalRequest(null);
        await refresh();
      }
    } catch {
      setError("Failed to mark request as completed.");
    } finally {
      setCompleting(false);
    }
  }

  function handlePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    if (file) {
      const validationError = validateImageFile(file);
      if (validationError) { setError(validationError); event.target.value = ""; return; }
    }
    setError("");
    setPhotoFile(file);
  }

  function handlePhotos(
    event: ChangeEvent<HTMLInputElement>,
    kind: "before" | "during" | "after"
  ) {
    const files = Array.from(event.target.files ?? []);
    if (files.length > MAX_FILES_PER_CATEGORY) {
      setError(`Choose no more than ${MAX_FILES_PER_CATEGORY} photos at a time.`);
      event.target.value = "";
      return;
    }
    const validationError = files.map(validateImageFile).find(Boolean);
    if (validationError) {
      setError(validationError);
      event.target.value = "";
      return;
    }
    if (kind === "before") setBeforeFiles(files);
    else if (kind === "during") setDuringFiles(files);
    else setAfterFiles(files);
    setError("");
  }

  return (
    <main className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">
              Hostel Management System
            </p>

            <h1 className="mt-2 text-3xl font-bold text-slate-900">
              Maintenance
            </h1>

            <p className="mt-1 text-sm text-slate-500">
              Manage maintenance requests, staff assignments, costs and completion.
            </p>
          </div>

          <button
            type="button"
            onClick={openAddForm}
            className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            + Add Request
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
            <div className="mb-6 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-xl font-bold text-slate-900">
                  {editingId
                    ? "Edit Maintenance Request"
                    : "Add Maintenance Request"}
                </h2>

                <p className="mt-1 text-sm text-slate-500">
                  Record the issue, assignment, photo and cost.
                </p>
              </div>

              <button
                type="button"
                onClick={() => {
                  resetForm();
                  setShowForm(false);
                }}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                Close
              </button>
            </div>

            <form onSubmit={saveRequest} className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                <Field label="Resident">
                  <select
                    disabled={Boolean(editingId)}
                    value={form.resident_id}
                    onChange={(event) => setForm((current) => ({ ...current, resident_id: event.target.value, admission_id: "", bed_id: "" }))}
                    className={inputClass}
                  >
                    <option value="">No resident selected</option>

                    {residents
                      .filter((resident) =>
                        text(resident.id) === form.resident_id ||
                        text(resident.status).trim().toLowerCase() !== "archived"
                      )
                      .map((resident) => (
                      <option
                        key={text(resident.id)}
                        value={text(resident.id)}
                      >
                        {residentName(resident)}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Admission">
                  <select
                    disabled={Boolean(editingId)}
                    value={form.admission_id}
                    onChange={(event) => {
                      const admission = admissions.find((item) => text(item.id) === event.target.value);
                      setForm((current) => ({
                        ...current,
                        admission_id: event.target.value,
                        resident_id: admission ? text(admission.resident_id) : current.resident_id,
                        room_id: admission ? text(admission.room_id) : current.room_id,
                        bed_id: admission ? text(admission.bed_id) : "",
                      }));
                    }}
                    className={inputClass}
                  >
                    <option value="">No admission selected</option>
                    {admissions.filter((admission) => !form.resident_id || text(admission.resident_id) === form.resident_id || text(admission.id) === form.admission_id).map((admission) => <option key={text(admission.id)} value={text(admission.id)}>{text(admission.admission_date).slice(0, 10) || text(admission.id)} · {text(admission.status)}</option>)}
                  </select>
                </Field>

                <Field label="Room *">
                  <select
                    required
                    disabled={Boolean(editingId)}
                    value={form.room_id}
                    onChange={(event) => setForm((current) => ({ ...current, room_id: event.target.value, admission_id: "", bed_id: "" }))}
                    className={inputClass}
                  >
                    <option value="">Select room</option>

                    {rooms.map((room) => (
                      <option key={text(room.id)} value={text(room.id)}>
                        {roomNumber(room)}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field label="Bed">
                  <select disabled={Boolean(editingId) || !form.room_id} value={form.bed_id} onChange={(event) => updateField("bed_id", event.target.value)} className={inputClass}>
                    <option value="">No bed selected</option>
                    {beds.filter((bed) => text(bed.room_id) === form.room_id).map((bed) => <option key={text(bed.id)} value={text(bed.id)}>{firstText(bed, ["bed_number"]) || text(bed.id)}</option>)}
                  </select>
                </Field>

                <Field label="Request Title *">
                  <input
                    required
                    value={form.title}
                    onChange={(event) =>
                      updateField("title", event.target.value)
                    }
                    className={inputClass}
                    placeholder="Fan not working"
                  />
                </Field>

                <Field label="Category">
                  <select
                    value={form.category}
                    onChange={(event) =>
                      updateField("category", event.target.value)
                    }
                    className={inputClass}
                  >
                    <option value="Electrical">Electrical</option>
                    <option value="Plumbing">Plumbing</option>
                    <option value="Furniture">Furniture</option>
                    <option value="Appliance">Appliance</option>
                    <option value="Cleaning">Cleaning</option>
                    <option value="Internet">Internet</option>
                    <option value="Other">Other</option>
                  </select>
                </Field>

                <Field label="Priority">
                  <select
                    value={form.priority}
                    onChange={(event) =>
                      updateField(
                        "priority",
                        event.target.value as Priority
                      )
                    }
                    className={inputClass}
                  >
                    <option value="Low">Low</option>
                    <option value="Medium">Medium</option>
                    <option value="High">High</option>
                    <option value="Emergency">Emergency</option>
                  </select>
                </Field>

                <Field label="Status">
                  <select
                    value={form.status}
                    onChange={(event) =>
                      updateField(
                        "status",
                        event.target.value as RequestStatus
                      )
                    }
                    className={inputClass}
                  >
                    <option value="Open">Open</option>
                    <option value="Pending">Pending Approval</option>
                    <option value="In Progress">In Progress</option>
                    <option value="Completed">Completed</option>
                    <option value="Cancelled">Cancelled</option>
                  </select>
                </Field>

                <Field label="Assigned Person / Vendor">
                  <input
                    value={form.assigned_to}
                    onChange={(event) =>
                      updateField("assigned_to", event.target.value)
                    }
                    className={inputClass}
                    placeholder="Staff, technician, or vendor name"
                  />
                </Field>

                <Field label="Estimated Cost">
                  <input
                    type="number"
                    min="0"
                    value={form.estimated_cost}
                    onChange={(event) =>
                      updateField(
                        "estimated_cost",
                        event.target.value
                      )
                    }
                    className={inputClass}
                  />
                </Field>

                <Field label="Actual Cost">
                  <input
                    type="number"
                    min="0"
                    value={form.actual_cost}
                    onChange={(event) =>
                      updateField("actual_cost", event.target.value)
                    }
                    className={inputClass}
                  />
                </Field>

                <Field label="Completion Date">
                  <input
                    type="date"
                    value={form.completion_date}
                    onChange={(event) =>
                      updateField(
                        "completion_date",
                        event.target.value
                      )
                    }
                    className={inputClass}
                  />
                </Field>

                <Field label="Primary Before Photo">
                  <input
                    id="maintenance-photo-input"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={handlePhoto}
                    className={inputClass}
                  />

                  {existingPhoto && !photoFile && (
                    <PrivateStorageLinks title="Current photo" bucket={MAINTENANCE_PHOTO_BUCKET} references={[maintenancePhotoUrl(existingPhoto)]} />
                  )}
                </Field>

                <Field label="Reported Date *">
                  <input required type="date" value={form.reported_date} onChange={(event) => updateField("reported_date", event.target.value)} className={inputClass} />
                </Field>

                <Field label="Additional Before Photos">
                  <input type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={(event) => handlePhotos(event, "before")} className={inputClass} />
                </Field>

                <Field label="During Work Photos">
                  <input type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={(event) => handlePhotos(event, "during")} className={inputClass} />
                </Field>

                <Field label="After Work Photos">
                  <input type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={(event) => handlePhotos(event, "after")} className={inputClass} />
                </Field>

                {editingId && (
                  <div className="md:col-span-2 xl:col-span-3">
                    <PrivateStorageLinks title="Existing before photos" bucket={MAINTENANCE_PHOTO_BUCKET} references={photoUrls(requests.find((item) => item.id === editingId)?.before_photos)} />
                    <PrivateStorageLinks title="Existing during photos" bucket={MAINTENANCE_PHOTO_BUCKET} references={photoUrls(requests.find((item) => item.id === editingId)?.during_photos)} />
                    <PrivateStorageLinks title="Existing after photos" bucket={MAINTENANCE_PHOTO_BUCKET} references={photoUrls(requests.find((item) => item.id === editingId)?.after_photos)} />
                  </div>
                )}

                <Field label="Description" wide>
                  <textarea
                    value={form.description}
                    onChange={(event) =>
                      updateField("description", event.target.value)
                    }
                    className={`${inputClass} min-h-28`}
                    placeholder="Describe the maintenance issue."
                  />
                </Field>

                <Field label="Admin Notes" wide>
                  <textarea
                    value={form.notes}
                    onChange={(event) =>
                      updateField("notes", event.target.value)
                    }
                    className={`${inputClass} min-h-24`}
                    placeholder="Work details, parts used or completion notes."
                  />
                </Field>
              </div>

              <div className="flex flex-wrap justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    resetForm();
                    setShowForm(false);
                  }}
                  className="rounded-xl border border-slate-300 px-5 py-3 text-sm font-semibold"
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  disabled={saving}
                  className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {uploading || (saving
                    ? "Saving..."
                    : editingId
                    ? "Update Request"
                    : "Save Request")}
                </button>
              </div>
            </form>
          </section>
        )}

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard label="Total Requests" value={String(summary.total)} />
          <StatCard label="Pending" value={String(summary.pending)} />
          <StatCard
            label="In Progress"
            value={String(summary.inProgress)}
          />
          <StatCard
            label="Completed"
            value={String(summary.completed)}
          />
          <StatCard
            label="High Priority"
            value={String(summary.highPriority)}
          />
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white shadow-sm">
          <div className="grid gap-3 border-b border-slate-200 p-5 md:grid-cols-2 xl:grid-cols-4">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className={inputClass}
              placeholder="Search request, resident, room, category or technician"
            />

            <select
              value={priorityFilter}
              onChange={(event) =>
                setPriorityFilter(event.target.value)
              }
              className={inputClass}
            >
              <option value="All">All Priorities</option>
              <option value="Low">Low</option>
              <option value="Medium">Medium</option>
              <option value="High">High</option>
              <option value="Emergency">Emergency</option>
            </select>

            <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)} className={inputClass}>
              <option value="All">All Categories</option>
              {["Electrical", "Plumbing", "Furniture", "Appliance", "Cleaning", "Internet", "Other"].map((category) => <option key={category} value={category}>{category}</option>)}
            </select>

            <select value={roomFilter} onChange={(event) => setRoomFilter(event.target.value)} className={inputClass}>
              <option value="All">All Rooms</option>
              {rooms.map((room) => <option key={text(room.id)} value={text(room.id)}>{roomNumber(room)}</option>)}
            </select>

            <select value={residentFilter} onChange={(event) => setResidentFilter(event.target.value)} className={inputClass}>
              <option value="All">All Residents</option>
              {residents.map((resident) => <option key={text(resident.id)} value={text(resident.id)}>{residentName(resident)}</option>)}
            </select>

            <select
              value={statusFilter}
              onChange={(event) =>
                setStatusFilter(event.target.value)
              }
              className={inputClass}
            >
              <option value="Current">Current</option>
              <option value="All">All Statuses</option>
              <option value="Pending">Pending Approval / New</option>
              <option value="Open">Open</option>
              <option value="In Progress">In Progress</option>
              <option value="Completed">Completed</option>
              <option value="Cancelled">Cancelled</option>
              <option value="Archived">Archived</option>
            </select>

            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold"
            >
              Refresh
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  {[
                    "Request / Dates",
                    "Room / Bed",
                    "Resident",
                    "Issue / Assignment",
                    "Costs",
                    "Evidence",
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
                      Loading maintenance requests...
                    </td>
                  </tr>
                ) : filteredRequests.length === 0 ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="px-5 py-12 text-center text-sm text-slate-500"
                    >
                      No maintenance requests found.
                    </td>
                  </tr>
                ) : (
                  filteredRequests.map((request) => {
                    const resident = residents.find(
                      (item) =>
                        text(item.id) === request.resident_id
                    );

                    const room = rooms.find(
                      (item) => text(item.id) === request.room_id
                    );
                    const bed = beds.find(
                      (item) => text(item.id) === request.bed_id
                    );
                    const archived = request.status === "Archived";

                    return (
                      <tr
                        key={request.id}
                        className="hover:bg-slate-50/70"
                      >
                        <td className="px-5 py-4">
                          <p className="font-semibold text-slate-900">
                            {request.request_number}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            Reported: {(request.complaint_date || request.created_at).slice(0, 10)}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            Completed: {request.completion_date || "—"}
                          </p>
                        </td>

                        <td className="px-5 py-4 text-sm text-slate-700">
                          <p>Room: {roomNumber(room)}</p>
                          <p className="mt-1 text-xs text-slate-500">
                            Bed: {firstText(bed, ["bed_number"]) || "Not linked"}
                          </p>
                        </td>

                        <td className="px-5 py-4 text-sm text-slate-700">
                          {residentName(resident)}
                        </td>

                        <td className="px-5 py-4">
                          <p className="font-semibold text-slate-900">
                            {request.title || "Maintenance Request"}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            {request.category}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">
                            Assigned: {request.assigned_to || "Not assigned"}
                          </p>
                          <span
                            className={`mt-2 inline-flex rounded-full px-3 py-1 text-xs font-bold ${priorityClass(
                              request.priority
                            )}`}
                          >
                            {request.priority}
                          </span>
                        </td>

                        <td className="px-5 py-4 text-xs text-slate-600">
                          <p>
                            Estimated: {money(request.estimated_cost)}
                          </p>
                          <p className="mt-1">
                            Actual: {money(request.actual_cost)}
                          </p>
                        </td>

                        <td className="px-5 py-4">
                          {photoList(request.before_photos).length + photoList(request.during_photos).length + photoList(request.after_photos).length > 0 || request.photo_url ? (
                            <span className="text-xs font-semibold text-slate-700">{photoList(request.before_photos).length + photoList(request.during_photos).length + photoList(request.after_photos).length || 1} photo(s)</span>
                          ) : (
                            <span className="text-xs text-slate-400">
                              No photo
                            </span>
                          )}
                        </td>

                        <td className="px-5 py-4">
                          <span
                            className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${statusClass(
                              request.status
                            )}`}
                          >
                            {request.status}
                          </span>
                        </td>

                        <td className="px-5 py-4">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Link
                              href={`/maintenance/${request.id}`}
                              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition shadow-sm"
                            >
                              View
                            </Link>

                            {!archived && (request.status === "Pending" || request.status === "Open") && (
                              <button
                                type="button"
                                disabled={approvingId === request.id}
                                onClick={() => void quickApprove(request)}
                                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-700 shadow-sm transition disabled:opacity-50"
                                title="Approve & Set to In Progress"
                              >
                                {approvingId === request.id ? "Approving..." : "✓ Approve"}
                              </button>
                            )}

                            {!archived && request.status !== "Completed" && request.status !== "Cancelled" && (
                              <button
                                type="button"
                                onClick={() => openQuickCompleteModal(request)}
                                className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 shadow-sm transition"
                                title="Mark as Completed"
                              >
                                ✓ Complete
                              </button>
                            )}

                            {!archived && (
                              <button
                                type="button"
                                onClick={() => openEditForm(request)}
                                className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 transition"
                              >
                                Edit
                              </button>
                            )}

                            {!archived && request.status !== "Cancelled" && (
                              <button
                                type="button"
                                onClick={() => void cancelRequest(request)}
                                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition"
                              >
                                Cancel
                              </button>
                            )}

                            {!archived && (
                              <button
                                type="button"
                                onClick={() => void archiveRequest(request)}
                                className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-100 transition"
                              >
                                Archive
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Quick Complete Modal */}
        {completeModalRequest && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm">
            <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-3xl border border-slate-200 bg-white p-4 shadow-2xl sm:p-8">
              <div className="flex items-center justify-between border-b border-slate-200 pb-4">
                <div>
                  <h3 className="text-xl font-bold text-slate-900">Mark Maintenance as Completed</h3>
                  <p className="text-xs text-slate-500 mt-0.5 font-mono">
                    {completeModalRequest.request_number} — {completeModalRequest.title}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setCompleteModalRequest(null)}
                  className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 transition"
                >
                  ✕
                </button>
              </div>

              <form onSubmit={submitQuickComplete} className="mt-5 space-y-4">
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
                      value={completeCostInput}
                      onChange={(e) => setCompleteCostInput(e.target.value)}
                      placeholder="0"
                      className="w-full rounded-xl border border-slate-300 bg-white pl-12 pr-4 py-2.5 text-sm font-bold text-slate-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                    />
                  </div>
                  <span className="text-[11px] text-slate-400">
                    Estimated cost was Rs {Number(completeModalRequest.estimated_cost || 0).toLocaleString()}
                  </span>
                </div>

                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-slate-700">
                    Resolution Notes / Work Performed
                  </label>
                  <textarea
                    rows={3}
                    value={completeNotesInput}
                    onChange={(e) => setCompleteNotesInput(e.target.value)}
                    placeholder="Describe work completed, technician notes, or parts replaced..."
                    className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  />
                </div>

                <div className="flex flex-wrap items-center justify-end gap-3 border-t border-slate-200 pt-3">
                  <button
                    type="button"
                    onClick={() => setCompleteModalRequest(null)}
                    className="rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={completing}
                    className="rounded-xl bg-emerald-600 px-6 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {completing ? "Completing..." : "Confirm & Complete"}
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
      <p className="text-sm font-medium text-slate-500">
        {label}
      </p>
      <p className="mt-2 text-2xl font-bold text-slate-900">
        {value}
      </p>
    </article>
  );
}
