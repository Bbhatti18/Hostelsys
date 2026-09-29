-- Local only. Requires the preceding atomic finance migrations. Never folds fines into rent.
begin;

create table public.late_fees (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null unique references public.bills(id) on delete restrict,
  calculated_amount numeric(12,2) not null default 0 check (calculated_amount >= 0),
  accrual_as_of_date date,
  waived_amount numeric(12,2) not null default 0 check (waived_amount >= 0),
  paid_amount numeric(12,2) not null default 0 check (paid_amount >= 0),
  frozen_amount numeric(12,2) check (frozen_amount >= 0),
  payable_amount numeric(12,2) generated always as
    (greatest(coalesce(frozen_amount, calculated_amount) - waived_amount - paid_amount, 0)) stored,
  freeze_receipt_id uuid unique references public.payment_receipts(id) on delete restrict,
  freeze_payment_id uuid unique references public.payments(id) on delete restrict,
  frozen_at timestamptz,
  status text not null default 'Calculated' check (status in
    ('Calculated','Charged','Frozen','Partially Waived','Waived','Paid')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Reconciliation may reduce the charge below historical payments/waivers.
  -- Retain those amounts; payable is floored at zero, never refund/delete implicitly.
  check ((frozen_amount is null and freeze_receipt_id is null and freeze_payment_id is null and frozen_at is null and status <> 'Frozen')
      or (frozen_amount is not null and freeze_receipt_id is not null and freeze_payment_id is not null and frozen_at is not null and status = 'Frozen')),
  check (status <> 'Paid' or (paid_amount > 0 and calculated_amount <= paid_amount + waived_amount)),
  check (status <> 'Waived' or (waived_amount > 0 and calculated_amount <= paid_amount + waived_amount))
);

create table public.late_fee_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null unique references public.payments(id) on delete restrict,
  late_fee_id uuid not null references public.late_fees(id) on delete restrict,
  receipt_id uuid not null unique references public.payment_receipts(id) on delete restrict,
  amount numeric(12,2) not null check (amount > 0),
  applied_at timestamptz,
  reversed_at timestamptz,
  created_at timestamptz not null default now(),
  check (reversed_at is null or applied_at is not null),
  unique(payment_id, late_fee_id)
);
create index late_fee_allocations_fee on public.late_fee_payment_allocations(late_fee_id);

