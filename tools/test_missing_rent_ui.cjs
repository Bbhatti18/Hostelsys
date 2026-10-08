// Isolated real component/helper tests. No credentials, network or production writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
function compile(file,deps={}){const m={exports:{}};vm.runInNewContext('(function(require,module,exports){'+ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText+'})',{Intl,Date,window:{confirm:()=>allowConfirmation},fetch:deps.fetch})(id=>deps[id]||require(id),m,m.exports);return m.exports;}
const approval=compile('lib/billApproval.ts'),periods=compile('lib/missingRentPeriods.ts',{'./billApproval':approval});
const admission={id:'admission',resident_id:'resident',admission_date:'2027-04-01',status:'Pending',created_at:'2027-04-01T00:00:00Z'};
assert.deepEqual(Array.from(periods.missingRentMonths(admission,[{admission_id:'admission',bill_type:'Rent',billing_month:'2027-03'}],'2027-04')),['2027-04']);
assert.deepEqual(Array.from(periods.missingRentMonths(admission,[],'2027-05')),['2027-04','2027-05']);
for(const status of ["Pending Approval","Pending","Unpaid","Partially Paid","Overdue","Paid","Cancelled"])assert.equal(periods.missingRentMonths(admission,[{admission_id:'admission',bill_type:'Rent',billing_month:'2027-04',bill_status:status}],'2027-04').length,0);
assert.equal(periods.missingRentMonths({...admission,admission_date:'2027-06-01'},[],'2027-05').length,0);
assert.equal(periods.missingRentMonths({...admission,status:'Completed'},[],'2027-05').length,0);
assert.equal(periods.isCurrentRentAdmission(admission,[admission,{...admission,id:'new',admission_date:'2027-05-01'}]),false);
assert.equal(periods.currentRentMonth(new Date('2027-03-31T20:00:00Z')),'2027-04');
assert.equal(approval.rentDueDate('2027-04-01','2027-04'),'2027-04-01');
function harness(){let i=0;const state=[];return {reset(){i=0},react:{...React,useState(v){const n=i++;if(!(n in state))state[n]=v;return [state[n],x=>state[n]=typeof x==='function'?x(state[n]):x]}}};}
function nodes(t){return !t||typeof t!=='object'?[]:[t,...React.Children.toArray(t.props.children).flatMap(nodes)];}
let role='Super Admin',allowConfirmation=true,failPreview=false;const requests=[];let refreshed=0;
const hooks=harness();
const deps={'react':hooks.react,'next/link':{__esModule:true,default:'a'},'@/lib/usePermissions':{usePermissions:()=>({role,profile:{status:'Active'}})},'@/lib/paymentReceiptPurpose':{rentPeriodLabel:m=>'Rent — '+m},'@/lib/supabase':{supabase:{auth:{getSession:async()=>({data:{session:{access_token:'local-test',expires_at:Date.now()/1000+600}}})}}},fetch:async(url,opts)=>{requests.push({url,opts});return {ok:!failPreview,json:async()=>failPreview?{error:'Rent bill already exists'}:opts.method==='GET'?{admissionId:'admission',month:new URL(url,'https://local.invalid').searchParams.get('month'),amount:14000,dueDate:'2027-04-01'}:{billId:'generated-bill',message:'Generated for approval'}}}};
const Generate=compile('components/payments/GenerateMissingRentBill.tsx',deps).default;
const props={admissionId:'admission',months:['2027-04','2027-05'],onSaved:()=>refreshed++};
const render=()=>{hooks.reset();return Generate(props)};
const button=(tree,label)=>nodes(tree).find(n=>n.type==='button'&&n.props.children===label);
(async()=>{
 assert.match(renderToStaticMarkup(render()),/Generate Missing Rent Bill/);
 button(render(),'Generate Missing Rent Bill').props.onClick();await new Promise(setImmediate);
 let tree=render();assert.match(requests[0].url,/admissionId=admission&month=2027-04/);
 assert.match(renderToStaticMarkup(tree),/Rs14,000.*Due 2027-04-01/);
 assert.equal(nodes(tree).find(n=>n.type==='select').props.value,'2027-04');
 assert.equal(button(tree,'Confirm generation').props.disabled,true);
 nodes(tree).find(n=>n.type==='input').props.onChange({target:{checked:true}});
 allowConfirmation=false;await button(render(),'Confirm generation').props.onClick();assert.equal(requests.length,1);
 allowConfirmation=true;await button(render(),'Confirm generation').props.onClick();
 const sent=JSON.parse(requests[1].opts.body);assert.deepEqual(sent,{action:'generate',admissionId:'admission',month:'2027-04',expectedAmount:14000,expectedDueDate:'2027-04-01',confirmed:true});
 assert.equal(refreshed,1);assert.match(renderToStaticMarkup(render()),/billing\?billId=generated-bill/);
 role='Accountant';assert.equal(render(),null);role='Super Admin';
 const secondHooks=harness(),Second=compile('components/payments/GenerateMissingRentBill.tsx',{...deps,react:secondHooks.react}).default;
 const second=()=>{secondHooks.reset();return Second(props)};
 button(second(),'Generate Missing Rent Bill').props.onClick();await new Promise(setImmediate);
 nodes(second()).find(n=>n.type==='input').props.onChange({target:{checked:true}});
 failPreview=true;nodes(second()).find(n=>n.type==='select').props.onChange({target:{value:'2027-05'}});await new Promise(setImmediate);
 assert.match(renderToStaticMarkup(second()),/Rent bill already exists/);assert.equal(button(second(),'Confirm generation'),undefined);
 assert.equal(requests.filter(r=>r.opts.method==='POST').length,1);
 for(const status of ["Pending Approval","Pending","Unpaid","Partially Paid","Overdue","Paid","Cancelled"]){const h=harness(),C=compile('components/payments/GenerateMissingRentBill.tsx',{...deps,react:h.react}).default;h.reset();const tree=C({...props,months:['2027-04'],existingBills:[{id:'existing-bill',bill_number:'RENT-123',admission_id:'admission',bill_type:'Rent',billing_month:'2027-04',bill_status:status}]});const html=renderToStaticMarkup(tree);assert.match(html,/Rent bill already exists for this month\./);assert.ok(html.includes('Status: '+status));assert.match(html,/RENT-123/);assert.match(html,/billing\?billId=existing-bill/);assert.equal(button(tree,'Generate Missing Rent Bill'),undefined);if(status==='Cancelled')assert.match(html,/separate explicitly authorized, audited workflow/);}
 const differentHooks=harness(),Different=compile('components/payments/GenerateMissingRentBill.tsx',{...deps,react:differentHooks.react}).default;differentHooks.reset();assert.ok(button(Different({...props,months:['2027-04'],existingBills:[{id:'other',admission_id:'other-admission',bill_type:'Rent',billing_month:'2027-04'}]}),'Generate Missing Rent Bill'));
 const noneHooks=harness(),None=compile('components/payments/GenerateMissingRentBill.tsx',{...deps,react:noneHooks.react}).default;noneHooks.reset();assert.equal(None({...props,months:[]}),null);
 assert.match(fs.readFileSync('app/admissions/page.tsx','utf8'),/GenerateMissingRentBill admissionId=\{admission.id\} months=\{missingRentMonths/);
 assert.match(fs.readFileSync('app/billing/page.tsx','utf8'),/Missing Rent Bills/);
 console.log('PASS missing rent UI: visible Super Admin action, exact missing periods, canonical preview, explicit confirmation, stale/duplicate errors, refresh and exact Billing link; role/current-admission/timezone guards.');
})().catch(e=>{console.error(e);process.exitCode=1});
