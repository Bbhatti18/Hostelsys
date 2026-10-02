// Executes real PostgreSQL migrations/RPC in memory. No env, SDK, email or network.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const {randomUUID} = require('node:crypto');
const {PGlite} = require('../.local-checks/late-fee-db/node_modules/@electric-sql/pglite');

async function testForm() {
  // Run the actual submit handler with local effects, including failures after commit.
  const source=fs.readFileSync('components/admissions/AdmissionForm.tsx','utf8');
  const start=source.indexOf('  async function saveAdmission(');
  const end=source.indexOf('\n  return (',start);
  const handler=source.slice(start,end);
  for(const scenario of ['ok','whole-room','single-bed-no-bed','rpc-failure','login-failure','notification-failure','refresh-failure']) {
    const calls=[];let message='',error='';
    const setMessage=value=>{message=typeof value==='function'?value(message):value;};
    const noop=()=>{};
    const context={exports:{},residentId:'resident',roomId:'room',bedId:scenario==='whole-room'||scenario==='single-bed-no-bed'?'':'bed',admissionDate:'2026-10-01',monthlyRent:'17000',securityDeposit:'0',specialClauses:' Terms ',communicationChannels:['email'],
      setSaving:noop,setMessage,setError:value=>{error=value;},setResidentId:noop,setRoomId:noop,setBedId:noop,setAllocationMode:noop,setAdmissionDate:noop,setMonthlyRent:noop,setSecurityDeposit:noop,setSpecialClauses:noop,
      allocationMode:scenario==='whole-room'?'whole_room':'single_bed',supabase:{rpc:async(name,args)=>{calls.push('rpc');assert.equal(name,'create_admission_package');assert.equal(args.p_security_deposit,0);assert.equal(args.p_special_clauses,'Terms');assert.equal(args.p_allocation_mode,scenario==='whole-room'?'whole_room':'single_bed');assert.equal(args.p_bed_id,scenario==='whole-room'?null:'bed');return scenario==='rpc-failure'?{error:{message:'injected'}}:{data:{admission_id:'a',rent_bill_id:'rent',contract_id:'c',deposit_bill_id:null}};}},
      getSupabaseErrorMessage:e=>e.message,
      ensureResidentLogin:async()=>{calls.push('login');if(scenario==='login-failure')throw Error('injected');return {created:false,email:'local@example.invalid'};},
      requestEventNotification:async event=>{calls.push(event);return {warning:scenario==='notification-failure'};},
      notificationWarning:result=>result.warning?' Notification failed.':'',
      loadRoomsAndBeds:async()=>{calls.push('refresh');if(scenario==='refresh-failure')throw Error('injected');},onSaved:async()=>{},
    };
    vm.runInNewContext(ts.transpileModule(handler+'\nexports.save=saveAdmission;',{
      compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020},
    }).outputText,context);
    await context.exports.save({preventDefault(){}});
    if(scenario==='single-bed-no-bed') {assert.deepEqual(calls,[]);assert.match(error,/bed.*required/i);}
    else if(scenario==='rpc-failure') {assert.deepEqual(calls,['rpc']);assert.ok(error);}
    else {assert.equal(calls[0],'rpc');assert.equal(error,'');assert.match(message,/saved/);assert.equal(calls.filter(c=>c==='rpc').length,1);}
    if(scenario==='login-failure')assert.ok(!calls.includes('resident_login_details_sent'));
    if(scenario==='notification-failure')assert.match(message,/Notification failed/);
    if(scenario==='refresh-failure')assert.match(message,/do not create this admission again/);
  }
  console.log('PASS actual AdmissionForm handler: one RPC, side effects after commit only, failures preserve saved package.');
}

