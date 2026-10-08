// Real route with isolated auth/RPC/notification doubles. No environment or network.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const uuid='11111111-1111-4111-8111-111111111111';
let role='admin',active=true,replayed=false,notificationSupported=true,notificationFails=false;const calls=[],notifications=[];
const reply=(body,status=200)=>({status,body});
const deps={
 'next/server':{},
 '@/lib/adminApiAuth':{apiError:(error,status)=>reply({error},status),apiJson:body=>reply(body),requireStaff:async(req,roles)=>active&&roles.includes(role)?{staff:{email:'staff@local.invalid',role},response:null}:{staff:null,response:reply({error:'denied'},403)}},
 '@/lib/supabaseAdmin':{supabaseAdmin:{rpc:async(name,args)=>{calls.push({name,args});return {data:{payment_id:uuid,replayed,notification_supported:notificationSupported},error:null}}}},
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
 assert.equal((await post({action:'generate',admissionId:uuid,month:'2027-04'})).status,200);assert.equal(calls.at(-1).name,'generate_missing_staff_rent');
 const get=params=>m.exports.GET({nextUrl:{searchParams:new URLSearchParams(params)}});
 assert.equal((await get({history:'true'})).status,200);assert.equal(calls.at(-1).name,'staff_correction_history');
 assert.equal((await get({paymentId:'invalid',receiptId:uuid})).status,400);
 notificationSupported=true;notificationFails=true;
 const financialCalls=calls.length;const deliveryFailure=await post(valid);
 assert.equal(deliveryFailure.status,200);assert.equal(deliveryFailure.body.notificationWarning,true);
 assert.equal(calls.length,financialCalls+1);assert.equal(calls.at(-1).name,'apply_staff_payment_allocation');
 console.log('PASS allocation API: exact selected periods forwarded, confirmation and input rejection, active role gates, Admin-only correction/generation, actor derived from auth and replay-safe notification.');
})().catch(e=>{console.error(e);process.exitCode=1});
