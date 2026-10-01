// Pure modules and mocked read pagination only; no SDK, env files or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const allowed = new Set(['dashboardData','dashboardRent','dashboardRead','residentFinancialSummary',
  'financialMath','paymentAllocations','billApproval','contractWorkflow','canonical']);
const cache = new Map();
function load(name) {
  name = name.split('/').pop();
  assert.ok(allowed.has(name), `Unexpected import: ${name}`);
  if (cache.has(name)) return cache.get(name);
  const mod = {exports:{}}; cache.set(name,mod.exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(`lib/${name}.ts`,'utf8'), {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020},
  }).outputText,{module:mod,exports:mod.exports,require:load,Date,Intl});
  return mod.exports;
}
const {buildDashboardRent,karachiCalendarDate} = load('dashboardRent');
const {buildDashboardSummary} = load('dashboardData');
const now = new Date('2026-09-30T19:00:00Z'); // October 1 in Karachi.
function fixture() {
  return {
    residents:[{id:'r',full_name:'Test resident',status:'Active'}],
    admissions:[{id:'a',resident_id:'r',status:'Pending',admission_date:'2026-09-01',created_at:'2026-09-01',room_id:'room',bed_id:'bed',security_deposit:0,deposit_status:'Held'}],
    bills:[{id:'rent',resident_id:'r',admission_id:'a',bill_type:'Rent',bill_status:'Pending',billing_month:'2026-10',due_date:'2026-10-01',rent_amount:17000,total_amount:17000}],
    rooms:[{id:'room',room_number:'101',status:'Occupied'}],
    beds:[{id:'bed',room_id:'room',bed_number:'1',status:'Occupied'}],
    payments:[],receipts:[],contracts:[],maintenance:[],inspections:[],notices:[],
  };
}
const list = data => buildDashboardRent(data,now).dueToday;
const payment = (status,amount=17000) => ({id:'p',resident_id:'r',bill_id:'rent',payment_status:status,amount});
assert.equal(karachiCalendarDate(now),'2026-10-01');
assert.equal(karachiCalendarDate(new Date('2026-09-30T18:59:59Z')),'2026-09-30');
let data=fixture();
const before=JSON.stringify(data);
assert.equal(list(data).length,1);
assert.equal(list(data)[0].outstandingAmount,17000);
assert.equal(list(data)[0].room,'101'); assert.equal(list(data)[0].bed,'1');
assert.equal(list(data)[0].paymentState,'Due');
assert.equal(JSON.stringify(data),before,'Read-only calculation leaves inputs unchanged');
for(const due of ['2026-09-30','2026-10-02']) {
  data=fixture();data.bills[0].due_date=due; assert.equal(list(data).length,0);
}
for(const status of ['Verified','Pending','Rejected','Cancelled']) {
  data=fixture();data.payments=[payment(status)];
  if(status==='Verified')assert.equal(list(data).length,0);
  else { assert.equal(list(data).length,1); assert.equal(list(data)[0].paymentState,status==='Pending'?'Payment Pending Verification':'Due'); }
}
data=fixture();data.bills[0].bill_status='Paid';assert.equal(list(data).length,0);
for(const status of ['Pending Verification','Verified','Rejected','Cancelled']) {
  data=fixture(); data.receipts=[{id:'receipt',resident_id:'r',bill_id:'rent',status}];
  assert.equal(list(data)[0].paymentState,status==='Pending Verification'?'Payment Pending Verification':'Due');
  assert.equal(list(data)[0].outstandingAmount,17000,'Receipt alone never gives verified credit');
}
for(const bill_type of ['Security Deposit','Other Charges','Electricity','AC','Late Fee']) {
  data=fixture();data.bills[0].bill_type=bill_type;assert.equal(list(data).length,0);
  assert.equal(buildDashboardSummary(data,now).diagnostics.pendingRentBills,0);
}
for(const status of ['Completed','Cancelled','Archived']) {
  data=fixture();data.admissions[0].status=status;assert.equal(list(data).length,0);
  assert.ok(!buildDashboardSummary(data,now).tasks.some(t=>t.id==='approaching-bills'));
}
for(const status of ['Cancelled','Draft','Pending Approval','Archived','Unknown']) {
  data=fixture();data.bills[0].bill_status=status;assert.equal(list(data).length,0);
}
data=fixture();data.admissions.push({...data.admissions[0],id:'new',admission_date:'2026-10-01'});
assert.equal(list(data).length,0,'Old admission cannot supply current rent');
data=fixture();data.admissions[0].admission_date='2026-10-02';assert.equal(list(data).length,0);
data=fixture();data.bills[0].resident_id='other';assert.equal(list(data).length,0);
data=fixture();data.residents[0].status='Archived';assert.equal(list(data).length,0);
// Combined allocations override the legacy direct reference and do not duplicate credit.
for(const relation of ['allocations','payment_allocations']) {
  data=fixture(); data.payments=[{...payment('Verified',22000),[relation]:[
    {bill_id:'rent',amount:10000},{bill_id:'deposit',amount:12000},
  ]}];
  data.payments.push(data.payments[0]);data.bills.push(data.bills[0]);
  assert.equal(list(data).length,1);assert.equal(list(data)[0].outstandingAmount,7000);
  data.payments=[{...payment('Pending',22000),bill_id:null,[relation]:[{bill_id:'rent',amount:17000},{bill_id:'deposit',amount:5000}]}];
  data.receipts=[{id:'receipt',resident_id:'r',bill_id:null,payment_id:'p',status:'Pending Verification'}];
  assert.equal(list(data).length,1);assert.equal(list(data)[0].paymentState,'Payment Pending Verification');
  assert.equal(list(data)[0].href,'/payment-verification');
  data.payments[0].payment_status='Rejected';assert.equal(list(data)[0].paymentState,'Due');
}
data=fixture();data.payments=[{...payment('Pending'),bill_id:'deposit'}];
data.receipts=[{id:'receipt',resident_id:'r',bill_id:'deposit',payment_id:'p',status:'Pending Verification'}];
assert.equal(list(data)[0].paymentState,'Due','Deposit evidence does not label Rent pending');
data=fixture();data.bills[0].electricity_amount=3000;data.bills[0].discount_amount=2000;data.bills[0].total_amount=18000;
data.payments=[payment('Verified',10000)];assert.equal(list(data)[0].outstandingAmount,5300,'Canonical proportional discount and rent-first credit');
data.payments=[payment('Verified',15300)];assert.equal(list(data).length,0,'Utility-only remainder is not Rent due');
assert.equal(buildDashboardSummary(data,now).diagnostics.pendingRentBills,0);
data=fixture();data.contracts=[{id:'c',admission_id:'a',status:'Pending Signature',resident_signature_url:'local',resident_signature_status:'Approved',signed_by_resident:true,signed_at:'2026-09-01',contract_content:'Terms'}];
assert.equal(buildDashboardSummary(data,now).diagnostics.readyForActivation,0,'Zero deposit cannot waive unpaid Rent');
assert.equal(buildDashboardSummary(data,now).diagnostics.pendingDeposits,0);
assert.equal(buildDashboardSummary(data,now).rentDueToday.length,1);
assert.equal(buildDashboardSummary(data,now).diagnostics.pendingRentBills,1);
assert.ok(buildDashboardSummary(data,now).tasks.some(t=>t.id==='approaching-bills'));

