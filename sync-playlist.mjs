// BeatSaver のプレイリストを、ワールドの曲の一覧にそろえる。
//   node sync-playlist.mjs 1280881 --out ../../site-local
//   (プレイリストの URL https://beatsaver.com/playlists/1280881 の、最後の数字だけを入れる)
//
// やること:
//  1. BeatSaver からプレイリストの曲の一覧を読む(並び順もそのまま)
//  2. プレイリストの順に、スロット 1, 2, 3 … に入れる(スロット 0 の同期テストはそのまま)
//     - 前と同じ譜面(同じ版)がすでに同じスロットに入っていれば、取り直さない
//     - 新しい曲・版が変わった曲だけ、譜面の ZIP を取ってきて変換する(convert.mjs)
//  3. プレイリストから外れた曲は、曲の一覧(catalog.json)から外す
//  4. ジャケットのまとめ画像を作り直す
//  5. どのプレイリストか・最後に曲が変わった時刻を playlist.json に残す(serve.mjs が自動で見張るのに使う)
//
// オプション:
//   --diff Expert      … 遊ぶ難易度(なければ、それより下でいちばん難しいもの。それもなければいちばん易しいもの)
//   --force            … 同じ版でも取り直して変換し直す
//   --if-changed       … プレイリストの曲が前回から変わっていなければ、何もしない(自動の見張り用)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildAtlases } from './lib/covers.mjs';

const UA = { headers: { 'User-Agent': 'vrsaber-convert/0.1 (prototype)' } };
const DiffOrder = ['Easy', 'Normal', 'Hard', 'Expert', 'ExpertPlus'];

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

// プレイリストの番号: 数字だけでも、URL をそのまま貼っても受け付ける
function playlistIdOf(s) {
  const m = String(s ?? '').match(/(\d+)\s*\/?\s*$/);
  return m ? m[1] : null;
}

// BeatSaver のタグから、ワールドのジャンル(選曲パネルの左の列)を決める(ざっくり)
export function genreFromTags(tags) {
  const t = new Set(tags ?? []);
  if (t.has('vocaloid')) return 'vocaloid';
  if (t.has('anime')) return 'anime';
  if (t.has('j-pop') || t.has('j-rock')) return 'jpop';
  if (t.has('video-game-soundtrack') || t.has('soundtrack')) return 'game';
  const western = ['pop', 'rock', 'electronic', 'dance', 'hip-hop-rap', 'metal', 'alternative', 'indie', 'rb', 'punk', 'house', 'dubstep', 'drum-and-bass', 'techno', 'trance', 'funk-disco', 'jazz', 'folk-acoustic', 'soul', 'country', 'k-pop'];
  if (western.some((g) => t.has(g))) return 'western';
  return 'other';
}

// 遊ぶ難易度を決める(Standard のものだけ)
function pickDiff(diffs, want) {
  const std = (diffs ?? []).filter((d) => d.characteristic === 'Standard').map((d) => d.difficulty);
  if (std.length === 0) return null;
  if (std.includes(want)) return want;
  const wi = DiffOrder.indexOf(want);
  const lower = std.filter((d) => DiffOrder.indexOf(d) <= wi).sort((x, y) => DiffOrder.indexOf(y) - DiffOrder.indexOf(x));
  if (lower.length) return lower[0];
  return std.sort((x, y) => DiffOrder.indexOf(x) - DiffOrder.indexOf(y))[0];
}

async function fetchPlaylist(id) {
  const maps = [];
  let info = null;
  for (let page = 0; page < 50; page++) {
    const res = await fetch(`https://api.beatsaver.com/playlists/id/${id}/${page}`, UA);
    if (!res.ok) throw new Error(`プレイリスト ${id} を読めませんでした(BeatSaver: ${res.status})。番号と、公開になっているかを確かめてください`);
    const j = await res.json();
    info = info ?? j.playlist;
    const got = j.maps ?? [];
    for (const m of got) maps.push(m);
    if (got.length === 0 || maps.length >= (j.playlist?.stats?.totalMaps ?? 0)) break;
  }
  maps.sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
  return { info, maps: maps.map((m) => m.map) };
}

