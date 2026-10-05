import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const derive = promisify(scrypt), root = path.dirname(fileURLToPath(import.meta.url));
const token = () => randomBytes(32).toString('hex');
const hash = s => createHash('sha256').update(s).digest('hex');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const integer = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

export function createApp({ dbPath = path.join(root, 'data', 'feeder.sqlite'), now = () => Date.now(), secure = process.env.COOKIE_SECURE === '1' } = {}) {
  if (dbPath !== ':memory:') mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,password TEXT NOT NULL,salt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),expires INTEGER);
    CREATE TABLE IF NOT EXISTS devices(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),name TEXT NOT NULL,token TEXT UNIQUE NOT NULL,last_seen INTEGER,run_ms INTEGER DEFAULT 1500,stop_us INTEGER DEFAULT 1500,run_us INTEGER DEFAULT 1700);
    CREATE TABLE IF NOT EXISTS schedules(id INTEGER PRIMARY KEY,device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,time TEXT NOT NULL,days TEXT NOT NULL,enabled INTEGER DEFAULT 1,UNIQUE(device_id,time));
    CREATE TABLE IF NOT EXISTS commands(id INTEGER PRIMARY KEY AUTOINCREMENT,device_id INTEGER REFERENCES devices(id) ON DELETE CASCADE,source TEXT,status TEXT,created INTEGER,expires INTEGER,finished INTEGER,run_ms INTEGER,stop_us INTEGER,run_us INTEGER,schedule_key TEXT UNIQUE);
  `);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  // Additive migration: preserve accounts, schedules and each existing run time.
  db.exec('BEGIN');
  try {
    const addColumn = (table, name, definition) => {
      if (all(`PRAGMA table_info(${table})`).some(c => c.name === name)) return false;
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`); return true;
    };
    addColumn('devices','portions','INTEGER NOT NULL DEFAULT 1');
    if (addColumn('devices','portion_ms','INTEGER NOT NULL DEFAULT 1500')) db.exec('UPDATE devices SET portion_ms=run_ms');
    addColumn('devices','config_version','INTEGER NOT NULL DEFAULT 1');
    addColumn('devices','applied_config_version','INTEGER NOT NULL DEFAULT 0');
    addColumn('devices','config_synced_at','INTEGER');
    addColumn('devices','config_error','TEXT');
    addColumn('devices','firmware_protocol','INTEGER NOT NULL DEFAULT 1');
    addColumn('commands','portions','INTEGER NOT NULL DEFAULT 1');
    if (addColumn('commands','portion_ms','INTEGER')) db.exec('UPDATE commands SET portion_ms=run_ms');
    addColumn('commands','config_version','INTEGER NOT NULL DEFAULT 0');
    const positionalMigration=addColumn('devices','servo_mode',"TEXT NOT NULL DEFAULT 'position180'");
    addColumn('devices','closed_angle','INTEGER NOT NULL DEFAULT 60');
    addColumn('devices','open_angle','INTEGER NOT NULL DEFAULT 90');
    addColumn('devices','move_ms','INTEGER NOT NULL DEFAULT 700');
    addColumn('commands','servo_mode',"TEXT NOT NULL DEFAULT 'legacy_continuous'");
    addColumn('commands','closed_angle','INTEGER');
    addColumn('commands','open_angle','INTEGER');
    addColumn('commands','move_ms','INTEGER');
    if(positionalMigration){
      db.exec("UPDATE devices SET run_ms=move_ms+portions*(portion_ms+2*move_ms),config_version=config_version+1,applied_config_version=0,config_synced_at=NULL,config_error=NULL");
      db.exec("UPDATE commands SET status='cancelled' WHERE status='queued'");
    }
    // Upgrade once; old commands retain their original mode/history.
    db.exec("UPDATE commands SET status='cancelled' WHERE status='queued' AND device_id IN (SELECT id FROM devices WHERE servo_mode!='timed_sweep')");
    db.exec("UPDATE devices SET servo_mode='timed_sweep',closed_angle=0,open_angle=360,move_ms=500,run_ms=portions*portion_ms,config_version=config_version+1,applied_config_version=0,config_synced_at=NULL,config_error=NULL WHERE servo_mode!='timed_sweep'");
    db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK'); throw e; }
  const configOf = d => ({version:d.config_version,servo_mode:d.servo_mode,portions:d.portions,portion_ms:d.portion_ms,run_ms:d.run_ms,closed_angle:d.closed_angle,open_angle:d.open_angle,move_ms:d.move_ms});
  const configMatches = (ack,d) => ack && Object.entries(configOf(d)).every(([key,value])=>ack[key]===value);
  const online = d => d.last_seen != null && now() - d.last_seen < 20000;
  function expire() {
    run("UPDATE commands SET status='expired' WHERE status='queued' AND expires<=?", now());
    run("UPDATE commands SET status='unknown' WHERE status='delivered' AND expires+60000<=?", now());
  }
  function queue(d, source, key = null) {
    expire();
    if(d.firmware_protocol!==4)throw fail('Cần nạp firmware quét theo thời gian mới trước khi cho ăn.',409);
    if(d.applied_config_version!==d.config_version||d.config_error)throw fail('Chờ ESP32 xác nhận cấu hình đóng/mở mới.',409);
    if(!integer(d.run_ms,200,60000))throw fail('Tổng thời gian một lệnh phải không quá 60 giây. Hãy giảm số phần hoặc thời gian.',409);
    if (get("SELECT id FROM commands WHERE device_id=? AND (status IN ('queued','delivered') OR created>?)", d.id, now() - 10000)) throw fail('Thiết bị đang xử lý hoặc vừa cho ăn. Hãy chờ ít nhất 10 giây.',409);
    return Number(run("INSERT INTO commands(device_id,source,status,created,expires,run_ms,stop_us,run_us,schedule_key,portions,portion_ms,config_version,servo_mode,closed_angle,open_angle,move_ms) VALUES(?,?,'queued',?,?,?,?,?,?,?,?,?,?,?,?,?)",d.id,source,now(),now()+15000,d.run_ms,d.stop_us,d.run_us,key,d.portions,d.portion_ms,d.config_version,d.servo_mode,d.closed_angle,d.open_angle,d.move_ms).lastInsertRowid);
  }
  function tick() {
    expire();
    const local = new Date(now()+7*3600000), day=local.getUTCDay(), time=local.toISOString().slice(11,16), date=local.toISOString().slice(0,10);
    for (const s of all('SELECT s.*,d.last_seen,d.run_ms,d.stop_us,d.run_us,d.portions,d.portion_ms,d.config_version,d.applied_config_version,d.firmware_protocol,d.config_error,d.servo_mode,d.closed_angle,d.open_angle,d.move_ms FROM schedules s JOIN devices d ON d.id=s.device_id WHERE enabled=1 AND time=?',time)) {
      if (!JSON.parse(s.days).includes(day)) continue;
      const key=`${s.id}:${date}:${time}`;
      if (get('SELECT id FROM commands WHERE schedule_key=?',key)) continue;
      const d={...s,id:s.device_id};
      try {
        if (!online(d)) throw fail('Offline');
        queue(d,'schedule',key);
      } catch {
        run("INSERT OR IGNORE INTO commands(device_id,source,status,created,expires,schedule_key) VALUES(?,'schedule','skipped',?,?,?)",d.id,now(),now(),key);
      }
    }
  }
  const attempts = new Map();
  const server = http.createServer(async (req,res) => {
    const send = (status, data) => { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(data)); };
    try {
      res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      const url=new URL(req.url,'http://localhost'), p=url.pathname, method=req.method;
      if (!p.startsWith('/api/')) {
        const files={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
        if (method!=='GET'||!files[p]) throw fail('Không tìm thấy',404);
        res.writeHead(200,{'Content-Type':files[p][1]});res.end(readFileSync(path.join(root,'public',files[p][0])));return;
      }
      let body={};
      if (method !== 'GET') {
        if (!p.startsWith('/api/device/')) {
          if (req.headers['x-requested-with'] !== 'PawMeal' || req.headers['sec-fetch-site']==='cross-site') throw fail('Yêu cầu không hợp lệ',403);
          const allowed=process.env.PUBLIC_ORIGIN || `${secure?'https':'http'}://${req.headers.host}`;
          if (req.headers.origin && req.headers.origin!==allowed) throw fail('Nguồn yêu cầu không hợp lệ',403);
        }
        let raw=''; for await (const chunk of req) { raw+=chunk; if(raw.length>16384) throw fail('Dữ liệu quá lớn',413); }
        try { body=JSON.parse(raw||'{}'); } catch {throw fail('JSON không hợp lệ');}
        if (!body || typeof body!=='object' || Array.isArray(body)) throw fail('Dữ liệu không hợp lệ');
      }
      if (p==='/api/register'||p==='/api/login') {
        if(method!=='POST') throw fail('Không tìm thấy',404);
        const ip=req.socket.remoteAddress, t=now();
        for (const [k,v] of attempts) if(t-v.start>600000) attempts.delete(k);
        const a=attempts.get(ip)||{start:t,count:0}; attempts.set(ip,a);
        if(++a.count>30) throw fail('Quá nhiều lần thử. Chờ 10 phút.',429);
        const email=String(body.email||'').trim().toLowerCase(), password=body.password;
        if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>200||typeof password!=='string'||password.length<10||password.length>128) throw fail('Email hợp lệ và mật khẩu từ 10–128 ký tự là bắt buộc.');
        let u=get('SELECT * FROM users WHERE email=?',email);
        if(p==='/api/register') {
          if(u) throw fail('Email đã được sử dụng.',409);
          const salt=token(), digest=Buffer.from(await derive(password,salt,64)).toString('hex');
          try { const id=run('INSERT INTO users(email,password,salt) VALUES(?,?,?)',email,digest,salt).lastInsertRowid; u={id,email}; }
          catch {throw fail('Email đã được sử dụng.',409);}
        } else {
          const digest=Buffer.from(await derive(password,u?.salt||'dummy-salt',64));
          if(!u||!timingSafeEqual(digest,Buffer.from(u.password,'hex'))) throw fail('Email hoặc mật khẩu không đúng.',401);
        }
        const session=token();run('DELETE FROM sessions WHERE expires<?',now());
        run('INSERT INTO sessions VALUES(?,?,?)',hash(session),u.id,now()+7*86400000);
        res.setHeader('Set-Cookie',`session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure?'; Secure':''}`);
        send(200,{email:u.email});return;
      }
      if(p.startsWith('/api/device/')) {
        const bearer=req.headers.authorization?.replace(/^Bearer /,'')||'';
        const d=get('SELECT * FROM devices WHERE token=?',hash(bearer));
        if(!d) throw fail('Token thiết bị không hợp lệ',401);
        if(p==='/api/device/poll'&&method==='POST') {
          run('UPDATE devices SET last_seen=? WHERE id=?',now(),d.id);expire();
          if (body.protocol===4) {
            const error=['storage','invalid'].includes(body.config_error)?body.config_error:null;
            run('UPDATE devices SET firmware_protocol=4,config_error=? WHERE id=?',error,d.id);
            if (!error && configMatches(body.applied_config,d)) {
              if (d.applied_config_version!==d.config_version || !d.config_synced_at || d.config_error) {
                run('UPDATE devices SET applied_config_version=?,config_synced_at=? WHERE id=?',d.config_version,now(),d.id);
              }
            } else {
              run('UPDATE devices SET applied_config_version=0,config_synced_at=NULL WHERE id=?',d.id);
            }
          } else {
            // An older firmware must never appear to have acknowledged stored config.
            run('UPDATE devices SET firmware_protocol=?,applied_config_version=0,config_synced_at=NULL,config_error=NULL WHERE id=?',[2,3].includes(body.protocol)?body.protocol:1,d.id);
          }
          const compatible=body.protocol===4&&!body.config_error&&configMatches(body.applied_config,d);
          const c=compatible?get("SELECT * FROM commands WHERE device_id=? AND status='queued' AND expires>? AND servo_mode='timed_sweep' ORDER BY id LIMIT 1",d.id,now()):null;
          if(c) run("UPDATE commands SET status='delivered' WHERE id=? AND status='queued'",c.id);
          send(200,{config:body.protocol===4?configOf(d):null,requires_firmware:body.protocol===4?null:'timed_sweep protocol 4',command:c?{id:c.id,servo_mode:c.servo_mode,run_ms:c.run_ms,portions:c.portions,portion_ms:c.portion_ms,closed_angle:c.closed_angle,open_angle:c.open_angle,move_ms:c.move_ms,config_version:c.config_version}:null});return;
        }
        if(p==='/api/device/ack'&&method==='POST') {
          if(!integer(body.id,1,Number.MAX_SAFE_INTEGER)||!['completed','interrupted'].includes(body.status)) throw fail('Phản hồi không hợp lệ');
          run("UPDATE commands SET status=?,finished=? WHERE id=? AND device_id=? AND status IN ('delivered','unknown')",body.status,now(),body.id,d.id);
          send(200,{ok:true});return;
        }
        throw fail('Không tìm thấy',404);
      }
      const cookie=(req.headers.cookie||'').match(/(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/)?.[1]||'';
      const u=get('SELECT users.id,users.email FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires>?',hash(cookie),now());
      if(!u) throw fail('Vui lòng đăng nhập.',401);
      if(p==='/api/logout'&&method==='POST') {
        run('DELETE FROM sessions WHERE token=?',hash(cookie)); res.setHeader('Set-Cookie','session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');send(200,{ok:true});return;
      }
      if(p==='/api/state'&&method==='GET') {
        expire();const devices=all('SELECT id,name,last_seen,run_ms,stop_us,run_us,portions,portion_ms,config_version,applied_config_version,config_synced_at,config_error,firmware_protocol,servo_mode,closed_angle,open_angle,move_ms FROM devices WHERE user_id=?',u.id).map(d=>({...d,config_synced:d.firmware_protocol===4&&d.applied_config_version===d.config_version&&!d.config_error,online:online(d),schedules:all('SELECT * FROM schedules WHERE device_id=? ORDER BY time',d.id).map(s=>({...s,days:JSON.parse(s.days)}))}));
        const events=all('SELECT c.id,c.device_id,d.name,c.source,c.status,c.created,c.finished,c.run_ms,c.portions,c.portion_ms,c.servo_mode,c.closed_angle,c.open_angle,c.move_ms FROM commands c JOIN devices d ON d.id=c.device_id WHERE d.user_id=? ORDER BY c.id DESC LIMIT 50',u.id);
        send(200,{user:u,devices,events});return;
      }
      if(p==='/api/devices'&&method==='POST') {
        const name=String(body.name||'').trim();if(!name||name.length>60) throw fail('Tên thiết bị dài 1–60 ký tự.');
        if(get('SELECT count(*) n FROM devices WHERE user_id=?',u.id).n>=30) throw fail('Tối đa 30 thiết bị.');
        const secret=token(), id=Number(run("INSERT INTO devices(user_id,name,token,run_ms,servo_mode,closed_angle,open_angle,move_ms) VALUES(?,?,?,1500,'timed_sweep',0,360,500)",u.id,name,hash(secret)).lastInsertRowid);
        send(201,{id,token:secret});return;
      }
      const m=p.match(/^\/api\/devices\/(\d+)(?:\/(feed|schedules|token))?(?:\/(\d+))?$/);
      if(!m) throw fail('Không tìm thấy',404);
      const d=get('SELECT * FROM devices WHERE id=? AND user_id=?',Number(m[1]),u.id);if(!d) throw fail('Không tìm thấy thiết bị',404);
      if(method==='DELETE'&&!m[2]) {run('DELETE FROM devices WHERE id=?',d.id);send(200,{ok:true});return;}
      if(method==='PATCH'&&!m[2]) {
        const {name,portions,portion_ms,closed_angle,open_angle,move_ms}=body;
        const run_ms=portions*portion_ms;
        if(typeof name!=='string'||!name.trim()||name.length>60||!integer(portions,1,20)||!integer(portion_ms,200,10000)||!integer(move_ms,200,3000)||!integer(closed_angle,0,360)||!integer(open_angle,0,360)||Math.abs(closed_angle-open_angle)<5||!integer(run_ms,200,60000))throw fail('Chọn 1–20 phần; chạy 0,2–10 giây/phần; nghỉ ở mỗi đầu 0,2–3 giây; mốc 0–360 cách nhau ít nhất 5. Tổng không quá 60 giây.');
        const changed=portions!==d.portions||portion_ms!==d.portion_ms||closed_angle!==d.closed_angle||open_angle!==d.open_angle||move_ms!==d.move_ms;
        db.exec('BEGIN');
        try {
          run('UPDATE devices SET name=?,portions=?,portion_ms=?,run_ms=?,closed_angle=?,open_angle=?,move_ms=?,config_version=config_version+? WHERE id=?',name.trim(),portions,portion_ms,run_ms,closed_angle,open_angle,move_ms,+changed,d.id);
          if(changed) {
            run('UPDATE devices SET config_error=NULL,config_synced_at=NULL WHERE id=?',d.id);
            run("UPDATE commands SET status='cancelled' WHERE device_id=? AND status='queued'",d.id);
          }
          db.exec('COMMIT');
        } catch(e) {db.exec('ROLLBACK');throw e;}
        send(200,{ok:true,config_version:d.config_version+Number(changed),config_synced:!changed&&d.applied_config_version===d.config_version&&!d.config_error});return;
      }
      if(m[2]==='token'&&method==='POST') {
        const secret=token();run('UPDATE devices SET token=?,last_seen=NULL,applied_config_version=0,config_synced_at=NULL,config_error=NULL WHERE id=?',hash(secret),d.id);
        run("UPDATE commands SET status='expired' WHERE device_id=? AND status='queued'",d.id);send(200,{token:secret});return;
      }
      if(m[2]==='feed'&&method==='POST') {if(!online(d)) throw fail('Thiết bị đang mất kết nối.',409);send(201,{id:queue(d,'manual')});return;}
      if(m[2]==='schedules'&&method==='POST'&&!m[3]) {
        if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.time)||!Array.isArray(body.days)||!body.days.length||body.days.length>7||!body.days.every(v=>integer(v,0,6))) throw fail('Chọn giờ và ít nhất một ngày.');
        if(get('SELECT count(*) n FROM schedules WHERE device_id=?',d.id).n>=12) throw fail('Tối đa 12 lịch mỗi thiết bị.');
        if(get('SELECT id FROM schedules WHERE device_id=? AND time=?',d.id,body.time)) throw fail('Đã có lịch vào giờ này.',409);
        run('INSERT INTO schedules(device_id,time,days) VALUES(?,?,?)',d.id,body.time,JSON.stringify([...new Set(body.days)]));send(201,{ok:true});return;
      }
      if(m[2]==='schedules'&&m[3]&&['DELETE','PATCH'].includes(method)) {
        if(method==='DELETE')run('DELETE FROM schedules WHERE id=? AND device_id=?',Number(m[3]),d.id);
        else {if(typeof body.enabled!=='boolean')throw fail('Trạng thái không hợp lệ');run('UPDATE schedules SET enabled=? WHERE id=? AND device_id=?',+body.enabled,Number(m[3]),d.id);}
        send(200,{ok:true});return;
      }
      throw fail('Không tìm thấy',404);
    } catch(e) {if(!e.status) console.error(e);if(!res.headersSent)send(e.status||500,{error:e.status?e.message:'Lỗi máy chủ.'});else res.end();}
  });
  server.requestTimeout=10000;
  return {server,tick,close:()=>db.close()};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const app=createApp(), port=Number(process.env.PORT||3000);
  app.server.listen(port,process.env.HOST||'0.0.0.0',()=>console.log(`PawMeal: http://localhost:${port}`));
  const timer=setInterval(app.tick,1000);
  for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{clearInterval(timer);app.server.close(()=>{app.close();process.exit();});});
}
