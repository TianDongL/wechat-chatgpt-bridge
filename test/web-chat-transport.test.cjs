const test = require('node:test');
const assert = require('node:assert/strict');
const {baselineCursor,outgoingPage,makeReceipt,confirmReceipt,run} = require('../src/native/web_chat_transport.cjs');
const node = (id,parent,role,extra={}) => ({id,parent,message:{id,author:{role},create_time:10,
  status:'finished_successfully',content:{content_type:'text',parts:[id]},...extra}});
const chat = nodes => ({current_node:nodes.at(-1).id,mapping:Object.fromEntries(nodes.map(n=>[n.id,n]))});
const {pushPage} = require('../src/native/web_chat_transport.cjs');
const finalNode = (id, parent) => node(id, parent, 'assistant', {channel:'final',end_turn:true});

test('a vanished initial position can resume only from a newer visible user on one linear conversation', () => {
  const vanished = '11111111-ffff-4444-8888-111111111111';
  const c = chat([node('old', null, 'user', {create_time:5}), finalNode('old-result', 'old'),
    node('new', 'old-result', 'user', {create_time:12}), finalNode('result', 'new'),
    node('internal', 'result', 'assistant', {end_turn:true,metadata:{is_visually_hidden_from_conversation:true}})]);
  const texts = (initial, after=vanished) => pushPage(c,after,9000,null,null,vanished,initial).entries
    .filter(e=>e.text).map(e=>e.id);
  assert.deepEqual(texts(true), ['result']);
  assert.deepEqual(texts(false), []);
  assert.deepEqual(texts(true,'result'), []);
  assert.deepEqual(pushPage(c,'old',9000,null,null,'ambiguous:saved',true).entries, []);
  c.mapping.new.message.metadata = {is_visually_hidden_from_conversation:true};
  assert.deepEqual(texts(true), []);
  delete c.mapping.new.message.metadata;
  c.mapping.sibling = finalNode('sibling','old');
  assert.deepEqual(texts(true), []);
});

test('a terminal partial is skipped and later full text on that branch still reaches the owner', () => {
  const c = chat([node('u',null,'user'),node('partial','u','assistant',{
    channel:'final',status:'finished_partial_completion',end_turn:true,metadata:{is_complete:true}}),
    node('next','partial','user'),finalNode('final','next'),node('hidden','final','assistant',{
      channel:'final',end_turn:true,metadata:{is_visually_hidden_from_conversation:true}})]);
  const p = pushPage(c,'u',9000,null,null,'u',true);
  assert.deepEqual(p.entries.filter(e=>e.finished_turn).map(e=>e.id), ['final']);
  assert.deepEqual(p.entries.filter(e=>e.text).map(e=>e.id), ['final']);
});

test('a partial at the live tip can still complete in place', () => {
  const c = chat([node('u',null,'user'),node('answer','u','assistant',{
    status:'finished_partial_completion',channel:'final',end_turn:true})]);
  assert.deepEqual(pushPage(c,'u',9000,null,null,'u',true).entries, []);
  c.mapping.answer.message.status = 'finished_successfully';
  assert.equal(pushPage(c,'u',9000,null,null,'u',true).entries[0].text,'answer');
});

test('both numbered selection and a direct selection keep a durable ancestor of the temporary cursor', async () => {
  const c = webchat([node(BASE,null,'user',{create_time:3}),node('transient',BASE,'assistant',{
    channel:'commentary',end_turn:false,create_time:5})]);
  const base = {target:TARGET,origin_thread:ORIGIN,push_mode:true};
  const numbered = await run({...base,operation:'outbox',opened_at:6000,after:'',initial_watch:true},'unused',fixture([c]).deps);
  assert.equal(numbered.start_cursor,'transient');
  assert.equal(numbered.start_anchor,BASE);
  const direct = await run({...base,operation:'baseline'},'unused',fixture([c]).deps);
  assert.equal(direct.cursor,'transient');
  assert.equal(direct.branch_anchor,BASE);
});

test('push follows the exact original user after an edit on another branch', () => {
  const c = chat([node('base',null,'assistant'),node('original','base','user'),finalNode('ours','original'),
    node('later','ours','user'),finalNode('later-reply','later'),
    node('edited','base','user'),finalNode('sibling-reply','edited')]);
  const answer = pushPage(c,'base',9000,null,'original','base');
  assert.deepEqual(answer.entries,[]);
  assert.deepEqual([answer.completed.id,answer.completed.user_id], ['ours','original']);
  assert.equal(pushPage(c,'base',11000,null,'original','base').completed,undefined);
});

