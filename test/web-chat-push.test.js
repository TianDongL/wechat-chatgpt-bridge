import test from "node:test";
import assert from "node:assert/strict";
import { Bridge, digest, initialState } from "../src/bridge.js";
import { NativeProvider } from "../src/native-provider.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const U = "33333333-3333-4333-8333-333333333333";
const F = "44444444-4444-4444-8444-444444444444";
const url = (id) => "https://chatgpt.com/c/" + id;
const credentials = { botId:"fixture-bot", ownerId:"fixture-owner", token:"SYNTHETIC-WECHAT-TOKEN" };

function fixture() {
  let now = 1800000000000, sequence = 0;
  let saved = { ...initialState(), selected:url(A), defaultSelected:url(A) };
  let list = [{id:B, title:"Second"}];
  let post = {status:"accepted", message_id:U};
  let page = {status:"page", entries:[], start_cursor:"baseline", start_anchor:"visible-user"};
  const requests = [], sends = [], sockets = [], dotEntries = [], replies = new Map();
  const store = {
    read: () => structuredClone(saved),
    write: (_, value) => { saved = structuredClone(value); },
    saveReply: (key, text) => replies.set(key, text),
  };
  const provider = new NativeProvider({
    now: () => now,
    settings:{defaultUrl:url(A), accountHash:digest("fixture-account"), dot:{}, executable:"fixture"},
    resolve: () => "fixture",
    listen: (_, emit) => {
      const socket = {
        closed:false, selection:null, emit,
        select: (value) => { socket.selection = value; return true; },
        close: () => { socket.closed = true; },
      };
      sockets.push(socket);
      return socket;
    },
    transport: async (input) => {
      requests.push(structuredClone(input));
      if (input.operation === "list") return {status:"list", items:list};
      if (input.operation === "baseline") return {status:"ready", cursor:"baseline", branch_anchor:"visible-user", title:"Fresh web title"};
      if (input.operation === "post") return structuredClone(post);
      if (input.operation === "outbox") return structuredClone(page);
      throw Error("unexpected operation");
    },
  });
  provider.dotCall = async (operation) => operation === "baseline"
    ? {status:"ready", cursor:"dot-baseline"}
    : {status:"page", entries:dotEntries};
  const make = () => new Bridge({
    store, provider, credentials, wechat:{sendText:async (value) => sends.push(value)},
    since:now - 1000, now:() => now,
  });
  const bridge = make();
  const input = async (text, active = bridge) => {
    await active.ingest({
      get_updates_buf:"fixture-cursor-" + (++sequence),
      msgs:[{from_user_id:credentials.ownerId, to_user_id:credentials.botId,
        message_id:String(sequence), message_type:1, message_state:2, create_time_ms:now,
        context_token:"SYNTHETIC-CONTEXT", item_list:[{type:1,text_item:{text}}]}],
    });
    await active.drain();
  };
  const advance = (ms) => { now += ms; };
  const step = async (ms = 0, active = bridge) => { advance(ms); await active.pollWeb(); };
  const ready = async (active = bridge) => {
    await active.pollWeb();
    sockets.at(-1).emit({kind:"ready"});
    await active.pollWeb();
    await step(600, active);
  };
  const signal = () => sockets.at(-1).emit({kind:"update",...sockets.at(-1).selection});
  const final = () => {
    page = {status:"page", entries:[],
      completed:{id:F,user_id:U,text:"EXACT FINAL\r\n\n<div>original</div>  ",finished_turn:true}};
  };
  return { bridge, provider, requests, sends, sockets, dotEntries, replies, input, ready, step, advance,
    signal, final, make, store, disk:() => structuredClone(saved),
    page:(value) => {page=value;}, post:(value) => {post=value;}, list:(value) => {list=value;} };
}

