-- Optional contact details; no backfill or existing row updates.
begin;
alter table public.residents
  add column emergency_contact_name text,
  add column emergency_contact_relationship text;
commit;
