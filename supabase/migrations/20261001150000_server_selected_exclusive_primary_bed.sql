-- Keep the applied exclusive-room migration immutable. This correction lets the
-- database choose a stable primary bed when callers submit Whole Room with NULL.
begin;

create or replace function public.create_admission_package(
  p_resident_id uuid,
  p_room_id uuid,
  p_bed_id uuid,
  p_admission_date date,
  p_monthly_rent numeric,
  p_security_deposit numeric,
  p_special_clauses text default '',
  p_allocation_mode text default 'single_bed'
)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_resident public.residents%rowtype;
  v_room public.rooms%rowtype;
  v_bed public.beds%rowtype;
  v_template public.contract_templates%rowtype;
  v_admission_id uuid;
  v_contract_id uuid;
  v_rent_bill_id uuid;
  v_deposit_bill_id uuid;
  v_terms text;
  v_clauses text := btrim(coalesce(p_special_clauses, ''), E' \t\r\n');
begin
  if coalesce(auth.role(), '') <> 'authenticated'
     or auth.uid() is null
     or not public.staff_can_operate('admissions', array['manager','reception']::text[])
     or not public.staff_can_operate('rent_bills', array['manager','accountant']::text[]) then
    raise exception 'Admission and Rent billing permissions are required.' using errcode = '42501';
  end if;
  if p_admission_date is null or not isfinite(p_admission_date)
     or p_monthly_rent is null or p_security_deposit is null
     or p_monthly_rent::text in ('NaN','Infinity','-Infinity')
     or p_security_deposit::text in ('NaN','Infinity','-Infinity')
     or p_monthly_rent <= 0 or p_security_deposit < 0
     or p_monthly_rent > 9999999999.99 or p_security_deposit > 9999999999.99
     or round(p_monthly_rent, 2) <> p_monthly_rent
     or round(p_security_deposit, 2) <> p_security_deposit then
    raise exception 'A valid admission date, positive Rent and nonnegative Deposit with at most two decimals are required.' using errcode = '22023';
  end if;
  if p_allocation_mode is null or p_allocation_mode not in ('single_bed','whole_room') then
    raise exception 'Select Single Bed or Whole Room (Exclusive).' using errcode = '22023';
  end if;
  if p_allocation_mode = 'single_bed' and p_bed_id is null then
    raise exception 'Select a bed for Single Bed allocation.' using errcode = '22023';
  end if;

  perform public.lock_financial_ledger();
  select * into v_resident from public.residents where id = p_resident_id for update;
  if not found or v_resident.status = 'Archived' then
    raise exception 'The selected resident is unavailable.' using errcode = '23514';
  end if;
  select * into v_room from public.rooms where id = p_room_id for update;
  if not found or v_room.status not in ('Available','Partially Occupied','Occupied') then
    raise exception 'The selected room is not operational.' using errcode = '23514';
  end if;
  if exists (select 1 from public.admissions where resident_id = p_resident_id and status in ('Pending','Active')) then
    raise exception 'This resident already has a current admission.' using errcode = '23505';
  end if;
  if p_allocation_mode = 'whole_room' and exists (
    select 1 from public.admissions where room_id = p_room_id and status in ('Pending','Active')
  ) then
    raise exception 'Whole Room requires a room with no other current admission.' using errcode = '23505';
  end if;
  if p_allocation_mode = 'single_bed' and exists (
    select 1 from public.admissions where room_id = p_room_id and status in ('Pending','Active')
      and allocation_mode = 'whole_room'
  ) then
    raise exception 'This room is reserved by a current Whole Room admission.' using errcode = '23505';
  end if;

  if p_allocation_mode = 'whole_room' then
    select * into v_bed from public.beds
      where room_id = p_room_id and status = 'Vacant'
      order by bed_number collate "C", id
      limit 1 for update;
    if not found then
      raise exception 'Whole Room requires at least one active vacant bed.' using errcode = '23514';
    end if;
  else
    select * into v_bed from public.beds
      where id = p_bed_id and room_id = p_room_id and status = 'Vacant'
      for update;
    if not found then
      raise exception 'The selected bed is no longer vacant in this room.' using errcode = '23514';
    end if;
  end if;

  lock table public.contract_templates in share mode;
  if (select count(*) from public.contract_templates where is_active) <> 1 then
    raise exception 'Exactly one active contract template is required.' using errcode = '23514';
  end if;
  select * into v_template from public.contract_templates where is_active;
  v_terms := btrim(v_template.content, E' \t\r\n');
  if coalesce(v_terms, '') = '' then
    raise exception 'The active contract template has no terms.' using errcode = '23514';
  end if;
  if v_clauses <> '' then v_terms := v_terms || E'\n\nSpecial Clauses:\n' || v_clauses; end if;

  insert into public.admissions (resident_id, room_id, bed_id, allocation_mode, admission_date,
    monthly_rent, security_deposit, deposit_status, status)
  values (p_resident_id, p_room_id, v_bed.id, p_allocation_mode, p_admission_date,
    p_monthly_rent, p_security_deposit, 'Pending', 'Pending') returning id into v_admission_id;

  insert into public.bills (bill_number, resident_id, admission_id, billing_month,
    due_date, rent_amount, total_amount, balance_amount, bill_status, bill_type, notes)
  values ('RENT-' || gen_random_uuid()::text, p_resident_id, v_admission_id,
    to_char(p_admission_date, 'YYYY-MM'), p_admission_date, p_monthly_rent,
    p_monthly_rent, p_monthly_rent, 'Pending', 'Rent',
    'Initial rent generated with admission. Future rent is generated by monthly billing.')
  returning id into v_rent_bill_id;

  if p_security_deposit > 0 then
    insert into public.bills (bill_number, resident_id, admission_id, billing_month,
      due_date, rent_amount, total_amount, balance_amount, bill_status, bill_type, notes)
    values ('DEP-' || gen_random_uuid()::text, p_resident_id, v_admission_id,
      'Security Deposit', (now() at time zone 'UTC')::date + 5, 0,
      p_security_deposit, p_security_deposit, 'Pending', 'Security Deposit',
      'Auto-generated Security Deposit bill.') returning id into v_deposit_bill_id;
  end if;

  insert into public.contracts (contract_number, resident_id, admission_id, room_id,
    bed_id, template_id, contract_content, start_date, monthly_rent, security_deposit,
    notice_period_days, status, resident_signature_status, owner_signature_status,
    signed_by_resident, signed_at, notes)
  values ('CNT-' || gen_random_uuid()::text, p_resident_id, v_admission_id, p_room_id,
    v_bed.id, v_template.id, v_terms, p_admission_date, p_monthly_rent, p_security_deposit,
    30, 'Pending Signature', 'Pending', 'Pending', false, null, nullif(v_clauses, ''))
  returning id into v_contract_id;

  return jsonb_build_object('admission_id', v_admission_id, 'contract_id', v_contract_id,
    'rent_bill_id', v_rent_bill_id, 'deposit_bill_id', v_deposit_bill_id,
    'allocation_mode', p_allocation_mode, 'primary_bed_id', v_bed.id);
