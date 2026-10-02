export const profileFields = [
  ["cnic", "Resident CNIC / Passport"], ["dob", "Date of Birth"], ["gender", "Gender"],
  ["permanent_address", "Permanent Address"], ["city", "City"], ["nationality", "Nationality"],
  ["occupation", "Occupation"], ["company_university", "Company / University"],
  ["father_name", "Guardian Name"], ["guardian_cnic", "Guardian CNIC / Passport"], ["guardian_phone", "Guardian Phone"],
] as const;
export const contactRelationships = ["Father", "Mother", "Brother", "Sister", "Guardian", "Spouse", "Uncle", "Aunt", "Other"];
export type EmergencyContact = { id?: string; contact_name: string; relationship: string; phone: string };
export function legacyEmergencyContact(resident: Record<string, unknown>): EmergencyContact[] {
  const contact = { contact_name: String(resident.emergency_contact_name || ""), relationship: String(resident.emergency_contact_relationship || ""), phone: String(resident.emergency_contact || "") };
  return Object.values(contact).some(Boolean) ? [contact] : [];
}