test('off-branch regenerated replies are ambiguous, active streaming is never replaced by a sibling', () => {
  const c = chat([node('base',null,'assistant'),node('u','base','user'),finalNode('v1','u'),finalNode('v2','u'),
    node('different','base','user'),finalNode('elsewhere','different')]);
  const result = pushPage(c,'base',9000,null,'u');
  assert.equal(result.ambiguous_turn,true);
  assert.equal(result.completed,undefined);
  c.current_node = 'v2';
  assert.equal(pushPage(c,'base',9000,null,'u').completed.id,'v2');
  c.mapping.v2.message.status = 'in_progress';
  assert.equal(pushPage(c,'base',9000,null,'u').completed,undefined);
});

test('passive updates require the same delivered branch and never rewind before its anchor', () => {
  const c = chat([node('base',null,'user'),finalNode('old','base'),node('u','old','user'),finalNode('anchor','u'),
    node('u2','anchor','user'),finalNode('new','u2')]);
  for (const cursor of ['gone','old','anchor']) {
    assert.deepEqual(pushPage(c,cursor,9000,null,null,'anchor').entries.filter(x=>x.text).map(x=>x.id),['new']);
  }
  c.current_node = 'old';
  assert.deepEqual(pushPage(c,'anchor',9000,null,null,'anchor').entries,[]);
});

test('receipt lookup waits, then yields only the newly created exact user on an inactive branch', () => {
  const snapshot = before();
  const receipt = makeReceipt(snapshot,'PROMPT',100000);
  const otherId = '66666666-6666-4666-8666-666666666666';
  const c = webchat([snapshot.mapping[BASE],node(otherId,BASE,'user',{create_time:100}),finalNode('other-final',otherId)]);
  assert.deepEqual(pushPage(c,BASE,9000,receipt,null).entries,[]);
  assert.equal(pushPage(c,BASE,9000,receipt,null).confirmation.status,'pending');
  c.mapping[USER] = after().mapping[USER];
  c.mapping.ours = finalNode('ours',USER);
  const match = pushPage(c,BASE,9000,receipt,null);
  assert.equal(match.confirmation.message_id,USER);
  assert.equal(match.completed.id,'ours');
  assert.deepEqual(match.entries,[]);
});
test('a delayed first baseline forwards replies since local selection exactly once',()=>{
  const c=chat([node('old',null,'assistant',{create_time:2,end_turn:true}),
    node('user','old','user'),node('new','user','assistant',{end_turn:true})]);
  assert.equal(baselineCursor(c,9000),'old');
  assert.equal(baselineCursor(c,20000),'new');
  assert.equal(baselineCursor(c,1000),'');
  const entries=outgoingPage(c,baselineCursor(c,9000),9000).entries;
  assert.deepEqual(entries.filter(e=>e.text).map(e=>e.text),['new']);
  assert.deepEqual(outgoingPage(c,entries.at(-1).id,9000).entries,[]);
});
test('never relays previous conversation history',()=>{
  const c=chat([node('old',null,'assistant',{end_turn:true,channel:'final'}),node('u','old','user'),node('new','u','assistant',{end_turn:true,channel:'final'})]);
  assert.deepEqual(outgoingPage(c,'u',9000).entries.map(x=>x.text),['new']);
});
test('only completed final text, never analysis, tools or reasoning recap',()=>{
  const c=chat([node('u',null,'user'),node('thought','u','assistant',{channel:'analysis',end_turn:true}),
    node('tool','thought','tool'),node('recap','tool','assistant',{end_turn:true,content:{content_type:'reasoning_recap',parts:['secret']}}),
    node('final','recap','assistant',{end_turn:true,channel:'final'})]);
  assert.deepEqual(outgoingPage(c,'u',9000).entries.filter(x=>x.text).map(x=>[x.text,x.user_id]),[['final','u']]);
});
test('streaming node is not advanced past before completion',()=>{
  const c=chat([node('u',null,'user'),node('partial','u','assistant',{status:'in_progress',channel:'final',end_turn:false})]);
  assert.equal(outgoingPage(c,'u',9000).entries.length,0);
  Object.assign(c.mapping.partial.message,{status:'finished_successfully',end_turn:true});
  assert.equal(outgoingPage(c,'u',9000).entries[0].text,'partial');
});
test('a completed final behind the cursor reconciles only the pending turn without replaying history',()=>{
  const c=chat([node('u',null,'user'),node('final','u','assistant',{channel:'final',end_turn:true}),
    node('hidden','final','assistant',{end_turn:true,metadata:{is_visually_hidden_from_conversation:true}})]);
  const page=outgoingPage(c,'hidden',9000,undefined,'u');
  assert.deepEqual(page.entries,[]);
  assert.equal(page.completed.id,'final');assert.equal(page.completed.user_id,'u');
  assert.equal(outgoingPage(c,'hidden',9000).completed,undefined);
  assert.equal(outgoingPage(c,'hidden',9000,undefined,'wrong').completed,undefined);
  assert.equal(outgoingPage(c,'hidden',11000,undefined,'u').completed,undefined);
  c.mapping.final.message.metadata={is_complete:false};
  assert.equal(outgoingPage(c,'hidden',9000,undefined,'u').completed,undefined);
});
test('branch changes keep time fence and selected branch only',()=>{
  const c=chat([node('old',null,'assistant',{create_time:1,end_turn:true,channel:'final'}),node('u','old','user'),
    node('new','u','assistant',{end_turn:true,channel:'final'})]);
  c.mapping.abandoned=node('abandoned','old','assistant',{end_turn:true,channel:'final'});
  assert.deepEqual(outgoingPage(c,'missing',9000).entries.filter(x=>x.text).map(x=>x.text),['new']);
});
test('a single snapshot can acknowledge an exact turn beyond a full or stalled page',()=>{
  const nodes=[node('base',null,'user')];
  for(let i=0;i<20;i++) nodes.push(node('a'+i,nodes.at(-1).id,'assistant',{end_turn:true}));
  nodes.push(node('u',nodes.at(-1).id,'user'),node('reply','u','assistant',{end_turn:true}));
  const c=chat(nodes);
  const full=outgoingPage(c,'base',9000,null,'u');
  assert.equal(full.entries.length,10);
  assert.equal(full.completed.text,'reply');
  c.mapping.a0.message.status='in_progress';
  const stalled=outgoingPage(c,'base',9000,null,'u');
  assert.equal(stalled.entries.length,0);
  assert.equal(stalled.completed.id,'reply');
  assert.equal(outgoingPage(c,'u',9000,null,'u').completed,undefined);
  assert.equal(outgoingPage(c,'base',9000,null,'someone-else').completed,undefined);
});
test('a long sequence of invisible history advances in one read and keeps the exact cursor',()=>{
  const nodes=[node('base',null,'user')];
  for(let i=0;i<3000;i++) nodes.push(node('old'+i,nodes.at(-1).id,'assistant',{create_time:1,end_turn:true}));
  nodes.push(node('u',nodes.at(-1).id,'user'),node('reply','u','assistant',{end_turn:true}));
  const c=chat(nodes);
  c.mapping.old1500.message.status='in_progress';
  const result=outgoingPage(c,'base',9000,null,'u');
  assert.deepEqual(result.entries.map(e=>e.id),['u','reply']);
  assert.equal(result.completed,undefined);
  assert.deepEqual(outgoingPage(c,'base',9000).entries.map(e=>e.id),['u','reply']);
});
test('cancelled and tool-directed assistants cannot become a reply',()=>{
  const c=chat([node('u',null,'user'),node('cancel','u','assistant',{end_turn:true,channel:'final',status:'cancelled'}),
    node('code','cancel','assistant',{end_turn:true,channel:'final',recipient:'python'})]);
  assert.equal(outgoingPage(c,'u',9000).entries.filter(x=>x.text).length,0);
});

