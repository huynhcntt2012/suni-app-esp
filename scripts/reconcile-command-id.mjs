// Run during maintenance, with the app stopped. Never resets ESP32 deduplication.
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const [file, deviceArg, lastArg, apply] = process.argv.slice(2);
if (!file || !deviceArg || !lastArg || (apply && apply !== '--apply')) {
  console.error('Usage: node scripts/reconcile-command-id.mjs DATA.sqlite DEVICE_ID LAST_SAVED_ID [--apply]');
  process.exit(1);
}
const deviceId = Number(deviceArg), last = Number(lastArg);
if (!Number.isSafeInteger(deviceId) || deviceId < 1 || !Number.isSafeInteger(last) || last < 0 || last >= Number.MAX_SAFE_INTEGER - 1) {
  throw new Error('Device ID and last saved ID must be safe nonnegative integers.');
}
const path = resolve(file);
if (!existsSync(path)) throw new Error('Database does not exist; refusing to create one.');
const db = new DatabaseSync(path, { readOnly: !apply });
try {
  db.exec('PRAGMA busy_timeout=5000');
  const device = db.prepare('SELECT id,name,diagnostics_json FROM devices WHERE id=?').get(deviceId);
  if (!device) throw new Error('Device not found.');
  const report = device.diagnostics_json ? JSON.parse(device.diagnostics_json) : null;
  if (report?.pending_ack_id > 0) throw new Error('Pending ACK exists. Resolve it before reconciling IDs.');
  const reports = db.prepare('SELECT diagnostics_json FROM devices').all();
  let floor = last;
  for (const row of reports) {
    const r = row.diagnostics_json ? JSON.parse(row.diagnostics_json) : null;
    if (Number.isSafeInteger(r?.last_command_id)) floor = Math.max(floor, r.last_command_id);
  }
  floor = Math.max(floor,
    db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM commands').get().id,
    db.prepare("SELECT seq FROM sqlite_sequence WHERE name='commands'").get()?.seq || 0);
  if (floor >= Number.MAX_SAFE_INTEGER - 1) throw new Error('Sequence too large.');
  const active = db.prepare("SELECT id,status FROM commands WHERE device_id=? AND status IN ('queued','delivered')").all(deviceId);
  console.log(JSON.stringify({ deviceId, deviceName: device.name, suppliedLastSavedId: last, sequenceFloor: floor, nextIdAtLeast: floor + 1, activeCommands: active, apply: !!apply }, null, 2));
  if (apply) {
    // VACUUM INTO creates a consistent backup, including WAL data.
    const backup = path + '.before-id-reconcile-' + Date.now() + '.sqlite';
    db.prepare('VACUUM INTO ?').run(backup);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE commands SET status='cancelled' WHERE device_id=? AND status='queued'").run(deviceId);
      // Do not claim completion or replay delivered commands.
      db.prepare("UPDATE commands SET status='unknown' WHERE device_id=? AND status='delivered'").run(deviceId);
      const current = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='commands'").get();
      if (current) db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='commands'").run(floor);
      else db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('commands',?)").run(floor);
      db.exec('COMMIT');
      console.log('Reconciled. Backup: ' + backup);
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  } else console.log('Preview only. Stop the app before rerunning with --apply.');
} finally { db.close(); }
