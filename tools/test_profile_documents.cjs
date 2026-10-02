// Local PostgreSQL and mocked HTTP/storage only. No env or network.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const {randomUUID}=require('node:crypto');
const {PGlite}=require('../.local-checks/late-fee-db/node_modules/@electric-sql/pglite');
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
      if(file==='20261002140000_resident_profile_completion.sql') {
        await db.exec("insert into residents(full_name,status,emergency_contact,emergency_contact_name,emergency_contact_relationship) values('Before migration','Inactive','03001234567','Parent','Father');");
      }
      await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8').replace(/^\uFEFF/,''));
    }
const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
const claims=async(role,email)=>db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role,email})]);
await claims('service_role','');
const grandfather=randomUUID();
await db.query("insert into residents(id,full_name,email,status,photo_url,id_card_url) values($1,'Existing','existing@local.invalid','Inactive','data:image/png;base64,AQID','data:image/png;base64,AQID')",[grandfather]);
const details={cnic:'ID',father_name:'Guardian',guardian_cnic:'G-ID',guardian_phone:'03000000000'};
const contacts=[{contact_name:'Father',relationship:'Father',phone:'03111111111'},{contact_name:'Uncle',relationship:'Uncle',phone:'03222222222'}];
await db.query('select save_resident_profile_completion($1,$2,$3,true)',[grandfather,JSON.stringify(details),JSON.stringify(contacts)]);
const before=await one('select * from residents where id=$1',[grandfather]);
await db.exec(`create schema storage;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text,metadata jsonb,unique(bucket_id,name));
 alter table storage.objects enable row level security;
 grant usage on schema storage to authenticated,anon,service_role;
 grant all on storage.objects,storage.buckets to service_role;
 grant select,insert,update,delete on storage.objects to authenticated;
 create policy legacy_broad_policy on storage.objects for all to authenticated using(true) with check(true);
 insert into storage.buckets values('unrelated','unrelated',false,999999,array['image/gif']);`);
