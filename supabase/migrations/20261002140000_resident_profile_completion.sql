begin;

alter table public.residents add column guardian_cnic text, add column guardian_phone text;

create table public.resident_profile_completions (
  resident_id uuid primary key references public.residents(id) on delete restrict,
  draft jsonb not null default '{}',
  draft_contacts jsonb not null default '[]',
  submitted_at timestamptz,
  updated_at timestamptz not null default now()
);
create table public.resident_emergency_contacts (
  id uuid primary key default gen_random_uuid(),
  resident_id uuid not null references public.residents(id) on delete restrict,
  contact_name text not null check (btrim(contact_name) <> ''),
  relationship text not null check (btrim(relationship) <> ''),
  phone text not null check (btrim(phone) <> ''),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index resident_emergency_contacts_resident_idx on public.resident_emergency_contacts(resident_id);
-- The existing admin_data_action_audits is reserved for destructive operations.
create table public.resident_profile_corrections (
  id uuid primary key default gen_random_uuid(),
  resident_id uuid not null references public.residents(id) on delete restrict,
  actor text not null,
  previous_values jsonb not null,
  next_values jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.resident_profile_completions enable row level security;
alter table public.resident_emergency_contacts enable row level security;
alter table public.resident_profile_corrections enable row level security;
revoke all on public.resident_profile_completions, public.resident_emergency_contacts, public.resident_profile_corrections from anon, authenticated;
grant select on public.resident_profile_completions, public.resident_emergency_contacts, public.resident_profile_corrections to authenticated;
grant all on public.resident_profile_completions, public.resident_emergency_contacts, public.resident_profile_corrections to service_role;
create policy profile_read on public.resident_profile_completions for select to authenticated
  using (public.is_staff_user() or resident_id = public.current_resident_id());
create policy contacts_read on public.resident_emergency_contacts for select to authenticated
  using (public.is_staff_user() or resident_id = public.current_resident_id());
create policy corrections_read on public.resident_profile_corrections for select to authenticated using (public.is_admin_user());

-- All contact writes take the resident lock, serializing with final submission.
create function public.save_resident_emergency_contacts(p_resident_id uuid, p_contacts jsonb)
returns void language plpgsql security definer set search_path = pg_catalog, public as $$
declare c jsonb; r public.residents%rowtype; cid uuid;
begin
  if coalesce(auth.role(),'') <> 'service_role' and not public.staff_can_operate('residents',array['manager','reception']) then
    raise exception 'Staff resident-management permission required.' using errcode='42501';
  end if;
  select * into strict r from public.residents where id=p_resident_id for update;
  if r.status='Archived' then raise exception 'Archived resident cannot be edited.'; end if;
  if jsonb_typeof(p_contacts) is distinct from 'array' or jsonb_array_length(p_contacts)>20 then raise exception 'Invalid contacts.'; end if;
  for c in select value from jsonb_array_elements(p_contacts) loop
    if coalesce(btrim(c->>'contact_name'),'')='' or coalesce(btrim(c->>'relationship'),'')='' or coalesce(btrim(c->>'phone'),'')='' then raise exception 'Complete each contact name, relationship and phone.'; end if;
    if length(c->>'contact_name')>200 or length(c->>'relationship')>100 or length(c->>'phone')>50 then raise exception 'Contact value is too long.'; end if;
    cid := nullif(c->>'id','')::uuid;
    if cid is not null then
      update public.resident_emergency_contacts set contact_name=btrim(c->>'contact_name'), relationship=btrim(c->>'relationship'), phone=btrim(c->>'phone'), updated_at=now()
        where id=cid and resident_id=p_resident_id;
      if not found then raise exception 'Contact does not belong to resident.'; end if;
    elsif not exists (select 1 from public.resident_emergency_contacts where resident_id=p_resident_id and contact_name=btrim(c->>'contact_name') and relationship=btrim(c->>'relationship') and phone=btrim(c->>'phone'))
      and not (coalesce(r.emergency_contact_name,'')=btrim(c->>'contact_name') and coalesce(r.emergency_contact_relationship,'')=btrim(c->>'relationship') and coalesce(r.emergency_contact,'')=btrim(c->>'phone')) then
      insert into public.resident_emergency_contacts(resident_id,contact_name,relationship,phone) values(p_resident_id,btrim(c->>'contact_name'),btrim(c->>'relationship'),btrim(c->>'phone'));
    end if;
  end loop;
end; $$;
revoke all on function public.save_resident_emergency_contacts(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.save_resident_emergency_contacts(uuid,jsonb) to authenticated,service_role;

-- Only the authenticated server route can invoke this service-only transaction.
-- Never accept resident identity or staff privilege from the request body.
create function public.save_resident_profile_completion(p_resident_id uuid,p_details jsonb,p_contacts jsonb,p_submit boolean default false)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.residents%rowtype; completion public.resident_profile_completions%rowtype; k text; v text; cleaned jsonb := '{}'; c jsonb;
  allowed text[] := array['cnic','dob','gender','permanent_address','city','nationality','occupation','company_university','father_name','guardian_cnic','guardian_phone'];
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Server access required.' using errcode='42501'; end if;
  select * into strict r from public.residents where id=p_resident_id for update;
  if r.status='Archived' then raise exception 'Resident unavailable.'; end if;
  select * into completion from public.resident_profile_completions where resident_id=p_resident_id;
  if completion.submitted_at is not null then raise exception 'Profile is submitted and locked. Contact staff for corrections.'; end if;
  if jsonb_typeof(p_details) is distinct from 'object' or jsonb_typeof(p_contacts) is distinct from 'array' or jsonb_array_length(p_contacts)>20 then raise exception 'Invalid profile.'; end if;
  for k,v in select key,value from jsonb_each_text(p_details) loop
    if not k=any(allowed) then raise exception 'Unsupported profile field.'; end if;
    if length(v)>1000 then raise exception 'Profile value is too long.'; end if;
    -- Staff data always wins, including changes made since the draft was loaded.
    if coalesce(btrim(to_jsonb(r)->>k),'')='' then
      cleaned := cleaned || jsonb_build_object(k,nullif(btrim(v),''));
    end if;
  end loop;
  if cleaned->>'dob' is not null and ((cleaned->>'dob')::date > current_date or (cleaned->>'dob')::date < date '1900-01-01') then raise exception 'Invalid date of birth.'; end if;
  for c in select value from jsonb_array_elements(p_contacts) loop
    if c ? 'id' then raise exception 'Existing contacts are staff-managed.'; end if;
    if p_submit and (coalesce(btrim(c->>'contact_name'),'')='' or coalesce(btrim(c->>'relationship'),'')='' or coalesce(btrim(c->>'phone'),'')='') then raise exception 'Complete each contact name, relationship and phone.'; end if;
    if length(c->>'contact_name')>200 or length(c->>'phone')>50 or (coalesce(c->>'relationship','')<>'' and not (c->>'relationship')=any(array['Father','Mother','Brother','Sister','Guardian','Spouse','Uncle','Aunt','Other'])) then raise exception 'Invalid contact.'; end if;
  end loop;
  if p_submit then
    foreach k in array array['cnic','father_name','guardian_cnic','guardian_phone'] loop
      if coalesce(nullif(btrim(to_jsonb(r)->>k),''),cleaned->>k,'')='' then raise exception 'Identity and guardian details are required before submission.'; end if;
    end loop;
    if coalesce(btrim(r.emergency_contact),'')='' and jsonb_array_length(p_contacts)=0 and not exists(select 1 from public.resident_emergency_contacts where resident_id=p_resident_id) then raise exception 'At least one emergency contact is required.'; end if;
    -- Update only explicitly whitelisted missing fields. Existing CNIC indexes
    -- and resident guards still execute; any failure rolls the entire save back.
    for k,v in select key,value from jsonb_each_text(cleaned) loop
      if k='dob' then execute format('update public.residents set %I=$1::date where id=$2',k) using v,p_resident_id;
      else execute format('update public.residents set %I=$1 where id=$2',k) using v,p_resident_id; end if;
    end loop;
    perform public.save_resident_emergency_contacts(p_resident_id,p_contacts);
  end if;
  insert into public.resident_profile_completions(resident_id,draft,draft_contacts,submitted_at)
    values(p_resident_id,case when p_submit then '{}'::jsonb else cleaned end,case when p_submit then '[]'::jsonb else p_contacts end,case when p_submit then now() end)
    on conflict(resident_id) do update set draft=excluded.draft,draft_contacts=excluded.draft_contacts,submitted_at=excluded.submitted_at,updated_at=now();
end; $$;
revoke all on function public.save_resident_profile_completion(uuid,jsonb,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.save_resident_profile_completion(uuid,jsonb,jsonb,boolean) to service_role;

create function public.audit_locked_resident_profile()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare rid uuid; before_data jsonb; after_data jsonb;
begin
  if tg_table_name='residents' then rid := new.id; else rid := new.resident_id; end if;
  if exists(select 1 from public.resident_profile_completions where resident_id=rid and submitted_at is not null) then
    if tg_table_name='residents' then
      select jsonb_object_agg(key,value) into before_data from jsonb_each(to_jsonb(old)) where key=any(array['cnic','father_name','guardian_cnic','guardian_phone','emergency_contact','emergency_contact_name','emergency_contact_relationship','dob','gender','permanent_address','city','nationality','occupation','company_university']);
      select jsonb_object_agg(key,value) into after_data from jsonb_each(to_jsonb(new)) where key=any(array['cnic','father_name','guardian_cnic','guardian_phone','emergency_contact','emergency_contact_name','emergency_contact_relationship','dob','gender','permanent_address','city','nationality','occupation','company_university']);
    else before_data := case when tg_op='INSERT' then '{}'::jsonb else to_jsonb(old)-'updated_at' end; after_data:=to_jsonb(new)-'updated_at'; end if;
    if before_data is distinct from after_data then
      insert into public.resident_profile_corrections(resident_id,actor,previous_values,next_values) values(rid,coalesce(auth.jwt()->>'email','service_role'),before_data,after_data);
    end if;
  end if;
  return new;
end; $$;
revoke all on function public.audit_locked_resident_profile() from public,anon,authenticated;
create trigger resident_profile_correction after update on public.residents for each row execute function public.audit_locked_resident_profile();
create trigger resident_contact_correction after insert or update on public.resident_emergency_contacts for each row execute function public.audit_locked_resident_profile();
commit;
