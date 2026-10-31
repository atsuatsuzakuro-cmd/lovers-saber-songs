// Beat Saber 形式(v2 / v3 / v4)の譜面を、VRChat 側で扱いやすい
// 「秒単位・平坦な数値配列」の独自形式 (vrsaber-chart v1) に変換する。
// 配置(x, y)・向き(d, a)・時刻は元の値をそのまま使い、拍→秒の換算だけを行う。
import { createHash } from 'node:crypto';

export const CHART_FORMAT = 'vrsaber-chart';
export const CHART_FORMAT_VERSION = 1;

const DEFAULT_NJS = { Easy: 10, Normal: 10, Hard: 10, Expert: 12, ExpertPlus: 16 };

function parseJson(buf, name) {
  // BOM 付きの .dat もあるので除去する
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try { return JSON.parse(text); } catch (e) { throw new Error(`${name} の JSON が読めません: ${e.message}`); }
}

function majorVersion(obj) {
  const v = obj.version ?? obj._version ?? '2.0.0';
  return parseInt(String(v).split('.')[0], 10);
}

// ZIP 内のファイル名は大文字小文字やフォルダの違いがあるので、ゆるく探す
export function makeFileLookup(files) {
  const byLower = new Map();
  for (const [name, data] of files) {
    byLower.set(name.toLowerCase(), data);
    const base = name.split('/').pop().toLowerCase();
    if (!byLower.has(base)) byLower.set(base, data);
  }
  return (name) => byLower.get(String(name).toLowerCase()) ?? null;
}

// ---- Info.dat ----
export function readInfo(files) {
  const get = makeFileLookup(files);
  const infoBuf = get('Info.dat');
  if (!infoBuf) throw new Error('Info.dat が見つかりません');
  const info = parseJson(infoBuf, 'Info.dat');
  const v = majorVersion(info);
  if (v >= 4) {
    return {
      infoVersion: info.version,
      infoBuf,
      title: info.song?.title ?? '',
      subTitle: info.song?.subTitle ?? '',
      artist: info.song?.author ?? '',
      bpm: info.audio?.bpm,
      songFilename: info.audio?.songFilename,
      coverFilename: info.coverImageFilename ?? null,
      audioDataFilename: info.audio?.audioDataFilename ?? null,
      songTimeOffset: 0,
      difficulties: (info.difficultyBeatmaps ?? []).map((d) => ({
        characteristic: d.characteristic,
        difficulty: d.difficulty,
        filename: d.beatmapDataFilename,
        njs: d.noteJumpMovementSpeed,
        jumpOffset: d.noteJumpStartBeatOffset ?? 0,
        mappers: d.beatmapAuthors?.mappers ?? [],
        customData: d.customData ?? null,
      })),
    };
  }
  const diffs = [];
  for (const set of info._difficultyBeatmapSets ?? []) {
    for (const d of set._difficultyBeatmaps ?? []) {
      diffs.push({
        characteristic: set._beatmapCharacteristicName,
        difficulty: d._difficulty,
        filename: d._beatmapFilename,
        njs: d._noteJumpMovementSpeed,
        jumpOffset: d._noteJumpStartBeatOffset ?? 0,
        mappers: info._levelAuthorName ? [info._levelAuthorName] : [],
        customData: d._customData ?? null,
      });
    }
  }
  return {
    infoVersion: info._version ?? '2.0.0',
    infoBuf,
    title: info._songName ?? '',
    subTitle: info._songSubName ?? '',
    artist: info._songAuthorName ?? '',
    bpm: info._beatsPerMinute,
    songFilename: info._songFilename,
    coverFilename: info._coverImageFilename ?? null,
    audioDataFilename: get('BPMInfo.dat') ? 'BPMInfo.dat' : null,
    songTimeOffset: info._songTimeOffset ?? 0,
    difficulties: diffs,
  };
}

// ---- 拍 → 秒 ----
// segments: [{ beat, time, bpm }] を拍順に並べたもの。区間ごとに一定 BPM として換算する。
export function makeTimeline(segments) {
  const segs = [...segments].sort((a, b) => a.beat - b.beat);
  return (beat) => {
    let s = segs[0];
    for (let i = 1; i < segs.length; i++) {
      if (segs[i].beat <= beat) s = segs[i]; else break;
    }
    return s.time + ((beat - s.beat) * 60) / s.bpm;
  };
}

