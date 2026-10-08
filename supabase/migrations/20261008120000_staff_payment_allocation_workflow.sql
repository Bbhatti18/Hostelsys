-- Infrastructure only. No backfill, correction or production fixture is executed.
begin;
create table public.staff_payment_allocation_audit (
 id uuid primary key, action text not null check(action in ('verify','correct')),
 original_payment_id uuid not null references public.payments(id),
 replacement_payment_id uuid references public.payments(id) deferrable initially deferred,
 receipt_id uuid references public.payment_receipts(id), admission_id uuid not null references public.admissions(id),
 resident_id uuid not null references public.residents(id), actor text not null, reason text not null,
 fee_exception_reason text, request jsonb not null, before_state jsonb not null,
 selected_items jsonb not null, created_at timestamptz not null default now()
);
alter table public.staff_payment_allocation_audit enable row level security;
revoke all on public.staff_payment_allocation_audit from public,anon,authenticated,service_role;
grant select on public.staff_payment_allocation_audit to authenticated;
create policy staff_allocation_audit_read on public.staff_payment_allocation_audit for select to authenticated
 using (public.is_admin_user());
create trigger staff_allocation_audit_immutable before update or delete on public.staff_payment_allocation_audit
 for each row execute function public.protect_rent_period_correction();
create unique index staff_allocation_original_correction on public.staff_payment_allocation_audit(original_payment_id) where action='correct';
create unique index staff_allocation_replacement on public.staff_payment_allocation_audit(replacement_payment_id) where replacement_payment_id is not null;

-- Explicit exceptions affect only the selected historical rent credit, once.
-- Existing rent-period correction behavior and normal future policy are preserved.
create or replace function public.preserve_rent_fee_for_credit(p_bill uuid,p_payment uuid,p_actor text)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare c public.rent_period_corrections%rowtype;
begin
 if exists(select 1 from public.staff_payment_allocation_audit x join public.payments p on p.id=x.replacement_payment_id
 join public.bills b on b.id=p_bill where x.replacement_payment_id=p_payment and x.action='correct'
 and x.fee_exception_reason is not null and x.xmin::text=pg_current_xact_id()::text
 and b.bill_type='Rent' and b.billing_month<=to_char(p.payment_date,'YYYY-MM') and b.due_date<=p.payment_date
 and exists(select 1 from jsonb_array_elements(x.selected_items) i where i->>'bill_id'=p_bill::text)) then return; end if;
 select * into c from public.rent_period_corrections where replacement_payment_id=p_payment and historical_rent_bill_id=p_bill
 and xmin::text=pg_current_xact_id()::text;
 if found then
   if c.late_fee_treatment='historical_policy' then perform public.refresh_late_fee(p_bill,c.settlement_date,p_actor,'Historical settlement; correction '||c.id::text); end if;
 else
   perform public.refresh_late_fee(p_bill,(now() at time zone 'Asia/Karachi')::date,p_actor,
     'Preserved accrued fine before rent verification; payment '||p_payment::text);
 end if;
end; $$;

create function public.require_allocation_actor(p_actor text,p_admin boolean default false) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if coalesce(auth.role(),'')<>'service_role' or
 (select count(*) from public.staff_users where lower(btrim(email))=p_actor and lower(status)='active'
 and lower(role)=any(case when p_admin then array['admin','super admin'] else array['admin','super admin','accountant'] end))<>1
 then raise exception 'Authorized active staff server required.' using errcode='42501'; end if;
end; $$;