create table public.late_fee_history (
  id uuid primary key default gen_random_uuid(),
  late_fee_id uuid not null references public.late_fees(id) on delete restrict,
  action text not null check (action in ('Calculated','Charged','Frozen','Released','Recalculated','Partially Waived','Waived','Paid','Reversed')),
  amount_before numeric(12,2) not null check (amount_before >= 0),
  amount_after numeric(12,2) not null check (amount_after >= 0),
  waived_amount numeric(12,2) not null check (waived_amount >= 0),
  calculated_before numeric(12,2),
  calculated_after numeric(12,2),
  reason text not null check (length(btrim(reason)) > 0),
  actor text not null,
  receipt_id uuid references public.payment_receipts(id) on delete restrict,
  payment_id uuid references public.payments(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index late_fee_history_fee on public.late_fee_history(late_fee_id, created_at);

alter table public.late_fees enable row level security;
alter table public.late_fee_history enable row level security;
alter table public.late_fee_payment_allocations enable row level security;
revoke all on public.late_fees, public.late_fee_history, public.late_fee_payment_allocations from anon, authenticated;
grant select on public.late_fees, public.late_fee_history, public.late_fee_payment_allocations to authenticated;
grant select, insert, update on public.late_fees, public.late_fee_payment_allocations to service_role;
grant select, insert on public.late_fee_history to service_role;
create policy late_fee_read on public.late_fees for select to authenticated using
 (public.is_staff_user() or exists (select 1 from public.bills b where b.id = bill_id and b.resident_id = public.current_resident_id()));
create policy late_fee_allocation_read on public.late_fee_payment_allocations for select to authenticated using
 (public.is_staff_user() or exists (select 1 from public.payments p where p.id = payment_id and p.resident_id = public.current_resident_id()));
create policy late_fee_history_read on public.late_fee_history for select to authenticated using
 (public.is_staff_user() or exists (select 1 from public.late_fees f join public.bills b on b.id = f.bill_id where f.id = late_fee_id and b.resident_id = public.current_resident_id()));

-- Pure date arithmetic: explicit dates only, no current-date dependency.
create function public.calculate_rent_late_fee(p_due_date date, p_as_of_date date, p_next_due_date date default null)
returns numeric language sql immutable set search_path = pg_catalog, public as $$
 select case when p_due_date is null or p_as_of_date is null or days <= 5 then 0 else days * 300 end::numeric from (
   select greatest(0, least(p_as_of_date,
       case when p_next_due_date > p_due_date then p_next_due_date - 1 else p_as_of_date end)
     - p_due_date + 1) as days
 ) d;
$$;

-- Matches the current summary's proportional discount and rent-first payment allocation.
create function public.outstanding_rent(p_bill_id uuid, p_exclude_payment uuid default null)
returns numeric language sql volatile security definer set search_path = pg_catalog, public as $$
 select coalesce((select greatest(round(b.rent_amount * least(1::numeric, b.total_amount / nullif(
   b.rent_amount + b.electricity_amount + b.ac_amount + b.other_amount + greatest(b.total_amount - greatest(
     b.rent_amount + b.electricity_amount + b.ac_amount + b.other_amount - b.discount_amount, 0), 0), 0)), 2)
   - public.effective_bill_paid(b.id, p_exclude_payment), 0)
 from public.bills b join public.admissions a on a.id = b.admission_id and a.resident_id = b.resident_id
 where b.id = p_bill_id and b.bill_type = 'Rent'
   and (b.bill_status in ('Pending','Partially Paid','Overdue') or (p_exclude_payment is not null and b.bill_status = 'Paid'))
   and a.status in ('Pending','Active')
   and b.due_date >= a.admission_date), 0);
$$;

create function public.rent_cycle_late_fee(p_bill_id uuid, p_as_of_date date)
returns numeric language sql volatile security definer set search_path = pg_catalog, public as $$
 select public.calculate_rent_late_fee(b.due_date, p_as_of_date,
   (select min(n.due_date) from public.bills n where n.admission_id = b.admission_id
     and n.resident_id = b.resident_id and n.bill_type = 'Rent'
     and n.bill_status in ('Pending','Partially Paid','Overdue','Paid') and n.due_date > b.due_date))
 from public.bills b join public.admissions a on a.id = b.admission_id
 where b.id = p_bill_id and b.bill_type = 'Rent' and b.due_date >= a.admission_date;
$$;

create function public.current_rent_late_fee(p_bill_id uuid, p_as_of_date date)
returns numeric language sql volatile security definer set search_path = pg_catalog, public as $$
 select case when public.outstanding_rent(p_bill_id) > 0
   then public.rent_cycle_late_fee(p_bill_id,p_as_of_date) else 0 end;
$$;

-- One financial status rule for every write; audit actions are stored separately.
create function public.derive_late_fee_status()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
declare payable numeric;
begin
 payable := greatest(coalesce(new.frozen_amount,new.calculated_amount)-new.waived_amount-new.paid_amount,0);
 new.status := case when new.freeze_payment_id is not null and payable > 0 then 'Frozen'
   when payable = 0 and new.paid_amount > 0 then 'Paid'
   when payable = 0 and new.waived_amount > 0 then 'Waived'
   when payable > 0 and new.waived_amount > 0 then 'Partially Waived'
   when payable > 0 then 'Charged' else 'Calculated' end;
 return new;
end;
$$;
create trigger late_fee_financial_status before insert or update on public.late_fees
 for each row execute function public.derive_late_fee_status();

create function public.late_fee_accrual_date(p_bill_id uuid, p_as_of_date date)
returns date language sql volatile security definer set search_path = pg_catalog, public as $$
 select case when public.outstanding_rent(p_bill_id) > 0
   and not coalesce(f.paid_amount > 0 and f.paid_amount + f.waived_amount >= f.calculated_amount,false)
   then p_as_of_date else f.accrual_as_of_date end
 from (select 1) seed left join public.late_fees f on f.bill_id = p_bill_id;
$$;

create function public.refresh_late_fee(p_bill_id uuid, p_as_of_date date, p_actor text, p_reason text)
returns public.late_fees language plpgsql security definer set search_path = pg_catalog, public as $$
declare b public.bills%rowtype; f public.late_fees%rowtype; previous numeric; calculated numeric;
 previous_calculated numeric; accrual_date date;
begin
 perform public.lock_financial_ledger();
 select * into b from public.bills where id = p_bill_id for update;
 if b.id is null or b.bill_type <> 'Rent' then raise exception 'A rent bill is required.'; end if;
 if not exists (select 1 from public.admissions a where a.id = b.admission_id and a.resident_id = b.resident_id
   and b.due_date >= a.admission_date) then raise exception 'Repair the rent due date: it precedes admission.'; end if;
 insert into public.late_fees(bill_id) values (b.id) on conflict (bill_id) do nothing;
 select * into f from public.late_fees where bill_id = b.id for update;
 if f.freeze_payment_id is not null then return f; end if;
 previous := f.payable_amount;
 previous_calculated := f.calculated_amount;
 accrual_date := public.late_fee_accrual_date(b.id,p_as_of_date);
 calculated := coalesce(public.rent_cycle_late_fee(b.id,accrual_date),0);
 -- A satisfied fine may reconcile downward, but cannot reopen through recalculation.
 if f.paid_amount > 0 and f.paid_amount + f.waived_amount >= f.calculated_amount then
   calculated := least(calculated,f.calculated_amount);
 end if;
 update public.late_fees set calculated_amount = calculated, accrual_as_of_date = accrual_date, updated_at = now()
 where id = f.id returning * into f;
 insert into public.late_fee_history(late_fee_id, action, amount_before, amount_after, waived_amount, reason, actor,calculated_before,calculated_after)
 values(f.id, 'Recalculated', previous, f.payable_amount, f.waived_amount, p_reason, p_actor,previous_calculated,calculated);
 return f;
end;
$$;

create function public.freeze_late_fee_for_receipt(p_bill_id uuid, p_receipt_id uuid, p_payment_id uuid)
returns public.late_fees language plpgsql security definer set search_path = pg_catalog, public as $$
declare b public.bills%rowtype; f public.late_fees%rowtype; r public.payment_receipts%rowtype; p public.payments%rowtype;
begin
 perform public.lock_financial_ledger();
 select * into b from public.bills where id = p_bill_id for update;
 select * into p from public.payments where id = p_payment_id for update;
 select * into r from public.payment_receipts where id = p_receipt_id for update;
 if b.id is null or b.bill_type <> 'Rent' or b.bill_status not in ('Pending','Partially Paid','Overdue','Paid')
   or p.id is null or r.id is null or p.payment_status <> 'Pending' or r.status <> 'Pending Verification'
   or r.payment_id is distinct from p.id or p.bill_id is not null
   or p.resident_id is distinct from b.resident_id or r.resident_id is distinct from b.resident_id or r.amount <> p.amount then
   raise exception 'Matching pending receipt/payment and payable rent bill are required.';
 end if;
 if not exists (select 1 from public.admissions where id = b.admission_id and status in ('Pending','Active')) then
   raise exception 'Current admission is required.'; end if;
 select * into f from public.late_fees where bill_id = b.id for update;
 if f.freeze_payment_id is not null then
   if f.freeze_payment_id = p.id and f.freeze_receipt_id = r.id then return f; end if;
   raise exception 'Another pending receipt already freezes this fine.';
 end if;
 f := public.refresh_late_fee(b.id, (r.created_at at time zone 'Asia/Karachi')::date,
   'resident:' || b.resident_id::text, 'Calculated at receipt submission.');
 if f.payable_amount <= 0 then raise exception 'No outstanding late fee is payable.'; end if;
 update public.late_fees set frozen_amount = calculated_amount, freeze_receipt_id = r.id,
   freeze_payment_id = p.id, frozen_at = now(), status = 'Frozen', updated_at = now()
 where id = f.id returning * into f;
 insert into public.late_fee_history(late_fee_id,action,amount_before,amount_after,waived_amount,reason,actor,receipt_id,payment_id)
 values(f.id,'Frozen',f.payable_amount,f.payable_amount,f.waived_amount,'Frozen at receipt submission.',
   'resident:' || b.resident_id::text,r.id,p.id);
 return f;
end;
$$;

create function public.release_late_fee_freeze(p_receipt_id uuid, p_reason text, p_actor text)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare f public.late_fees%rowtype; previous numeric; payment_key uuid; bill_key uuid;
begin
 perform public.lock_financial_ledger();
 if nullif(btrim(p_reason),'') is null then raise exception 'Release reason is required.'; end if;
 select bill_id into bill_key from public.late_fees where freeze_receipt_id = p_receipt_id;
 if bill_key is null then return; end if;
 perform 1 from public.bills where id = bill_key for update;
 select * into f from public.late_fees where freeze_receipt_id = p_receipt_id for update;
 if not found then return; end if;
 if exists (select 1 from public.payments where id = f.freeze_payment_id and payment_status not in ('Rejected','Cancelled')) then
   raise exception 'Only rejected or cancelled payments release a freeze.'; end if;
 previous := f.payable_amount; payment_key := f.freeze_payment_id;
 update public.late_fees set frozen_amount = null, freeze_receipt_id = null, freeze_payment_id = null, frozen_at = null,
   updated_at = now() where id = f.id returning * into f;
 f := public.refresh_late_fee(f.bill_id,(now() at time zone 'Asia/Karachi')::date,p_actor,p_reason);
 insert into public.late_fee_history(late_fee_id,action,amount_before,amount_after,waived_amount,reason,actor,receipt_id,payment_id)
 values(f.id,'Released',previous,f.payable_amount,f.waived_amount,p_reason,p_actor,p_receipt_id,payment_key);
end;
$$;

-- The authenticated caller identity is authoritative; no actor supplied by the browser.
create function public.adjust_late_fee(p_bill_id uuid, p_action text, p_waived_amount numeric, p_reason text)
returns public.late_fees language plpgsql security definer set search_path = pg_catalog, public as $$
declare f public.late_fees%rowtype; previous numeric; actor_name text;
begin
 perform public.lock_financial_ledger();
 if not public.is_admin_user() then raise exception 'Active Admin or Super Admin required.' using errcode = '42501'; end if;
 if nullif(btrim(p_reason),'') is null then raise exception 'Adjustment reason is required.'; end if;
 if p_action not in ('Charge','Waive') or p_action is null then raise exception 'Invalid fine action.'; end if;
 actor_name := auth.uid()::text || ':' || (auth.jwt()->>'email');
 f := public.refresh_late_fee(p_bill_id, (now() at time zone 'Asia/Karachi')::date, actor_name, p_reason);
 if f.freeze_payment_id is not null then raise exception 'Reject or cancel the pending receipt before adjusting its frozen fine.'; end if;
 previous := f.payable_amount;
 if p_action = 'Waive' and (p_waived_amount is null or p_waived_amount < 0 or p_waived_amount <> round(p_waived_amount,2)
   or p_waived_amount > greatest(f.waived_amount,f.calculated_amount - f.paid_amount)) then raise exception 'Invalid total waiver amount.'; end if;
 update public.late_fees set waived_amount = case when p_action = 'Waive' then p_waived_amount else waived_amount end,
   updated_at = now() where id = f.id returning * into f;
 insert into public.late_fee_history(late_fee_id,action,amount_before,amount_after,waived_amount,reason,actor)
 values(f.id,case when p_action = 'Charge' then 'Charged'
   when f.payable_amount = 0 and f.waived_amount > 0 then 'Waived' else 'Partially Waived' end,
   previous,f.payable_amount,f.waived_amount,p_reason,actor_name);
 return f;
end;
$$;

-- Allocation-backed fine payments use bill_id NULL. Legacy single-bill projection is unchanged.
create function public.validate_late_fee_payment(p_payment_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare p public.payments%rowtype; x public.late_fee_payment_allocations%rowtype;
 f public.late_fees%rowtype; r public.payment_receipts%rowtype; b public.bills%rowtype; total numeric;
begin
 perform public.lock_financial_ledger();
 select * into p from public.payments where id = p_payment_id for update;
 select * into x from public.late_fee_payment_allocations where payment_id = p.id;
 if x.id is null then return; end if;
 select * into f from public.late_fees where id = x.late_fee_id for update;
 select * into b from public.bills where id = f.bill_id for update;
 select * into r from public.payment_receipts where id = x.receipt_id for update;
 select coalesce(sum(amount),0) into total from public.payment_allocations where payment_id = p.id;
 if p.bill_id is not null or total + x.amount <> p.amount or r.payment_id is distinct from p.id
   or r.resident_id is distinct from p.resident_id or r.amount <> p.amount or b.resident_id is distinct from p.resident_id then
   raise exception 'Fine payment must equal its explicit bill and late-fee allocations and receipt.'; end if;
 if exists (select 1 from public.payment_allocations pa join public.bills ab on ab.id = pa.bill_id
   where pa.payment_id = p.id and (ab.resident_id <> p.resident_id or ab.admission_id <> b.admission_id
     or (ab.id <> b.id and ab.bill_type <> 'Security Deposit'))) then
   raise exception 'Fine allocations must use this rent bill and its admission deposit.'; end if;
 if p.payment_status = 'Pending' then
   if f.freeze_payment_id is distinct from p.id or f.freeze_receipt_id is distinct from r.id
     or x.amount > f.payable_amount or x.applied_at is not null or r.status <> 'Pending Verification' then
     raise exception 'Fine allocation exceeds payable fine or does not own the pending freeze.'; end if;
 elsif p.payment_status = 'Verified' then
   if x.applied_at is null or x.reversed_at is not null or r.status <> 'Verified' then
     raise exception 'Verified fine allocation was not atomically applied.'; end if;
 elsif x.applied_at is not null and x.reversed_at is null then
   raise exception 'Finalized fine allocation must be reversed with its payment.';
 end if;
end;
$$;

create function public.guard_late_fee_allocation()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare p public.payments%rowtype;
begin
 perform public.lock_financial_ledger();
 if tg_op = 'DELETE' then raise exception 'Fine allocations are retained for audit.'; end if;
 if tg_op = 'UPDATE' then
   if (to_jsonb(new) - array['applied_at','reversed_at']) is distinct from (to_jsonb(old) - array['applied_at','reversed_at'])
     or pg_trigger_depth() < 2 then raise exception 'Fine allocations are immutable; reject/cancel the payment.'; end if;
   return new;
 end if;
 select * into p from public.payments where id = new.payment_id for update;
 if p.payment_status <> 'Pending' or p.bill_id is not null or new.applied_at is not null or new.reversed_at is not null then
   raise exception 'Fine allocations require an unapplied pending allocation payment.'; end if;
 return new;
end;
$$;
create trigger late_fee_allocation_guard before insert or update or delete on public.late_fee_payment_allocations
 for each row execute function public.guard_late_fee_allocation();

-- Payment status is the single atomic apply/release/reverse boundary, including existing staff reversal RPCs.
create function public.apply_late_fee_payment_transition()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare x public.late_fee_payment_allocations%rowtype; f public.late_fees%rowtype; previous numeric; actor_name text;
begin
 perform public.lock_financial_ledger();
 if new.payment_status = old.payment_status then return null; end if;
 select * into x from public.late_fee_payment_allocations where payment_id = new.id for update;
 if x.id is null then return null; end if;
 perform 1 from public.bills where id = (select bill_id from public.late_fees where id = x.late_fee_id) for update;
 select * into f from public.late_fees where id = x.late_fee_id for update;
 previous := f.payable_amount;
 actor_name := coalesce(nullif(new.verified_by,''), auth.jwt()->>'email', 'system');
 if new.payment_status = 'Verified' then
   if not exists (select 1 from public.bills b join public.admissions a on a.id = b.admission_id
     where b.id = f.bill_id and b.resident_id = new.resident_id and a.resident_id = new.resident_id
       and a.status in ('Pending','Active') and b.bill_type = 'Rent'
       and b.bill_status in ('Pending','Partially Paid','Overdue','Paid')) then
     raise exception 'Fine obligation is no longer payable.'; end if;
   if old.payment_status <> 'Pending' or x.applied_at is not null or x.reversed_at is not null
     or f.freeze_payment_id is distinct from new.id or f.freeze_receipt_id is distinct from x.receipt_id
     or x.amount > f.payable_amount then raise exception 'Fine payment exceeds its frozen payable amount or was already applied.'; end if;
   if not exists (select 1 from public.payment_receipts where id = x.receipt_id and payment_id = new.id
     and resident_id = new.resident_id and amount = new.amount and status = 'Pending Verification') then
     raise exception 'Fine verification requires the matching pending receipt.'; end if;
   update public.late_fee_payment_allocations set applied_at = now() where id = x.id;
   update public.late_fees set paid_amount = paid_amount + x.amount,
     frozen_amount = null, freeze_receipt_id = null, freeze_payment_id = null, frozen_at = null,
     updated_at = now()
   where id = f.id returning * into f;
   insert into public.late_fee_history(late_fee_id,action,amount_before,amount_after,waived_amount,reason,actor,receipt_id,payment_id)
   values(f.id,'Paid',previous,f.payable_amount,f.waived_amount,'Verified explicit fine allocation.',actor_name,x.receipt_id,new.id);
 elsif old.payment_status = 'Verified' then
   if new.payment_status <> 'Cancelled' or x.applied_at is null or x.reversed_at is not null then
     raise exception 'Invalid fine reversal.'; end if;
   if f.freeze_payment_id is not null then raise exception 'Resolve the pending fine receipt before reversing an earlier fine payment.'; end if;
   update public.late_fee_payment_allocations set reversed_at = now() where id = x.id;
   update public.late_fees set paid_amount = paid_amount - x.amount, updated_at = now()
     where id = f.id returning * into f;
   insert into public.late_fee_history(late_fee_id,action,amount_before,amount_after,waived_amount,reason,actor,receipt_id,payment_id)
   values(f.id,'Reversed',previous,f.payable_amount,f.waived_amount,coalesce(nullif(btrim(new.notes),''),'Payment reversed.'),actor_name,x.receipt_id,new.id);
 elsif new.payment_status in ('Rejected','Cancelled') then
   perform public.release_late_fee_freeze(x.receipt_id, coalesce(nullif(btrim(new.notes),''),'Payment ' || new.payment_status), actor_name);
 end if;
 return null;
end;
$$;
create trigger payments_late_fee_transition after update of payment_status on public.payments
 for each row execute function public.apply_late_fee_payment_transition();

-- A receipt-only rejection/cancellation must also transition its linked payment.
create function public.release_late_fee_receipt_transition()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
 if new.status is distinct from old.status and new.status in ('Rejected','Cancelled')
   and exists (select 1 from public.late_fee_payment_allocations where receipt_id = new.id) then
   update public.payments set payment_status = case when new.status = 'Cancelled' then 'Cancelled' else 'Rejected' end,
     notes = coalesce(nullif(new.remarks,''),'Receipt ' || new.status), verified_by = new.verified_by
     where id = new.payment_id and payment_status = 'Pending';
 end if;
 return null;
end;
$$;
create trigger receipts_late_fee_transition after update of status on public.payment_receipts
 for each row execute function public.release_late_fee_receipt_transition();

create function public.check_late_fee_integrity()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare f public.late_fees%rowtype; fee_key uuid;
begin
 perform public.lock_financial_ledger();
 if tg_table_name = 'late_fees' then fee_key := new.id; else fee_key := new.late_fee_id; end if;
 select * into f from public.late_fees where id = fee_key;
 if f.paid_amount <> coalesce((select sum(x.amount) from public.late_fee_payment_allocations x
   join public.payments p on p.id = x.payment_id where x.late_fee_id = f.id and p.payment_status = 'Verified'
     and x.applied_at is not null and x.reversed_at is null),0) then raise exception 'Fine paid amount requires verified explicit allocations.'; end if;
 if f.freeze_payment_id is not null and not exists (select 1 from public.late_fee_payment_allocations x
   join public.payments p on p.id = x.payment_id where x.late_fee_id = f.id and x.payment_id = f.freeze_payment_id
   and x.receipt_id = f.freeze_receipt_id and p.payment_status = 'Pending' and x.amount <= f.payable_amount) then
   raise exception 'Freeze must belong to an explicit pending fine allocation.'; end if;
 return null;
end;
$$;
create constraint trigger late_fee_integrity after insert or update on public.late_fees
 deferrable initially deferred for each row execute function public.check_late_fee_integrity();
create constraint trigger late_fee_allocation_integrity after insert or update on public.late_fee_payment_allocations
 deferrable initially deferred for each row execute function public.check_late_fee_integrity();

create function public.verify_late_fee_payment(p_payment_id uuid, p_receipt_id uuid, p_verifier text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare p public.payments%rowtype; x public.late_fee_payment_allocations%rowtype; obligation record; n integer;
begin
 perform public.lock_financial_ledger();
 select * into p from public.payments where id = p_payment_id for update;
 if p.id is null or p.payment_status <> 'Pending' then raise exception 'Payment is no longer pending.'; end if;
 select * into x from public.late_fee_payment_allocations where payment_id = p.id and receipt_id = p_receipt_id;
 if x.id is null then raise exception 'Explicit fine allocation is required.'; end if;
 perform public.validate_late_fee_payment(p.id);
 if not exists (select 1 from public.late_fees f join public.bills b on b.id = f.bill_id
   join public.admissions a on a.id = b.admission_id where f.id = x.late_fee_id
   and a.status in ('Pending','Active') and b.bill_status in ('Pending','Partially Paid','Overdue','Paid')) then
   raise exception 'Fine obligation is no longer payable.'; end if;
 select count(*) into n from public.payment_allocations where payment_id = p.id;
 if n > 2 then raise exception 'Invalid fine payment bill allocations.'; end if;
 for obligation in select pa.*, b.bill_type, b.total_amount, b.bill_status from public.payment_allocations pa
   join public.bills b on b.id = pa.bill_id where pa.payment_id = p.id order by b.id for update of b loop
   if obligation.bill_status not in ('Pending','Partially Paid','Overdue') then raise exception 'Bill is not payable.'; end if;
   if (n = 2 and obligation.amount <> obligation.total_amount - public.effective_bill_paid(obligation.bill_id))
     or (n = 1 and (obligation.bill_type <> 'Rent' or obligation.amount <> public.outstanding_rent(obligation.bill_id))) then
     raise exception 'Payment must settle the exact selected current rent/deposit obligations.'; end if;
 end loop;
 update public.payments set payment_status = 'Verified', verified_by = p_verifier, verified_at = now() where id = p.id;
 update public.payment_receipts set status = 'Verified', verified = true, verified_by = p_verifier, verified_at = now()
   where id = p_receipt_id and payment_id = p.id and status = 'Pending Verification';
 if not found then raise exception 'Receipt changed before verification.'; end if;
 return jsonb_build_object('payment_id',p.id,'receipt_id',p_receipt_id);
end;
$$;

create function public.create_late_fee_payment_submission(
 p_resident_id uuid, p_admission_id uuid, p_rent_bill_id uuid, p_deposit_bill_id uuid,
 p_include_rent boolean, p_amount numeric, p_payment_method text, p_reference_number text,
 p_notes text, p_receipt_url text, p_original_file_name text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare b public.bills%rowtype; d public.bills%rowtype; f public.late_fees%rowtype;
 payment_key uuid := gen_random_uuid(); receipt_key uuid := gen_random_uuid(); rent_due numeric := 0; deposit_due numeric := 0;
begin
 perform public.lock_financial_ledger();
 select * into b from public.bills where id = p_rent_bill_id and resident_id = p_resident_id and admission_id = p_admission_id for update;
 if b.id is null or b.bill_type <> 'Rent' or b.bill_status not in ('Pending','Partially Paid','Overdue','Paid') then
   raise exception 'Valid rent obligation is required.'; end if;
 if p_include_rent is null or (p_deposit_bill_id is not null and not p_include_rent) then
   raise exception 'Deposit plus fine requires rent in the combined payment.'; end if;
 if p_include_rent then
   rent_due := public.outstanding_rent(b.id);
   if rent_due <= 0 then raise exception 'No outstanding rent.'; end if;
 end if;
 if p_deposit_bill_id is not null then
   select * into d from public.bills where id = p_deposit_bill_id and resident_id = p_resident_id
     and admission_id = p_admission_id and bill_type = 'Security Deposit' and bill_status in ('Pending','Partially Paid','Overdue') for update;
   if d.id is null then raise exception 'Valid deposit obligation is required.'; end if;
   -- Preserve the established exact Rent + Deposit bill balance contract.
   rent_due := b.total_amount - public.effective_bill_paid(b.id);
   deposit_due := d.total_amount - public.effective_bill_paid(d.id);
   if deposit_due <= 0 then raise exception 'No outstanding deposit.'; end if;
 end if;
 if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount,2) then raise exception 'Invalid payment amount.'; end if;
 insert into public.payments(id,payment_number,resident_id,amount,payment_method,reference_number,notes,payment_status)
 values(payment_key,'PAY-' || replace(payment_key::text,'-',''),p_resident_id,p_amount,p_payment_method,nullif(p_reference_number,''),p_notes,'Pending');
 insert into public.payment_receipts(id,resident_id,payment_id,amount,receipt_url,original_file_name,reference_number,notes,status)
 values(receipt_key,p_resident_id,payment_key,p_amount,p_receipt_url,p_original_file_name,nullif(p_reference_number,''),p_notes,'Pending Verification');
 f := public.freeze_late_fee_for_receipt(b.id,receipt_key,payment_key);
 if p_amount <> rent_due + deposit_due + f.payable_amount then raise exception 'Amount must equal selected obligations plus the current applicable fine.'; end if;
 if rent_due > 0 then insert into public.payment_allocations(payment_id,bill_id,amount) values(payment_key,b.id,rent_due); end if;
 if deposit_due > 0 then insert into public.payment_allocations(payment_id,bill_id,amount) values(payment_key,d.id,deposit_due); end if;
 insert into public.late_fee_payment_allocations(payment_id,late_fee_id,receipt_id,amount) values(payment_key,f.id,receipt_key,f.payable_amount);
 perform public.validate_late_fee_payment(payment_key);
 return jsonb_build_object('payment_id',payment_key,'receipt_id',receipt_key,'late_fee_amount',f.payable_amount);
end;
$$;

-- Existing guards extended only for explicitly allocated fine payments.
create or replace function public.validate_payment_allocation_total()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  affected_ids uuid[] := '{}'::uuid[];
  affected_id uuid;
  payment_row public.payments%rowtype;
  allocation_total numeric(12,2);
  allocation_count bigint;
begin
  -- Do not access NEW on DELETE or OLD on INSERT, or fields from another table.
  if tg_table_schema = 'public' and tg_table_name = 'payments' then
    if tg_op <> 'INSERT' then affected_ids := array_append(affected_ids, old.id); end if;
    if tg_op <> 'DELETE' then affected_ids := array_append(affected_ids, new.id); end if;
  elsif tg_table_schema = 'public' and tg_table_name in ('payment_allocations','late_fee_payment_allocations') then
    if tg_op <> 'INSERT' then affected_ids := array_append(affected_ids, old.payment_id); end if;
    if tg_op <> 'DELETE' then affected_ids := array_append(affected_ids, new.payment_id); end if;
  else
    raise exception 'Unexpected allocation validation trigger table.' using errcode = '23514';
  end if;

  -- Validate both the source and destination of a moved allocation, once each.
  for affected_id in
    select distinct parent_id from unnest(affected_ids) as parents(parent_id)
    where parent_id is not null order by parent_id
  loop
    select * into payment_row from public.payments where id = affected_id for update;
    -- Parent deletion cascades allocations; there is then no parent to validate.
    if not found then continue; end if;
    select coalesce(sum(amount), 0)::numeric(12,2), count(*)
      into allocation_total, allocation_count
    from public.payment_allocations where payment_id = affected_id;

    if exists (select 1 from public.late_fee_payment_allocations where payment_id = affected_id) then
      perform public.validate_late_fee_payment(affected_id);
      continue;
    end if;
    if payment_row.bill_id is not null then
      if allocation_count <> 1 or allocation_total <> payment_row.amount
         or exists (select 1 from public.payment_allocations
                    where payment_id = affected_id and bill_id <> payment_row.bill_id) then
        raise exception 'Single-bill payment requires one exact matching allocation.' using errcode = '23514';
      end if;
    elsif payment_row.payment_status = 'Verified' and allocation_total <> payment_row.amount then
      raise exception 'Verified combined payment allocations must equal the parent amount.' using errcode = '23514';
    end if;
    if allocation_total > 0 and allocation_total <> payment_row.amount then
      raise exception 'Payment allocation total must equal the parent payment amount.' using errcode = '23514';
    end if;
    if exists (
      select 1 from public.payment_allocations pa join public.bills b on b.id = pa.bill_id
      where pa.payment_id = affected_id and b.resident_id is distinct from payment_row.resident_id
    ) then
      raise exception 'Allocation bill must belong to the payment resident.' using errcode = '23514';
    end if;
  end loop;
  return null;
end;
$$;
create or replace function public.guard_payment_ledger()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare obligation record; b public.bills%rowtype; a public.admissions%rowtype;
begin
  perform public.lock_financial_ledger();
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.resident_id is distinct from old.resident_id
       or (old.payment_status <> 'Pending' and
         (new.bill_id is distinct from old.bill_id or new.amount is distinct from old.amount
          or (new.payment_status is distinct from old.payment_status and new.payment_status <> 'Cancelled'))) then
      raise exception 'Only pending payments may be edited; reverse finalized payments.' using errcode = '23514';
    end if;
  end if;
  if nullif(btrim(new.reference_number), '') is not null and exists (
    select 1 from public.payments p where p.reference_number = new.reference_number and p.id <> new.id
  ) then raise exception 'Payment reference already exists.' using errcode = '23505'; end if;

  -- Enforce the outstanding amount for individual submissions AND verification.
  -- Combined pending submissions are validated by their exact-total RPC.
  for obligation in
    select new.bill_id as bill_id, new.amount as amount where new.bill_id is not null
    union all
    select pa.bill_id, pa.amount from public.payment_allocations pa
      where pa.payment_id = new.id and new.bill_id is null
    order by bill_id
  loop
    select * into b from public.bills where id = obligation.bill_id for update;
    if not found or b.resident_id is distinct from new.resident_id then
      raise exception 'Payment bill does not belong to resident.' using errcode = '23514';
    end if;
    select * into a from public.admissions where id = b.admission_id;
    if (tg_op = 'INSERT' or new.payment_status in ('Pending','Verified')) then
      if a.id is null or a.resident_id is distinct from new.resident_id
         or a.status not in ('Pending','Active')
         or b.bill_status in ('Draft','Pending Approval','Cancelled') then
        raise exception 'Payment requires a current payable admission obligation.' using errcode = '23514';
      end if;
      if b.bill_type = 'Security Deposit' and a.deposit_status not in ('Pending','Held') then
        raise exception 'Released or deducted deposits require settlement review.' using errcode = '23514';
      end if;
      if obligation.amount > b.total_amount - public.effective_bill_paid(b.id, new.id) then
        raise exception 'Payment exceeds current outstanding balance.' using errcode = '23514';
      end if;
      if new.payment_status = 'Verified' and new.bill_id is null
         and exists (select 1 from public.late_fee_payment_allocations where payment_id = new.id)
         and (select count(*) from public.payment_allocations where payment_id = new.id) = 1
         and (b.bill_type <> 'Rent' or obligation.amount <> public.outstanding_rent(b.id,new.id)) then
        raise exception 'Rent plus fine must settle the exact outstanding rent.';
      end if;
      if new.bill_id is null and new.payment_status = 'Verified'
         and not (exists (select 1 from public.late_fee_payment_allocations where payment_id = new.id)
           and (select count(*) from public.payment_allocations where payment_id = new.id) = 1)
         and obligation.amount <> b.total_amount - public.effective_bill_paid(b.id, new.id) then
        raise exception 'Combined payment must settle the exact current outstanding obligations.' using errcode = '23514';
      end if;
    end if;
    if tg_op = 'UPDATE' and old.payment_status = 'Verified' and new.payment_status <> 'Verified'
       and b.bill_type = 'Security Deposit' and a.deposit_status not in ('Pending','Held') then
      raise exception 'Released or deducted deposits require settlement review.' using errcode = '23514';
    end if;
    -- Before rent credit becomes effective, preserve its accrued fine atomically.
    if new.payment_status = 'Verified' and b.bill_type = 'Rent' then
      if tg_op = 'INSERT' or old.payment_status <> 'Verified' then
        if public.outstanding_rent(b.id) > 0 then
          perform public.refresh_late_fee(b.id,(now() at time zone 'Asia/Karachi')::date,
            coalesce(auth.jwt()->>'email',nullif(new.verified_by,''),'system'),
            'Preserved accrued fine before rent verification; payment ' || new.id::text);
        end if;
      end if;
    end if;
  end loop;
  new.verified := new.payment_status = 'Verified';
  if coalesce(auth.role(), '') = 'authenticated' then new.verified_by := auth.jwt() ->> 'email'; end if;
  if new.verified then new.verified_at := coalesce(new.verified_at, now()); else new.verified_at := null; end if;
  return new;
end;
$$;
create or replace function public.verify_payment_with_allocations(
  p_payment_id uuid,
  p_receipt_id uuid,
  p_verifier text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  payment_row public.payments%rowtype;
  receipt_row public.payment_receipts%rowtype;
  allocation_row record;
  current_admission_id uuid;
  allocation_total numeric(12,2) := 0;
  verified_before numeric(12,2);
  v_paid_amount numeric(12,2);
  v_balance_amount numeric(12,2);
  v_next_bill_status text;
  deposit_bill_id uuid;
  allocation_count integer := 0;
  regular_bill_count integer := 0;
  now_at timestamptz := now();
begin
  perform public.lock_financial_ledger();
  if exists (select 1 from public.late_fee_payment_allocations where payment_id = p_payment_id) then
    return public.verify_late_fee_payment(p_payment_id, p_receipt_id, p_verifier);
  end if;
  select * into payment_row
  from public.payments
  where id = p_payment_id
  for update;
  if payment_row.id is null or payment_row.payment_status <> 'Pending' then
    raise exception 'Payment is no longer pending.' using errcode = '40001';
  end if;
  if payment_row.bill_id is not null then
    raise exception 'Allocation verification is only for combined payments.' using errcode = '22023';
  end if;

  select * into receipt_row
  from public.payment_receipts
  where id = p_receipt_id and payment_id = p_payment_id
  for update;
  if receipt_row.id is null or receipt_row.status <> 'Pending Verification' then
    raise exception 'Receipt is no longer pending verification.' using errcode = '40001';
  end if;
  if receipt_row.resident_id <> payment_row.resident_id
     or round(receipt_row.amount, 2) <> round(payment_row.amount, 2) then
    raise exception 'Receipt and payment do not match.' using errcode = '23514';
  end if;

  select coalesce(sum(amount), 0)::numeric(12,2)
    into allocation_total
  from public.payment_allocations
  where payment_id = p_payment_id;
  if allocation_total <> payment_row.amount then
    raise exception 'Payment allocation total must equal the parent payment amount.' using errcode = '23514';
  end if;

  for allocation_row in
    select pa.bill_id, pa.amount, b.resident_id, b.admission_id,
           b.total_amount, b.due_date, b.bill_status, b.bill_type
    from public.payment_allocations pa
    join public.bills b on b.id = pa.bill_id
    where pa.payment_id = p_payment_id
    order by pa.created_at, pa.id
    for update of b
  loop
    if allocation_row.resident_id <> payment_row.resident_id
       or allocation_row.admission_id is null then
      raise exception 'Payment allocation does not belong to the payment resident.' using errcode = '23514';
    end if;
    if current_admission_id is null then
      current_admission_id := allocation_row.admission_id;
    elsif current_admission_id <> allocation_row.admission_id then
      raise exception 'Combined payment allocations must use one admission.' using errcode = '23514';
    end if;
    if allocation_row.bill_status in ('Draft', 'Pending Approval', 'Cancelled', 'Archived') then
      raise exception 'Payment allocation references a non-payable bill.' using errcode = '23514';
    end if;
    if lower(coalesce(allocation_row.bill_type, '')) = 'security deposit' then
      deposit_bill_id := allocation_row.bill_id;
    else
      regular_bill_count := regular_bill_count + 1;
    end if;
    allocation_count := allocation_count + 1;

    select coalesce(sum(pa.amount), 0)::numeric(12,2)
      into verified_before
    from public.payment_allocations pa
    join public.payments p on p.id = pa.payment_id
    where pa.bill_id = allocation_row.bill_id
      and p.payment_status = 'Verified'
      and p.id <> p_payment_id;
    if allocation_row.amount > round(coalesce(allocation_row.total_amount, 0) - verified_before, 2) then
      raise exception 'Payment allocation exceeds the current bill balance.' using errcode = '23514';
    end if;

    v_paid_amount := round(verified_before + allocation_row.amount, 2);
    v_balance_amount := greatest(round(coalesce(allocation_row.total_amount, 0) - v_paid_amount, 2), 0);
    v_next_bill_status := case
      when v_balance_amount = 0 then 'Paid'
      when v_paid_amount > 0 then 'Partially Paid'
      when allocation_row.due_date < current_date then 'Overdue'
      else 'Pending'
    end;
    update public.bills
    set paid_amount = v_paid_amount,
      balance_amount = v_balance_amount,
      bill_status = v_next_bill_status,
        updated_at = now_at
    where id = allocation_row.bill_id;
  end loop;

  if current_admission_id is null or allocation_count <> 2 or deposit_bill_id is null or regular_bill_count <> 1 then
    raise exception 'Combined payment has no allocations.' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.admissions
    where id = current_admission_id
      and resident_id = payment_row.resident_id
      and status in ('Pending', 'Active')
  ) then
    raise exception 'Combined payment admission is no longer current.' using errcode = '23514';
  end if;

  update public.payments
  set payment_status = 'Verified', verified = true, verified_by = p_verifier,
      verified_at = now_at, updated_at = now_at
  where id = p_payment_id and payment_status = 'Pending';
  if not found then
    raise exception 'Payment changed before verification completed.' using errcode = '40001';
  end if;

  update public.payment_receipts
  set status = 'Verified', verified = true, verified_by = p_verifier,
      verified_at = now_at, updated_at = now_at
  where id = p_receipt_id and payment_id = p_payment_id
    and status = 'Pending Verification';
  if not found then
    raise exception 'Receipt changed before verification completed.' using errcode = '40001';
  end if;

  if deposit_bill_id is not null then
    update public.admissions
    set deposit_status = case
      when exists (
        select 1 from public.bills
        where id = deposit_bill_id and balance_amount = 0 and bill_status = 'Paid'
      ) then 'Held' else 'Pending' end,
      updated_at = now_at
    where id = current_admission_id and resident_id = payment_row.resident_id
      and status in ('Pending', 'Active');
  end if;

  return jsonb_build_object('payment_id', p_payment_id, 'receipt_id', p_receipt_id, 'admission_id', current_admission_id);
end;
$$;

create constraint trigger late_fee_payment_total_check after insert or update or delete on public.late_fee_payment_allocations
 deferrable initially deferred for each row execute function public.validate_payment_allocation_total();

create function public.check_late_fee_receipt()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare payment_key uuid;
begin
 for payment_key in select payment_id from public.late_fee_payment_allocations where receipt_id = new.id loop
   perform public.validate_late_fee_payment(payment_key);
 end loop;
 return null;
end;
$$;
create constraint trigger late_fee_receipt_integrity after insert or update on public.payment_receipts
 deferrable initially deferred for each row execute function public.check_late_fee_receipt();

create function public.prevent_late_fee_history_edit()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
begin raise exception 'Financial fine history cannot be changed or deleted.'; end;
$$;
create trigger late_fee_history_immutable before update or delete on public.late_fee_history
 for each row execute function public.prevent_late_fee_history_edit();

-- Serialize with the same global lock as the existing finance tables, before row locks.
create trigger financial_statement_lock before insert or update or delete on public.late_fees
 for each statement execute function public.lock_financial_statement();
create trigger financial_statement_lock before insert or update or delete on public.late_fee_payment_allocations
 for each statement execute function public.lock_financial_statement();

-- Read-only current quote. Database date and resident identity cannot be supplied by a browser.
create function public.quote_late_fee(p_bill_id uuid)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare b public.bills%rowtype; f public.late_fees%rowtype; calculated numeric;
begin
 select * into b from public.bills where id = p_bill_id;
 if b.id is null or b.bill_type <> 'Rent' or not (public.is_staff_user() or coalesce(b.resident_id = public.current_resident_id(),false)) then
   raise exception 'Rent bill unavailable.' using errcode = '42501'; end if;
 select * into f from public.late_fees where bill_id = b.id;
 calculated := coalesce(public.rent_cycle_late_fee(b.id,
   public.late_fee_accrual_date(b.id,(now() at time zone 'Asia/Karachi')::date)),0);
 if f.paid_amount > 0 and f.paid_amount + f.waived_amount >= f.calculated_amount then
   calculated := least(calculated,f.calculated_amount);
 end if;
 return jsonb_build_object('bill_id',b.id,'due_date',b.due_date,'rent_due',public.outstanding_rent(b.id),
   'late_fee_due',greatest(coalesce(f.frozen_amount,calculated)-coalesce(f.waived_amount,0)-coalesce(f.paid_amount,0),0),
   'frozen',f.freeze_payment_id is not null,'waived_amount',coalesce(f.waived_amount,0));
end;
$$;

-- Default PUBLIC execution is explicitly removed from every new helper and RPC.
do $$
declare fn regprocedure;
begin
 for fn in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname = any(array[
 'calculate_rent_late_fee','outstanding_rent','current_rent_late_fee','rent_cycle_late_fee',
 'late_fee_accrual_date','derive_late_fee_status','refresh_late_fee',
 'freeze_late_fee_for_receipt','release_late_fee_freeze','adjust_late_fee','validate_late_fee_payment',
 'guard_late_fee_allocation','apply_late_fee_payment_transition','release_late_fee_receipt_transition',
 'check_late_fee_integrity','verify_late_fee_payment','create_late_fee_payment_submission',
 'check_late_fee_receipt','prevent_late_fee_history_edit','quote_late_fee']) loop
 execute format('revoke all on function %s from public, anon, authenticated',fn);
 end loop;
end;
$$;
grant execute on function public.adjust_late_fee(uuid,text,numeric,text), public.quote_late_fee(uuid) to authenticated;
grant execute on function public.create_late_fee_payment_submission(uuid,uuid,uuid,uuid,boolean,numeric,text,text,text,text,text),
 public.verify_late_fee_payment(uuid,uuid,text) to service_role;

comment on table public.late_fee_payment_allocations is 'Explicit immutable fine allocations. Status transition applies or reverses once; normal bill allocations remain separate.';
comment on function public.calculate_rent_late_fee(date,date,date) is 'Inclusive due-cycle days: <=5 free, otherwise days*300; only the next actual payable Rent bill for this admission/resident establishes an exclusive boundary.';

-- LATE-FEE LOCK-ORDER COMPATIBILITY: create_combined_payment_submission
create or replace function public.create_combined_payment_submission(
  p_resident_id uuid,
  p_admission_id uuid,
  p_rent_bill_id uuid,
  p_deposit_bill_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_reference_number text,
  p_notes text,
  p_receipt_url text,
  p_original_file_name text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  admission_row public.admissions%rowtype;
  rent_bill public.bills%rowtype;
  deposit_bill public.bills%rowtype;
  rent_paid numeric(12,2);
  deposit_paid numeric(12,2);
  rent_balance numeric(12,2);
  deposit_balance numeric(12,2);
  payment_id uuid := gen_random_uuid();
  receipt_id uuid := gen_random_uuid();
  now_at timestamptz := now();
begin
  perform public.lock_financial_ledger();
  select * into admission_row from public.admissions
  where id = p_admission_id and resident_id = p_resident_id and status in ('Pending', 'Active')
  for update;
  if admission_row.id is null then raise exception 'Current admission could not be verified.' using errcode = '23514'; end if;

  select * into rent_bill from public.bills
  where id = p_rent_bill_id and admission_id = p_admission_id and resident_id = p_resident_id
    and bill_type <> 'Security Deposit' and bill_status not in ('Draft', 'Pending Approval', 'Cancelled', 'Archived')
  for update;
  select * into deposit_bill from public.bills
  where id = p_deposit_bill_id and admission_id = p_admission_id and resident_id = p_resident_id
    and bill_type = 'Security Deposit' and bill_status not in ('Draft', 'Pending Approval', 'Cancelled', 'Archived')
  for update;
  if rent_bill.id is null or deposit_bill.id is null then raise exception 'Both current payment obligations are required.' using errcode = '23514'; end if;

  select coalesce(sum(pa.amount), 0)::numeric(12,2) into rent_paid
  from public.payment_allocations pa join public.payments p on p.id = pa.payment_id
  where pa.bill_id = rent_bill.id and p.payment_status = 'Verified';
  select coalesce(sum(pa.amount), 0)::numeric(12,2) into deposit_paid
  from public.payment_allocations pa join public.payments p on p.id = pa.payment_id
  where pa.bill_id = deposit_bill.id and p.payment_status = 'Verified';
  rent_balance := greatest(round(rent_bill.total_amount - rent_paid, 2), 0);
  deposit_balance := greatest(round(deposit_bill.total_amount - deposit_paid, 2), 0);
  if rent_balance <= 0 or deposit_balance <= 0 or round(p_amount, 2) <> round(rent_balance + deposit_balance, 2) then
    raise exception 'Combined amount must equal the exact current Rent + Security Deposit balance.' using errcode = '23514';
  end if;

  insert into public.payments (id, payment_number, resident_id, bill_id, payment_date, amount, payment_method, reference_number, notes, payment_status, verified, created_at, updated_at)
  values (payment_id, 'PAY-' || extract(year from now_at)::text || '-' || upper(substr(replace(payment_id::text, '-', ''), 1, 8)), p_resident_id, null, now_at::date, round(p_amount, 2), p_payment_method, nullif(p_reference_number, ''), p_notes, 'Pending', false, now_at, now_at);
  insert into public.payment_allocations (payment_id, bill_id, amount) values
    (payment_id, rent_bill.id, rent_balance),
    (payment_id, deposit_bill.id, deposit_balance);
  insert into public.payment_receipts (id, resident_id, bill_id, payment_id, receipt_url, original_file_name, reference_number, amount, status, verified, notes, uploaded_at, created_at, updated_at)
  values (receipt_id, p_resident_id, null, payment_id, p_receipt_url, p_original_file_name, nullif(p_reference_number, ''), round(p_amount, 2), 'Pending Verification', false, p_notes, now_at, now_at, now_at);
  return jsonb_build_object('payment_id', payment_id, 'receipt_id', receipt_id);
end;
$$;


-- LATE-FEE LOCK-ORDER COMPATIBILITY: reject_payment_with_allocations
create or replace function public.reject_payment_with_allocations(
  p_payment_id uuid,
  p_receipt_id uuid,
  p_actor text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  payment_row public.payments%rowtype;
  receipt_row public.payment_receipts%rowtype;
begin
  perform public.lock_financial_ledger();
  select * into payment_row from public.payments where id = p_payment_id for update;
  select * into receipt_row from public.payment_receipts where id = p_receipt_id and payment_id = p_payment_id for update;
  if payment_row.id is null or receipt_row.id is null or payment_row.payment_status <> 'Pending' or receipt_row.status <> 'Pending Verification' then
    raise exception 'Payment or receipt is no longer pending.' using errcode = '40001';
  end if;
  update public.payments
  set payment_status = 'Rejected', verified = false, verified_by = p_actor,
      verified_at = null, notes = p_reason, updated_at = now()
  where id = p_payment_id and payment_status = 'Pending';
  update public.payment_receipts
  set status = 'Rejected', verified = false, verified_by = p_actor,
      verified_at = null, remarks = p_reason, updated_at = now()
  where id = p_receipt_id and status = 'Pending Verification';
  return jsonb_build_object('payment_id', p_payment_id, 'receipt_id', p_receipt_id);
end;
$$;

revoke all on function public.verify_payment_with_allocations(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.reject_payment_with_allocations(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.create_combined_payment_submission(uuid, uuid, uuid, uuid, numeric, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.cancel_payment_with_allocations(uuid, text, text) from public, anon, authenticated;
grant execute on function public.verify_payment_with_allocations(uuid, uuid, text) to service_role;
grant execute on function public.reject_payment_with_allocations(uuid, uuid, text, text) to service_role;
grant execute on function public.create_combined_payment_submission(uuid, uuid, uuid, uuid, numeric, text, text, text, text, text) to service_role;
grant execute on function public.cancel_payment_with_allocations(uuid, text, text) to service_role;

comment on table public.payment_allocations is
  'Canonical obligation allocations for a payment; legacy single-bill payments are backfilled here.';
comment on column public.payments.bill_id is
  'Legacy single-bill compatibility column. Combined payments leave this null and use payment_allocations.';
comment on table public.payment_status_history is
  'Immutable status transition history for payment verification, rejection, and cancellation.';


-- LATE-FEE LOCK-ORDER COMPATIBILITY: cancel_payment_with_allocations
create or replace function public.cancel_payment_with_allocations(
  p_payment_id uuid,
  p_actor text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  payment_row public.payments%rowtype;
  allocation_row record;
  deposit_admission_id uuid;
begin
  perform public.lock_financial_ledger();
  select * into payment_row from public.payments where id = p_payment_id for update;
  if payment_row.id is null or payment_row.payment_status = 'Cancelled' then
    raise exception 'Payment is already cancelled or unavailable.' using errcode = '40001';
  end if;
  for allocation_row in select distinct bill_id from public.payment_allocations where payment_id = p_payment_id loop
    update public.bills b
    set paid_amount = coalesce((select sum(pa.amount) from public.payment_allocations pa join public.payments p on p.id = pa.payment_id where pa.bill_id = b.id and p.payment_status = 'Verified' and p.id <> p_payment_id), 0),
        balance_amount = greatest(b.total_amount - coalesce((select sum(pa.amount) from public.payment_allocations pa join public.payments p on p.id = pa.payment_id where pa.bill_id = b.id and p.payment_status = 'Verified' and p.id <> p_payment_id), 0), 0),
        bill_status = case when greatest(b.total_amount - coalesce((select sum(pa.amount) from public.payment_allocations pa join public.payments p on p.id = pa.payment_id where pa.bill_id = b.id and p.payment_status = 'Verified' and p.id <> p_payment_id), 0), 0) = 0 then 'Paid' when coalesce((select sum(pa.amount) from public.payment_allocations pa join public.payments p on p.id = pa.payment_id where pa.bill_id = b.id and p.payment_status = 'Verified' and p.id <> p_payment_id), 0) > 0 then 'Partially Paid' else 'Pending' end,
        updated_at = now()
    where id = allocation_row.bill_id;
    select admission_id into deposit_admission_id from public.bills where id = allocation_row.bill_id and bill_type = 'Security Deposit';
  end loop;
  update public.payments set payment_status = 'Cancelled', verified = false, verified_by = p_actor, verified_at = null, notes = p_reason, updated_at = now() where id = p_payment_id and payment_status <> 'Cancelled';
  update public.payment_receipts set status = 'Rejected', verified = false, verified_by = p_actor, verified_at = null, remarks = p_reason, updated_at = now() where payment_id = p_payment_id and status = 'Pending Verification';
  if deposit_admission_id is not null then
    update public.admissions set deposit_status = case when exists (select 1 from public.bills where admission_id = deposit_admission_id and bill_type = 'Security Deposit' and bill_status = 'Paid') then 'Held' else 'Pending' end, updated_at = now() where id = deposit_admission_id and status in ('Pending', 'Active');
  end if;
  return jsonb_build_object('payment_id', p_payment_id);
end;
$$;
commit;
