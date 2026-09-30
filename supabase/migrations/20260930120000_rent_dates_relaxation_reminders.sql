begin;

create or replace function public.calculate_rent_late_fee(p_due_date date, p_as_of_date date, p_next_due_date date default null)
returns numeric language sql immutable set search_path = pg_catalog, public as $$
 select case when p_due_date is null or p_as_of_date is null or extract(day from p_as_of_date) <= 5 then 0
 else greatest(0, least(p_as_of_date,
   case when p_next_due_date > p_due_date then p_next_due_date - 1 else p_as_of_date end)
   - greatest(p_due_date + 1, date_trunc('month',p_as_of_date)::date) + 1) * 300 end::numeric;
$$;
comment on function public.calculate_rent_late_fee(date,date,date) is
 'Current calendar month relaxation: days 1-5 zero payable, day 6 retroactive from max(month start,due date+1). Only an actual next payable Rent bill provides an exclusive end boundary.';

create function public.admission_rent_due_date(p_admission date, p_month text)
returns date language plpgsql immutable set search_path = pg_catalog, public as $$
declare first_day date; anniversary date;
begin
 if p_admission is null or p_month is null or p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
   or p_month < to_char(p_admission,'YYYY-MM') then return null; end if;
 if p_month = to_char(p_admission,'YYYY-MM') then return p_admission; end if;
 first_day := (p_month || '-01')::date;
 anniversary := first_day + (least(extract(day from p_admission)::integer,
   extract(day from first_day + interval '1 month - 1 day')::integer) - 1);
 return anniversary - 1;
end;
$$;
revoke all on function public.admission_rent_due_date(date,text) from public, anon, authenticated;
grant execute on function public.admission_rent_due_date(date,text) to service_role;

-- Conservative repair: no receipt, allocation, payment or fine history is rewritten.
select public.lock_financial_ledger();
update public.bills b set due_date = public.admission_rent_due_date(a.admission_date,b.billing_month), updated_at = now()
from public.admissions a, public.residents r
where a.id = b.admission_id and a.resident_id = b.resident_id and r.id = b.resident_id
 and a.status in ('Pending','Active') and r.status in ('Pending','Active')
 and not exists (select 1 from public.admissions newer where newer.resident_id = a.resident_id
   and (newer.admission_date,newer.created_at,newer.id) > (a.admission_date,a.created_at,a.id))
 and b.bill_type = 'Rent' and b.bill_status in ('Pending','Overdue','Draft','Pending Approval')
 and coalesce(b.paid_amount,0) = 0 and public.effective_bill_paid(b.id) = 0
 and b.billing_month >= to_char((now() at time zone 'Asia/Karachi')::date,'YYYY-MM')
 and b.billing_month > to_char(a.admission_date,'YYYY-MM')
 and public.admission_rent_due_date(a.admission_date,b.billing_month) is not null
 and not exists (select 1 from public.payments p where p.bill_id = b.id)
 and not exists (select 1 from public.payment_allocations pa where pa.bill_id = b.id)
 and not exists (select 1 from public.payment_receipts pr where pr.bill_id = b.id)
 and not exists (select 1 from public.late_fees f where f.bill_id = b.id);

create table public.rent_reminder_deliveries (
 id uuid primary key default gen_random_uuid(),
 resident_id uuid not null references public.residents(id),
 bill_id uuid not null references public.bills(id),
 reminder_date date not null,
 status text not null default 'claimed' check (status in ('claimed','sent','failed','skipped','configuration_required')),
 claimed_at timestamptz not null default now(),
 completed_at timestamptz,
 provider_message_id text,
 unique(resident_id,bill_id,reminder_date)
);
alter table public.rent_reminder_deliveries enable row level security;
revoke all on public.rent_reminder_deliveries from public, anon, authenticated;
grant select,insert,update on public.rent_reminder_deliveries to service_role;

-- Claim one at a time before dispatch. Claims never expire automatically: SMTP can
-- accept a message even if the process dies before recording success.
create function public.claim_daily_rent_reminder()
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare today date := (now() at time zone 'Asia/Karachi')::date;
 b record; claim_id uuid; f public.late_fees%rowtype;
begin
 perform public.lock_financial_ledger();
 select bills.*, r.full_name, r.email into b
 from public.bills bills join public.admissions a on a.id = bills.admission_id and a.resident_id = bills.resident_id
 join public.residents r on r.id = bills.resident_id
 where bills.bill_type = 'Rent' and bills.bill_status in ('Pending','Partially Paid','Overdue')
 and bills.billing_month = to_char(today,'YYYY-MM')
 and a.status in ('Pending','Active') and r.status in ('Pending','Active') and a.admission_date <= today
 and not exists (select 1 from public.admissions newer where newer.resident_id = a.resident_id
   and (newer.admission_date,newer.created_at,newer.id) > (a.admission_date,a.created_at,a.id))
 and nullif(btrim(r.email),'') is not null and public.outstanding_rent(bills.id) > 0
 and not exists (select 1 from public.rent_reminder_deliveries d where d.bill_id = bills.id
   and d.resident_id = bills.resident_id and d.reminder_date = today)
 order by bills.id limit 1 for update of bills;
 if b.id is null then return null; end if;
 insert into public.rent_reminder_deliveries(resident_id,bill_id,reminder_date)
 values(b.resident_id,b.id,today) on conflict do nothing returning id into claim_id;
 if claim_id is null then return null; end if;
 f := public.refresh_late_fee(b.id,today,'rent-reminder','Daily rent reminder quote.');
 return jsonb_build_object('id',claim_id,'residentName',b.full_name,'email',b.email,
   'billId',b.id,'day',today,'dueDate',b.due_date,'rent',public.outstanding_rent(b.id),'lateFee',f.payable_amount);
end;
$$;
revoke all on function public.claim_daily_rent_reminder() from public, anon, authenticated;
grant execute on function public.claim_daily_rent_reminder() to service_role;
commit;
