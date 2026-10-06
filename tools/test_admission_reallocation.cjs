// Real in-memory PostgreSQL migrations/RPC plus pure occupancy projections.
// No env files, SDK, network, email, or remote database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('../.local-checks/late-fee-db/node_modules/@electric-sql/pglite');
const ts = require('typescript');

function loadPure(name) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', `${name}.ts`), 'utf8');
  const module = { exports: {} };
  const requireModule = dependency => {
    assert.ok(['./statuses', './roomOccupancy'].includes(dependency));
    return loadPure(dependency.slice(2));
  };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { module, exports: module.exports, require: requireModule });
  return module.exports;
}

(async () => {
  const { reallocationDestinations } = loadPure('reallocationDestinations');
  const room = { id: 'r', status: 'Available' };
  const beds = [{ id: 'a', room_id: 'r', status: 'Occupied' }, { id: 'b', room_id: 'r', status: 'Vacant' }];
  const single = { id: 'admission', resident_id: 'resident', room_id: 'r', bed_id: 'a', status: 'Pending', allocation_mode: 'single_bed' };
  const whole = { ...single, allocation_mode: 'whole_room' };
  const options = (admission, mode, others = [], inventory = beds) => reallocationDestinations([room], inventory, [admission, ...others], admission, mode);
  assert.deepEqual(Array.from(options(single, 'single_bed')[0].beds, b => b.id), ['b'], 'Same bed excluded; same-room different bed allowed');
  assert.equal(options(single, 'single_bed', [], [beds[0]]).length, 0, 'Room without a changed destination is excluded');
  assert.equal(options(whole, 'whole_room').length, 0, 'Same-room Whole Room no-op excluded');
  assert.equal(options(single, 'whole_room').length, 1, 'Same-room exclusive conversion allowed when alone');
  const neighbor = { ...single, id: 'other', resident_id: 'other', bed_id: 'b', status: 'Active' };
  assert.equal(options(single, 'whole_room', [neighbor]).length, 0, 'Another current admission blocks exclusive conversion');
  assert.equal(options(single, 'whole_room', [{ ...neighbor, status: 'Completed' }]).length, 1, 'Historical admission does not block conversion');
  assert.deepEqual(Array.from(options(whole, 'single_bed')[0].beds, b => b.id), ['a', 'b'], 'Whole Room conversion may retain primary or choose another bed');
  assert.equal(options(single, 'single_bed', [neighbor]).length, 0, 'Occupied alternative is excluded');
  const component = fs.readFileSync('components/admissions/MoveResident.tsx', 'utf8');
  assert.ok(component.includes('if (busy || !canMove || !destination) return;'), 'Save rejects stale/invalid selections before RPC');
  assert.ok(component.includes('disabled={!canMove || busy}'), 'Confirmation uses the same valid destination predicate');
  const { buildRoomOccupancy } = loadPure('roomOccupancy');
  const shared = buildRoomOccupancy(room,beds,[single]);
  const exclusive = buildRoomOccupancy(room,beds,[whole]);
  assert.equal(shared.status,'Partially Occupied');assert.equal(shared.available,1);assert.equal(shared.blocked,0);
  assert.equal(exclusive.status,'Exclusively Occupied');assert.equal(exclusive.available,0);assert.equal(exclusive.blocked,1);
  // Exercise the real dialog's mode-change handler without network or effects.
  const React=require('react');
  function dialog(admission,neighbors=[]) {
    let i=0;const changed={};const states={0:[{...room,room_number:'14'}],1:beds,2:[admission,...neighbors]};
    const mod={exports:{}};
    const deps={'react':{...React,useEffect(){},useState(initial){const key=i++;return [key in states?states[key]:initial,v=>{changed[key]=v;}];}},'react/jsx-runtime':require('react/jsx-runtime'),'@/lib/supabase':{supabase:{}},'@/lib/reallocationDestinations':{reallocationDestinations}};
    const compiled=ts.transpileModule(component,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText;
    vm.runInNewContext('(function(require,module,exports){'+compiled+'})',{})(id=>{assert.ok(deps[id],id);return deps[id];},mod,mod.exports);
    const tree=mod.exports.default({admission,residentName:'Resident',onClose(){},async onSaved(){}});
    const selects=[];function walk(n){if(!n||typeof n!=='object')return;if(Array.isArray(n)){n.forEach(walk);return;}if(n.type==='select')selects.push(n);walk(n.props?.children);}walk(tree);
    return {changed,select:selects[0]};
  }
  const toSharing=dialog(whole);assert.equal(toSharing.select.props.value,'whole_room');
  toSharing.select.props.onChange({target:{value:'single_bed'}});
  assert.equal(toSharing.changed[4],'r');assert.equal(toSharing.changed[5],'a','Retain current primary bed for same-room conversion');
  const toWhole=dialog(single);toWhole.select.props.onChange({target:{value:'whole_room'}});
  assert.equal(toWhole.changed[4],'r');assert.equal(toWhole.changed[5],'');
  const blocked=dialog(single,[neighbor]);blocked.select.props.onChange({target:{value:'whole_room'}});assert.equal(blocked.changed[4],'');
  console.log('PASS UI destinations: no-ops excluded, same-room moves/conversions preserved, current conflicts excluded, save/button share validation');
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key,email text);
      create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt()->>'sub')::uuid $$;
      create function auth.role() returns text language sql stable as $$ select coalesce(auth.jwt()->>'role','service_role') $$;
      grant usage on schema auth to anon,authenticated,service_role;
      grant execute on all functions in schema auth to anon,authenticated,service_role;`);
    for (const file of fs.readdirSync('supabase/migrations').sort()) {
      if (file.includes('storage_hardening')) continue;
      await db.exec(fs.readFileSync(path.join('supabase/migrations', file), 'utf8').replace(/^\uFEFF/, ''));
    }
    const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
    const actorId = randomUUID();
    await db.query("insert into auth.users(id,email) values($1,'admin@local.invalid')", [actorId]);
    await db.exec("insert into staff_users(email,full_name,role,status,permissions) values('admin@local.invalid','Admin','Admin','Active','{}'); insert into contract_templates(template_name,title,content,is_active) values('Standard','Terms','Standard terms',true)");

    async function fixture(roomStatus = 'Available', bedStatuses = ['Vacant', 'Vacant', 'Vacant']) {
      const roomId = randomUUID();
      const residentIds = [randomUUID(), randomUUID(), randomUUID()];
      const beds = bedStatuses.map(() => randomUUID());
      await db.query('insert into rooms(id,room_number,status,total_beds) values($1,$2,$3,$4)', [roomId, roomId, roomStatus, bedStatuses.length]);
      for (let i = 0; i < beds.length; i++) {
        await db.query('insert into beds(id,room_id,bed_number,status) values($1,$2,$3,$4)', [beds[i], roomId, String.fromCharCode(65 + i), bedStatuses[i]]);
      }
      for (const residentId of residentIds) await db.query("insert into residents(id,full_name,status) values($1,'Resident','Inactive')", [residentId]);
      return { roomId, residentIds, beds };
    }

    async function create(fixtureRow, residentId, bedId, mode = 'single_bed', useDefault = false) {
      await db.query('select set_config(\'request.jwt.claims\',$1,false)', [JSON.stringify({ role: 'authenticated', email: 'admin@local.invalid', sub: actorId })]);
      await db.exec('set role authenticated');
      try {
        const args = [residentId, fixtureRow.roomId, bedId, '2026-10-01', 17000, 15000, ''];
        const result = useDefault
          ? await one('select public.create_admission_package($1,$2,$3,$4,$5,$6,$7) as result', args)
          : await one('select public.create_admission_package($1,$2,$3,$4,$5,$6,$7,$8) as result', [...args, mode]);
        return result.result;
      } finally {
        await db.exec('reset role');
        await db.query("select set_config('request.jwt.claims','{}',false)");
      }
    }


    async function move(id,room,bed,mode='single_bed',role='authenticated',email='admin@local.invalid') {
      await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role,email,sub:actorId})]);
      await db.exec('set role '+role);
      try { return await one('select reallocate_admission($1,$2,$3,$4,$5) result',[id,room,bed,mode,'Transfer']); }
      finally { await db.exec('reset role'); await db.query("select set_config('request.jwt.claims','{}',false)"); }
    }
    for(const role of ['anon','authenticated','service_role']) {
      for(const privilege of ['INSERT','UPDATE','DELETE'])assert.equal((await one("select has_table_privilege($1,'admission_allocation_history',$2) allowed",[role,privilege])).allowed,false);
    }
    const a=await fixture(),b=await fixture(),c=await fixture(),d=await fixture(),inactive=await fixture('Maintenance');
    const pkg=await create(a,a.residentIds[0],a.beds[0]);
    const rival=await create(d,d.residentIds[0],d.beds[0]);
    const pay=await one("insert into payments(payment_number,resident_id,bill_id,amount,payment_method,payment_status) values($1,$2,$3,1000,'Cash','Verified') returning id",[randomUUID(),a.residentIds[0],pkg.rent_bill_id]);
    const combined=await one("insert into payments(payment_number,resident_id,amount,payment_method) values($1,$2,500,'Cash') returning id",[randomUUID(),a.residentIds[0]]);
    await db.query('insert into payment_allocations(payment_id,bill_id,amount) values($1,$2,500)',[combined.id,pkg.deposit_bill_id]);
    await db.query("insert into payment_receipts(resident_id,bill_id,payment_id,receipt_url,amount) values($1,$2,$3,'private-proof',500)",[a.residentIds[0],pkg.deposit_bill_id,combined.id]);
    await db.query("update contracts set signed_by_resident=true,signed_at=now(),resident_signature_status='Signed',resident_signature_url='signature-preserved' where id=$1",[pkg.contract_id]);
    const fee=await one('select id from late_fees where bill_id=$1',[pkg.rent_bill_id]);
    await db.query("insert into late_fee_history(late_fee_id,action,amount_before,amount_after,waived_amount,reason,actor) values($1,'Calculated',0,100,0,'Existing history','staff')",[fee.id]);
    const snapshot=async()=> {
      const result={};
      for(const table of ['residents','bills','payments','payment_allocations','payment_receipts','payment_status_history','late_fees','late_fee_history'])
        result[table]=(await db.query('select * from '+table+' order by id')).rows;
      return result;
    };
    const moneyBefore=await snapshot(),contractBefore=await one('select * from contracts where id=$1',[pkg.contract_id]);
    const before=await one('select * from admissions where id=$1',[pkg.admission_id]);
    let successes=0;
    async function good(room,bed,mode='single_bed') {
      const old=await one('select * from admissions where id=$1',[pkg.admission_id]);
      await move(pkg.admission_id,room,bed,mode);successes++;
      const row=await one('select * from admissions where id=$1',[pkg.admission_id]);
      assert.equal(row.resident_id,before.resident_id);assert.deepEqual(row.admission_date,before.admission_date);
      assert.equal((await one('select status from beds where id=$1',[row.bed_id])).status,'Occupied');
      if(old.bed_id!==row.bed_id)assert.equal((await one('select status from beds where id=$1',[old.bed_id])).status,'Vacant');
      assert.equal(Number((await one('select count(*) n from admission_allocation_history')).n),successes);
      assert.deepEqual(await snapshot(),moneyBefore);
      const contract=await one('select * from contracts where id=$1',[pkg.contract_id]);
      for(const key of Object.keys(contractBefore))if(!['room_id','bed_id','updated_at'].includes(key))assert.deepEqual(contract[key],contractBefore[key],key);
      assert.equal(contract.room_id,row.room_id);assert.equal(contract.bed_id,row.bed_id);
    }
    async function bad(room,bed,mode='single_bed') {
      const old=await one('select * from admissions where id=$1',[pkg.admission_id]);
      const bedsBefore=(await db.query('select * from beds order by id')).rows;
      const contractsBefore=(await db.query('select * from contracts order by id')).rows;
      await assert.rejects(move(pkg.admission_id,room,bed,mode));
      assert.deepEqual(await one('select * from admissions where id=$1',[pkg.admission_id]),old);
      assert.deepEqual((await db.query('select * from beds order by id')).rows,bedsBefore);
      assert.deepEqual((await db.query('select * from contracts order by id')).rows,contractsBefore);
      assert.equal(Number((await one('select count(*) n from admission_allocation_history')).n),successes);
    }
    await good(a.roomId,a.beds[1]); // same room, Pending
    await good(b.roomId,b.beds[0]);
    await good(b.roomId,null,'whole_room');
    await bad(b.roomId,null,'whole_room'); // unchanged exclusive allocation
    const primary=(await one('select bed_id from admissions where id=$1',[pkg.admission_id])).bed_id;
    await good(b.roomId,primary,'single_bed'); // same room, retain primary
    assert.equal((await one('select allocation_mode from admissions where id=$1',[pkg.admission_id])).allocation_mode,'single_bed');
    await good(b.roomId,null,'whole_room'); // sole occupant may regain exclusivity
    await good(c.roomId,null,'whole_room');
    await db.query("update admissions set status='Active' where id=$1",[pkg.admission_id]);
    await good(a.roomId,a.beds[0]);
    await bad(a.roomId,a.beds[0]);
    await bad(d.roomId,d.beds[0]);
    await bad(d.roomId,null,'whole_room');
    await move(rival.admission_id,d.roomId,null,'whole_room');successes++;
    await bad(d.roomId,d.beds[1]);
    await bad(inactive.roomId,inactive.beds[0]);
    await bad(a.roomId,a.beds[1],'whole_room');
    await db.query("update beds set status='Inactive' where id=$1",[b.beds[1]]);await bad(b.roomId,b.beds[1]);
    for(const role of ['anon','service_role'])await assert.rejects(move(pkg.admission_id,b.roomId,b.beds[0],'single_bed',role),/permission denied/);
    await assert.rejects(move(pkg.admission_id,b.roomId,b.beds[0],'single_bed','authenticated','resident@local.invalid'),/permission/);
    await db.exec("create function fail_move() returns trigger language plpgsql as $$ begin raise exception 'Injected failure'; end $$; create trigger fail_move before insert on admission_allocation_history for each row execute function fail_move();");
    await bad(b.roomId,b.beds[0]);
    await db.exec('drop trigger fail_move on admission_allocation_history');
    await db.query("update admissions set status='Completed' where id=$1",[pkg.admission_id]);await bad(b.roomId,b.beds[0]);
    assert.equal(Number((await one('select count(*) n from admissions')).n),2);
    assert.equal((await one('select status from beds where id=$1',[d.beds[0]])).status,'Occupied');
    assert.deepEqual(await snapshot(),moneyBefore);
    // PGlite serializes statements: competing requests still demonstrate the loser
    // cannot claim the winner's inventory. Multi-session locking needs PostgreSQL.
    const x=await fixture(),y=await fixture(),z=await fixture();
    const xp=await create(x,x.residentIds[0],x.beds[0]),yp=await create(y,y.residentIds[0],y.beds[0]);
    await move(xp.admission_id,z.roomId,z.beds[0]);
    await assert.rejects(move(yp.admission_id,z.roomId,z.beds[0]));
    assert.equal(Number((await one("select count(*) n from admissions where bed_id=$1 and status in ('Pending','Active')",[z.beds[0]])).n),1);
    assert.equal((await one('select bed_id from admissions where id=$1',[yp.admission_id])).bed_id,y.beds[0]);
    for (const [role,status,permissions,allowed] of [['Manager','Active','{admissions}',true],['Reception','Active','{admissions}',true],['Manager','Inactive','{admissions}',false],['Manager','Active','{}',false],['Accountant','Active','{admissions}',false]]) {
      const email=randomUUID()+'@local.invalid';
      await db.query('insert into staff_users(email,full_name,role,status,permissions) values($1,$2,$3,$4,$5)',[email,'Staff',role,status,permissions]);
      await assert.rejects(move(xp.admission_id,z.roomId,z.beds[0],'single_bed','authenticated',email),allowed ? /unchanged/ : /permission/);
    }
    await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'authenticated',email:'resident@local.invalid',sub:actorId})]);
    await db.exec('set role authenticated');
    assert.equal(Number((await one('select count(*) n from admission_allocation_history')).n),0);
    await assert.rejects(db.query('delete from admission_allocation_history'),/permission denied/);
    await db.exec('reset role');
    const source=fs.readFileSync('app/admissions/page.tsx','utf8');
    assert.ok(!source.includes('needsNewBedClaim'));
    assert.ok(source.includes('<MoveResident'));
    console.log('PASS all move modes, identity/date/history preservation, contracts, audit, rollback, conflicts, lifecycle, authorization and serialized competing claims');
  } finally { await db.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
