begin;

-- The preceding repair deliberately handled recurring months only. Legacy
-- admission-month Rent still used admission_date + 5; initial Rent is payable
-- on admission itself. Join the bill's OWN admission, never a resident-only join.
select public.lock_financial_ledger();

-- Keep every field except due_date unchanged, including status and updated_at.
-- These two existing BEFORE UPDATE projections would otherwise rewrite them.
-- Hold the table exclusively while suspending ONLY those projections; financial
-- locking/validation, constraints and RLS are not disabled. Both are restored
-- before commit, and any failure rolls back the entire transaction.
lock table public.bills in access exclusive mode;
do $$
begin
  if (select count(*) from pg_catalog.pg_trigger
      where tgrelid = 'public.bills'::regclass and tgenabled = 'O'
        and tgname in ('bills_balance_projection','bills_updated_at')) <> 2 then
    raise exception 'Expected bill projections are missing or not normally enabled; review before repair.';
  end if;
end;
$$;
alter table public.bills disable trigger bills_balance_projection;
alter table public.bills disable trigger bills_updated_at;

update public.bills b
set due_date = a.admission_date
from public.admissions a
where a.id = b.admission_id and a.resident_id = b.resident_id
  and a.status in ('Pending','Active')
  and not exists (
    select 1 from public.admissions newer
    where newer.resident_id = a.resident_id
      and (newer.admission_date,newer.created_at,newer.id)
        > (a.admission_date,a.created_at,a.id)
  )
  and b.bill_type = 'Rent' and b.rent_amount > 0
  and b.billing_month = to_char(a.admission_date,'YYYY-MM')
  and b.due_date <> a.admission_date
  and b.bill_status in ('Pending','Overdue','Draft','Pending Approval')
  and b.total_amount > 0 and b.paid_amount = 0
  and b.balance_amount = b.total_amount
  and public.effective_bill_paid(b.id) = 0
  -- All statuses are excluded, not just Verified: pending, rejected, cancelled
  -- and reversed submissions can retain receipt/allocation/audit history.
  and not exists (select 1 from public.payments p where p.bill_id = b.id)
  and not exists (select 1 from public.payment_allocations pa where pa.bill_id = b.id)
  and not exists (select 1 from public.payment_receipts pr where pr.bill_id = b.id)
  -- An unassigned payment or receipt cannot safely be attributed to another bill.
  and not exists (
    select 1 from public.payments p where p.resident_id = b.resident_id and p.bill_id is null
      and not exists (select 1 from public.payment_allocations pa where pa.payment_id = p.id)
      and not exists (select 1 from public.late_fee_payment_allocations fa where fa.payment_id = p.id)
  )
  and not exists (
    select 1 from public.payment_receipts pr
    where pr.resident_id = b.resident_id and pr.bill_id is null
  )
  -- Allow only a pristine zero calculated fee (e.g. a relaxation-day reminder).
  -- Never change a due date underlying a charge, waiver, freeze or settlement,
  -- even if subsequent reconciliation reduced the current amounts to zero.
  and not exists (
    select 1 from public.late_fees f where f.bill_id = b.id and (
      f.status <> 'Calculated' or f.calculated_amount <> 0 or f.paid_amount <> 0
      or f.waived_amount <> 0 or f.frozen_amount is not null
      or f.freeze_payment_id is not null or f.freeze_receipt_id is not null
      or f.frozen_at is not null
      or exists (select 1 from public.late_fee_payment_allocations fa where fa.late_fee_id = f.id)
      or exists (
        select 1 from public.late_fee_history h where h.late_fee_id = f.id
          and (h.action not in ('Calculated','Recalculated')
            or h.amount_before <> 0 or h.amount_after <> 0 or h.waived_amount <> 0
            or coalesce(h.calculated_before,0) <> 0 or coalesce(h.calculated_after,0) <> 0
            or h.receipt_id is not null or h.payment_id is not null)
      )
    )
  );

-- No fee is created/refreshed here: refresh_late_fee materializes a charge and
-- appends history. Leave pristine calculated rows to that authoritative path.
-- Its due_date + 1 eligibility and calendar 1st-5th relaxation remain unchanged.
alter table public.bills enable trigger bills_balance_projection;
alter table public.bills enable trigger bills_updated_at;
commit;
