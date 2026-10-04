// Real route handlers, mocked auth/storage only. No environment files/network.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const rows={residents:[{id:'resident-a',email:'a@local.invalid',status:'Active'},{id:'resident-b',email:'b@local.invalid',status:'Active'}],staff_users:[{email:'staff@local.invalid',role:'Admin',status:'Active',permissions:[]}],historical_payment_evidence:[{id:'evidence-b',resident_id:'resident-b',receipt_path:'resident-b/proof.pdf'}]};
let signatures=0,uploads=0,calls=[];
const users={a:{email:'a@local.invalid',user_metadata:{resident_id:'resident-a'}},b:{email:'b@local.invalid',user_metadata:{resident_id:'resident-b'}},staff:{email:'staff@local.invalid',user_metadata:{}},mismatch:{email:'a@local.invalid',user_metadata:{resident_id:'resident-b'}}};
const admin={auth:{getUser:async token=>({data:{user:users[token] || null},error:null})},from(table){assert.ok(rows[table],table);let filters=[],insert;
 const run=()=>{if(insert){rows[table].push(insert);return {data:null,error:null};}return {data:rows[table].filter(r=>filters.every(([k,v])=>r[k]===v)),error:null};};
 return {select(){return this;},order(){return this;},eq(k,v){filters.push([k,v]);return this;},insert(row){insert=row;return this;},async maybeSingle(){let r=run();return {...r,data:r.data?.[0] || null};},then(ok,bad){return Promise.resolve(run()).then(ok,bad);}};
},storage:{from(bucket){assert.equal(bucket,'payment-receipts');return {async upload(path){uploads++;return {error:null};},async remove(){return {error:null};},async createSignedUrl(path,seconds){signatures++;assert.equal(seconds,60);return {data:{signedUrl:'https://private.invalid/'+path},error:null};}};}},rpc:async(name,args)=>{calls.push({name,args});return {data:{receipt_id:'receipt'},error:null};}};
const dependencies={'next/server':{NextResponse:{json:(data,options)=>({data,status:200,...options})}},'@/lib/supabaseAdmin':{supabaseAdmin:admin},'@supabase/supabase-js':{createClient:()=>admin},'@/lib/identity':{normalizeIdentityEmail:s=>s.trim().toLowerCase()},'@/lib/additionalCharges':{additionalChargeError:()=>null}};
function load(path){const module={exports:{}};const code=ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;vm.runInNewContext(`(function(require,module,exports){${code}\n})`,{File,Uint8Array,crypto:require('node:crypto').webcrypto,process:{env:{NEXT_PUBLIC_SUPABASE_URL:'https://local.invalid',NEXT_PUBLIC_SUPABASE_ANON_KEY:'test-public-placeholder'}}})(id=>{assert.ok(dependencies[id],id);return dependencies[id];},module,module.exports);return module.exports;}
const evidence=load('app/api/payment-evidence/route.ts'),submission=load('app/api/resident-portal/combined-payment/route.ts');
const request=(token,query='',body={})=>({headers:{get:()=>token?'Bearer '+token:null},nextUrl:{searchParams:new URLSearchParams(query)},json:async()=>body});
(async()=>{
 assert.equal((await evidence.GET(request(null))).status,403);
 assert.equal((await evidence.GET(request('mismatch'))).status,403);
 assert.equal((await evidence.GET(request('a','id=evidence-b'))).status,404);assert.equal(signatures,0);
 assert.equal((await evidence.GET(request('b','id=evidence-b'))).status,200);assert.equal(signatures,1);
 assert.equal((await evidence.PATCH(request('a','',{id:'evidence-b',status:'Verified',note:'Forged'}))).status,403);assert.equal(calls.length,0);
 assert.equal((await evidence.PATCH(request('staff','',{id:'evidence-b',status:'Verified',note:'Inspected'}))).status,200);
 assert.equal(calls[0].name,'review_historical_evidence');assert.equal(calls[0].args.p_actor,'staff@local.invalid');calls=[];
 const form=new FormData();for(const [k,v] of Object.entries({historical:'true',historicalPurpose:'Previous Rent + Security Deposit',historicalDate:'2025-01-01',amount:'34000',paymentMethod:'Bank',notes:'Old proof',residentId:'resident-b'}))form.set(k,v);
 form.set('file',new File([new Uint8Array([37,80,68,70,45])],'proof.pdf',{type:'application/pdf'}));
 const req={...request('a'),formData:async()=>form};
 assert.equal((await submission.POST(req)).status,200);assert.equal(rows.historical_payment_evidence.at(-1).resident_id,'resident-a');assert.equal(calls.length,0,'Historical upload invokes no ledger RPC');
 assert.equal(uploads,1);
 form.set('file',new File([new Uint8Array([0,1,2])],'bad.pdf',{type:'application/pdf'}));
 assert.equal((await submission.POST(req)).status,400);assert.equal(uploads,1,'Invalid content never uploads');
 form.set('file',new File([new Uint8Array([37,80,68,70,45])],'proof.pdf',{type:'application/pdf'}));
 form.delete('historical');form.set('admissionId','admission');form.set('obligationItems',JSON.stringify([{bill_id:'deposit',amount:10000}]));form.set('amount','10000');form.set('commitmentDate','2026-11-15');form.set('acknowledged','true');form.set('commitmentReason','Personal issue');
 assert.equal((await submission.POST(req)).status,200);assert.equal(calls[0].name,'submit_partial_obligations');assert.equal(calls[0].args.p_resident_id,'resident-a');assert.equal(calls[0].args.p_ack,true);
 console.log('PASS real APIs: exact token ownership, cross-resident signed URL denial, staff-only evidence review, historical non-ledger upload, MIME validation, partial commitment RPC routing.');
})().catch(e=>{console.error(e);process.exitCode=1;});