// Admissions and Dashboard must agree on the entire activation prerequisite.
const workflow=load('contractWorkflow');
const approvedContract={...data.contracts[0]};
function readinessFixture() {
  const value=fixture(); value.contracts=[{...approvedContract}]; value.bills[0].billing_month='2026-09'; value.payments=[payment('Verified')]; return value;
}
function assertReadiness(value,state,ready) {
  const snapshot=JSON.stringify(value);
  const deposit=workflow.getAdmissionDeposit(value.admissions[0],value.bills,value.payments);
  assert.equal(deposit.state,state);
  assert.equal(workflow.isDepositVerified(deposit.state),state==='verified');
  assert.equal(workflow.isAdmissionActivationReady({admission:value.admissions[0],resident:value.residents[0],
    room:value.rooms[0],bed:value.beds[0],contract:value.contracts[0],depositState:deposit.state,
    admissions:value.admissions,bills:value.bills,payments:value.payments}),ready);
  assert.equal(buildDashboardSummary(value,now).diagnostics.readyForActivation,Number(ready));
  assert.equal(JSON.stringify(value),snapshot,'Readiness never creates financial or audit records');
}
data=readinessFixture();assertReadiness(data,'not_required',true);
assert.equal(workflow.depositStateLabel('not_required'),'No Deposit Required');
assert.equal(data.payments.length,1);assert.equal(data.receipts.length,0); // Rent only; no deposit evidence.
function positiveFixture() {
  const value=readinessFixture();value.admissions[0].security_deposit=10000;
  value.bills.push({id:'deposit',resident_id:'r',admission_id:'a',bill_type:'Security Deposit',bill_status:'Pending',total_amount:10000});
  return value;
}
data=positiveFixture();assertReadiness(data,'pending',false);
for(const status of ['Pending','Rejected','Cancelled','Verified']) {
  data=positiveFixture();data.payments=[payment('Verified'),{id:'dp',resident_id:'r',bill_id:'deposit',payment_status:status,amount:10000}];
  assertReadiness(data,status==='Verified'?'verified':'pending',status==='Verified');
}
data=positiveFixture();data.payments=[payment('Verified'),{id:'dp',resident_id:'r',payment_status:'Verified',amount:5000,
  allocations:[{bill_id:'deposit',amount:5000}]}];assertReadiness(data,'pending',false);
