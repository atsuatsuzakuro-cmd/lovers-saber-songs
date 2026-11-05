// Cloudflare Pages に置く曲のファイルを作る(GitHub Actions が、決まった時間ごとに動かす)。
//   node build-site.mjs [--out site]
// 設定は publish.config.json:
//   siteUrl     … 公開している住所(https://○○.pages.dev/)。前回置いたファイルを、ここから取り直して使い回す
//   playlists   … 入れる BeatSaver のプレイリストの番号(先に書いたものから順に入れる)
//   topRated    … プレイリストのあとに足す、BeatSaver の評価の高い順の曲の数
//   maxSongs    … 入れる曲のいちばん多い数(ワールドに埋め込んだスロット数 - 1 以下)
//   difficulty  … いちばん上に置く(はじめに選ばれている)難易度(なければ、それより下でいちばん難しいもの)。
//                 ほかの難易度も chart.json の "diffs" に入れ、一覧の "diffs" に選べる難易度を書く(ワールドで選べる)
//   audioBitrate… 音の質(80k なら 1 曲 1.5MB ほど)
//
// ダブルセイバー(ダース・モール)用の譜面: BeatSaver には専用の種類がなく、作者が難易度の名前に
// 「MAUL SPIN」「Darth Maul」「DoubleSaber」「Two Hand DM」などと書いて区別している。
// ふつうの譜面にはこれを選ばず、ある曲では slots/NNN/maul.json として別に置く(音は chart.json と同じ audio.mp4)
//
// 同じ曲は、前回と同じスロットに置く(遊んでいる途中の人の曲が入れ替わらないように)。
// 前回と同じ曲・同じ版は、前回のファイルを取り直して使い、新しい曲だけ BeatSaver から取ってきて変える
import { listCustom, buildCustom } from './lib/custom.mjs';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync, unlinkSync, statfsSync } from 'node:fs';
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
// 試しに少しだけ作るとき(--max 10 など): いちばん多い曲数をその数にする
const maxIdx = args.indexOf('--max');
if (maxIdx >= 0 && parseInt(args[maxIdx + 1], 10) > 0) cfg.maxSongs = parseInt(args[maxIdx + 1], 10);
const UA = { headers: { 'User-Agent': 'vrsaber-publish/0.1' } };
const DiffOrder = ['Easy', 'Normal', 'Hard', 'Expert', 'ExpertPlus'];
const slotDir = (n) => join(out, 'slots', String(n).padStart(3, '0'));
const log = (s) => console.log(s);
// BeatSaver から取ってきた ZIP(1 つ 6MB くらい)。曲を変えたらすぐ消す。
// 残しておくと、GitHub のパソコンの空き(14GB くらい)がいっぱいになって、途中で止まってしまう
const dropZips = () => rmSync(join(import.meta.dirname, 'downloads'), { recursive: true, force: true });
const freeBytes = () => { try { const st = statfsSync(out); return st.bavail * st.bsize; } catch { return Infinity; } };
const freeGB = () => { const b = freeBytes(); return b === Infinity ? '?' : (b / 1073741824).toFixed(1); };
// 空きがこれより少なくなったら、新しい曲を作るのをやめて、そこまでの分を必ず Cloudflare に置く(空きがなくなって全部むだになるのを防ぐ)
const MinFree = 3 * 1073741824;
let lowSpaceTold = false;
const lowSpace = () => { const low = freeBytes() < MinFree; if (low && !lowSpaceTold) { lowSpaceTold = true; log(`空きが ${freeGB()}GB になったので、新しい曲はここまで(残りは次の回)`); } return low; };

// BeatSaver に断られた(混んでいる・続けて頼みすぎた)ときは、少し待ってやり直す
async function getJson(url) {
  let last = '';
  for (let t = 0; t < 6; t++) {
    try {
      const r = await fetch(url, UA);
      if (r.ok) return await r.json();
      last = String(r.status);
      if (r.status === 404) break;
    } catch (e) { last = e.message; }
    await new Promise((res) => setTimeout(res, 2000 * 2 ** t));
  }
  throw new Error(`${url}: ${last}`);
}

