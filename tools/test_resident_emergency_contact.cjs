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
const resident={id:'local',full_name:'Fixture',status:'Inactive',emergency_contact:'03001234567',emergency_contact_name:'Contact',emergency_contact_relationship:'Aunt'};
evaluate(edit+'\nopenEditForm(resident);',{resident,setEditingId:noop,setForm:f=>loaded=f,setPhotoFileName:noop,setIdCardFileName:noop,setMessage:noop,setError:noop,setShowForm:noop,window:{scrollTo:noop}});
assert.equal(loaded.emergency_contact_relationship,'Aunt');assert.equal(loaded.emergency_contact_name,'Contact');assert.equal(loaded.emergency_contact,resident.emergency_contact);
const start=source.indexOf('    const payload = {',source.indexOf('async function saveResident'));
const end=source.indexOf('\n    let result;',start);
function payload(editingId,fields){return evaluate(source.slice(start,end)+'\npayload;', {form:{...empty,full_name:'Fixture',...fields},editingId,now:'local-time',normalizedEmail:'local@example.invalid',residents:[],generateResidentCode:()=> 'LOCAL',RESIDENT_STATUS:{INACTIVE:'Inactive'}});}
for(const editingId of [null,'local']) {
const result=payload(editingId,{emergency_contact_name:' Contact ',emergency_contact_relationship:'Aunt',emergency_contact:'03001234567'});
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
console.log('PASS optional schema, existing row preserved, create/edit payloads, edit loading, legacy relationship preservation, profile fields');
}finally{await db.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