export async function syncPlaylist(id, opts = {}) {
  const outRoot = resolve(opts.out || join(import.meta.dirname, '..', '..', 'site'));
  const want = opts.diff || 'Expert';
  const statePath = join(outRoot, 'playlist.json');
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  const { info, maps } = await fetchPlaylist(id);
  if (opts.ifChanged && state.playlistId === id && state.songsChangedAt && state.songsChangedAt === (info?.songsChangedAt ?? info?.updatedAt)) {
    console.log(`プレイリスト ${id}「${info?.name}」は前回から変わっていません`);
    return { changed: false };
  }
  console.log(`プレイリスト ${id}「${info?.name}」: ${maps.length} 曲`);

  const catPath = join(outRoot, 'catalog.json');
  const readCat = () => (existsSync(catPath) ? JSON.parse(readFileSync(catPath, 'utf8')) : { format: 'vrsaber-catalog', formatVersion: 1, slots: [] });
  const done = [];
  let slot = 1;
  for (const m of maps) {
    const ver = (m.versions ?? []).find((v) => v.state === 'Published') ?? m.versions?.[0];
    const diff = ver ? pickDiff(ver.diffs, want) : null;
    if (!ver || !diff) { console.warn(`  とばしました: ${m.name}(Standard の譜面がありません)`); continue; }
    const genre = genreFromTags(m.tags);
    const cur = readCat().slots.find((s) => s.slot === slot);
    const audioOk = existsSync(join(outRoot, 'slots', String(slot).padStart(3, '0'), 'audio.mp4'));
    if (!opts.force && cur && cur.mapHash === ver.hash && cur.difficulty === diff && audioOk) {
      // 同じ譜面がもう入っている: ジャンルだけそろえる
      if (cur.genre !== genre) { const c = readCat(); c.slots.find((s) => s.slot === slot).genre = genre; writeFileSync(catPath, JSON.stringify(c, null, 1)); }
      console.log(`  スロット ${slot}: ${m.name}(そのまま)`);
    } else {
      console.log(`  スロット ${slot}: ${m.name} [${diff}] を取り込みます`);
      const r = spawnSync(process.execPath, [join(import.meta.dirname, 'convert.mjs'), '--bsr', m.id, '--slot', String(slot), '--diff', diff, '--genre', genre, '--out', outRoot, '--no-atlas',
        '--rights', `BeatSaver プレイリスト ${id} から自動取り込み(私的検証のみ)。譜面: ${m.uploader?.name ?? ''} さん(BeatSaver ${m.id})`], { stdio: 'inherit' });
      if (r.status !== 0) { console.warn(`  !! スロット ${slot}: ${m.name} を取り込めませんでした。とばします`); continue; }
    }
    done.push(slot);
    slot++;
  }
  // プレイリストから外れた曲を、曲の一覧から外す(スロット 0 の同期テストは残す)
  const cat = readCat();
  const before = cat.slots.length;
  cat.slots = cat.slots.filter((s) => s.slot === 0 || done.includes(s.slot));
  if (cat.slots.length !== before) console.log(`  プレイリストにない ${before - cat.slots.length} 曲を、曲の一覧から外しました`);
  const cv = buildAtlases(outRoot, cat);
  writeFileSync(catPath, JSON.stringify(cat, null, 1));
  console.log(`ジャケット: ${cv.count} 曲分をまとめ画像にしました`);
  writeFileSync(statePath, JSON.stringify({ playlistId: id, name: info?.name ?? '', songsChangedAt: info?.songsChangedAt ?? info?.updatedAt ?? '', syncedAt: new Date().toISOString(), slots: done.length, diff: want }, null, 1));
  if (slot - 1 > 49) console.warn(`!! 曲が ${slot - 1} 曲あります。Unity の「2. URL 設定」の曲スロット数を ${slot} 以上にして、ワールドを作り直してください`);
  console.log(`完了: ${done.length} 曲をワールドの曲の一覧にそろえました`);
  return { changed: true, count: done.length };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const a = parseArgs(process.argv.slice(2));
  const id = playlistIdOf(a._[0] ?? a.id);
  if (!id) {
    console.log('使い方: node sync-playlist.mjs <プレイリストの番号 または URL> [--out ../../site-local] [--diff Expert] [--force] [--if-changed]');
    process.exit(1);
  }
  syncPlaylist(id, { out: a.out, diff: a.diff, force: !!a.force, ifChanged: !!a['if-changed'] })
    .catch((e) => { console.error(`エラー: ${e.message}`); process.exit(1); });
}
