-- Infrastructure only. No resident backfill or correction is executed here.
begin;

create table public.rent_period_corrections (
 id uuid primary key,
 resident_id uuid not null references public.residents(id),
 admission_id uuid not null references public.admissions(id),
 original_payment_id uuid not null unique references public.payments(id),
 original_receipt_id uuid not null unique references public.payment_receipts(id),
 replacement_payment_id uuid not null unique references public.payments(id) deferrable initially deferred,
 wrong_rent_bill_id uuid not null references public.bills(id),
 historical_rent_bill_id uuid not null references public.bills(id),
 deposit_bill_id uuid not null references public.bills(id),
 settlement_date date not null,
 late_fee_treatment text not null check (late_fee_treatment in ('historical_policy','no_correction_generated_fee')),
 late_fee_reason text,
 reason text not null check (length(btrim(reason)) > 0),
 request jsonb not null,
 before_state jsonb not null,
 actor_id uuid not null,
 actor_email text not null,
 created_at timestamptz not null default now(),
 check (late_fee_treatment <> 'no_correction_generated_fee' or length(btrim(late_fee_reason)) > 0),
 check (original_payment_id <> replacement_payment_id),
 check (wrong_rent_bill_id <> historical_rent_bill_id)
);
alter table public.rent_period_corrections enable row level security;
revoke all on public.rent_period_corrections from public,anon,authenticated,service_role;
grant select on public.rent_period_corrections to authenticated;
create policy rent_period_corrections_admin_read on public.rent_period_corrections for select to authenticated
 using (public.is_admin_user());
create function public.protect_rent_period_correction() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin raise exception 'Rent period correction audit is immutable.'; end; $$;
revoke all on function public.protect_rent_period_correction() from public,anon,authenticated,service_role;
create trigger rent_period_correction_immutable before update or delete on public.rent_period_corrections
 for each row execute function public.protect_rent_period_correction();

-- Only called by the existing ledger guard. No session flag or client-controlled
-- payment field can authorize a historical date / fee exception.
create function public.preserve_rent_fee_for_credit(p_bill uuid,p_payment uuid,p_actor text)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.rent_period_corrections%rowtype;
begin
 select * into c from public.rent_period_corrections
 where replacement_payment_id=p_payment and historical_rent_bill_id=p_bill
   and xmin::text=pg_current_xact_id()::text;
 if found then
   if c.late_fee_treatment='historical_policy' then
     perform public.refresh_late_fee(p_bill,c.settlement_date,p_actor,'Historical settlement; correction '||c.id::text);
   end if;
   -- Explicit no-fee authorization and reason are permanently retained in c.
 else
   perform public.refresh_late_fee(p_bill,(now() at time zone 'Asia/Karachi')::date,p_actor,
     'Preserved accrued fine before rent verification; payment '||p_payment::text);
 end if;
end; $$;
revoke all on function public.preserve_rent_fee_for_credit(uuid,uuid,text) from public,anon,authenticated,service_role;