const documentMigration=fs.readFileSync('supabase/migrations/20261002150000_resident_profile_documents_storage_hardening.sql','utf8');
await db.exec(documentMigration);
const migrated=await one('select * from residents where id=$1',[grandfather]);
for(const k of Object.keys(before))assert.deepEqual(migrated[k],before[k]);
assert.deepEqual(await one("select id,name,public,file_size_limit,allowed_mime_types from storage.buckets where id='resident-documents'"),{id:'resident-documents',name:'resident-documents',public:false,file_size_limit:4194304,allowed_mime_types:['image/jpeg','image/png','image/webp','application/pdf']});
assert.ok((await one('select submitted_at from resident_profile_completions where resident_id=$1',[grandfather])).submitted_at);
const bucketGuard=documentMigration.match(/do \$\$ begin[\s\S]*?end; \$\$;/i)?.[0];assert.ok(bucketGuard);
assert.doesNotMatch(bucketGuard,/on\s+conflict\s*\([^)]*\)\s*do\s+update/i);
await db.query("update storage.buckets set name='resident-documents',file_size_limit=987654,allowed_mime_types=array['image/gif'] where id='resident-documents'");
const existingBucketBefore=await one("select * from storage.buckets where id='resident-documents'");
await db.exec(bucketGuard);
assert.deepEqual(await one("select * from storage.buckets where id='resident-documents'"),existingBucketBefore,'Existing bucket properties remain unchanged');
const unrelatedBefore=await one("select * from storage.buckets where id='unrelated'");await db.exec(bucketGuard);
assert.deepEqual(await one("select * from storage.buckets where id='unrelated'"),unrelatedBefore,'Unrelated bucket remains unchanged');
await db.query("update storage.buckets set public=true where id='resident-documents'");
await assert.rejects(db.exec(bucketGuard),/Existing resident-documents bucket is not private/);
assert.equal((await one("select public from storage.buckets where id='resident-documents'")).public,true,'A pre-existing public bucket is rejected, not modified');
await db.query("update storage.buckets set public=false where id='resident-documents'");
assert.equal(Number((await one("select count(*) n from pg_policies where schemaname='storage' and tablename='objects' and policyname='legacy_broad_policy'")).n),1);
console.log('PASS bucket absent/private creation, existing bucket immutable/fail-closed, unrelated bucket/policies preserved, legacy rows and lock preserved');
const r=randomUUID(),other=randomUUID();
await db.query("insert into residents(id,full_name,email,status) values($1,'Resident','resident@local.invalid','Inactive'),($2,'Other','other@local.invalid','Inactive')",[r,other]);
async function upload(id,slot,email='resident@local.invalid',type='image/png') {
 const path=id+'/'+slot+'/'+randomUUID()+'.png';
 await db.query("insert into storage.objects(bucket_id,name) values('resident-documents',$1)",[path]);
 await db.query('select register_resident_profile_document($1,$2,$3,$4,10,$5)',[id,slot,path,type,email]);return path;
}
const save=(id,type='CNIC')=>db.query('select save_resident_profile_completion($1,$2,$3,true)',[id,JSON.stringify({...details,cnic:id,resident_identity_type:type,guardian_identity_type:type}),JSON.stringify(contacts)]);
const legacyId=randomUUID(),pngData='data:image/png;base64,iVBORw0KGgo=',jpegData='data:image/jpeg;base64,/9j/AA==';
await db.query("insert into residents(id,full_name,email,status,photo_url,id_card_url) values($1,'Legacy','legacy@local.invalid','Inactive',$2,$3)",[legacyId,pngData,jpegData]);
assert.equal((await one("select resolve_profile_legacy_document($1,'photo') as doc",[legacyId])).doc.kind,'data');
assert.equal((await one("select resolve_profile_legacy_document($1,'resident_front') as doc",[legacyId])).doc.kind,'data');
await db.query("insert into storage.buckets values('legacy-private','legacy-private',false,4194304,array['image/png'])");
const legacyStoragePath=legacyId+'/photo/old.png';
await db.query("insert into storage.objects(bucket_id,name,metadata) values('legacy-private',$1,'{\"mimetype\":\"image/png\"}')",[legacyStoragePath]);
await db.query('update residents set photo_url=$1 where id=$2',['legacy-private/'+legacyStoragePath,legacyId]);
assert.equal((await one("select resolve_profile_legacy_document($1,'photo') as doc",[legacyId])).doc.kind,'storage');
await db.query('update residents set photo_url=$1 where id=$2',[pngData,legacyId]);
await upload(legacyId,'resident_back','legacy@local.invalid');await upload(legacyId,'guardian_front','legacy@local.invalid');await upload(legacyId,'guardian_back','legacy@local.invalid');
await save(legacyId);
const legacyAfter=await one('select photo_url,id_card_url from residents where id=$1',[legacyId]);
assert.equal(legacyAfter.photo_url,pngData);assert.equal(legacyAfter.id_card_url,jpegData,'Valid legacy data URLs remain unchanged after submission');
const unsafeLegacy=randomUUID();await db.query("insert into residents(id,full_name,email,status,photo_url) values($1,'Unsafe legacy','unsafe@local.invalid','Inactive','https://untrusted.invalid/profile.png')",[unsafeLegacy]);
assert.equal((await one("select resolve_profile_legacy_document($1,'photo') as doc",[unsafeLegacy])).doc,null);
for(const slot of ['resident_front','resident_back','guardian_front','guardian_back'])await upload(unsafeLegacy,slot,'unsafe@local.invalid');
await assert.rejects(save(unsafeLegacy),/needs staff review: Resident Profile Photo/);
assert.equal((await one('select photo_url from residents where id=$1',[unsafeLegacy])).photo_url,'https://untrusted.invalid/profile.png','Unsafe external reference is not rewritten');
console.log('PASS valid legacy data URLs/private storage references remain readable; unsafe external URL is rejected without rewriting');
await assert.rejects(save(r),/Required document missing/);
assert.equal((await one('select cnic from residents where id=$1',[r])).cnic,null);
const slots=['photo','resident_front','resident_back','guardian_front','guardian_back'];
for(const slot of slots)await upload(r,slot);
const originalPath=(await one("select storage_path from resident_profile_documents where resident_id=$1 and slot='photo'",[r])).storage_path;
const replacement=await upload(r,'photo');assert.notEqual(replacement,originalPath);
assert.ok(await one('select name from storage.objects where name=$1',[originalPath]));
await assert.rejects(upload(other,'photo'),/access denied/);
await assert.rejects(upload(r,'photo','resident@local.invalid','application/pdf'),/check constraint/);
await save(r);
assert.equal((await one('select photo_url from residents where id=$1',[r])).photo_url,replacement);
for(const slot of slots)await assert.rejects(upload(r,slot),/locked/);
await assert.rejects(save(r),/locked/);
assert.equal(Number((await one('select count(*) n from resident_emergency_contacts where resident_id=$1',[r])).n),2);
console.log('PASS CNIC requires all five documents, draft replacement preserves old objects, final submit locks all slots, multiple contacts retained');
for(const slot of ['photo','resident_front','guardian_front'])await upload(other,slot,'other@local.invalid');
await save(other,'Passport');
assert.ok((await one('select submitted_at from resident_profile_completions where resident_id=$1',[other])).submitted_at);
console.log('PASS Passport requires photo and both identity pages without fabricated backs');
await claims('authenticated','resident@local.invalid');await db.exec('set role authenticated');
await assert.rejects(db.query('select register_resident_profile_document($1,$2,$3,$4,10,$5)',[r,'photo',replacement,'image/png','resident@local.invalid']),/permission denied/);
await assert.rejects(db.query("update resident_profile_documents set storage_path='hacked' where resident_id=$1",[r]),/permission denied/);
await assert.rejects(db.query('delete from resident_profile_documents where resident_id=$1',[r]),/permission denied/);
assert.equal(Number((await one('select count(*) n from resident_profile_documents where resident_id=$1',[other])).n),0);
assert.equal(Number((await one("select count(*) n from storage.objects where bucket_id='resident-documents'")).n),0);
await assert.rejects(db.query("insert into storage.objects(bucket_id,name) values('resident-documents','hacked')"),/row-level security/);
await db.query("update storage.objects set name='hacked' where name=$1",[replacement]);
await db.query('delete from storage.objects where name=$1',[replacement]);
await db.exec('reset role');await claims('service_role','');assert.ok(await one('select name from storage.objects where name=$1',[replacement]));
console.log('PASS direct resident RPC, metadata, storage read/write/delete bypasses blocked even with broad legacy storage policy');
await db.exec("insert into staff_users(full_name,email,role,status,permissions) values('Staff','staff@local.invalid','Manager','Active','{residents}');");
await upload(r,'guardian_front','staff@local.invalid');await upload(r,'photo','staff@local.invalid');
assert.ok(Number((await one('select count(*) n from resident_profile_corrections where resident_id=$1',[r])).n)>=2);
const draft=randomUUID();await db.query("insert into residents(id,full_name,email,status) values($1,'Draft','draft@local.invalid','Inactive')",[draft]);
await upload(draft,'guardian_front','staff@local.invalid');await assert.rejects(upload(draft,'guardian_front','draft@local.invalid'),/recorded by staff/);
await assert.rejects(upload(grandfather,'photo','existing@local.invalid'),/locked|recorded by staff/);
console.log('PASS staff correction after lock is audited; staff/legacy documents remain authoritative');