// v2/v3: 譜面ファイル内の BPM イベントから区間を作る
export function timelineFromBpmEvents(initialBpm, events) {
  const evs = [...events].filter((e) => e.bpm > 0).sort((a, b) => a.beat - b.beat);
  const segs = [{ beat: 0, time: 0, bpm: initialBpm }];
  for (const e of evs) {
    const last = segs[segs.length - 1];
    const time = last.time + ((e.beat - last.beat) * 60) / last.bpm;
    if (e.beat === last.beat) { last.bpm = e.bpm; continue; }
    segs.push({ beat: e.beat, time, bpm: e.bpm });
  }
  return { toSec: makeTimeline(segs), segments: segs };
}

// v4 (および v2 BPMInfo.dat): サンプル位置ベースの区間から作る
export function timelineFromAudioData(initialBpm, audio) {
  const v = majorVersion(audio);
  const freq = v >= 4 ? audio.songFrequency : audio._songFrequency;
  const regions = (v >= 4 ? audio.bpmData : audio._regions) ?? [];
  const rs = regions.map((r) => v >= 4
    ? { si: r.si, ei: r.ei, sb: r.sb, eb: r.eb }
    : { si: r._startSampleIndex, ei: r._endSampleIndex, sb: r._startBeat, eb: r._endBeat });
  if (!freq || rs.length === 0) return timelineFromBpmEvents(initialBpm, []);
  rs.sort((a, b) => a.sb - b.sb);
  const segs = [];
  if (rs[0].sb > 0) {
    // 最初の区間より前は、区間開始時刻から逆算した一定 BPM とみなす
    const t0 = rs[0].si / freq;
    const bpm0 = t0 > 0 ? (rs[0].sb * 60) / t0 : initialBpm;
    segs.push({ beat: 0, time: 0, bpm: bpm0 });
  }
  for (const r of rs) {
    const dur = (r.ei - r.si) / freq;
    const bpm = dur > 0 && r.eb > r.sb ? ((r.eb - r.sb) * 60) / dur : initialBpm;
    segs.push({ beat: r.sb, time: r.si / freq, bpm });
  }
  return { toSec: makeTimeline(segs), segments: segs };
}

// ---- 譜面ファイル ----
// 戻り値の beat はすべて「拍」。秒への換算は呼び出し側で行う。
export function readBeatmap(buf, name, initialBpm) {
  const map = parseJson(buf, name);
  const v = majorVersion(map);
  const warnings = [];
  const notes = []; // { beat, x, y, c, d, a }
  const bombs = []; // { beat, x, y }
  const walls = []; // { beat, durBeats, x, y, w, h }
  const bpmEvents = []; // { beat, bpm }

  if (v >= 4) {
    const nd = map.colorNotesData ?? [];
    for (const n of map.colorNotes ?? []) {
      const d = nd[n.i ?? 0] ?? {};
      notes.push({ beat: n.b ?? 0, x: d.x ?? 0, y: d.y ?? 0, c: d.c ?? 0, d: d.d ?? 0, a: d.a ?? 0 });
    }
    const bd = map.bombNotesData ?? [];
    for (const n of map.bombNotes ?? []) {
      const d = bd[n.i ?? 0] ?? {};
      bombs.push({ beat: n.b ?? 0, x: d.x ?? 0, y: d.y ?? 0 });
    }
    const od = map.obstaclesData ?? [];
    for (const o of map.obstacles ?? []) {
      const d = od[o.i ?? 0] ?? {};
      walls.push({ beat: o.b ?? 0, durBeats: d.d ?? 0, x: d.x ?? 0, y: d.y ?? 0, w: d.w ?? 1, h: d.h ?? 5 });
    }
    if ((map.arcs ?? []).length || (map.chains ?? []).length) warnings.push('アーク/チェーンは試作では未対応のため除外しました');
    if ((map.colorNotes ?? []).some((n) => n.r)) warnings.push('回転(360/90度譜面)の r は試作では無視しています');
  } else if (v === 3) {
    for (const n of map.colorNotes ?? []) {
      notes.push({ beat: n.b ?? 0, x: n.x ?? 0, y: n.y ?? 0, c: n.c ?? 0, d: n.d ?? 0, a: n.a ?? 0 });
    }
    for (const n of map.bombNotes ?? []) bombs.push({ beat: n.b ?? 0, x: n.x ?? 0, y: n.y ?? 0 });
    for (const o of map.obstacles ?? []) {
      walls.push({ beat: o.b ?? 0, durBeats: o.d ?? 0, x: o.x ?? 0, y: o.y ?? 0, w: o.w ?? 1, h: o.h ?? 5 });
    }
    for (const e of map.bpmEvents ?? []) bpmEvents.push({ beat: e.b ?? 0, bpm: e.m });
    if ((map.sliders ?? []).length || (map.burstSliders ?? []).length) warnings.push('アーク/チェーンは試作では未対応のため除外しました');
  } else {
    for (const n of map._notes ?? []) {
      const base = { beat: n._time ?? 0, x: n._lineIndex ?? 0, y: n._lineLayer ?? 0 };
      if (n._type === 3) bombs.push(base);
      else if (n._type === 0 || n._type === 1) notes.push({ ...base, c: n._type, d: n._cutDirection ?? 0, a: 0 });
    }
    for (const o of map._obstacles ?? []) {
      // _type 0 = 全高の壁, 1 = 上半分(しゃがみ壁), 2 = 2.6.0 の自由形状
      let y = 0, h = 5;
      if (o._type === 1) { y = 2; h = 3; }
      else if (o._type === 2) { y = o._lineLayer ?? 0; h = o._height ?? 5; }
      walls.push({ beat: o._time ?? 0, durBeats: o._duration ?? 0, x: o._lineIndex ?? 0, y, w: o._width ?? 1, h });
    }
    for (const e of map._events ?? []) {
      if (e._type === 100) bpmEvents.push({ beat: e._time ?? 0, bpm: e._floatValue });
    }
    const customBpm = map._BPMChanges ?? map._customData?._BPMChanges ?? map._customData?._bpmChanges;
    if (customBpm && customBpm.length) {
      warnings.push('MOD用の _BPMChanges があります。ゲーム本体と同じく公式 BPM イベント(_type 100)だけを使いました。タイミングがずれる場合は要確認');
    }
  }

  // Noodle Extensions などの位置上書きは試作では未対応
  const usesCustom = [...(map.colorNotes ?? []), ...(map._notes ?? [])].some((n) => n.customData || n._customData);
  if (usesCustom) warnings.push('ノーツに customData があります(MOD 依存の可能性)。試作では無視して標準の配置で表示します');

  return { version: map.version ?? map._version ?? '2.0.0', notes, bombs, walls, bpmEvents, warnings };
}

