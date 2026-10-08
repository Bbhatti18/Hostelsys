// Local component event tests: no environment, network, Supabase or email.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
function compile(file, deps) {
  const m={exports:{}};
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  vm.runInNewContext('(function(require,module,exports){'+code+'})',{window:deps.window||{confirm:()=>true},crypto:{randomUUID:()=> 'request-id'},URLSearchParams,Date,fetch:deps.fetch})(id=>deps[id]||require(id),m,m.exports);
  return m.exports;
}
function stateHarness() {
  let index=0;const state=[];
  return {state, reset(){index=0}, react:{...React,useState(initial){const i=index++;if(!(i in state))state[i]=initial;return [state[i],v=>state[i]=typeof v==='function'?v(state[i]):v]}}};
}
function nodes(tree) {
  if(!tree||typeof tree!=='object')return [];
  return [tree,...React.Children.toArray(tree.props?.children).flatMap(nodes)];
}
const obligation=(id,month,available)=>({bill_id:id,bill_type:'Rent',billing_month:month,due_date:month+'-01',total:12000,verified:0,pending:0,available});
const snapshot={amount:12000,fingerprint:'expected',allocations:[{bill_id:'march',amount:12000}],obligations:[obligation('march','2027-03',12000),obligation('april','2027-04',12000),{bill_id:'deposit',bill_type:'Security Deposit',billing_month:'Security Deposit',due_date:'2027-03-01',total:12000,verified:12000,pending:0,available:0}],fine_linked:false,already_corrected:false,receipt:{id:'receipt'}};
(async()=>{
  const hooks=stateHarness();const requests=[];let saved=0;
  const deps={'react':hooks.react,'@/lib/usePermissions':{usePermissions:()=>({role:'Admin',profile:{status:'Active'}})},'@/lib/supabase':{supabase:{auth:{getSession:async()=>({data:{session:{access_token:'local-test',expires_at:Date.now()/1000+600}}})}}},'@/lib/paymentReceiptPurpose':{rentPeriodLabel:month=>'Rent '+month},fetch:async(path,options)=>{requests.push({path,options});return {ok:true,json:async()=>options.method==='GET'?snapshot:{message:'saved'}}}};
  const Editor=compile('components/payments/StaffAllocationEditor.tsx',deps).default;
  const render=()=>{hooks.reset();return Editor({paymentId:'payment',receiptId:'receipt',onSaved:()=>saved++})};
  await nodes(render()).find(n=>n.type==='button').props.onClick();
  await new Promise(setImmediate);
  let tree=render();
  const inputs=nodes(tree).filter(n=>n.type==='input'&&n.props.type==='number');
  assert.equal(inputs.length,3);assert.equal(inputs[2].props.disabled,true);
  inputs[0].props.onChange({target:{value:'4000'}});inputs[1].props.onChange({target:{value:'8000'}});
  nodes(tree).find(n=>n.type==='textarea').props.onChange({target:{value:'Exact periods reviewed'}});
  tree=render();nodes(tree).find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}});
  tree=render();assert.match(renderToStaticMarkup(tree),/After: Rent 2027-03 Rs4,000 \+ Rent 2027-04 Rs8,000/);
  await nodes(tree).find(n=>n.type==='button'&&n.props.children==='Confirm Verification').props.onClick();
  await new Promise(setImmediate);
  const payload=JSON.parse(requests.at(-1).options.body);
  assert.deepEqual(payload.items.map(i=>[i.bill_id,i.billing_month,i.amount]),[['march','2027-03',4000],['april','2027-04',8000]]);
  assert.equal(payload.fingerprint,'expected');assert.equal(payload.confirmed,true);assert.equal(saved,1);
  assert.match(requests[0].path,/paymentId=payment.*receiptId=receipt/);
  const accountant=compile('components/payments/StaffAllocationEditor.tsx',{...deps,'@/lib/usePermissions':{usePermissions:()=>({role:'Accountant',profile:{status:'Active'}})}}).default;
  hooks.reset();assert.equal(accountant({paymentId:'payment',correction:true,onSaved(){}}),null);

  const billHooks=stateHarness(),rpc=[];
  const Actions=compile('components/payments/BillPaymentActions.tsx',{'react':billHooks.react,'next/link':{__esModule:true,default:'a'},'@/lib/usePermissions':deps['@/lib/usePermissions'],'@/lib/paymentReceiptPurpose':deps['@/lib/paymentReceiptPurpose'],'@/lib/supabase':{supabase:{rpc:async(name,args)=>{rpc.push({name,args});return {data:[{bill_id:'april',remaining:12000}],error:null}}}}}).default;
  const billRender=()=>{billHooks.reset();return Actions({billId:'april',month:'2027-04'})};
  let billTree=billRender();assert.match(renderToStaticMarkup(billTree),/payments\?billId=april/);assert.match(renderToStaticMarkup(billTree),/billing\?billId=april/);
  await nodes(billTree).find(n=>n.type==='button').props.onClick();
  billTree=billRender();nodes(billTree).find(n=>n.type==='input'&&n.props.type==='date').props.onChange({target:{value:'2027-04-15'}});
  nodes(billTree).find(n=>n.type==='input'&&n.props['aria-label']==='Request reason').props.onChange({target:{value:'Outstanding April rent'}});
  billTree=billRender();await nodes(billTree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});
  assert.equal(rpc.at(-1).name,'request_obligation_payment');assert.equal(rpc.at(-1).args.p_bill,'april');assert.equal(rpc.at(-1).args.p_amount,12000);
  // Execute the real Payments page's receive-link effect, with loaded rows.
  function receive(id) {
    const pageHooks=stateHarness(),effects=[];
    pageHooks.state[0]=[];pageHooks.state[1]=[{id:'resident',full_name:'Resident'}];
    pageHooks.state[2]=['march','april'].map((id,i)=>({id,resident_id:'resident',bill_type:'Rent',billing_month:i?'2027-04':'2027-03',balance_amount:i?8000:12000}));
    pageHooks.state[3]=[];pageHooks.state[9]=false;
    const pageDeps={'react':{...pageHooks.react,useEffect:f=>effects.push(f),useCallback:f=>f,useMemo:f=>f()},window:{location:{search:'?billId='+id}}};
    for(const match of fs.readFileSync('app/payments/page.tsx','utf8').matchAll(/from "(@\/[^\"]+)"/g))pageDeps[match[1]]=new Proxy({__esModule:true},{get:(target,key)=>key==='__esModule'?true:key==='default'?()=>null:()=>null});
    const Page=compile('app/payments/page.tsx',pageDeps).default;
    pageHooks.reset();Page();effects.find(f=>f.toString().includes('window.location.search'))();
    return pageHooks.state;
  }
  assert.equal(receive('april')[4].bill_id,'april');assert.equal(receive('april')[4].amount,'8000');
  assert.equal(receive('missing')[4].bill_id,'');assert.match(receive('missing')[13],/no other bill was selected/);
  console.log('PASS staff UI events: explicit months, exact split payload, paid deposit excluded, confirmation, Admin-only correction, exact-bill request and receive links.');
})().catch(e=>{console.error(e);process.exitCode=1});
