// Real route + finance modules, mocked authorization/database; no env, SDK or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function fixture() {
  return {
    admissions:[{id:'a',resident_id:'r',status:'Pending',room_id:'room',bed_id:'bed',admission_date:'2026-10-01',security_deposit:0,deposit_status:'Pending'}],
    residents:[{id:'r',status:'Pending'}],rooms:[{id:'room',status:'Available'}],beds:[{id:'bed',room_id:'room',status:'Occupied'}],
    contracts:[{id:'c',resident_id:'r',admission_id:'a',status:'Pending Signature',resident_signature_url:'proof',resident_signature_status:'Approved',signed_by_resident:true,signed_at:'2026-10-01',contract_content:'Terms'}],
    bills:[{id:'rent',resident_id:'r',admission_id:'a',billing_month:'2026-10',bill_type:'Rent',bill_status:'Pending',rent_amount:17000,total_amount:17000}],
    payments:[],
  };
}
function harness(rows,{authorized=true,failTable=null,failUpdate=null}={}) {
  const writes=[];let reads=0;
  const db={from(table) {
    assert.ok(Object.hasOwn(rows,table));
    let filters=[],single=false,update=null,from=0,to=Infinity;
    const q={
      select(){return q;},order(){return q;},
      eq(k,v){filters.push(row=>row[k]===v);return q;},
      is(k,v){return q.eq(k,v);},
      limit(n){to=n-1;return q;},range(a,b){from=a;to=b;return q;},
      maybeSingle(){single=true;return q;},
      update(value){update=value;return q;},
      then(resolve,reject){try {
        reads++;
        if(table===failTable)return resolve({data:null,error:{message:'Read failed'}});
        if(update && table===failUpdate)return resolve({data:null,error:{message:'Write failed'}});
        const selected=rows[table].filter(row=>filters.every(f=>f(row))).slice(from,to+1);
        if(update){writes.push(table);for(const row of selected)Object.assign(row,update);}
        return resolve({data:single?selected[0]??null:selected,error:null});
      }catch(error){return reject(error);}},
    };return q;
  }};
  const cache=new Map();
  const allowed=new Set(['contractWorkflow','residentFinancialSummary','financialMath','billApproval','paymentAllocations','dashboardRead','supabaseErrors']);
  function load(name) {
    if(name==='next/server')return {};
    if(name==='@/lib/adminApiAuth')return {
      requireStaff:async(_request,roles)=>{assert.deepEqual(Array.from(roles),['super admin','admin','manager','staff']);return {response:authorized?null:{status:403}};},
      apiError:(error,status)=>({status,body:{error}}),apiJson:body=>({status:200,body}),
    };
    if(name==='@/lib/supabaseAdmin')return {supabaseAdmin:db};
    name=name.split('/').pop();assert.ok(allowed.has(name),`Unexpected import ${name}`);
    if(cache.has(name))return cache.get(name);
    const mod={exports:{}};cache.set(name,mod.exports);
    evaluate(`lib/${name}.ts`,mod);return mod.exports;
  }
  function evaluate(path,mod){vm.runInNewContext(ts.transpileModule(fs.readFileSync(path,'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020},
  }).outputText,{module:mod,exports:mod.exports,require:load,Date,Intl,Error});}
  const route={exports:{}};evaluate('app/api/admissions/activate/route.ts',route);
  return {writes,get reads(){return reads;},run:()=>route.exports.POST({json:async()=>({admissionId:'a'})})};
}
const rentPayment=(status='Verified',amount=17000)=>({id:'p',resident_id:'r',bill_id:'rent',payment_status:status,amount});
(async()=>{
  for(const change of [
    ()=>{},
    rows=>rows.payments=[rentPayment('Verified',1000)],
    ...['Pending','Rejected','Cancelled','Reversed'].map(status=>rows=>rows.payments=[rentPayment(status)]),
    rows=>{rows.bills[0].bill_status='Paid';rows.bills[0].balance_amount=0;},
    rows=>rows.payments=[{...rentPayment(),bill_id:'old-admission-rent'}],
  ]) {
    const rows=fixture();change(rows);const before=JSON.stringify(rows);const h=harness(rows);
    const result=await h.run();assert.equal(result.status,409);assert.match(result.body.error,/Rent/);
    assert.equal(h.writes.length,0);assert.equal(JSON.stringify(rows),before);
  }
  for(const change of [
    rows=>rows.contracts[0].status='Cancelled',
    rows=>rows.contracts[0].status='Terminated',
    rows=>rows.contracts[0].resident_signature_status='Submitted',
    rows=>rows.admissions[0].security_deposit=17000,
    rows=>rows.beds[0].room_id='other',
    rows=>rows.admissions.push({...rows.admissions[0],id:'conflict',resident_id:'other'}),
  ]) {
    const rows=fixture();rows.payments=[rentPayment()];change(rows);const h=harness(rows);
    assert.equal((await h.run()).status,409);assert.equal(h.writes.length,0);
  }
  for(const status of ['Verified','Pending','Rejected','Cancelled','Reversed']) {
    const rows=fixture();rows.admissions[0].security_deposit=10000;
    rows.bills.push({id:'deposit',resident_id:'r',admission_id:'a',bill_type:'Security Deposit',bill_status:'Pending',total_amount:10000});
    rows.payments=[{id:'combined',resident_id:'r',amount:27000,payment_status:status,
      payment_allocations:[{bill_id:'rent',amount:17000},{bill_id:'deposit',amount:10000}]}];
    const financial=JSON.stringify([rows.bills,rows.payments]);const h=harness(rows);
    assert.equal((await h.run()).status,status==='Verified'?200:409);
    assert.equal(JSON.stringify([rows.bills,rows.payments]),financial);
    if(status!=='Verified')assert.equal(h.writes.length,0);
  }
  const rows=fixture();rows.payments=[rentPayment()];
  rows.bills.push({...rows.bills[0],id:'future',billing_month:'2026-11'});
  const h=harness(rows);assert.equal((await h.run()).status,200);
  assert.equal(rows.admissions[0].status,'Active');assert.equal(rows.contracts[0].status,'Active');
  assert.deepEqual(h.writes,['contracts','admissions','residents']);
  assert.equal(rows.payments.length,1,'No fabricated deposit payment');
  const denied=harness(fixture(),{authorized:false});assert.equal((await denied.run()).status,403);assert.equal(denied.reads,0);
  const failed=harness(fixture(),{failTable:'payments'});assert.equal((await failed.run()).status,503);assert.equal(failed.writes.length,0);
  for(const table of ['contracts','admissions','residents']) {
    const rows=fixture();rows.payments=[rentPayment()];const h=harness(rows,{failUpdate:table});
    assert.equal((await h.run()).status,409);
    assert.equal(rows.admissions[0].status,'Pending');assert.equal(rows.contracts[0].status,'Pending Signature');
  }
  console.log('PASS server activation: staff authorization, unpaid/partial/nonverified/old Rent blocked without writes, independent deposit, contract/allocation guards, verified combined allocations, future rent excluded, no financial mutations.');
})().catch(error=>{console.error(error);process.exitCode=1;});
