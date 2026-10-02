-- No data repair is performed on installation. Reconcile only explicit edits.
begin;

create function public.reconcile_pending_admission_deposit()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public as $$
declare
  deposit_bill public.bills%rowtype;
  deposit_count integer;
  verified_amount numeric;
begin
  -- Existing admission RLS authorizes the edit; no table grants are added.
  -- The admission statement trigger already takes this gate before row locks.
  perform public.lock_financial_ledger();
  if new.security_deposit is null or new.security_deposit::text in ('NaN','Infinity','-Infinity')
     or new.security_deposit < 0 then raise exception 'Security Deposit must be a nonnegative finite amount.'; end if;
  if old.status <> 'Pending' or new.status <> 'Pending' then
    if new.security_deposit is distinct from old.security_deposit then
      raise exception 'Deposit requirement changes are only supported for Pending admissions.';
    end if;
    return null;
  end if;
  if new.resident_id is distinct from old.resident_id then
    raise exception 'Deposit reconciliation cannot move an admission to another resident.';
  end if;

  perform 1 from public.bills where admission_id = new.id and bill_type = 'Security Deposit' order by id for update;
  select count(*) into deposit_count from public.bills
    where admission_id = new.id and bill_type = 'Security Deposit' and bill_status <> 'Cancelled';
  if deposit_count > 1 then raise exception 'Multiple Deposit bills require reconciliation before editing this admission.'; end if;
  select * into deposit_bill from public.bills
    where admission_id = new.id and bill_type = 'Security Deposit' and bill_status <> 'Cancelled';
  if deposit_bill.id is not null and deposit_bill.resident_id <> new.resident_id then
    raise exception 'The Deposit bill does not belong to this admission resident.';
  end if;
  -- An unchanged save can repair the already-stale zero requirement, but normal
  -- edits whose requirement/bill agree need no financial writes or proof changes.
  if new.security_deposit = old.security_deposit and
     ((new.security_deposit = 0 and deposit_bill.id is null) or
      (new.security_deposit > 0 and deposit_bill.total_amount = new.security_deposit)) then return null; end if;

  select coalesce(sum(public.effective_bill_paid(id)),0) into verified_amount
    from public.bills where admission_id = new.id and bill_type = 'Security Deposit';
  if verified_amount > 0 and (new.security_deposit = 0 or
     new.security_deposit < greatest(old.security_deposit,coalesce(deposit_bill.total_amount,0),verified_amount)) then
    raise exception 'Deposit reduction blocked: this admission has verified Deposit money. Review settlement without rewriting payment history.';
  end if;
  if new.deposit_status in ('Released','Deducted') then
    raise exception 'Released or deducted Deposits require settlement review.';
  end if;
  if exists (
    select 1 from public.payments p where p.payment_status = 'Pending' and (
      p.bill_id in (select id from public.bills where admission_id = new.id and bill_type = 'Security Deposit') or
      exists (select 1 from public.payment_allocations pa join public.bills b on b.id = pa.bill_id
        where pa.payment_id = p.id and b.admission_id = new.id and b.bill_type = 'Security Deposit'))
  ) or exists (
    select 1 from public.payment_receipts r where r.status = 'Pending Verification' and (
      r.bill_id in (select id from public.bills where admission_id = new.id and bill_type = 'Security Deposit') or
      exists (select 1 from public.payments p where p.id = r.payment_id and (
        p.bill_id in (select id from public.bills where admission_id = new.id and bill_type = 'Security Deposit') or
        exists(select 1 from public.payment_allocations pa join public.bills b on b.id = pa.bill_id
          where pa.payment_id = p.id and b.admission_id = new.id and b.bill_type = 'Security Deposit'))) or
      (r.resident_id = new.resident_id and r.bill_id is null
       and r.notes ~* E'(^|\n)Payment purpose:[ \t]*Security Deposit[ \t]*(\n|$)'
       and substring(r.notes from E'Admission ID:[ \t]*([0-9a-fA-F-]{36})') = new.id::text)
    )
  ) then raise exception 'Deposit edit blocked: a payment or receipt is pending verification. Review it first; no proof has been changed.'; end if;

  if new.security_deposit = 0 then
    update public.bills set bill_status = 'Cancelled'
      where id = deposit_bill.id and admission_id = new.id;
  elsif deposit_bill.id is not null then
    update public.bills set total_amount = new.security_deposit
      where id = deposit_bill.id and admission_id = new.id;
  else
    insert into public.bills(bill_number,resident_id,admission_id,bill_type,billing_month,
      due_date,total_amount,balance_amount,bill_status,notes)
    values('DEP-' || gen_random_uuid()::text,new.resident_id,new.id,'Security Deposit','Security Deposit',
      (now() at time zone 'UTC')::date + 5,new.security_deposit,new.security_deposit,'Pending',
      'Security Deposit obligation created by Pending admission edit.');
  end if;
  -- Existing projection triggers recalculate balances/deposit status. Contracts,
  -- payments, receipts, allocations and all non-Deposit bills remain untouched.
  return null;
end;
$$;
revoke all on function public.reconcile_pending_admission_deposit() from public,anon,authenticated,service_role;
create trigger admissions_reconcile_deposit after update of security_deposit on public.admissions
  for each row execute function public.reconcile_pending_admission_deposit();

commit;
