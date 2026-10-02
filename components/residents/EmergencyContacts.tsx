"use client";
import { contactRelationships, type EmergencyContact } from "@/lib/residentProfile";

export default function EmergencyContacts({ contacts, onChange, readOnly = false }: {
  contacts: EmergencyContact[]; onChange?: (contacts: EmergencyContact[]) => void; readOnly?: boolean;
}) {
  function change(index: number, key: keyof EmergencyContact, value: string) {
    onChange?.(contacts.map((contact, i) => i === index ? { ...contact, [key]: value } : contact));
  }
  return <div className="space-y-3">
    {contacts.map((contact, i) => <div key={contact.id || i} className="grid gap-3 rounded-xl border border-slate-200 p-3 sm:grid-cols-3">
      <label className="text-sm">Contact Name<input aria-label={`Contact ${i + 1} name`} disabled={readOnly} className="mt-1 w-full rounded-lg border p-2 disabled:bg-slate-100" value={contact.contact_name} maxLength={200} onChange={e => change(i, "contact_name", e.target.value)} /></label>
      <label className="text-sm">Relationship<select aria-label={`Contact ${i + 1} relationship`} disabled={readOnly} className="mt-1 w-full rounded-lg border p-2 disabled:bg-slate-100" value={contact.relationship} onChange={e => change(i, "relationship", e.target.value)}>
        <option value="">Select relationship</option>
        {contact.relationship && !contactRelationships.includes(contact.relationship) && <option>{contact.relationship}</option>}
        {contactRelationships.map(value => <option key={value}>{value}</option>)}
      </select></label>
      <label className="text-sm">Phone Number<input aria-label={`Contact ${i + 1} phone`} disabled={readOnly} className="mt-1 w-full rounded-lg border p-2 disabled:bg-slate-100" value={contact.phone} maxLength={50} onChange={e => change(i, "phone", e.target.value)} /></label>
      {!readOnly && !contact.id && <button type="button" className="text-left text-sm text-red-700" onClick={() => onChange?.(contacts.filter((_, n) => n !== i))}>Remove unsaved contact</button>}
    </div>)}
    {!readOnly && contacts.length < 20 && <button type="button" className="rounded-lg border px-4 py-2 text-sm font-semibold" onClick={() => onChange?.([...contacts, { contact_name: "", relationship: "", phone: "" }])}>+ Add Another Emergency Contact</button>}
    {readOnly && contacts.length === 0 && <p className="text-sm text-slate-500">No additional contacts recorded.</p>}
  </div>;
}
