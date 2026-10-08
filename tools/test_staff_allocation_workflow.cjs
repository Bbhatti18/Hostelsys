// Real in-memory PostgreSQL. No env, network, production database, or email.
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const {randomUUID}=require('node:crypto');
const {PGlite}=require('../.local-checks/late-fee-db/node_modules/@electric-sql/pglite');
let ts;try{ts=require('typescript')}catch{ts=require('../.local-checks/typescript/package/lib/typescript.js')}
const pureModules=new Set(['additionalCharges','paymentAllocations','reportData','contractWorkflow','financialMath','billApproval','residentFinancialSummary']);const pureCache=new Map();
function loadPure(name){name=name.replace(/^.*\//,'').replace(/\.ts$/,'');assert.ok(pureModules.has(name),`Non-pure import blocked: ${name}`);if(pureCache.has(name))return pureCache.get(name);const source=fs.readFileSync(path.join(__dirname,'..','lib',`${name}.ts`),'utf8');const loaded={exports:{}};pureCache.set(name,loaded.exports);const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;vm.runInNewContext(`(function(require,module,exports){${code}\n})`,{}, {timeout:2000})((id)=>loadPure(id),loaded,loaded.exports);return loaded.exports;}
(async()=>{const db=new PGlite();try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,email text);
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      create function auth.role() returns text language sql stable as $$ select coalesce(auth.jwt()->>'role','service_role') $$;
      grant usage on schema auth to anon,authenticated,service_role;
      grant execute on all functions in schema auth to anon,authenticated,service_role;`);
    for(const file of fs.readdirSync('supabase/migrations').sort()) {
      if(file.includes('storage_hardening'))continue; // Supabase storage service is not loaded locally.
      await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8').replace(/^\uFEFF/,''));
    }

 const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
 for(const rpc of ['staff_allocation_snapshot(uuid,uuid,text)','apply_staff_payment_allocation(uuid,uuid,uuid,text,jsonb,text,text,text,text)','generate_missing_staff_rent(uuid,text,text)','staff_correction_history(text)']) {
   for(const role of ['anon','authenticated'])assert.equal((await one('select has_function_privilege($1,$2,\'EXECUTE\') ok',[role,'public.'+rpc])).ok,false);
   assert.equal((await one('select has_function_privilege(\'service_role\',$1,\'EXECUTE\') ok',['public.'+rpc])).ok,true);
 }
 assert.equal((await one("select has_table_privilege('service_role','staff_payment_allocation_audit','INSERT') ok")).ok,false);
 await db.exec("insert into staff_users(email,full_name,role,status) values('verifier@local.invalid','Verifier','Admin','Active')");
 async function fixture(deposit=0){
  const r=randomUUID(),room=randomUUID(),bed=randomUUID(),a=randomUUID(),rent=randomUUID(),dep=deposit?randomUUID():null;
  await db.query("insert into residents(id,full_name,status) values($1,'Fixture','Active')",[r]);
  await db.query('insert into rooms(id,room_number) values($1,$2)',[room,room]);
  await db.query("insert into beds(id,room_id,bed_number,status) values($1,$2,'A','Occupied')",[bed,room]);
  await db.query("insert into admissions(id,resident_id,room_id,bed_id,admission_date,monthly_rent,security_deposit,status) values($1,$2,$3,$4,current_date,17000,$5,'Pending')",[a,r,room,bed,deposit]);
  await db.query("insert into bills(id,bill_number,resident_id,admission_id,bill_type,billing_month,due_date,rent_amount,total_amount) values($1::uuid,$1::text,$2,$3,'Rent',to_char(current_date,'YYYY-MM'),current_date,17000,17000)",[rent,r,a]);
  if(dep)await db.query("insert into bills(id,bill_number,resident_id,admission_id,bill_type,billing_month,due_date,total_amount) values($1::uuid,$1::text,$2,$3,'Security Deposit','Security Deposit',current_date,$4)",[dep,r,a,deposit]);
  return {r,a,rent,dep};
 }

 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'service_role'})]);
 const tomorrow=(await one("select ((now() at time zone 'Asia/Karachi')::date+1)::text d")).d;
 async function partial(f,items,due=tomorrow,ack=true) {return (await one('select submit_partial_obligations($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) result',[f.r,f.a,JSON.stringify(items),due,'Personal issue',ack,'Bank',randomUUID(),'Payment method: Bank',f.r+'/proof.png','proof.png'])).result;}
 const item=(bill_id,amount)=>({bill_id,amount});

 const f=await fixture(17000);
 const first=await partial(f,[item(f.rent,10000)]);
 const snap=async(pay,receipt)=>(await one('select staff_allocation_snapshot($1,$2,$3) s',[pay,receipt,'verifier@local.invalid'])).s;
 const itemsFor=(s,entries)=>entries.map(([key,amount])=>{const b=s.obligations.find(x=>x.bill_id===key);return {bill_id:key,bill_type:b.bill_type,billing_month:b.billing_month,due_date:b.due_date,amount};});
 const apply=async(s,items,action='verify',opts={})=> (await one('select apply_staff_payment_allocation($1,$2,$3,$4,$5,$6,$7,$8,$9) result',
 [opts.id||randomUUID(),s.payment?.id||null,s.receipt?.id||null,action,JSON.stringify(items),s.fingerprint,'Explicit staff reviewed allocation',opts.exception||null,'verifier@local.invalid'])).result;
 let s=await snap(first.payment_id,first.receipt_id);
 const wrong=itemsFor(s,[[f.rent,10000]]);wrong[0].billing_month='1900-01';
 await assert.rejects(apply(s,wrong),/Stale|wrong month/);
 await assert.rejects(apply(s,itemsFor(s,[[f.rent,9000]])),/Exact allocation total/);
 await assert.rejects(apply(s,[...itemsFor(s,[[f.rent,5000]]),...itemsFor(s,[[f.rent,5000]])]),/unique/);
 await apply(s,itemsFor(s,[[f.rent,6000],[f.dep,4000]]));
 assert.equal(Number((await one('select effective_bill_paid($1) n',[f.rent])).n),6000);
 assert.equal(Number((await one('select effective_bill_paid($1) n',[f.dep])).n),4000);
 await assert.rejects(apply(s,itemsFor(s,[[f.rent,10000]])),/changed|pending/);
 assert.equal((await one('select status from payment_receipts where id=$1',[first.receipt_id])).status,'Verified');
 const receiptBefore=await one('select to_jsonb(r) data from payment_receipts r where id=$1',[first.receipt_id]);
 s=await snap(first.payment_id,first.receipt_id);
 const correctionId=randomUUID();const correctedItems=itemsFor(s,[[f.dep,10000]]);
 // Force failure after original reversal and allocation/audit insertion; everything must roll back.
 await db.exec("create function reject_fixture_replacement() returns trigger language plpgsql as $$ begin if new.payment_status='Verified' and new.notes like 'Replacement of %' then raise exception 'Fixture forced transaction failure'; end if; return new; end $$; create trigger reject_fixture_replacement before update on payments for each row execute function reject_fixture_replacement();");
 await assert.rejects(apply(s,correctedItems,'correct',{id:correctionId}),/Fixture forced transaction failure/);
 assert.equal((await one('select payment_status from payments where id=$1',[first.payment_id])).payment_status,'Verified');
 assert.equal(Number((await one('select effective_bill_paid($1) n',[f.rent])).n),6000);
 assert.equal(Number((await one('select count(*) n from staff_payment_allocation_audit where id=$1',[correctionId])).n),0);
 assert.deepEqual(await one('select to_jsonb(r) data from payment_receipts r where id=$1',[first.receipt_id]),receiptBefore);
 await db.exec('drop trigger reject_fixture_replacement on payments; drop function reject_fixture_replacement();');
 const corrected=await apply(s,correctedItems,'correct',{id:correctionId});
 assert.equal(Number((await one('select effective_bill_paid($1) n',[f.rent])).n),0);
 assert.equal(Number((await one('select effective_bill_paid($1) n',[f.dep])).n),10000);
 assert.equal((await one('select payment_status from payments where id=$1',[first.payment_id])).payment_status,'Cancelled');
 assert.deepEqual(await one('select to_jsonb(r) data from payment_receipts r where id=$1',[first.receipt_id]),receiptBefore);
 assert.equal(new Date((await one('select verified_at from payments where id=$1',[corrected.payment_id])).verified_at).getTime(),new Date(s.payment.verified_at).getTime());
 const retry=await apply(s,correctedItems,'correct',{id:correctionId});assert.equal(retry.replayed,true);
 await assert.rejects(apply(s,correctedItems,'correct'),/changed|corrected/);
 assert.equal(Number((await one("select sum(amount) n from payments where resident_id=$1 and payment_status='Verified'",[f.r])).n),10000);
 const reserved=await partial(f,[item(f.dep,7000)]);
 const pending=await partial(f,[item(f.rent,7000)]);
 s=await snap(pending.payment_id,pending.receipt_id);
 assert.equal(Number(s.obligations.find(b=>b.bill_id===f.dep).available),0);
 await assert.rejects(apply(s,itemsFor(s,[[f.dep,7000]])),/unavailable/);
 const race=await Promise.allSettled([apply(s,itemsFor(s,[[f.rent,7000]])),apply(s,itemsFor(s,[[f.rent,7000]]))]);
 assert.equal(race.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(Number((await one('select effective_bill_paid($1) n',[f.rent])).n),7000);
 const g=await fixture();s=await snap(reserved.payment_id,reserved.receipt_id);
 const allocationBefore=(await one('select to_jsonb(pa) row from payment_allocations pa where payment_id=$1',[reserved.payment_id])).row;
 await db.query('update payment_allocations set id=$2 where payment_id=$1',[reserved.payment_id,randomUUID()]);
 await assert.rejects(apply(s,itemsFor(s,[[f.dep,7000]])),/changed/);
 await db.query('update payment_allocations set id=$2 where payment_id=$1',[reserved.payment_id,allocationBefore.id]);
 s=await snap(reserved.payment_id,reserved.receipt_id);
 const legacyReceipt=randomUUID();
 await db.query("insert into payment_receipts(id,resident_id,amount,receipt_url,status,notes) values($1,$2,1000,$3,'Pending Verification',$4)",[legacyReceipt,g.r,g.r+'/legacy.png','Payment purpose: Security Deposit\nAdmission ID: '+f.a]);
 await assert.rejects(snap(null,legacyReceipt),/different or ambiguous admission/);
 await db.query('update payment_receipts set notes=$2 where id=$1',[legacyReceipt,'Payment purpose: Security Deposit\nAdmission ID: '+g.a+'\nAdmission ID: '+g.a]);
 await assert.rejects(snap(null,legacyReceipt),/different or ambiguous admission/);
 const manipulated=itemsFor(s,[[f.dep,7000]]);manipulated[0].bill_id=g.rent;
 await assert.rejects(apply(s,manipulated),/Stale|wrong admission/);
 await db.exec("update staff_users set role='Accountant' where email='verifier@local.invalid'");
 await assert.rejects(apply(s,itemsFor(s,[[f.dep,7000]]),'correct'),/Authorized/);
 await db.exec("update staff_users set role='Admin' where email='verifier@local.invalid'");
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'authenticated',sub:randomUUID(),email:'verifier@local.invalid'})]);
 await assert.rejects(apply(s,itemsFor(s,[[f.dep,7000]])),/Authorized/);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'service_role'})]);
 const month=(await one("select to_char(current_date,'YYYY-MM') m")).m;
 await assert.rejects(one('select generate_missing_staff_rent($1,$2,$3)',[f.a,month,'verifier@local.invalid']),/already exists/);
 await db.query('delete from bills where id=$1',[g.rent]);
 const generated=await one('select generate_missing_staff_rent($1,$2,$3) id',[g.a,month,'verifier@local.invalid']);
 const generatedBill=await one('select * from bills where id=$1',[generated.id]);assert.equal(generatedBill.bill_status,'Pending Approval');
 assert.equal(new Date(generatedBill.due_date).getTime(),new Date((await one('select admission_date from admissions where id=$1',[g.a])).admission_date).getTime());
 await assert.rejects(one('select generate_missing_staff_rent($1,$2,$3)',[g.a,month,'verifier@local.invalid']),/already exists/);
 await assert.rejects(db.query('update staff_payment_allocation_audit set reason=$1 where id=$2',['tamper',correctionId]),/immutable/);
 // An explicit historical exception must never suppress future periods.
 const h=await fixture();
 const dates=await one("select to_char(current_date-interval '1 month','YYYY-MM') past,to_char(current_date+interval '1 month','YYYY-MM') future");
 await db.query('update admissions set admission_date=$1::date where id=$2',[dates.past+'-01',h.a]);
 const historical=randomUUID(),future=randomUUID();
 for(const [key,period] of [[historical,dates.past],[future,dates.future]])await db.query("insert into bills(id,bill_number,resident_id,admission_id,bill_type,billing_month,due_date,rent_amount,total_amount) values($1::uuid,$1::text,$2,$3,'Rent',$4,($4||'-01')::date,17000,17000)",[key,h.r,h.a,period]);
 const original=await partial(h,[item(h.rent,17000)]);
 s=await snap(original.payment_id,original.receipt_id);await apply(s,itemsFor(s,[[h.rent,17000]]));
 s=await snap(original.payment_id,original.receipt_id);
 await assert.rejects(apply(s,itemsFor(s,[[future,17000]]),'correct',{exception:'Explicit historical error'}),/cannot waive future/);
 const historicalResult=await apply(s,itemsFor(s,[[historical,17000]]),'correct',{exception:'Explicit historical staff dating error'});
 assert.equal(Number((await one('select count(*) n from late_fees where bill_id=$1',[historical])).n),0);
 assert.equal(Number((await one('select effective_bill_paid($1) n',[historical])).n),17000);
 assert.equal(Number((await one('select effective_bill_paid($1) n',[h.rent])).n),0);
 assert.equal(Number((await one('select effective_bill_paid($1) n',[future])).n),0);
 // Future normal policy still generates Rs300/day without touching the exception.
 await db.query('select refresh_late_fee($1,$2::date,$3,$4)',[future,dates.future+'-10','verifier@local.invalid','Future policy regression']);
 const normalFee=Number((await one('select calculated_amount from late_fees where bill_id=$1',[future])).calculated_amount);
 assert.ok(normalFee>0);
 await db.query('select refresh_late_fee($1,$2::date,$3,$4)',[future,dates.future+'-11','verifier@local.invalid','Future daily rate regression']);
 assert.equal(Number((await one('select calculated_amount from late_fees where bill_id=$1',[future])).calculated_amount)-normalFee,300);
 assert.equal(Number((await one('select waived_amount from late_fees where bill_id=$1',[future])).waived_amount),0);
 assert.equal((await one('select fee_exception_reason from staff_payment_allocation_audit where replacement_payment_id=$1',[historicalResult.payment_id])).fee_exception_reason,'Explicit historical staff dating error');
 const safeHistory=(await one('select staff_correction_history($1) history',['verifier@local.invalid'])).history;
 assert.ok(safeHistory.some(x=>x.replacement_payment_id===historicalResult.payment_id));assert.ok(safeHistory.every(x=>!('before_state' in x)));
 const multi=await fixture(17000);
 const reopened=(await one("select create_additional_payment_submission($1,$2,null,null,8000,8000,'Other','Canonical charge','Bank',$3,'notes',$4,'proof.pdf') result",[multi.r,multi.a,randomUUID(),multi.r+'/charge.pdf'])).result;
 await db.query("select verify_additional_payment($1,'verifier@local.invalid',8000,'Other','Staff classification')",[reopened.receipt_id]);
 await db.query('select cancel_payment_with_allocations($1,$2,$3)',[reopened.payment_id,'verifier@local.invalid','Fixture reversal of charge']);
 const charge=(await one("select additional_charge->>'billId' id from payment_receipts where id=$1",[reopened.receipt_id])).id;
 const splitProof=await partial(multi,[item(multi.rent,10000)]);
 s=await snap(splitProof.payment_id,splitProof.receipt_id);
 await apply(s,itemsFor(s,[[multi.rent,3000],[multi.dep,3000],[charge,4000]]));
 for(const [bill,expected] of [[multi.rent,3000],[multi.dep,3000],[charge,4000]])assert.equal(Number((await one('select effective_bill_paid($1) n',[bill])).n),expected);
 const classified=await fixture();
 const extra=(await one("select create_additional_payment_submission($1,$2,null,null,1000,1000,'Other','Existing classified charge','Bank',$3,'notes',$4,'proof.pdf') result",[classified.r,classified.a,randomUUID(),classified.r+'/extra.pdf'])).result;
 await db.query("select verify_additional_payment($1,'verifier@local.invalid',1000,'Other','Staff classification')",[extra.receipt_id]);
 s=await snap(extra.payment_id,extra.receipt_id);
 await apply(s,itemsFor(s,[[classified.rent,1000]]),'correct');
 assert.equal(Number((await one('select effective_bill_paid($1) n',[classified.rent])).n),1000);
 assert.equal((await one('select status from payment_receipts where id=$1',[extra.receipt_id])).status,'Verified');
 console.log('PASS real SQL staff allocation: exact periods/types/totals, split/partial credit, correction preservation, replay, duplicate prevention, pending reservations, concurrent stale verification, role gates, immutable audit and canonical missing bill generation.');
 }finally{await db.close();}})().catch(e=>{console.error(e);process.exitCode=1});