const isMaul = (d) => /maul|darth|double ?saber|(^|[^a-z])dm([^a-z]|$)/i.test(d.label ?? '');

// 難易度を選ぶ: want があればそれ、なければそれより下でいちばん難しいもの
function pickByDifficulty(cands, want) {
  if (!cands.length) return null;
  const names = cands.map((d) => d.difficulty);
  let pick = names.includes(want) ? want : null;
  if (!pick) {
    const wi = DiffOrder.indexOf(want);
    pick = names.filter((d) => DiffOrder.indexOf(d) <= wi).sort((x, y) => DiffOrder.indexOf(y) - DiffOrder.indexOf(x))[0]
      ?? names.sort((x, y) => DiffOrder.indexOf(x) - DiffOrder.indexOf(y))[0];
  }
  return cands.find((d) => d.difficulty === pick);
}

// ふつうの譜面(Standard で、ダブルセイバー用でないもの)
const pickDiff = (diffs, want) => pickByDifficulty((diffs ?? []).filter((d) => d.characteristic === 'Standard' && !isMaul(d)), want);

// ダブルセイバー用の譜面(なければ null)。Standard を優先し、なければ NoArrows など、ほかの種類から選ぶ
function pickMaul(diffs, want) {
  const all = (diffs ?? []).filter(isMaul);
  const std = all.filter((d) => d.characteristic === 'Standard');
  return pickByDifficulty(std.length ? std : all.filter((d) => d.characteristic === (all[0]?.characteristic)), want);
}

// 入れる曲を決める: プレイリストの曲 → 評価の高い順(同じ曲は 1 回だけ)
async function collectMaps() {
  const maps = [];
  const seen = new Set();
  // 自動で作った譜面(BeatSaver の automapper の印や、AI で作ったという申告があるもの)は、どこから来ても入れない
  let aiSkipped = 0, modSkipped = 0;
  const isAi = (m) => m.automapper === true || (m.declaredAi && m.declaredAi !== 'None');
  // 特別な改造(Noodle Extensions・Mapping Extensions)がないと遊べない譜面と、壁だけの譜面も、ワールドではこわれるので入れない
  const needsMod = (m) => { const v = (m.versions ?? []).find((x) => x.state === 'Published') ?? m.versions?.[0]; const std = (v?.diffs ?? []).filter((d) => d.characteristic === 'Standard'); return std.length > 0 && std.every((d) => d.ne || d.me); };
  const wallOnly = (m) => /wall ?map/i.test(m.name ?? '');
  const add = (m) => { if (m && !seen.has(m.id) && maps.length < cfg.maxSongs) { seen.add(m.id); if (isAi(m)) { aiSkipped++; log(`  自動で作った譜面なので入れません: ${m.name}(BeatSaver ${m.id})`); return; }
    if (needsMod(m) || wallOnly(m)) { modSkipped++; return; } maps.push(m); } };
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
  const fileRoom = Math.floor(((cfg.maxFiles ?? 19000) - 40) / 2);   // ダブルセイバー用の譜面(数十〜数百)は、maxFiles と Cloudflare の上限 20000 のすき間に入る
  const goal = Math.min(cfg.maxSongs, fileRoom, maps.length + (cfg.topRated ?? 0));
  if (maps.length + (cfg.topRated ?? 0) > goal) log(`置き場に入りきらないので、評価順の曲を ${maps.length + (cfg.topRated ?? 0) - goal} 曲減らします`);
  // まず、BeatSaver の運営が選んだ譜面(キュレーション)を評価の高い順に curatedFirst 曲まで入れる(雑な譜面が少ない)
  const curGoal = Math.min(goal, maps.length + (cfg.curatedFirst ?? 0));
  for (let page = 0; maps.length < curGoal && page < 200; page++) {
    let j;
    try { j = await getJson(`https://api.beatsaver.com/search/text/${page}?sortOrder=Rating&curated=true&pageSize=100`); }
    catch (e) { log(`キュレーションの ${page + 1} ページ目を読めませんでした(${e.message})。評価順に進みます`); break; }
    await new Promise((res) => setTimeout(res, 300));
    if (!(j.docs ?? []).length) break;
    for (const m of j.docs) if (maps.length < curGoal) add(m);
  }
  log(`キュレーションの曲まで: いま ${maps.length} 曲`);
  for (let page = 0; maps.length < goal && page < 200; page++) {
    let j;
    try { j = await getJson(`https://api.beatsaver.com/search/text/${page}?sortOrder=Rating&pageSize=100`); }
    catch (e) { log(`人気順の ${page + 1} ページ目を読めませんでした(${e.message})。ここまでの曲で進めます`); break; }
    await new Promise((res) => setTimeout(res, 300));
    if (!(j.docs ?? []).length) break;
    for (const m of j.docs) if (maps.length < goal) add(m);
  }
  log(`自動で作った譜面なので入れなかった曲: ${aiSkipped} 曲。改造が要る譜面・壁だけの譜面で入れなかった曲: ${modSkipped} 曲`);
  return maps;
}

