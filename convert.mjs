// 譜面 ZIP(またはフォルダ)を、VRChat ワールドが読み込む「スロット」形式に変換する。
//
// 出力(--out で指定したフォルダ。既定は ../../site):
//   slots/000/chart.json   … 秒単位に換算した譜面(VRCStringDownloader で読む)
//   slots/000/audio.mp4    … 音源(黒い小さな映像 + AAC 音声。VRChat の動画プレイヤーで再生する)
//   catalog.json           … スロット一覧(選曲画面用)
//
// 使い方の例:
//   node convert.mjs testmaps/synctest-v3.zip --slot 0
//   node convert.mjs 譜面.zip --slot 1 --diff Expert --song-id bsr:abcd --rights "作者の許諾あり(URL)"
//   node convert.mjs --bsr 3ce39 --slot 3 --diff Expert --genre vocaloid   … ジャンル(選曲パネルの左の列)を付ける
//   node convert.mjs --bsr abcd --slot 2 --diff Hard      … BeatSaver から ZIP を取得して変換
//   node convert.mjs 譜面.zip --list                      … 収録されている難易度を表示
//   node convert.mjs --bsr abcd --slot 2 --char NoArrows --diff Expert --chart-name maul.json --chart-only
//                                                          … 譜面だけを別の名前で書き出す(音・ジャケット・一覧は作らない。ダブルセイバー用の譜面など)
//   --all-diffs  … ほかの難易度も chart.json の "diffs" に入れる(ワールドで難易度を選べるように)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readZip } from './lib/zip.mjs';
import { convertMap, listDifficulties, makeFileLookup, readInfo } from './lib/beatmap.mjs';
import { buildAtlases, saveCover } from './lib/covers.mjs';

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (s.startsWith('--')) {
      const k = s.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) a[k] = true; else { a[k] = next; i++; }
    } else a._.push(s);
  }
  return a;
}

function loadFiles(path) {
  if (statSync(path).isDirectory()) {
    const m = new Map();
    const walk = (dir) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p); else m.set(relative(path, p).replaceAll('\\', '/'), readFileSync(p));
      }
    };
    walk(path);
    return m;
  }
  return readZip(readFileSync(path));
}

async function downloadFromBeatSaver(id, dir) {
  // BeatSaver API: GET https://api.beatsaver.com/maps/id/{id}
  const res = await fetch(`https://api.beatsaver.com/maps/id/${encodeURIComponent(id)}`, { headers: { 'User-Agent': 'vrsaber-convert/0.1 (prototype)' } });
  if (!res.ok) throw new Error(`BeatSaver API エラー: ${res.status}`);
  const map = await res.json();
  const ver = (map.versions ?? []).find((v) => v.state === 'Published') ?? map.versions?.[0];
  if (!ver) throw new Error('公開済みのバージョンが見つかりません');
  console.log(`BeatSaver: ${map.name} / mapper ${map.uploader?.name} / hash ${ver.hash}`);
  mkdirSync(dir, { recursive: true });
  const zipPath = join(dir, `${id}-${ver.hash}.zip`);
  if (!existsSync(zipPath)) {   // 前に取ってきた同じ版の ZIP があれば、それを使う
    const zipRes = await fetch(ver.downloadURL, { headers: { 'User-Agent': 'vrsaber-convert/0.1 (prototype)' } });
    if (!zipRes.ok) throw new Error(`ZIP の取得に失敗: ${zipRes.status}`);
    writeFileSync(zipPath, Buffer.from(await zipRes.arrayBuffer()));
  }
  return { zipPath, songId: `bsr:${map.id}`, mapHash: ver.hash, beatsaver: { id: map.id, name: map.name, uploader: map.uploader?.name, hash: ver.hash } };
}

function findFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  return r.status === 0;
}

