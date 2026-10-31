// Cloudflare Pages に置く曲のファイルを作る(GitHub Actions が、決まった時間ごとに動かす)。
//   node build-site.mjs [--out site]
// 設定は publish.config.json:
//   siteUrl     … 公開している住所(https://○○.pages.dev/)。前回置いたファイルを、ここから取り直して使い回す
//   playlists   … 入れる BeatSaver のプレイリストの番号(先に書いたものから順に入れる)
//   topRated    … プレイリストのあとに足す、BeatSaver の評価の高い順の曲の数
//   maxSongs    … 入れる曲のいちばん多い数(ワールドに埋め込んだスロット数 - 1 以下)
//   difficulty  … 遊ぶ難易度(なければ、それより下でいちばん難しいもの)
//   audioBitrate… 音の質(80k なら 1 曲 1.5MB ほど)
//
// 同じ曲は、前回と同じスロットに置く(遊んでいる途中の人の曲が入れ替わらないように)。
// 前回と同じ曲・同じ版は、前回のファイルを取り直して使い、新しい曲だけ BeatSaver から取ってきて変える
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildAtlases } from './lib/covers.mjs';
import { genreFromTags } from './sync-playlist.mjs';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const out = resolve(outIdx >= 0 ? args[outIdx + 1] : join(import.meta.dirname, 'site'));
const cfgIdx = args.indexOf('--config');
const cfg = JSON.parse(readFileSync(join(import.meta.dirname, cfgIdx >= 0 ? args[cfgIdx + 1] : 'publish.config.json'), 'utf8'));
const siteUrl = (cfg.siteUrl || '').replace(/\/?$/, '/');
const UA = { headers: { 'User-Agent': 'vrsaber-publish/0.1' } };
const DiffOrder = ['Easy', 'Normal', 'Hard', 'Expert', 'ExpertPlus'];
const slotDir = (n) => join(out, 'slots', String(n).padStart(3, '0'));
const log = (s) => console.log(s);

