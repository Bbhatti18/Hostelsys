-- Apply manually after review. No historical data or policies are changed.
begin;

create function public.create_admission_package(
  p_resident_id uuid,
  p_room_id uuid,
  p_bed_id uuid,
  p_admission_date date,
  p_monthly_rent numeric,
  p_security_deposit numeric,
  p_special_clauses text default ''
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
  -- Preserve the existing entry + bill-write role/module ceilings. In particular,
  -- admissions-only permission must not become general financial write access.
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

  -- Use the same gate/order as existing financial statement triggers before
  -- taking row locks. Unique current-resident/current-bed indexes remain active.
  perform public.lock_financial_ledger();
  select * into v_resident from public.residents where id = p_resident_id for update;
  if not found or v_resident.status = 'Archived' then
    raise exception 'The selected resident is unavailable.' using errcode = '23514';
  end if;
  select * into v_room from public.rooms where id = p_room_id for share;
  if not found or v_room.status not in ('Available','Partially Occupied','Occupied') then
    raise exception 'The selected room is not operational.' using errcode = '23514';
  end if;
  select * into v_bed from public.beds where id = p_bed_id for update;
  if not found or v_bed.room_id <> p_room_id or v_bed.status <> 'Vacant' then
    raise exception 'The selected bed is no longer vacant in this room.' using errcode = '23514';
  end if;
  if exists (select 1 from public.admissions where resident_id = p_resident_id and status in ('Pending','Active')) then
    raise exception 'This resident already has a current admission.' using errcode = '23505';
  end if;
  if exists (select 1 from public.admissions where bed_id = p_bed_id and status in ('Pending','Active')) then
    raise exception 'This bed already belongs to a current admission.' using errcode = '23505';
  end if;

  -- Freeze both the active-template selection and its content for this snapshot.
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

  update public.beds set status = 'Occupied' where id = p_bed_id;
  insert into public.admissions (resident_id, room_id, bed_id, admission_date,
    monthly_rent, security_deposit, deposit_status, status)
  values (p_resident_id, p_room_id, p_bed_id, p_admission_date,
    p_monthly_rent, p_security_deposit, 'Pending', 'Pending') returning id into v_admission_id;
  -- Existing deposit projection may cache Held for zero; canonical not_required
  -- semantics remain authoritative. No payment or verification record is created.

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
    p_bed_id, v_template.id, v_terms, p_admission_date, p_monthly_rent, p_security_deposit,
    30, 'Pending Signature', 'Pending', 'Pending', false, null, nullif(v_clauses, ''))
  returning id into v_contract_id;

  -- No exception handler: any insert/trigger/constraint failure aborts ALL writes.
  -- A retry cannot create another current package because the resident is locked
  -- and the existing unique indexes reject duplicate admissions and obligations.
  return jsonb_build_object('admission_id', v_admission_id, 'contract_id', v_contract_id,
    'rent_bill_id', v_rent_bill_id, 'deposit_bill_id', v_deposit_bill_id);
end;
$$;

revoke all on function public.create_admission_package(uuid,uuid,uuid,date,numeric,numeric,text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_admission_package(uuid,uuid,uuid,date,numeric,numeric,text) to authenticated;

commit;
