import { buildRoomOccupancy, type OccupancyAdmission } from "./roomOccupancy";

// UX projection only. The RPC must revalidate the actual allocation under locks.
export function reallocationDestinations<R extends { id: string; status: string | null }, B extends {
  id: string; room_id: string; status: string | null;
}>(rooms: R[], beds: B[], current: OccupancyAdmission[], admission: OccupancyAdmission, mode: string) {
  const other = current.filter(a => a.id !== admission.id && ["Pending", "Active"].includes(a.status ?? ""));
  const inventory = beds.map(b => b.id === admission.bed_id && b.status === "Occupied" ? { ...b, status: "Vacant" } : b);
  return rooms.map(room => {
    const occupancy = buildRoomOccupancy(room, inventory, other);
    const options = occupancy.beds.filter(b => b.assignable && !(mode === "single_bed" &&
      (admission.allocation_mode ?? "single_bed") === "single_bed" && room.id === admission.room_id && b.id === admission.bed_id));
    return { ...room, beds: options };
  }).filter(room => room.beds.length > 0 && (mode !== "whole_room" || (
    !(admission.allocation_mode === "whole_room" && room.id === admission.room_id) &&
    !other.some(a => a.room_id === room.id)
  )));
}
