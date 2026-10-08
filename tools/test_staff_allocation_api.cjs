// Real route with isolated auth/RPC/notification doubles. No environment or network.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const uuid='11111111-1111-4111-8111-111111111111';
let role='admin',active=true,replayed=false,notificationSupported=true,notificationFails=false;const calls=[],notifications=[];
let existingBill=false,currentAdmission=uuid,residentStatus='Inactive',monthlyRent=12000,rpcError=null,rpcTermsChange=null;
function pure(file,deps={}){const m={exports:{}};vm.runInNewContext('(function(require,module,exports){'+ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText+'})',{Intl,Date})(id=>deps[id],m,m.exports);return m.exports;}
const billApproval=pure('lib/billApproval.ts'),periods=pure('lib/missingRentPeriods.ts',{'./billApproval':billApproval});
function from(table){let selected='';const q={select(s){selected=s;return q},eq(){return q},order(){return q},limit(){return q},not(){return q},maybeSingle:async()=>({data:table==='admissions'?(selected==='id'?{id:currentAdmission}:{id:uuid,resident_id:uuid,admission_date:'2027-04-01',status:'Pending',monthly_rent:monthlyRent}):table==='residents'?{status:residentStatus}:{monthly_rent:0},error:null}),then(resolve){return Promise.resolve({data:existingBill?[{id:uuid}]:[],error:null}).then(resolve)}};return q;}
const reply=(body,status=200)=>({status,body});
const deps={
 'next/server':{},
 '@/lib/adminApiAuth':{apiError:(error,status)=>reply({error},status),apiJson:body=>reply(body),requireStaff:async(req,roles)=>active&&roles.includes(role)?{staff:{email:'staff@local.invalid',role},response:null}:{staff:null,response:reply({error:'denied'},403)}},
 '@/lib/supabaseAdmin':{supabaseAdmin:{from,rpc:async(name,args)=>{calls.push({name,args});if(name==='generate_missing_staff_rent'&&rpcTermsChange){const terms=rpcTermsChange;rpcTermsChange=null;if(args.p_expected_amount!==terms.amount||args.p_expected_due_date!==terms.due)return {data:null,error:{message:"Rent amount or due date changed. Reload the preview."}};}return {data:{payment_id:uuid,replayed,notification_supported:notificationSupported},error:rpcError}}}},
 '@/lib/billApproval':billApproval,
 '@/lib/missingRentPeriods':{...periods,currentRentMonth:()=> '2027-04'},
 '@/lib/notifications/server':{notifyResidentEvent:async(...args)=>{notifications.push(args);if(notificationFails)throw new Error('Delivery unavailable');return {warning:false}}},
};
const m={exports:{}};
vm.runInNewContext('(function(require,module,exports){'+ts.transpileModule(fs.readFileSync('app/api/staff-payment-allocation/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText+'})',{})(id=>{assert.ok(id in deps,`Unexpected connected dependency ${id}`);return deps[id]},m,m.exports);
const valid={action:'verify',requestId:uuid,paymentId:uuid,receiptId:uuid,fingerprint:'expected',reason:'Reviewed',confirmed:true,items:[{bill_id:uuid,bill_type:'Rent',billing_month:'2027-04',due_date:'2027-03-31',amount:12000}]};
const post=body=>m.exports.POST({json:async()=>body});
(async()=>{
 assert.equal((await post(valid)).status,200);assert.equal(calls.at(-1).args.p_items[0].billing_month,'2027-04');assert.equal(calls.at(-1).args.p_actor,'staff@local.invalid');assert.equal(notifications.length,1);
 const n=calls.length;
 for(const invalid of [{...valid,confirmed:false},{...valid,paymentId:'manipulated'},{...valid,items:[{...valid.items[0],amount:-1}]},{...valid,items:[{...valid.items[0],bill_id:'wrong'}]},{...valid,action:'correct',feeExceptionReason:'reason',feeExceptionConfirmed:false}])assert.equal((await post(invalid)).status,400);
 assert.equal(calls.length,n);
 role='accountant';assert.equal((await post({...valid,action:'correct'})).status,403);assert.equal((await post({...valid,action:'generate',admissionId:uuid,month:'2027-04'})).status,403);
 active=false;assert.equal((await post(valid)).status,403);assert.equal(calls.length,n);
 active=true;role='admin';replayed=true;assert.equal((await post(valid)).status,200);assert.equal(notifications.length,1);
 replayed=false;notificationSupported=false;assert.equal((await post(valid)).body.notificationWarning,true);assert.equal(notifications.length,1);
 assert.equal((await post({...valid,action:'correct',feeExceptionReason:'Explicit staff/system dating error',feeExceptionConfirmed:true})).status,200);
 assert.equal(calls.at(-1).args.p_fee_exception_reason,'Explicit staff/system dating error');
 const generate={action:'generate',admissionId:uuid,month:'2027-04',confirmed:true,expectedAmount:12000,expectedDueDate:'2027-04-01'};
 assert.equal((await post(generate)).status,200);assert.equal(calls.at(-1).name,'generate_missing_staff_rent');assert.equal(calls.at(-1).args.p_admission,uuid);assert.equal(calls.at(-1).args.p_month,'2027-04');assert.equal(calls.at(-1).args.p_expected_amount,12000);assert.equal(calls.at(-1).args.p_expected_due_date,'2027-04-01');
 const get=params=>m.exports.GET({nextUrl:{searchParams:new URLSearchParams(params)}});
 assert.equal((await get({history:'true'})).status,200);assert.equal(calls.at(-1).name,'staff_correction_history');
 assert.equal((await get({paymentId:'invalid',receiptId:uuid})).status,400);
 const preview={preview:'missing-rent',admissionId:uuid,month:'2027-04'};
 assert.deepEqual(JSON.parse(JSON.stringify((await get(preview)).body)),{admissionId:uuid,month:'2027-04',amount:12000,dueDate:'2027-04-01'});
 const generationCalls=calls.length;
 for(const bad of [{...generate,confirmed:false},{...generate,expectedDueDate:'2027-04-30'},{...generate,expectedAmount:14000},{...generate,month:'2027-03'},{...generate,month:'2027-05'}])assert.ok([400,409].includes((await post(bad)).status));
 existingBill=true;assert.equal((await get(preview)).status,409);assert.equal((await post(generate)).status,409);existingBill=false;
 currentAdmission='another-admission';assert.equal((await get(preview)).status,409);currentAdmission=uuid;
 residentStatus='Archived';assert.equal((await post(generate)).status,409);residentStatus='Inactive';
 monthlyRent=0;assert.equal((await get(preview)).status,409);monthlyRent=12000;
 role='accountant';assert.equal((await get(preview)).status,403);role='admin';
 assert.equal(calls.length,generationCalls,'invalid or stale generation never calls a mutation RPC');
 for(const changed of [{amount:14000,due:'2027-04-01'},{amount:12000,due:'2027-04-02'}]){rpcTermsChange=changed;assert.equal((await post(generate)).status,409,'RPC rejects terms changed after API preview validation');assert.equal(calls.at(-1).args.p_expected_amount,12000);assert.equal(calls.at(-1).args.p_expected_due_date,'2027-04-01');}
 rpcError={message:'Rent bill already exists'};assert.equal((await post(generate)).status,409);rpcError=null;
 console.log('PASS missing rent API: canonical preview, exact admission/month, explicit confirmation, stale amount/date rejection, current admission, period/duplicate guards and Admin authorization.');
 notificationSupported=true;notificationFails=true;
 const financialCalls=calls.length;const deliveryFailure=await post(valid);
 assert.equal(deliveryFailure.status,200);assert.equal(deliveryFailure.body.notificationWarning,true);
 assert.equal(calls.length,financialCalls+1);assert.equal(calls.at(-1).name,'apply_staff_payment_allocation');
 console.log('PASS allocation API: exact selected periods forwarded, confirmation and input rejection, active role gates, Admin-only correction/generation, actor derived from auth and replay-safe notification.');
})().catch(e=>{console.error(e);process.exitCode=1});
