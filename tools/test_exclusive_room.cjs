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
    assert.equal(dependency, './statuses');
    return loadPure('statuses');
  };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, { module, exports: module.exports, require: requireModule });
  return module.exports;
}

(async () => {
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

    const { buildRoomOccupancy, summarizeRoomOccupancy } = loadPure('roomOccupancy');
    const occupancy = async roomId => {
      const room = await one('select id,status from rooms where id=$1', [roomId]);
      const beds = (await db.query('select id,room_id,status from beds where room_id=$1 order by bed_number', [roomId])).rows;
      const admissions = (await db.query("select id,room_id,bed_id,resident_id,status,allocation_mode from admissions where room_id=$1 and status in ('Pending','Active')", [roomId])).rows;
      return buildRoomOccupancy(room, beds, admissions);
    };
    const countAdmissions = async roomId => Number((await one("select count(*) as count from admissions where room_id=$1 and status in ('Pending','Active')", [roomId])).count);

    const shared = await fixture();
    await assert.rejects(create(shared, shared.residentIds[0], null, 'single_bed'), /Select a bed for Single Bed allocation/);
    const single = await create(shared, shared.residentIds[0], shared.beds[0], 'single_bed', true);
    assert.equal((await one('select allocation_mode from admissions where id=$1', [single.admission_id])).allocation_mode, 'single_bed');
    assert.equal((await one('select status from beds where id=$1', [shared.beds[1]])).status, 'Vacant');
    let row = await occupancy(shared.roomId);
    assert.equal(row.occupied, 1); assert.equal(row.available, 2); assert.equal(row.status, 'Partially Occupied');
    await assert.rejects(create(shared, shared.residentIds[1], shared.beds[1], 'whole_room'), /no other current admission/);
    await db.query("update admissions set status='Active' where id=$1", [single.admission_id]);
    await assert.rejects(create(shared, shared.residentIds[1], shared.beds[1], 'whole_room'), /no other current admission/);

    const privateRoom = await fixture();
    const exclusive = await create(privateRoom, privateRoom.residentIds[0], null, 'whole_room');
    assert.equal((await one('select allocation_mode from admissions where id=$1', [exclusive.admission_id])).allocation_mode, 'whole_room');
    assert.equal(exclusive.primary_bed_id, privateRoom.beds[0], 'Whole Room chooses the first bed in stable bed-number order without a caller-selected bed');
    assert.equal((await one('select bed_id from admissions where id=$1', [exclusive.admission_id])).bed_id, privateRoom.beds[0]);
    assert.equal(Number((await one('select total_beds from rooms where id=$1', [privateRoom.roomId])).total_beds), 3, 'Exclusive allocation does not alter configured capacity');
    assert.equal(await countAdmissions(privateRoom.roomId), 1, 'Exclusive booking creates one resident/admission only');
    assert.equal(Number((await one("select count(*) as count from bills where admission_id=$1 and bill_type='Rent' and total_amount=17000", [exclusive.admission_id])).count), 1);
    assert.equal(Number((await one("select count(*) as count from bills where admission_id=$1 and bill_type='Security Deposit' and total_amount=15000", [exclusive.admission_id])).count), 1);
    assert.equal((await one('select contract_content from contracts where id=$1', [exclusive.contract_id])).contract_content, 'Standard terms');
    row = await occupancy(privateRoom.roomId);
    assert.equal(row.occupied, 1); assert.equal(row.blocked, 2); assert.equal(row.unavailable, 3);
    assert.equal(row.available, 0); assert.equal(row.status, 'Exclusively Occupied');
    assert.deepEqual(JSON.parse(JSON.stringify(row.beds.filter(bed => bed.blockedByExclusive).map(bed => bed.id))), privateRoom.beds.slice(1));
    assert.ok((await db.query('select status from beds where id=any($1::uuid[])', [privateRoom.beds.slice(1)])).rows.every(bed => bed.status === 'Vacant'), 'Blocked beds remain physically Vacant and are not deactivated');
    assert.equal(summarizeRoomOccupancy([row]).occupied, 1); assert.equal(summarizeRoomOccupancy([row]).blocked, 2);
    await assert.rejects(create(privateRoom, privateRoom.residentIds[1], privateRoom.beds[1], 'single_bed'), /reserved by a current Whole Room/);
    await db.query("update admissions set status='Active' where id=$1", [exclusive.admission_id]);
    await assert.rejects(create(privateRoom, privateRoom.residentIds[1], privateRoom.beds[1], 'single_bed'), /reserved by a current Whole Room/);
    await assert.rejects(create(privateRoom, privateRoom.residentIds[1], privateRoom.beds[1], 'whole_room'), /no other current admission/);
    await assert.rejects(create(privateRoom, privateRoom.residentIds[2], privateRoom.beds[2], 'invalid'), /Select Single Bed/);

    const wrongRoom = await fixture();
    await assert.rejects(create(wrongRoom, wrongRoom.residentIds[0], privateRoom.beds[2]), /active bed in the selected room|no longer vacant in this room/);
    const inactive = await fixture('Available', ['Inactive', 'Vacant', 'Vacant']);
    await assert.rejects(create(inactive, inactive.residentIds[0], inactive.beds[0]), /no longer vacant in this room/);
    const maintenance = await fixture('Maintenance');
    await assert.rejects(create(maintenance, maintenance.residentIds[0], maintenance.beds[0]), /not operational/);
    const noEligibleBeds = await fixture('Available', ['Inactive', 'Occupied']);
    await assert.rejects(create(noEligibleBeds, noEligibleBeds.residentIds[0], null, 'whole_room'), /at least one active vacant bed/);
    const twoBedRoom = await fixture('Available', ['Vacant', 'Vacant']);
    await create(twoBedRoom, twoBedRoom.residentIds[0], null, 'whole_room');
    row = await occupancy(twoBedRoom.roomId);
    assert.equal(row.occupied, 1); assert.equal(row.available, 0); assert.equal(row.blocked, 1); assert.equal(row.capacity, 2);
    assert.equal(await countAdmissions(twoBedRoom.roomId), 1);

    const conversion = await fixture();
    await create(conversion, conversion.residentIds[0], conversion.beds[0], 'single_bed');
    await create(conversion, conversion.residentIds[1], conversion.beds[1], 'single_bed');
    await assert.rejects(db.query("update admissions set allocation_mode='whole_room' where resident_id=$1 and status='Pending'", [conversion.residentIds[0]]), /no other current admission/);

    const editSource = await fixture();
    const editRoom = await create(editSource, editSource.residentIds[0], null, 'whole_room');
    const originalPrimary = (await one('select bed_id from admissions where id=$1', [editRoom.admission_id])).bed_id;
    await db.query("update admissions set notes='unrelated edit' where id=$1", [editRoom.admission_id]);
    assert.equal((await one('select bed_id from admissions where id=$1', [editRoom.admission_id])).bed_id, originalPrimary, 'Unrelated Whole Room edit preserves primary bed');
    const newEditRoom = await fixture();
    await db.query('update admissions set room_id=$1,bed_id=null where id=$2', [newEditRoom.roomId, editRoom.admission_id]);
    assert.equal((await one('select bed_id from admissions where id=$1', [editRoom.admission_id])).bed_id, newEditRoom.beds[0], 'Changing an exclusive room resolves its primary bed in the database');
    assert.equal((await one('select status from beds where id=$1', [originalPrimary])).status, 'Vacant');

    await db.query("update admissions set allocation_mode='single_bed' where id=$1", [exclusive.admission_id]);
    row = await occupancy(privateRoom.roomId);
    assert.equal(row.available, 2, 'Whole Room to Single Bed conversion releases derived blocks');
    assert.equal(row.status, 'Partially Occupied');
    await db.query("update admissions set allocation_mode='whole_room' where id=$1", [exclusive.admission_id]);
    await db.query("update admissions set status='Cancelled' where id=$1", [exclusive.admission_id]);
    row = await occupancy(privateRoom.roomId);
    assert.equal(row.available, 3, 'Cancellation releases all remaining bookable inventory without reactivation');
    assert.equal(row.status, 'Available');

    const historical = await fixture();
    await db.query("insert into admissions(resident_id,room_id,bed_id,admission_date,status) values($1,$2,$3,'2026-09-01','Active')", [historical.residentIds[0], historical.roomId, historical.beds[0]]);
    assert.equal((await one('select allocation_mode from admissions where room_id=$1', [historical.roomId])).allocation_mode, 'single_bed');
    row = await occupancy(historical.roomId); assert.equal(row.available, 2, 'Historical rows default to Single Bed');
    await db.query("update admissions set status='Completed' where room_id=$1", [historical.roomId]);
    assert.equal((await occupancy(historical.roomId)).available, 3, 'Completion releases the bed according to physical bed state');
    await assert.rejects(db.query("update admissions set allocation_mode='whole_room' where room_id=$1", [historical.roomId]), /Historical admission allocation mode cannot be changed/);

    const race = await fixture();
    // PGlite is single-connection; this exercises competing invocations while
    // separately asserting the transaction-scoped lock used across real clients.
    await db.query('select set_config(\'request.jwt.claims\',$1,false)', [JSON.stringify({ role: 'authenticated', email: 'admin@local.invalid', sub: actorId })]);
    await db.exec('set role authenticated');
    let raceResults;
    try {
      raceResults = await Promise.all(race.residentIds.slice(0, 2).map((residentId, index) => one(
        'select public.create_admission_package($1,$2,$3,$4,$5,$6,$7,$8) as result',
        [residentId, race.roomId, null, '2026-10-01', 17000, 0, '', 'whole_room'],
      ).then(result => ({ ok: true, result: result.result }), error => ({ ok: false, error }))));
    } finally {
      await db.exec('reset role');
      await db.query("select set_config('request.jwt.claims','{}',false)");
    }
    assert.equal(raceResults.filter(result => result.ok).length, 1, 'Serialized concurrent attempts permit only one exclusive admission');
    assert.equal(await countAdmissions(race.roomId), 1);
    const lockDefinition = await one("select pg_get_functiondef('public.lock_financial_ledger()'::regprocedure) as definition");
    assert.match(lockDefinition.definition, /pg_advisory_xact_lock/);
    const triggerDefinition = await one("select pg_get_functiondef('public.guard_admission_room_allocation()'::regprocedure) as definition");
    assert.match(triggerDefinition.definition, /lock_financial_ledger/);
    assert.match(triggerDefinition.definition, /whole_room/);
    const secureDefinitions = (await db.query("select p.proname,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('create_admission_package','guard_admission_room_allocation')")).rows;
    assert.equal(secureDefinitions.length, 2);
    for (const fn of secureDefinitions) {
      assert.equal(fn.prosecdef, true);
      assert.ok(fn.proconfig.some(setting => setting === 'search_path=pg_catalog, public'));
    }
    const migrationSource = fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations/20261001140000_exclusive_room_allocation.sql'), 'utf8');
    assert.doesNotMatch(migrationSource, /disable\s+row\s+level\s+security|drop\s+policy/i);

    const authorization = await db.query("select has_function_privilege('anon','public.create_admission_package(uuid,uuid,uuid,date,numeric,numeric,text,text)','EXECUTE') as anon_exec, has_function_privilege('service_role','public.create_admission_package(uuid,uuid,uuid,date,numeric,numeric,text,text)','EXECUTE') as service_exec");
    assert.equal(authorization.rows[0].anon_exec, false); assert.equal(authorization.rows[0].service_exec, false);
    assert.equal((await one("select has_function_privilege('authenticated','public.create_admission_package(uuid,uuid,uuid,date,numeric,numeric,text,text)','EXECUTE') as allowed")).allowed, true);
    const modeColumn = await one("select column_default,is_nullable from information_schema.columns where table_schema='public' and table_name='admissions' and column_name='allocation_mode'");
    assert.equal(modeColumn.column_default, "'single_bed'::text"); assert.equal(modeColumn.is_nullable, 'NO');
    assert.equal((await one("select allocation_mode from admissions where id=$1", [single.admission_id])).allocation_mode, 'single_bed');
    const formSource = fs.readFileSync(path.join(__dirname, '..', 'components/admissions/AdmissionForm.tsx'), 'utf8');
    assert.match(formSource, /useState<AllocationMode>\("single_bed"\)/);
    assert.match(formSource, /Books the entire room for this resident\. No other bed in this room can be allocated while this admission is current\./);
    assert.match(formSource, /allocationMode === "single_bed" \? \(/);
    assert.match(formSource, /p_bed_id: allocationMode === "whole_room" \? null : bedId/);
    assert.match(formSource, /Whole Room Reservation/);

    console.log('PASS exclusive-room PostgreSQL: default Single Bed, exclusive logical blocking, one resident, conflict/invalid-bed checks, lock-backed competing invocation gate, conversion/lifecycle release, historical defaults, finance package, and restricted RPC grants.');
  } finally {
    await db.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