end;
$$;

create or replace function public.guard_admission_room_allocation()
returns trigger
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_room public.rooms%rowtype;
  v_bed public.beds%rowtype;
  v_old_room_id uuid;
  v_old_bed_id uuid;
begin
  if tg_op = 'UPDATE' and old.status not in ('Pending','Active')
     and new.allocation_mode is distinct from old.allocation_mode then
    raise exception 'Historical admission allocation mode cannot be changed.' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and old.status in ('Pending','Active')
     and new.status not in ('Pending','Active')
     and new.allocation_mode is distinct from old.allocation_mode then
    raise exception 'Finalize the current admission without changing its allocation mode.' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and new.room_id is not distinct from old.room_id
     and new.bed_id is not distinct from old.bed_id
     and new.allocation_mode is not distinct from old.allocation_mode
     and new.status is not distinct from old.status then
    return new;
  end if;
  if new.status not in ('Pending','Active') then
    if tg_op = 'UPDATE' and old.status in ('Pending','Active') then
      perform public.lock_financial_ledger();
      perform b.id from public.beds b where b.id = old.bed_id for update;
      update public.beds set status = 'Vacant'
        where id = old.bed_id and status = 'Occupied'
          and not exists (select 1 from public.admissions a
            where a.id <> old.id and a.bed_id = old.bed_id and a.status in ('Pending','Active'));
    end if;
    return new;
  end if;

  perform public.lock_financial_ledger();
  if tg_op = 'UPDATE' then
    v_old_room_id := old.room_id;
    v_old_bed_id := old.bed_id;
  end if;
  perform r.id from public.rooms r
    where r.id = any(array_remove(array[new.room_id, v_old_room_id]::uuid[], null::uuid))
    order by r.id for update;

  if new.allocation_mode = 'whole_room' and new.bed_id is null
     and tg_op = 'UPDATE' and new.room_id is not distinct from old.room_id then
    new.bed_id := old.bed_id;
  end if;
  if new.allocation_mode = 'whole_room' and new.bed_id is null then
    select * into v_bed from public.beds
      where room_id = new.room_id and status = 'Vacant'
      order by bed_number collate "C", id
      limit 1 for update;
    if not found then
      raise exception 'Whole Room requires at least one active vacant bed.' using errcode = '23514';
    end if;
    new.bed_id := v_bed.id;
  else
    if new.bed_id is null then
      raise exception 'Select a bed for Single Bed allocation.' using errcode = '23514';
    end if;
    perform b.id from public.beds b
      where b.id = any(array_remove(array[new.bed_id, v_old_bed_id]::uuid[], null::uuid))
      order by b.id for update;
    select * into v_bed from public.beds where id = new.bed_id;
  end if;

  select * into v_room from public.rooms where id = new.room_id;
  if not found or v_room.status not in ('Available','Partially Occupied','Occupied') then
    raise exception 'Current admissions require an operational room.' using errcode = '23514';
  end if;
  if v_bed.id is null or v_bed.room_id <> new.room_id or v_bed.status not in ('Vacant','Occupied') then
    raise exception 'Current admissions require an active bed in the selected room.' using errcode = '23514';
  end if;
  if new.allocation_mode = 'whole_room' and exists (
    select 1 from public.admissions a where a.room_id = new.room_id
      and a.id <> new.id and a.status in ('Pending','Active')
  ) then
    raise exception 'Whole Room requires a room with no other current admission.' using errcode = '23505';
  end if;
  if new.allocation_mode = 'single_bed' and exists (
    select 1 from public.admissions a where a.room_id = new.room_id
      and a.id <> new.id and a.status in ('Pending','Active')
      and a.allocation_mode = 'whole_room'
  ) then
    raise exception 'This room is reserved by a current Whole Room admission.' using errcode = '23505';
  end if;

  if tg_op = 'UPDATE' and old.status in ('Pending','Active')
     and old.bed_id is distinct from new.bed_id then
    update public.beds set status = 'Vacant'
      where id = old.bed_id and status = 'Occupied'
        and not exists (select 1 from public.admissions a
          where a.id <> old.id and a.bed_id = old.bed_id and a.status in ('Pending','Active'));
  end if;
  if v_bed.status = 'Vacant' then
    update public.beds set status = 'Occupied' where id = new.bed_id and status = 'Vacant';
  end if;
  return new;
end;
$$;

revoke all on function public.create_admission_package(uuid,uuid,uuid,date,numeric,numeric,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_admission_package(uuid,uuid,uuid,date,numeric,numeric,text,text)
  to authenticated;
revoke all on function public.guard_admission_room_allocation() from public, anon, authenticated, service_role;

commit;