test("numbered selection, immediate first prompt, independent Dot, one exact final and idle return", async () => {
  const f = fixture();
  await f.bridge.initialize();
  await f.input("/list");
  const before = f.requests.length;
  await f.input("/cd 1");
  assert.equal(f.requests.length,before);
  await f.input("first on B");
  assert.deepEqual(f.requests.slice(before).map(r=>[r.operation,r.target]),[["post",B]]);
  await f.ready();
  f.dotEntries.push({id:"reminder",text:"DOT REMINDER"});
  await f.bridge.pollDot();
  await f.bridge.flushOutgoing();
  assert.equal(f.sends.at(-1).text,"【Dot】\nDOT REMINDER");
  f.final();
  for (let i=0;i<5;i++) f.signal();
  await f.step();
  await f.step(3000);
  await f.bridge.flushOutgoing();
  assert.equal(f.bridge.webPending(),undefined);
  assert.equal(f.sends.filter(r=>r.text.startsWith("EXACT FINAL")).length,1);
  assert.equal(f.bridge.state.watch.branchAnchor,F);
  assert.equal(f.bridge.state.watch.baselineAnchor,false);
  assert.equal(f.bridge.status().autoDotInSeconds,600);
  f.signal(); await f.step(); await f.step(3000); await f.bridge.flushOutgoing();
  assert.equal(f.sends.filter(r=>r.text.startsWith("EXACT FINAL")).length,1);
  f.advance(596999);
  await f.bridge.ingest({msgs:[],get_updates_buf:"idle"});
  assert.equal(f.bridge.state.selected,url(B));
  f.advance(1);
  await f.bridge.ingest({msgs:[],get_updates_buf:"return"});
  await f.bridge.flushOutgoing();
  assert.equal(f.bridge.state.selected,"dot");
  assert.equal(f.provider.push.status().state,"off");
  assert.equal(f.sockets[0].closed,true);
  assert.equal(f.sends.filter(r=>r.text.includes("已自动切回")).length,1);
});

test("healthy idle makes no history requests; switches reuse the socket and ignore obsolete events", async () => {
  const f = fixture();
  await f.bridge.initialize(); await f.ready();
  const n=f.requests.length;
  for(let i=0;i<20;i++) await f.step(60000);
  assert.equal(f.requests.length,n);
  await f.bridge.command({name:"list"});
  await f.bridge.command({name:"switch",argument:"1"});
  const old=f.sockets[0].selection;
  await f.step(); await f.step(600);
  assert.equal(f.sockets.length,1);
  assert.equal(f.provider.push.status().connections,1);
  const count=f.requests.length;
  f.sockets[0].emit({kind:"update",target:A,generation:old.generation-1});
  await f.step(10000);
  assert.equal(f.requests.length,count);
  await f.bridge.command({name:"switch",argument:"dot"});
  assert.equal(f.sockets[0].closed,true);
  await f.step(100000);
  assert.equal(f.requests.length,count);
});

test("socket 429 blocks reads, posts and reconnection until its shared cooldown ends", async () => {
  const f=fixture(); await f.bridge.initialize(); await f.step();
  f.sockets[0].emit({kind:"limited",seconds:75});
  await f.step(); await f.input("wait here");
  await f.step(74000); await f.bridge.drain();
  assert.equal(f.requests.length,0); assert.equal(f.sockets.length,1);
  await f.step(1000); await f.bridge.drain();
  assert.equal(f.sockets.length,2);
  assert.equal(f.requests.filter(r=>r.operation==="post").length,1);
  assert.equal(f.requests.find(r=>r.operation==="post").target,A);
});

test("lost completion wakes through the pending watchdog and reconnect performs one catchup", async () => {
  const f=fixture(); await f.bridge.initialize(); await f.ready(); await f.input("one");
  const reads=f.requests.filter(r=>r.operation==="outbox").length;
  f.final(); await f.step(89999);
  assert.equal(f.requests.filter(r=>r.operation==="outbox").length,reads);
  await f.step(1); await f.bridge.flushOutgoing();
  assert.equal(f.sends.filter(r=>r.text.startsWith("EXACT FINAL")).length,1);
  f.sockets[0].emit({kind:"offline"}); await f.step(4999);
  assert.equal(f.sockets.length,1);
  await f.step(1); assert.equal(f.sockets.length,2);
  f.sockets[1].emit({kind:"ready"}); await f.step(); await f.step(600);
  assert.equal(f.sends.filter(r=>r.text.startsWith("EXACT FINAL")).length,1);
  await f.provider.close();
  f.sockets[1].emit({kind:"update",...f.sockets[1].selection});
  assert.equal(f.provider.push.status().state,"off");
});

