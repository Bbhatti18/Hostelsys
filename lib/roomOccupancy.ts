import { isAllocatableBedStatus, isOperationalBedStatus } from "./statuses";

type Room = { id: string; status: string | null };
type Bed = { id: string; room_id: string; status: string | null };
export type OccupancyAdmission = {
  id: string; room_id: string | null; bed_id: string | null;
  resident_id: string; status: string | null; allocation_mode?: string | null;
};

// Same current-admission lifecycle as Admissions and bed provisioning. Pending
// admissions reserve their assigned bed immediately, even before activation.
export function currentBedAssignments(beds: Bed[], admissions: OccupancyAdmission[]) {
  const byId = new Map(beds.map(bed => [bed.id, bed]));
  const assignments = new Map<string, OccupancyAdmission>();
  for (const admission of admissions) {
    const bed = admission.bed_id ? byId.get(admission.bed_id) : undefined;
    if (bed && isOperationalBedStatus(bed.status) && admission.resident_id &&
        admission.room_id === bed.room_id && ["Active", "Pending"].includes(admission.status ?? "")) {
      // Duplicate join rows or conflicting assignments cannot count a bed twice.
      assignments.set(bed.id, admission);
    }
  }
  return assignments;
}

export function buildRoomOccupancy<T extends Bed>(room: Room, beds: T[], admissions: OccupancyAdmission[]) {
  const assignments = currentBedAssignments(beds, admissions);
  const operational = ["Available", "Occupied", "Partially Occupied"].includes(room.status ?? "");
  const exclusive = admissions.some(admission => admission.room_id === room.id && admission.resident_id &&
    ["Active", "Pending"].includes(admission.status ?? "") && admission.allocation_mode === "whole_room");
  const roomBeds = [...new Map(beds.filter(b => b.room_id === room.id).map(b => [b.id, b])).values()]
    .map(bed => {
      const active = isOperationalBedStatus(bed.status);
      const occupied = active && assignments.has(bed.id);
      const blockedByExclusive = active && exclusive && !occupied;
      const vacant = active && !occupied && isAllocatableBedStatus(bed.status);
      return { ...bed, active, occupied, blockedByExclusive, assignable: operational && vacant && !exclusive,
        displayStatus: !active ? bed.status || "Unavailable" : occupied ? "Occupied" : blockedByExclusive ? "Blocked by Whole-Room Allocation" : vacant ? "Vacant" : "Unassigned (review)" };
    });
  const capacity = roomBeds.filter(b => b.active).length;
  const occupied = roomBeds.filter(b => b.occupied).length;
  const available = roomBeds.filter(b => b.assignable).length;
  const blocked = roomBeds.filter(b => b.blockedByExclusive).length;
  // Administrative restrictions win over occupancy, including Archived if read
  // from legacy data. Zero configured active beds never offers an assignable bed.
  const status = !operational ? room.status || "Unavailable" : exclusive ? "Exclusively Occupied" : occupied === 0 ? "Available" :
    occupied === capacity ? "Fully Occupied" : "Partially Occupied";
  return { id: room.id, status, capacity, occupied, blocked, unavailable: capacity - available, available, exclusive, beds: roomBeds };
}

export function summarizeBedInventory<R extends Room, B extends Bed>(rooms: R[], beds: B[], admissions: OccupancyAdmission[]) {
  const occupancy = rooms.map(room => buildRoomOccupancy(room, beds, admissions));
  return {
    total: beds.length,
    active: occupancy.reduce((sum, room) => sum + room.capacity, 0),
    occupied: occupancy.reduce((sum, room) => sum + room.occupied, 0),
    bookable: occupancy.reduce((sum, room) => sum + room.available, 0),
    blocked: occupancy.reduce((sum, room) => sum + room.blocked, 0),
    unavailable: occupancy.reduce((sum, room) => sum + room.unavailable, 0),
  };
}

type Occupancy = ReturnType<typeof buildRoomOccupancy>;
export function matchesRoomStatus(room: Pick<Occupancy, "status">, filter: string) {
  return filter === "All" || room.status === filter;
}

export function summarizeRoomOccupancy(rooms: Occupancy[]) {
  const scoped = rooms.filter(room => room.status !== "Archived");
  // Available means assignable capacity, not an entirely empty room. Counts
  // intentionally overlap for partially occupied operational rooms.
  return {
    total: scoped.length,
    available: scoped.filter(room => room.available > 0).length,
    occupied: scoped.filter(room => room.occupied > 0).length,
    exclusive: scoped.filter(room => room.exclusive).length,
    blocked: scoped.reduce((sum, room) => sum + room.blocked, 0),
    maintenance: scoped.filter(room => room.status === "Maintenance").length,
  };
}
