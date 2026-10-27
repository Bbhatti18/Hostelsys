"use client";

import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { getSupabaseErrorMessage } from "@/lib/supabaseErrors";
import { optimizeImageForUpload, safeStorageFileName, validateImageFile } from "@/lib/imageValidation";
import { INSPECTION_PHOTO_BUCKET, inspectionPhotoUrl, inspectionTypePath } from "@/lib/inspectionStorage";
import { normalizeBedLabel } from "@/lib/bedLabels";
import PrivateStorageLinks from "@/components/storage/PrivateStorageLinks";

type Row = Record<string, unknown>;
type Inspection = {
  id: string; resident_id: string | null; admission_id: string | null; room_id: string | null; bed_id: string | null;
  inspection_number: string | null; inspection_date: string; inspection_type: string | null;
  inspector_name: string | null; cleanliness: string | null; electrical_status: string | null;
  plumbing_status: string | null; furniture_condition: string | null; wall_floor_status: string | null;
  overall_status: string | null; notes: string | null; damage_found: boolean | null;
  damage_description: string | null; estimated_damage_cost: number | null; actual_damage_cost: number | null; status: string | null;
  before_photos: unknown; after_photos: unknown; photos: unknown;
};
type LegacyInspection = { id: string; resident_id: string | null; room_id: string | null; inspection_date: string; before_photo: string | null; after_photo: string | null; damage_notes: string | null };
type FormState = { resident_id: string; admission_id: string; room_id: string; inspection_type: "Check In" | "Check Out"; inspection_date: string; inspector_name: string; cleanliness: string; electrical_status: string; plumbing_status: string; furniture_condition: string; wall_floor_status: string; overall_status: string; notes: string; damage_found: boolean; damage_description: string; estimated_damage_cost: string; actual_damage_cost: string };

const emptyForm: FormState = { resident_id: "", admission_id: "", room_id: "", inspection_type: "Check In", inspection_date: new Date().toISOString().slice(0, 10), inspector_name: "", cleanliness: "", electrical_status: "", plumbing_status: "", furniture_condition: "", wall_floor_status: "", overall_status: "", notes: "", damage_found: false, damage_description: "", estimated_damage_cost: "0", actual_damage_cost: "0" };
const inputClass = "w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100 disabled:bg-slate-100";
const text = (value: unknown) => value == null ? "" : String(value);
const normalized = (value: unknown) => text(value).trim().toLowerCase();
const display = (row: Row | undefined, keys: string[], fallback = "—") => keys.map((key) => text(row?.[key]).trim()).find(Boolean) || fallback;
const photoList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
const photoUrls = (value: unknown) => photoList(value).map(inspectionPhotoUrl);
const MAX_FILES_PER_CATEGORY = 12;

