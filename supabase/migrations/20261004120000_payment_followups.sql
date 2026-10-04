-- Non-financial follow-ups. No backfill and no changes to existing obligations.
begin;
create table public.payment_followups (
 id uuid primary key default gen_random_uuid(),
 bill_id uuid not null references public.bills(id),
 receipt_id uuid references public.payment_receipts(id),
 kind text not null check(kind in ('commitment','request')),
 amount numeric(12,2) not null check(amount > 0),
 due_date date not null, note text not null check(length(btrim(note)) > 0),
 actor text not null, created_at timestamptz not null default now()
);
alter table public.payment_followups enable row level security;
revoke all on public.payment_followups from public,anon,authenticated,service_role;
create index payment_followups_bill on public.payment_followups(bill_id,created_at);

-- Matches the role/status checks in app/api/payment-verification/route.ts.
-- Request permission alone must never authorize receipt rejection.
create function public.can_reject_followup_receipt() returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
 select auth.role()='authenticated' and auth.uid() is not null and exists (
   select 1 from public.staff_users s
   where s.email=lower(btrim(coalesce(auth.jwt()->>'email','')))
   and lower(btrim(s.status))='active'
   and lower(btrim(s.role)) in ('super admin','admin','accountant')
 );
$$;
revoke all on function public.can_reject_followup_receipt() from public,anon,authenticated,service_role;

-- One association rule for pending capacity, replacement choices and rejection.
-- Canonical links take precedence; notes are used only for wholly unlinked proofs.
create function public.pending_receipt_matches_bill(p_receipt uuid,p_bill uuid) returns boolean
language plpgsql volatile security definer set search_path=pg_catalog,public as $$
declare r public.payment_receipts%rowtype; b public.bills%rowtype; p public.payments%rowtype;
 purposes text[]; admissions text[];
begin
 select * into r from public.payment_receipts where id=p_receipt;
 select * into b from public.bills where id=p_bill;
 if r.id is null or b.id is null or r.status is distinct from 'Pending Verification'
   or r.resident_id is distinct from b.resident_id then return false; end if;
 if r.payment_id is not null then
   select * into p from public.payments where id=r.payment_id;
   if p.id is null or p.resident_id is distinct from b.resident_id or p.payment_status is distinct from 'Pending' then return false; end if;
   if p.bill_id is not null then
     return p.bill_id=b.id and r.bill_id is not distinct from p.bill_id
       and (not exists(select 1 from public.payment_allocations where payment_id=p.id)
         or exists(select 1 from public.payment_allocations where payment_id=p.id and bill_id=b.id and amount>0));
   end if;
   return (r.bill_id is null or r.bill_id=b.id)
     and exists(select 1 from public.payment_allocations where payment_id=p.id and bill_id=b.id and amount>0);
 end if;
 if r.bill_id is not null then return r.bill_id=b.id; end if;
 if b.bill_type<>'Security Deposit' then return false; end if;
 select array_agg(btrim(substring(line from 17))) filter(where line ~* '^Payment purpose:'),
        array_agg(btrim(substring(line from 14))) filter(where line ~* '^Admission ID:')
 into purposes,admissions from regexp_split_to_table(coalesce(r.notes,''),E'\r?\n') line;
 -- Reject missing, duplicated or contradictory metadata, even repeated IDs.
 if cardinality(purposes) is distinct from 1 or cardinality(admissions) is distinct from 1
   or purposes[1] is distinct from 'Security Deposit'
   or lower(admissions[1]) is distinct from b.admission_id::text then return false; end if;
 return (select count(*)=1 from public.bills candidate where candidate.resident_id=b.resident_id
   and candidate.admission_id=b.admission_id and candidate.bill_type='Security Deposit'
   and candidate.bill_status not in ('Draft','Pending Approval','Cancelled','Archived'))
   and b.bill_status not in ('Draft','Pending Approval','Cancelled','Archived');
end; $$;
revoke all on function public.pending_receipt_matches_bill(uuid,uuid) from public,anon,authenticated,service_role;

create function public.pending_bill_submissions(p_bill uuid) returns numeric
language sql volatile security definer set search_path=pg_catalog,public as $$
 select coalesce(sum(amount),0) from (
 select pa.amount from public.payment_allocations pa join public.payments p on p.id=pa.payment_id
 where pa.bill_id=p_bill and p.payment_status='Pending'
 union all select p.amount from public.payments p where p.bill_id=p_bill and p.payment_status='Pending'
 and not exists(select 1 from public.payment_allocations pa where pa.payment_id=p.id)
 union all select r.amount from public.payment_receipts r where r.payment_id is null and public.pending_receipt_matches_bill(r.id,p_bill)
 ) pending;
