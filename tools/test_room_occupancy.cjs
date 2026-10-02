// Pure local modules only: no SDK, credentials, network or writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(name) {
  name = name.split('/').pop();
  assert.ok(['roomOccupancy','statuses'].includes(name));
  const mod = {exports:{}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(`lib/${name}.ts`,'utf8'), {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020},
  }).outputText,{module:mod,exports:mod.exports,require:load});
  return mod.exports;
}
const {buildRoomOccupancy: build, summarizeRoomOccupancy: summary, summarizeBedInventory: inventory, matchesRoomStatus: matches} = load('roomOccupancy');
function fixture(occupied,capacity,id='r',status='Available') {
  const room={id,status,total_beds:99}; // Stored/manual capacity must not drive the denominator.
  const beds=Array.from({length:capacity},(_,i)=>({id:`${id}-b${i}`,room_id:id,status:i<occupied?'Occupied':'Vacant'}));
  const admissions=beds.slice(0,occupied).map((b,i)=>({id:`${id}-a${i}`,resident_id:`resident-${i}`,bed_id:b.id,room_id:id,status:i%2?'Pending':'Active'}));
  return {room,beds,admissions};
}
const rows=[];
for(const [occupied,capacity,status] of [[0,2,'Available'],[1,2,'Partially Occupied'],[2,2,'Fully Occupied'],[1,3,'Partially Occupied'],[3,4,'Partially Occupied'],[3,5,'Partially Occupied']]) {
  const f=fixture(occupied,capacity,`r${rows.length}`);
  const row=build(f.room,f.beds,f.admissions);rows.push(row);
  assert.equal(row.status,status);assert.equal(row.capacity,capacity);assert.equal(row.occupied,occupied);
  assert.equal(row.available,capacity-occupied);
  assert.equal(matches(row,status),true);assert.equal(matches(row,'All'),true);
  if(occupied)assert.equal(matches(row,'Available'),false,'Filter cannot use stale Available room status');
}
assert.equal(summary(rows).total,6);assert.equal(summary(rows).available,5);assert.equal(summary(rows).occupied,5);
for(const status of ['Completed','Cancelled','Archived']) {
  const f=fixture(1,2);f.admissions[0].status=status;
  const row=build(f.room,f.beds,f.admissions);
  assert.equal(row.occupied,0);assert.equal(row.status,'Available');
  assert.equal(row.beds[0].displayStatus,'Unassigned (review)');
  assert.equal(row.available,1,'Stale Occupied bed flag is not assignable in admission workflow');
}
for(const status of ['Active','Pending']) {
  const f=fixture(1,2);f.admissions[0].status=status;f.beds[0].status='Vacant';
  const row=build(f.room,f.beds,f.admissions);
  assert.equal(row.occupied,1);assert.equal(row.available,1,'Current assignment overrides stale Vacant bed flag');
}
{
  const single=fixture(1,3,'single');
  const singleRow=build(single.room,single.beds,single.admissions);
  assert.equal(singleRow.occupied,1);assert.equal(singleRow.blocked,0);assert.equal(singleRow.available,2);assert.equal(singleRow.status,'Partially Occupied');
  const exclusive=fixture(1,3,'exclusive');exclusive.admissions[0].allocation_mode='whole_room';
  const exclusiveRow=build(exclusive.room,exclusive.beds,exclusive.admissions);
  assert.equal(exclusiveRow.occupied,1,'Blocked beds do not count as residents or physically occupied beds');
  assert.equal(exclusiveRow.blocked,2);assert.equal(exclusiveRow.unavailable,3);assert.equal(exclusiveRow.available,0);assert.equal(exclusiveRow.status,'Exclusively Occupied');
  assert.equal(exclusiveRow.beds.filter(b=>b.blockedByExclusive).length,2);
  assert.equal(exclusiveRow.beds.filter(b=>b.displayStatus==='Blocked by Whole-Room Allocation').length,2);
  assert.equal(summary([exclusiveRow]).blocked,2);
  assert.ok(exclusive.beds.slice(1).every(b=>b.status==='Vacant'),'Exclusivity is derived without mutating physical bed status');
  const dashboardInventory=inventory([exclusive.room],exclusive.beds,exclusive.admissions);
  assert.equal(dashboardInventory.total,3);assert.equal(dashboardInventory.occupied,1);assert.equal(dashboardInventory.bookable,0);assert.equal(dashboardInventory.blocked,2);
  const historical=fixture(1,3,'historical');delete historical.admissions[0].allocation_mode;
  const historicalRow=build(historical.room,historical.beds,historical.admissions);
  assert.equal(historicalRow.available,2,'Rows without an explicit mode remain Single Bed');
  const inconsistent=fixture(0,3,'exclusive-inconsistent');
  inconsistent.admissions.push({id:'exclusive-invalid-primary',resident_id:'resident',room_id:inconsistent.room.id,bed_id:'missing',status:'Active',allocation_mode:'whole_room'});
  const failClosed=build(inconsistent.room,inconsistent.beds,inconsistent.admissions);
  assert.equal(failClosed.occupied,0);assert.equal(failClosed.available,0);assert.equal(failClosed.blocked,3);
}
for(const status of ['Inactive','Archived','Maintenance']) {
  const f=fixture(1,2);f.beds[0].status=status;
  const row=build(f.room,f.beds,f.admissions);
  assert.equal(row.capacity,1);assert.equal(row.occupied,0);assert.equal(row.beds[0].displayStatus,status);
}
for(const status of ['Maintenance','Inactive','Archived']) {
  const f=fixture(1,2,'special',status);const row=build(f.room,f.beds,f.admissions);
  assert.equal(row.status,status);assert.equal(row.available,0);assert.equal(row.occupied,1);
  assert.equal(summary([row]).total,status==='Archived'?0:1);
  assert.equal(summary([row]).maintenance,status==='Maintenance'?1:0);
  assert.equal(summary([row]).occupied,status==='Archived'?0:1);
}
let f=fixture(1,2);
f.beds.push({...f.beds[0]});f.admissions.push({...f.admissions[0]});
assert.equal(build(f.room,f.beds,f.admissions).occupied,1);assert.equal(build(f.room,f.beds,f.admissions).capacity,2);
f.admissions.push({...f.admissions[0],id:'conflicting-join',resident_id:'another-resident'});
assert.equal(build(f.room,f.beds,f.admissions).occupied,1,'A bed is counted once, not once per joined resident');
f=fixture(1,2);f.admissions[0].room_id='other';assert.equal(build(f.room,f.beds,f.admissions).occupied,0);
f=fixture(1,2);f.admissions[0].bed_id='missing';assert.equal(build(f.room,f.beds,f.admissions).occupied,0);
f=fixture(1,2);f.admissions[0].resident_id='';assert.equal(build(f.room,f.beds,f.admissions).occupied,0);
f=fixture(0,0);assert.equal(build(f.room,f.beds,f.admissions).available,0);assert.equal(build(f.room,f.beds,f.admissions).status,'Available');
f=fixture(0,2,'stale-room','Occupied');assert.equal(build(f.room,f.beds,f.admissions).status,'Available');
const before=JSON.stringify(f);build(f.room,f.beds,f.admissions);assert.equal(JSON.stringify(f),before);
console.log('PASS room occupancy: empty/partial/full, Active/Pending lifecycle, historical exclusion, active capacity, administrative restrictions, assignment isolation, deduplication, shared summary/filter semantics and no mutations.');
