import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { cryptoBox, ensure, opaque, sha256 } from './security.mjs';

/** One process, one private SQLite file. All record bodies (including source and tokens) are encrypted. */
export class Store {
  constructor(filename, key, { now = Date.now } = {}) {
    this.now = now; this.box = cryptoBox(key);
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, key TEXT NOT NULL, owner TEXT NOT NULL,
      state TEXT NOT NULL, expires INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,key));
      CREATE INDEX IF NOT EXISTS owner_records ON records(kind,owner,expires);
      CREATE TABLE IF NOT EXISTS quotas (day TEXT NOT NULL, owner TEXT NOT NULL, used INTEGER NOT NULL, PRIMARY KEY(day,owner));`);
  }
  aad(kind, key, owner) { return JSON.stringify([kind, key, owner]); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  put(kind, key, owner, body, expires, state = '') {
    this.db.prepare('INSERT INTO records VALUES (?,?,?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET owner=excluded.owner,state=excluded.state,expires=excluded.expires,body=excluded.body')
      .run(kind, key, owner, state, expires, this.box.seal(body, this.aad(kind, key, owner)));
  }
  get(kind, key, owner) {
    const row = this.db.prepare('SELECT * FROM records WHERE kind=? AND key=? AND expires>?').get(kind, key, this.now());
    if (!row || (owner !== undefined && row.owner !== owner)) return null;
    return { ...this.box.open(row.body, this.aad(kind, key, row.owner)), state: row.state, expires: row.expires, owner: row.owner };
  }
  remove(kind, key) { this.db.prepare('DELETE FROM records WHERE kind=? AND key=?').run(kind, key); }
  consume(kind, key) { return this.transaction(() => { const r = this.get(kind, key); this.remove(kind, key); return r; }); }
  session(user, token, expiresIn, config) {
    const sid = opaque(), csrf = opaque(), owner = String(user.id), expires = this.now() + Math.min(config.sessionMs, expiresIn * 1000);
    this.put('session', sha256(sid), owner, { user: { id: user.id, login: user.login }, token, csrf }, expires);
    return { sid, csrf, expires, user: { id: user.id, login: user.login } };
  }
  jobs(owner) { return this.db.prepare("SELECT key FROM records WHERE kind='job' AND owner=? AND expires>? ORDER BY rowid DESC LIMIT 40").all(owner, this.now()).map(r => this.get('job', r.key, owner)); }
  saveJob(job) { this.put('job', job.id, job.owner, job, job.expires, job.state); }
  transition(id, owner, allowed, edit) {
    return this.transaction(() => {
      const job = this.get('job', id, owner); ensure(job, 404, 'not_found', 'Job not found.');
      ensure(allowed.includes(job.state), 409, 'job_state', 'This job cannot perform that action in its current state.');
      const next = { ...job, ...edit, updatedAt: this.now() }; this.saveJob(next); return next;
    });
  }
  reserve(owner, config, input) {
    return this.transaction(() => {
      const n = this.db.prepare("SELECT count(*) AS n FROM records WHERE kind='job' AND state IN ('queued','running') AND expires>?").get(this.now()).n;
      ensure(n < config.maxActive, 429, 'capacity', 'All draft workers are busy.');
      ensure(!this.jobs(owner).some(j => ['queued', 'running'].includes(j.state)), 429, 'capacity', 'Finish or cancel your active draft first.');
      const day = new Date(this.now()).toISOString().slice(0, 10);
      for (const [who, limit] of [[owner, config.userDailyLimit], ['*', config.globalDailyLimit]]) {
        const used = this.db.prepare('SELECT used FROM quotas WHERE day=? AND owner=?').get(day, who)?.used || 0;
        ensure(used < limit, 429, 'daily_limit', 'Daily AI draft allowance reached.');
        this.db.prepare('INSERT INTO quotas VALUES(?,?,1) ON CONFLICT(day,owner) DO UPDATE SET used=used+1').run(day, who);
      }
      const job = { id: opaque(), owner, state: 'queued', createdAt: this.now(), updatedAt: this.now(), expires: this.now() + config.retentionMs, input, message: 'Queued for repository analysis.' };
      this.saveJob(job); return job;
    });
  }
  invalidate(owner) { this.db.prepare("DELETE FROM records WHERE kind='session' AND owner=?").run(owner); }
  invalidateAll() { this.db.prepare("DELETE FROM records WHERE kind='session'").run(); }
  deleteOwner(owner) { this.db.prepare('DELETE FROM records WHERE owner=?').run(owner); } // Quotas deliberately retained until day expires.
  purge() {
    this.db.prepare('DELETE FROM records WHERE expires<=?').run(this.now());
    this.db.prepare('DELETE FROM quotas WHERE day<?').run(new Date(this.now() - 86400_000).toISOString().slice(0, 10));
  }
  recover() {
    const rows = this.db.prepare("SELECT key FROM records WHERE kind='job' AND state IN ('queued','running','publishing')").all();
    for (const { key } of rows) { const j = this.get('job', key); if (!j) continue; j.state = j.state === 'publishing' ? 'delivery_uncertain' : 'interrupted'; j.message = 'Server restarted; no AI request was automatically retried.'; this.saveJob(j); }
  }
  close() { this.db.close(); }
}
