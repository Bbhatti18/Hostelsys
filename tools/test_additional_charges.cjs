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
  await db.query("insert into admissions(id,resident_id,room_id,bed_id,admission_date,monthly_rent,security_deposit,status) values($1,$2,$3,$4,current_date,15000,$5,'Pending')",[a,r,room,bed,deposit]);
  await db.query("insert into bills(id,bill_number,resident_id,admission_id,bill_type,billing_month,due_date,rent_amount,total_amount) values($1::uuid,$1::text,$2,$3,'Rent',to_char(current_date,'YYYY-MM'),current_date,15000,15000)",[rent,r,a]);
  if(dep)await db.query("insert into bills(id,bill_number,resident_id,admission_id,bill_type,billing_month,due_date,total_amount) values($1::uuid,$1::text,$2,$3,'Security Deposit','Security Deposit',current_date,$4)",[dep,r,a,deposit]);
  return {r,a,rent,dep};
 }
 async function submit(f,extra=5140,category='Other',description='Other hostel charges',total=15000+(f.dep?15000:0)+Number(extra)){
  return (await one('select create_additional_payment_submission($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) as result',[f.r,f.a,f.rent,f.dep,total,extra,category,description,'Bank',randomUUID(),'Payment purpose: Rent + Additional Charges',f.r+'/proof.pdf','proof.pdf'])).result;
 }
 const verify=(result,amount=5140,category='Electricity / Utilities')=>one('select verify_additional_payment($1,$2,$3,$4,$5) as result',[result.receipt_id,'verifier@local.invalid',amount,category,'Staff checked receipt']);
 const {additionalChargeError,additionalPaymentTotal}=loadPure('additionalCharges');
 assert.equal(additionalPaymentTotal(15000,5140),20140);assert.equal(additionalPaymentTotal(30000,5140),35140);
 for(const amount of [0,-1,'-1','12.001','NaN','Infinity'])assert.ok(additionalChargeError(amount,'Other','Description'));
 assert.ok(additionalChargeError(10,'Other','  '));assert.ok(additionalChargeError(10,'Unknown','Description'));
 const {paymentCollectionBreakdown}=loadPure('reportData');
 const reportSplit=paymentCollectionBreakdown({bill_id:null,amount:20140,payment_status:'Verified',payment_allocations:[{bill_id:'rent',amount:15000},{bill_id:'extra',amount:5140}]},[{id:'rent',bill_type:'Rent'},{id:'extra',bill_type:'Other Charges'}]);
 assert.deepEqual(JSON.parse(JSON.stringify(reportSplit)),{rent:15000,deposit:0,other:5140});assert.equal(Object.values(reportSplit).reduce((sum,value)=>sum+value,0),20140);
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'service_role'})]);
 const f=await fixture(),result=await submit(f);
 const receipt=await one('select * from payment_receipts where id=$1',[result.receipt_id]);
 assert.equal(Number(receipt.amount),20140);assert.equal(receipt.additional_charge.amount,5140);
 assert.equal(Number((await one('select effective_bill_paid($1) as paid',[f.rent])).paid),0);
 const extraBill=receipt.additional_charge.billId;
 assert.equal((await one('select bill_status from bills where id=$1',[extraBill])).bill_status,'Pending Approval');
 assert.equal(Number((await one("select count(*) as n from payments where payment_status='Verified'")).n),0);
 await assert.rejects(verify(result,5000),/Mismatch/);
 assert.equal((await one('select payment_status from payments where id=$1',[result.payment_id])).payment_status,'Pending');
 await assert.rejects(db.query("update bills set bill_status='Pending' where id=$1",[extraBill]),/Confirm Additional/);
 await assert.rejects(db.query("update payments set payment_status='Verified' where id=$1",[result.payment_id]),/confirmation/);
 await verify(result);
 const allocations=(await db.query('select bill_id,amount from payment_allocations where payment_id=$1',[result.payment_id])).rows;
 assert.equal(allocations.length,2);assert.equal(Number(allocations.find(a=>a.bill_id===f.rent).amount),15000);assert.equal(Number(allocations.find(a=>a.bill_id===extraBill).amount),5140);
 assert.equal(Number((await one("select count(*) as n from payments where payment_status='Verified'")).n),1,'one bank transfer remains one payment');
 assert.equal(Number((await one("select sum(amount) as total from payments where payment_status='Verified'")).total),20140,'parent transfer is counted once');
 assert.equal(Number((await one('select sum(amount) as total from payment_allocations where payment_id=$1',[result.payment_id])).total),20140,'allocation breakdown reconciles without adding it to parent revenue');
 assert.equal(Number((await one('select total_amount from bills where id=$1',[f.rent])).total_amount),15000);
 await one('select cancel_payment_with_allocations($1,$2,$3)',[result.payment_id,'verifier@local.invalid','Local reversal']);
 for(const id of [f.rent,extraBill])assert.equal(Number((await one('select effective_bill_paid($1) as paid',[id])).paid),0);
 assert.equal(Number((await one('select balance_amount from bills where id=$1',[extraBill])).balance_amount),5140);
 const history=(await db.query('select next_status from payment_status_history where payment_id=$1',[result.payment_id])).rows.map(x=>x.next_status);assert.deepEqual(history,['Pending','Verified','Cancelled']);
 const both=await fixture(15000),combined=await submit(both);assert.equal(Number((await one('select amount from payments where id=$1',[combined.payment_id])).amount),35140);await verify(combined);
 const combinedAllocations=(await db.query('select bill_id,amount from payment_allocations where payment_id=$1',[combined.payment_id])).rows;
 assert.equal(combinedAllocations.length,3);assert.equal(Number(combinedAllocations.find(a=>a.bill_id===both.rent).amount),15000);assert.equal(Number(combinedAllocations.find(a=>a.bill_id===both.dep).amount),15000);assert.equal(Number(combinedAllocations.find(a=>a.bill_id!==both.rent&&a.bill_id!==both.dep).amount),5140);
 await one('select cancel_payment_with_allocations($1,$2,$3)',[combined.payment_id,'verifier@local.invalid','Local reversal']);
 for(const id of [both.rent,both.dep])assert.equal(Number((await one('select balance_amount from bills where id=$1',[id])).balance_amount),15000);
 const cancelledPending=await submit(await fixture());const cancelledReceipt=await one('select additional_charge from payment_receipts where id=$1',[cancelledPending.receipt_id]);
 await one('select cancel_payment_with_allocations($1,$2,$3)',[cancelledPending.payment_id,'verifier@local.invalid','Cancel pending declaration']);
 assert.equal((await one('select payment_status from payments where id=$1',[cancelledPending.payment_id])).payment_status,'Cancelled');
 assert.equal(Number((await one('select effective_bill_paid($1) as paid',[cancelledReceipt.additional_charge.billId])).paid),0);
 assert.equal((await one('select bill_status from bills where id=$1',[cancelledReceipt.additional_charge.billId])).bill_status,'Pending Approval');
 const rejected=await submit(await fixture());const rejectedReceipt=await one('select additional_charge from payment_receipts where id=$1',[rejected.receipt_id]);await one('select reject_payment_with_allocations($1,$2,$3,$4)',[rejected.payment_id,rejected.receipt_id,'verifier@local.invalid','Not accepted']);assert.equal(Number((await one("select count(*) as n from payments where payment_status='Verified'")).n),0);assert.equal(Number((await one('select effective_bill_paid($1) as paid',[rejectedReceipt.additional_charge.billId])).paid),0);assert.equal((await one('select bill_status from bills where id=$1',[rejectedReceipt.additional_charge.billId])).bill_status,'Pending Approval');
 for(const amount of [0,-1,'NaN','Infinity','12.001'])await assert.rejects(submit(await fixture(),amount));
 await assert.rejects(submit(await fixture(),10,'Other',''),/description/);
 await assert.rejects(submit(await fixture(),10,'Invalid','test'),/category/);
 const owner=await fixture(),outsider=await fixture();await assert.rejects(submit({...owner,r:outsider.r}),/Current resident/);await assert.rejects(submit({...owner,rent:outsider.rent}),/Invalid current Rent/);
 await db.query("update admissions set status='Completed' where id=$1",[owner.a]);await assert.rejects(submit(owner),/Current resident/);
 assert.equal(Number((await one('select count(*) as n from late_fee_payment_allocations')).n),0,'Additional money never becomes a late-fee allocation');
 // The legacy no-additional combined flow and NULL historical declaration remain valid.
 const legacy=await fixture(15000);const oldFlow=(await one('select create_combined_payment_submission($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as result',[legacy.r,legacy.a,legacy.rent,legacy.dep,30000,'Bank',randomUUID(),'Payment purpose: Rent + Security Deposit',legacy.r+'/legacy.pdf','legacy.pdf'])).result;
 assert.equal((await one('select additional_charge from payment_receipts where id=$1',[oldFlow.receipt_id])).additional_charge,null);
 await one('select verify_payment_with_allocations($1,$2,$3)',[oldFlow.payment_id,oldFlow.receipt_id,'verifier@local.invalid']);
 assert.equal((await one('select additional_charge from payment_receipts where id=$1',[oldFlow.receipt_id])).additional_charge,null);
 assert.equal((await one('select payment_status from payments where id=$1',[oldFlow.payment_id])).payment_status,'Verified');
 assert.equal(Number((await one('select sum(amount) as total from payment_allocations where payment_id=$1',[oldFlow.payment_id])).total),30000);
 const workflow=loadPure('contractWorkflow');const readyAdmission={id:'admission',resident_id:'resident',room_id:'room',bed_id:'bed',status:'Pending',admission_date:'2026-10-01',monthly_rent:15000,security_deposit:0,deposit_status:'Held'};
 const readyContract={admission_id:'admission',status:'Pending Signature',resident_signature_url:'proof',resident_signature_status:'Approved',signed_by_resident:true,signed_at:'2026-10-01',contract_content:'Terms'};
 const readyBase={admission:readyAdmission,resident:{id:'resident',status:'Active'},room:{id:'room',status:'Available'},bed:{id:'bed',room_id:'room',status:'Occupied'},contract:readyContract,depositState:'not_required',admissions:[readyAdmission],payments:[]};
 const readyRent={id:'rent',resident_id:'resident',admission_id:'admission',bill_type:'Rent',billing_month:'2026-10',rent_amount:15000,total_amount:15000,bill_status:'Paid'};
 const readyExtra={id:'extra',resident_id:'resident',admission_id:'admission',bill_type:'Other Charges',other_amount:5140,total_amount:5140,bill_status:'Pending Approval'};
 assert.equal(workflow.isAdmissionActivationReady({...readyBase,bills:[readyRent,readyExtra],payments:[{id:'rent-paid',resident_id:'resident',bill_id:null,payment_status:'Verified',amount:15000,allocations:[{bill_id:'rent',amount:15000}]},{id:'additional-pending',resident_id:'resident',bill_id:null,payment_status:'Pending',amount:20140,allocations:[{bill_id:'rent',amount:15000},{bill_id:'extra',amount:5140}]}]}),true,'Additional Charges do not affect admission readiness');
 const combinedRoute=fs.readFileSync(path.join(__dirname,'..','app/api/resident-portal/combined-payment/route.ts'),'utf8');assert.match(combinedRoute,/hasAdditional \? "create_additional_payment_submission" : includeLateFee \? "create_late_fee_payment_submission" : "create_combined_payment_submission"/);assert.match(combinedRoute,/if \(includeLateFee\) return errorResponse\("Submit Late Fee separately/);
 const securedFunctions=(await db.query(`select p.proname,p.prosecdef,p.proconfig,has_function_privilege('anon',p.oid,'EXECUTE') as anon_exec,has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_exec,has_function_privilege('service_role',p.oid,'EXECUTE') as service_exec from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('create_additional_payment_submission','verify_additional_payment')`)).rows;
 assert.equal(securedFunctions.length,2);for(const fn of securedFunctions){assert.equal(fn.prosecdef,true);assert.ok(fn.proconfig.some(setting=>setting==='search_path=pg_catalog, public'));assert.equal(fn.anon_exec,false);assert.equal(fn.authenticated_exec,false);assert.equal(fn.service_exec,true);}
 await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'authenticated'})]);
 await assert.rejects(one('select create_additional_payment_submission($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[legacy.r,legacy.a,legacy.rent,legacy.dep,35140,5140,'Other','Description','Bank',randomUUID(),'Notes',legacy.r+'/blocked.pdf','blocked.pdf']),/Server authentication/);
 assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'..','supabase/migrations/20261001130000_additional_payment_charges.sql'),'utf8'),/disable\s+row\s+level\s+security|drop\s+policy/i);
 console.log('PASS Additional Charges: exact totals and allocations, legacy OFF flow and NULL receipts, pending/rejected/reversal balances, mismatch and ownership guards, reporting split, readiness isolation, validation, and late-fee separation.');
 }finally{await db.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
