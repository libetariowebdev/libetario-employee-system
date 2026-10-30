import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { fixture, digest } from '../helpers';
import { profileForSession } from '../../src/server/dal/profiles';
import { db, authPool } from '../../src/server/db';
import { profileResponse } from '../../src/server/http/profile';
let f: Awaited<ReturnType<typeof fixture>>;
const runtime = new pg.Client({ connectionString: process.env.DATABASE_URL });
before(async () => { f = await fixture(); await runtime.connect(); });
after(async () => { await runtime.end(); await f.owner.end(); await db.$disconnect(); await authPool.end(); });

test('runtime is a non-owner, non-superuser, NOBYPASSRLS role', async () => {
  const row = (await runtime.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.equal(row.current_user, 'libetario_runtime'); assert.equal(row.rolsuper, false); assert.equal(row.rolbypassrls, false);
  assert.notEqual((await runtime.query("SELECT tableowner FROM pg_tables WHERE tablename='employee_profiles'")).rows[0].tableowner, row.current_user);
});
test('app DAL denies A→B and B→A profiles AND rates; admin may read both', async () => {
  assert.equal(await profileForSession(digest(f.tokens.a), f.ids.b), null);
  assert.equal(await profileForSession(digest(f.tokens.b), f.ids.a), null);
  const own = await profileForSession(digest(f.tokens.a), f.ids.a);
  assert.equal(own?.rates[0].amount, '100.1250');
  assert.equal((await profileForSession(digest(f.tokens.admin), f.ids.b))?.rates[0].amount, '250.5000');
});
test('direct runtime-role SELECT cannot read another employee even with their UUID', async () => {
  for (const [who, other] of [['a','b'],['b','a']] as const) {
    await runtime.query('BEGIN');
    try {
      await runtime.query("SELECT set_config('app.session_hash',$1,true)", [digest(f.tokens[who])]);
      assert.equal((await runtime.query('SELECT * FROM employee_profiles WHERE user_id=$1', [f.ids[other]])).rowCount, 0);
      assert.equal((await runtime.query('SELECT * FROM employee_rate_history WHERE employee_id=$1', [f.ids[other]])).rowCount, 0);
      assert.equal((await runtime.query('SELECT * FROM employee_profiles WHERE user_id=$1', [f.ids[who]])).rowCount, 1);
      assert.equal((await runtime.query('UPDATE employee_profiles SET display_name=$1 WHERE user_id=$2', ['Forged', f.ids[other]])).rowCount, 0);
    } finally { await runtime.query('ROLLBACK'); }
  }
});
test('application HTTP handler rejects guessed employee IDs and returns own records only', async () => {
  const req = (token: string) => new Request('http://127.0.0.1/api/employees/guessed-id', { headers: { cookie: `libetario_session=${token}` } });
  assert.equal((await profileResponse(req(f.tokens.a), f.ids.b)).status, 404);
  assert.equal((await profileResponse(req(f.tokens.b), f.ids.a)).status, 404);
  const own = await profileResponse(req(f.tokens.a), f.ids.a);
  assert.equal(own.status, 200); assert.equal((await own.json()).user_id, f.ids.a);
});
test('missing or forged session context is default deny, and pooled context does not leak', async () => {
  assert.equal((await runtime.query('SELECT * FROM employee_profiles')).rowCount, 0);
  await runtime.query("SELECT set_config('app.user_id',$1,false)", [f.ids.admin]);
  assert.equal((await runtime.query('SELECT * FROM employee_rate_history')).rowCount, 0);
  assert.equal(await profileForSession('0'.repeat(64), f.ids.a), null);
});
