import {it,expect,vi} from 'vitest';
import {makeWorld,seedRunningAgent,as} from './support/world.js';
import {exportAgent,importAgent} from '../src/orchestrator/transfer.js';
import {migrateAgent} from '../src/orchestrator/migrate.js';
import {moveAgentToHost} from '../src/orchestrator/moveHost.js';
import {MockProvider} from '../src/providers/mockProvider.js';
it.each(['http://[::1]:9999','http://[::ffff:127.0.0.1]:9999','http://[fe80::1]:9999'])('peer URL rejects prohibited IPv6 address %s',async url=>{
 const w=await makeWorld(); const calls:string[]=[];
 const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async u=>{calls.push(String(u));return new Response('[]');});
 try {
  const r=await w.f.inject({method:'POST',url:'/v1/peers',headers:as('fixture-member'),payload:{name:'Fixture peer',url,token:'fixture-credential'}});
  expect(r.statusCode).toBe(400);
  expect(calls).toEqual([]);
 } finally {spy.mockRestore();await w.f.close();}
});
it('stale stopped record is quiesced before migration',async()=>{
 const src=await makeWorld(),dst=await makeWorld('fixture-destination');
 const id=await seedRunningAgent(src,{name:'Fixture',slug:'fixture',accountId:'fixturebot',botToken:'fixture-value'});
 const ref=src.store.getAgent(id)!.runtimeRef!;
 src.store.setAgentState(id,'STOPPED');
 await src.secrets.put('fixture-peer','fixture-credential');
 let targetRef='';
 const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async(u,init)=>{
  const path=new URL(String(u)).pathname;
  if(path.endsWith('/preflight'))return new Response(JSON.stringify({ok:true,reasons:[]}));
  if(path.endsWith('/restore')){
   const a=await importAgent({store:dst.store,secrets:dst.secrets,provider:dst.provider,channel:dst.channel,sleep:async()=>{}},Buffer.from(init!.body as Uint8Array),{ownerId:dst.owner});
   targetRef=a.runtimeRef!;return new Response(JSON.stringify(a));
  }
  throw new Error('unexpected fixture request');
 });
 try {
  await migrateAgent({store:src.store,secrets:src.secrets,provider:src.provider,channel:src.channel,sleep:async()=>{}},id,{id:'fixture-peer',name:'Fixture peer',url:'http://fixture.invalid',secretRef:'fixture-peer'});
  expect(src.store.getAgent(id)!.migratedTo).toBeTruthy();
  expect(await src.provider.status(ref)).toMatchObject({phase:'stopped'});
  expect(await dst.provider.status(targetRef)).toMatchObject({phase:'running'});
 } finally {spy.mockRestore();await src.f.close();await dst.f.close();}
});
it('host move quiesces a stale STOPPED record before snapshot',async()=>{
 const w=await makeWorld();const id=await seedRunningAgent(w,{name:'Fixture',slug:'fixture',accountId:'fixturebot',botToken:'fixture-value'});
 const ref=w.store.getAgent(id)!.runtimeRef!;w.store.setAgentState(id,'STOPPED');
 w.store.insertHost({id:'h2',ownerId:w.owner,kind:'cloud',provider:'mock',name:'Fixture runner',settings:{},createdAt:'now'});
 const target=new MockProvider();w.provider.daemonId=async()=> 'fixture-source';target.daemonId=async()=> 'fixture-target';
 let copiedRunning=false;const exp=w.provider.exportState.bind(w.provider);
 w.provider.exportState=async r=>{copiedRunning=(await w.provider.status(r)).phase==='running';return exp(r);};
 try {
  await moveAgentToHost({store:w.store,secrets:w.secrets,channel:w.channel,source:w.provider,target,sleep:async()=>{}},id,'h2');
  expect(copiedRunning).toBe(false);
  expect(await w.provider.status(ref)).toMatchObject({phase:'absent'});
 } finally {await w.f.close();}
});

it('failed destination cleanup holds a migration and keeps both identities until cleanup can be retried', async () => {
  const src = await makeWorld(), dst = await makeWorld('fixture-destination');
  const id = await seedRunningAgent(src, { name: 'Fixture', slug: 'fixture', accountId: 'fixturebot', botToken: 'fixture-value' });
  const ref = src.store.getAgent(id)!.runtimeRef!;
  await src.secrets.put('fixture-peer', 'fixture-credential');
  const start = dst.provider.start.bind(dst.provider), destroy = dst.provider.destroy.bind(dst.provider);
  dst.provider.start = async r => { await start(r); throw new Error('fixture lost start response'); };
  dst.provider.destroy = async () => { throw new Error('fixture cleanup unavailable'); };
  let receiptId = '', restoreCode = 0;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (u, init) => {
    const path = new URL(String(u)).pathname;
    if (path.endsWith('/preflight')) return new Response(JSON.stringify({ ok: true, reasons: [] }));
    if (path.endsWith('/restore')) {
      receiptId = new Headers(init!.headers).get('x-hatchabot-move')!;
      const response = await dst.f.inject({ method: 'POST', url: path, headers: { ...as(dst.owner), 'content-type': 'application/octet-stream', 'x-hatchabot-move': receiptId }, payload: Buffer.from(init!.body as Uint8Array) });
      restoreCode = response.statusCode;
      return new Response(response.body, { status: response.statusCode });
    }
    if (path.startsWith('/v1/moves/')) {
      const response = await dst.f.inject({ method: 'GET', url: path, headers: as(dst.owner) });
      return new Response(response.body, { status: response.statusCode });
    }
    throw new Error('unexpected fixture request');
  });
  try {
    await expect(migrateAgent({ store: src.store, secrets: src.secrets, provider: src.provider, channel: src.channel, sleep: async () => {} }, id,
      { id: 'fixture-peer', name: 'Fixture peer', url: 'http://fixture.invalid', secretRef: 'fixture-peer' })).rejects.toThrow();
    expect(restoreCode).toBe(503);
    expect(await src.provider.status(ref)).toMatchObject({ phase: 'stopped' });
    const pending = dst.store.listAllActiveAgents()[0]!;
    expect(pending).toBeDefined();
    expect(dst.store.getChannelForAgent(pending.id)).toBeDefined();
    expect(dst.provider.runtimes.get(pending.runtimeRef!)!.phase).toBe('running');
    const receipt = await dst.f.inject({ method: 'GET', url: `/v1/moves/${receiptId}`, headers: as(dst.owner) });
    expect(receipt.json().state).toBe('running');
    const op = dst.store.listOperations([pending.id])[0]!;
    expect(op.status).toBe('held');
    dst.provider.destroy = destroy;
    const retry = await dst.f.inject({ method: 'POST', url: `/v1/operations/${op.id}/recover`, headers: as(dst.owner), payload: { action: 'retry' } });
    expect(retry.statusCode).toBe(200);
    expect(dst.store.getAgent(pending.id)!.state).toBe('DELETED');
    expect(await dst.provider.status(pending.runtimeRef!)).toMatchObject({ phase: 'absent' });
    expect((await dst.f.inject({ method: 'GET', url: `/v1/moves/${receiptId}`, headers: as(dst.owner) })).json().state).toBe('failed');
  } finally { spy.mockRestore(); await src.f.close(); await dst.f.close(); }
});
