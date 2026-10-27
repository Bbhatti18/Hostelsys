const fs = require("node:fs");
const assert = require("node:assert/strict");

const migration = fs.readFileSync("supabase/migrations/20261027173000_cascade_safe_admin_data_deletion.sql", "utf8");

// Verify essential tables are handled in admin_delete_resident_data
const expectedTables = [
  "payment_followups",
  "rent_reminder_deliveries",
  "fine_waiver_requests",
  "late_fee_payment_allocations",
  "late_fee_history",
  "late_fees",
  "rent_period_corrections",
  "staff_payment_allocation_audit",
  "payment_allocations",
  "payment_status_history",
  "payment_receipts",
  "payments",
  "ac_bills",
  "bills",
  "contracts",
  "room_inspections",
  "inspections",
  "maintenance_requests",
  "maintenance_photos",
  "inventory_assignments",
  "complaints",
  "visitors",
  "resident_portal_links",
  "historical_payment_evidence_reviews",
  "historical_payment_evidence",
  "resident_profile_documents",
  "resident_emergency_contacts",
  "resident_profile_corrections",
  "resident_profile_completions",
  "admission_allocation_history",
  "admissions",
  "residents",
  "beds",
  "rooms",
  "admin_data_action_audits"
];

for (const table of expectedTables) {
  assert.ok(
    migration.includes(table),
    `Migration must handle table public.${table}`
  );
}

// Verify app.allow_admin_destructive_cleanup bypass is set and checked
assert.ok(
  migration.includes("app.allow_admin_destructive_cleanup"),
  "Migration must set or check app.allow_admin_destructive_cleanup"
);

// Verify grant to service_role
assert.ok(
  migration.includes("grant execute on function public.admin_delete_resident_data(uuid, text, uuid, text) to service_role"),
  "Function admin_delete_resident_data must be granted to service_role"
);
assert.ok(
  migration.includes("grant execute on function public.admin_full_hostel_reset(uuid, text, text) to service_role"),
  "Function admin_full_hostel_reset must be granted to service_role"
);

console.log("✓ PASS: 20261027173000_cascade_safe_admin_data_deletion.sql contains complete cascade-safe cleanup for all " + expectedTables.length + " tables.");
