begin;
-- Preserve all legacy values. New identity types are nullable for existing rows.
alter table public.residents add column resident_identity_type text check (resident_identity_type in ('CNIC','Passport')),
  add column guardian_identity_type text check (guardian_identity_type in ('CNIC','Passport'));
do $$ begin
  if not exists(select 1 from storage.buckets where id='resident-documents') then
    insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
      values('resident-documents','resident-documents',false,4194304,array['image/jpeg','image/png','image/webp','application/pdf']);
  end if;
  -- Never reconfigure a pre-existing bucket. Fail closed if it is public.
  if exists(select 1 from storage.buckets where id='resident-documents' and public is distinct from false) then
    raise exception 'Existing resident-documents bucket is not private. Review its configuration separately; no bucket was changed.';
  end if;
end; $$;
-- Access is exclusively through authenticated server endpoints. Restrictive
-- policies also prevent an older broad storage policy from granting access.
create policy "Private resident documents server only" on storage.objects as restrictive
  for all to anon,authenticated using(bucket_id <> 'resident-documents') with check(bucket_id <> 'resident-documents');

create table public.resident_profile_documents (
  resident_id uuid not null references public.residents(id) on delete restrict,
  slot text not null check(slot in ('photo','resident_front','resident_back','guardian_front','guardian_back')),
  storage_path text not null unique,
  content_type text not null check(content_type in ('image/jpeg','image/png','image/webp','application/pdf')),
  size_bytes integer not null check(size_bytes between 1 and 4194304),
  source text not null check(source in ('resident','staff')),
  actor text not null,
  updated_at timestamptz not null default now(),
  primary key(resident_id,slot),
  check(slot <> 'photo' or content_type <> 'application/pdf')
);
alter table public.resident_profile_documents enable row level security;
revoke all on public.resident_profile_documents from anon,authenticated;
grant select on public.resident_profile_documents to authenticated;
grant all on public.resident_profile_documents to service_role;
create policy "Read own profile document metadata" on public.resident_profile_documents for select to authenticated
  using(resident_id=public.current_resident_id() or public.staff_can_operate('residents',array['manager','reception']));

create function public.register_resident_profile_document(p_resident_id uuid,p_slot text,p_path text,p_content_type text,p_size integer,p_actor_email text)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.residents%rowtype; previous public.resident_profile_documents%rowtype; is_staff boolean; locked boolean; legacy text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Server access required.' using errcode='42501'; end if;
  select * into strict r from public.residents where id=p_resident_id for update;
  if r.status='Archived' then raise exception 'Resident unavailable.'; end if;
  select exists(select 1 from public.staff_users where email=lower(btrim(p_actor_email)) and lower(status)='active'
    and (lower(role) in ('admin','super admin') or (lower(role) in ('manager','reception') and 'residents'=any(permissions)))) into is_staff;
  if not is_staff and (r.email is null or r.email is distinct from lower(btrim(p_actor_email))) then raise exception 'Document access denied.' using errcode='42501'; end if;
  select * into previous from public.resident_profile_documents where resident_id=p_resident_id and slot=p_slot;
  select exists(select 1 from public.resident_profile_completions where resident_id=p_resident_id and submitted_at is not null) into locked;
  legacy := case p_slot when 'photo' then r.photo_url when 'resident_front' then r.id_card_url end;
  if not is_staff and (locked or previous.source='staff' or coalesce(btrim(legacy),'')<>'') then
    raise exception 'Document is locked or recorded by staff. Contact staff for corrections.';
  end if;
  if p_path not like p_resident_id::text || '/' || p_slot || '/%' or p_path like '%..%' or
    not exists(select 1 from storage.objects where bucket_id='resident-documents' and name=p_path) then raise exception 'Invalid private document path.'; end if;
  insert into public.resident_profile_documents(resident_id,slot,storage_path,content_type,size_bytes,source,actor)
    values(p_resident_id,p_slot,p_path,p_content_type,p_size,case when is_staff then 'staff' else 'resident' end,p_actor_email)
    on conflict(resident_id,slot) do update set storage_path=excluded.storage_path,content_type=excluded.content_type,size_bytes=excluded.size_bytes,source=excluded.source,actor=excluded.actor,updated_at=now();
  -- Retain replaced objects; never overwrite/delete an existing upload.
  if is_staff then
    if p_slot='photo' then update public.residents set photo_url=p_path where id=p_resident_id;
    elsif p_slot='resident_front' then update public.residents set id_card_url=p_path where id=p_resident_id; end if;
    if locked then insert into public.resident_profile_corrections(resident_id,actor,previous_values,next_values)
      values(p_resident_id,p_actor_email,coalesce(to_jsonb(previous),'{}'::jsonb),jsonb_build_object('slot',p_slot,'storage_path',p_path)); end if;
  end if;