export default function InspectionPage() {
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [legacy, setLegacy] = useState<LegacyInspection[]>([]);
  const [residents, setResidents] = useState<Row[]>([]);
  const [rooms, setRooms] = useState<Row[]>([]);
  const [beds, setBeds] = useState<Row[]>([]);
  const [admissions, setAdmissions] = useState<Row[]>([]);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [editing, setEditing] = useState<Inspection | null>(null);
  const [beforeFiles, setBeforeFiles] = useState<File[]>([]);
  const [afterFiles, setAfterFiles] = useState<File[]>([]);
  const [evidenceFiles, setEvidenceFiles] = useState<File[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("Current");
  const [residentFilter, setResidentFilter] = useState("All");
  const [roomFilter, setRoomFilter] = useState("All");
  const [typeFilter, setTypeFilter] = useState("All");
  const [dateFilter, setDateFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true); setError("");
    const [inspectionResult, legacyResult, residentResult, roomResult, admissionResult, bedResult] = await Promise.all([
      supabase.from("room_inspections").select("*").order("inspection_date", { ascending: false }),
      supabase.from("inspections").select("id,resident_id,room_id,inspection_date,before_photo,after_photo,damage_notes").order("inspection_date", { ascending: false }),
      supabase.from("residents").select("*").neq("status", "Archived").order("created_at", { ascending: true }),
      supabase.from("rooms").select("*").order("room_number", { ascending: true }),
      supabase.from("admissions").select("*").order("created_at", { ascending: false }),
      supabase.from("beds").select("id,bed_number,room_id"),
    ]);
    const failed = inspectionResult.error || legacyResult.error || residentResult.error || roomResult.error || admissionResult.error || bedResult.error;
    if (failed) setError(getSupabaseErrorMessage(failed, "Inspection records could not be loaded. Please refresh and try again."));
    else {
      setInspections((inspectionResult.data ?? []) as Inspection[]);
      setLegacy((legacyResult.data ?? []) as LegacyInspection[]);
      setResidents((residentResult.data ?? []) as Row[]); setRooms((roomResult.data ?? []) as Row[]); setAdmissions((admissionResult.data ?? []) as Row[]);
      setBeds((bedResult.data ?? []) as Row[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timeout);
  }, [refresh]);

  const selectableResidents = residents.filter((resident) => normalized(resident.status) !== "archived");
  const residentAdmissions = admissions.filter((admission) => text(admission.resident_id) === form.resident_id && !["cancelled", "archived"].includes(normalized(admission.status)));
  const filtered = useMemo(() => inspections.filter((inspection) => {
    const resident = residents.find((row) => text(row.id) === inspection.resident_id);
    if (!resident || normalized(resident.status) === "archived") return false;
    const room = rooms.find((row) => text(row.id) === inspection.room_id);
    const haystack = [inspection.inspection_number, inspection.inspection_date, inspection.inspection_type, inspection.inspector_name, display(resident, ["full_name"]), display(room, ["room_number"])].join(" ").toLowerCase();
    return (!search.trim() || haystack.includes(search.trim().toLowerCase())) &&
      (statusFilter === "All" || (statusFilter === "Current" ? normalized(inspection.status) !== "archived" : inspection.status === statusFilter)) &&
      (residentFilter === "All" || inspection.resident_id === residentFilter) &&
      (roomFilter === "All" || inspection.room_id === roomFilter) &&
      (typeFilter === "All" || inspection.inspection_type === typeFilter) &&
      (!dateFilter || inspection.inspection_date === dateFilter);
  }), [dateFilter, inspections, residentFilter, residents, roomFilter, rooms, search, statusFilter, typeFilter]);

  function reset() { setForm(emptyForm); setEditing(null); setBeforeFiles([]); setAfterFiles([]); setEvidenceFiles([]); }
  function openEdit(item: Inspection) {
    const damageFound = Boolean(item.damage_found);
    setEditing(item); setForm({ resident_id: item.resident_id ?? "", admission_id: item.admission_id ?? "", room_id: item.room_id ?? "", inspection_type: item.inspection_type === "Check Out" ? "Check Out" : "Check In", inspection_date: item.inspection_date, inspector_name: item.inspector_name ?? "", cleanliness: item.cleanliness ?? "", electrical_status: item.electrical_status ?? "", plumbing_status: item.plumbing_status ?? "", furniture_condition: item.furniture_condition ?? "", wall_floor_status: item.wall_floor_status ?? "", overall_status: item.overall_status ?? "", notes: item.notes ?? "", damage_found: damageFound, damage_description: damageFound ? item.damage_description ?? "" : "", estimated_damage_cost: damageFound ? String(item.estimated_damage_cost ?? 0) : "0", actual_damage_cost: damageFound ? String(item.actual_damage_cost ?? 0) : "0" });
    setBeforeFiles([]); setAfterFiles([]); setEvidenceFiles([]); setShowForm(true); setMessage(""); setError(""); window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function chooseFiles(event: ChangeEvent<HTMLInputElement>, kind: "before" | "after" | "evidence") {
    const files = Array.from(event.target.files ?? []);
    if (files.length > MAX_FILES_PER_CATEGORY) { setError(`Choose no more than ${MAX_FILES_PER_CATEGORY} photos at a time.`); event.target.value = ""; return; }
    const invalid = files.map(validateImageFile).find(Boolean);
    if (invalid) { setError(invalid); event.target.value = ""; return; }
    if (kind === "before") setBeforeFiles(files); else if (kind === "after") setAfterFiles(files); else setEvidenceFiles(files);
    setError("");
  }
  async function upload(files: File[], id: string, admissionId: string, inspectionType: string, kind: "before" | "after" | "evidence") {
    const paths: string[] = [];
    for (let index = 0; index < files.length; index += 1) {
      setUploading(`Optimizing and uploading ${kind} photo ${index + 1} of ${files.length}...`);
      const optimized = await optimizeImageForUpload(files[index]);
      const path = `inspection/${admissionId}/${inspectionTypePath(inspectionType)}/${id}/${kind}/${Date.now()}-${index}-${safeStorageFileName(optimized.file)}`;
      const result = await supabase.storage.from(INSPECTION_PHOTO_BUCKET).upload(path, optimized.file, { cacheControl: "31536000", contentType: optimized.file.type, upsert: false });
      if (result.error) throw new Error("PHOTO_UPLOAD");
      paths.push(path);
    }
    return paths;
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaving(true); setMessage(""); setError("");
    try {
      const residentId = editing?.resident_id || form.resident_id;
      const admissionId = editing?.admission_id || form.admission_id;
      const roomId = editing?.room_id || form.room_id;
      if (!residentId || !admissionId || !roomId || !form.inspection_date) throw new Error("REQUIRED");
      if (editing && normalized(editing.status) === "archived") throw new Error("ARCHIVED");
      const damageDescription = form.damage_description.trim();
      const estimatedCost = form.damage_found ? Number(form.estimated_damage_cost || 0) : 0;
      const actualCost = form.damage_found ? Number(form.actual_damage_cost || 0) : 0;
      if (form.damage_found && !damageDescription) throw new Error("DAMAGE_DESCRIPTION");
      if (!Number.isFinite(estimatedCost) || estimatedCost < 0 || !Number.isFinite(actualCost) || actualCost < 0) throw new Error("COST");
      const residentResult = await supabase.from("residents").select("id,status").eq("id", residentId).maybeSingle();
      if (residentResult.error || !residentResult.data || (!editing && normalized(residentResult.data.status) === "archived")) throw new Error("RESIDENT");
      const admissionResult = await supabase.from("admissions").select("id,resident_id,room_id,bed_id,status").eq("id", admissionId).maybeSingle();
      if (admissionResult.error || !admissionResult.data || text(admissionResult.data.resident_id) !== residentId || text(admissionResult.data.room_id) !== roomId) throw new Error("ADMISSION");
      if (!editing && form.inspection_type === "Check Out") {
        const checkInResult = await supabase.from("room_inspections").select("id").eq("admission_id", admissionId).eq("inspection_type", "Check In").neq("status", "Archived").limit(1).maybeSingle();
        if (checkInResult.error) throw new Error("DATABASE");
        if (!checkInResult.data) throw new Error("CHECK_IN_REQUIRED");
      }
      if (editing) {
        const current = await supabase.from("room_inspections").select("id,status,before_photos,after_photos,photos").eq("id", editing.id).maybeSingle();
        if (current.error || !current.data) throw new Error("STALE");
        if (normalized(current.data.status) === "archived" || current.data.status !== editing.status) throw new Error("STALE");
      }
      const selectedAdmission = admissionResult.data as Row;
      const payload = { resident_id: residentId, admission_id: admissionId, room_id: roomId, bed_id: editing?.bed_id ?? (text(selectedAdmission.bed_id) || null), inspection_date: form.inspection_date, inspection_type: form.inspection_type, inspector_name: form.inspector_name.trim() || null, cleanliness: form.cleanliness.trim() || null, electrical_status: form.electrical_status.trim() || null, plumbing_status: form.plumbing_status.trim() || null, furniture_condition: form.furniture_condition.trim() || null, wall_floor_status: form.wall_floor_status.trim() || null, overall_status: form.overall_status.trim() || null, notes: form.notes.trim() || null, damage_found: form.damage_found, damage_description: form.damage_found ? damageDescription : null, estimated_damage_cost: estimatedCost, actual_damage_cost: actualCost, status: editing?.status || "Completed", updated_at: new Date().toISOString() };
      let result;
      if (editing) {
        let updateQuery = supabase.from("room_inspections").update(payload).eq("id", editing.id);
        updateQuery = editing.status ? updateQuery.eq("status", editing.status) : updateQuery.is("status", null);
        result = await updateQuery.select("*").single();
      } else {
        result = await supabase.from("room_inspections").insert({ ...payload, inspection_number: `INS-${new Date().getFullYear()}-${Date.now().toString().slice(-7)}` }).select("*").single();
      }
      if (result.error || !result.data) throw new Error("DATABASE");
      const saved = result.data as Inspection;
      let before = photoList(saved.before_photos); let after = photoList(saved.after_photos); let evidence = photoList(saved.photos);
      try { before = [...before, ...(await upload(beforeFiles, saved.id, admissionId, form.inspection_type, "before"))]; after = [...after, ...(await upload(afterFiles, saved.id, admissionId, form.inspection_type, "after"))]; evidence = [...evidence, ...(await upload(evidenceFiles, saved.id, admissionId, form.inspection_type, "evidence"))]; }
      catch { setError("The inspection was saved, but one or more photos could not be uploaded. Please edit the inspection and try again."); await refresh(); return; }
      if (beforeFiles.length || afterFiles.length || evidenceFiles.length) {
        const linked = await supabase.from("room_inspections").update({ before_photos: before, after_photos: after, photos: evidence, updated_at: new Date().toISOString() }).eq("id", saved.id);
        if (linked.error) { setError("The inspection and photos were saved, but the photo links could not be attached. Please refresh and try again."); await refresh(); return; }
      }
      setMessage(editing ? "Inspection updated successfully." : "Inspection recorded successfully."); reset(); setShowForm(false); await refresh();
    } catch (caught) {
      const code = caught instanceof Error ? caught.message : "";
      const messages: Record<string, string> = { REQUIRED: "Resident, admission, room, and inspection date are required.", RESIDENT: "The selected resident is no longer available for this inspection.", ADMISSION: "The selected admission, resident, and room no longer match.", ARCHIVED: "Archived inspections are permanent read-only history.", DAMAGE_DESCRIPTION: "Damage description is required when damage is found.", COST: "Estimated and actual damage costs must be valid non-negative amounts.", CHECK_IN_REQUIRED: "Create a Check In inspection for this admission before recording its Check Out inspection.", STALE: "This inspection no longer exists. Please refresh and try again.", PHOTO_UPLOAD: "One or more inspection photos could not be optimized or uploaded.", DATABASE: "The inspection could not be saved. Please review the form and try again." };
      setError(messages[code] || "The inspection could not be saved. Please try again.");
    } finally { setUploading(""); setSaving(false); }
  }

  async function archiveInspection(item: Inspection) {
    if (normalized(item.status) === "archived") return;
    if (!window.confirm("Archive this inspection? Its record and photos will remain preserved in history.")) return;
    setMessage(""); setError("");
    let archiveQuery = supabase.from("room_inspections").update({ status: "Archived", updated_at: new Date().toISOString() }).eq("id", item.id);
    archiveQuery = item.status ? archiveQuery.eq("status", item.status) : archiveQuery.is("status", null);
    const { data, error: archiveError } = await archiveQuery.select("id").maybeSingle();
    if (archiveError || !data) {
      setError(archiveError ? getSupabaseErrorMessage(archiveError, "Unable to archive this inspection.") : "The inspection changed before it could be archived. Refresh and try again.");
      await refresh();
      return;
    }
    if (editing?.id === item.id) { reset(); setShowForm(false); }
    setMessage("Inspection archived. Its history and photos were preserved.");
    await refresh();
  }

  return <main className="min-h-screen bg-slate-50 p-4 sm:p-6 lg:p-8"><div className="mx-auto max-w-7xl space-y-6">
    <section className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-6"><div><p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-600">University Girls Hostel</p><h1 className="mt-2 text-2xl font-bold text-slate-900 sm:text-3xl">Room Inspections</h1><p className="mt-1 text-sm text-slate-500">Record room condition, damage, costs, and inspection photos.</p></div><button type="button" onClick={() => { reset(); setShowForm(true); setError(""); setMessage(""); }} className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white">+ New Inspection</button></section>
    {(message || error) && <section className={`rounded-2xl border px-4 py-3 text-sm font-medium ${error ? "border-red-200 bg-red-50 text-red-700" : "border-emerald-200 bg-emerald-50 text-emerald-700"}`}>{error || message}</section>}
    {showForm && <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"><div className="flex items-center justify-between gap-3"><h2 className="text-xl font-bold">{editing ? "Edit Inspection" : "New Inspection"}</h2><button type="button" onClick={() => { reset(); setShowForm(false); }} className="rounded-lg border px-3 py-2 text-sm">Close</button></div><form onSubmit={save} className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <Field label="Resident *"><select required disabled={Boolean(editing)} value={form.resident_id} onChange={(e) => setForm({ ...form, resident_id: e.target.value, admission_id: "", room_id: "" })} className={inputClass}><option value="">Select resident</option>{(editing && residents.find((r) => text(r.id) === form.resident_id) ? residents.filter((r) => text(r.id) === form.resident_id || normalized(r.status) !== "archived") : selectableResidents).map((r) => <option key={text(r.id)} value={text(r.id)}>{display(r, ["full_name"])}</option>)}</select></Field>
      <Field label="Admission *"><select required disabled={Boolean(editing)} value={form.admission_id} onChange={(e) => { const a = admissions.find((row) => text(row.id) === e.target.value); setForm({ ...form, admission_id: e.target.value, room_id: text(a?.room_id) }); }} className={inputClass}><option value="">Select admission</option>{(editing && admissions.find((a) => text(a.id) === form.admission_id) ? admissions.filter((a) => text(a.id) === form.admission_id || (text(a.resident_id) === form.resident_id && !["cancelled", "archived"].includes(normalized(a.status)))) : residentAdmissions).map((a) => <option key={text(a.id)} value={text(a.id)}>{display(a, ["admission_number"], text(a.id))} · {display(rooms.find((r) => text(r.id) === text(a.room_id)), ["room_number"])}</option>)}</select></Field>
      <Field label="Room *"><select required disabled value={form.room_id} className={inputClass}><option value="">Selected from admission</option>{rooms.map((r) => <option key={text(r.id)} value={text(r.id)}>{display(r, ["room_number"])}</option>)}</select></Field>
      <Field label="Inspection Date *"><input required type="date" value={form.inspection_date} onChange={(e) => setForm({ ...form, inspection_date: e.target.value })} className={inputClass}/></Field>
      <Field label="Inspection Type *"><select required disabled={Boolean(editing)} value={form.inspection_type} onChange={(e) => setForm({ ...form, inspection_type: e.target.value as FormState["inspection_type"] })} className={inputClass}><option value="Check In">Check In / Pre-admission</option><option value="Check Out">Check Out / Post-admission</option></select></Field>
      <Field label="Inspector"><input value={form.inspector_name} onChange={(e) => setForm({ ...form, inspector_name: e.target.value })} className={inputClass}/></Field>
      {(["cleanliness", "electrical_status", "plumbing_status", "furniture_condition", "wall_floor_status", "overall_status"] as const).map((key) => <Field key={key} label={key.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase())}><input value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} className={inputClass}/></Field>)}
      <Field label="Damage Found"><select value={form.damage_found ? "Yes" : "No"} onChange={(e) => { const damageFound = e.target.value === "Yes"; setForm({ ...form, damage_found: damageFound, damage_description: damageFound ? form.damage_description : "", estimated_damage_cost: damageFound ? form.estimated_damage_cost : "0", actual_damage_cost: damageFound ? form.actual_damage_cost : "0" }); }} className={inputClass}><option>No</option><option>Yes</option></select></Field>
      <Field label="Estimated Damage Cost"><input type="number" min="0" value={form.estimated_damage_cost} onChange={(e) => setForm({ ...form, estimated_damage_cost: e.target.value })} disabled={!form.damage_found} className={inputClass}/></Field>
      <Field label="Actual Damage Cost"><input type="number" min="0" value={form.actual_damage_cost} onChange={(e) => setForm({ ...form, actual_damage_cost: e.target.value })} disabled={!form.damage_found} className={inputClass}/></Field>
      {(form.inspection_type === "Check In" || editing) && <Field label="Before / Check-in Photos"><input type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={(e) => chooseFiles(e, "before")} className={inputClass}/></Field>}
      {(form.inspection_type === "Check Out" || editing) && <Field label="After / Check-out Photos"><input type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={(e) => chooseFiles(e, "after")} className={inputClass}/></Field>}
      <Field label="Additional Evidence Photos"><input type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={(e) => chooseFiles(e, "evidence")} className={inputClass}/></Field>
      <Field label="Damage Description" wide><textarea required={form.damage_found} value={form.damage_description} onChange={(e) => setForm({ ...form, damage_description: e.target.value })} disabled={!form.damage_found} className={`${inputClass} min-h-24`}/></Field>
      <Field label="Notes" wide><textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className={`${inputClass} min-h-24`}/></Field>
      {editing && <div className="md:col-span-2 xl:col-span-3"><PrivateStorageLinks title="Existing before photos" bucket={INSPECTION_PHOTO_BUCKET} references={photoUrls(editing.before_photos)}/><PrivateStorageLinks title="Existing after photos" bucket={INSPECTION_PHOTO_BUCKET} references={photoUrls(editing.after_photos)}/><PrivateStorageLinks title="Existing evidence photos" bucket={INSPECTION_PHOTO_BUCKET} references={photoUrls(editing.photos)}/></div>}
      <div className="md:col-span-2 xl:col-span-3"><button disabled={saving} className="w-full rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white disabled:opacity-60 sm:w-auto">{uploading || (saving ? "Saving..." : editing ? "Update Inspection" : "Save Inspection")}</button></div>
    </form></section>}
    <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6 print:hidden">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search inspections" className={inputClass}/>
        <select value={residentFilter} onChange={(event) => setResidentFilter(event.target.value)} className={inputClass}><option value="All">All Residents</option>{residents.map((resident) => <option key={text(resident.id)} value={text(resident.id)}>{display(resident, ["full_name"])}</option>)}</select>
        <select value={roomFilter} onChange={(event) => setRoomFilter(event.target.value)} className={inputClass}><option value="All">All Rooms</option>{rooms.map((room) => <option key={text(room.id)} value={text(room.id)}>{display(room, ["room_number"])}</option>)}</select>
        <input type="date" value={dateFilter} onChange={(event) => setDateFilter(event.target.value)} className={inputClass}/>
        <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} className={inputClass}><option value="All">All Types</option><option value="Check In">Check In</option><option value="Check Out">Check Out</option></select>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className={inputClass}><option value="Current">Current</option><option value="All">All Statuses</option>{Array.from(new Set(inspections.map((item) => item.status).filter(Boolean))).map((status) => <option key={status!} value={status!}>{status}</option>)}</select>
      </div>
      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[1050px] text-left">
          <thead><tr className="border-b text-xs uppercase text-slate-500">{["Inspection", "Resident", "Room / Bed", "Date / Type", "Damage", "Photos", "Status", "Actions"].map((heading) => <th key={heading} className="px-4 py-3">{heading}</th>)}</tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={8} className="p-8 text-center">Loading inspections...</td></tr> : filtered.length === 0 ? <tr><td colSpan={8} className="p-8 text-center text-slate-500">No inspections found.</td></tr> : filtered.map((item) => {
              const resident = residents.find((row) => text(row.id) === item.resident_id);
              const room = rooms.find((row) => text(row.id) === item.room_id);
              const bed = beds.find((row) => text(row.id) === item.bed_id);
              const archived = normalized(item.status) === "archived";
              return <tr key={item.id} className="border-b border-slate-100">
                <td className="px-4 py-4 font-semibold">{item.inspection_number || item.id}</td>
                <td className="px-4 py-4">{display(resident, ["full_name"])}</td>
                <td className="px-4 py-4">Room {display(room, ["room_number"])}<div className="text-xs text-slate-500">{bed ? normalizeBedLabel(display(bed, ["bed_number"], "")) : "—"}</div></td>
                <td className="px-4 py-4">{item.inspection_date}<div className="text-xs text-slate-500">{item.inspection_type || "—"}</div></td>
                <td className="px-4 py-4">{item.damage_found ? <><span className="font-semibold text-red-700">Damage found</span><div className="text-xs text-slate-500">Est. Rs {Number(item.estimated_damage_cost || 0).toLocaleString()} · Actual Rs {Number(item.actual_damage_cost || 0).toLocaleString()}</div></> : "No damage"}</td>
                <td className="px-4 py-4">{photoList(item.before_photos).length + photoList(item.after_photos).length + photoList(item.photos).length}</td>
                <td className="px-4 py-4"><span className={`rounded-full px-3 py-1 text-xs font-bold ${archived ? "bg-slate-200 text-slate-700" : "bg-emerald-100 text-emerald-700"}`}>{item.status || "Completed"}</span></td>
                <td className="px-4 py-4"><div className="flex flex-wrap gap-2"><Link href={`/inspection/${item.id}`} className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold">View</Link>{!archived && <><button type="button" onClick={() => openEdit(item)} className="rounded-lg border border-indigo-200 px-3 py-2 text-xs font-semibold text-indigo-700">Edit</button><button type="button" onClick={() => void archiveInspection(item)} className="rounded-lg border border-amber-200 px-3 py-2 text-xs font-semibold text-amber-700">Archive</button></>}</div></td>
              </tr>;
            })}
          </tbody>
        </table>
      </div>
    </section>
    {legacy.length > 0 && <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm print:hidden"><h2 className="text-xl font-bold">Legacy Inspection History</h2><p className="mt-1 text-sm text-slate-500">Preserved read-only records from the earlier inspection workflow.</p><div className="mt-4 space-y-3">{legacy.map((item) => <article key={item.id} className="rounded-2xl border border-slate-200 p-4 text-sm"><strong>{item.inspection_date}</strong> · {display(residents.find((r) => text(r.id) === item.resident_id), ["full_name"])} · Room {display(rooms.find((r) => text(r.id) === item.room_id), ["room_number"])}{item.damage_notes && <p className="mt-2 text-slate-600">{item.damage_notes}</p>}<PrivateStorageLinks title="Photos" bucket={INSPECTION_PHOTO_BUCKET} references={[item.before_photo, item.after_photo].filter((url): url is string => Boolean(url))}/></article>)}</div></section>}
  </div></main>;
}

function Field({ label, wide = false, children }: { label: string; wide?: boolean; children: React.ReactNode }) { return <label className={wide ? "md:col-span-2 xl:col-span-3" : ""}><span className="mb-2 block text-sm font-semibold capitalize text-slate-700">{label}</span>{children}</label>; }
