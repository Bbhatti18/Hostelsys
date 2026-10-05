-- No data repair/backfill. Existing commitments, balances and receipts are untouched.
begin;
-- Server provenance allows a capacity-filling partial combined submission to be
-- verified without inventing a zero-value commitment. Legacy exact-total checks remain.
alter table public.payment_receipts add column available_balance_submission boolean;
create function public.guard_available_balance_submission() returns trigger
language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_op='INSERT' then
   if new.available_balance_submission is not null and coalesce(auth.role(),'')<>'service_role' then
     raise exception 'Submission provenance is server-only.' using errcode='42501';
   end if;
 elsif new.available_balance_submission is distinct from old.available_balance_submission then
   raise exception 'Submission provenance is immutable.' using errcode='42501';
 end if;
 return new;
end; $$;
revoke all on function public.guard_available_balance_submission() from public,anon,authenticated,service_role;
create trigger receipt_available_balance_origin before insert or update on public.payment_receipts
for each row execute function public.guard_available_balance_submission();

create or replace function public.submit_partial_obligations(p_resident_id uuid,p_admission_id uuid,p_items jsonb,
 p_due date,p_reason text,p_ack boolean,p_payment_method text,p_reference_number text,p_notes text,p_receipt_url text,p_original_file_name text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare item jsonb; b public.bills%rowtype; remaining numeric; available numeric; submitted numeric; total numeric:=0;
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
   available:=greatest(remaining-public.pending_bill_submissions(b.id),0);
   if submitted is null or submitted::text in ('NaN','Infinity','-Infinity') or submitted<=0 or round(submitted,2)<>submitted or submitted>available then raise exception 'Amount exceeds available balance after verified and pending submissions.'; end if;
   if submitted<available and (p_ack is distinct from true or p_due is null or not isfinite(p_due) or p_due<=(now() at time zone 'Asia/Karachi')::date or coalesce(btrim(p_reason),'')='') then raise exception 'Acknowledge remaining balance and provide a future commitment date and reason.'; end if;
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
 insert into public.payment_receipts(id,resident_id,bill_id,payment_id,receipt_url,original_file_name,reference_number,amount,notes,available_balance_submission)
 values(receipt,p_resident_id,case when jsonb_array_length(p_items)=1 then single_bill end,pay,p_receipt_url,p_original_file_name,nullif(p_reference_number,''),total,p_notes,true);
 for item in select * from jsonb_array_elements(p_items) loop
   select * into b from public.bills where id=(item->>'bill_id')::uuid;
   -- The new payment is already pending, so it is included exactly once here.
   remaining:=greatest(b.total_amount-public.effective_bill_paid(b.id)-public.pending_bill_submissions(b.id),0);
   if remaining>0 then insert into public.payment_followups(bill_id,receipt_id,kind,amount,due_date,note,actor)
     values(b.id,receipt,'commitment',remaining,p_due,p_reason,p_resident_id::text); end if;
 end loop;
 return jsonb_build_object('payment_id',pay,'receipt_id',receipt);
end; $$;
revoke all on function public.submit_partial_obligations(uuid,uuid,jsonb,date,text,boolean,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.submit_partial_obligations(uuid,uuid,jsonb,date,text,boolean,text,text,text,text,text) to service_role;

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