end; $$;
revoke all on function public.register_resident_profile_document(uuid,text,text,text,integer,text) from public,anon,authenticated;
grant execute on function public.register_resident_profile_document(uuid,text,text,text,integer,text) to service_role;

-- Read-only compatibility for staff-recorded legacy values. External URLs are
-- never fetched/trusted. Private references must resolve to a local object
-- under this resident's UUID; no public bucket or cross-resident path qualifies.
create function public.resolve_profile_legacy_document(p_resident_id uuid,p_slot text)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare value text; parts text[]; bytes bytea; mime text; bucket text; path text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'Server access required.' using errcode='42501'; end if;
  select case p_slot when 'photo' then photo_url when 'resident_front' then id_card_url end into value
    from public.residents where id=p_resident_id;
  value:=btrim(value);
  if coalesce(value,'')='' then return null; end if;
  parts:=regexp_match(value,'^data:([^;,]+);base64,([A-Za-z0-9+/=[:space:]]+)$','i');
  if parts is not null then
    mime:=case lower(parts[1]) when 'image/jpg' then 'image/jpeg' when 'image/x-png' then 'image/png' when 'image/x-ms-bmp' then 'image/bmp' else lower(parts[1]) end;
    begin bytes:=decode(regexp_replace(parts[2],'[[:space:]]','','g'),'base64'); exception when others then return null; end;
    if not (case mime
      when 'image/jpeg' then substring(bytes from 1 for 3)=decode('ffd8ff','hex')
      when 'image/png' then substring(bytes from 1 for 8)=decode('89504e470d0a1a0a','hex')
      when 'image/webp' then substring(bytes from 1 for 4)=convert_to('RIFF','UTF8') and substring(bytes from 9 for 4)=convert_to('WEBP','UTF8')
      when 'image/gif' then substring(bytes from 1 for 6) in (convert_to('GIF87a','UTF8'),convert_to('GIF89a','UTF8'))
      when 'image/bmp' then substring(bytes from 1 for 2)=convert_to('BM','UTF8')
      when 'application/pdf' then p_slot='resident_front' and substring(bytes from 1 for 5)=convert_to('%PDF-','UTF8')
      else false end) then return null; end if;
    return jsonb_build_object('kind','data','url','data:' || mime || ';base64,' || replace(encode(bytes,'base64'),E'\n',''));
  end if;
  if value like 'storage://%' then value:=substring(value from 11); end if;
  if value like p_resident_id::text || '/%' then bucket:='resident-documents'; path:=value;
  else bucket:=split_part(value,'/',1); path:=substring(value from length(bucket)+2); end if;
  if bucket !~ '^[A-Za-z0-9_-]+$' or path not like p_resident_id::text || '/%' or path like '%..%' or path like '%\\%' then return null; end if;
  select coalesce(o.metadata->>'mimetype',d.content_type) into mime from storage.objects o
    join storage.buckets b on b.id=o.bucket_id and b.public=false
    left join public.resident_profile_documents d on bucket='resident-documents' and d.resident_id=p_resident_id and d.slot=p_slot and d.storage_path=o.name
    where o.bucket_id=bucket and o.name=path;
  if mime in ('image/jpeg','image/png','image/webp','image/gif','image/bmp') or (p_slot='resident_front' and mime='application/pdf') then
    return jsonb_build_object('kind','storage','bucket',bucket,'path',path);
  end if;
  return null;
end; $$;
revoke all on function public.resolve_profile_legacy_document(uuid,text) from public,anon,authenticated;
grant execute on function public.resolve_profile_legacy_document(uuid,text) to service_role;

