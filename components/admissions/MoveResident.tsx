"use client";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { type OccupancyAdmission } from "@/lib/roomOccupancy";
import { reallocationDestinations } from "@/lib/reallocationDestinations";

type Room = { id: string; room_number: string; status: string };
type Bed = { id: string; room_id: string; bed_number: string; status: string };
export default function MoveResident({ admission, residentName, onClose, onSaved }: {
  admission: OccupancyAdmission; residentName: string; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [rooms, setRooms] = useState<Room[]>([]), [beds, setBeds] = useState<Bed[]>([]);
  const [current, setCurrent] = useState<OccupancyAdmission[]>([]);
  const [mode, setMode] = useState("single_bed"), [roomId, setRoomId] = useState(""), [bedId, setBedId] = useState("");
  const [reason, setReason] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => { void (async () => {
    const [r,b,a] = await Promise.all([supabase.from("rooms").select("id,room_number,status"),
      supabase.from("beds").select("id,room_id,bed_number,status"),
      supabase.from("admissions").select("id,resident_id,room_id,bed_id,allocation_mode,status").in("status",["Pending","Active"])]);
    if (r.error || b.error || a.error) { setError("Unable to verify destination inventory. Close and retry."); return; }
    setRooms(r.data || []); setBeds(b.data || []); setCurrent(a.data || []);
  })(); }, []);
  const eligible = reallocationDestinations(rooms, beds, current, admission, mode);
  const destination = eligible.find(r => r.id === roomId);
  const canMove = !!destination && (mode === "whole_room" || destination.beds.some(b => b.id === bedId));
  async function save() {
    if (busy || !canMove || !destination) return;
    if (!window.confirm(`Move ${residentName} to Room ${destination.room_number}${mode === "whole_room" ? " (Whole Room)" : ` / ${beds.find(b => b.id === bedId)?.bed_number}`}? The same admission and financial history will be retained.`)) return;
    setBusy(true); setError("");
    try {
      const result = await supabase.rpc("reallocate_admission", { p_admission_id: admission.id, p_room_id: roomId,
        p_bed_id: mode === "whole_room" ? null : bedId, p_allocation_mode: mode, p_reason: reason });
      if (result.error) throw result.error;
      // Cross-tab refresh is best effort; blocked browser storage cannot undo a committed move.
      try { window.localStorage.setItem("admission-allocation-changed", String(Date.now())); } catch { /* Focus/navigation still reload inventory. */ }
      window.dispatchEvent(new Event("admission-allocation-changed"));
      await onSaved();
    } catch (e) { setError(e && typeof e === "object" && "message" in e ? String(e.message) : "Move failed. Refresh and retry."); }
    finally { setBusy(false); }
  }
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label="Move Resident">
    <div className="w-full max-w-lg space-y-4 rounded-2xl bg-white p-6">
      <h2 className="text-xl font-bold">Move Resident</h2><p>{residentName}</p>
      <p className="text-sm">Current: Room {rooms.find(r => r.id === admission.room_id)?.room_number} / {beds.find(b => b.id === admission.bed_id)?.bed_number} / {admission.allocation_mode === "whole_room" ? "Whole Room" : "Single Bed"}</p>
      {error && <p role="alert" className="text-red-700">{error}</p>}
      <fieldset disabled={busy} className="space-y-4">
        <label className="block">Destination allocation type<select className="block w-full rounded border p-2" value={mode} onChange={e => { setMode(e.target.value); setRoomId(""); setBedId(""); }}><option value="single_bed">Single Bed</option><option value="whole_room">Whole Room (Exclusive)</option></select></label>
        <label className="block">Destination room<select className="block w-full rounded border p-2" value={roomId} onChange={e => { setRoomId(e.target.value); setBedId(""); }}><option value="">Select room</option>{eligible.map(r => <option key={r.id} value={r.id}>{r.room_number}</option>)}</select></label>
        {mode === "single_bed" ? <label className="block">Destination bed<select className="block w-full rounded border p-2" value={bedId} onChange={e => setBedId(e.target.value)}><option value="">Select bed</option>{destination?.beds.filter(b => b.assignable).map(b => <option key={b.id} value={b.id}>{b.bed_number}</option>)}</select></label> : <p className="text-sm">The server chooses the primary bed. All other active beds are reserved exclusively.</p>}
        <label className="block">Reason / notes (optional)<textarea className="block w-full rounded border p-2" value={reason} onChange={e => setReason(e.target.value)} /></label>
        <div className="flex gap-3"><button type="button" onClick={onClose}>Cancel</button><button type="button" className="rounded bg-indigo-600 px-4 py-2 text-white disabled:opacity-50" disabled={!canMove || busy} onClick={() => void save()}>{busy ? "Moving..." : "Confirm Move"}</button></div>
      </fieldset>
    </div>
  </div>;
}