async function getJson(url) {
  const r = await fetch(url, UA);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

function pickDiff(diffs, want) {
  const std = (diffs ?? []).filter((d) => d.characteristic === 'Standard');
  if (!std.length) return null;
  const names = std.map((d) => d.difficulty);
  let pick = names.includes(want) ? want : null;
  if (!pick) {
    const wi = DiffOrder.indexOf(want);
    pick = names.filter((d) => DiffOrder.indexOf(d) <= wi).sort((x, y) => DiffOrder.indexOf(y) - DiffOrder.indexOf(x))[0]
      ?? names.sort((x, y) => DiffOrder.indexOf(x) - DiffOrder.indexOf(y))[0];
  }
  return std.find((d) => d.difficulty === pick);
}

// 入れる曲を決める: プレイリストの曲 → 評価の高い順(同じ曲は 1 回だけ)
async function collectMaps() {
  const maps = [];
  const seen = new Set();
  const add = (m) => { if (m && !seen.has(m.id) && maps.length < cfg.maxSongs) { seen.add(m.id); maps.push(m); } };
  // いちばん先に入れる曲(うどんセイバーの曲など。BeatSaver の番号の一覧のファイル)。この曲は置き場に入りきらなくても減らさない
  for (const f of cfg.priorityIdFiles ?? []) {
    const j = JSON.parse(readFileSync(join(import.meta.dirname, f), 'utf8'));
    const ids = Array.isArray(j) ? j : [...(j.sure ?? []), ...(j.check ?? [])];
    for (let i = 0; i < ids.length; i += 50) {
      const r = await getJson(`https://api.beatsaver.com/maps/ids/${ids.slice(i, i + 50).join(',')}`);
      for (const id of ids.slice(i, i + 50)) add(r[id]);
    }
    log(`${f}: いま ${maps.length} 曲`);
  }
  for (const id of cfg.playlists ?? []) {
    for (let page = 0; page < 100; page++) {
      const j = await getJson(`https://api.beatsaver.com/playlists/id/${id}/${page}`);
      const got = (j.maps ?? []).sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
      for (const x of got) add(x.map);
      if (!got.length) break;
    }
    log(`プレイリスト ${id}: いま ${maps.length} 曲`);
  }
  // プレイリストのあとに、評価の高い順で topRated 曲を足す。
  // 置き場に入りきらないときは、プレイリストの曲は残し、評価順の曲のほうを減らして帳尻を合わせる
  // (1 曲 = 譜面と曲の 2 ファイル。ほかに 一覧・まとめ画像・同期テストの分を残しておく)
  const fileRoom = Math.floor(((cfg.maxFiles ?? 19000) - 40) / 2);
  const goal = Math.min(cfg.maxSongs, fileRoom, maps.length + (cfg.topRated ?? 0));
  if (maps.length + (cfg.topRated ?? 0) > goal) log(`置き場に入りきらないので、評価順の曲を ${maps.length + (cfg.topRated ?? 0) - goal} 曲減らします`);
  for (let page = 0; maps.length < goal && page < 200; page++) {
    const j = await getJson(`https://api.beatsaver.com/search/text/${page}?sortOrder=Rating&pageSize=100`);
    if (!(j.docs ?? []).length) break;
    for (const m of j.docs) if (maps.length < goal) add(m);
  }
  return maps;
}

async function main() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'slots'), { recursive: true });

  // 前回置いた一覧(スロットの並びを保つため)
  let prev = { slots: [] };
  if (siteUrl.startsWith('http')) { try { prev = await getJson(siteUrl + 'catalog.json'); log(`前回の一覧: ${prev.slots.length} 曲`); } catch { log('前回の一覧はありません(初めて)'); } }
  const prevById = new Map(prev.slots.filter((s) => s.songId?.startsWith('bsr:')).map((s) => [s.songId.slice(4), s]));

  const maps = await collectMaps();
  log(`入れる曲: ${maps.length} 曲`);

  // スロットを決める: 前回と同じ曲は同じスロット、新しい曲は空いているスロット(0 は同期テスト)
  const used = new Set([0]);
  const plan = [];
  for (const m of maps) { const p = prevById.get(m.id); if (p && !used.has(p.slot)) { used.add(p.slot); plan.push({ m, slot: p.slot, prev: p }); } else plan.push({ m, slot: -1 }); }
  let next = 1;
  for (const p of plan) if (p.slot < 0) { while (used.has(next)) next++; p.slot = next; used.add(next); }

  // スロット 0: 同期テスト(自作のクリック音)
  const r0 = spawnSync(process.execPath, [join(import.meta.dirname, 'convert.mjs'), join(import.meta.dirname, 'testmaps', 'synctest-v3.zip'), '--slot', '0', '--out', out, '--no-atlas', '--abr', cfg.audioBitrate, '--rights', '自作クリック音・自作譜面', '--genre', 'other'], { stdio: 'inherit' });
  if (r0.status !== 0) throw new Error('同期テストを作れませんでした');
  const slots = [JSON.parse(readFileSync(join(out, 'catalog.json'), 'utf8')).slots.find((s) => s.slot === 0)];
  slots[0].title = '同期テスト クリック';

  let reused = 0, made = 0, failed = 0, later = 0;
  const started = Date.now();
  const budgetMs = (cfg.maxMinutes ?? 300) * 60000;   // GitHub Actions は 1 回 6 時間まで。新しい曲を変えるのは、この時間まで(残りは次の回)
  for (const p of plan) {
    const m = p.m;
    const ver = (m.versions ?? []).find((v) => v.state === 'Published') ?? m.versions?.[0];
    const d = ver ? pickDiff(ver.diffs, cfg.difficulty) : null;
    if (!ver || !d) { failed++; continue; }
    const dir = slotDir(p.slot);
    mkdirSync(dir, { recursive: true });
    const md = m.metadata ?? {};
    const entry = {
      slot: p.slot, title: md.songName ?? m.name, subTitle: md.songSubName ?? '', artist: md.songAuthorName ?? '', mappers: [md.levelAuthorName ?? m.uploader?.name ?? ''],
      characteristic: 'Standard', difficulty: d.difficulty, songId: `bsr:${m.id}`, mapHash: ver.hash, chartKey: `bsr:${m.id}|${ver.hash}|Standard|${d.difficulty}`,
      noteCount: d.notes ?? 0, bpm: md.bpm ?? 0, length: md.duration ?? 0, genre: genreFromTags(m.tags), cover: false, rights: `BeatSaver ${m.id}(${m.uploader?.name ?? ''} さん)`,
    };
    // 前回と同じ版・同じ難易度なら、前回のファイルを取り直す
    let ok = false;
    if (p.prev && p.prev.mapHash === ver.hash && p.prev.difficulty === d.difficulty) {
      try {
        for (const f of ['chart.json', 'audio.mp4']) {
          const r = await fetch(`${siteUrl}slots/${String(p.slot).padStart(3, '0')}/${f}`, UA);
          if (!r.ok) throw new Error(f);
          writeFileSync(join(dir, f), Buffer.from(await r.arrayBuffer()));
        }
        ok = true; reused++;
      } catch {}
    }
    if (!ok && Date.now() - started > budgetMs) { later++; rmSync(dir, { recursive: true, force: true }); continue; }
    if (!ok) {
      const r = spawnSync(process.execPath, [join(import.meta.dirname, 'convert.mjs'), '--bsr', m.id, '--slot', String(p.slot), '--diff', d.difficulty, '--out', out, '--no-atlas', '--abr', cfg.audioBitrate, '--genre', entry.genre, '--rights', entry.rights], { stdio: 'ignore' });
      ok = r.status === 0 && existsSync(join(dir, 'chart.json')) && existsSync(join(dir, 'audio.mp4'));
      if (ok) made++; else { failed++; rmSync(dir, { recursive: true, force: true }); log(`  とばしました: ${entry.title}(BeatSaver ${m.id})`); continue; }
    }
    // ジャケット(まとめ画像を作るためだけに使う。置き場には置かない)
    try {
      const r = await fetch(ver.coverURL, UA);
      if (r.ok) writeFileSync(join(dir, 'cover.jpg'), Buffer.from(await r.arrayBuffer()));
    } catch {}
    slots.push(entry);
    if ((reused + made) % 50 === 0) log(`  ${reused + made} 曲(使い回し ${reused} / 新しく ${made})`);
  }
  slots.sort((x, y) => x.slot - y.slot);
  const total = (await getJson('https://api.beatsaver.com/search/text/0?pageSize=1')).info?.total ?? 0;
  const cat = { format: 'vrsaber-catalog', formatVersion: 1, source: 'beatsaver', total, slots };
  buildAtlases(out, cat);
  // 置き場には、曲・譜面・まとめ画像・一覧だけを置く(ジャケットの元の画像は置かない)
  for (const s of slots) for (const f of ['cover.jpg', 'cover.png']) { const p = join(slotDir(s.slot), f); if (existsSync(p)) unlinkSync(p); }
  writeFileSync(join(out, 'catalog.json'), JSON.stringify(cat));
  writeFileSync(join(out, '_headers'), '/*\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=300\n');
  log(`できました: ${slots.length - 1} 曲(使い回し ${reused} / 新しく ${made} / とばした ${failed} / 次の回へ ${later})`);
}

main().catch((e) => { console.error(`エラー: ${e.message}`); process.exit(1); });
