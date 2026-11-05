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
  const r = await buildCustom('abc1', { customRoot: join(customDir(), '..'), out: tmpdir(), slot: 5, fetch: () => Promise.reject(new Error('つながらない')), log: s => logs.push(s) });
  assert.equal(r, null);
  assert.ok(logs.some(s => s.includes('abc1') && s.includes('つながらない')), logs.join('\n'));
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