$$;
revoke all on function public.pending_bill_submissions(uuid) from public,anon,authenticated;

create function public.payment_followup_data() returns jsonb
language plpgsql volatile security definer set search_path=pg_catalog,public as $$
declare result jsonb; staff boolean;
begin
 if auth.role()<>'authenticated' or auth.uid() is null then raise exception 'Authentication required.' using errcode='42501'; end if;
 staff := public.staff_can_operate('payments',array['manager','accountant']::text[]);
 select coalesce(jsonb_agg(row_data),'[]') into result from (
 select jsonb_build_object('bill_id',b.id,'admission_id',a.id,'resident',r.full_name,
 'purpose',case when b.bill_type='Other Charges' then 'Additional Charges' else b.bill_type end,
 'billing_month',b.billing_month,'original',b.total_amount,'verified',public.effective_bill_paid(b.id),
 'pending',public.pending_bill_submissions(b.id),'remaining',greatest(b.total_amount-public.effective_bill_paid(b.id),0),
 'available',greatest(b.total_amount-public.effective_bill_paid(b.id)-public.pending_bill_submissions(b.id),0),
 'followups',coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'kind',f.kind,'amount',f.amount,
   'receipt_id',f.receipt_id,'due_date',f.due_date,'note',f.note,'receipt_status',pr.status,
   'status',case when public.effective_bill_paid(b.id)>=b.total_amount then 'Resolved'
     when f.due_date<(now() at time zone 'Asia/Karachi')::date then 'Overdue'
     when f.due_date=(now() at time zone 'Asia/Karachi')::date then 'Due Today' else 'Open' end)
   order by f.created_at desc) from public.payment_followups f left join public.payment_receipts pr on pr.id=f.receipt_id where f.bill_id=b.id),'[]'),
 'pending_receipts',coalesce((select jsonb_agg(jsonb_build_object('id',pr.id,'amount',pr.amount))
   from public.payment_receipts pr where staff and public.can_reject_followup_receipt()
   and public.pending_receipt_matches_bill(pr.id,b.id)),'[]')) row_data
 from public.bills b join public.admissions a on a.id=b.admission_id and a.resident_id=b.resident_id
 join public.residents r on r.id=b.resident_id
 where a.status in ('Pending','Active') and r.status<>'Archived'
 and b.bill_status not in ('Draft','Pending Approval','Cancelled','Archived')
 and not exists(select 1 from public.admissions n where n.resident_id=a.resident_id and (n.admission_date,n.created_at,n.id)>(a.admission_date,a.created_at,a.id))
 and (b.bill_type<>'Security Deposit' or a.deposit_status in ('Pending','Held'))
 and (staff or r.id=public.current_resident_id())
 ) rows;
 return result;
end; $$;
revoke all on function public.payment_followup_data() from public,anon,authenticated,service_role;
grant execute on function public.payment_followup_data() to authenticated;

create function public.request_obligation_payment(p_bill uuid,p_amount numeric,p_due date,p_note text,p_replace_receipt uuid default null)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare b public.bills%rowtype; r public.payment_receipts%rowtype; result uuid;
begin
 if auth.role()<>'authenticated' or auth.uid() is null or not public.staff_can_operate('payments',array['manager','accountant']::text[]) then
 raise exception 'Active payment staff permission required.' using errcode='42501'; end if;
 perform public.lock_financial_ledger();
 select * into b from public.bills where id=p_bill for update;
 if b.id is null or b.bill_status in ('Draft','Pending Approval','Cancelled','Archived') or
 not exists(select 1 from public.admissions a join public.residents resident on resident.id=a.resident_id
 where a.id=b.admission_id and a.resident_id=b.resident_id and a.status in ('Pending','Active') and resident.status<>'Archived'
 and (b.bill_type<>'Security Deposit' or a.deposit_status in ('Pending','Held'))
 and not exists(select 1 from public.admissions n where n.resident_id=a.resident_id and (n.admission_date,n.created_at,n.id)>(a.admission_date,a.created_at,a.id))) then raise exception 'Current payable obligation required.'; end if;
 if p_amount is null or p_amount::text in ('NaN','Infinity','-Infinity') or p_amount<=0 or round(p_amount,2)<>p_amount or p_amount>b.total_amount-public.effective_bill_paid(b.id)
 or p_due is null or not isfinite(p_due) or p_due<(now() at time zone 'Asia/Karachi')::date or coalesce(btrim(p_note),'')='' then raise exception 'Valid outstanding amount, due date and note required.'; end if;
 if p_replace_receipt is not null then
   if public.can_reject_followup_receipt() is not true then raise exception 'Receipt rejection permission required.' using errcode='42501'; end if;
   select * into r from public.payment_receipts where id=p_replace_receipt and resident_id=b.resident_id and status='Pending Verification' for update;
   if r.id is null or public.pending_receipt_matches_bill(r.id,b.id) is not true then raise exception 'Pending receipt does not belong to this obligation.'; end if;
   if exists(select 1 from public.payments where id=r.payment_id and bill_id is null) then
     perform public.reject_payment_with_allocations(r.payment_id,r.id,auth.jwt()->>'email','Replacement requested: '||p_note);
   else perform public.reject_single_payment_receipt(r.id,auth.jwt()->>'email','Replacement requested: '||p_note); end if;
 end if;
 insert into public.payment_followups(bill_id,kind,amount,due_date,note,actor)
 values(b.id,'request',p_amount,p_due,p_note,auth.jwt()->>'email') returning id into result;
 return result;