// 半ジャンプ時間(ノーツが出現してから判定位置に来るまでの拍数)
// コミュニティで広く使われている計算式に合わせている。
export function halfJumpBeats(bpm, njs, offset) {
  const beatSec = 60 / bpm;
  let hj = 4;
  while (njs * beatSec * hj > 17.999) hj /= 2;
  hj += offset;
  if (hj < 0.25) hj = 0.25;
  return hj;
}

const r5 = (x) => Math.round(x * 100000) / 100000;

// 1曲・1難易度を vrsaber-chart に変換する
export function convertMap(files, { characteristic = 'Standard', difficulty, songId, mapHash } = {}) {
  const get = makeFileLookup(files);
  const info = readInfo(files);
  const cands = info.difficulties.filter((d) => d.characteristic === characteristic);
  if (cands.length === 0) throw new Error(`特性 ${characteristic} の譜面がありません`);
  const diff = difficulty ? cands.find((d) => d.difficulty === difficulty) : cands[cands.length - 1];
  if (!diff) throw new Error(`難易度 ${difficulty} がありません。候補: ${cands.map((d) => d.difficulty).join(', ')}`);
  const buf = get(diff.filename);
  if (!buf) throw new Error(`譜面ファイル ${diff.filename} が ZIP 内にありません`);

  const bm = readBeatmap(buf, diff.filename, info.bpm);
  const warnings = [...bm.warnings];
  const bmMajor = parseInt(String(bm.version).split('.')[0], 10);

  let timeline;
  let timingSource;
  if (bmMajor >= 4 && info.audioDataFilename && get(info.audioDataFilename)) {
    const audio = parseJson(get(info.audioDataFilename), info.audioDataFilename);
    timeline = timelineFromAudioData(info.bpm, audio);
    timingSource = `audioData:${info.audioDataFilename}`;
  } else {
    timeline = timelineFromBpmEvents(info.bpm, bm.bpmEvents);
    timingSource = bm.bpmEvents.length ? 'bpmEvents' : 'infoBpm';
    if (info.audioDataFilename && get(info.audioDataFilename)) {
      // v2/v3 譜面に BPMInfo.dat が同梱されている場合、差があれば警告だけ出す
      const audio = parseJson(get(info.audioDataFilename), info.audioDataFilename);
      const alt = timelineFromAudioData(info.bpm, audio);
      const probe = bm.notes.length ? bm.notes[bm.notes.length - 1].beat : 0;
      const diffMs = Math.abs(alt.toSec(probe) - timeline.toSec(probe)) * 1000;
      if (diffMs > 1) warnings.push(`BPMInfo.dat と譜面内 BPM イベントで最終ノーツ時刻が ${diffMs.toFixed(1)}ms 異なります。譜面内イベントを採用しました(要確認)`);
    }
  }
  if (info.songTimeOffset) warnings.push(`_songTimeOffset=${info.songTimeOffset} はゲーム本体でも使われないため無視しました`);

  const toSec = timeline.toSec;
  const njs = diff.njs && diff.njs > 0 ? diff.njs : DEFAULT_NJS[diff.difficulty] ?? 10;
  const hj = halfJumpBeats(info.bpm, njs, diff.jumpOffset ?? 0);

  // 同じ時刻のノーツの順序を固定するため、時刻→x→y で安定ソートする
  const notes = bm.notes.map((n) => ({ ...n, t: toSec(n.beat) }))
    .sort((p, q) => p.t - q.t || p.x - q.x || p.y - q.y);
  const bombs = bm.bombs.map((n) => ({ ...n, t: toSec(n.beat) })).sort((p, q) => p.t - q.t);
  const walls = bm.walls.map((w) => {
    const t = toSec(w.beat);
    return { ...w, t, dur: toSec(w.beat + w.durBeats) - t };
  }).sort((p, q) => p.t - q.t);

  const localHash = computeMapHash(files, info);
  const hash = (mapHash || localHash).toLowerCase();
  const sid = songId || `local:${hash.slice(0, 10)}`;
  const last = Math.max(0, ...notes.map((n) => n.t), ...bombs.map((n) => n.t), ...walls.map((w) => w.t + w.dur));

  return {
    format: CHART_FORMAT,
    formatVersion: CHART_FORMAT_VERSION,
    // ---- 統計用の識別子(曲 / 譜面バージョン / 難易度を分ける) ----
    songId: sid,
    mapHash: hash,
    characteristic: diff.characteristic,
    difficulty: diff.difficulty,
    chartKey: `${sid}|${hash}|${diff.characteristic}|${diff.difficulty}`,
    // ---- 表示用 ----
    title: info.title,
    subTitle: info.subTitle,
    artist: info.artist,
    mappers: diff.mappers,
    // ---- 再生パラメータ ----
    sourceInfoVersion: info.infoVersion,
    sourceBeatmapVersion: bm.version,
    timingSource,
    bpm: info.bpm,
    bpmSegments: timeline.segments.map((s) => ({ beat: r5(s.beat), time: r5(s.time), bpm: r5(s.bpm) })),
    njs,
    jumpOffset: diff.jumpOffset ?? 0,
    halfJumpBeats: hj,
    spawnAhead: r5((hj * 60) / info.bpm),
    lastObjectTime: r5(last),
    counts: { notes: notes.length, bombs: bombs.length, walls: walls.length },
    // ---- 本体(平坦な数値配列。Udon の VRCJson で速く読めるようにするため) ----
    // notes: [t, x, y, c, d, a] の繰り返し(t は秒)
    notes: notes.flatMap((n) => [r5(n.t), n.x, n.y, n.c, n.d, n.a]),
    // bombs: [t, x, y]
    bombs: bombs.flatMap((n) => [r5(n.t), n.x, n.y]),
    // walls: [t, dur, x, y, w, h](t, dur は秒)
    walls: walls.flatMap((w) => [r5(w.t), r5(w.dur), w.x, w.y, w.w, w.h]),
    warnings,
    _source: { songFilename: info.songFilename, beatmapFilename: diff.filename },
  };
}

// BeatSaver と同じ考え方のハッシュ: Info.dat + 各難易度ファイルを連結した SHA-1。
// v4 では BeatSaver 側の計算対象が異なる可能性があるため、BeatSaver の hash が分かる場合はそちらを優先する。
export function computeMapHash(files, info) {
  const get = makeFileLookup(files);
  const h = createHash('sha1');
  h.update(info.infoBuf);
  const seen = new Set();
  for (const d of info.difficulties) {
    if (seen.has(d.filename)) continue;
    seen.add(d.filename);
    const b = get(d.filename);
    if (b) h.update(b);
  }
  return h.digest('hex');
}

export function listDifficulties(files) {
  return readInfo(files).difficulties.map((d) => `${d.characteristic}/${d.difficulty}`);
}