create function public.require_profile_documents()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.residents%rowtype; s text; path text; legacy text;
begin
  if new.submitted_at is null then return new; end if;
  if tg_op='UPDATE' then if old.submitted_at is not null then return new; end if; end if;
  select * into strict r from public.residents where id=new.resident_id for update;
  foreach s in array array['photo','resident_front','resident_back','guardian_front','guardian_back'] loop
    if (s='resident_back' and r.resident_identity_type='Passport') or (s='guardian_back' and r.guardian_identity_type='Passport') then continue; end if;
    select storage_path into path from public.resident_profile_documents where resident_id=r.id and slot=s;
    legacy := case s when 'photo' then r.photo_url when 'resident_front' then r.id_card_url end;
    if coalesce(btrim(legacy),'')<>'' and public.resolve_profile_legacy_document(r.id,s) is not null then continue; end if;
    if path is null or (coalesce(btrim(legacy),'')<>'' and legacy<>path) or not exists(select 1 from storage.objects where bucket_id='resident-documents' and name=path) then
      raise exception 'Required document missing or needs staff review: %',case s
        when 'photo' then 'Resident Profile Photo'
        when 'resident_front' then 'Resident CNIC Front / Passport Identity Page'
        when 'resident_back' then 'Resident CNIC Back'
        when 'guardian_front' then 'Guardian CNIC Front / Passport Identity Page'
        else 'Guardian CNIC Back' end;
    end if;
  end loop;
  update public.residents set
    photo_url=coalesce(nullif(btrim(photo_url),''),(select storage_path from public.resident_profile_documents where resident_id=r.id and slot='photo')),
    id_card_url=coalesce(nullif(btrim(id_card_url),''),(select storage_path from public.resident_profile_documents where resident_id=r.id and slot='resident_front'))
    where id=r.id;
  return new;
end; $$;
revoke all on function public.require_profile_documents() from public,anon,authenticated;
create trigger require_profile_documents before insert or update on public.resident_profile_completions
  for each row execute function public.require_profile_documents();

-- Extended profile whitelist and correction history are defined below.

create or replace function public.save_resident_profile_completion(p_resident_id uuid,p_details jsonb,p_contacts jsonb,p_submit boolean default false)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare r public.residents%rowtype; completion public.resident_profile_completions%rowtype; k text; v text; cleaned jsonb := '{}'; c jsonb;
  allowed text[] := array['cnic','dob','gender','permanent_address','city','nationality','occupation','company_university','father_name','guardian_cnic','guardian_phone','resident_identity_type','guardian_identity_type'];
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
    if (coalesce(btrim(r.emergency_contact),'')='' or coalesce(btrim(r.emergency_contact_name),'')='' or coalesce(btrim(r.emergency_contact_relationship),'')='') and jsonb_array_length(p_contacts)=0 and not exists(select 1 from public.resident_emergency_contacts where resident_id=p_resident_id) then raise exception 'At least one complete emergency contact (name, relationship and phone) is required.'; end if;
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

create or replace function public.audit_locked_resident_profile()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare rid uuid; before_data jsonb; after_data jsonb;
begin
  if tg_table_name='residents' then rid := new.id; else rid := new.resident_id; end if;
  if exists(select 1 from public.resident_profile_completions where resident_id=rid and submitted_at is not null) then
    if tg_table_name='residents' then
      select jsonb_object_agg(key,value) into before_data from jsonb_each(to_jsonb(old)) where key=any(array['cnic','father_name','guardian_cnic','guardian_phone','emergency_contact','emergency_contact_name','emergency_contact_relationship','dob','gender','permanent_address','city','nationality','occupation','company_university','resident_identity_type','guardian_identity_type','photo_url','id_card_url']);
      select jsonb_object_agg(key,value) into after_data from jsonb_each(to_jsonb(new)) where key=any(array['cnic','father_name','guardian_cnic','guardian_phone','emergency_contact','emergency_contact_name','emergency_contact_relationship','dob','gender','permanent_address','city','nationality','occupation','company_university','resident_identity_type','guardian_identity_type','photo_url','id_card_url']);
    else before_data := case when tg_op='INSERT' then '{}'::jsonb else to_jsonb(old)-'updated_at' end; after_data:=to_jsonb(new)-'updated_at'; end if;
    if before_data is distinct from after_data then
      insert into public.resident_profile_corrections(resident_id,actor,previous_values,next_values) values(rid,coalesce(auth.jwt()->>'email','service_role'),before_data,after_data);
    end if;
  end if;
  return new;
end; $$;
revoke all on function public.audit_locked_resident_profile() from public,anon,authenticated;

commit;
