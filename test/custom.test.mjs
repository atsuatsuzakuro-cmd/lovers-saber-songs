import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { overlayCustom, buildCustom } from '../lib/custom.mjs';

function customDir() {
  const d = mkdtempSync(join(tmpdir(), 'custom-'));
  writeFileSync(join(d, 'Info.dat'), '{"_version":"2.0.0","_levelAuthorName":"らばーず譜面"}');
  writeFileSync(join(d, 'NormalStandard.dat'), '{"_notes":[]}');
  return d;
}

test('らばーず譜面のファイルで、BeatSaver の ZIP の Info.dat を置きかえ、譜面を足す(音はそのまま)', () => {
  const files = new Map([['Info.dat', Buffer.from('{"_levelAuthorName":"元の作者"}')], ['song.egg', Buffer.from('OGG')], ['ExpertStandard.dat', Buffer.from('{}')]]);
  const out = overlayCustom(files, customDir());
  assert.match(out.get('Info.dat').toString(), /らばーず譜面/);
  assert.equal(out.get('NormalStandard.dat').toString(), '{"_notes":[]}');
  assert.equal(out.get('song.egg').toString(), 'OGG');
});

test('BeatSaver から ZIP を取れないときは、その曲だけとばして記録する(止まらない)', async () => {
  const logs = [];
  const { basename, dirname } = await import('node:path');
  const d = customDir(), id = basename(d);
  const r = await buildCustom(id, { customRoot: dirname(d), out: tmpdir(), slot: 5, fetch: () => Promise.reject(new Error('つながらない')), log: s => logs.push(s) });
  assert.equal(r, null);
  assert.ok(logs.some(s => s.includes(id) && s.includes('つながらない')), logs.join('\n'));
});

test('作ったときと BeatSaver の音の版がちがえば、その曲はとばす(譜面と音がずれるため)', async () => {
  const d = customDir();
  writeFileSync(join(d, 'source.json'), '{"hash":"aaa"}');
  const logs = [];
  const map = { uploader: { name: 'x' }, versions: [{ hash: 'bbb', state: 'Published', downloadURL: 'https://example.invalid/bbb.zip' }] };
  const fetchStub = async (url) => { if (url.includes('/maps/id/')) return { ok: true, json: async () => map }; throw new Error('ZIP は取りにいかないはず'); };
  const { basename, dirname } = await import('node:path');
  const r = await buildCustom(basename(d), { customRoot: dirname(d), out: tmpdir(), slot: 5, fetch: fetchStub, log: s => logs.push(s) });
  assert.equal(r, null);
  assert.ok(logs.some(s => s.includes('版')), logs.join('\n'));
});

test('source.json は、置き場の曲のファイルには入れない', () => {
  const d = customDir();
  writeFileSync(join(d, 'source.json'), '{"hash":"aaa"}');
  assert.equal(overlayCustom(new Map(), d).has('source.json'), false);
});

test('譜面のファイルが同じなら、同じ印(customKey)。1 文字でも変われば別の印', async () => {
  const { customKey } = await import('../lib/custom.mjs');
  const d = customDir();
  const k1 = customKey(d);
  assert.equal(customKey(d), k1);
  writeFileSync(join(d, 'NormalStandard.dat'), '{"_notes":[1]}');
  assert.notEqual(customKey(d), k1);
});

test('前回と同じ譜面(customKey が同じ)なら、前回置いたファイルを取り直して使う(BeatSaver から作り直さない)', async () => {
  const { customKey } = await import('../lib/custom.mjs');
  const { basename, dirname } = await import('node:path');
  const { mkdtempSync, existsSync, readFileSync } = await import('node:fs');
  const d = customDir();
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const prev = { slot: 7, title: 'YY', songId: 'lovers:' + basename(d), customKey: customKey(d), custom: true, mappers: ['らばーず譜面'] };
  const asked = [];
  const fetchStub = async (url) => { asked.push(url); if (url.includes('pages.dev/slots/007/')) return { ok: true, arrayBuffer: async () => new TextEncoder().encode(url.endsWith('chart.json') ? '{"x":1}' : 'MP4').buffer }; throw new Error('BeatSaver には行かないはず: ' + url); };
  const r = await buildCustom(basename(d), { customRoot: dirname(d), out, slot: 7, prev, siteUrl: 'https://lovers-saber.pages.dev/', fetch: fetchStub, log: () => {} });
  assert.equal(r.songId, prev.songId);
  assert.equal(r.reused, true);
  assert.equal(readFileSync(join(out, 'slots', '007', 'audio.mp4'), 'utf8'), 'MP4');
  assert.ok(!asked.some(u => u.includes('beatsaver')));
});

test('ZIP の中が小文字の info.dat でも、らばーず譜面の Info.dat に置きかわる(大文字小文字を区別する Linux でも)', () => {
  const files = new Map([['info.dat', Buffer.from('{"_levelAuthorName":"元の作者"}')], ['sub/Expert.dat', Buffer.from('{}')], ['song.egg', Buffer.from('OGG')]]);
  const out = overlayCustom(files, customDir());
  const infos = [...out.keys()].filter(k => k.split('/').pop().toLowerCase() === 'info.dat');
  assert.deepEqual(infos, ['Info.dat']);
  assert.match(out.get('Info.dat').toString(), /らばーず譜面/);
});

test('ダブルセイバーの maul.json から、一覧の "maul"(選べる難易度つき)を作る', async () => {
  const { maulEntry } = await import('../lib/custom.mjs');
  const m = { characteristic: 'Lawless', difficulty: 'Normal', chartKey: 'k-n', counts: { notes: 60 }, diffs: [{ difficulty: 'Hard', chartKey: 'k-h', counts: { notes: 90 } }, { difficulty: 'Easy', chartKey: 'k-e', counts: { notes: 30 } }] };
  assert.deepEqual(maulEntry(m), {
    characteristic: 'Lawless', difficulty: 'Normal', label: 'Double Saber', noteCount: 60, chartKey: 'k-n',
    diffs: [{ difficulty: 'Easy', noteCount: 30, chartKey: 'k-e' }, { difficulty: 'Normal', noteCount: 60, chartKey: 'k-n' }, { difficulty: 'Hard', noteCount: 90, chartKey: 'k-h' }],
  });
});
