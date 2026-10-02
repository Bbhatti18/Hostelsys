"use client";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { EmergencyContact } from "@/lib/residentProfile";
import EmergencyContacts from "./EmergencyContacts";

export default function StaffProfileContacts({ residentId, statusOnly = false }: { residentId: string; statusOnly?: boolean }) {
  const [contacts, setContacts] = useState<EmergencyContact[]>([]);
  const [status, setStatus] = useState("Loading...");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.all([
      supabase.from("resident_emergency_contacts").select("id,contact_name,relationship,phone").eq("resident_id", residentId).order("created_at"),
      supabase.from("resident_profile_completions").select("submitted_at").eq("resident_id", residentId).maybeSingle(),
    ]).then(([contactsResult, completion]) => {
      if (!active) return;
      if (contactsResult.error || completion.error) { setError("Unable to load profile contacts/status."); return; }
      setContacts(contactsResult.data || []); setStatus(completion.data?.submitted_at ? "Submitted / Locked" : "Incomplete");
    });
    return () => { active = false; };
  }, [residentId]);
  return <div className="space-y-3"><p className="font-semibold">Profile completion: {status}</p>{error && <p role="alert" className="text-red-700">{error}</p>}{!statusOnly && <><h3 className="font-semibold">Additional Emergency Contacts</h3><EmergencyContacts contacts={contacts} readOnly /></>}</div>;
}
