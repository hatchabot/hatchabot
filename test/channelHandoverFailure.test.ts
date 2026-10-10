import {it,expect,vi} from 'vitest';
import {makeWorld,seedRunningAgent,as} from './support/world.js';
it.each(['discord','slack'] as const)('%s detach retains credentials and supports retry when stop fails',async kind=>{
 const w=await makeWorld();
 const id=await seedRunningAgent(w,{name:'Fixture',slug:'fixture',accountId:'fixturebot',botToken:'fixture-value'});
 const ref=w.store.getAgent(id)!.runtimeRef!;
 const secretRef=`fixture/${kind}`;
 await w.secrets.put(secretRef,JSON.stringify({botToken:'fixture-value',appToken:'fixture-app'}));
 w.store.insertChannel({id:`fixture-${kind}`,agentId:id,kind,accountId:'fixture-account',secretRef,deepLink:'https://example.org',createdAt:'now'});
 const stop=w.provider.stop.bind(w.provider);
 w.provider.stop=async()=>{throw new Error('fixture runner unreachable');};
 w.provider.provision=async()=>{throw new Error('fixture runner unreachable');};
 const spy=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>new Response('{}'));
 try {
  const r=await w.f.inject({method:'DELETE',url:`/v1/agents/${id}/channels/${kind}`,headers:as()});
  expect(r.statusCode).toBe(409);
  expect(r.json().error).toMatch(/still connected/);
  expect(w.store.getChannelForAgent(id,kind)).toBeDefined();
  expect(w.secrets.map.has(secretRef)).toBe(true);
  await new Promise(r=>setTimeout(r,20));
  expect(w.provider.runtimes.get(ref)!.phase).toBe('running');
  w.provider.stop=stop;
  expect((await w.f.inject({method:'DELETE',url:`/v1/agents/${id}/channels/${kind}`,headers:as()})).statusCode).toBe(202);
 } finally {spy.mockRestore();await w.f.close();}
});
