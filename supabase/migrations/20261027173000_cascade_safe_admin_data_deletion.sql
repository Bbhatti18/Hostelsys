-- Migration: 20261027173000_cascade_safe_admin_data_deletion.sql
-- Purpose: Support complete, cascade-safe administrative resident deletion and full hostel reset
--          accounting for tables created in recent migrations:
--          payment_followups, rent_period_corrections, staff_payment_allocation_audit,
--          admission_allocation_history, late_fees, late_fee_payment_allocations, late_fee_history,
--          fine_waiver_requests, rent_reminder_deliveries, resident_profile_documents,
--          resident_profile_completions, resident_emergency_contacts, resident_profile_corrections,
--          historical_payment_evidence, historical_payment_evidence_reviews,
--          and clearing bills.additional_receipt_id.

begin;

-- 1. Allow the immutable triggers on rent_period_corrections and staff_payment_allocation_audit
--    to be safely bypassed only when app.allow_admin_destructive_cleanup is explicitly turned 'on'
--    within the administrative transaction.
create or replace function public.protect_rent_period_correction()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if current_setting('app.allow_admin_destructive_cleanup', true) = 'on' then
    return old;
  end if;
  raise exception 'Rent period correction audit is immutable.';
end;
$$;

revoke all on function public.protect_rent_period_correction() from public, anon, authenticated, service_role;

