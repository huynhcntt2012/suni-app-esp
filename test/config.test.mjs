import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';

test('Portions, configuration acknowledgement, failed storage and command snapshots',async t=>{
  let clock=Date.parse('2026-10-04T00:00:00Z');
  const app=createApp({dbPath:':memory:',now:()=>clock});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>app.server.close(r));app.close();});
  const base=`http://127.0.0.1:${app.server.address().port}/api`;
  let cookie;
  async function request(route,method='GET',body,deviceToken){
    const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-Requested-With':'PawMeal',...(cookie?{Cookie:cookie}:{}),...(deviceToken?{Authorization:'Bearer '+deviceToken}:{})},...(body?{body:JSON.stringify(body)}:{})});
    if(r.headers.has('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
    return {status:r.status,body:await r.json()};
  }
  await request('/register','POST',{email:'config@example.invalid',password:'local-test-password'});
  const {body:d}=await request('/devices','POST',{name:'Config test'});
  const p=`/devices/${d.id}`;let cached=null;
  const poll=async(body)=>{const r=await request('/device/poll','POST',body??{protocol:4,applied_config:cached},d.token);if(r.body.config)cached=r.body.config;return r;};
  const device=async()=>(await request('/state')).body.devices[0];
  assert.equal((await request(p+'/feed','POST')).status,409,'old firmware cannot feed');
  const legacy=(await poll({protocol:2})).body;assert.equal(legacy.command,null);assert.equal(legacy.config,null);
  const initial=(await poll()).body;
  assert.equal(initial.config.servo_mode,'timed_sweep');
  assert.equal(initial.config.closed_angle,0);
  assert.equal(initial.config.open_angle,360);
  assert.equal(initial.config.move_ms,500);
  assert.equal(initial.command,null,'saving config must not feed');
  assert.equal((await request(p+'/feed','POST')).status,409,'config must be acknowledged before feeding');
  assert.equal(initial.config.portions,1);
  assert.equal((await device()).config_synced,false,'delivery alone is not an ACK');
  await poll({protocol:4,applied_config:initial.config});
  assert.equal((await device()).config_synced,true);
  const settings={name:'Config test',portions:3,portion_ms:500,closed_angle:60,open_angle:110,move_ms:700};
  for(const bad of [{portions:0},{portions:1.5},{portions:21},{portion_ms:199},{portion_ms:10001},{portions:20,portion_ms:10000},{closed_angle:110},{open_angle:361},{move_ms:199},{portion_ms:500.5}]) {
    assert.equal((await request(p,'PATCH',{...settings,...bad})).status,400);
  }
  await request(p+'/feed','POST');
  assert.equal((await request(p,'PATCH',settings)).status,200);
  assert.equal((await device()).config_synced,false);
  assert.equal((await request('/state')).body.events[0].status,'cancelled','old queued command cancelled on edit');
  const updated=(await poll({protocol:4,applied_config:initial.config})).body;
  assert.equal(updated.command,null,'configuration sync does not rotate servo');
  assert.equal(updated.config.run_ms,1500);
  assert.equal(updated.config.portions,3);
  assert.equal(updated.config.portion_ms,500);
  assert.equal(updated.config.version,2);
  assert.equal((await device()).config_synced,false,'stale revision cannot acknowledge new config');
  await poll({protocol:4,applied_config:{...updated.config,portions:2}});
  assert.equal((await device()).config_synced,false,'wrong content cannot acknowledge matching version');
  await poll({protocol:4,applied_config:updated.config,config_error:'storage'});
  assert.equal((await device()).config_error,'storage');
  assert.equal((await device()).config_synced,false);
  await poll({protocol:4,applied_config:updated.config});
  assert.equal((await device()).config_synced,true);
  assert.equal((await device()).config_error,null);
  const unchanged=await request(p,'PATCH',{...settings,name:'Renamed'});
  assert.equal(unchanged.body.config_version,2);
  assert.equal(unchanged.body.config_synced,true,'renaming does not invalidate settings');
  clock+=11000;
  await request(p+'/feed','POST');
  const oldFirmware=(await poll({protocol:3,applied_config:updated.config})).body;
  assert.equal(oldFirmware.command,null,'protocol 3 cannot drain a queued timed-sweep command');
  assert.equal(oldFirmware.config,null);
  const command=(await poll({protocol:4,applied_config:updated.config})).body.command;
  assert.equal(command.run_ms,1500);assert.equal(command.portions,3);assert.equal(command.portion_ms,500);
  await request(p,'PATCH',{...settings,portions:2});
  const snapshot=(await request('/state')).body.events[0];
  assert.equal(snapshot.status,'delivered');assert.equal(snapshot.run_ms,1500);assert.equal(snapshot.portions,3);
  await request('/device/ack','POST',{id:command.id,status:'completed'},d.token);
  clock+=60000;
  await request(p+'/schedules','POST',{time:'07:01',days:[0]});
  await poll();await poll();app.tick();
  const scheduled=(await poll()).body.command;
  assert.equal(scheduled.run_ms,1000);assert.equal(scheduled.portions,2,'schedule uses newly saved portions');
  await poll({});
  assert.equal((await device()).firmware_protocol,1);
  assert.equal((await device()).config_synced,false,'legacy firmware is not reported as synced');
  // Independent accounts cannot change config or observe it through the device API.
  await request('/register','POST',{email:'other@example.invalid',password:'other-test-password'});
  assert.equal((await request(p,'PATCH',settings)).status,404);
  assert.equal((await request('/device/poll','POST',{protocol:4},'wrong-token')).status,401);
});

