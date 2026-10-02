// Real PostgreSQL in memory only. No environment, production data, or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {randomUUID} = require('node:crypto');
const {PGlite} = require('../.local-checks/late-fee-db/node_modules/@electric-sql/pglite');
(async()=>{ const db=new PGlite(); try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,email text);
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      create function auth.role() returns text language sql stable as $$ select coalesce(auth.jwt()->>'role','service_role') $$;
      grant usage on schema auth to anon,authenticated,service_role;
      grant execute on all functions in schema auth to anon,authenticated,service_role;`);
    for(const file of fs.readdirSync('supabase/migrations').sort()) {
      if(file.includes('storage_hardening'))continue; // Supabase storage service is not loaded locally.
      if(file==='20261002140000_resident_profile_completion.sql') {
        await db.exec("insert into residents(full_name,status,emergency_contact,emergency_contact_name,emergency_contact_relationship) values('Before migration','Inactive','03001234567','Parent','Father');");
      }
      await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8').replace(/^\uFEFF/,''));
    }
const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
const legacy=await one("select * from residents where full_name='Before migration'");
assert.equal(legacy.emergency_contact,'03001234567');assert.equal(legacy.emergency_contact_name,'Parent');assert.equal(legacy.emergency_contact_relationship,'Father');assert.equal(legacy.guardian_cnic,null);assert.equal(legacy.guardian_phone,null);
assert.equal(Number((await one('select count(*) n from resident_emergency_contacts')).n),0);
const r=randomUUID(), other=randomUUID();
await db.query("insert into residents(id,full_name,email,status,emergency_contact,emergency_contact_name,emergency_contact_relationship,city) values($1,'Local','resident@local.invalid','Inactive','03000000000','Legacy','Father','Staff City')",[r]);
await db.query("insert into residents(id,full_name,email,status,cnic) values($1,'Other','other@local.invalid','Inactive','TAKEN')",[other]);
const original=await one('select * from residents where id=$1',[r]);
const details={cnic:'NEW-PASSPORT',father_name:'Guardian',guardian_cnic:'GUARDIAN-ID',guardian_phone:'03111111111',city:'Overwrite attempt',dob:'2000-01-01'};
const contacts=[{contact_name:'Dad',relationship:'Father',phone:'03222222222'},{contact_name:'Uncle',relationship:'Uncle',phone:'03333333333'}];
const claims=async(role,email)=>db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role,email})]);
const save=(data=details,submit=false,contactList=contacts)=>db.query('select save_resident_profile_completion($1,$2,$3,$4)',[r,JSON.stringify(data),JSON.stringify(contactList),submit]);
await claims('service_role','');
await save({},false,[{contact_name:'Unfinished',relationship:'',phone:''}]);
await assert.rejects(save(details,true,[{contact_name:'Unfinished',relationship:'',phone:''}]),/Complete each contact/);
await save();assert.deepEqual(await one('select * from residents where id=$1',[r]),original);
await save({...details,occupation:'Student'});assert.equal((await one('select draft from resident_profile_completions where resident_id=$1',[r])).draft.occupation,'Student');
console.log('PASS draft is editable and leaves existing resident and legacy contact unchanged');
await assert.rejects(save({...details,cnic:'TAKEN'},true),/duplicate|unique/i);
assert.equal((await one('select submitted_at from resident_profile_completions where resident_id=$1',[r])).submitted_at,null);
assert.equal(Number((await one('select count(*) n from resident_emergency_contacts')).n),0);
await assert.rejects(save({...details,monthly_rent:'1'},true),/Unsupported/);
await save(details,true);
const submitted=await one('select * from residents where id=$1',[r]);
assert.equal(submitted.city,'Staff City');assert.equal(submitted.cnic,'NEW-PASSPORT');assert.equal(submitted.father_name,'Guardian');assert.equal(submitted.guardian_cnic,'GUARDIAN-ID');assert.equal(submitted.guardian_phone,'03111111111');
for(const k of ['email','phone','status','emergency_contact','emergency_contact_name','emergency_contact_relationship'])assert.equal(submitted[k],original[k]);
assert.equal(Number((await one('select count(*) n from resident_emergency_contacts where resident_id=$1',[r])).n),2);
await assert.rejects(save(),/locked/);await assert.rejects(save(details,true),/locked/);
console.log('PASS final submission fills missing fields, preserves staff data, saves Father + Uncle, uniqueness rollback and repeat lock');
await claims('authenticated','resident@local.invalid');await db.exec('set role authenticated');
await assert.rejects(save(),/permission denied/);
await assert.rejects(db.query('select save_resident_emergency_contacts($1,$2)',[r,JSON.stringify(contacts)]),/permission required/);
await assert.rejects(db.query("insert into resident_profile_completions(resident_id) values($1)",[other]),/permission denied/);
await assert.rejects(db.query("update resident_profile_completions set submitted_at=null where resident_id=$1",[r]),/permission denied/);
await assert.rejects(db.query("update resident_emergency_contacts set phone='hacked' where resident_id=$1",[r]),/permission denied/);
await db.query("update residents set cnic='hacked',guardian_phone='hacked' where id=$1",[r]);
assert.equal((await one('select cnic from residents where id=$1',[r])).cnic,'NEW-PASSPORT');
assert.equal(Number((await one('select count(*) n from resident_profile_completions where resident_id=$1',[other])).n),0);
await db.exec('reset role');
console.log('PASS resident direct RPC/table bypass blocked and ownership reads isolated');
await db.exec("insert into staff_users(full_name,email,role,status,permissions) values('Local manager','manager@local.invalid','Manager','Active','{residents}');");
await claims('authenticated','manager@local.invalid');await db.exec('set role authenticated');
await db.query("update residents set guardian_phone='corrected',cnic='CORRECTED-ID' where id=$1",[r]);
const contact=await one('select * from resident_emergency_contacts where resident_id=$1 limit 1',[r]);
await db.query('select save_resident_emergency_contacts($1,$2)',[r,JSON.stringify([{...contact,phone:'corrected'}])]);
await db.exec('reset role');
assert.equal((await one('select guardian_phone from residents where id=$1',[r])).guardian_phone,'corrected');
assert.equal(Number((await one('select count(*) n from resident_profile_corrections where resident_id=$1',[r])).n),2);
assert.ok((await one('select submitted_at from resident_profile_completions where resident_id=$1',[r])).submitted_at);
console.log('PASS authorized staff correct locked identity/contacts with audit, submission remains locked');
await claims('service_role','');
await db.query('select save_resident_emergency_contacts($1,$2)',[r,JSON.stringify([{contact_name:'Legacy',relationship:'Father',phone:'03000000000'}])]);
assert.equal(Number((await one('select count(*) n from resident_emergency_contacts where resident_id=$1',[r])).n),2);
for(const table of ['admissions','bills','payments','payment_allocations','contracts','auth.users']) assert.equal(Number((await one('select count(*) n from '+table)).n),0);
console.log('PASS legacy compatibility avoids duplicates; admissions, auth, contracts and finance untouched');
const blank=randomUUID();await db.query("insert into residents(id,full_name,status) values($1,'Blank','Inactive')",[blank]);
await db.query('select save_resident_profile_completion($1,$2,$3,true)',[blank,JSON.stringify({...details,cnic:'BLANK-ID'}),JSON.stringify(contacts)]);
assert.equal((await one('select cnic from residents where id=$1',[blank])).cnic,'BLANK-ID');
assert.equal(Number((await one('select count(*) n from resident_emergency_contacts where resident_id=$1',[blank])).n),2);
console.log('PASS blank resident completes identity, guardian details and multiple contacts');
// Execute the real API handler with local auth/database adapters, including a
// hostile body resident_id. The API must derive identity from the verified token.
const vm=require('node:vm'), ts=require('typescript');
const routeModule={exports:{}};
let lookedUpId=null, rpcId=null;
const admin={auth:{getUser:async token=>token==='valid' ? {data:{user:{email:'resident@local.invalid',user_metadata:{resident_id:r}}},error:null} : {data:{user:null},error:{message:'Invalid'}}},
  from(table){assert.equal(table,'residents');const filters={};return {select(){return this;},eq(k,v){filters[k]=v;return this;},neq(){return this;},async maybeSingle(){lookedUpId=filters.id;return {data:filters.email==='resident@local.invalid' && filters.id===r ? {id:r}:null,error:null};}};},
  async rpc(name,args){assert.equal(name,'save_resident_profile_completion');rpcId=args.p_resident_id;try {await db.query('select save_resident_profile_completion($1,$2,$3,$4)',[args.p_resident_id,JSON.stringify(args.p_details),JSON.stringify(args.p_contacts),args.p_submit]);return {error:null};}catch(e){return {error:{code:e.code,message:e.message}};}}
};
const imports={'next/server':{NextResponse:{json:(body,options)=>({body,...options})}},'@/lib/supabaseAdmin':{supabaseAdmin:admin},'@/lib/identity':{normalizeIdentityEmail:v=>v.trim().toLowerCase()},'@/lib/residentProfile':{profileFields:[]}};
const js=ts.transpileModule(fs.readFileSync('app/api/resident-portal/profile/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
vm.runInNewContext('(function(require,module,exports){'+js+'\n})',{})(name=>{assert.ok(imports[name]);return imports[name];},routeModule,routeModule.exports);
const request=(token,body)=>({headers:{get:()=>token?'Bearer '+token:null},json:async()=>body});
assert.equal((await routeModule.exports.POST(request(null,{}))).status,403);
assert.equal((await routeModule.exports.POST(request('invalid',{}))).status,403);
assert.equal((await routeModule.exports.POST(request('valid',{action:'submit',confirmed:false}))).status,400);
const blockedApi=await routeModule.exports.POST(request('valid',{resident_id:other,action:'submit',confirmed:true,details,contacts}));
assert.equal(blockedApi.status,400);assert.match(blockedApi.body.error,/locked/);assert.equal(lookedUpId,r);assert.equal(rpcId,r);
console.log('PASS API rejects missing/invalid auth, requires confirmation, ignores body identity, and enforces submitted lock');
} finally {await db.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
