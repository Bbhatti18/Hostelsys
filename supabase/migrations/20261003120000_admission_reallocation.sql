begin;

create table public.admission_allocation_history (
  id uuid primary key default gen_random_uuid(),
  admission_id uuid not null references public.admissions(id),
  resident_id uuid not null references public.residents(id),
  old_room_id uuid references public.rooms(id), old_bed_id uuid references public.beds(id),
  old_allocation_mode text not null,
  new_room_id uuid not null references public.rooms(id), new_bed_id uuid not null references public.beds(id),
  new_allocation_mode text not null,
  reason text, changed_by uuid not null, changed_at timestamptz not null default now()
);
alter table public.admission_allocation_history enable row level security;
revoke all on public.admission_allocation_history from public, anon, authenticated, service_role;
grant select on public.admission_allocation_history to authenticated;
create policy allocation_history_staff_read on public.admission_allocation_history for select to authenticated
  using (public.staff_can_operate('admissions', array['manager','reception']::text[]));

create function public.reallocate_admission(p_admission_id uuid, p_room_id uuid,
  p_bed_id uuid, p_allocation_mode text, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$
declare old_row public.admissions%rowtype; new_row public.admissions%rowtype;
begin
  if coalesce(auth.role(),'') <> 'authenticated' or auth.uid() is null
    or not public.staff_can_operate('admissions',array['manager','reception']::text[]) then
    raise exception 'Active staff with Admissions permission required.' using errcode='42501';
  end if;
  if p_allocation_mode is null or p_allocation_mode not in ('single_bed','whole_room')
    or (p_allocation_mode='single_bed' and p_bed_id is null)
    or (p_allocation_mode='whole_room' and p_bed_id is not null) then
    raise exception 'Select a Single Bed, or let the server choose the Whole Room primary bed.';
  end if;
  -- Same global gate/order as creation and the allocation statement/row guards.
  perform public.lock_financial_ledger();
  select * into old_row from public.admissions where id=p_admission_id for update;
  if not found or old_row.status not in ('Pending','Active') then
    raise exception 'Only current Pending or Active admissions can move.';
  end if;
  perform id from public.rooms where id in (old_row.room_id,p_room_id) order by id for update;
  if p_allocation_mode='single_bed' and p_bed_id is distinct from old_row.bed_id
    and not exists(select 1 from public.beds where id=p_bed_id and room_id=p_room_id and status='Vacant') then
    raise exception 'Destination bed is not vacant.';
  end if;
  -- Existing guard chooses Whole Room primary, validates inventory/exclusivity,
  -- releases only our old bed and occupies the new bed. Unique current-bed index
  -- remains the final conflict constraint. No financial columns are updated.
  update public.admissions set room_id=p_room_id, bed_id=p_bed_id,
    allocation_mode=p_allocation_mode where id=old_row.id returning * into new_row;
  if (old_row.room_id,old_row.bed_id,old_row.allocation_mode) is not distinct from
     (new_row.room_id,new_row.bed_id,new_row.allocation_mode) then
    raise exception 'Allocation is unchanged; no move recorded.';
  end if;
  -- These references drive current contract UI; signed text and terms are snapshots.
  update public.contracts set room_id=new_row.room_id,bed_id=new_row.bed_id
    where admission_id=old_row.id and resident_id=old_row.resident_id;
  insert into public.admission_allocation_history(admission_id,resident_id,old_room_id,old_bed_id,
    old_allocation_mode,new_room_id,new_bed_id,new_allocation_mode,reason,changed_by)
  values(old_row.id,old_row.resident_id,old_row.room_id,old_row.bed_id,old_row.allocation_mode,
    new_row.room_id,new_row.bed_id,new_row.allocation_mode,nullif(btrim(p_reason),''),auth.uid());
  return jsonb_build_object('admission_id',new_row.id,'room_id',new_row.room_id,'bed_id',new_row.bed_id);
end;
$$;
revoke all on function public.reallocate_admission(uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.reallocate_admission(uuid,uuid,uuid,text,text) to authenticated;
commit;