// 音源を「64x64 の黒映像 + AAC 音声」の mp4 にする。
// 音声だけのファイルは VRChat の動画プレイヤーで扱いが不安定な可能性があるため、念のため映像トラックを付ける。
// 曲の先頭位置は変えない(トリミングや無音追加はしない)。
// 映像は Windows の再生(Media Foundation)で扱いやすい H.264 baseline にする。
// -shortest だけでは映像が少し長くなるため、音声の長さを測って映像をその長さで切る。
function audioDuration(input) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'format=duration', '-of', 'csv=p=0', input], { encoding: 'utf8' });
  const d = parseFloat(r.stdout);
  return r.status === 0 && d > 0 ? d : null;
}

// abr = 音の質(ビットレート)。小さくするほどファイルが小さくなる(無料の置き場にたくさん入れるときは 80k)
function encodeAudio(input, output, abr = '192k') {
  const dur = audioDuration(input);
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=2',   // 映像は黒い四角(1 秒に 2 枚)。ファイルを小さくするため
    '-i', input,
    '-map', '0:v', '-map', '1:a:0',
    '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.0', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', abr, '-ar', '48000',
    ...(dur ? ['-t', dur.toFixed(3)] : []),
    '-shortest', '-movflags', '+faststart',
    output,
  ];
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg の変換に失敗しました:\n${r.stderr}`);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const outRoot = resolve(a.out || join(import.meta.dirname, '..', '..', 'site'));
  let input = a._[0];
  let songId = a['song-id'];
  let mapHash = a.hash;
  let beatsaver = null;

  if (a.bsr) {
    const d = await downloadFromBeatSaver(a.bsr, join(import.meta.dirname, 'downloads'));
    input = d.zipPath; songId = songId || d.songId; mapHash = mapHash || d.mapHash; beatsaver = d.beatsaver;
  }
  if (!input) {
    console.log('使い方: node convert.mjs <譜面.zip またはフォルダ> --slot 0 [--diff Expert] [--char Standard] [--song-id bsr:xxxx] [--rights "利用条件"] [--no-audio] [--genre vocaloid|anime|jpop|game|western|other]');
    process.exit(1);
  }
  const files = loadFiles(input);
  if (a.list) {
    console.log(listDifficulties(files).join('\n'));
    return;
  }

  const chart = convertMap(files, { characteristic: a.char || 'Standard', difficulty: a.diff, songId, mapHash });
  const slot = parseInt(a.slot ?? '0', 10);
  const slotName = String(slot).padStart(3, '0');
  const slotDir = join(outRoot, 'slots', slotName);
  mkdirSync(slotDir, { recursive: true });

  chart.slot = slot;
  chart.rights = a.rights || '';
  if (beatsaver) chart.beatsaver = beatsaver;
  // --all-diffs: ほかの難易度(Standard で、ダブルセイバー用でないもの)も、同じファイルの "diffs" に入れる。
  // --char で Standard 以外(らばーず譜面のダブルセイバー用 Lawless など)を選んだときは、その種類の難易度を全部入れる。
  // いちばん上の譜面(--diff で選んだもの)はそのまま(前のワールドは、いちばん上だけを読む)。ファイルの数は増えない
  if (a['all-diffs']) {
    const isMaulLabel = (d) => /maul|darth|double ?saber|(^|[^a-z])dm([^a-z]|$)/i.test(d.customData?._difficultyLabel ?? d.customData?.difficultyLabel ?? '');
    chart.diffs = [];
    const ch = a.char || 'Standard';
    for (const d of readInfo(files).difficulties) {
      if (d.characteristic !== ch || d.difficulty === chart.difficulty || (ch === 'Standard' && isMaulLabel(d))) continue;
      if (chart.diffs.some((x) => x.difficulty === d.difficulty)) continue;
      try {
        const c = convertMap(files, { characteristic: ch, difficulty: d.difficulty, songId, mapHash });
        chart.diffs.push({ difficulty: c.difficulty, chartKey: c.chartKey, njs: c.njs, spawnAhead: c.spawnAhead, lastObjectTime: c.lastObjectTime, counts: c.counts, notes: c.notes, bombs: c.bombs, walls: c.walls });
      } catch (e) { console.warn(`  注意: ${d.difficulty} を変換できませんでした(${e.message})`); }
    }
    const order = ['Easy', 'Normal', 'Hard', 'Expert', 'ExpertPlus'];
    chart.diffs.sort((x, y) => order.indexOf(x.difficulty) - order.indexOf(y.difficulty));
  }
  const { _source, ...publicChart } = chart;
  writeFileSync(join(slotDir, a['chart-name'] || 'chart.json'), JSON.stringify(publicChart));
  if (a['chart-only']) {
    console.log(`スロット ${slotName}: ${a['chart-name'] || 'chart.json'} [${chart.characteristic}/${chart.difficulty}] ノーツ ${chart.counts.notes}`);
    return;
  }

  // 音源
  const info = readInfo(files);
  const audioBuf = makeFileLookup(files)(info.songFilename);
  if (!a['no-audio']) {
    if (!audioBuf) throw new Error(`音源 ${info.songFilename} が見つかりません`);
    if (findFfmpeg()) {
      // 元の音源は一時フォルダで変換し、配信フォルダには残さない
      const tmp = mkdtempSync(join(tmpdir(), 'vrsaber-'));
      const tmpIn = join(tmp, `source_${info.songFilename.replace(/[^\w.]/g, '_')}`);
      writeFileSync(tmpIn, audioBuf);
      try { encodeAudio(tmpIn, join(slotDir, 'audio.mp4'), a.abr || '192k'); } finally { rmSync(tmp, { recursive: true, force: true }); }
      console.log('音源: audio.mp4 を作成しました');
    } else {
      console.warn('!! ffmpeg が見つからないため audio.mp4 を作れませんでした。docs/01_環境準備.md の「ffmpeg を入れる」を行ってから再実行してください。');
    }
  }

  // ジャケット画像(サムネイル)
  if (saveCover(makeFileLookup(files), info.coverFilename, slotDir)) console.log('ジャケット: ' + info.coverFilename + ' を保存しました');

  // カタログ更新
  const catPath = join(outRoot, 'catalog.json');
  const cat = existsSync(catPath) ? JSON.parse(readFileSync(catPath, 'utf8')) : { format: 'vrsaber-catalog', formatVersion: 1, slots: [] };
  const prevEntry = cat.slots.find((s) => s.slot === slot);
  cat.slots = cat.slots.filter((s) => s.slot !== slot);
  cat.slots.push({
    slot, title: chart.title, subTitle: chart.subTitle, artist: chart.artist, mappers: chart.mappers,
    characteristic: chart.characteristic, difficulty: chart.difficulty,
    songId: chart.songId, mapHash: chart.mapHash, chartKey: chart.chartKey,
    noteCount: chart.counts.notes, bpm: chart.bpm, length: chart.lastObjectTime, rights: chart.rights,
    // ジャンル(選曲パネルの左の列): vocaloid / anime / jpop / game / western / other
    genre: a.genre || prevEntry?.genre || 'other',
  });
  cat.slots.sort((x, y) => x.slot - y.slot);
  if (!a['no-atlas'] && findFfmpeg()) { const cv = buildAtlases(outRoot, cat); console.log(`ジャケット: ${cv.count} 曲分をまとめ画像にしました(covers/)`); }
  writeFileSync(catPath, JSON.stringify(cat, null, 1));

  console.log(`スロット ${slotName}: ${chart.title} [${chart.characteristic}/${chart.difficulty}] ノーツ ${chart.counts.notes} / 爆弾 ${chart.counts.bombs} / 壁 ${chart.counts.walls}`);
  console.log(`  chartKey: ${chart.chartKey}`);
  console.log(`  タイミング元: ${chart.timingSource} / NJS ${chart.njs} / 出現 ${chart.spawnAhead}s 前`);
  for (const w of chart.warnings) console.warn(`  注意: ${w}`);
  if (!chart.rights) console.warn('  注意: --rights(利用条件)が未記入です。公開サーバーに置く前に、音源と譜面の利用条件を確認して記入してください。');
}

main().catch((e) => { console.error(`エラー: ${e.message}`); process.exit(1); });
