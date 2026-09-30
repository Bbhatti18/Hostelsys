// Entirely local: real PostgreSQL via PGlite, injected mail transport, no env files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const {randomUUID} = require('node:crypto');
const {PGlite} = require('../.local-checks/late-fee-db/node_modules/@electric-sql/pglite');
function load(file, requireMock = () => { throw Error('Unexpected import'); }) {
  const mod = {exports:{}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'), {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2021}
  }).outputText,{module:mod,exports:mod.exports,require:requireMock,Date,Intl,Buffer,Response,process:{env:{CRON_SECRET:'local-only'}}});
  return mod.exports;
}
const {rentDueDate} = load('lib/billApproval.ts');
const {runRentReminders,buildRentReminderEmail} = load('lib/rentReminder.ts');
const dates = [
 ['2026-09-10','2026-10','2026-10-09'],
 ['2026-01-31','2026-02','2026-02-27'],
 ['2028-01-31','2028-02','2028-02-28'],
 ['2026-09-01','2026-10','2026-09-30'],
 ['2026-09-10','2026-09','2026-09-10'],
];
for (const [admission,month,due] of dates) assert.equal(rentDueDate(admission,month),due);
assert.throws(()=>rentDueDate('2026-02-31','2026-03'));
assert.throws(()=>rentDueDate('2026-09-10','2026-08'));

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
   create or replace function pg_catalog.now() returns timestamptz language sql stable as $$ select '2026-09-30 20:00:00+00'::timestamptz $$;`);
  const migration = '20260930120000_rent_dates_relaxation_reminders.sql';
  for (const file of fs.readdirSync('supabase/migrations').sort()) {
   if(file.includes('storage_hardening') || file===migration) continue;
   await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8').replace(/^\uFEFF/,''));
  }
  const one = async(sql,args=[]) => (await db.query(sql,args)).rows[0];
  async function fixture({status='Pending',type='Rent',residentStatus='Active',admissionStatus='Active',month='2026-10',admitted='2026-09-10'}={}) {
   const r=randomUUID(),room=randomUUID(),bed=randomUUID(),a=randomUUID(),b=randomUUID();
   await db.query('insert into residents(id,full_name,email,status) values($1,$2,$3,$4)',[r,'Resident <test>',r+'@test.invalid',residentStatus]);
   await db.query('insert into rooms(id,room_number) values($1,$2)',[room,room]);
   await db.query("insert into beds(id,room_id,bed_number) values($1,$2,'1')",[bed,room]);
   await db.query('insert into admissions(id,resident_id,room_id,bed_id,admission_date,monthly_rent,status) values($1,$2,$3,$4,$5,10000,$6)',[a,r,room,bed,admitted,admissionStatus]);
   await db.query('insert into bills(id,bill_number,resident_id,admission_id,billing_month,rent_amount,total_amount,due_date,bill_status,bill_type) values($1,$2,$3,$4,$5,$6,10000,$7,$8,$9)',[b,b,r,a,type==='Security Deposit'?'Security Deposit':month,type==='Rent'?10000:0,'2026-10-06',status,type]);
   if(status==='Paid') {
    await db.query("insert into payments(payment_number,resident_id,bill_id,amount,payment_method,payment_status) values($1,$2,$3,10000,'Bank','Verified')",[randomUUID(),r,b]);
   }
   return {r,a,b};
  }
  const eligible=await fixture();
  const pending=await fixture({admissionStatus:'Pending'});
  const deposit=await fixture({type:'Security Deposit'});
  const initial=await fixture({admitted:'2026-10-01'});
  const historical=await fixture({month:'2026-09'});
  const excluded=[];
  for(const status of ['Paid','Cancelled','Draft','Pending Approval']) excluded.push(await fixture({status}));
  excluded.push(await fixture({residentStatus:'Archived'}));
  excluded.push(await fixture({admissionStatus:'Archived'}));
  excluded.push(await fixture({admitted:'2026-10-10'}));
  await db.exec(fs.readFileSync('supabase/migrations/'+migration,'utf8'));
  for (const [admission,month,due] of dates) {
   assert.equal((await one('select public.admission_rent_due_date($1,$2)::text as due',[admission,month])).due,due);
  }
  assert.equal((await one('select due_date::text as due from bills where id=$1',[eligible.b])).due,'2026-10-09');
  for(const f of [deposit,initial,historical,...excluded.slice(0,2)]) {
   assert.equal((await one('select due_date::text as due from bills where id=$1',[f.b])).due,'2026-10-06');
  }
  // Exclude initial rent from this population after verifying repair left it untouched.
  await db.query("update bills set bill_status='Cancelled' where id=$1",[initial.b]);
  const sent=[];
  const deps={
   claim:async()=> (await one('select public.claim_daily_rent_reminder() as value')).value,
   send:async email=>{sent.push(email);return {status:'sent',providerMessageId:'mock-only'};},
   complete:async(id,status,message)=>{await db.query('update rent_reminder_deliveries set status=$2,provider_message_id=$3 where id=$1',[id,status,message]);},
  };
  const runs=await Promise.all([runRentReminders(deps),runRentReminders(deps)]);
  assert.equal(runs.reduce((n,r)=>n+r.sent,0),2);
  assert.equal((await runRentReminders(deps)).sent,0);
  assert.equal(sent.length,2);
  assert.match(sent[0].text,/2026-10-01/,'Karachi date crosses UTC midnight');
  assert.match(sent[0].text,/Outstanding Rent: Rs 10,000/);
  assert.match(sent[0].text,/Actual Rent due date: 2026-10-09/);
  assert.match(sent[0].text,/Current payable Late Fee: Rs 0/);
  assert.match(sent[0].text,/Total currently payable \(Rent \+ Late Fee\): Rs 10,000/);
  assert.match(sent[0].html,/&lt;test&gt;/);
  await db.exec('set role authenticated');
  await assert.rejects(db.query('select public.claim_daily_rent_reminder()'),/permission denied/);
  await assert.rejects(db.query('select * from rent_reminder_deliveries'),/permission denied/);
  await db.exec('reset role');
  // A new day can claim again, including when the previous outcome is uncertain.
  await db.exec(`create or replace function pg_catalog.now() returns timestamptz language sql stable as $$ select '2026-10-02 07:00:00+00'::timestamptz $$;`);
  await db.exec('discard plans');
  const uncertain=await deps.claim(); assert.ok(uncertain);
  await runRentReminders(deps);
  assert.equal((await runRentReminders(deps)).attempted,0,'uncertain claim must never resend');
  const email=buildRentReminderEmail({...uncertain,rent:10000,lateFee:1800});
  assert.match(email.text,/Late Fee: Rs 1,800/);assert.match(email.text,/Rs 11,800/);
  let called=false;
  const route=load('app/api/cron/rent-reminders/route.ts',name=>{
   if(name==='node:crypto')return require(name);
   if(name==='@/lib/supabaseAdmin')return {supabaseAdmin:{}};
   if(name==='@/lib/email/resendClient')return {emailSenderConfigured:()=>true};
   if(name==='@/lib/rentReminder')return {runRentReminders:async()=>{called=true;return {sent:0};}};
   throw Error(name);
  });
  for(const authorization of [null,'Bearer wrong']) {
   assert.equal((await route.GET(new Request('http://localhost',{headers:authorization?{authorization}:{}}))).status,401);
   assert.equal(called,false);
  }
  assert.equal((await route.GET(new Request('http://localhost',{headers:{authorization:'Bearer local-only'}}))).status,200);
  console.log('PASS: JS/SQL due dates, safe repair, Karachi day-one reminders, exclusions, concurrent/daily idempotency, uncertain delivery retention, email values, RLS, cron authentication; mocked email only.');
 } finally {await db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
