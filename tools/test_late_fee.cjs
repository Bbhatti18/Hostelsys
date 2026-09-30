// Executes the real migration and ledger transitions locally. Never loads .env or connects remotely.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { randomUUID } = require('node:crypto');
let PGlite;
try { ({ PGlite } = require('../.local-checks/late-fee-db/node_modules/@electric-sql/pglite')); }
catch { throw new Error('Install the isolated PostgreSQL test dependency using the command in docs/late-fee-lifecycle.md. SQL tests must not be skipped.'); }
const mod = {exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('lib/lateFee.ts','utf8'), {
 compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}
}).outputText,{module:mod,exports:mod.exports,require,Intl,Date});
const {calculateLateFee,lateFeePayable}=mod.exports;
const cases = [
 ...[1,2,3,4,5].map(day=>['2026-08-20', '2026-09-0'+day, 0]),
 ['2026-08-20','2026-09-06',1800],['2026-08-20','2026-09-07',2100],['2026-08-20','2026-09-10',3000],
 ['2026-09-01','2026-09-06',1500],['2026-09-10','2026-09-06',0],
 ['2026-09-10','2026-09-10',0],['2026-09-10','2026-09-11',300],
 ['2026-09-10','2026-09-14',1200],['2026-09-10','2026-09-15',1500],
 ['2026-09-10','2027-12-15',4500],['2026-01-31','2026-03-15',4500],
 ['2028-01-31','2028-03-15',4500]
];
for(const [due,day,expected] of cases) assert.equal(calculateLateFee(due,day),expected);
assert.equal(calculateLateFee('2026-09-10','2026-10-20','2026-10-01'),0);
assert.equal(lateFeePayable(3000,0,2100),2100);
assert.equal(lateFeePayable(2100,1000,2100),1100);
assert.equal(lateFeePayable(2100,2100,2100),0);
assert.equal(lateFeePayable(2100,1000,null,1100),0);

