// Local PostgreSQL only. Never loads env files, SDKs or email transports.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {randomUUID} = require('node:crypto');
const {PGlite} = require('../.local-checks/late-fee-db/node_modules/@electric-sql/pglite');
const migration = '20260930130000_repair_initial_rent_due_dates.sql';
const repair = fs.readFileSync('supabase/migrations/'+migration,'utf8');

(async()=>{
 const db = new PGlite();
 try {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
   create schema auth; create table auth.users(id uuid primary key,email text);
   create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
   create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
   create function auth.role() returns text language sql stable as $$ select coalesce(auth.jwt()->>'role','service_role') $$;
   grant usage on schema auth to anon,authenticated,service_role;
   grant execute on all functions in schema auth to anon,authenticated,service_role;
   create or replace function pg_catalog.now() returns timestamptz language sql stable as $$ select '2026-10-01 07:00:00+00'::timestamptz $$;`);
  for(const file of fs.readdirSync('supabase/migrations').sort()) {
   if(file.includes('storage_hardening') || file >= migration) continue;
   await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8').replace(/^\uFEFF/,''));
  }
  const one = async(sql,args=[]) => (await db.query(sql,args)).rows[0];
  async function admission(resident=null, date='2026-10-01', status='Active') {
   const r=resident || randomUUID(),room=randomUUID(),bed=randomUUID(),a=randomUUID();
   if(!resident) await db.query("insert into residents(id,full_name,status) values($1,'Repair fixture','Active')",[r]);
   await db.query('insert into rooms(id,room_number) values($1,$2)',[room,room]);
   await db.query("insert into beds(id,room_id,bed_number) values($1,$2,'1')",[bed,room]);
   await db.query('insert into admissions(id,resident_id,room_id,bed_id,admission_date,monthly_rent,status) values($1,$2,$3,$4,$5,10000,$6)',[a,r,room,bed,date,status]);
   return {r,a};
  }
  async function bill(f, {month='2026-10',due='2026-10-06',type='Rent',status='Pending',total=10000}={}) {
   const b=randomUUID();
   await db.query(`insert into bills(id,bill_number,resident_id,admission_id,billing_month,bill_type,
    rent_amount,total_amount,due_date,bill_status,notes,created_at,updated_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Preserve this note','2026-09-20','2026-09-20')`,
    [b,b,f.r,f.a,type==='Security Deposit'?'Security Deposit':month,type,type==='Rent'?total:0,total,due,status]);
   return {...f,b};
  }
  const fixture=async(options={})=>bill(await admission(),options);
  const eligible=await fixture();
  const pendingAdmission=await bill(await admission(null,'2026-10-01','Pending'));
  const pristine=await fixture();
  await db.query("select public.refresh_late_fee($1,'2026-10-01','local-test','Zero relaxation quote')",[pristine.b]);
  const recurring=await bill(eligible,{month:'2026-11',due:'2026-10-31'});
  const deposit=await bill(eligible,{type:'Security Deposit'});
  const excluded=[recurring,deposit];
  for(const type of ['Late Fee','Other Charges','Electricity','AC']) excluded.push(await fixture({type}));
  excluded.push(await fixture({status:'Cancelled'}));
  excluded.push(await fixture({total:0}));
  excluded.push(await fixture({due:'2026-10-01'}));
  async function payment(f,status,amount=10000,direct=true) {
   const p=randomUUID();
   await db.query(`insert into payments(id,payment_number,resident_id,bill_id,amount,payment_method,payment_status)
    values($1,$2,$3,$4,$5,'Bank',$6)`,[p,p,f.r,direct?f.b:null,amount,status]);
   return p;
  }
  const paid=await fixture(); await payment(paid,'Verified'); excluded.push(paid);
  const partial=await fixture(); await payment(partial,'Verified',1000); excluded.push(partial);
  for(const status of ['Pending','Rejected','Cancelled']) {
   const f=await fixture(); const p=await payment(f,'Pending',1000);
   if(status!=='Pending')await db.query('update payments set payment_status=$2 where id=$1',[p,status]);
   excluded.push(f);
  }
  const allocated=await fixture();
  const allocationPayment=await payment(allocated,'Pending',1000,false);
  await db.query('insert into payment_allocations(payment_id,bill_id,amount) values($1,$2,1000)',[allocationPayment,allocated.b]);
  excluded.push(allocated);
  const ambiguous=await fixture(); await payment(ambiguous,'Pending',1000,false); excluded.push(ambiguous);
  for(const linked of [true,false]) {
   const f=await fixture();
   await db.query("insert into payment_receipts(resident_id,bill_id,amount,receipt_url) values($1,$2,1000,'local-only.pdf')",[f.r,linked?f.b:null]);
   excluded.push(f);
  }
  const old=await bill(await admission(null,'2026-09-01','Completed'),{month:'2026-09',due:'2026-09-06'});
  const current=await bill(await admission(old.r)); excluded.push(old);
  const mismatched=await fixture(); const other=await admission();
  await db.query('update bills set resident_id=$2 where id=$1',[mismatched.b,other.r]); excluded.push(mismatched);
  // Fine states are built using real ledger APIs; the repair must not touch them.
  await db.exec(`create or replace function pg_catalog.now() returns timestamptz language sql stable as $$ select '2026-10-10 07:00:00+00'::timestamptz $$; discard plans;`);
  const charged=await fixture();
  await db.query("select public.refresh_late_fee($1,'2026-10-10','local-test','Existing charge')",[charged.b]); excluded.push(charged);
  const waived=await fixture();
  await db.query("select public.refresh_late_fee($1,'2026-10-10','local-test','Existing charge')",[waived.b]);
  await db.query("insert into staff_users(email,full_name,role,status) values('repair@test.invalid','Repair admin','Admin','Active')");
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'authenticated',email:'repair@test.invalid',sub:randomUUID()})]);
  await db.query("select public.adjust_late_fee($1,'Waive',1200,'Existing explicit waiver history')",[waived.b]);
  await db.query("select set_config('request.jwt.claims','{}',false)"); excluded.push(waived);
  const frozen=await fixture();
  // Receipt created after relaxation freezes a positive authoritative charge.
  const submission=(await one("select public.create_late_fee_payment_submission($1,$2,$3,null,false,1200,'Bank','','Local test','test.pdf','test.pdf') as value",[frozen.r,frozen.a,frozen.b])).value;
  excluded.push(frozen);
  const settled=await fixture();
  const settleSubmission=(await one("select public.create_late_fee_payment_submission($1,$2,$3,null,false,1200,'Bank','','Local test','test.pdf','test.pdf') as value",[settled.r,settled.a,settled.b])).value;
  await db.query("select public.verify_payment_with_allocations($1,$2,'repair@test.invalid')",[settleSubmission.payment_id,settleSubmission.receipt_id]); excluded.push(settled);
  assert.ok(submission.payment_id);
  const tables=['bills','payments','payment_allocations','payment_receipts','payment_status_history','late_fees','late_fee_payment_allocations','late_fee_history','admissions'];
  const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async table=>[table,(await db.query(`select to_jsonb(t) as row from public.${table} t order by id`)).rows.map(r=>r.row)])));
  const before=await snapshot();
  const triggersBefore=(await db.query("select tgname,tgenabled from pg_trigger where tgrelid='public.bills'::regclass order by tgname")).rows;
  await db.exec(repair);
  const after=await snapshot();
  const repaired=new Set([eligible.b,pendingAdmission.b,pristine.b,current.b]);
  for(const row of before.bills) {
   const actual=after.bills.find(b=>b.id===row.id);
   assert.deepEqual(actual,repaired.has(row.id)?{...row,due_date:'2026-10-01'}:row,`Exact row preservation: ${row.id}`);
  }
  for(const table of tables.filter(t=>t!=='bills')) assert.deepEqual(after[table],before[table],table+' untouched');
  assert.equal(excluded.length,24);
  assert.deepEqual((await db.query("select tgname,tgenabled from pg_trigger where tgrelid='public.bills'::regclass order by tgname")).rows,triggersBefore);
  await db.exec(repair);
  assert.deepEqual(await snapshot(),after,'Second application is a complete no-op');
  for(const date of ['2026-09-30','2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05']) {
   assert.equal(Number((await one('select public.rent_cycle_late_fee($1,$2) as fee',[eligible.b,date])).fee),0);
  }
  assert.equal(Number((await one("select public.rent_cycle_late_fee($1,'2026-10-06') as fee",[eligible.b])).fee),1500,'Only Oct 2-6 are overdue');
  assert.equal(after.late_fees.some(f=>f.bill_id===eligible.b),false,'Repair creates no fee');
  assert.equal(Number((await one("select (public.refresh_late_fee($1,'2026-10-06','local-test','Normal later refresh')).payable_amount as fee",[pristine.b])).fee),1500);
  console.log('PASS: initial repair; recurring/non-Rent/cancelled/settled/history/ambiguous exclusions; own-admission isolation; exact field and ledger preservation; trigger restoration; idempotency; no pre-admission fees; relaxation and normal later refresh.');
 } finally {await db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