create function public.staff_allocation_snapshot(p_payment uuid,p_receipt uuid,p_actor text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare p public.payments%rowtype; r public.payment_receipts%rowtype; a public.admissions%rowtype;
 own numeric; rows jsonb:='[]'; b public.bills%rowtype; paid numeric; pending numeric;
 evidence_admissions text[];
begin
 perform public.require_allocation_actor(p_actor);
 perform public.lock_financial_ledger();
 if p_receipt is not null then select * into r from public.payment_receipts where id=p_receipt;
   if r.id is null then raise exception 'Receipt unavailable.'; end if;
   if p_payment is not null and p_payment is distinct from r.payment_id then raise exception 'Receipt/payment mismatch.'; end if;
   p_payment:=r.payment_id;
 end if;
 select * into p from public.payments where id=p_payment;
 if r.id is null and p.id is not null then
   if (select count(*) from public.payment_receipts where payment_id=p.id)>1 then raise exception 'Multiple evidence links require review.'; end if;
   select * into r from public.payment_receipts where payment_id=p.id;
 end if;
 if p.id is null and r.id is null then raise exception 'Payment unavailable.'; end if;
 select * into a from public.admissions where resident_id=coalesce(p.resident_id,r.resident_id)
 order by admission_date desc,created_at desc,id desc limit 1;
 if a.id is null or a.status not in ('Pending','Active') or exists(select 1 from public.residents where id=a.resident_id and status='Archived') then raise exception 'Current admission required.'; end if;
 -- Wholly unlinked legacy evidence still carries an explicit admission in notes.
 -- Never retarget an old admission's deposit proof to the current admission.
 if p.id is null and r.bill_id is null then
   select array_agg(lower(btrim(substring(line from 14)))) into evidence_admissions
   from regexp_split_to_table(coalesce(r.notes,''),E'\r?\n') line where line ~* '^Admission ID:';
   if evidence_admissions is not null and (cardinality(evidence_admissions)<>1 or evidence_admissions[1] is distinct from a.id::text) then
     raise exception 'Original evidence belongs to a different or ambiguous admission; settlement review required.';
   end if;
 end if;
 if exists(select 1 from public.bills x where (x.id=p.bill_id or x.id=r.bill_id or x.id in
   (select bill_id from public.payment_allocations where payment_id=p.id)) and
   (x.admission_id is distinct from a.id or x.resident_id is distinct from a.resident_id)) then raise exception 'Original evidence belongs to a different admission; settlement review required.'; end if;
 for b in select * from public.bills where admission_id=a.id and resident_id=a.resident_id
 and bill_type in ('Rent','Security Deposit','Other Charges') and bill_status in ('Pending','Overdue','Partially Paid','Paid') order by billing_month,id loop
   paid:=public.effective_bill_paid(b.id);
   pending:=public.pending_bill_submissions(b.id);
   own:=0;
   if p.payment_status='Pending' then
     if p.bill_id=b.id then own:=p.amount;
     elsif p.bill_id is null then select coalesce(sum(amount),0) into own from public.payment_allocations where payment_id=p.id and bill_id=b.id; end if;
   elsif p.id is null and r.status='Pending Verification' and public.pending_receipt_matches_bill(r.id,b.id) then own:=r.amount;
   end if;
   rows:=rows||jsonb_build_array(jsonb_build_object('bill_id',b.id,'bill_type',b.bill_type,'billing_month',b.billing_month,
     'due_date',b.due_date,'total',b.total_amount,'verified',paid,'pending',pending,
     'available',greatest(b.total_amount-public.effective_bill_paid(b.id,p.id)-pending+own,0)));
 end loop;
 return jsonb_build_object('payment',case when p.id is null then null else to_jsonb(p) end,
 'receipt',case when r.id is null then null else to_jsonb(r)-'receipt_url' end,'admission_id',a.id,
 'resident_id',a.resident_id,'amount',coalesce(p.amount,r.amount),'obligations',rows,
 'fingerprint',md5(coalesce(to_jsonb(p)::text,'')||coalesce(to_jsonb(r)::text,'')||
   coalesce((select jsonb_agg(to_jsonb(pa) order by pa.bill_id,pa.id)::text from public.payment_allocations pa where payment_id=p.id),'[]')),
 'allocations',coalesce((select jsonb_agg(jsonb_build_object('bill_id',bill_id,'amount',amount)) from public.payment_allocations where payment_id=p.id),
 case when coalesce(p.bill_id,r.bill_id) is not null then jsonb_build_array(jsonb_build_object('bill_id',coalesce(p.bill_id,r.bill_id),'amount',coalesce(p.amount,r.amount))) else '[]'::jsonb end),
 'fine_linked',exists(select 1 from public.late_fee_payment_allocations where payment_id=p.id or receipt_id=r.id),
 'already_corrected',exists(select 1 from public.rent_period_corrections where original_payment_id=p.id or replacement_payment_id=p.id)
 or exists(select 1 from public.staff_payment_allocation_audit where action='correct' and (original_payment_id=p.id or replacement_payment_id=p.id)));
end; $$;

create function public.apply_staff_payment_allocation(p_request_id uuid,p_payment uuid,p_receipt uuid,
 p_action text,p_items jsonb,p_expected text,p_reason text,p_fee_exception_reason text,p_actor text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare s jsonb; p public.payments%rowtype; r public.payment_receipts%rowtype; b public.bills%rowtype;
 item jsonb; obligation jsonb; total numeric:=0; amount numeric; pay uuid; original uuid;
 old_bills uuid[]; request_data jsonb; prior public.staff_payment_allocation_audit%rowtype;
 before_data jsonb; timestamp_at timestamptz;
begin
 perform public.require_allocation_actor(p_actor,p_action='correct');
 if p_action is null or p_action not in ('verify','correct') or p_request_id is null or nullif(btrim(p_reason),'') is null or length(p_reason)>2000 then raise exception 'Action, request ID and reason required.'; end if;
 perform public.lock_financial_ledger();
 request_data:=jsonb_build_array(p_payment,p_receipt,p_action,p_items,p_expected,p_reason,p_fee_exception_reason,p_actor);
 select * into prior from public.staff_payment_allocation_audit where id=p_request_id;
 if found then
   if prior.request is distinct from request_data then raise exception 'Request ID reused with different inputs.'; end if;
   return jsonb_build_object('payment_id',coalesce(prior.replacement_payment_id,prior.original_payment_id),'replayed',true);
 end if;
 s:=public.staff_allocation_snapshot(p_payment,p_receipt,p_actor);
 if s->>'fingerprint' is distinct from p_expected or (s->>'fine_linked')::boolean then raise exception 'Payment changed or has a Late Fee allocation; use the existing fine workflow.'; end if;
 if (s->>'already_corrected')::boolean then raise exception 'Previously corrected payments require separate settlement review.'; end if;
 if p_receipt is not null then select * into r from public.payment_receipts where id=p_receipt for update; p_payment:=r.payment_id; end if;
 select * into p from public.payments where id=p_payment for update;
 if p_action='verify' and (coalesce(p.payment_status,'Pending')<>'Pending' or (r.id is not null and r.status<>'Pending Verification')) then raise exception 'Payment/receipt is no longer pending.' using errcode='40001'; end if;
 if p_action='correct' and (p.id is null or p.payment_status<>'Verified' or p.verified is not true or p.verified_at is null) then raise exception 'Verified payment required.'; end if;
 if r.id is not null and (r.resident_id is distinct from p.resident_id and p.id is not null
 or (p.id is not null and r.amount<>p.amount) or (p_action='correct' and (r.status<>'Verified' or r.verified is not true))) then raise exception 'Receipt evidence and financial status mismatch.'; end if;
 if exists(select 1 from public.payment_receipts where payment_id=p.id and additional_charge is not null
   and (p_action='verify' or additional_charge->'confirmed' is null)) or
   (r.additional_charge is not null and (p_action='verify' or r.additional_charge->'confirmed' is null)) then raise exception 'Unclassified Additional Charges must use the existing confirmation workflow.'; end if;
 if exists(select 1 from public.payment_receipts where payment_id=p.id and id is distinct from r.id) then raise exception 'Select the linked receipt; multiple evidence links require review.'; end if;
 if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 20
 or (select count(distinct x->>'bill_id') from jsonb_array_elements(p_items) x)<>jsonb_array_length(p_items) then raise exception 'Select unique exact bills.'; end if;
 for item in select * from jsonb_array_elements(p_items) loop
   select * into b from public.bills where id=(item->>'bill_id')::uuid for update;
   select x into obligation from jsonb_array_elements(s->'obligations') x where x->>'bill_id'=item->>'bill_id';
   amount:=(item->>'amount')::numeric;
   if b.id is null or obligation is null or b.admission_id::text is distinct from s->>'admission_id'
   or b.resident_id::text is distinct from s->>'resident_id' or b.bill_type is distinct from item->>'bill_type'
   or b.billing_month is distinct from item->>'billing_month' or b.due_date::text is distinct from item->>'due_date'
   or (b.bill_type='Security Deposit' and not exists(select 1 from public.admissions where id=b.admission_id and deposit_status in ('Pending','Held')))
   or amount is null or amount::text in ('NaN','Infinity','-Infinity') or amount<=0 or round(amount,2)<>amount
   or amount>(obligation->>'available')::numeric then raise exception 'Stale, wrong month, wrong admission or unavailable bill amount.'; end if;
   if p_fee_exception_reason is not null and b.bill_type='Rent' and
    (p_action<>'correct' or b.billing_month>to_char(p.payment_date,'YYYY-MM') or b.due_date>p.payment_date
     or exists(select 1 from public.late_fees where bill_id=b.id)) then raise exception 'Historical exception cannot waive future periods or existing fee history.'; end if;
   total:=total+amount;
 end loop;
 if total is distinct from (s->>'amount')::numeric then raise exception 'Exact allocation total must equal payment amount.'; end if;
 if p_fee_exception_reason is not null and (p_action<>'correct' or nullif(btrim(p_fee_exception_reason),'') is null or length(p_fee_exception_reason)>2000) then raise exception 'Separate Admin historical fee authorization reason required.'; end if;
 before_data:=jsonb_build_object('snapshot',s,'payment',to_jsonb(p),'receipt',to_jsonb(r),
 'history',(select jsonb_agg(to_jsonb(h)) from public.payment_status_history h where payment_id=p.id),
 'allocations',(select jsonb_agg(to_jsonb(x)) from public.payment_allocations x where payment_id=p.id));
 select array_agg(distinct bill_id) into old_bills from public.payment_allocations where payment_id=p.id;
 old_bills:=array_append(coalesce(old_bills,'{}'),p.bill_id);
 if p.id is null then
   pay:=gen_random_uuid();
   insert into public.payments(id,payment_number,resident_id,amount,payment_method,payment_date,reference_number,notes)
   values(pay,'PAY-ALLOC-'||pay::text,r.resident_id,r.amount,
   coalesce(nullif(btrim(substring(r.notes from E'Payment method:[ \\t]*([^\\n\\r]+)')),''),case when nullif(r.reference_number,'') is null then 'Cash' else 'Bank' end),
   coalesce((r.created_at at time zone 'Asia/Karachi')::date,current_date),r.reference_number,'Staff allocation of receipt '||r.id::text);
   select * into p from public.payments where id=pay;
 end if;
 original:=p.id; pay:=p.id; timestamp_at:=now();
 if p_action='correct' then
   pay:=gen_random_uuid(); timestamp_at:=p.verified_at;
   perform public.cancel_payment_with_allocations(p.id,p_actor,p_reason);
   insert into public.payments(id,payment_number,resident_id,amount,payment_method,payment_date,notes)
   values(pay,'PAY-ALLOC-'||p_request_id::text,p.resident_id,p.amount,p.payment_method,p.payment_date,'Replacement of '||p.id::text||': '||p_reason);
 else
   update public.payments set bill_id=null where id=pay;
   delete from public.payment_allocations where payment_id=pay;
 end if;
 insert into public.staff_payment_allocation_audit(id,action,original_payment_id,replacement_payment_id,receipt_id,admission_id,resident_id,
 actor,reason,fee_exception_reason,request,before_state,selected_items)
 values(p_request_id,p_action,original,case when p_action='correct' then pay end,r.id,(s->>'admission_id')::uuid,
 (s->>'resident_id')::uuid,p_actor,p_reason,p_fee_exception_reason,request_data,before_data,p_items);
 for item in select * from jsonb_array_elements(p_items) loop
   insert into public.payment_allocations(payment_id,bill_id,amount) values(pay,(item->>'bill_id')::uuid,(item->>'amount')::numeric);
 end loop;
 if p_action='verify' and r.id is not null then update public.payment_receipts set payment_id=pay,
 bill_id=case when jsonb_array_length(p_items)=1 then (p_items->0->>'bill_id')::uuid end where id=r.id; end if;
 update public.payments set payment_status='Verified',verified_by=p_actor,verified_at=timestamp_at where id=pay;
 if p_action='verify' and r.id is not null then update public.payment_receipts set status='Verified',verified=true,verified_by=p_actor,verified_at=timestamp_at where id=r.id; end if;
 for b in select * from public.bills where id=any(old_bills) or id in(select (x->>'bill_id')::uuid from jsonb_array_elements(p_items) x) loop
   perform public.refresh_bill_financials(b.id);
 end loop;
 if p_action='correct' and r.id is not null and to_jsonb(r) is distinct from (select to_jsonb(x) from public.payment_receipts x where id=r.id) then raise exception 'Historical evidence changed; rollback.'; end if;
 if (select sum(x.amount) from public.payment_allocations x where x.payment_id=pay)<>p.amount
 or not exists(select 1 from public.payments where id=pay and payment_status='Verified')
 or (p_action='correct' and not exists(select 1 from public.payments where id=original and payment_status='Cancelled')) then raise exception 'Credit integrity assertion failed.'; end if;
 return jsonb_build_object('payment_id',pay,'audit_id',p_request_id,'replayed',false,'notification_supported',jsonb_array_length(p_items)=1);
end; $$;

-- Scope partial-allocation authorization to the immutable audited transaction.
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
         and not exists(select 1 from public.payment_receipts r where r.payment_id=new.id and r.available_balance_submission is true)
         and not exists(select 1 from public.staff_payment_allocation_audit x
           where coalesce(x.replacement_payment_id,x.original_payment_id)=new.id
           and x.xmin::text=pg_current_xact_id()::text) then
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

create function public.generate_missing_staff_rent(p_admission uuid,p_month text,p_actor text) returns uuid
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.admissions%rowtype; amount numeric; key uuid:=gen_random_uuid();
begin
 perform public.require_allocation_actor(p_actor,true);
 perform public.lock_financial_ledger();
 select * into a from public.admissions where id=p_admission for update;
 if a.id is null or a.status not in ('Pending','Active') or p_month is null or p_month !~ '^\d{4}-(0[1-9]|1[0-2])$'
 or p_month<to_char(a.admission_date,'YYYY-MM') or p_month>to_char((now() at time zone 'Asia/Karachi')::date,'YYYY-MM')
 or exists(select 1 from public.residents where id=a.resident_id and status='Archived')
 or exists(select 1 from public.admissions n where n.resident_id=a.resident_id and (n.admission_date,n.created_at,n.id)>(a.admission_date,a.created_at,a.id)) then raise exception 'Current admission and missing elapsed/current month required.'; end if;
 if exists(select 1 from public.bills where admission_id=a.id and bill_type='Rent' and billing_month=p_month) then raise exception 'Rent bill already exists, including cancelled or paid history.'; end if;
 amount:=a.monthly_rent;
 if amount is null or amount<=0 then select monthly_rent into amount from public.contracts where admission_id=a.id and status not in ('Cancelled','Terminated') order by created_at desc,id desc limit 1; end if;
 if amount is null or amount<=0 then raise exception 'Canonical monthly rent is missing.'; end if;
 insert into public.bills(id,bill_number,resident_id,admission_id,bill_type,billing_month,due_date,rent_amount,total_amount,bill_status,notes)
 values(key,'RENT-MISSING-'||key::text,a.resident_id,a.id,'Rent',p_month,public.admission_rent_due_date(a.admission_date,p_month),amount,amount,'Pending Approval','Missing rent generated by '||p_actor||'; rent only; utilities use their existing workflow.');
 return key;
end; $$;
-- Safe display linkage for finance staff; raw before-state snapshots stay Admin-only.
create function public.staff_correction_history(p_actor text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare result jsonb;
begin
 perform public.require_allocation_actor(p_actor);
 select coalesce(jsonb_agg(row),'[]'::jsonb) into result from (
 select jsonb_build_object('id',id,'resident_id',resident_id,'admission_id',admission_id,'original_payment_id',original_payment_id,
 'replacement_payment_id',replacement_payment_id,'wrong_rent_bill_id',wrong_rent_bill_id,'reason',reason,'actor',actor_email,'created_at',created_at,
 'fee_exception_reason',case when late_fee_treatment='no_correction_generated_fee' then late_fee_reason end) row
 from public.rent_period_corrections
 union all
 select jsonb_build_object('id',id,'resident_id',resident_id,'admission_id',admission_id,'original_payment_id',original_payment_id,
 'replacement_payment_id',replacement_payment_id,'reason',reason,'actor',actor,'created_at',created_at,'fee_exception_reason',fee_exception_reason,
 'original_bill_ids',(select jsonb_agg(x->>'bill_id') from jsonb_array_elements(before_state->'snapshot'->'allocations') x))
 from public.staff_payment_allocation_audit where action='correct'
 ) q;
 return result;
end; $$;
revoke all on function public.require_allocation_actor(text,boolean) from public,anon,authenticated,service_role;
revoke all on function public.staff_allocation_snapshot(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.apply_staff_payment_allocation(uuid,uuid,uuid,text,jsonb,text,text,text,text) from public,anon,authenticated;
revoke all on function public.generate_missing_staff_rent(uuid,text,text) from public,anon,authenticated;
grant execute on function public.staff_allocation_snapshot(uuid,uuid,text), public.apply_staff_payment_allocation(uuid,uuid,uuid,text,jsonb,text,text,text,text), public.generate_missing_staff_rent(uuid,text,text) to service_role;
revoke all on function public.staff_correction_history(text) from public,anon,authenticated;
grant execute on function public.staff_correction_history(text) to service_role;
commit;