test('10-second sweep command is finite, acknowledged once, and retains tested endpoints',async t=>{
  const app=createApp({dbPath:':memory:'});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>app.server.close(r));app.close();});
  const base=`http://127.0.0.1:${app.server.address().port}/api`;
  let cookie='',token='';
  async function call(route,body,method='POST',device=false){
    const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json','X-Requested-With':'PawMeal',Cookie:cookie,...(device?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});
    if(r.headers.has('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
    assert.ok(r.status===200||r.status===201,`${route}: HTTP ${r.status}`);return r.json();
  }
  await call('/register',{email:'timed@example.invalid',password:'test-timed-sweep'});
  const d=await call('/devices',{name:'Timed sweep'});token=d.token;
  await call(`/devices/${d.id}`,{name:'Timed sweep',portions:1,portion_ms:10000,closed_angle:0,open_angle:360,move_ms:500},'PATCH');
  const {config}=await call('/device/poll',{protocol:4},'POST',true);
  await call('/device/poll',{protocol:4,applied_config:config},'POST',true);
  await call(`/devices/${d.id}/feed`,{});
  const {command}=await call('/device/poll',{protocol:4,applied_config:config},'POST',true);
  assert.equal(command.run_ms,10000);assert.equal(command.servo_mode,'timed_sweep');
  assert.equal(command.closed_angle,0);assert.equal(command.open_angle,360);assert.equal(command.move_ms,500);
  assert.equal((await call('/device/poll',{protocol:4,applied_config:config},'POST',true)).command,null);
  await call('/device/ack',{id:command.id,status:'completed'},'POST',true);
  assert.equal((await call('/state',null,'GET')).events[0].status,'completed');
});

test('Existing database migration preserves feeding duration and survives restart',async t=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'pawmeal-migration-')), dbPath=path.join(dir,'test.sqlite');
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const db=new DatabaseSync(dbPath), secret='migration-device-token';
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT UNIQUE,password TEXT,salt TEXT);
    CREATE TABLE devices(id INTEGER PRIMARY KEY,user_id INTEGER,name TEXT,token TEXT,last_seen INTEGER,run_ms INTEGER,stop_us INTEGER,run_us INTEGER);
    INSERT INTO users VALUES(1,'test@example.invalid','unused','unused');`);
  db.prepare('INSERT INTO devices VALUES(1,1,?,?,?,?,?,?)').run('Existing',createHash('sha256').update(secret).digest('hex'),null,725,1495,1750);
  db.close();
  for(let round=0;round<2;round++){
    const app=createApp({dbPath});
    try{
      await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
      const r=await fetch(`http://127.0.0.1:${app.server.address().port}/api/device/poll`,{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:'{"protocol":4}'});
      const {config}=await r.json();
      assert.deepEqual(config,{version:3,servo_mode:'timed_sweep',portions:1,portion_ms:725,run_ms:725,closed_angle:0,open_angle:360,move_ms:500});
    }finally{await new Promise(r=>app.server.close(r));app.close();}
  }
});