create function public.correct_rent_payment_period(
 p_correction_id uuid,p_resident_id uuid,p_admission_id uuid,p_payment_id uuid,p_receipt_id uuid,
 p_wrong_rent_bill_id uuid,p_deposit_bill_id uuid,
 p_expected_admission_date date,p_correct_admission_date date,p_expected_rent_due_date date,
 p_historical_billing_month text,p_expected_rent_amount numeric,p_expected_deposit_amount numeric,
 p_expected_payment_date date,p_expected_verified_at timestamptz,
 p_reason text,p_late_fee_treatment text,p_late_fee_reason text default null
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
 a public.admissions%rowtype; p public.payments%rowtype; r public.payment_receipts%rowtype;
 w public.bills%rowtype; d public.bills%rowtype; h public.bills%rowtype;
 prior public.rent_period_corrections%rowtype; request_data jsonb; before_data jsonb;
 replacement uuid:=gen_random_uuid(); historical_due date; corrected_due date; actor text;
 original_allocations jsonb; original_history jsonb; contracts_before jsonb; fees_before jsonb;
 resident_before jsonb;
begin
 if coalesce(auth.role(),'')<>'authenticated' or auth.uid() is null or public.is_admin_user() is not true then
   raise exception 'Active Admin or Super Admin required.' using errcode='42501';
 end if;
 actor:=auth.jwt()->>'email';
 if p_correction_id is null or p_resident_id is null or p_admission_id is null or p_payment_id is null
 or p_receipt_id is null or p_wrong_rent_bill_id is null or p_deposit_bill_id is null
 or p_expected_admission_date is null or p_correct_admission_date is null or p_expected_rent_due_date is null
 or not isfinite(p_expected_admission_date) or not isfinite(p_correct_admission_date) or not isfinite(p_expected_rent_due_date)
 or p_expected_payment_date is null or not isfinite(p_expected_payment_date)
 or p_expected_verified_at is null or not isfinite(p_expected_verified_at)
 or p_correct_admission_date>=p_expected_admission_date
 or p_expected_payment_date<p_correct_admission_date or p_expected_payment_date>(now() at time zone 'Asia/Karachi')::date
 or p_historical_billing_month is distinct from to_char(p_correct_admission_date,'YYYY-MM')
 or to_char(p_expected_payment_date,'YYYY-MM') is distinct from p_historical_billing_month
 or p_expected_rent_amount is null or p_expected_deposit_amount is null
 or p_expected_rent_amount::text in ('NaN','Infinity','-Infinity') or p_expected_deposit_amount::text in ('NaN','Infinity','-Infinity')
 or p_expected_rent_amount<=0 or p_expected_deposit_amount<=0
 or round(p_expected_rent_amount,2)<>p_expected_rent_amount or round(p_expected_deposit_amount,2)<>p_expected_deposit_amount
 or nullif(btrim(p_reason),'') is null or length(p_reason)>2000
 or p_late_fee_treatment is null or p_late_fee_treatment not in ('historical_policy','no_correction_generated_fee')
 or (p_late_fee_treatment='no_correction_generated_fee' and nullif(btrim(p_late_fee_reason),'') is null)
 then raise exception 'Complete, finite expected values and explicit correction treatment/reason required.'; end if;
 request_data:=jsonb_build_array(p_resident_id,p_admission_id,p_payment_id,p_receipt_id,p_wrong_rent_bill_id,p_deposit_bill_id,
 p_expected_admission_date,p_correct_admission_date,p_expected_rent_due_date,p_historical_billing_month,
 p_expected_rent_amount,p_expected_deposit_amount,p_expected_payment_date,p_expected_verified_at,p_reason,p_late_fee_treatment,p_late_fee_reason);
 perform public.lock_financial_ledger();
 select * into prior from public.rent_period_corrections where id=p_correction_id;
 if found then
   if prior.request is distinct from request_data then raise exception 'Correction ID already used with different inputs.'; end if;
   return jsonb_build_object('correction_id',prior.id,'replacement_payment_id',prior.replacement_payment_id,
     'historical_rent_bill_id',prior.historical_rent_bill_id,'replayed',true);
 end if;
 if exists(select 1 from public.rent_period_corrections where original_payment_id=p_payment_id
   or replacement_payment_id=p_payment_id or original_receipt_id=p_receipt_id) then raise exception 'Payment/receipt already corrected.'; end if;
 select to_jsonb(x) into resident_before from public.residents x where id=p_resident_id for update;
 select * into a from public.admissions where id=p_admission_id for update;
 select * into p from public.payments where id=p_payment_id for update;
 select * into r from public.payment_receipts where id=p_receipt_id for update;
 select * into w from public.bills where id=p_wrong_rent_bill_id for update;
 select * into d from public.bills where id=p_deposit_bill_id for update;
 perform 1 from public.payment_allocations where payment_id=p_payment_id order by id for update;
 perform 1 from public.payment_status_history where payment_id=p_payment_id order by id for update;
 if a.id is null or a.resident_id<>p_resident_id or a.status not in ('Pending','Active') or a.deposit_status not in ('Pending','Held')
 or a.admission_date<>p_expected_admission_date or a.monthly_rent<>p_expected_rent_amount or a.security_deposit<>p_expected_deposit_amount
 or not exists(select 1 from public.residents where id=p_resident_id and status<>'Archived')
 or exists(select 1 from public.admissions where resident_id=p_resident_id and id<>a.id
   and (admission_date>=p_correct_admission_date or status in ('Pending','Active') or actual_leaving_date is null or actual_leaving_date>=p_correct_admission_date))
 then raise exception 'Current admission/date/terms mismatch or overlapping history.'; end if;
 if p.id is null or p.resident_id<>a.resident_id or p.bill_id is not null or p.payment_status<>'Verified' or p.verified is not true
 or p.amount<>p_expected_rent_amount+p_expected_deposit_amount or p.payment_date<>p_expected_payment_date
 or p.verified_at is distinct from p_expected_verified_at
 or r.id is null or r.payment_id is distinct from p.id or r.resident_id<>a.resident_id or r.bill_id is not null
 or r.status<>'Verified' or r.verified is not true or r.amount<>p.amount or r.additional_charge is not null
 or r.verified_at is distinct from p_expected_verified_at
 or (select count(*) from public.payment_receipts where payment_id=p.id)<>1
 then raise exception 'Expected verified combined payment/receipt mismatch.'; end if;
 if w.id is null or d.id is null or w.id=d.id or w.resident_id<>a.resident_id or d.resident_id<>a.resident_id
 or w.admission_id is distinct from a.id or d.admission_id is distinct from a.id
 or w.bill_type<>'Rent' or d.bill_type<>'Security Deposit' or w.bill_status<>'Paid' or d.bill_status<>'Paid'
 or w.total_amount<>p_expected_rent_amount or w.rent_amount<>p_expected_rent_amount or d.total_amount<>p_expected_deposit_amount
 or coalesce(w.electricity_amount,0)+coalesce(w.ac_amount,0)+coalesce(w.other_amount,0)+coalesce(w.discount_amount,0)<>0
 or w.due_date<>p_expected_rent_due_date or w.billing_month<>to_char(p_expected_admission_date,'YYYY-MM')
 or p_historical_billing_month>=w.billing_month
 or (select count(*) from public.bills where admission_id=a.id and bill_type='Rent' and billing_month=w.billing_month)<>1
 or (select count(*) from public.bills where admission_id=a.id and bill_type='Security Deposit')<>1
 then raise exception 'Expected canonical bill types, periods, amounts or dates mismatch.'; end if;
 -- Changing the admission anniversary affects other Rent periods too. Reject
 -- those cases rather than silently editing unrelated obligations/history.
 if exists(select 1 from public.bills where admission_id=a.id and bill_type='Rent'
   and id<>w.id and billing_month<>p_historical_billing_month
   and due_date is distinct from public.admission_rent_due_date(p_correct_admission_date,billing_month))
 then raise exception 'Other Rent due dates require separate reviewed correction.'; end if;
 if (select count(*) from public.payment_allocations where payment_id=p.id)<>2
 or not exists(select 1 from public.payment_allocations where payment_id=p.id and bill_id=w.id and amount=p_expected_rent_amount)
 or not exists(select 1 from public.payment_allocations where payment_id=p.id and bill_id=d.id and amount=p_expected_deposit_amount)
 or exists(select 1 from public.late_fee_payment_allocations where payment_id=p.id)
 or exists(select 1 from public.payment_followups where receipt_id=r.id)
 or public.effective_bill_paid(w.id,p.id)<>0 or public.effective_bill_paid(d.id,p.id)<>0
 or public.pending_bill_submissions(w.id)<>0 or public.pending_bill_submissions(d.id)<>0
 then raise exception 'Ambiguous credit, fine allocation, followup or pending reservation.'; end if;
 historical_due:=public.admission_rent_due_date(p_correct_admission_date,p_historical_billing_month);
 corrected_due:=public.admission_rent_due_date(p_correct_admission_date,w.billing_month);
 if historical_due is null or corrected_due is null or p_expected_payment_date>=corrected_due then raise exception 'Historical settlement overlaps the reopened period.'; end if;
 if (select count(*) from public.bills where admission_id=a.id and bill_type='Rent' and billing_month=p_historical_billing_month)>1 then raise exception 'Duplicate historical bills.'; end if;
 select * into h from public.bills where admission_id=a.id and bill_type='Rent' and billing_month=p_historical_billing_month for update;
 if h.id is not null and (h.resident_id<>a.resident_id or h.total_amount<>p_expected_rent_amount or h.rent_amount<>p_expected_rent_amount
 or h.due_date<>historical_due or h.bill_status not in ('Pending','Overdue')
 or coalesce(h.electricity_amount,0)+coalesce(h.ac_amount,0)+coalesce(h.other_amount,0)+coalesce(h.discount_amount,0)<>0
 or exists(select 1 from public.payment_allocations where bill_id=h.id)
 or exists(select 1 from public.payments where bill_id=h.id)
 or exists(select 1 from public.payment_receipts where bill_id=h.id)
 or exists(select 1 from public.payment_followups where bill_id=h.id)) then raise exception 'Historical bill is not an untouched matching obligation.'; end if;
 -- Never rewrite existing fee history. Those cases require separate review.
 if exists(select 1 from public.late_fees where bill_id=h.id or (bill_id=w.id and (calculated_amount<>0 or waived_amount<>0 or paid_amount<>0 or freeze_payment_id is not null))) then raise exception 'Existing Rent late-fee history requires separate review.'; end if;
 select jsonb_agg(to_jsonb(x) order by id) into original_allocations from public.payment_allocations x where payment_id=p.id;
 select jsonb_agg(to_jsonb(x) order by id) into original_history from public.payment_status_history x where payment_id=p.id;
 select jsonb_agg(to_jsonb(x) order by id) into contracts_before from public.contracts x where admission_id=a.id;
 select jsonb_agg(to_jsonb(x) order by id) into fees_before from public.late_fees x where bill_id=w.id;
 before_data:=jsonb_build_object('admission',to_jsonb(a),'payment',to_jsonb(p),'receipt',to_jsonb(r),
   'wrong_rent_bill',to_jsonb(w),'deposit_bill',to_jsonb(d),'historical_bill',case when h.id is null then null else to_jsonb(h) end,
   'allocations',original_allocations,'payment_history',original_history);
 update public.admissions set admission_date=p_correct_admission_date where id=a.id;
 if h.id is null then
   insert into public.bills(bill_number,resident_id,admission_id,bill_type,billing_month,due_date,rent_amount,total_amount,bill_status,notes)
   values('RENT-CORR-'||p_correction_id::text,a.resident_id,a.id,'Rent',p_historical_billing_month,historical_due,
     p_expected_rent_amount,p_expected_rent_amount,'Pending','Historical obligation; correction '||p_correction_id::text)
   returning * into h;
 end if;
 update public.bills set due_date=corrected_due where id=w.id;
 insert into public.rent_period_corrections(id,resident_id,admission_id,original_payment_id,original_receipt_id,
 replacement_payment_id,wrong_rent_bill_id,historical_rent_bill_id,deposit_bill_id,settlement_date,
 late_fee_treatment,late_fee_reason,reason,request,before_state,actor_id,actor_email)
 values(p_correction_id,a.resident_id,a.id,p.id,r.id,replacement,w.id,h.id,d.id,p.payment_date,
 p_late_fee_treatment,p_late_fee_reason,p_reason,request_data,before_data,auth.uid(),actor);
 perform public.cancel_payment_with_allocations(p.id,actor,'Rent period correction '||p_correction_id::text||': '||p_reason);
 insert into public.payments(id,payment_number,resident_id,bill_id,payment_date,amount,payment_method,notes)
 values(replacement,'PAY-CORR-'||p_correction_id::text,a.resident_id,null,p.payment_date,p.amount,p.payment_method,
   'Replacement of payment '||p.id::text||'; original receipt '||r.id::text||'; correction '||p_correction_id::text||': '||p_reason);
 insert into public.payment_allocations(payment_id,bill_id,amount) values
 (replacement,h.id,p_expected_rent_amount),(replacement,d.id,p_expected_deposit_amount);
 update public.payments set payment_status='Verified',verified_by=actor,verified_at=p.verified_at where id=replacement;
 perform public.refresh_bill_financials(w.id);
 perform public.refresh_bill_financials(h.id);
 perform public.refresh_bill_financials(d.id);
 if public.effective_bill_paid(w.id)<>0 or public.effective_bill_paid(h.id)<>p_expected_rent_amount
 or public.effective_bill_paid(d.id)<>p_expected_deposit_amount
 or not exists(select 1 from public.bills where id=w.id and total_amount=p_expected_rent_amount and balance_amount=p_expected_rent_amount)
 or not exists(select 1 from public.bills where id=h.id and balance_amount=0 and bill_status='Paid')
 or not exists(select 1 from public.bills where id=d.id and balance_amount=0 and bill_status='Paid')
 or not exists(select 1 from public.admissions where id=a.id and admission_date=p_correct_admission_date and deposit_status='Held' and status=a.status)
 or not exists(select 1 from public.payments where id=p.id and payment_status='Cancelled')
 or not exists(select 1 from public.payments where id=replacement and payment_status='Verified' and amount=p.amount and payment_date=p.payment_date and verified_at=p.verified_at)
 or to_jsonb(r) is distinct from (select to_jsonb(x) from public.payment_receipts x where id=r.id)
 or resident_before is distinct from (select to_jsonb(x) from public.residents x where id=a.resident_id)
 or not (coalesce((select jsonb_agg(to_jsonb(x) order by id) from public.payment_status_history x where payment_id=p.id),'[]'::jsonb) @> coalesce(original_history,'[]'::jsonb))
 or not exists(select 1 from public.payment_status_history where payment_id=p.id and previous_status='Verified' and next_status='Cancelled')
 or (select coalesce(sum(pa.amount),0) from public.payment_allocations pa join public.payments x on x.id=pa.payment_id where x.id in(p.id,replacement) and x.payment_status='Verified')<>p.amount
 or (select count(*) from public.bills where admission_id=a.id and bill_type='Rent' and billing_month=p_historical_billing_month)<>1
 or original_allocations is distinct from (select jsonb_agg(to_jsonb(x) order by id) from public.payment_allocations x where payment_id=p.id)
 or contracts_before is distinct from (select jsonb_agg(to_jsonb(x) order by id) from public.contracts x where admission_id=a.id)
 or fees_before is distinct from (select jsonb_agg(to_jsonb(x) order by id) from public.late_fees x where bill_id=w.id)
 or (p_late_fee_treatment='no_correction_generated_fee' and exists(select 1 from public.late_fees where bill_id=h.id))
 then raise exception 'Correction final-state assertion failed; transaction rolled back.'; end if;
 return jsonb_build_object('correction_id',p_correction_id,'replacement_payment_id',replacement,'historical_rent_bill_id',h.id,'replayed',false);
end; $$;
revoke all on function public.correct_rent_payment_period(uuid,uuid,uuid,uuid,uuid,uuid,uuid,date,date,date,text,numeric,numeric,date,timestamptz,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.correct_rent_payment_period(uuid,uuid,uuid,uuid,uuid,uuid,uuid,date,date,date,text,numeric,numeric,date,timestamptz,text,text,text) to authenticated;

-- Ledger guard definition follows, with only its fee-preservation call changed.

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
         and not (b.bill_type = 'Rent' and exists (select 1 from public.payment_receipts r
           where r.payment_id = new.id and r.additional_charge is not null))
         and obligation.amount <> b.total_amount - public.effective_bill_paid(b.id, new.id)
         and not exists(select 1 from public.payment_followups f join public.payment_receipts r on r.id=f.receipt_id
           where r.payment_id=new.id and f.bill_id=b.id and f.kind='commitment')
         and not exists(select 1 from public.payment_receipts r where r.payment_id=new.id and r.available_balance_submission is true) then
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
          perform public.preserve_rent_fee_for_credit(b.id,new.id,
            coalesce(auth.jwt()->>'email',nullif(new.verified_by,''),'system'));
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

commit;
