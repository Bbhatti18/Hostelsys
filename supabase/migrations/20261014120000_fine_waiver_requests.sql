-- Migration to enforce Rs. 300/day fine after due date and create fine waiver requests ledger
begin;

create table if not exists public.fine_waiver_requests (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.bills(id) on delete cascade,
  resident_id uuid not null references public.residents(id) on delete cascade,
  fine_amount numeric(12,2) not null check (fine_amount >= 0),
  requested_amount numeric(12,2) not null check (requested_amount >= 0),
  waived_amount numeric(12,2) not null default 0 check (waived_amount >= 0),
  reason text not null check (length(btrim(reason)) > 0),
  status text not null default 'Pending' check (status in ('Pending', 'Approved', 'Partially Approved', 'Rejected')),
  admin_notes text,
  reviewed_by text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_fine_waiver_resident on public.fine_waiver_requests(resident_id);
create index if not exists idx_fine_waiver_bill on public.fine_waiver_requests(bill_id);
create index if not exists idx_fine_waiver_status on public.fine_waiver_requests(status);

alter table public.fine_waiver_requests enable row level security;
revoke all on public.fine_waiver_requests from anon, authenticated;
grant select on public.fine_waiver_requests to authenticated;
grant select, insert, update on public.fine_waiver_requests to service_role;

create policy fine_waiver_read on public.fine_waiver_requests for select to authenticated using
  (public.is_staff_user() or resident_id = public.current_resident_id());

-- Update calculate_rent_late_fee to strictly charge Rs. 300/day for every day overdue
create or replace function public.calculate_rent_late_fee(p_due_date date, p_as_of_date date, p_next_due_date date default null)
returns numeric language sql immutable set search_path = pg_catalog, public as $$
  select case when p_due_date is null or p_as_of_date is null or p_as_of_date <= p_due_date then 0
  else greatest(0, least(p_as_of_date,
    case when p_next_due_date > p_due_date then p_next_due_date - 1 else p_as_of_date end)
    - p_due_date) * 300 end::numeric;
$$;

commit;