data.payments[1].amount=10000;data.payments[1].allocations[0].amount=10000;assertReadiness(data,'verified',true);
data=positiveFixture();data.bills.push({...data.bills[1],id:'old-deposit',admission_id:'old'});
data.payments=[payment('Verified'),{id:'old-payment',resident_id:'r',bill_id:'old-deposit',payment_status:'Verified',amount:10000}];
assertReadiness(data,'pending',false);
for(const status of ['Cancelled','Terminated','Draft','Active']) {
  data=readinessFixture();data.contracts[0].status=status;assertReadiness(data,'not_required',false);
}
for(const status of ['Submitted','Rejected','Pending',null]) {
  data=readinessFixture();data.contracts[0].resident_signature_status=status;assertReadiness(data,'not_required',false);
}
for(const change of [
  value=>value.contracts=[],
  value=>value.contracts[0].admission_id='old',
  value=>value.contracts[0].signed_at=null,
  value=>value.contracts[0].resident_signature_url=null,
  value=>value.contracts[0].signed_by_resident=false,
  value=>value.contracts[0].contract_content=' ',
  value=>value.admissions[0].status='Active',
  value=>value.residents=[],
  value=>value.residents[0].status='Archived',
  value=>value.rooms[0].status='Maintenance',
  value=>value.beds[0].room_id='other',
  value=>value.beds[0].status='Available',
  value=>value.admissions.push({...value.admissions[0],id:'conflict',status:'Active'}),
]) {data=readinessFixture();change(data);assertReadiness(data,'not_required',false);}
// Rent is independent of Deposit and only the initial admission month is required.
for(const status of ['Pending','Rejected','Cancelled','Reversed']) {
  data=readinessFixture();data.payments=[payment(status)];
  data.receipts=[{id:'proof',resident_id:'r',bill_id:'rent',status:'Pending Verification'}];
  assertReadiness(data,'not_required',false);
}
data=readinessFixture();data.payments=[];assertReadiness(data,'not_required',false);
data=readinessFixture();data.payments=[payment('Verified',1000)];assertReadiness(data,'not_required',false);
data.payments.push(data.payments[0]);assertReadiness(data,'not_required',false);
data=positiveFixture();data.payments=[{id:'dp',resident_id:'r',bill_id:'deposit',payment_status:'Verified',amount:10000}];assertReadiness(data,'verified',false);
for(const status of ['Verified','Pending','Rejected','Cancelled','Reversed']) {
  data=positiveFixture();data.payments=[{id:'combined',resident_id:'r',payment_status:status,amount:27000,
    payment_allocations:[{bill_id:'rent',amount:17000},{bill_id:'deposit',amount:10000}]}];
  assertReadiness(data,status==='Verified'?'verified':'pending',status==='Verified');
}
data=readinessFixture();data.bills.push({...data.bills[0],id:'old-rent',admission_id:'old'});
data.payments=[{...payment('Verified'),bill_id:'old-rent'}];assertReadiness(data,'not_required',false);
data=readinessFixture();data.bills.push({...data.bills[0],id:'future',billing_month:'2026-11'});assertReadiness(data,'not_required',true);
for(const change of [
  value=>value.bills=[],
  value=>value.bills[0].billing_month='2026-11',
  value=>value.bills[0].bill_status='Cancelled',
  value=>value.bills[0].bill_status='Pending Approval',
  value=>value.bills.push({...value.bills[0],id:'ambiguous'}),
  value=>value.payments[0].resident_id='different',
  value=>value.admissions.push({...value.admissions[0],id:'newer',admission_date:'2026-10-01',bed_id:'other',status:'Completed'}),
]) {data=readinessFixture();change(data);assertReadiness(data,'not_required',false);}
data=readinessFixture();data.payments=[];data.bills[0].bill_status='Paid';data.bills[0].balance_amount=0;assertReadiness(data,'not_required',false);
console.log('PASS activation readiness: zero/positive deposits, canonical allocations, old admissions, invalid contracts, occupancy guards, Dashboard/Admissions parity and no mutations.');

(async()=>{
  const {readDashboardRows}=load('dashboardRead');
  const rows=Array.from({length:1201},(_,id)=>({id}));
  const offsets=[];
  const result=await readDashboardRows({range:async(from,to)=>{offsets.push(from);return {data:rows.slice(from,to+1),error:null};}});
  assert.equal(result.data.length,1201);assert.deepEqual(offsets,[0,500,1000]);
  const failed=await readDashboardRows({range:async(from)=>from===0?{data:rows.slice(0,500),error:null}:{data:null,error:{message:'Local simulated failure'}}});
  assert.equal(failed.data,null,'Never display a partially loaded financial count');
  console.log('PASS dashboard Rent Due Today: exact Karachi date, current admission, canonical balances/discounts, all exclusions, receipt/payment states, allocation deduplication, existing tasks/deposit readiness, pagination and read-only behavior.');
})().catch(error=>{console.error(error);process.exitCode=1;});
