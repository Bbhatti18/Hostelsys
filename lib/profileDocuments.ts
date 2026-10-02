export const documentSlots = ["photo", "resident_front", "resident_back", "guardian_front", "guardian_back"] as const;
export type DocumentSlot = typeof documentSlots[number];
export const documentLabels: Record<DocumentSlot, string> = {
  photo: "Resident Profile Photo", resident_front: "Resident CNIC Front / Passport Identity Page",
  resident_back: "Resident CNIC Back", guardian_front: "Guardian CNIC Front / Passport Identity Page", guardian_back: "Guardian CNIC Back",
};
export function documentLabel(slot: DocumentSlot, residentType = "CNIC", guardianType = "CNIC") {
  if (slot === "resident_front") return residentType === "Passport" ? "Resident Passport Identity Page" : "Resident CNIC Front";
  if (slot === "guardian_front") return guardianType === "Passport" ? "Guardian Passport Identity Page" : "Guardian CNIC Front";
  return documentLabels[slot];
}
export function documentSlotsForIdentityType(slots: readonly DocumentSlot[], residentType = "CNIC", guardianType = "CNIC") {
  return slots.filter(slot =>
    !(slot === "resident_back" && residentType === "Passport") &&
    !(slot === "guardian_back" && guardianType === "Passport"),
  );
}
export const MAX_PROFILE_DOCUMENT_BYTES = 4 * 1024 * 1024;
export function profileDocumentError(slot: string, type: string, size: number, bytes?: Uint8Array) {
  if (!documentSlots.includes(slot as DocumentSlot)) return "Unknown document type.";
  if (size <= 0 || size > MAX_PROFILE_DOCUMENT_BYTES) return "Each file must be no larger than 4 MB.";
  if (!["image/jpeg", "image/png", "image/webp", ...(slot === "photo" ? [] : ["application/pdf"])].includes(type)) return "Use JPEG, PNG or WebP; identity documents also accept PDF.";
  if (bytes) {
    const prefix = (values: number[]) => values.every((value, index) => bytes[index] === value);
    const valid = type === "image/jpeg" ? prefix([255,216,255]) : type === "image/png" ? prefix([137,80,78,71,13,10,26,10]) : type === "application/pdf" ? prefix([37,80,68,70,45]) : prefix([82,73,70,70]) && String.fromCharCode(...bytes.slice(8,12)) === "WEBP";
    if (!valid) return "File content does not match its declared type.";
  }
  return null;
}
