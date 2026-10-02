-- Additional declarations use ordinary bills/allocations, never a second money ledger.
begin;
alter table public.payment_receipts add column additional_charge jsonb
 check (additional_charge is null or (jsonb_typeof(additional_charge)='object' and (additional_charge->>'amount')::numeric > 0));
alter table public.bills add column additional_receipt_id uuid unique references public.payment_receipts(id) deferrable initially deferred;
alter table public.bills add constraint additional_bill_purpose check (additional_receipt_id is null or (bill_type='Other Charges' and rent_amount=0 and electricity_amount=0 and ac_amount=0 and discount_amount=0));
-- Preserve one regular monthly bill while allowing separately classified transfers.
drop index public.bills_regular_admission_month_key;
create unique index bills_regular_admission_month_key on public.bills(admission_id,billing_month)
 where bill_status <> 'Cancelled' and bill_type <> 'Security Deposit' and additional_receipt_id is null;
comment on column public.payment_receipts.additional_charge is 'Immutable resident declaration plus staff confirmation. NULL for historical receipts.';

create function public.validate_additional_charge(p_amount numeric, p_category text, p_description text)
returns void language plpgsql set search_path = pg_catalog, public as $$
begin
 if p_amount is null or p_amount::text in ('NaN','Infinity','-Infinity') or p_amount <= 0
   or p_amount > 9999999999.99 or p_amount <> round(p_amount,2)
   or p_category is null or p_category not in ('Electricity / Utilities','AC / Appliance Charges','Maintenance / Repair','Damage / Fine','Mess / Food','Other')
   or length(coalesce(p_description,'')) > 500 or (p_category = 'Other' and nullif(btrim(p_description),'') is null) then
   raise exception 'A positive two-decimal additional amount, controlled category and description for Other are required.';
 end if;
end;
$$;
revoke all on function public.validate_additional_charge(numeric,text,text) from public, anon, authenticated;

create function public.guard_additional_receipt()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
 if new.additional_charge is null and (tg_op = 'INSERT' or old.additional_charge is null) then return new; end if;
 if tg_op = 'INSERT' or new.additional_charge is distinct from old.additional_charge then
   if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Additional charges require the authenticated submission/verification API.'; end if;
   if tg_op = 'UPDATE' and (new.additional_charge - 'confirmed') is distinct from (old.additional_charge - 'confirmed') then raise exception 'Resident declaration is immutable.'; end if;
   if tg_op = 'UPDATE' and old.status <> 'Pending Verification' then raise exception 'Finalized classification is immutable.'; end if;
   perform public.validate_additional_charge((new.additional_charge->>'amount')::numeric,new.additional_charge->>'category',new.additional_charge->>'description');
 end if;
 if new.payment_id is null or new.bill_id is not null then raise exception 'Additional receipt requires one allocated payment.'; end if;
 return new;
end;
$$;
revoke all on function public.guard_additional_receipt() from public, anon, authenticated;
create trigger additional_receipt_guard before insert or update on public.payment_receipts for each row execute function public.guard_additional_receipt();