const source=fs.readFileSync('app/residents/page.tsx','utf8');
const headings=['Personal Information','Guardian Information','Emergency Contacts','Address & Other Details','Documents / Photo'];
const form=source.slice(source.indexOf('<form onSubmit={saveResident}'),source.indexOf('</form>',source.indexOf('<form onSubmit={saveResident}')));
let previous=-1;for(const heading of headings){const position=form.indexOf('>'+heading+'</h3>');assert.ok(position>previous,heading);previous=position;}
assert.equal((form.match(/value=\{form\.cnic\}/g)||[]).length,1);
assert.equal((form.match(/value=\{form\.guardian_phone\}/g)||[]).length,1);
const pure={exports:{}};vm.runInNewContext('(function(exports){'+ts.transpileModule(fs.readFileSync('lib/profileDocuments.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText+'})',{})(pure.exports);
const validation=pure.exports.profileDocumentError;
const MAX_PROFILE_DOCUMENT_BYTES=pure.exports.MAX_PROFILE_DOCUMENT_BYTES;
assert.equal(validation('photo','image/png',8,new Uint8Array([137,80,78,71,13,10,26,10])),null);
assert.ok(validation('photo','application/pdf',5));assert.ok(validation('photo','image/svg+xml',10));assert.ok(validation('photo','image/png',5e6));assert.ok(validation('photo','image/png',8,new Uint8Array(8)));
assert.equal(validation('guardian_front','application/pdf',5,new Uint8Array([37,80,68,70,45])),null);
const compressorModule={exports:{}};
const compressorCode=ts.transpileModule(fs.readFileSync('lib/compressProfileImage.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const compressorWrapper=vm.runInNewContext('(function(require,module,exports){'+compressorCode+'\n})',{File,Blob});
compressorWrapper(name=>{assert.equal(name,'./profileDocuments');return pure.exports;},compressorModule,compressorModule.exports);
const compress=compressorModule.exports.compressProfileImage;
function compressionEnv(width,height,{type='image/jpeg',size=900,decodeFailure=false}={}) {
 const state={draw:null,mime:null,quality:null,closed:0,orientation:null};
 return {state,env:{decode:async(_file,options)=>{state.orientation=options.imageOrientation;if(decodeFailure)throw Error('decoder failure');return {width,height,close(){state.closed++;}};},createCanvas:()=>({width:0,height:0,getContext:()=>({drawImage:(_bitmap,_x,_y,w,h)=>{state.draw=[w,h];}}),toBlob(callback,mime,quality){state.mime=mime;state.quality=quality;callback(new Blob([new Uint8Array(size)],{type}));}})}};
}
const smallJpeg=new File([new Uint8Array(64)],'small.jpg',{type:'image/jpeg'});
const smallImageEnv=compressionEnv(640,480);
const smallCompressed=await compress(smallJpeg,'photo',smallImageEnv.env);
assert.deepEqual(smallImageEnv.state.draw,[640,480],'Small images are not upscaled');assert.equal(smallImageEnv.state.orientation,'from-image');assert.equal(smallImageEnv.state.mime,'image/jpeg');assert.equal(smallImageEnv.state.quality,0.82);assert.equal(smallCompressed.type,'image/jpeg');assert.equal(smallCompressed.size,900);assert.equal(smallImageEnv.state.closed,1);
const photoEnv=compressionEnv(2400,1600);
await compress(smallJpeg,'photo',photoEnv.env);assert.deepEqual(photoEnv.state.draw,[1200,800]);
const documentEnv=compressionEnv(3600,2400);
const documentCompressed=await compress(smallJpeg,'resident_front',documentEnv.env);assert.deepEqual(documentEnv.state.draw,[1800,1200]);assert.equal(documentCompressed.size,900);
const png=new File([new Uint8Array(64)],'scan.png',{type:'image/png'}),pngEnv=compressionEnv(300,200,{type:'image/png'});
const pngCompressed=await compress(png,'guardian_front',pngEnv.env);assert.equal(pngCompressed.type,'image/png');assert.equal(pngEnv.state.quality,undefined);
let pdfDecodeCalled=false;const pdf=new File([new Uint8Array([37,80,68,70,45])],'identity.pdf',{type:'application/pdf'});
assert.equal(await compress(pdf,'resident_front',{decode:async()=>{pdfDecodeCalled=true;throw Error('must bypass');},createCanvas:()=>{throw Error('must bypass');}}),pdf);assert.equal(pdfDecodeCalled,false);
const oversizedEnv=compressionEnv(2000,2000,{size:MAX_PROFILE_DOCUMENT_BYTES+1});
await assert.rejects(compress(smallJpeg,'photo',oversizedEnv.env),/4 MB/);
const failedEnv=compressionEnv(1000,800,{decodeFailure:true});
await assert.rejects(compress(smallJpeg,'photo',failedEnv.env),/compress this image safely/);
await assert.rejects(compress(new File([new Uint8Array(MAX_PROFILE_DOCUMENT_BYTES+1)],'large.jpg',{type:'image/jpeg'}),'photo',smallImageEnv.env),/4 MB/);
const componentSource=fs.readFileSync('components/residents/ProfileDocuments.tsx','utf8');
const uploadHandlerStart=componentSource.indexOf('async function upload(');
assert.ok(componentSource.indexOf('compressProfileImage(file, slot)',uploadHandlerStart)<componentSource.indexOf('const body = new FormData()',uploadHandlerStart));
assert.ok(componentSource.indexOf('const body = new FormData()',uploadHandlerStart)<componentSource.indexOf('const result = await request(body)',uploadHandlerStart));
assert.match(componentSource,/catch \(e\) \{ setError\(e instanceof Error \? e.message/);
const staffSource=fs.readFileSync('app/residents/page.tsx','utf8');
const photoHandler=staffSource.slice(staffSource.indexOf('async function handlePhotoUpload'),staffSource.indexOf('async function handleIdCardUpload'));
const idCardHandler=staffSource.slice(staffSource.indexOf('async function handleIdCardUpload'),staffSource.indexOf('  return (',staffSource.indexOf('async function handleIdCardUpload')));
assert.ok(photoHandler.indexOf('compressProfileImage(file, "photo")')<photoHandler.indexOf('readFileAsDataUrl(prepared)'));
assert.ok(idCardHandler.indexOf('compressProfileImage(file, "resident_front")')<idCardHandler.indexOf('readFileAsDataUrl(prepared)'));
console.log('PASS image compression: photo 1200px, identity 1800px, no upscale, orientation, MIME/quality/output size, PNG preservation, PDF bypass, 4 MB rules, safe failures before upload');
console.log('PASS form sections, no duplicated identity fields, MIME/size/content validation');
// Execute real server access helper and upload/view handlers against the local
// database and an in-memory storage adapter. No real credentials or requests.
const apiResident=randomUUID();await db.query("insert into residents(id,full_name,email,status) values($1,'API fixture','api@local.invalid','Inactive')",[apiResident]);
let uploads=0,signatures=0;
const admin={auth:{getUser:async token=>({data:{user:token==='own'?{email:'api@local.invalid',user_metadata:{resident_id:apiResident}}:token==='staff'?{email:'staff@local.invalid',user_metadata:{}}:null},error:null})},
 from(table){assert.ok(['residents','staff_users','resident_profile_documents','resident_profile_completions'].includes(table));let columns='*';const filters=[],params=[];
  const run=async()=>{try{return {data:(await db.query('select '+columns+' from '+table+(filters.length?' where '+filters.join(' and '):''),params)).rows,error:null};}catch(e){return {data:null,error:e};}};
  return {select(value){columns=value;return this;},eq(k,v){params.push(v);filters.push(k+'=$'+params.length);return this;},neq(k,v){params.push(v);filters.push(k+'<>$'+params.length);return this;},async maybeSingle(){const r=await run();return {...r,data:r.data?.[0]||null};},async single(){return this.maybeSingle();},then(ok,bad){return run().then(ok,bad);}};
 },
 storage:{from(name){assert.equal(name,'resident-documents');return {async upload(path,bytes,options){assert.equal(options.upsert,false);uploads++;await db.query("insert into storage.objects(bucket_id,name) values('resident-documents',$1)",[path]);return {error:null};},async createSignedUrl(path,seconds){assert.equal(seconds,60);signatures++;return {data:{signedUrl:'https://private.invalid/'+path},error:null};}};}},
 async rpc(name,args){assert.equal(name,'register_resident_profile_document');try{await db.query('select register_resident_profile_document($1,$2,$3,$4,$5,$6)',[args.p_resident_id,args.p_slot,args.p_path,args.p_content_type,args.p_size,args.p_actor_email]);return {error:null};}catch(e){return {error:{code:e.code,message:e.message}};}}
};
const imports={'server-only':{},'@/lib/supabaseAdmin':{supabaseAdmin:admin},'@/lib/identity':{normalizeIdentityEmail:v=>v.trim().toLowerCase()},'@/lib/profileDocuments':pure.exports,'next/server':{NextResponse:{json:(body,options)=>({body,...options})}}};
function moduleFile(file){const mod={exports:{}};const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{File,Uint8Array,crypto:require('node:crypto').webcrypto})(name=>{assert.ok(imports[name],name);return imports[name];},mod,mod.exports);return mod.exports;}
imports['@/lib/profileDocumentAccess']=moduleFile('lib/profileDocumentAccess.ts');
const route=moduleFile('app/api/resident-portal/profile/documents/route.ts');
const req=(token,slot='photo',id=null,bytes=[137,80,78,71,13,10,26,10])=>({headers:{get:()=>token?'Bearer '+token:null},nextUrl:{searchParams:new URLSearchParams(id?{residentId:id}:{})},formData:async()=>{const form=new FormData();form.set('slot',slot);form.set('file',new File([new Uint8Array(bytes)],'fixture.png',{type:'image/png'}));return form;}});
assert.equal((await route.POST(req(null))).status,403);
assert.equal((await route.GET(req('own','photo',r))).status,403);
assert.equal((await route.POST(req('own','photo',r))).status,403);assert.equal(uploads,0);assert.equal(signatures,0);
assert.equal((await route.POST(req('own','photo',null,[0,1,2]))).status,400);assert.equal(uploads,0);
for(const slot of slots)assert.equal((await route.POST(req('own',slot))).status,200);
assert.equal((await route.POST(req('own','photo'))).status,200);
const viewed=await route.GET(req('own'));assert.equal(viewed.status,200);assert.equal(viewed.body.documents.filter(d=>d.recorded).length,5);assert.equal(signatures,5);
await save(apiResident);
const uploadCount=uploads;assert.equal((await route.POST(req('own','guardian_front'))).status,409);assert.equal(uploads,uploadCount);
assert.equal((await route.POST(req('staff','guardian_front',apiResident))).status,200);
assert.equal((await route.GET(req('staff','photo',apiResident))).status,200);
assert.equal(route.DELETE,undefined);
console.log('PASS real API: own photo/identity uploads and draft replacement; cross-resident denial before storage access; signed reads; locked denial; authorized staff correction; no deletion endpoint');
}finally{await db.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
