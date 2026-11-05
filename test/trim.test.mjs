import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trimToFit } from '../lib/trim.mjs';

const m = (id, score, prot = false) => ({ id, stats: { score }, protected: prot });

test('入りきらないときは、守る曲以外を BeatSaver の評価の低いほうから減らす', () => {
  const maps = [m('u1', 0.5, true), m('c1', 0.95), m('c2', 0.70), m('t1', 0.90), m('t2', 0.60)];
  const r = trimToFit(maps, 3);
  assert.deepEqual(r.kept.map(x => x.id), ['u1', 'c1', 't1']);
  assert.deepEqual(r.dropped.map(x => x.id).sort(), ['c2', 't2']);
});

test('守る曲(うどんセイバー・らばーず譜面・頼まれた曲)は、評価が低くても消さない', () => {
  const maps = [m('u1', 0.1, true), m('u2', 0.2, true), m('t1', 0.99)];
  const r = trimToFit(maps, 2);
  assert.deepEqual(r.kept.map(x => x.id), ['u1', 'u2']);
});

test('守る曲だけで入りきらなくても、守る曲は消さない(知らせだけ出す)', () => {
  const r = trimToFit([m('u1', 0.1, true), m('u2', 0.2, true)], 1);
  assert.equal(r.kept.length, 2);
  assert.equal(r.over, 1);
});

test('入りきるときは、何も減らさず、並び順もそのまま', () => {
  const maps = [m('a', 0.5), m('b', 0.9, true)];
  assert.deepEqual(trimToFit(maps, 5).kept.map(x => x.id), ['a', 'b']);
});