end; $$;
revoke all on function public.request_obligation_payment(uuid,numeric,date,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.request_obligation_payment(uuid,numeric,date,text,uuid) to authenticated;

create function public.submit_partial_obligations(p_resident_id uuid,p_admission_id uuid,p_items jsonb,
 p_due date,p_reason text,p_ack boolean,p_payment_method text,p_reference_number text,p_notes text,p_receipt_url text,p_original_file_name text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare item jsonb; b public.bills%rowtype; remaining numeric; submitted numeric; total numeric:=0;
 pay uuid:=gen_random_uuid(); receipt uuid:=gen_random_uuid(); single_bill uuid;
begin
 if coalesce(auth.role(),'')<>'service_role' or split_part(p_receipt_url,'/',1) is distinct from p_resident_id::text then raise exception 'Authenticated server and resident receipt path required.'; end if;
 perform public.lock_financial_ledger();
 if not exists(select 1 from public.admissions a join public.residents r on r.id=a.resident_id where a.id=p_admission_id and a.resident_id=p_resident_id and a.status in ('Pending','Active') and r.status<>'Archived'
 and not exists(select 1 from public.admissions n where n.resident_id=a.resident_id and (n.admission_date,n.created_at,n.id)>(a.admission_date,a.created_at,a.id))) then raise exception 'Current admission required.'; end if;
 if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items) not between 1 and 2 or coalesce(btrim(p_payment_method),'')='' then raise exception 'Select one obligation or Rent and Deposit.'; end if;
 if (select count(distinct x->>'bill_id') from jsonb_array_elements(p_items) x)<>jsonb_array_length(p_items) then raise exception 'Duplicate obligation.'; end if;
 for item in select * from jsonb_array_elements(p_items) loop
   select * into b from public.bills where id=(item->>'bill_id')::uuid and resident_id=p_resident_id and admission_id=p_admission_id for update;
   if b.id is null or b.bill_status in ('Draft','Pending Approval','Cancelled','Archived') then raise exception 'Current payable bill required.'; end if;
   submitted:=(item->>'amount')::numeric;
   remaining:=b.total_amount-public.effective_bill_paid(b.id);
   if submitted is null or submitted::text in ('NaN','Infinity','-Infinity') or submitted<=0 or round(submitted,2)<>submitted or submitted>remaining-public.pending_bill_submissions(b.id) then raise exception 'Amount exceeds available balance after verified and pending submissions.'; end if;
   if submitted<remaining and (p_ack is distinct from true or p_due is null or not isfinite(p_due) or p_due<=(now() at time zone 'Asia/Karachi')::date or coalesce(btrim(p_reason),'')='') then raise exception 'Acknowledge remaining balance and provide a future commitment date and reason.'; end if;
   total:=total+submitted; single_bill:=b.id;
 end loop;
 if jsonb_array_length(p_items)=2 and (select count(distinct bill_type) from public.bills where id in (select (x->>'bill_id')::uuid from jsonb_array_elements(p_items) x) and bill_type in ('Rent','Security Deposit'))<>2 then raise exception 'Combined partial payment requires Rent and Deposit.'; end if;
 if coalesce(p_reference_number,'')<>'' and (exists(select 1 from public.payments where resident_id=p_resident_id and reference_number=p_reference_number) or exists(select 1 from public.payment_receipts where resident_id=p_resident_id and reference_number=p_reference_number)) then raise exception 'Reference already submitted.'; end if;
 insert into public.payments(id,payment_number,resident_id,bill_id,amount,payment_method,reference_number,notes)
 values(pay,'PAY-'||pay::text,p_resident_id,case when jsonb_array_length(p_items)=1 then single_bill end,total,p_payment_method,nullif(p_reference_number,''),p_notes);
 for item in select * from jsonb_array_elements(p_items) loop
   if jsonb_array_length(p_items)>1 then
     insert into public.payment_allocations(payment_id,bill_id,amount) values(pay,(item->>'bill_id')::uuid,(item->>'amount')::numeric);
   end if;
 end loop;
 insert into public.payment_receipts(id,resident_id,bill_id,payment_id,receipt_url,original_file_name,reference_number,amount,notes)
 values(receipt,p_resident_id,case when jsonb_array_length(p_items)=1 then single_bill end,pay,p_receipt_url,p_original_file_name,nullif(p_reference_number,''),total,p_notes);
 for item in select * from jsonb_array_elements(p_items) loop
   select * into b from public.bills where id=(item->>'bill_id')::uuid;
   remaining:=b.total_amount-public.effective_bill_paid(b.id)-(item->>'amount')::numeric;
   if remaining>0 then insert into public.payment_followups(bill_id,receipt_id,kind,amount,due_date,note,actor)
     values(b.id,receipt,'commitment',remaining,p_due,p_reason,p_resident_id::text); end if;
 end loop;
 return jsonb_build_object('payment_id',pay,'receipt_id',receipt);
end; $$;
revoke all on function public.submit_partial_obligations(uuid,uuid,jsonb,date,text,boolean,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.submit_partial_obligations(uuid,uuid,jsonb,date,text,boolean,text,text,text,text,text) to service_role;

-- Every write path shares the existing ledger gate. Deferred checks see the final
-- receipt/payment/allocation transaction, including the commitment inserted above.
create function public.guard_pending_capacity() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare key uuid; pending numeric; b public.bills%rowtype;
begin
 -- Rejection/cancellation must remain available to clear pre-existing duplicates.
 if tg_table_name='payments' and to_jsonb(new)->>'payment_status' in ('Rejected','Cancelled') then return null; end if;
 if tg_table_name='payment_receipts' and to_jsonb(new)->>'status'='Rejected' then return null; end if;
 for key in select distinct bill_id from (
   select nullif(to_jsonb(new)->>'bill_id','')::uuid bill_id
   union all select pa.bill_id from public.payment_allocations pa where pa.payment_id=case when tg_table_name='payments' then new.id else nullif(to_jsonb(new)->>'payment_id','')::uuid end
   union all select legacy_bill.id from public.bills legacy_bill where tg_table_name='payment_receipts'
    and to_jsonb(new)->>'bill_id' is null and legacy_bill.bill_type='Security Deposit'
    and legacy_bill.resident_id::text=to_jsonb(new)->>'resident_id'
    and (to_jsonb(new)->>'notes') ~* E'Payment purpose:[ \t]*Security Deposit'
    and legacy_bill.admission_id::text=substring(to_jsonb(new)->>'notes' from 'Admission ID:[ ]*([0-9a-fA-F-]{36})')
 ) ids where bill_id is not null loop
   select * into b from public.bills where id=key;
   pending:=public.pending_bill_submissions(key);
   if pending>greatest(b.total_amount-public.effective_bill_paid(key),0) then raise exception 'Pending submissions exceed the remaining obligation.'; end if;
 end loop;
 return null;
end; $$;
revoke all on function public.guard_pending_capacity() from public,anon,authenticated,service_role;
create constraint trigger pending_capacity after insert or update on public.payments deferrable initially deferred for each row execute function public.guard_pending_capacity();
create constraint trigger pending_capacity after insert or update on public.payment_allocations deferrable initially deferred for each row execute function public.guard_pending_capacity();
create constraint trigger pending_capacity after insert or update on public.payment_receipts deferrable initially deferred for each row execute function public.guard_pending_capacity();
create function public.require_resident_partial_commitment_api() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if auth.role()='authenticated' and not public.is_staff_user() and exists(select 1 from public.bills b where
 (b.id=new.bill_id or (new.bill_id is null and b.bill_type='Security Deposit' and b.resident_id=new.resident_id and new.notes ~* E'Payment purpose:[ \t]*Security Deposit'
 and b.admission_id::text=substring(new.notes from 'Admission ID:[ ]*([0-9a-fA-F-]{36})')))
 and new.amount<b.total_amount-public.effective_bill_paid(b.id)) then
 raise exception 'Partial receipts require the secure commitment submission workflow.'; end if;
 return new;
end; $$;
revoke all on function public.require_resident_partial_commitment_api() from public,anon,authenticated,service_role;
create trigger partial_receipt_workflow before insert on public.payment_receipts for each row execute function public.require_resident_partial_commitment_api();
-- Only explicitly recorded partial submissions relax the legacy exact-total guard.
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
           where r.payment_id=new.id and f.bill_id=b.id and f.kind='commitment') then
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
commit;
