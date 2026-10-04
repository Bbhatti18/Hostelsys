-- Historical evidence is intentionally separate from all financial tables.
begin;
create or replace function public.create_additional_payment_submission(
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
 if p_rent_bill_id is null and p_deposit_bill_id is null and nullif(btrim(p_description),'') is null then raise exception 'Other Charges requires Description / Notes.'; end if;
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

create table public.historical_payment_evidence (
 id uuid primary key default gen_random_uuid(), resident_id uuid not null references public.residents(id),
 purpose text not null check(purpose in ('Previous Rent','Previous Security Deposit','Previous Rent + Security Deposit','Other Charges')),
 payment_date date not null, amount numeric(12,2) not null check(amount>0 and amount::text not in ('NaN','Infinity','-Infinity')),
 payment_method text not null check(length(btrim(payment_method))>0), reference_number text,
 description text not null check(length(btrim(description))>0), receipt_path text not null,
 status text not null default 'Pending' check(status in ('Pending','Verified','Rejected')),
 reviewed_by text, reviewed_at timestamptz, review_note text, created_at timestamptz not null default now(),
 check(split_part(receipt_path,'/',1)=resident_id::text)
);
create table public.historical_payment_evidence_reviews (
 id uuid primary key default gen_random_uuid(), evidence_id uuid not null references public.historical_payment_evidence(id),
 status text not null, actor text not null, note text not null, created_at timestamptz not null default now()
);
alter table public.historical_payment_evidence enable row level security;
alter table public.historical_payment_evidence_reviews enable row level security;
revoke all on public.historical_payment_evidence,public.historical_payment_evidence_reviews from public,anon,authenticated,service_role;
grant select,insert on public.historical_payment_evidence to service_role;
create function public.guard_historical_evidence() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 if tg_op='INSERT' then
   if new.status<>'Pending' or new.reviewed_by is not null or new.reviewed_at is not null or new.review_note is not null
      or not isfinite(new.payment_date) or new.payment_date>(now() at time zone 'Asia/Karachi')::date then raise exception 'Valid historical date and pending evidence required.'; end if;
 else
   if old.status<>'Pending' or new.status not in ('Verified','Rejected') or (to_jsonb(new)-array['status','reviewed_by','reviewed_at','review_note']) is distinct from (to_jsonb(old)-array['status','reviewed_by','reviewed_at','review_note']) then raise exception 'Evidence is immutable; only pending review is allowed.'; end if;
 end if;
 return new;
end; $$;
create trigger historical_evidence_guard before insert or update on public.historical_payment_evidence for each row execute function public.guard_historical_evidence();
revoke all on function public.guard_historical_evidence() from public,anon,authenticated,service_role;
create function public.review_historical_evidence(p_id uuid,p_status text,p_actor text,p_note text)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if coalesce(auth.role(),'')<>'service_role' or not exists(select 1 from public.staff_users where email=p_actor and lower(status)='active' and (lower(role) in ('admin','super admin') or (lower(role)='accountant' and 'payments'=any(permissions)))) then raise exception 'Authorized verifier required.'; end if;
 if p_status not in ('Verified','Rejected') or coalesce(btrim(p_note),'')='' then raise exception 'Review decision and note required.'; end if;
 update public.historical_payment_evidence set status=p_status,reviewed_by=p_actor,reviewed_at=now(),review_note=p_note where id=p_id and status='Pending';
 if not found then raise exception 'Evidence is no longer pending.'; end if;
 insert into public.historical_payment_evidence_reviews(evidence_id,status,actor,note) values(p_id,p_status,p_actor,p_note);
end; $$;
revoke all on function public.review_historical_evidence(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.review_historical_evidence(uuid,text,text,text) to service_role;
commit;