(async()=>{
  const db=new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,email text);
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      create function auth.role() returns text language sql stable as $$ select coalesce(auth.jwt()->>'role','service_role') $$;
      grant usage on schema auth to anon,authenticated,service_role;
      grant execute on all functions in schema auth to anon,authenticated,service_role;`);
    for(const file of fs.readdirSync('supabase/migrations').sort()) {
      if(file.includes('storage_hardening'))continue; // Supabase storage service is not loaded locally.
      await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8').replace(/^\uFEFF/,''));
    }
    const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
    const actorId=randomUUID();
    await db.query("insert into auth.users(id,email) values($1,'admin@local.invalid')",[actorId]);
    await db.exec(`insert into staff_users(email,full_name,role,status,permissions) values
      ('admin@local.invalid','Admin','Admin','Active','{}'),
      ('manager@local.invalid','Manager','Manager','Active','{admissions,rent_bills}'),
      ('admissions-only@local.invalid','Limited','Manager','Active','{admissions}'),
      ('reception@local.invalid','Reception','Reception','Active','{admissions,rent_bills}'),
      ('inactive@local.invalid','Inactive','Admin','Inactive','{}');
      insert into contract_templates(template_name,title,content,is_active) values('Standard','Terms','Standard terms',true);`);
    async function fixture(resident=null) {
      const r=resident||randomUUID(),room=randomUUID(),bed=randomUUID();
      if(!resident)await db.query("insert into residents(id,full_name,status) values($1,'Local fixture','Inactive')",[r]);
      await db.query('insert into rooms(id,room_number) values($1,$2)',[room,room]);
      await db.query("insert into beds(id,room_id,bed_number) values($1,$2,'A')",[bed,room]);
      return {r,room,bed};
    }
    async function create(f,overrides={},email='admin@local.invalid') {
      const values={date:'2026-10-01',rent:17000,deposit:17000,clauses:' Local clause ',...overrides};
      await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'authenticated',email,sub:actorId})]);
      await db.exec('set role authenticated');
      try {return (await one('select public.create_admission_package($1,$2,$3,$4,$5,$6,$7) as result',
        [f.r,f.room,f.bed,values.date,values.rent,values.deposit,values.clauses])).result;}
      finally {await db.exec('reset role');await db.query("select set_config('request.jwt.claims','{}',false)");}
    }
    const snapshot=async()=>{
      const result={};
      for(const table of ['admissions','beds','bills','contracts','payments','payment_allocations','payment_receipts','payment_status_history','notification_deliveries','auth.users']) {
        result[table]=(await db.query(`select * from ${table} order by id`)).rows;
      }
      return JSON.stringify(result);
    };
    async function rejectUnchanged(f,overrides={},pattern=/.*/,email) {
      const before=await snapshot();await assert.rejects(create(f,overrides,email),pattern);assert.equal(await snapshot(),before);
    }

    const f=await fixture(),result=await create(f);
    const a=await one('select * from admissions where id=$1',[result.admission_id]);
    assert.equal(a.status,'Pending');assert.equal(a.resident_id,f.r);assert.equal(a.bed_id,f.bed);
    assert.equal((await one('select status from beds where id=$1',[f.bed])).status,'Occupied');
    const rent=await one('select * from bills where id=$1',[result.rent_bill_id]);
    assert.equal(rent.bill_type,'Rent');assert.equal(rent.billing_month,'2026-10');assert.equal(new Date(rent.due_date).toISOString().slice(0,10),'2026-10-01');
    assert.equal(rent.admission_id,a.id);assert.equal(rent.resident_id,f.r);assert.equal(Number(rent.total_amount),17000);assert.equal(Number(rent.paid_amount),0);assert.equal(Number(rent.balance_amount),17000);
    const deposit=await one('select * from bills where id=$1',[result.deposit_bill_id]);assert.equal(deposit.bill_type,'Security Deposit');assert.equal(Number(deposit.total_amount),17000);
    const contract=await one('select * from contracts where id=$1',[result.contract_id]);
    assert.equal(contract.admission_id,a.id);assert.equal(contract.status,'Pending Signature');assert.equal(contract.signed_by_resident,false);assert.equal(contract.resident_signature_status,'Pending');
    assert.equal(contract.contract_content,'Standard terms\n\nSpecial Clauses:\nLocal clause');
    await rejectUnchanged(f,{},/vacant|current/); // Retry must not duplicate any required row.
    await rejectUnchanged(await fixture(f.r),{},/current admission/);
    assert.equal(Number((await one('select count(*) as n from contracts where admission_id=$1',[a.id])).n),1);

    const zero=await create(await fixture(),{deposit:0},'manager@local.invalid');assert.equal(zero.deposit_bill_id,null);
    assert.equal(Number((await one('select count(*) as n from bills where admission_id=$1',[zero.admission_id])).n),1);
    for(const table of ['payments','payment_allocations','payment_receipts','payment_status_history','notification_deliveries'])assert.equal(Number((await one(`select count(*) as n from ${table}`)).n),0);

    // Deliberate SQL trigger failures at each write stage prove rollback, not a JS simulation.
    await db.exec(`create function public.test_package_failure() returns trigger language plpgsql as $$ begin
      if current_setting('test.package_failure',true) = tg_table_name || ':' || coalesce(to_jsonb(new)->>'bill_type','') then
        raise exception 'Injected package failure'; end if; return new; end; $$;
      create trigger test_bill_failure before insert on bills for each row execute function test_package_failure();
      create trigger test_contract_failure before insert on contracts for each row execute function test_package_failure();`);
    for(const stage of ['bills:Rent','bills:Security Deposit','contracts:']) {
      const fresh=await fixture();await db.query("select set_config('test.package_failure',$1,false)",[stage]);
      await rejectUnchanged(fresh,{},/Injected package failure/);
      await db.query("select set_config('test.package_failure','',false)");
    }
    for(const status of ['Occupied','Inactive']) {
      const fresh=await fixture();await db.query('update beds set status=$1 where id=$2',[status,fresh.bed]);await rejectUnchanged(fresh,{},/vacant/);
    }
    const conflict=await fixture();const other=await fixture();
    await db.query("insert into admissions(resident_id,room_id,bed_id,admission_date,status) values($1,$2,$3,'2026-09-01','Active')",[other.r,conflict.room,conflict.bed]);
    await rejectUnchanged(conflict,{},/bed already belongs|no longer vacant/);
    for(const overrides of [{rent:0},{rent:-1},{deposit:-1},{rent:'NaN'},{rent:'Infinity'},{rent:'17000.001'},{date:'infinity'},{deposit:null}])await rejectUnchanged(await fixture(),overrides);
    const archived=await fixture();await db.query("update residents set status='Archived' where id=$1",[archived.r]);await rejectUnchanged(archived,{},/resident/);
    const maintenance=await fixture();await db.query("update rooms set status='Maintenance' where id=$1",[maintenance.room]);await rejectUnchanged(maintenance,{},/room/);
    const mismatch=await fixture();mismatch.room=(await fixture()).room;await rejectUnchanged(mismatch,{},/room/);
    for(const email of ['outsider@local.invalid','inactive@local.invalid','admissions-only@local.invalid','reception@local.invalid'])await rejectUnchanged(await fixture(),{},/permissions/,email);
    for(const role of ['anon','service_role'])assert.equal((await one("select has_function_privilege($1,'public.create_admission_package(uuid,uuid,uuid,date,numeric,numeric,text,text)','EXECUTE') as allowed",[role])).allowed,false);

    await db.exec('update contract_templates set is_active=false');await rejectUnchanged(await fixture(),{},/Exactly one/);
    await db.exec("update contract_templates set is_active=true,content=' '");await rejectUnchanged(await fixture(),{},/no terms/);
    await db.exec("update contract_templates set content='Standard terms'; insert into contract_templates(template_name,title,content,is_active) values('Duplicate','Duplicate','Terms',true)");
    await rejectUnchanged(await fixture(),{},/Exactly one/);
    console.log('PASS real PostgreSQL atomic admission: required package, zero deposit, Rent/Deposit/Contract rollback, duplicate retries, bed/resident conflicts, dates, amounts, template and role/module validation, no financial/notification history.');
  } finally {await db.close();}
  await testForm();
})().catch(error=>{console.error(error);process.exitCode=1;});