-- 2. Complete cascade-safe resident deletion function
create or replace function public.admin_delete_resident_data(
  p_admin_user_id uuid,
  p_admin_email text,
  p_resident_id uuid,
  p_resident_name_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_admin_staff_id uuid;
  v_resident_name text;
  v_counts jsonb := '{}'::jsonb;
  v_count bigint;
  v_bed_ids uuid[];
  v_room_ids uuid[];
  v_admission_ids uuid[];
begin
  -- Verification: Admin check
  select id into v_admin_staff_id
  from public.staff_users
  where lower(email) = lower(trim(p_admin_email))
    and lower(coalesce(status, '')) = 'active'
    and lower(coalesce(role, '')) in ('admin', 'super admin')
  limit 1;

  if v_admin_staff_id is null then
    raise exception 'Administrator permission is required.' using errcode = '42501';
  end if;

  -- Verification: Resident exists and lock row
  select full_name into v_resident_name
  from public.residents
  where id = p_resident_id
  for update;

  if v_resident_name is null then
    raise exception 'Resident not found.' using errcode = 'P0002';
  end if;

  -- Verification: Full name confirmation match
  if lower(trim(p_resident_name_confirmation)) is distinct from lower(trim(v_resident_name)) then
    raise exception 'Resident name confirmation does not match.' using errcode = '22023';
  end if;

  -- Inventory guard: Inventory needs explicit return/disposal; deletion must not silently lose stock.
  if exists (select 1 from public.inventory_assignments where resident_id = p_resident_id) then
    raise exception 'Return or reassign resident inventory before deleting the resident.' using errcode = '23503';
  end if;

  -- Enable transaction-local override for immutable triggers
  perform set_config('app.allow_admin_destructive_cleanup', 'on', true);

  -- Fetch associated admissions, beds, rooms
  select coalesce(array_agg(id), '{}'::uuid[]) into v_admission_ids
  from public.admissions where resident_id = p_resident_id;

  select array_remove(array_agg(distinct bed_id), null),
         array_remove(array_agg(distinct room_id), null)
    into v_bed_ids, v_room_ids
  from public.admissions
  where resident_id = p_resident_id;

  -- Notifications & Notices
  delete from public.notification_deliveries where resident_id = p_resident_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('notification_deliveries', v_count);

  delete from public.notice_recipients where resident_id = p_resident_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('notice_recipients', v_count);

  delete from public.notice_recipients
  where notice_id in (select id from public.notices where resident_id = p_resident_id);
  get diagnostics v_count = row_count;
  v_counts := jsonb_set(v_counts, '{notice_recipients}', to_jsonb(coalesce((v_counts ->> 'notice_recipients')::bigint, 0) + v_count));

  delete from public.notices where resident_id = p_resident_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('notices', v_count);

  -- Maintenance
  delete from public.maintenance_photos
  where maintenance_request_id in (
    select id from public.maintenance_requests where resident_id = p_resident_id or admission_id = any(v_admission_ids)
  );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('maintenance_photos', v_count);

  delete from public.maintenance_requests where resident_id = p_resident_id or admission_id = any(v_admission_ids);
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('maintenance_requests', v_count);

  -- Payment Followups & Rent Reminders (Must be cleared before payment_receipts and bills)
  delete from public.payment_followups
  where bill_id in (select id from public.bills where resident_id = p_resident_id)
     or receipt_id in (select id from public.payment_receipts where resident_id = p_resident_id);
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('payment_followups', v_count);

  delete from public.rent_reminder_deliveries
  where resident_id = p_resident_id
     or bill_id in (select id from public.bills where resident_id = p_resident_id);
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('rent_reminder_deliveries', v_count);

  -- Fine Waivers & Late Fees (Must be cleared before payment_receipts, payments, and bills)
  delete from public.fine_waiver_requests
  where resident_id = p_resident_id
     or bill_id in (select id from public.bills where resident_id = p_resident_id);
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('fine_waiver_requests', v_count);

  delete from public.late_fee_payment_allocations
  where payment_id in (select id from public.payments where resident_id = p_resident_id)
     or receipt_id in (select id from public.payment_receipts where resident_id = p_resident_id)
     or late_fee_id in (
       select lf.id from public.late_fees lf
       join public.bills b on b.id = lf.bill_id
       where b.resident_id = p_resident_id
     );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('late_fee_payment_allocations', v_count);

  delete from public.late_fee_history
  where payment_id in (select id from public.payments where resident_id = p_resident_id)
     or receipt_id in (select id from public.payment_receipts where resident_id = p_resident_id)
     or late_fee_id in (
       select lf.id from public.late_fees lf
       join public.bills b on b.id = lf.bill_id
       where b.resident_id = p_resident_id
     );
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('late_fee_history', v_count);

  delete from public.late_fees
  where bill_id in (select id from public.bills where resident_id = p_resident_id)
     or freeze_receipt_id in (select id from public.payment_receipts where resident_id = p_resident_id)
     or freeze_payment_id in (select id from public.payments where resident_id = p_resident_id);
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('late_fees', v_count);

  -- Rent Period Corrections & Staff Allocation Audits
  delete from public.rent_period_corrections
  where resident_id = p_resident_id
     or admission_id = any(v_admission_ids);
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('rent_period_corrections', v_count);

  delete from public.staff_payment_allocation_audit
  where resident_id = p_resident_id
     or admission_id = any(v_admission_ids);
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('staff_payment_allocation_audit', v_count);

  -- Disassociate cross-referencing foreign keys on bills and receipts
  update public.bills
  set additional_receipt_id = null
  where resident_id = p_resident_id and additional_receipt_id is not null;

  update public.payment_receipts
  set payment_id = null
  where resident_id = p_resident_id and payment_id is not null;

  delete from public.payment_allocations
  where payment_id in (select id from public.payments where resident_id = p_resident_id)
     or bill_id in (select id from public.bills where resident_id = p_resident_id);
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('payment_allocations', v_count);

  delete from public.payment_status_history
  where payment_id in (select id from public.payments where resident_id = p_resident_id);
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('payment_status_history', v_count);

  -- Payment Receipts & Payments
  delete from public.payment_receipts where resident_id = p_resident_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('payment_receipts', v_count);

  delete from public.payments where resident_id = p_resident_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('payments', v_count);

  -- AC Bills & Bills
  delete from public.ac_bills where resident_id = p_resident_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('ac_bills', v_count);

  delete from public.bills where resident_id = p_resident_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('bills', v_count);

  -- Contracts & Inspections
  delete from public.contracts where resident_id = p_resident_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('contracts', v_count);

  delete from public.room_inspections where resident_id = p_resident_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('room_inspections', v_count);

  delete from public.inspections where resident_id = p_resident_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('inspections', v_count);

  -- Operational Records
  delete from public.complaints where resident_id = p_resident_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('complaints', v_count);

  delete from public.visitors where resident_id = p_resident_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('visitors', v_count);

  delete from public.resident_portal_links where resident_id = p_resident_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('resident_portal_links', v_count);

  delete from public.inventory_assignments where resident_id = p_resident_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('inventory_assignments', v_count);

  -- Profile Extensions & Payment Evidence
  delete from public.historical_payment_evidence_reviews
  where evidence_id in (select id from public.historical_payment_evidence where resident_id = p_resident_id);
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('historical_payment_evidence_reviews', v_count);

  delete from public.historical_payment_evidence where resident_id = p_resident_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('historical_payment_evidence', v_count);

  delete from public.resident_profile_documents where resident_id = p_resident_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('resident_profile_documents', v_count);

  delete from public.resident_emergency_contacts where resident_id = p_resident_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('resident_emergency_contacts', v_count);

  delete from public.resident_profile_corrections where resident_id = p_resident_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('resident_profile_corrections', v_count);

  delete from public.resident_profile_completions where resident_id = p_resident_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('resident_profile_completions', v_count);

  -- Admission Allocation History & Admissions
  delete from public.admission_allocation_history
  where resident_id = p_resident_id
     or admission_id = any(v_admission_ids);
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('admission_allocation_history', v_count);

  delete from public.admissions where resident_id = p_resident_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('admissions', v_count);

  -- Resident Profile
  delete from public.residents where id = p_resident_id;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('residents', v_count);

  -- Release occupied beds if no other pending/active admission exists
  if coalesce(array_length(v_bed_ids, 1), 0) > 0 then
    update public.beds b
    set status = 'Vacant', updated_at = now()
    where b.id = any(v_bed_ids)
      and b.status <> 'Inactive'
      and not exists (
        select 1 from public.admissions a
        where a.bed_id = b.id
          and a.status in ('Pending', 'Active')
      );
  end if;

  -- Recompute room occupancy counts
  if coalesce(array_length(v_room_ids, 1), 0) > 0 then
    update public.rooms r
    set occupied_beds = (
      select count(*)::integer from public.beds b
      where b.room_id = r.id and lower(coalesce(b.status, '')) = 'occupied'
    ), updated_at = now()
    where r.id = any(v_room_ids);
  end if;

  -- Audit log
  insert into public.admin_data_action_audits (
    admin_user_id, admin_staff_user_id, admin_email, action_type,
    deleted_resident_id, deleted_resident_name, deleted_record_counts, status
  ) values (
    p_admin_user_id, v_admin_staff_id, lower(trim(p_admin_email)), 'RESIDENT_DELETE',
    p_resident_id, v_resident_name, v_counts, 'SUCCESS'
  );

  return v_counts;
end;
$$;

revoke all on function public.admin_delete_resident_data(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.admin_delete_resident_data(uuid, text, uuid, text) to service_role;


-- 3. Complete cascade-safe full hostel reset function
create or replace function public.admin_full_hostel_reset(
  p_admin_user_id uuid,
  p_admin_email text,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_admin_staff_id uuid;
  v_counts jsonb := '{}'::jsonb;
  v_count bigint;
begin
  if p_confirmation is distinct from 'RESET HOSTEL DATA' then
    raise exception 'Invalid reset confirmation.' using errcode = '22023';
  end if;

  select id into v_admin_staff_id
  from public.staff_users
  where lower(email) = lower(trim(p_admin_email))
    and lower(coalesce(status, '')) = 'active'
    and lower(coalesce(role, '')) in ('admin', 'super admin')
  limit 1;

  if v_admin_staff_id is null then
    raise exception 'Administrator permission is required.' using errcode = '42501';
  end if;

  perform set_config('app.allow_admin_destructive_cleanup', 'on', true);

  delete from public.notification_deliveries where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('notification_deliveries', v_count);

  delete from public.notice_recipients where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('notice_recipients', v_count);

  delete from public.maintenance_photos where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('maintenance_photos', v_count);

  delete from public.maintenance_requests where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('maintenance_requests', v_count);

  delete from public.payment_followups where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('payment_followups', v_count);

  delete from public.rent_reminder_deliveries where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('rent_reminder_deliveries', v_count);

  delete from public.fine_waiver_requests where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('fine_waiver_requests', v_count);

  delete from public.late_fee_payment_allocations where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('late_fee_payment_allocations', v_count);

  delete from public.late_fee_history where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('late_fee_history', v_count);

  delete from public.late_fees where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('late_fees', v_count);

  delete from public.rent_period_corrections where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('rent_period_corrections', v_count);

  delete from public.staff_payment_allocation_audit where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('staff_payment_allocation_audit', v_count);

  update public.bills set additional_receipt_id = null where additional_receipt_id is not null;
  update public.payment_receipts set payment_id = null where payment_id is not null;

  delete from public.payment_allocations where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('payment_allocations', v_count);

  delete from public.payment_status_history where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('payment_status_history', v_count);

  delete from public.payment_receipts where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('payment_receipts', v_count);

  delete from public.payments where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('payments', v_count);

  delete from public.ac_bills where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('ac_bills', v_count);

  delete from public.bills where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('bills', v_count);

  delete from public.contracts where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('contracts', v_count);

  delete from public.room_inspections where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('room_inspections', v_count);

  delete from public.inspections where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('inspections', v_count);

  delete from public.inventory_assignments where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('inventory_assignments', v_count);

  delete from public.inventory_movements where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('inventory_movements', v_count);

  delete from public.inventory where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('inventory', v_count);

  delete from public.complaints where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('complaints', v_count);

  delete from public.visitors where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('visitors', v_count);

  delete from public.notices where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('notices', v_count);

  delete from public.resident_portal_links where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('resident_portal_links', v_count);

  delete from public.historical_payment_evidence_reviews where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('historical_payment_evidence_reviews', v_count);

  delete from public.historical_payment_evidence where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('historical_payment_evidence', v_count);

  delete from public.resident_profile_documents where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('resident_profile_documents', v_count);

  delete from public.resident_emergency_contacts where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('resident_emergency_contacts', v_count);

  delete from public.resident_profile_corrections where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('resident_profile_corrections', v_count);

  delete from public.resident_profile_completions where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('resident_profile_completions', v_count);

  delete from public.admission_allocation_history where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('admission_allocation_history', v_count);

  delete from public.admissions where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('admissions', v_count);

  delete from public.beds where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('beds', v_count);

  delete from public.rooms where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('rooms', v_count);

  delete from public.residents where true;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('residents', v_count);

  insert into public.admin_data_action_audits (
    admin_user_id, admin_staff_user_id, admin_email, action_type,
    deleted_record_counts, status
  ) values (
    p_admin_user_id, v_admin_staff_id, lower(trim(p_admin_email)), 'FULL_RESET',
    v_counts, 'SUCCESS'
  );

  return v_counts;
end;
$$;

revoke all on function public.admin_full_hostel_reset(uuid, text, text) from public, anon, authenticated;
grant execute on function public.admin_full_hostel_reset(uuid, text, text) to service_role;

commit;