test('old finals, hidden fragments and reasoning cannot trigger empty completion',()=>{
  const c=chat([node('old',null,'assistant',{create_time:1,end_turn:true}),node('u','old','user'),
    node('hidden','u','assistant',{end_turn:true,metadata:{is_visually_hidden_from_conversation:true}}),
    node('recap','hidden','assistant',{end_turn:true,content:{content_type:'reasoning_recap'}})]);
  const entries=outgoingPage(c,'removed-cursor',9000).entries;
  assert.equal(entries.some(e=>e.finished_turn||e.text),false);
});
test('not-yet-complete final content is not forwarded or consumed',()=>{
  const c=chat([node('u',null,'user'),node('partial','u','assistant',{end_turn:true,metadata:{is_complete:false}})]);
  assert.deepEqual(outgoingPage(c,'u',9000).entries,[]);
});

const TARGET='11111111-1111-4111-8111-111111111111',ORIGIN='22222222-2222-4222-8222-222222222222';
const BASE='33333333-3333-4333-8333-333333333333',USER='44444444-4444-4444-8444-444444444444';
const REQUEST='55555555-5555-4555-8555-555555555555';
const webchat=nodes=>({...chat(nodes),conversation_id:TARGET});
const before=()=>webchat([node(BASE,null,'user',{content:{content_type:'text',parts:['OLD']}})]);
const after=()=>webchat([before().mapping[BASE],node(USER,BASE,'user',{create_time:100,content:{content_type:'text',parts:['PROMPT']}})]);
function fixture(responses,{writeThrows=false,nativeTitle}={}) {
  let reads=0,writes=0;
  const deps={now:()=>100000,connect:async()=>async()=>{
    const result=responses[reads++];if(result instanceof Error)throw result;
    if(result?.http)return {ok:false,status:result.http,headers:{get:()=>result.retry??null}};
    return {ok:true,json:async()=>result};
  },callTool:async(name)=>{
    if(name==='send_message_to_thread'){writes++;if(writeThrows)throw Error('private error text must not escape');}
    const value=name==='read_thread'?{thread:{id:TARGET,kind:'chatgpt',title:nativeTitle,status:{type:'idle'}}}:{threadId:TARGET};
    return {success:true,contentItems:[{type:'inputText',text:JSON.stringify(value)}]};
  }};
  return {deps,counts:()=>({reads,writes})};
}
const input=()=>({operation:'post',target:TARGET,origin_thread:ORIGIN,request_id:REQUEST,text:'PROMPT'});
test('a direct selection uses the web title and falls back to the app title when the web title is blank',async()=>{
  for (const [webTitle, expected] of [['组织部','组织部'], ['  ','New chat'], [undefined,'New chat']]) {
    const f=fixture([{...before(),title:webTitle}],{nativeTitle:'New chat'});
    const reply=await run({operation:'baseline',target:TARGET,origin_thread:ORIGIN},'unused',f.deps);
    assert.equal(reply.title,expected);
    assert.deepEqual(f.counts(),{reads:1,writes:0});
  }
});
test('one write accepts an immediately visible exact user message',async()=>{
  const f=fixture([before(),after()]);const result=await run(input(),'unused',f.deps);
  assert.deepEqual(result,{status:'accepted',message_id:USER});assert.equal(f.counts().writes,1);
});
test('delayed readback becomes read-only confirmation, never a retry burst',async()=>{
  const f=fixture([before(),before()]);const result=await run(input(),'unused',f.deps);
  assert.equal(result.status,'confirming');assert.equal(result.acknowledged,true);
  assert.deepEqual(f.counts(),{reads:2,writes:1});
  assert.deepEqual(confirmReceipt(after(),result.receipt),{status:'accepted',message_id:USER});
});
test('HTTP 429 before a write is explicitly not dispatched',async()=>{
  const f=fixture([{http:429,retry:'90'}]);const result=await run(input(),'unused',f.deps);
  assert.equal(result.status,'not_dispatched');assert.equal(result.http_status,429);assert.equal(result.retry_after,90);
  assert.equal(f.counts().writes,0);
});
test('slow conversation reads get a larger bounded budget; a timeout before writing is safe',async()=>{
  const f=fixture([]); let timeout;
  f.deps.connect=async()=>async(_path,opts)=>{
    timeout=opts.timeout;
    throw new DOMException('timeout','TimeoutError');
  };
  const r=await run({...input(),budget_ms:14000},'unused',f.deps);
  assert.ok(timeout>5000 && timeout<=12800);
  assert.equal(r.status,'not_dispatched');
  assert.equal(r.reason,'web_chat_read_timeout');
  assert.equal(f.counts().writes,0);
});
test('HTTP 429 after a write carries read-only receipt and Retry-After',async()=>{
  const f=fixture([before(),{http:429,retry:'75'}]);const result=await run(input(),'unused',f.deps);
  assert.equal(result.status,'confirming');assert.equal(result.retry_after,75);assert.equal(f.counts().writes,1);
  assert.equal(confirmReceipt(after(),result.receipt).status,'accepted');
});
test('RPC timeout is never permission to retry a write',async()=>{
  const f=fixture([before(),after()],{writeThrows:true});const result=await run(input(),'unused',f.deps);
  assert.equal(result.status,'accepted');assert.equal(f.counts().writes,1);
});
test('old identical input cannot confirm a new submission; ambiguity stays explicit',()=>{
  const old=after();const receipt=makeReceipt(old,'PROMPT',100000);
  assert.equal(confirmReceipt(old,receipt).status,'pending');
  old.mapping[REQUEST]=node(REQUEST,USER,'user',{create_time:101,content:{content_type:'text',parts:['PROMPT']}});
  assert.equal(confirmReceipt(old,receipt).message_id,REQUEST);
  old.mapping[ORIGIN]=node(ORIGIN,USER,'user',{create_time:101,content:{content_type:'text',parts:['PROMPT']}});
  assert.equal(confirmReceipt(old,receipt).status,'ambiguous');
});
test('a branch change still confirms a submitted user node without sending it again',()=>{
  const c=after();c.current_node=BASE;
  const receipt=makeReceipt(before(),'PROMPT',100000);
  assert.equal(confirmReceipt(c,receipt).message_id,USER);
});
test('ordinary conversation text containing a rate-limit phrase is still ordinary text',async()=>{
  const f=fixture([before(),after()]);const native=f.deps.callTool;
  f.deps.callTool=async(...args)=>{
    const result=await native(...args);
    if(args[0]==='read_thread'){
      const data=JSON.parse(result.contentItems[0].text);data.thread.preview='Please explain Too many requests';
      result.contentItems[0].text=JSON.stringify(data);
    }
    return result;
  };
  assert.equal((await run(input(),'unused',f.deps)).status,'accepted');
});
