const {test} = require("node:test");
const assert = require("node:assert/strict");
const {listener, completedConversation, retrySeconds} = require("../src/native/web_chat_push.cjs");
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const tick = () => new Promise(r => setImmediate(r));

function setup(reply) {
  const events = [], sockets = [];
  let requests = 0;
  class FakeSocket extends EventTarget {
    constructor(url) { super(); this.readyState = 0; this.url = url; sockets.push(this); }
    send(value) { this.commands = JSON.parse(value); }
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
    message(rows) { this.dispatchEvent(new MessageEvent("message", {data:JSON.stringify(rows)})); }
  }
  const watch = listener("unused", e => events.push(e), {Socket:FakeSocket,
    getConnection:async () => async (path) => {
      assert.equal(path,"/celsius/ws/user");
      requests++;
      return reply || {ok:true,json:async()=>({websocket_url:"wss://ws.chatgpt.com/example?private=fixture"})};
    }});
  return {watch, events, sockets, calls:()=>requests};
}
const envelope = id => ({type:"message",topic_id:"conversations",
  payload:{type:"conversation-turn-complete",payload:{conversation_id:id}}});

test("one socket for web A and B, and only matching events reach the parent", async () => {
  const f = setup();
  f.watch.select({target:A,generation:1}); await tick();
  const ws=f.sockets[0]; ws.readyState=1; ws.dispatchEvent(new Event("open"));
  assert.deepEqual(ws.commands.map(m=>m.command.type),["connect","subscribe","subscribe"]);
  ws.message([{id:1,reply:{type:"connect"}},{id:2,reply:{type:"subscribe",topic_id:"conversations"}}]);
  assert.equal(f.events.length,0);
  ws.message([{id:3,reply:{type:"subscribe",topic_id:"alder-conversations"}}]);
  ws.message([envelope(B),envelope(A)]);
  f.watch.select({target:B,generation:2});
  ws.message([envelope(A),envelope(B)]);
  assert.equal(f.calls(),1);
  assert.deepEqual(f.events,[{kind:"ready"},{kind:"update",target:A,generation:1},{kind:"update",target:B,generation:2}]);
  f.watch.close(); ws.message([envelope(B)]);
  assert.equal(f.events.length,3);
  assert.equal(ws.readyState,3);
  assert.doesNotMatch(JSON.stringify(f.events),/private|fixture/);
});

test("ignores drafts, partials, hidden messages and other update types",()=>{
  const message={author:{role:"assistant"},end_turn:true,status:"finished_successfully",channel:"final"};
  const wrap=m=>({type:"conversation-history-update",payload:{conversation_id:A,update_type:"add-messages",messages:[m]}});
  assert.equal(completedConversation(wrap(message)),A);
  for(const change of [{end_turn:false},{channel:"analysis"},{metadata:{is_complete:false}},
    {metadata:{is_visually_hidden_from_conversation:true}},{recipient:"tool"},{author:{role:"user"}}])
    assert.equal(completedConversation(wrap({...message,...change})),null);
  assert.equal(completedConversation({type:"conversation-created",payload:{conversation_id:A}}),null);
});

test("signed endpoint throttling and invalid origins never create a socket",async()=>{
  const f=setup({ok:false,status:429,headers:{get:()=>"145"}});
  f.watch.select({target:A,generation:0}); await tick();
  assert.deepEqual(f.events,[{kind:"limited",seconds:145}]); assert.equal(f.sockets.length,0);
  const wrong=setup({ok:true,json:async()=>({websocket_url:"wss://example.org/socket"})});
  wrong.watch.select({target:A,generation:0}); await tick();
  assert.deepEqual(wrong.events,[{kind:"offline"}]); assert.equal(wrong.sockets.length,0);
  assert.equal(retrySeconds(null),60);
});

test("closing while signing prevents opening a late socket", async()=>{
  const f=setup();
  f.watch.select({target:A,generation:5}); f.watch.close(); await tick();
  assert.equal(f.calls(),0); assert.equal(f.sockets.length,0);
});