(async()=>{
 const db=new PGlite();
 try {
 await db.exec(`create or replace function pg_catalog.now() returns timestamptz language sql stable as $$ select '2026-09-30 07:00:00+00'::timestamptz $$; create role anon; create role authenticated; create role service_role bypassrls;
 create schema auth; create table auth.users(id uuid primary key, email text);
 create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
 create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
 create function auth.role() returns text language sql stable as $$ select coalesce(auth.jwt()->>'role','service_role') $$;
 grant usage on schema auth to anon, authenticated, service_role;
 grant execute on all functions in schema auth to anon, authenticated, service_role;`);
 for(const file of fs.readdirSync('supabase/migrations').sort()) {
   if(file.includes('storage_hardening'))continue;
   await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8').replace(/^\uFEFF/,''));
 }
 const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
 const fails=async(sql,args=[],pattern) => {
   await assert.rejects(db.query(sql,args),pattern);
   // A failed deferred constraint aborts the implicit transaction, already rolled back.
 };
 for(const [due,day,expected] of cases) {
   const row=await one('select public.calculate_rent_late_fee($1::date,$2::date) as amount',[due,day]);
   assert.equal(Number(row.amount),expected);
 }
 async function fixture(options={}) {
   const r=randomUUID(), room=randomUUID(),bed=randomUUID(),a=randomUUID(),b=randomUUID(),d=randomUUID();
   await db.query('insert into residents(id,full_name,email,status) values($1,$2,$3,\'Active\')',[r,'Test resident',r+'@test.invalid']);
   await db.query('insert into rooms(id,room_number) values($1,$2)',[room,room]);
   await db.query('insert into beds(id,room_id,bed_number) values($1,$2,\'1\')',[bed,room]);
   await db.query(`insert into admissions(id,resident_id,room_id,bed_id,admission_date,monthly_rent,security_deposit,status)
     values($1,$2,$3,$4,((now() at time zone 'Asia/Karachi')::date - 10),10000,5000,'Active')`,[a,r,room,bed]);
   await db.query(`insert into bills(id,bill_number,resident_id,admission_id,billing_month,rent_amount,total_amount,due_date,bill_status)
     values($1::uuid,$1::uuid::text,$2,$3,'2026-09',10000,10000,((now() at time zone 'Asia/Karachi')::date - $4::integer),$5)`,[b,r,a,options.days??7,options.status??'Pending']);
   await db.query(`insert into bills(id,bill_number,resident_id,admission_id,billing_month,bill_type,total_amount,due_date)
     values($1::uuid,$1::uuid::text,$2,$3,'Security Deposit','Security Deposit',5000,((now() at time zone 'Asia/Karachi')::date - 6))`,[d,r,a]);
   return {r,a,b,d};
 }
 const fee=async(b)=>one('select * from late_fees where bill_id=$1',[b]);
 const refresh=async(b,asof=null)=>one(`select * from public.refresh_late_fee($1,coalesce($2::date,(now() at time zone 'Asia/Karachi')::date),'test','Test refresh.')`,[b,asof]);
 const submit=async(f,includeRent=false,deposit=false,amount=2100)=>{
   const row=await one(`select public.create_late_fee_payment_submission($1,$2,$3,$4,$5,$6,'Bank','', 'Test receipt','test/file.pdf','file.pdf') as result`,
    [f.r,f.a,f.b,deposit?f.d:null,includeRent,amount]);
   return row.result;
 };
 const verify=async(s)=>one('select public.verify_payment_with_allocations($1,$2,\'admin@test.invalid\')',[s.payment_id,s.receipt_id]);
 const reject=async(s)=>one('select public.reject_payment_with_allocations($1,$2,\'admin@test.invalid\',\'Unreadable proof\')',[s.payment_id,s.receipt_id]);
 const cancel=async(s)=>one('select public.cancel_payment_with_allocations($1,\'admin@test.invalid\',\'Test cancellation\')',[s.payment_id]);
 const f=await fixture();
 // Submit on cycle day six, then process on day seven: verify stays 1800, reject recalculates 2100.
 async function earlierSubmission(f, amount=1800) {
   const p=randomUUID(),r=randomUUID();
   await db.exec('begin');
   try {
     await db.query(`insert into payments(id,payment_number,resident_id,amount,payment_method) values($1,$2,$3,$4,'Bank')`,[p,p,f.r,amount]);
     await db.query(`insert into payment_receipts(id,resident_id,payment_id,amount,receipt_url,created_at)
       values($1,$2,$3,$4,'test.pdf',now()-interval '1 day')`,[r,f.r,p,amount]);
     const frozen=await one('select * from public.freeze_late_fee_for_receipt($1,$2,$3)',[f.b,r,p]);
     await db.query('insert into late_fee_payment_allocations(payment_id,late_fee_id,receipt_id,amount) values($1,$2,$3,$4)',[p,frozen.id,r,amount]);
     await db.exec('commit');
     return {payment_id:p,receipt_id:r};
   } catch(error) { await db.exec('rollback');throw error; }
 }
 const delay=await fixture();
 const delayed=await earlierSubmission(delay);
 assert.equal(Number((await fee(delay.b)).payable_amount),1800);
 await verify(delayed);
 assert.equal(Number((await fee(delay.b)).paid_amount),1800,'verification delay cannot increase fine');
 const released=await fixture();
 const releasePending=await earlierSubmission(released);
 await reject(releasePending);
 assert.equal(Number((await fee(released.b)).payable_amount),2100,'rejection recalculates current applicable date');
 const cancelled=await fixture();
 await cancel(await earlierSubmission(cancelled));
 assert.equal(Number((await fee(cancelled.b)).payable_amount),2100,'cancellation recalculates current applicable date');
 const excess=await fixture();
 await assert.rejects(earlierSubmission(excess,1801),/exceeds payable|explicit pending/);
 assert.equal(await fee(excess.b),undefined,'overallocated submission rolls back entirely');
 assert.equal(Number((await refresh(f.b)).payable_amount),2100);
 assert.equal(Number((await one('select public.current_rent_late_fee($1,current_date) as amount',[f.d])).amount),0);
 await fails('select public.refresh_late_fee($1,current_date,\'test\',\'Deposit\')',[f.d],/rent bill/);
 for(const status of ['Cancelled','Draft','Pending Approval']) {
   const blocked=await fixture({status});
   assert.equal(Number((await refresh(blocked.b)).payable_amount),0);
 }
 const fresh=await fixture({days:0});
 assert.equal(Number((await refresh(fresh.b)).payable_amount),0);
 const archived=await fixture();
 await db.query("update admissions set status='Archived' where id=$1",[archived.a]);
 assert.equal(Number((await refresh(archived.b)).payable_amount),0);
 const bad=await fixture({days:20});
 await fails('select public.refresh_late_fee($1,current_date,\'test\',\'Invalid anchor\')',[bad.b],/precedes admission/);
 const discounted=await fixture();
 await db.query('update bills set discount_amount=10000,total_amount=0 where id=$1',[discounted.b]);
 assert.equal(Number((await refresh(discounted.b)).payable_amount),0);
 const utilities=await fixture();
 await db.query('update bills set electricity_amount=2000,discount_amount=1200,total_amount=10800 where id=$1',[utilities.b]);
 await db.query(`insert into payments(payment_number,resident_id,bill_id,amount,payment_method,payment_status)
   values($1,$2,$3,9000,'Bank','Verified')`,[randomUUID(),utilities.r,utilities.b]);
 assert.equal(Number((await one('select public.current_rent_late_fee($1,current_date) as amount',[utilities.b])).amount),0,'unpaid utilities must not accrue rent fine');
 assert.equal(Number((await refresh(utilities.b)).payable_amount),2100,'preserve the fine accrued before net rent settlement');
 const s=await submit(f);
 await fails('update payments set amount=amount+1 where id=$1',[s.payment_id],/explicit bill and late-fee allocations/);
 assert.equal((await fee(f.b)).freeze_payment_id,s.payment_id);
 assert.equal(Number((await refresh(f.b,'2099-12-01')).payable_amount),2100,'pending freeze must not grow');
 await assert.rejects(submit(f),/already freezes/);
 assert.equal((await fee(f.b)).freeze_payment_id,s.payment_id,'conflict cannot replace freeze');
 await fails('update late_fee_payment_allocations set amount=2200 where payment_id=$1',[s.payment_id],/immutable/);
 await fails('update late_fees set calculated_amount=1800,frozen_amount=1800 where bill_id=$1',[f.b],/explicit pending/);
 await reject(s);
 assert.equal((await fee(f.b)).freeze_payment_id,null);
 assert.equal((await fee(f.b)).status,'Charged');
 const s2=await submit(f);
 await cancel(s2);
 assert.equal((await fee(f.b)).freeze_payment_id,null);
 const s3=await submit(f);
 await verify(s3);
 assert.equal((await fee(f.b)).status,'Paid');
 assert.equal(Number((await fee(f.b)).payable_amount),0);
 assert.equal(Number((await fee(f.b)).paid_amount),2100);
 await assert.rejects(verify(s3),/no longer pending/);
 await cancel(s3);
 assert.equal(Number((await fee(f.b)).paid_amount),0);
 assert.equal(Number((await fee(f.b)).payable_amount),2100);
 await assert.rejects(cancel(s3),/already cancelled/);
 await fails('update late_fees set paid_amount=2100,status=\'Paid\' where bill_id=$1',[f.b],/requires verified explicit/);
 const unrelated=await fixture();
 await refresh(unrelated.b);
 await db.query(`insert into payments(payment_number,resident_id,bill_id,amount,payment_method,payment_status)
   values($1,$2,$3,10000,'Bank','Verified')`,[randomUUID(),unrelated.r,unrelated.b]);
 assert.equal(Number((await fee(unrelated.b)).paid_amount),0,'unrelated verified rent cannot pay a fine');
 assert.equal(Number((await refresh(unrelated.b,'2099-12-01')).payable_amount),2100,'cleared rent stops accrual but retains charge');
 const rentFine=await fixture();
 const rentFineSubmission=await submit(rentFine,true,false,12100);
 await verify(rentFineSubmission);
 await db.query("update payments set notes='Verified note update' where id=$1",[rentFineSubmission.payment_id]);
 assert.equal(Number((await one('select public.effective_bill_paid($1) as amount',[rentFine.b])).amount),10000);
 assert.equal(Number((await fee(rentFine.b)).paid_amount),2100);
 const receiptRejected=await fixture();
 const receiptPending=await submit(receiptRejected);
 await db.query("update payment_receipts set status='Rejected',remarks='Receipt-only rejection' where id=$1",[receiptPending.receipt_id]);
 assert.equal((await fee(receiptRejected.b)).freeze_payment_id,null);
 assert.equal((await one('select payment_status from payments where id=$1',[receiptPending.payment_id])).payment_status,'Rejected');
 const three=await fixture();
 await verify(await submit(three,true,true,17100));
 assert.equal(Number((await one('select public.effective_bill_paid($1) as amount',[three.d])).amount),5000);
 const legacy=await fixture({days:0});
 await assert.rejects(one(`select public.create_combined_payment_submission($1,$2,$3,$4,14999,'Bank','','Test','file.pdf','file.pdf')`,[legacy.r,legacy.a,legacy.b,legacy.d]),/exact current/);
 const old=await one(`select public.create_combined_payment_submission($1,$2,$3,$4,15000,'Bank','','Test','file.pdf','file.pdf') as result`,[legacy.r,legacy.a,legacy.b,legacy.d]);
 await verify(old.result);
 assert.equal(Number((await one('select public.effective_bill_paid($1) as amount',[legacy.b])).amount),10000);
 assert.equal(Number((await fee(legacy.b)).payable_amount),0);
 // Authenticated waiver RPC derives identity from auth, not a browser-supplied actor.
 const admin=randomUUID();
 await db.query('insert into auth.users(id,email) values($1,\'admin@test.invalid\')',[admin]);
 await db.query(`insert into staff_users(email,full_name,role,status) values('admin@test.invalid','Admin','Admin','Active')`);
 const claims=async(role,email,id=admin)=>db.query('select set_config(\'request.jwt.claims\',$1,false)',[JSON.stringify({role,email,sub:id})]);
 const w=await fixture();
 await claims('authenticated','admin@test.invalid');
 await db.exec('set role authenticated');
 await fails('select public.adjust_late_fee($1,\'Waive\',1000,\' \')',[w.b],/reason/);
 let waived=await one('select * from public.adjust_late_fee($1,\'Waive\',1000,\'Hardship\')',[w.b]);
 assert.equal(Number(waived.payable_amount),1100);
 waived=await one('select * from public.adjust_late_fee($1,\'Waive\',2100,\'Full hardship waiver\')',[w.b]);
 assert.equal(waived.status,'Waived');assert.equal(Number(waived.payable_amount),0);
 await fails('select public.adjust_late_fee($1,\'Waive\',2101,\'Too much\')',[w.b],/Invalid total waiver/);
 await one('select public.adjust_late_fee($1,\'Waive\',1000,\'Correct waiver\')',[w.b]);
 await one('select public.adjust_late_fee($1,\'Charge\',0,\'Apply calculated fine\')',[w.b]);
 await fails('update late_fees set waived_amount=0 where bill_id=$1',[w.b],/permission denied/);
 await claims('authenticated','outsider@test.invalid');
 await fails('select public.adjust_late_fee($1,\'Waive\',0,\'Not admin\')',[w.b],/Active Admin/);
 await fails('select public.quote_late_fee($1)',[w.b],/unavailable/);
 assert.equal((await db.query('select * from late_fees')).rows.length,0,'RLS isolates outsiders');
 await db.exec('reset role');await claims('service_role','');
 await db.query("update staff_users set role='Super Admin' where email='admin@test.invalid'");
 await claims('authenticated','admin@test.invalid');await db.exec('set role authenticated');
 await one('select public.adjust_late_fee($1,\'Charge\',0,\'Super Admin charge\')',[w.b]);
 await db.exec('reset role');await claims('service_role','');
 await db.query("update staff_users set status='Inactive' where email='admin@test.invalid'");
 await claims('authenticated','admin@test.invalid');await db.exec('set role authenticated');
 await fails('select public.adjust_late_fee($1,\'Waive\',0,\'Inactive admin\')',[w.b],/Active Admin/);
 await db.exec('reset role');await claims('service_role','');
 await db.query("update staff_users set status='Active' where email='admin@test.invalid'");
 const ws=await submit(w,false,false,1100);
 await claims('authenticated','admin@test.invalid');await db.exec('set role authenticated');
 await fails('select public.adjust_late_fee($1,\'Waive\',0,\'Frozen adjustment\')',[w.b],/pending receipt/);
 await db.exec('reset role');await claims('service_role','');
 await verify(ws);
 assert.equal(Number((await fee(w.b)).waived_amount),1000);
 assert.equal((await fee(w.b)).status,'Paid');
 await fails('delete from late_fee_history where late_fee_id=$1',[(await fee(w.b)).id],/cannot be changed/);
 // Actual next-bill boundary, not an anniversary (including January 31).
 for (const [due,asof,next,expected] of [
   ['2026-09-10','2026-10-20','2026-10-01',0],
   ['2026-01-31','2026-03-15','2026-02-28',0],
   ['2026-01-31','2026-03-15','2026-03-10',2700],
 ]) {
   assert.equal(calculateLateFee(due,asof,next),expected);
   assert.equal(Number((await one('select public.calculate_rent_late_fee($1,$2,$3) as amount',[due,asof,next])).amount),expected);
 }
 async function oldCycle() {
   const f=await fixture({days:21});
   await db.query("update admissions set admission_date=(now() at time zone 'Asia/Karachi')::date-40 where id=$1",[f.a]);
   return f;
 }
 async function followingBill(f) {
   const id=randomUUID();
   await db.query(`insert into bills(id,bill_number,resident_id,admission_id,billing_month,rent_amount,total_amount,due_date)
     values($1::uuid,$1::uuid::text,$2,$3,'2026-10',10000,10000,(now() at time zone 'Asia/Karachi')::date-10)`,[id,f.r,f.a]);
   return id;
 }
 const boundary=await oldCycle();
 assert.equal(Number((await refresh(boundary.b)).calculated_amount),6300);
 const nextBill=await followingBill(boundary);
 const reconciled=await refresh(boundary.b);
 assert.equal(Number(reconciled.calculated_amount),3000);
 assert.equal(Number(reconciled.payable_amount),3000);
 const down=await one("select * from late_fee_history where late_fee_id=$1 and calculated_before=6300 and calculated_after=3000",[reconciled.id]);
 assert.equal(Number(down.amount_before),6300);assert.equal(Number(down.amount_after),3000);
 assert.equal(down.action,'Recalculated');assert.ok(down.reason && down.actor && down.created_at);
 await db.query("update bills set bill_status='Cancelled' where id=$1",[nextBill]);
 assert.equal(Number((await refresh(boundary.b)).calculated_amount),6300,'cancelled next bill no longer establishes a boundary');
 assert.ok(await one('select id from late_fee_history where late_fee_id=$1 and calculated_before=3000 and calculated_after=6300',[reconciled.id]));
 const frozenCycle=await oldCycle();
 const frozenPayment=await submit(frozenCycle,false,false,6300);
 const frozenBefore=await fee(frozenCycle.b);
 await followingBill(frozenCycle);
 assert.deepEqual(await refresh(frozenCycle.b),frozenBefore,'boundary recalculation must not mutate an active freeze');
 await reject(frozenPayment);
 assert.equal(Number((await fee(frozenCycle.b)).calculated_amount),3000);
 assert.equal((await fee(frozenCycle.b)).freeze_payment_id,null);
 const settledCycle=await oldCycle();
 await claims('authenticated','admin@test.invalid');await db.exec('set role authenticated');
 await one("select public.adjust_late_fee($1,'Waive',1000,'Cycle waiver')",[settledCycle.b]);
 await db.exec('reset role');await claims('service_role','');
 await verify(await submit(settledCycle,false,false,5300));
 await followingBill(settledCycle);
 const reconciledPaid=await refresh(settledCycle.b);
 assert.equal(Number(reconciledPaid.calculated_amount),3000);
 assert.equal(Number(reconciledPaid.paid_amount),5300);
 assert.equal(Number(reconciledPaid.waived_amount),1000);
 assert.equal(Number(reconciledPaid.payable_amount),0);assert.equal(reconciledPaid.status,'Paid');
 assert.ok(await one('select id from late_fee_history where late_fee_id=$1 and calculated_before=6300 and calculated_after=3000',[reconciledPaid.id]));
 const rentOnly=await fixture();
 assert.equal(await fee(rentOnly.b),undefined);
 const rentReceipt=randomUUID();
 await db.query("insert into payment_receipts(id,resident_id,bill_id,amount,receipt_url) values($1,$2,$3,10000,'rent-only.pdf')",[rentReceipt,rentOnly.r,rentOnly.b]);
 await one("select public.verify_single_payment_receipt($1,'admin@test.invalid')",[rentReceipt]);
 const preserved=await fee(rentOnly.b);
 assert.equal(Number(preserved.calculated_amount),2100);
 assert.equal(Number(preserved.payable_amount),2100);assert.equal(Number(preserved.paid_amount),0);
 assert.equal(preserved.status,'Charged');
 assert.equal(Number((await one('select public.outstanding_rent($1) as amount',[rentOnly.b])).amount),0);
 assert.equal(Number((await refresh(rentOnly.b,'2099-12-01')).payable_amount),2100,'rent settlement stops new accrual without erasing the ledger');
 const combinedAccrual=await fixture();
 const normalCombined=await one("select public.create_combined_payment_submission($1,$2,$3,$4,15000,'Bank','','Test','file.pdf','file.pdf') as result",[combinedAccrual.r,combinedAccrual.a,combinedAccrual.b,combinedAccrual.d]);
 await verify(normalCombined.result);
 assert.equal(Number((await fee(combinedAccrual.b)).payable_amount),2100,'normal combined verification also preserves accrued fine');
 // Charge action and later as-of dates cannot relabel/reopen a settled fee.
 await claims('authenticated','admin@test.invalid');await db.exec('set role authenticated');
 const chargedSettled=await one("select * from public.adjust_late_fee($1,'Charge',0,'Recheck settled fine')",[settledCycle.b]);
 assert.equal(chargedSettled.status,'Paid');assert.equal(Number(chargedSettled.payable_amount),0);
 await db.exec('reset role');await claims('service_role','');
 assert.equal((await refresh(settledCycle.b,'2099-12-01')).status,'Paid');
 assert.equal((await refresh(delay.b,'2099-12-01')).status,'Paid','settled fine without a next bill must not reopen');
 const chargeEvent=await one("select * from late_fee_history where late_fee_id=$1 and reason='Recheck settled fine' and action='Charged'",[chargedSettled.id]);
 assert.equal(Number(chargeEvent.amount_after),0);
 assert.ok(Number((await one(`select count(*) as n from late_fee_history where action in ('Frozen','Released','Paid','Reversed','Waived','Partially Waived','Charged')`)).n)>15);
 console.log('PASS: date/grace/cycle caps, admission protection, deposit/non-payable exclusion, freeze/conflict/release, explicit allocations, verification/reversal, legacy combined totals, admin waiver/RLS and audit (real local PostgreSQL).');
 } finally { await db.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
