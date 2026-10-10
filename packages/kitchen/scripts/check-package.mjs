import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';

const run=promisify(execFile);
const archive=process.argv[2]&&path.resolve(process.argv[2]);
if(!archive)throw new Error('Provide the .tgz produced by npm pack.');
const fixture=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'agenttrail-kitchen-package-')));
let service,events;
try{
  const npm=process.platform==='win32'?'npm.cmd':'npm';
  await run(npm,['install','--prefix',fixture,'--omit=dev','--ignore-scripts','--offline','--no-audit','--no-fund',archive],{timeout:60000});
  const installed=path.join(fixture,'node_modules/agenttrail-kitchen');
  const pkg=JSON.parse(await fs.readFile(path.join(installed,'package.json'),'utf8'));
  assert.equal(pkg.license,'MIT');
   assert.equal(pkg.private,true,'The harness fork must not accidentally publish under the upstream npm name');
  assert.deepEqual(Object.keys(pkg.dependencies||{}),[]);
  assert.match(await fs.readFile(path.join(installed,'docs/OBSERVABILITY.md'),'utf8'),/History is \*\*disabled by default\*\*/);
  for(const excluded of ['test','scripts','concepts','recordings','.office','.runs','public/src']){
    await assert.rejects(fs.access(path.join(installed,excluded)),{code:'ENOENT'});
  }
  await assert.rejects(fs.access(path.join(fixture,'node_modules/three')),{code:'ENOENT'});
  const cli=path.join(installed,pkg.bin['agenttrail-kitchen']);
  assert.match((await run(process.execPath,[cli,'--help'])).stdout,/agenttrail-kitchen/);
  const launch=args=>run(npm,['exec','--offline','--yes','--','agenttrail-kitchen',...args],{cwd:fixture,timeout:15000});
  assert.match((await launch(['--help'])).stdout,/Agenttrail Kitchen/);
  const first=path.join(fixture,'first repo'),second=path.join(fixture,"repo with spaces ' and $(literal)");
   const observerHome=path.join(fixture,'empty-observer-home'),stateDir=path.join(observerHome,'.local/state/code-harness/agenttrail');
  await Promise.all([first,second,observerHome].map(p=>fs.mkdir(p)));
  const {startOffice}=await import(pathToFileURL(path.join(installed,'src/server.mjs')));
  service=await startOffice({roots:[first],home:observerHome,stateDir,port:0});
  for(const [asset,mime] of [['/','text/html'],['/build/app.js','text/javascript'],['/kitchen.css','text/css'],['/fonts/nunito-800.woff2','font/woff2'],['/favicon.svg','image/svg+xml']]){
    const response=await fetch(service.url+asset);
    assert.equal(response.status,200,asset);
    assert.equal(response.headers.get('content-type')?.split(';')[0],mime);
    assert.ok((await response.arrayBuffer()).byteLength>20,asset);
  }
  const initial=await fetch(service.url+'/api/state').then(r=>r.json());
  assert.equal(initial.app,'agenttrail-kitchen');
  assert.deepEqual(initial.executors,[]);
  assert.equal(initial.history.enabled,false);
  assert.equal(initial.overview.length,1);
  const bootstrap=await fetch(service.url+'/api/bootstrap').then(r=>r.json());
  const registration=JSON.parse(await fs.readFile(path.join(stateDir,'server.json'))),historyHeaders={'x-history-token':registration.dashboardToken};
  assert.equal((await fetch(service.url+'/api/history')).status,401);
  assert.ok(!JSON.stringify(bootstrap).includes(registration.dashboardToken));
  const post=async(endpoint,data)=>{const response=await fetch(service.url+endpoint,{method:'POST',headers:{'content-type':'application/json','x-office-token':bootstrap.token,...historyHeaders},body:JSON.stringify(data)});assert.equal(response.status,200);return response.json();};
  await post('/api/history/settings',{enabled:true,retentionDays:3});
  // Synthetic provider fixtures, confined to the temporary consumer install.
  const logDir=path.join(observerHome,'.codex/sessions/2024/01/02');
  await fs.mkdir(logDir,{recursive:true});
  const log=path.join(logDir,'consumer-check.jsonl');
  const row=(type,payload)=>JSON.stringify({type,timestamp:new Date().toISOString(),payload})+'\n';
  const plan=status=>row('response_item',{type:'function_call',name:'update_plan',call_id:'plan-'+status,arguments:JSON.stringify({plan:[{step:'Check the installed kitchen',status}]})})+row('response_item',{type:'function_call_output',call_id:'plan-'+status,output:'Plan updated'});
  await fs.writeFile(log,JSON.stringify({type:'session_meta',payload:{id:'consumer-check',cwd:second}})+'\n'+row('event_msg',{type:'task_started',turn_id:'check'})+plan('in_progress')+row('response_item',{type:'function_call',name:'Read',call_id:'research',arguments:JSON.stringify({file_path:'research/notes.md',private:'never-show-this'})}));
  const {stdout}=await launch([second,'--state-dir',stateDir,'--no-open']);
  const live=new URL(stdout.split('\n')[0].replace('Kitchen updated: ',''));
  assert.equal(live.searchParams.get('project'),second);
  assert.equal(live.searchParams.get('mode'),'live');
  events=new AbortController();
  const reader=(await fetch(service.url+'/api/events',{signal:events.signal})).body.getReader();
  let pending='';
  const nextState=async predicate=>{
    const timer=setTimeout(()=>events.abort(),15000);
    try{
      while(true){
        let end;
        while((end=pending.indexOf('\n\n'))!==-1){
          const message=pending.slice(0,end);pending=pending.slice(end+2);
          if(message.startsWith('data: ')){const state=JSON.parse(message.slice(6));assert.ok(!JSON.stringify(state).includes('never-show-this'));if(predicate(state))return state;}
        }
        const part=await reader.read();assert.equal(part.done,false,'Live event stream closed early');pending+=new TextDecoder().decode(part.value);
      }
    }finally{clearTimeout(timer);}
  };
  const reading=await nextState(s=>s.executors.some(e=>e.sessionId==='consumer-check'&&e.state==='reading')&&s.orders.some(o=>o.title==='Check the installed kitchen'));
  assert.equal(reading.executors.length,1);
  assert.ok(reading.crew.filter(c=>c.project===second).length>1,'A planless repo has multiple role chefs');
  assert.equal(reading.orders.length,1);
  assert.equal(reading.orders[0].status,'in_progress');
  const researchChef=reading.crew.find(c=>c.project===second&&c.workingCount);
  assert.equal(researchChef.roleId,'researcher');
  await fs.appendFile(log,row('response_item',{type:'function_call_output',call_id:'research',output:'never-show-this'})+row('response_item',{type:'function_call',name:'Write',call_id:'build',arguments:JSON.stringify({file_path:'src/app.js',content:'never-show-this'})}));
  const writing=await nextState(s=>s.executors.some(e=>e.state==='writing'));
  const buildChef=writing.crew.find(c=>c.project===second&&c.workingCount);
  assert.notEqual(buildChef.id,researchChef.id,'The same session changes responsibilities');
  assert.equal(writing.orders[0].id,reading.orders[0].id,'Both chefs contribute to the same dish');
  assert.ok(writing.orders[0].contributors.some(c=>c.chefId===researchChef.id));
  assert.ok(writing.orders[0].contributors.some(c=>c.chefId===buildChef.id));
  await fs.appendFile(log,row('response_item',{type:'function_call_output',call_id:'build',output:'done'})+plan('completed')+row('event_msg',{type:'task_complete',turn_id:'check'}));
  const done=await nextState(s=>s.orders[0]?.status==='completed'&&s.executors[0]?.state==='complete');
   assert.ok(done.tables.some(t=>t.completedIds.includes(reading.orders[0].id)),'Completed dish reaches its table');
   const {createOpenCodeObserver}=await import(pathToFileURL(path.join(installed,'src/opencode/core.mjs')));
   const bridge=createOpenCodeObserver({home:observerHome,cwd:second});
   bridge.observe({type:'session.status',properties:{sessionID:'packed-open-code',status:{type:'busy'}}});
    bridge.observe({type:'todo.updated',properties:{sessionID:'packed-open-code',todos:[{content:'never-show-this',status:'in_progress'}]}});
    bridge.observe({type:'message.updated',properties:{info:{id:'msg_packed',sessionID:'packed-open-code',role:'assistant',time:{completed:Date.now()},tokens:{input:50,output:10,reasoning:2,cache:{read:20,write:0}},structured:'never-show-this'}}});
   bridge.observe({type:'session.status',properties:{sessionID:'packed-open-code',status:{type:'idle'}}});
   await bridge.settled();bridge.dispose();
   const observed=await nextState(s=>s.executors.some(e=>e.provider==='opencode'&&e.state==='input'));
    assert.equal(observed.executors.find(e=>e.provider==='opencode').sessionTasks[0].title,'Task 1');
    assert.equal(observed.overview.find(p=>p.id===second).sessions.find(s=>s.provider==='opencode').usage.input,50);
    const history=await fetch(service.url+'/api/history?limit=200',{headers:historyHeaders}).then(r=>r.json());
    assert.ok(history.records.some(record=>record.provider==='opencode'&&record.kind==='usage'));
    for(const privateText of ['never-show-this',second,'Check the installed kitchen'])assert.ok(!JSON.stringify(history.records).includes(privateText));
    await post('/api/history/clear',{});
    assert.equal((await fetch(service.url+'/api/history',{headers:historyHeaders}).then(r=>r.json())).records.length,0);
    await post('/api/history/settings',{enabled:false,retentionDays:3});
   assert.ok((await fetch(service.url+'/build/app.js').then(r=>r.text())).includes('OpenCode'),'Bundled UI includes the real provider identity');
  // File observation works independently of native todos and never writes to the repo.
  const changed=path.join(second,'observed-file.txt');
  await fs.writeFile(changed,'A consumer-created file.\n');
  await nextState(s=>s.projects.find(p=>p.id===second)?.activity.some(a=>a.file==='observed-file.txt'));
  assert.equal(await fs.readFile(changed,'utf8'),'A consumer-created file.\n');
  await fs.unlink(changed);
  const example=await launch([second,'--example','--state-dir',stateDir,'--no-open']);
  const demo=new URL(example.stdout.split('\n')[0].replace('Kitchen updated: ',''));
  assert.equal(demo.searchParams.get('mode'),'demo');
  assert.equal(demo.searchParams.has('project'),false);
  assert.deepEqual(await fs.readdir(first),[]);
  assert.deepEqual(await fs.readdir(second),[]);
   console.log('Packed kitchen verified: offline install, CLI/assets, Codex collaboration, OpenCode metadata/usage, project overview, opt-in private history/deletion, native tasks, file observation and example launch.');
}finally{
  events?.abort();
  await service?.close();
  await fs.rm(fixture,{recursive:true,force:true});
}
