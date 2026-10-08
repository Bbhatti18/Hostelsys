-- Infrastructure only. No historical rows are repaired or payments executed.
begin;

-- Runs after the existing BEFORE UPDATE ledger/timestamp triggers. No staff or
-- service-role exemption: reversal changes status, never the settlement date.
create function public.protect_finalized_payment_settlement() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 perform public.lock_financial_ledger();
 if (old.payment_status<>'Pending' or new.payment_status<>'Pending')
   and new.payment_date is distinct from old.payment_date then
   raise exception 'Finalized payment settlement date is immutable; reverse without changing its date.' using errcode='23514';
 end if;
 if old.payment_status='Verified' and new.payment_status='Verified'
   and new.verified_at is distinct from old.verified_at then
   raise exception 'Existing verification timestamp is immutable.' using errcode='23514';
 end if;
 return new;
end; $$;
revoke all on function public.protect_finalized_payment_settlement() from public,anon,authenticated,service_role;
create trigger payments_zz_settlement_guard before update on public.payments
 for each row execute function public.protect_finalized_payment_settlement();

create or replace function public.preserve_rent_fee_for_credit(p_bill uuid,p_payment uuid,p_actor text)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.rent_period_corrections%rowtype;
 x public.staff_payment_allocation_audit%rowtype; settlement date; calculated numeric;
 f public.late_fees%rowtype;
begin
 select * into x from public.staff_payment_allocation_audit
 where replacement_payment_id=p_payment and action='correct'
 and xmin::text=pg_current_xact_id()::text
 and exists(select 1 from jsonb_array_elements(selected_items) i where i->>'bill_id'=p_bill::text);
 if found then
   -- The immutable before-state is the verified source, not a caller-supplied date.
   settlement:=(x.before_state->'payment'->>'payment_date')::date;
   if x.before_state->'payment'->>'payment_status' is distinct from 'Verified'
     or x.before_state->'payment'->>'verified_at' is null
     or settlement is null or not isfinite(settlement)
     or settlement>(now() at time zone 'Asia/Karachi')::date
     or not exists(select 1 from public.payments p where p.id=p_payment and p.payment_date=settlement)
   then raise exception 'Verified original settlement date required for correction.'; end if;
   -- Explicit historical authorization remains narrowly scoped by the applying RPC.
   if x.fee_exception_reason is not null and exists(select 1 from public.bills b
     where b.id=p_bill and b.bill_type='Rent' and b.billing_month<=to_char(settlement,'YYYY-MM')
     and b.due_date<=settlement) then return; end if;
   perform public.lock_financial_ledger();
   calculated:=public.rent_cycle_late_fee(p_bill,settlement);
   if calculated is null then raise exception 'Canonical rent period required for correction.'; end if;
   select * into f from public.late_fees where bill_id=p_bill for update;
   -- Never reduce, waive, unfreeze or rewrite previously recorded fee history.
   -- Residual rent continues accruing through the existing outstanding-rent policy.
   if (f.id is null and calculated=0) or (f.id is not null and
     (f.freeze_payment_id is not null or f.calculated_amount>=calculated)) then return; end if;
   perform public.refresh_late_fee(p_bill,settlement,p_actor,
     'Original verified settlement date '||settlement::text||'; staff correction '||x.id::text);
   return;
 end if;
 -- Preserve the earlier rent-period correction and ordinary verification paths.
 select * into c from public.rent_period_corrections where replacement_payment_id=p_payment and historical_rent_bill_id=p_bill
 and xmin::text=pg_current_xact_id()::text;
 if found then
   if c.late_fee_treatment='historical_policy' then perform public.refresh_late_fee(p_bill,c.settlement_date,p_actor,'Historical settlement; correction '||c.id::text); end if;
 else
   perform public.refresh_late_fee(p_bill,(now() at time zone 'Asia/Karachi')::date,p_actor,
     'Preserved accrued fine before rent verification; payment '||p_payment::text);
 end if;
end; $$;
revoke all on function public.preserve_rent_fee_for_credit(uuid,uuid,text) from public,anon,authenticated,service_role;
commit;
