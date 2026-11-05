import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { fileURLToPath } from 'node:url';
const convert = fileURLToPath(new URL('../convert.mjs', import.meta.url));
const dat = n => JSON.stringify({ _version: '2.2.0', _notes: Array.from({ length: n }, (_, i) => ({ _time: 4 + i, _lineIndex: i % 2 ? 2 : 1, _lineLayer: 0, _type: i % 2, _cutDirection: 1 })), _obstacles: [], _events: [] });

test('ダブルセイバー用の種類(--char Lawless)で --all-diffs: maul.json に、その種類の難易度を全部入れる', () => {
  const d = mkdtempSync(join(tmpdir(), 'conv-'));
  const lab = { _difficultyLabel: 'Double Saber' };
  writeFileSync(join(d, 'Info.dat'), JSON.stringify({
    _version: '2.0.0', _songName: 'T', _songAuthorName: 'A', _levelAuthorName: 'らばーず譜面', _beatsPerMinute: 120, _songTimeOffset: 0, _songFilename: 'song.egg',
    _difficultyBeatmapSets: [
      { _beatmapCharacteristicName: 'Standard', _difficultyBeatmaps: [{ _difficulty: 'Normal', _difficultyRank: 3, _beatmapFilename: 'NormalStandard.dat', _noteJumpMovementSpeed: 10, _noteJumpStartBeatOffset: 0 }] },
      { _beatmapCharacteristicName: 'Lawless', _difficultyBeatmaps: ['Easy', 'Normal', 'Hard'].map((x, i) => ({ _difficulty: x, _difficultyRank: i * 2 + 1, _beatmapFilename: x + 'Lawless.dat', _noteJumpMovementSpeed: 10, _noteJumpStartBeatOffset: 0, _customData: lab })) },
    ],
  }));
  writeFileSync(join(d, 'NormalStandard.dat'), dat(8));
  writeFileSync(join(d, 'EasyLawless.dat'), dat(4));
  writeFileSync(join(d, 'NormalLawless.dat'), dat(6));
  writeFileSync(join(d, 'HardLawless.dat'), dat(10));
  const out = mkdtempSync(join(tmpdir(), 'out-'));
  const r = spawnSync(process.execPath, [convert, d, '--slot', '3', '--char', 'Lawless', '--diff', 'Normal', '--all-diffs', '--chart-only', '--chart-name', 'maul.json', '--out', out, '--song-id', 'lovers:t'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const m = JSON.parse(readFileSync(join(out, 'slots', '003', 'maul.json'), 'utf8'));
  assert.equal(m.difficulty, 'Normal');
  assert.equal(m.counts.notes, 6);
  assert.deepEqual(m.diffs.map(x => [x.difficulty, x.counts.notes]), [['Easy', 4], ['Hard', 10]]);
});