async function main() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'slots'), { recursive: true });

  // 前回置いた一覧(スロットの並びを保つため)
  let prev = { slots: [] };
  if (siteUrl.startsWith('http')) { try { prev = await getJson(siteUrl + 'catalog.json'); log(`前回の一覧: ${prev.slots.length} 曲`); } catch { log('前回の一覧はありません(初めて)'); } }
  const prevById = new Map(prev.slots.filter((s) => s.songId?.startsWith('bsr:')).map((s) => [s.songId.slice(4), s]));

  // --custom-only: らばーず譜面だけを作る(手元で確かめる用)
  const maps = args.includes('--custom-only') ? [] : await collectMaps();
  // らばーず譜面(custom/<番号>/)。入りきらないときは、BeatSaver の曲(優先度の低い後ろのほう)を減らす
  const customRoot = join(import.meta.dirname, 'custom');
  const customIds = listCustom(customRoot);
  if (customIds.length && maps.length + customIds.length > cfg.maxSongs) { maps.length = Math.max(0, cfg.maxSongs - customIds.length); log(`らばーず譜面 ${customIds.length} 曲のぶん、BeatSaver の曲を減らしました`); }
  log(`入れる曲: ${maps.length} 曲 + らばーず譜面 ${customIds.length} 曲`);

  // スロットを決める: 前回と同じ曲は同じスロット、新しい曲は空いているスロット(0 は同期テスト)
  const used = new Set([0]);
  const plan = [];
  for (const m of maps) { const p = prevById.get(m.id); if (p && !used.has(p.slot)) { used.add(p.slot); plan.push({ m, slot: p.slot, prev: p }); } else plan.push({ m, slot: -1 }); }
  const prevCustom = new Map(prev.slots.filter((s) => s.songId?.startsWith('lovers:')).map((s) => [s.songId.slice(7), s.slot]));
  const customPlan = customIds.map((id) => { const ps = prevCustom.get(id); if (ps !== undefined && !used.has(ps)) { used.add(ps); return { id, slot: ps }; } return { id, slot: -1 }; });
  let next = 1;
  for (const p of plan) if (p.slot < 0) { while (used.has(next)) next++; p.slot = next; used.add(next); }
  for (const p of customPlan) if (p.slot < 0) { while (used.has(next)) next++; p.slot = next; used.add(next); }

  // スロット 0: 同期テスト(自作のクリック音)
  const r0 = spawnSync(process.execPath, [join(import.meta.dirname, 'convert.mjs'), join(import.meta.dirname, 'testmaps', 'synctest-v3.zip'), '--slot', '0', '--out', out, '--no-atlas', '--abr', cfg.audioBitrate, '--rights', '自作クリック音・自作譜面', '--genre', 'other'], { stdio: 'inherit' });
  if (r0.status !== 0) throw new Error('同期テストを作れませんでした');
  const slots = [JSON.parse(readFileSync(join(out, 'catalog.json'), 'utf8')).slots.find((s) => s.slot === 0)];
  slots[0].title = '同期テスト クリック';

  let reused = 0, made = 0, failed = 0, later = 0, maulCount = 0, upgraded = 0;
  const started = Date.now();
  const budgetMs = (cfg.maxMinutes ?? 300) * 60000;   // GitHub Actions は 1 回 6 時間まで。新しい曲を変えるのは、この時間まで(残りは次の回)
  for (const p of plan) {
    const m = p.m;
    const ver = (m.versions ?? []).find((v) => v.state === 'Published') ?? m.versions?.[0];
    const d = ver ? pickDiff(ver.diffs, cfg.difficulty) : null;
    if (!ver || !d) { failed++; if (ver && pickMaul(ver.diffs, cfg.difficulty)) log(`  とばしました(ダブルセイバー用の譜面しかない): ${m.name}(BeatSaver ${m.id})`); continue; }
    const mDiff = pickMaul(ver.diffs, cfg.difficulty);
    const dir = slotDir(p.slot);
    mkdirSync(dir, { recursive: true });
    const md = m.metadata ?? {};
    const entry = {
      slot: p.slot, title: md.songName ?? m.name, subTitle: md.songSubName ?? '', artist: md.songAuthorName ?? '', mappers: [md.levelAuthorName ?? m.uploader?.name ?? ''],
      characteristic: 'Standard', difficulty: d.difficulty, songId: `bsr:${m.id}`, mapHash: ver.hash, chartKey: `bsr:${m.id}|${ver.hash}|Standard|${d.difficulty}`,
      noteCount: d.notes ?? 0, bpm: md.bpm ?? 0, length: md.duration ?? 0, genre: genreFromTags(m.tags), cover: false, curated: !!m.curator, ranked: !!(m.ranked || m.blRanked), rights: `BeatSaver ${m.id}(${m.uploader?.name ?? ''} さん)`,
    };
    if (mDiff) entry.maul = { characteristic: mDiff.characteristic, difficulty: mDiff.difficulty, label: mDiff.label ?? '', noteCount: mDiff.notes ?? 0, chartKey: `bsr:${m.id}|${ver.hash}|${mDiff.characteristic}|${mDiff.difficulty}` };
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
      // 前の形(難易度が 1 つだけ)の譜面なら、時間が残っているうちに、譜面だけ「全部の難易度入り」に作り直す(音は作らないので速い)。
      // 作り直せなかった曲は、前の譜面のまま置き、次の回にまた試す
      if (ok && !p.prev.diffs && Date.now() - started <= budgetMs && !lowSpace()) {
        const r = spawnSync(process.execPath, [join(import.meta.dirname, 'convert.mjs'), '--bsr', m.id, '--slot', String(p.slot), '--diff', d.difficulty, '--chart-only', '--all-diffs', '--out', out, '--rights', entry.rights], { stdio: 'ignore' });
        if (r.status === 0) upgraded++;
      }
    }
    if (!ok && (Date.now() - started > budgetMs || lowSpace())) { later++; rmSync(dir, { recursive: true, force: true }); continue; }
    if (!ok) {
      const r = spawnSync(process.execPath, [join(import.meta.dirname, 'convert.mjs'), '--bsr', m.id, '--slot', String(p.slot), '--diff', d.difficulty, '--all-diffs', '--out', out, '--no-atlas', '--abr', cfg.audioBitrate, '--genre', entry.genre, '--rights', entry.rights], { stdio: 'ignore' });
      ok = r.status === 0 && existsSync(join(dir, 'chart.json')) && existsSync(join(dir, 'audio.mp4'));
      if (ok) made++; else { failed++; dropZips(); rmSync(dir, { recursive: true, force: true }); log(`  とばしました: ${entry.title}(BeatSaver ${m.id})`); continue; }
    }
    // 一覧に、選べる難易度(いちばん上の譜面と "diffs" の分)を書く。前の形の譜面のままなら書かない(次の回に作り直す印)
    try {
      const ch = JSON.parse(readFileSync(join(dir, 'chart.json'), 'utf8'));
      if (Array.isArray(ch.diffs)) {
        entry.diffs = [{ difficulty: ch.difficulty, noteCount: ch.counts?.notes ?? 0, chartKey: ch.chartKey }, ...ch.diffs.map((x) => ({ difficulty: x.difficulty, noteCount: x.counts?.notes ?? 0, chartKey: x.chartKey }))];
        entry.diffs.sort((x, y) => DiffOrder.indexOf(x.difficulty) - DiffOrder.indexOf(y.difficulty));
      }
    } catch {}
    // ジャケット(まとめ画像を作るためだけに使う。置き場には置かない)
    try {
      const r = await fetch(ver.coverURL, UA);
      if (r.ok) writeFileSync(join(dir, 'cover.jpg'), Buffer.from(await r.arrayBuffer()));
    } catch {}
    // ダブルセイバー用の譜面: 前回と同じものなら取り直し、なければ譜面だけ変える(音は作らないので速い)
    if (entry.maul) {
      let mok = false;
      const pm = p.prev?.maul;
      if (pm && p.prev.mapHash === ver.hash && pm.characteristic === mDiff.characteristic && pm.difficulty === mDiff.difficulty) {
        try {
          const r = await fetch(`${siteUrl}slots/${String(p.slot).padStart(3, '0')}/maul.json`, UA);
          if (r.ok) { writeFileSync(join(dir, 'maul.json'), Buffer.from(await r.arrayBuffer())); mok = true; }
        } catch {}
      }
      if (!mok) {
        const r = spawnSync(process.execPath, [join(import.meta.dirname, 'convert.mjs'), '--bsr', m.id, '--slot', String(p.slot), '--char', mDiff.characteristic, '--diff', mDiff.difficulty, '--chart-name', 'maul.json', '--chart-only', '--out', out, '--rights', entry.rights], { stdio: 'ignore' });
        mok = r.status === 0 && existsSync(join(dir, 'maul.json'));
      }
      if (mok) maulCount++; else delete entry.maul;
    }
    dropZips();
    slots.push(entry);
    if ((reused + made) % 50 === 0) log(`  ${reused + made} 曲(使い回し ${reused} / 新しく ${made})・空き ${freeGB()}GB`);
  }
  // らばーず譜面(音は BeatSaver の ZIP から。取れない曲は、とばして記録する)
  let customMade = 0;
  for (const p of customPlan) {
    const entry = await buildCustom(p.id, { customRoot, out, slot: p.slot, abr: cfg.audioBitrate, genreFromTags, log });
    if (entry) { slots.push(entry); customMade++; }
  }
  if (customPlan.length) log(`らばーず譜面: ${customMade} / ${customPlan.length} 曲`);
  slots.sort((x, y) => x.slot - y.slot);
  const total = (await getJson('https://api.beatsaver.com/search/text/0?pageSize=1')).info?.total ?? 0;
  const cat = { format: 'vrsaber-catalog', formatVersion: 1, source: 'beatsaver', total, slots };
  buildAtlases(out, cat);
  // 置き場には、曲・譜面・まとめ画像・一覧だけを置く(ジャケットの元の画像は置かない)
  for (const s of slots) for (const f of ['cover.jpg', 'cover.png']) { const p = join(slotDir(s.slot), f); if (existsSync(p)) unlinkSync(p); }
  writeFileSync(join(out, 'catalog.json'), JSON.stringify(cat));
  writeFileSync(join(out, '_headers'), '/*\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=300\n');
  // 曲さがしのページと遊び方ガイド(web/ の中身を、置き場のいちばん上にそのまま置く。数ファイルだけ)
  const webDir = join(import.meta.dirname, 'web');
  if (existsSync(webDir)) for (const f of readdirSync(webDir)) copyFileSync(join(webDir, f), join(out, f));
  log(`できました: ${slots.length - 1} 曲(使い回し ${reused} / 新しく ${made} / とばした ${failed} / 次の回へ ${later})。ダブルセイバー用の譜面がある曲: ${maulCount} 曲。全部の難易度入りに作り直した曲: ${upgraded} 曲(選べる曲 ${slots.filter((s) => s.diffs).length} 曲)`);
}

main().catch((e) => { console.error(`エラー: ${e.message}`); process.exit(1); });