test("late confirmation survives restart and fetches only its exact reply without a second write", async () => {
  const f=fixture(); await f.bridge.initialize(); await f.ready();
  f.post({status:"confirming",receipt:{content_hash:"a".repeat(64),excluded_ids:[],not_before_ms:0}});
  await f.input("write once"); f.advance(90001); await f.bridge.drain();
  assert.equal(f.bridge.webPending(),undefined);
  const next=f.make(); await next.initialize();
  f.page({status:"page",entries:[{id:"wrong",user_id:B,text:"WRONG",finished_turn:true}],
    confirmation:{status:"accepted",message_id:U},completed:{id:F,user_id:U,text:"LATE EXACT",finished_turn:true}});
  await f.ready(next); await next.flushOutgoing();
  assert.equal(f.requests.filter(r=>r.operation==="post").length,1);
  assert.equal(f.sends.filter(x=>x.text==="LATE EXACT").length,1);
  assert.equal(f.sends.some(x=>x.text==="WRONG"),false);
});

test("renamed list updates same-target cd and where without resetting a pending turn", async () => {
  const f=fixture(); await f.bridge.initialize(); await f.ready(); await f.input("pending");
  f.list([{id:B,title:"old"}, {id:A,title:"Renamed"}]);
  const watch=structuredClone(f.bridge.state.watch),generation=f.bridge.generation;
  await f.bridge.command({name:"list"});
  const count=f.requests.length;
  assert.match(await f.bridge.command({name:"switch",argument:"2"}),/Renamed/);
  assert.match(await f.bridge.command({name:"where"}),/Renamed/);
  assert.equal(f.requests.length,count);
  assert.deepEqual(f.bridge.state.watch,watch);
  assert.equal(f.bridge.generation,generation);
  assert.equal(f.bridge.webPending().messageId,U);
  assert.equal(f.make().state.selectedTitle,"Renamed");
});

test("upgrade fixes the cached title and preserves delivered branch protection", async () => {
  const f=fixture();
  const old=f.disk();
  old.selectedTitle="New chat"; old.listed=[{url:url(A),title:"Renamed"}]; delete old.titleSync;
  old.watch={url:url(A),cursor:F,openedAt:1800000000000};
  old.records[digest("output:"+url(A)+":"+F)]={kind:"outbox",status:"delivery_uncertain",at:1800000000000};
  f.store.write("state.json",old);
  const next=f.make();
  assert.equal(next.state.selectedTitle,"Renamed");
  assert.equal(next.state.watch.branchAnchor,F);
  assert.equal(next.state.watch.baselineAnchor,false);
  const updated=f.disk();updated.selectedTitle="Newer direct title";
  f.store.write("state.json",updated);
  assert.equal(f.make().state.selectedTitle,"Newer direct title");
});

test("an ambiguous pending turn is recorded once and never forwarded from another branch", async () => {
  const f=fixture(); await f.bridge.initialize(); await f.ready(); await f.input("ask");
  f.page({status:"page",entries:[{id:"wrong",text:"WRONG",finished_turn:true}],ambiguous_turn:true});
  f.signal(); await f.step(); await f.step(3000); await f.bridge.flushOutgoing();
  assert.equal(f.bridge.webPending(),undefined);
  assert.match(f.bridge.state.watch.branchAnchor,/^ambiguous:/);
  assert.equal(f.sends.some(x=>x.text==="WRONG"),false);
  assert.equal(f.sends.filter(x=>x.text.includes("多个版本")).length,1);
});

test("native signing keeps the account binding and receives no signed URL on rejection", async () => {
  let requested=0;
  const wrong=async()=>{requested++;return {ok:true};}; wrong.accountId="unexpected";
  const p=new NativeProvider({
    settings:{defaultUrl:url(A),accountHash:digest("expected"),executable:"fixture"},
    resolve:()=>"fixture",connect:async()=>wrong,
  });
  p.push.select(url(A),0); p.push.tick();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requested,0);
  assert.equal(p.push.status().state,"backoff");
  await p.close();
});
