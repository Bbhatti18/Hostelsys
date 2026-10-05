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
 await assert.rejects(partial(f,[item(f.dep,10000)],null,false),/commitment/);
 const first=await partial(f,[item(f.rent,17000),item(f.dep,10000)]);
 assert.equal(Number((await one('select effective_bill_paid($1) paid',[f.rent])).paid),0);
 assert.equal(Number((await one('select pending_bill_submissions($1) pending',[f.dep])).pending),10000);
 assert.equal(Number((await one('select amount from payment_followups where receipt_id=$1',[first.receipt_id])).amount),7000);
 await assert.rejects(partial(f,[item(f.dep,8000)]),/available balance/);
 await db.query('select verify_payment_with_allocations($1,$2,$3)',[first.payment_id,first.receipt_id,'verifier@local.invalid']);
 assert.equal(Number((await one('select effective_bill_paid($1) paid',[f.rent])).paid),17000);
 assert.equal(Number((await one('select effective_bill_paid($1) paid',[f.dep])).paid),10000);
 assert.equal((await one('select bill_status from bills where id=$1',[f.dep])).bill_status,'Partially Paid');
 const uid=randomUUID();
 async function staffRequest(bill,amount=7000,replace=null){await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'authenticated',sub:uid,email:'verifier@local.invalid'})]);try{return await one("select request_obligation_payment($1,$2,(now() at time zone 'Asia/Karachi')::date,'Please submit balance',$3) id",[bill,amount,replace]);}finally{await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'service_role'})]);}}
 await staffRequest(f.dep);
 await assert.rejects(staffRequest(f.dep,7001),/outstanding/);
 assert.equal(Number((await one("select sum(amount) n from payments where payment_status='Verified'")).n),27000);
 const {paymentCollectionBreakdown}=loadPure('reportData');
 const ledgerBills=(await db.query('select * from bills')).rows;
 const ledgerPayments=(await db.query("select * from payments where payment_status='Verified'")).rows;
 const report={rent:0,deposit:0,other:0};
 for(const p of ledgerPayments){const payment_allocations=(await db.query('select * from payment_allocations where payment_id=$1',[p.id])).rows;const split=paymentCollectionBreakdown({...p,payment_allocations},ledgerBills);for(const key of Object.keys(report))report[key]+=split[key];}
 assert.deepEqual(JSON.parse(JSON.stringify(report)),{rent:17000,deposit:10000,other:0});
 const final=await partial(f,[item(f.dep,7000)]);
 assert.equal(Number((await one('select effective_bill_paid($1) n',[f.dep])).n),10000);
 await assert.rejects(partial(f,[item(f.dep,1)]),/available balance/);
 await staffRequest(f.dep,7000,final.receipt_id);
 assert.equal((await one('select payment_status from payments where id=$1',[final.payment_id])).payment_status,'Rejected');
 assert.equal(Number((await one('select pending_bill_submissions($1) n',[f.dep])).n),0);
 const corrected=await partial(f,[item(f.dep,7000)]);
 await db.query('select verify_single_payment_receipt($1,$2)',[corrected.receipt_id,'verifier@local.invalid']);
 assert.equal((await one('select bill_status from bills where id=$1',[f.dep])).bill_status,'Paid');
 assert.equal(Number((await one('select count(*) n from bills where admission_id=$1',[f.a])).n),2);
 await assert.rejects(partial(f,[item(f.dep,1)]),/available balance/);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'authenticated',sub:uid,email:'verifier@local.invalid'})]);
 const resolved=(await one('select payment_followup_data() data')).data.find(r=>r.bill_id===f.dep);
 assert.ok(resolved.followups.every(r=>r.status==='Resolved'));
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'service_role'})]);
 const g=await fixture(); const rentPart=await partial(g,[item(g.rent,10000)]);
 await db.query('select verify_single_payment_receipt($1,$2)',[rentPart.receipt_id,'verifier@local.invalid']);
 await staffRequest(g.rent);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'authenticated',sub:uid,email:'verifier@local.invalid'})]);
 let data=(await one('select payment_followup_data() data')).data.find(r=>r.bill_id===g.rent);
 assert.equal(Number(data.remaining),7000);assert.ok(data.followups.some(f=>f.status==='Due Today'));
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'service_role'})]);
 const rentRest=await partial(g,[item(g.rent,7000)]);await db.query('select verify_single_payment_receipt($1,$2)',[rentRest.receipt_id,'verifier@local.invalid']);
 assert.equal(Number((await one('select count(*) n from bills where admission_id=$1',[g.a])).n),1);
 const h=await fixture();
 const before=(await one("select coalesce(sum(amount),0) n from payments where payment_status='Verified'")).n;
 const ev=await one("insert into historical_payment_evidence(resident_id,purpose,payment_date,amount,payment_method,description,receipt_path) values($1,'Previous Rent + Security Deposit',current_date-30,34000,'Bank','Old receipt',$2) returning id",[h.r,h.r+'/old.pdf']);
 await db.query("select review_historical_evidence($1,'Verified','verifier@local.invalid','Accepted as genuine historical evidence')",[ev.id]);
 assert.equal((await one("select coalesce(sum(amount),0) n from payments where payment_status='Verified'")).n,before);
 assert.equal(Number((await one('select count(*) n from historical_payment_evidence_reviews where evidence_id=$1',[ev.id])).n),1);
 await assert.rejects(db.query("select review_historical_evidence($1,'Verified','verifier@local.invalid','Repeat')",[ev.id]),/no longer pending/);
 await assert.rejects(db.query("insert into historical_payment_evidence(resident_id,purpose,payment_date,amount,payment_method,description,receipt_path,status) values($1,'Previous Rent',current_date,1,'Bank','Attempt',$2,'Verified')",[h.r,h.r+'/proof']),/pending evidence/);
 assert.equal(Number((await one('select effective_bill_paid($1) n',[h.rent])).n),0);
 for(const purpose of ['Previous Rent','Previous Security Deposit','Other Charges']) {
  const evidence=await one("insert into historical_payment_evidence(resident_id,purpose,payment_date,amount,payment_method,description,receipt_path) values($1,$2,current_date-30,17000,'Bank','Historical evidence only',$3) returning id,payment_date,created_at",[h.r,purpose,h.r+'/legacy.pdf']);
  assert.notEqual(String(evidence.payment_date).slice(0,10),String(evidence.created_at).slice(0,10));
  await db.query("select review_historical_evidence($1,'Verified','verifier@local.invalid','Historical acceptance only')",[evidence.id]);
  assert.equal((await one("select coalesce(sum(amount),0) n from payments where payment_status='Verified'")).n,before);
  assert.equal(Number((await one('select effective_bill_paid($1) n',[h.rent])).n),0);
  assert.equal(Number((await one('select pending_bill_submissions($1) n',[h.rent])).n),0);
 }
 await assert.rejects(db.query("update historical_payment_evidence set description='rewrite' where id=$1",[ev.id]),/immutable/);
 await assert.rejects(db.query("insert into historical_payment_evidence(resident_id,purpose,payment_date,amount,payment_method,description,receipt_path) values($1,'Other Charges',current_date-1,1,'Bank','',$2)",[h.r,h.r+'/proof']),/check constraint/);
 await partial(h,[item(h.rent,17000)]);
 const extra=await one("select create_additional_payment_submission($1,$2,null,null,1,1,'Other','Standalone other charge','Bank',$3,'notes',$4,'proof.pdf') result",[h.r,h.a,randomUUID(),h.r+'/extra.pdf']);
 await assert.rejects(db.query("update payments set payment_status='Verified' where id=$1",[extra.result.payment_id]),/confirmation/);
 await db.query("select verify_additional_payment($1,'verifier@local.invalid',1,'Other','Staff classification')",[extra.result.receipt_id]);

 const cancelFixture=await fixture();const cancelled=await partial(cancelFixture,[item(cancelFixture.rent,10000)]);
 await db.query('select cancel_payment_with_allocations($1,$2,$3)',[cancelled.payment_id,'verifier@local.invalid','Correction']);
 assert.equal(Number((await one('select pending_bill_submissions($1) n',[cancelFixture.rent])).n),0);
 const under=await partial(cancelFixture,[item(cancelFixture.rent,17000)]);
 await assert.rejects(db.query("insert into payments(payment_number,resident_id,bill_id,amount,payment_method) values($1,$2,$3,1,'Bank')",[randomUUID(),cancelFixture.r,cancelFixture.rent]),/Pending submissions/);
 await db.query('select verify_single_payment_receipt($1,$2)',[under.receipt_id,'verifier@local.invalid']);
 await assert.rejects(db.query("insert into payments(payment_number,resident_id,bill_id,amount,payment_method,payment_status) values($1,$2,$3,1,'Bank','Verified')",[randomUUID(),cancelFixture.r,cancelFixture.rent]),/exceeds/);
 const dueFixture=await fixture();const duePayment=await partial(dueFixture,[item(dueFixture.rent,10000)]);
 // Simulate an older still-outstanding promise, locally only.
 await db.query("update payment_followups set due_date=(now() at time zone 'Asia/Karachi')::date-1 where receipt_id=$1",[duePayment.receipt_id]);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'authenticated',sub:uid,email:'verifier@local.invalid'})]);
 await db.exec("set timezone='Pacific/Honolulu'");
 const overdue=(await one('select payment_followup_data() data')).data.find(r=>r.bill_id===dueFixture.rent);
 assert.equal(overdue.followups[0].status,'Overdue');assert.equal(Number(overdue.verified),0);assert.equal(Number(overdue.pending),10000);assert.equal(Number(overdue.remaining),17000);assert.equal(Number(overdue.available),7000);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'authenticated',sub:uid,email:'not-staff@local.invalid'})]);
 await assert.rejects(db.query("select request_obligation_payment($1,1,current_date,'unauthorized',null)",[dueFixture.rent]),/permission/);
 assert.equal((await one('select payment_followup_data() data')).data.length,0);
 for(const role of ['anon','authenticated'])assert.equal((await one("select has_function_privilege($1,'submit_partial_obligations(uuid,uuid,jsonb,date,text,boolean,text,text,text,text,text)','execute') allowed",[role])).allowed,false);
 for(const table of ['payment_followups','historical_payment_evidence','historical_payment_evidence_reviews']) for(const privilege of ['INSERT','UPDATE','DELETE'])assert.equal((await one('select has_table_privilege($1,$2,$3) allowed',['authenticated',table,privilege])).allowed,false);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'service_role'})]);
 await assert.rejects(partial(f,[item(dueFixture.rent,100)]),/payable bill/);
 await db.query("update admissions set status='Completed' where id=$1",[dueFixture.a]);await assert.rejects(partial(dueFixture,[item(dueFixture.rent,100)]),/Current admission/);

 // Release-blocker regressions: real SQL, local fixtures only.
 const serviceClaims=()=>db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'service_role'})]);
 const operatorClaims=(email='verifier@local.invalid')=>db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'authenticated',sub:uid,email})]);
 const replacement=(bill,receipt)=>db.query("select request_obligation_payment($1,1,(now() at time zone 'Asia/Karachi')::date,'Corrected receipt requested',$2)",[bill,receipt]);
 const proofStatus=async id=>(await one('select status from payment_receipts where id=$1',[id])).status;
 const snapshot=()=>one("select (select count(*) from bills) bills,(select count(*) from payment_allocations) allocations,(select coalesce(sum(amount),0) from payments where payment_status='Verified') verified");
 const legacyProof=async(f,notes)=>one("insert into payment_receipts(resident_id,amount,receipt_url,notes) values($1,17000,$2,$3) returning id",[f.r,f.r+'/legacy.png',notes]);
 const legacyNotes=id=>'Payment purpose: Security Deposit\nAdmission ID: '+id;
 await serviceClaims();
 const scoped=await fixture(17000);
 const rentProof=await partial(scoped,[item(scoped.rent,17000)]);
 await db.exec("insert into staff_users(email,full_name,role,status,permissions) values('manager@local.invalid','Manager','Manager','Active',array['payments'])");
 await operatorClaims('manager@local.invalid');
 await replacement(scoped.rent,null); // Ordinary requests remain authorized.
 assert.equal((await one('select payment_followup_data() data')).data.find(r=>r.bill_id===scoped.rent).pending_receipts.length,0);
 await assert.rejects(replacement(scoped.rent,rentProof.receipt_id),/rejection permission/);
 assert.equal(await proofStatus(rentProof.receipt_id),'Pending Verification');
 console.log('PASS previous Manager reproduction now fails safely; ordinary request still allowed');
 await operatorClaims();
 await assert.rejects(replacement(scoped.dep,rentProof.receipt_id),/does not belong/);
 assert.equal(await proofStatus(rentProof.receipt_id),'Pending Verification');
 await serviceClaims();
 const legacy=await legacyProof(scoped,legacyNotes(scoped.a));
 await operatorClaims();
 const depositData=(await one('select payment_followup_data() data')).data.find(r=>r.bill_id===scoped.dep);
 assert.equal(Number(depositData.pending),17000);assert.equal(Number(depositData.available),0);
 assert.deepEqual(depositData.pending_receipts.map(r=>r.id),[legacy.id]);
 await assert.rejects(replacement(scoped.rent,legacy.id),/does not belong/);
 assert.equal(await proofStatus(legacy.id),'Pending Verification');
 console.log('PASS previous Rent-to-legacy-Deposit reproduction now fails safely');
 const beforeReplace=await snapshot();
 await replacement(scoped.dep,legacy.id);
 assert.equal(await proofStatus(legacy.id),'Rejected');assert.deepEqual(await snapshot(),beforeReplace);
 assert.equal((await one('select notes from payment_receipts where id=$1',[legacy.id])).notes,legacyNotes(scoped.a));
 assert.equal((await one('select receipt_url from payment_receipts where id=$1',[legacy.id])).receipt_url,scoped.r+'/legacy.png');
 assert.equal(Number((await one('select pending_bill_submissions($1) n',[scoped.dep])).n),0);
 await replacement(scoped.rent,rentProof.receipt_id);
 assert.equal(await proofStatus(rentProof.receipt_id),'Rejected');assert.deepEqual(await snapshot(),beforeReplace);
 assert.equal(Number((await one("select count(*) n from payment_status_history where payment_id=$1 and next_status='Rejected'",[rentProof.payment_id])).n),1);
 await serviceClaims();
 const allocationFixture=await fixture(17000);
 const allocationProof=await partial(allocationFixture,[item(allocationFixture.rent,17000),item(allocationFixture.dep,10000)]);
 await operatorClaims();
 const allocationData=(await one('select payment_followup_data() data')).data;
 for(const bill of [allocationFixture.rent,allocationFixture.dep]) assert.ok(allocationData.find(r=>r.bill_id===bill).pending_receipts.some(r=>r.id===allocationProof.receipt_id));
 await assert.rejects(replacement(scoped.dep,allocationProof.receipt_id),/does not belong/); // Different resident.
 assert.equal(await proofStatus(allocationProof.receipt_id),'Pending Verification');
 const beforeCombined=await snapshot();await replacement(allocationFixture.dep,allocationProof.receipt_id);
 assert.equal(await proofStatus(allocationProof.receipt_id),'Rejected');assert.deepEqual(await snapshot(),beforeCombined);
 await serviceClaims();
 // Canonical Rent association overrides misleading Deposit notes.
 const canonical=await partial(scoped,[item(scoped.rent,17000)]);
 await db.query('update payment_receipts set notes=$1 where id=$2',[legacyNotes(scoped.a),canonical.receipt_id]);
 await operatorClaims();await assert.rejects(replacement(scoped.dep,canonical.receipt_id),/does not belong/);
 await serviceClaims();
 for(const notes of ['Unknown association',legacyNotes(scoped.a)+'\nAdmission ID: '+scoped.a,legacyNotes(scoped.a)+'\nPayment purpose: Rent',legacyNotes(randomUUID())]) {
   const unknown=await legacyProof(scoped,notes);
   await operatorClaims();await assert.rejects(replacement(scoped.dep,unknown.id),/does not belong/);
   assert.equal(await proofStatus(unknown.id),'Pending Verification');
   assert.ok(!(await one('select payment_followup_data() data')).data.find(r=>r.bill_id===scoped.dep).pending_receipts.some(r=>r.id===unknown.id));
   await serviceClaims();
 }
 const oldAdmission=randomUUID();
 await db.query("insert into admissions(id,resident_id,room_id,bed_id,admission_date,monthly_rent,security_deposit,status) select $1,resident_id,room_id,bed_id,admission_date-30,monthly_rent,security_deposit,'Completed' from admissions where id=$2",[oldAdmission,scoped.a]);
 const oldProof=await legacyProof(scoped,legacyNotes(oldAdmission));
 await operatorClaims();await assert.rejects(replacement(scoped.dep,oldProof.id),/does not belong/);
 assert.equal(await proofStatus(oldProof.id),'Pending Verification');
 console.log('PASS replacement authorization, bidirectional cross-obligation, NULL/ambiguous legacy, allocation/legacy selector parity, canonical precedence, cross-resident/admission, preserved proof/history and zero new money/bills');

 // Pending reserves capacity, never financial credit. Followups cover only unreserved remainder.
 await serviceClaims();
 const pendingCase=await fixture(10000);
 const initialPending=await partial(pendingCase,[item(pendingCase.rent,17000),item(pendingCase.dep,7000)]);
 assert.equal(Number((await one('select effective_bill_paid($1) n',[pendingCase.dep])).n),0);
 assert.equal(Number((await one('select pending_bill_submissions($1) n',[pendingCase.dep])).n),7000);
 await assert.rejects(partial(pendingCase,[item(pendingCase.dep,3001)],null,false),/available balance/);
 await assert.rejects(partial(pendingCase,[item(pendingCase.dep,2000)],null,false),/commitment/);
 const small=await partial(pendingCase,[item(pendingCase.dep,2000)]);
 assert.equal(Number((await one('select amount from payment_followups where receipt_id=$1',[small.receipt_id])).amount),1000);
 await db.query('select reject_single_payment_receipt($1,$2,$3)',[small.receipt_id,'verifier@local.invalid','Correction']);
 assert.equal(Number((await one('select pending_bill_submissions($1) n',[pendingCase.dep])).n),7000);
 const fill=await partial(pendingCase,[item(pendingCase.dep,3000)],null,false);
 assert.equal(Number((await one('select count(*) n from payment_followups where receipt_id=$1',[fill.receipt_id])).n),0);
 assert.equal(Number((await one('select effective_bill_paid($1) n',[pendingCase.dep])).n),0);
 assert.equal(Number((await one('select balance_amount from bills where id=$1',[pendingCase.dep])).balance_amount),10000);
 await assert.rejects(partial(pendingCase,[item(pendingCase.dep,1)],null,false),/available balance/);
 await db.query('select cancel_payment_with_allocations($1,$2,$3)',[fill.payment_id,'verifier@local.invalid','Correction']);
 assert.equal(Number((await one('select pending_bill_submissions($1) n',[pendingCase.dep])).n),7000);
 const finalFill=await partial(pendingCase,[item(pendingCase.dep,3000)],null,false);
 await db.query('select verify_single_payment_receipt($1,$2)',[finalFill.receipt_id,'verifier@local.invalid']);
 await db.query('select verify_payment_with_allocations($1,$2,$3)',[initialPending.payment_id,initialPending.receipt_id,'verifier@local.invalid']);
 assert.equal(Number((await one('select effective_bill_paid($1) n',[pendingCase.dep])).n),10000);
 assert.equal(Number((await one('select count(*) n from bills where admission_id=$1',[pendingCase.a])).n),2);
 // Fill both independently reserved balances; no artificial commitment is needed.
 const both=await fixture(10000);
 const bothFirst=await partial(both,[item(both.rent,5000),item(both.dep,7000)]);
 const bothLast=await partial(both,[item(both.rent,12000),item(both.dep,3000)],null,false);
 assert.equal(Number((await one('select count(*) n from payment_followups where receipt_id=$1',[bothLast.receipt_id])).n),0);
 await assert.rejects(db.query('update payment_receipts set available_balance_submission=false where id=$1',[bothLast.receipt_id]),/immutable/);
 await db.query('select verify_payment_with_allocations($1,$2,$3)',[bothLast.payment_id,bothLast.receipt_id,'verifier@local.invalid']);
 assert.equal(Number((await one('select effective_bill_paid($1) n',[both.dep])).n),3000);
 await db.query('select verify_payment_with_allocations($1,$2,$3)',[bothFirst.payment_id,bothFirst.receipt_id,'verifier@local.invalid']);
 assert.equal(Number((await one('select effective_bill_paid($1) n',[both.dep])).n),10000);
 assert.equal(Number((await one('select effective_bill_paid($1) n',[both.rent])).n),17000);
 const provenance=await fixture();
 await operatorClaims();
 await assert.rejects(db.query("insert into payment_receipts(resident_id,bill_id,amount,receipt_url,available_balance_submission) values($1,$2,17000,$3,true)",[provenance.r,provenance.rent,provenance.r+'/forged.pdf']),/server-only/);
 await serviceClaims();
 console.log('PASS pending-aware commitments: 10k outstanding, 7k pending, 3k capacity, 2k commits 1k, 3k no commitment, over-cap denied, rejection/cancellation restore capacity, independent combined settlement in either order, server-only immutable provenance');
 console.log('PASS partial 27k/7k, same bills, no duplicate pending/overpayment, commitments/requests zero effect, replacement rejection, canonical settlement, due-today and resolved follow-ups, historical isolation, Other Charges classification');
}finally{await db.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
