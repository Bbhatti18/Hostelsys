// Isolated local checks: no environment files, production client, or network.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
const {PGlite}=require('../.local-checks/late-fee-db/node_modules/@electric-sql/pglite');
const source=fs.readFileSync('app/residents/page.tsx','utf8');
function evaluate(code,context={}) {return vm.runInNewContext(ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText,context);}
const empty=evaluate(source.slice(source.indexOf('const emptyForm:'),source.indexOf('const emergencyRelationships'))+'\nemptyForm;', {RESIDENT_STATUS:{INACTIVE:'Inactive'}});
for(const f of ['emergency_contact_name','emergency_contact_relationship','emergency_contact'])assert.equal(empty[f],'');
const edit=source.slice(source.indexOf('  function openEditForm('),source.indexOf('  function closeForm('));
let loaded;
const noop=()=>{};
const resident={id:'local',full_name:'Fixture',status:'Inactive',guardian_cnic:'GUARDIAN-ID',guardian_phone:'03123456789',emergency_contact:'03001234567',emergency_contact_name:'Contact',emergency_contact_relationship:'Aunt'};
evaluate(edit+'\nopenEditForm(resident);',{resident,setContactsVersion:noop,setContactsLoading:noop,setExtraContacts:noop,setEditingId:noop,setForm:f=>loaded=f,setPhotoFileName:noop,setIdCardFileName:noop,setMessage:noop,setError:noop,setShowForm:noop,window:{scrollTo:noop}});
assert.equal(loaded.emergency_contact_relationship,'Aunt');assert.equal(loaded.emergency_contact_name,'Contact');assert.equal(loaded.emergency_contact,resident.emergency_contact);
assert.equal(loaded.guardian_cnic,resident.guardian_cnic);assert.equal(loaded.guardian_phone,resident.guardian_phone);
const start=source.indexOf('    const payload = {',source.indexOf('async function saveResident'));
const end=source.indexOf('\n    let result;',start);
function payload(editingId,fields){return evaluate(source.slice(start,end)+'\npayload;', {form:{...empty,full_name:'Fixture',...fields},editingId,now:'local-time',normalizedEmail:'local@example.invalid',residents:[],generateResidentCode:()=> 'LOCAL',RESIDENT_STATUS:{INACTIVE:'Inactive'}});}
for(const editingId of [null,'local']) {
const result=payload(editingId,{guardian_cnic:' GUARDIAN-ID ',guardian_phone:'03123456789',emergency_contact_name:' Contact ',emergency_contact_relationship:'Aunt',emergency_contact:'03001234567'});
assert.equal(result.guardian_cnic,'GUARDIAN-ID');assert.equal(result.guardian_phone,'03123456789');
assert.equal(result.emergency_contact_name,'Contact');assert.equal(result.emergency_contact_relationship,'Aunt');assert.equal(result.emergency_contact,'03001234567');
assert.equal(payload(editingId,{}).emergency_contact_name,null);assert.equal(payload(editingId,{}).emergency_contact_relationship,null);
}
assert.ok(source.includes('!emergencyRelationships.includes(form.emergency_contact_relationship)'));
for(const path of ['app/residents/page.tsx','app/resident-portal/profile/page.tsx']){
const view=fs.readFileSync(path,'utf8');assert.match(view,/label="Emergency Contact Name"/);assert.match(view,/label="Relationship"/);assert.ok(view.includes('label="Emergency Contact / Phone"'));
}
(async()=>{const db=new PGlite();try {
await db.exec("create table public.residents(id integer primary key, emergency_contact text); insert into residents values(1,'03001234567');");
await db.exec(fs.readFileSync('supabase/migrations/20261002130000_add_resident_emergency_contact_details.sql','utf8'));
const row=(await db.query('select * from residents')).rows[0];assert.deepEqual(row,{id:1,emergency_contact:'03001234567',emergency_contact_name:null,emergency_contact_relationship:null});
await db.exec("insert into residents(id,emergency_contact_name,emergency_contact_relationship) values(2,'Contact','Mother'); update residents set emergency_contact_relationship='Aunt' where id=2;");
assert.equal((await db.query('select emergency_contact_relationship from residents where id=2')).rows[0].emergency_contact_relationship,'Aunt');
const saveHandler=source.slice(source.indexOf('  async function saveResident('),source.indexOf('  async function handleResetPortalPassword('));
for(const editingId of [null,'local']) for(const fail of [false,true]) {
  let savedId=null,closed=false,error='',written=null;
  const contacts=[{contact_name:'Father',relationship:'Father',phone:'03000000000'},{contact_name:'Uncle',relationship:'Uncle',phone:'03111111111'}];
  const context={exports:{},editingId,contactsLoading:false,documentsUploading:false,extraContacts:contacts,form:{...empty,full_name:'Fixture',phone:'03012345678',email:'local@example.invalid',cnic:'LOCAL-ID',guardian_cnic:'GUARDIAN-ID',guardian_phone:'03123456789'},residents:[],
    RESIDENT_STATUS:{INACTIVE:'Inactive'},retryContactsFor:{current:null},setSaving:noop,setMessage:noop,setError:value=>{error=value;},setEditingId:id=>{savedId=id;},closeForm:()=>{closed=true;},refresh:async()=>{error='';},
    normalizeEmail:v=>v.trim().toLowerCase(),normalizePhone:v=>v,normalizeIdentity:v=>v,generateResidentCode:()=> 'LOCAL',ensureResidentLogin:async()=>({created:false,email:'local@example.invalid'}),getSupabaseErrorMessage:e=>e.message,
    supabase:{from:()=>({select:()=>({order:async()=>({data:[],error:null})}),update:payload=>({eq:async()=>{written=payload;return {error:null};}}),insert:payload=>({select:()=>({single:async()=>{written=payload;return {data:{id:'created'},error:null};}})})}),rpc:async(name,args)=>{assert.equal(name,'save_resident_emergency_contacts');assert.equal(args.p_resident_id,editingId||'created');assert.equal(args.p_contacts.length,2);return {error:fail?{message:'Injected contact failure'}:null};}}
  };
  evaluate(saveHandler+'\nexports.save=saveResident;',context);
  await context.exports.save({preventDefault(){}});
  assert.equal(written.guardian_cnic,'GUARDIAN-ID');
  if(fail){assert.equal(closed,false);assert.equal(savedId,editingId||'created');assert.match(error,/Resident saved, but additional contacts were not saved/);if(!editingId)assert.equal(context.retryContactsFor.current,'created');}
  else {assert.equal(closed,true);assert.equal(error,'');}
}
console.log('PASS actual staff Create/Edit handler saves contacts and guardian details; partial failure retains edit identity and retry message');
console.log('PASS optional schema, existing row preserved, create/edit payloads, edit loading, legacy relationship preservation, profile fields');
}finally{await db.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