create function public.create_additional_payment_submission(
 p_resident_id uuid, p_admission_id uuid, p_rent_bill_id uuid, p_deposit_bill_id uuid,
 p_amount numeric, p_additional_amount numeric, p_category text, p_description text,
 p_payment_method text, p_reference_number text, p_notes text, p_receipt_url text, p_original_file_name text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.admissions%rowtype; b public.bills%rowtype; d public.bills%rowtype;
 rent_due numeric := 0; deposit_due numeric := 0; payment_key uuid := gen_random_uuid(); receipt_key uuid := gen_random_uuid(); extra_bill uuid;
begin
 if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Server authentication required.'; end if;
 perform public.lock_financial_ledger();
 perform public.validate_additional_charge(p_additional_amount,p_category,p_description);
 select * into a from public.admissions where id=p_admission_id and resident_id=p_resident_id and status in ('Pending','Active') for update;
 if a.id is null or not exists(select 1 from public.residents where id=p_resident_id and status <> 'Archived')
   or exists(select 1 from public.admissions n where n.resident_id=p_resident_id and (n.admission_date,n.created_at,n.id)>(a.admission_date,a.created_at,a.id)) then raise exception 'Current resident admission required.'; end if;
 if p_rent_bill_id is null and p_deposit_bill_id is null then raise exception 'Select Rent and/or Security Deposit.'; end if;
 if p_rent_bill_id is not null then
  select * into b from public.bills where id=p_rent_bill_id and resident_id=p_resident_id and admission_id=a.id and bill_type='Rent' and bill_status in ('Pending','Partially Paid','Overdue') for update;
  if b.id is null then raise exception 'Invalid current Rent bill.'; end if;
  rent_due := public.outstanding_rent(b.id);
  if rent_due <= 0 then raise exception 'No outstanding Rent.'; end if;
 end if;
 if p_deposit_bill_id is not null then
  select * into d from public.bills where id=p_deposit_bill_id and resident_id=p_resident_id and admission_id=a.id and bill_type='Security Deposit' and bill_status in ('Pending','Partially Paid','Overdue') for update;
  if d.id is null or a.security_deposit <= 0 or a.deposit_status not in ('Pending','Held') then raise exception 'Invalid current Deposit bill.'; end if;
  deposit_due := d.total_amount-public.effective_bill_paid(d.id);
  if deposit_due <= 0 then raise exception 'No outstanding Deposit.'; end if;
 end if;
 if p_amount is null or p_amount <> rent_due+deposit_due+p_additional_amount then raise exception 'Submitted total must equal canonical obligations plus declared additional charges.'; end if;
 if nullif(btrim(p_payment_method),'') is null or split_part(p_receipt_url,'/',1) is distinct from p_resident_id::text then raise exception 'Payment method and resident receipt path required.'; end if;
 if exists(select 1 from public.payment_receipts r where r.status='Pending Verification' and
   (r.bill_id in (b.id,d.id) or exists(select 1 from public.payment_allocations pa where pa.payment_id=r.payment_id and pa.bill_id in (b.id,d.id)))) then raise exception 'A receipt for this obligation is already pending verification.'; end if;
 if nullif(btrim(p_reference_number),'') is not null and (exists(select 1 from public.payments where reference_number=p_reference_number) or exists(select 1 from public.payment_receipts where reference_number=p_reference_number)) then raise exception 'Payment reference already submitted.'; end if;
 -- A declaration is NOT payable accounting until staff confirms it.
 insert into public.bills(bill_number,resident_id,admission_id,bill_type,billing_month,due_date,other_amount,total_amount,bill_status,notes,additional_receipt_id)
 values('ADD-'||receipt_key::text,p_resident_id,a.id,'Other Charges',to_char((now() at time zone 'Asia/Karachi')::date,'YYYY-MM'),(now() at time zone 'Asia/Karachi')::date,p_additional_amount,p_additional_amount,'Pending Approval','Resident-declared Additional Charges; awaiting payment verification.',receipt_key) returning id into extra_bill;
 insert into public.payments(id,payment_number,resident_id,amount,payment_method,reference_number,notes,payment_status)
 values(payment_key,'PAY-'||payment_key::text,p_resident_id,p_amount,p_payment_method,nullif(p_reference_number,''),p_notes,'Pending');
 if rent_due>0 then insert into public.payment_allocations(payment_id,bill_id,amount) values(payment_key,b.id,rent_due); end if;
 if deposit_due>0 then insert into public.payment_allocations(payment_id,bill_id,amount) values(payment_key,d.id,deposit_due); end if;
 insert into public.payment_allocations(payment_id,bill_id,amount) values(payment_key,extra_bill,p_additional_amount);
 insert into public.payment_receipts(id,resident_id,payment_id,amount,receipt_url,original_file_name,reference_number,notes,status,additional_charge)
 values(receipt_key,p_resident_id,payment_key,p_amount,p_receipt_url,p_original_file_name,nullif(p_reference_number,''),p_notes,'Pending Verification',
 jsonb_build_object('amount',p_additional_amount,'category',p_category,'description',btrim(coalesce(p_description,'')),'billId',extra_bill,
 'rentBillId',b.id,'rentAmount',rent_due,'depositBillId',d.id,'depositAmount',deposit_due));
 return jsonb_build_object('payment_id',payment_key,'receipt_id',receipt_key);
end;
$$;

create function public.verify_additional_payment(p_receipt_id uuid,p_verifier text,p_amount numeric,p_category text,p_description text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.payment_receipts%rowtype; p public.payments%rowtype; a public.admissions%rowtype; b public.bills%rowtype;
 extra_bill uuid; rent_due numeric:=0; deposit_due numeric:=0; bill_key uuid;
begin
 if coalesce(auth.role(),'') <> 'service_role' or not exists(select 1 from public.staff_users where email=lower(btrim(p_verifier)) and lower(status)='active' and lower(role) in ('admin','super admin','accountant')) then raise exception 'Authorized payment verifier required.'; end if;
 perform public.lock_financial_ledger();
 perform public.validate_additional_charge(p_amount,p_category,p_description);
 select * into r from public.payment_receipts where id=p_receipt_id for update;
 select * into p from public.payments where id=r.payment_id for update;
 if r.id is null or r.additional_charge is null or r.status<>'Pending Verification' or p.payment_status<>'Pending' or p.id is null or p.resident_id<>r.resident_id or p.amount<>r.amount then raise exception 'Matching pending payment/receipt required.'; end if;
 extra_bill := (r.additional_charge->>'billId')::uuid;
 select * into b from public.bills where id=extra_bill and resident_id=r.resident_id and bill_type='Other Charges' and bill_status='Pending Approval' for update;
 if b.id is null then raise exception 'Additional declaration bill is unavailable.'; end if;
 select * into a from public.admissions where id=b.admission_id and resident_id=r.resident_id and status in ('Pending','Active') for update;
 if a.id is null or not exists(select 1 from public.residents where id=r.resident_id and status <> 'Archived') or exists(select 1 from public.admissions n where n.resident_id=a.resident_id and (n.admission_date,n.created_at,n.id)>(a.admission_date,a.created_at,a.id)) then raise exception 'Current admission required.'; end if;
 bill_key := (r.additional_charge->>'rentBillId')::uuid;
 if bill_key is not null then
  select * into b from public.bills where id=bill_key and admission_id=a.id and resident_id=r.resident_id and bill_type='Rent' and bill_status in ('Pending','Partially Paid','Overdue') for update;
  if b.id is null then raise exception 'Rent is no longer payable.'; end if;
  rent_due := public.outstanding_rent(b.id);
  if rent_due <= 0 then raise exception 'Rent balance changed; review receipt.'; end if;
 end if;
 bill_key := (r.additional_charge->>'depositBillId')::uuid;
 if bill_key is not null then
  select * into b from public.bills where id=bill_key and admission_id=a.id and resident_id=r.resident_id and bill_type='Security Deposit' and bill_status in ('Pending','Partially Paid','Overdue') for update;
  if b.id is null or a.deposit_status not in ('Pending','Held') then raise exception 'Deposit is no longer payable.'; end if;
  deposit_due := b.total_amount-public.effective_bill_paid(b.id);
  if deposit_due <= 0 then raise exception 'Deposit balance changed; review receipt.'; end if;
 end if;
 if rent_due+deposit_due+p_amount <> r.amount then raise exception 'Mismatch: canonical allocations plus confirmed Additional Charges must equal the submitted receipt total.'; end if;
 update public.payment_receipts set additional_charge=additional_charge||jsonb_build_object('confirmed',jsonb_build_object('amount',p_amount,'category',p_category,'description',btrim(coalesce(p_description,'')),'by',p_verifier,'at',now())) where id=r.id;
 update public.bills set other_amount=p_amount,total_amount=p_amount,bill_status='Pending',notes='Additional Charges: '||p_category||E'\n'||coalesce(p_description,'') where id=extra_bill;
 delete from public.payment_allocations where payment_id=p.id;
 if rent_due>0 then insert into public.payment_allocations(payment_id,bill_id,amount) values(p.id,(r.additional_charge->>'rentBillId')::uuid,rent_due); end if;
 if deposit_due>0 then insert into public.payment_allocations(payment_id,bill_id,amount) values(p.id,(r.additional_charge->>'depositBillId')::uuid,deposit_due); end if;
 insert into public.payment_allocations(payment_id,bill_id,amount) values(p.id,extra_bill,p_amount);
 update public.payments set payment_status='Verified',verified_by=p_verifier,verified_at=now() where id=p.id;
 update public.payment_receipts set status='Verified',verified=true,verified_by=p_verifier,verified_at=now() where id=r.id;
 return jsonb_build_object('payment_id',p.id,'receipt_id',r.id);
end;
$$;

create function public.guard_additional_verification()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
declare r public.payment_receipts%rowtype; item record;
begin
 select * into r from public.payment_receipts where payment_id=new.id and additional_charge is not null;
 if r.id is null or new.payment_status <> 'Verified' then return new; end if;
 if r.additional_charge->'confirmed' is null then raise exception 'Explicit staff Additional Charges confirmation is required.'; end if;
 for item in select pa.*,b.bill_type from public.payment_allocations pa join public.bills b on b.id=pa.bill_id where pa.payment_id=new.id loop
  if item.bill_type='Rent' and item.amount <> public.outstanding_rent(item.bill_id,new.id) then raise exception 'Additional payment must settle exact current Rent.'; end if;
 end loop;
 return new;
end;
$$;
revoke all on function public.guard_additional_verification() from public,anon,authenticated;
create trigger additional_verification_guard before update of payment_status on public.payments for each row execute function public.guard_additional_verification();

create function public.guard_additional_bill()
returns trigger language plpgsql security definer set search_path = pg_catalog, public as $$
begin
 if tg_op='INSERT' then
   if new.additional_receipt_id is not null and coalesce(auth.role(),'') <> 'service_role' then raise exception 'Additional bills require the submission API.'; end if;
   return new;
 end if;
 if new.additional_receipt_id is distinct from old.additional_receipt_id then raise exception 'Additional receipt link is immutable.'; end if;
 if old.bill_status='Pending Approval' and new.bill_status not in ('Pending Approval','Cancelled') and exists(select 1 from public.payment_receipts r where r.additional_charge->>'billId'=old.id::text and r.additional_charge->'confirmed' is null) then raise exception 'Confirm Additional Charges through payment verification.'; end if;
 return new;
end;
$$;
revoke all on function public.guard_additional_bill() from public,anon,authenticated;
create trigger additional_bill_guard before insert or update on public.bills for each row execute function public.guard_additional_bill();

-- Existing ledger protections retained; only explicitly declared Rent allocations
-- may settle the canonical Rent component without paying unrelated utility lines.
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

revoke all on function public.create_additional_payment_submission(uuid,uuid,uuid,uuid,numeric,numeric,text,text,text,text,text,text,text), public.verify_additional_payment(uuid,text,numeric,text,text) from public,anon,authenticated;
grant execute on function public.create_additional_payment_submission(uuid,uuid,uuid,uuid,numeric,numeric,text,text,text,text,text,text,text), public.verify_additional_payment(uuid,text,numeric,text,text) to service_role;
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
  if payment_row.payment_status in ('Pending','Rejected') and exists(select 1 from public.payment_receipts where payment_id=p_payment_id and additional_charge is not null and additional_charge->'confirmed' is null) then
    update public.payments set payment_status='Cancelled',verified=false,verified_by=p_actor,verified_at=null,notes=p_reason where id=p_payment_id;
    update public.payment_receipts set status='Rejected',verified=false,verified_by=p_actor,verified_at=null,remarks=p_reason where payment_id=p_payment_id and status='Pending Verification';
    return jsonb_build_object('payment_id',p_payment_id);
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
