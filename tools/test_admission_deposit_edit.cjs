// Local PostgreSQL only; no environment, production client, or network.
// Isolated tests: only local pure modules may be imported. No application initialization,
// environment files, network clients, database commands, or connected fixtures.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
let ts;
try { ts = require("typescript"); } catch { ts = require("../.local-checks/typescript/package/lib/typescript.js"); }
const allowed = new Set(["residentFinancialSummary", "financialMath", "billApproval", "residentPaymentHistory", "paymentReceiptPurpose", "paymentObligations", "paymentAllocations", "canonical", "contractWorkflow", "noticeVisibility"]);
const cache = new Map();
function load(name) {
  name = name.replace(/^.*\//, "").replace(/\.ts$/, "");
  assert(allowed.has(name), `Non-pure import blocked: ${name}`);
  if (cache.has(name)) return cache.get(name);
  const source = fs.readFileSync(path.join(__dirname, "..", "lib", `${name}.ts`), "utf8");
  const loadedModule = { exports: {} };
  cache.set(name, loadedModule.exports);
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(`(function(require,module,exports){${code}\n})`, {}, { timeout: 2000 })(load, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}

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
      if(file.includes('storage_hardening') || file.includes('reconcile_pending_admission_deposit'))continue; // Supabase storage service is not loaded locally.
      await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8').replace(/^\uFEFF/,''));
    }

const one=async(sql,args=[]) => (await db.query(sql,args)).rows[0];
async function fixture(amount=10000,resident=null,status='Pending') {
 const r=resident||randomUUID(), room=randomUUID(),bed=randomUUID(),a=randomUUID();
 if(!resident)await db.query("insert into residents(id,full_name,status) values($1,'Local fixture','Inactive')",[r]);
 await db.query('insert into rooms(id,room_number) values($1,$2)',[room,room]);
 await db.query("insert into beds(id,room_id,bed_number) values($1,$2,'A')",[bed,room]);
 await db.query("insert into admissions(id,resident_id,room_id,bed_id,admission_date,status,monthly_rent,security_deposit) values($1,$2,$3,$4,'2026-10-01',$5,17000,$6)",[a,r,room,bed,status,amount]);
 async function bill(type,total){return (await one("insert into bills(bill_number,resident_id,admission_id,bill_type,billing_month,due_date,total_amount,balance_amount,rent_amount) values($1,$2,$3,$4,$5,'2026-10-01',$6,$6,$7) returning id",[randomUUID(),r,a,type,type==='Rent'?'2026-10':'Security Deposit',total,type==='Rent'?total:0])).id;}
 const rent=await bill('Rent',17000),deposit=amount?await bill('Security Deposit',amount):null;
 return {r,a,rent,deposit};
}
const edit=(f,n)=>db.query('update admissions set security_deposit=$1 where id=$2',[n,f.a]);
const snapshot=async()=>{const out={};for(const t of ['admissions','bills','payments','payment_allocations','payment_receipts','payment_status_history','contracts'])out[t]=(await db.query('select * from '+t+' order by id')).rows;return JSON.stringify(out);};
async function blocked(f,n,pattern){const before=await snapshot();await assert.rejects(edit(f,n),pattern);assert.equal(await snapshot(),before);}
async function pay(f,amount,status){return one("insert into payments(payment_number,resident_id,bill_id,amount,payment_method,payment_status) values($1,$2,$3,$4,'Cash',$5) returning id",[randomUUID(),f.r,f.deposit,amount,status]);}
const stale=await fixture();await edit(stale,0);const preMigration=await snapshot();
await db.exec(fs.readFileSync('supabase/migrations/20261002120000_reconcile_pending_admission_deposit.sql','utf8'));
assert.equal(await snapshot(),preMigration);await edit(stale,0);
assert.equal((await one('select bill_status from bills where id=$1',[stale.deposit])).bill_status,'Cancelled');
console.log('PASS migration performs no repair; explicit resave reconciles stale zero requirement');
const f=await fixture(),beforeRent=await one('select * from bills where id=$1',[f.rent]);
await edit(f,0);
let bill=await one('select * from bills where id=$1',[f.deposit]);
assert.equal(bill.bill_status,'Cancelled');assert.equal(Number(bill.total_amount),10000);
const admission=await one('select * from admissions where id=$1',[f.a]);
const bills=(await db.query('select * from bills where admission_id=$1',[f.a])).rows;
assert.equal(load('contractWorkflow').getAdmissionDeposit(admission,bills,[]).state,'not_required');
const summary=load('residentFinancialSummary').buildResidentFinancialSummary({admission,room:null,bed:null,bills,payments:[]});
assert.equal(summary.depositBalance,0);assert.equal(summary.totalOutstanding,17000);
assert.deepEqual(await one('select * from bills where id=$1',[f.rent]),beforeRent);
for(const t of ['payments','payment_receipts','payment_allocations','payment_status_history'])assert.equal(Number((await one('select count(*) n from '+t)).n),0);
console.log('PASS unpaid 10k -> 0: retained Cancelled bill, canonical display/dues zero, Rent and payment history unchanged');
const partial=await fixture();await edit(partial,5000);bill=await one('select * from bills where id=$1',[partial.deposit]);assert.equal(Number(bill.total_amount),5000);assert.equal(Number(bill.balance_amount),5000);
const zero=await fixture(0);await edit(zero,10000);await edit(zero,10000);assert.equal(Number((await one("select count(*) n from bills where admission_id=$1 and bill_type='Security Deposit'",[zero.a])).n),1);
console.log('PASS unpaid 10k -> 5k and 0 -> 10k, same bill reconciliation/idempotence');
for(const amount of [1000,10000]){const v=await fixture();await pay(v,amount,'Verified');await blocked(v,5000,/verified Deposit money/);await blocked(v,0,/verified Deposit money/);}
const pending=await fixture();await pay(pending,1000,'Pending');await blocked(pending,0,/pending verification/);
const receipt=await fixture();await db.query("insert into payment_receipts(resident_id,bill_id,receipt_url,amount) values($1,$2,'local-fixture',10000)",[receipt.r,receipt.deposit]);await blocked(receipt,5000,/pending verification/);
console.log('PASS verified reductions and pending payments/receipts blocked atomically, evidence unchanged');
const old=await fixture();await pay(old,10000,'Verified');await db.query("update admissions set status='Completed' where id=$1",[old.a]);const oldBefore=await one('select * from bills where id=$1',[old.deposit]);const current=await fixture(10000,old.r);await edit(current,0);assert.deepEqual(await one('select * from bills where id=$1',[old.deposit]),oldBefore);
console.log('PASS old admission isolation');
await db.exec(`create function test_deposit_failure() returns trigger language plpgsql as $$ begin raise exception 'Injected failure'; end; $$; create trigger test_deposit_failure before update on bills for each row execute function test_deposit_failure();`);
await blocked(partial,0,/Injected failure/);
console.log('PASS bill failure rolls admission edit back');
}finally{await db.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
