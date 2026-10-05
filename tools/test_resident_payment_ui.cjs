// Render the real resident card with isolated state. No database, network, or files written.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
const source=fs.readFileSync('components/payments/PaymentFollowups.tsx','utf8');
const row=(id,purpose,remaining,available=remaining)=>({bill_id:id,admission_id:'current',resident:'Resident',purpose,billing_month:'2026-10',original:remaining,verified:0,pending:remaining-available,remaining,available,followups:[],pending_receipts:[]});
const rows=[row('rent','Rent',17000),row('deposit','Security Deposit',10000)];
function render(purpose,amounts={},against='current',customRows=rows){
 let index=0;const changed={};const states={0:purpose,1:customRows,3:amounts,15:against};
 const mockReact={...React,useState(initial){const key=index++;return [key in states?states[key]:initial,value=>{changed[key]=value;}];},useEffect(){},useCallback:f=>f};
 const deps={'react':mockReact,'react/jsx-runtime':require('react/jsx-runtime'),'next/link':({children,...props})=>React.createElement('a',props,children),'@/lib/supabase':{supabase:{}},'@/lib/financialMath':{roundMoney:n=>Math.round(n*100)/100}};
 const module={exports:{}};const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2020}}).outputText;
 vm.runInNewContext('(function(require,module,exports){'+code+'\n})',{Date,Object,Number,Math,FormData})(id=>{assert.ok(deps[id],id);return deps[id];},module,module.exports);
 const tree=module.exports.default({additionalPaymentForm:React.createElement('form',{'data-testid':'combined-extra'},React.createElement('input',{required:true,type:'file'}))});
 return {tree,changed,html:renderToStaticMarkup(tree)};
}
function nodes(tree,type){if(!tree||typeof tree!=='object')return [];return [...(tree.type===type?[tree]:[]),...React.Children.toArray(tree.props?.children).flatMap(child=>nodes(child,type))];}
const forbidden=/canonical obligation|staff classification required|evidence only|non-ledger|Available to submit now|Pay an Obligation/i;
for(const [purpose,amounts,against] of [['rent',{rent:'17000'},'current'],['deposit',{deposit:'7000'},'current'],['combined',{rent:'17000',deposit:'7000'},'current'],['other',{},'other'],['historical',{},'historical']]){
 const view=render(purpose,amounts,against);assert.match(view.html,/Make a Payment/);assert.doesNotMatch(view.html,forbidden);assert.equal(nodes(view.tree,'form').length,1);const files=nodes(view.tree,'input').filter(n=>n.props.type==='file');assert.equal(files.length,1);assert.equal(files[0].props.required,true);assert.match(view.html,/Submit for Verification/);
}
assert.match(render('rent',{rent:'17000'}).html,/October 2026/);
assert.doesNotMatch(render('rent',{rent:'17000'}).html,/When will you pay/);
assert.match(render('deposit',{deposit:'7000'}).html,/Remaining balance: Rs 3,000/);
assert.match(render('combined',{rent:'17000',deposit:'7000'}).html,/Rs 24,000/);
const initial=render('');const purposeSelect=nodes(initial.tree,'select')[0];assert.ok(nodes(initial.tree,'option').some(n=>n.props.value==='combined'&&n.props.children==='Rent + Security Deposit'));
purposeSelect.props.onChange({target:{value:'combined'}});assert.deepEqual(JSON.parse(JSON.stringify(initial.changed[3])),{rent:'17000',deposit:'10000'});
const history=render('');nodes(history.tree,'select')[0].props.onChange({target:{value:'historical'}});assert.equal(history.changed[15],'historical');assert.deepEqual(Object.keys(history.changed[3]),[]);
const pending=render('deposit',{deposit:''},'current',[row('deposit','Security Deposit',7000,0)]);assert.match(pending.html,/awaiting review/);assert.equal(nodes(pending.tree,'button').find(n=>n.props.type==='submit').props.disabled,true);
const extra=render('additional');assert.equal(nodes(extra.tree,'form').length,1);assert.equal(nodes(extra.tree,'form')[0].props['data-testid'],'combined-extra');
const page=fs.readFileSync('app/resident-portal/payments/page.tsx','utf8');assert.equal((page.match(/<PaymentFollowups\b/g)||[]).length,1);assert.equal((page.match(/<form onSubmit=\{uploadReceipt\}/g)||[]).length,1);assert.match(page,/additionalPaymentForm=\{/);assert.doesNotMatch(page,/<h2[^>]*>Upload Payment Receipt<\/h2>/);assert.match(source,/body\.set\("historical","true"\)/);assert.match(source,/if \(!file \|\| !method/);
console.log('PASS resident payment UX: friendly labels, one active form, required receipt, explicit flexible combined choice, partial fields, pending cap display, previous receipt routing and retained combined Additional Charges form');
