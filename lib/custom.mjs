// らばーず譜面(tools/chart-lab で作った譜面)を、置き場の曲にする。
// custom/<BeatSaver の番号>/ には Info.dat と譜面(.dat)だけを置く。音は BeatSaver の ZIP から取る(リポジトリに音を入れない)。
// BeatSaver の作者の譜面とは別の曲(別のスロット)として並べる。songId は "lovers:<番号>"、作者名は「らばーず譜面」。
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readZip } from './zip.mjs';

export const CUSTOM_AUTHOR = 'らばーず譜面';

// custom/ の下で、Info.dat がある曲の番号
export function listCustom(customRoot) {
  if (!existsSync(customRoot)) return [];
  return readdirSync(customRoot, { withFileTypes: true }).filter(d => d.isDirectory() && existsSync(join(customRoot, d.name, 'Info.dat'))).map(d => d.name);
}

// ZIP の中身(Map: 名前 → Buffer)に、custom の Info.dat と譜面を上書きする
export function overlayCustom(files, dir) {
  const out = new Map(files);
  for (const f of readdirSync(dir)) {
    if (f === 'source.json') continue;   // source.json は作ったときの記録なので入れない
    // 同じ名前のファイル(大文字・小文字ちがいや、フォルダの中のものも)は消してから置く。
    // GitHub の自動作業(Linux)では info.dat と Info.dat が別のファイルになり、元の作者の Info.dat が使われてしまうため
    for (const k of [...out.keys()]) if (k.split('/').pop().toLowerCase() === f.toLowerCase()) out.delete(k);
    out.set(f, readFileSync(join(dir, f)));
  }
  return out;
}

// custom/<番号>/ のファイルの中身から作る印。同じなら、前回作った置き場のファイルをそのまま使える
export function customKey(dir) {
  const h = createHash('sha1');
  h.update('v2');   // 作り方を直したら数字を変える(前回のファイルを使わず、全部作りなおす)。v2: 小文字の info.dat の直し
  for (const f of readdirSync(dir).sort()) { h.update(f); h.update(readFileSync(join(dir, f))); }
  return h.digest('hex').slice(0, 16);
}

// ダブルセイバー用の譜面(maul.json の中身)から、一覧の "maul" を作る。選べる難易度(やさしい順)もつける
export function maulEntry(m) {
  const order = ['Easy', 'Normal', 'Hard', 'Expert', 'ExpertPlus'];
  const diffs = [{ difficulty: m.difficulty, noteCount: m.counts?.notes ?? 0, chartKey: m.chartKey }, ...(m.diffs ?? []).map(x => ({ difficulty: x.difficulty, noteCount: x.counts?.notes ?? 0, chartKey: x.chartKey }))]
    .sort((x, y) => order.indexOf(x.difficulty) - order.indexOf(y.difficulty));
  return { characteristic: m.characteristic, difficulty: m.difficulty, label: 'Double Saber', noteCount: m.counts?.notes ?? 0, chartKey: m.chartKey, diffs };
}

// 1 曲を作る。うまくいけば一覧の 1 行(entry)、だめなら null(記録だけ残して、ほかの曲は続ける)
// ctx.prev: 前回の一覧のその曲の行。譜面のファイルが前回と同じなら、置き場(ctx.siteUrl)から取り直す(BeatSaver から作り直さない)
export async function buildCustom(bsid, ctx) {
  const { customRoot, out, slot, log = console.log, abr = '96k', genreFromTags = () => 'other', prev, siteUrl } = ctx;
  const get = ctx.fetch ?? fetch;
  let key = null;
  try { key = customKey(join(customRoot, bsid)); } catch (e) { log(`  らばーず譜面を作れませんでした: BeatSaver ${bsid}(${e.message})`); return null; }
  const dir = join(out, 'slots', String(slot).padStart(3, '0'));
  if (prev && siteUrl && prev.customKey === key) {
    try {
      mkdirSync(dir, { recursive: true });
      for (const f of prev.maul ? ['chart.json', 'audio.mp4', 'maul.json'] : ['chart.json', 'audio.mp4']) {
        const r = await get(`${siteUrl}slots/${String(prev.slot).padStart(3, '0')}/${f}`);
        if (!r.ok) throw new Error(f);
        writeFileSync(join(dir, f), Buffer.from(await r.arrayBuffer()));
      }
      if (prev.coverURL) { try { const cv = await get(prev.coverURL); if (cv.ok) writeFileSync(join(dir, 'cover.jpg'), Buffer.from(await cv.arrayBuffer())); } catch {} }
      return { ...prev, slot, reused: true };
    } catch { rmSync(dir, { recursive: true, force: true }); }   // 取り直せなければ、作り直す
  }
  let tmp = null;
  try {
    const r = await get(`https://api.beatsaver.com/maps/id/${bsid}`);
    if (!r.ok) throw new Error(`BeatSaver で見つかりません(HTTP ${r.status})`);
    const m = await r.json();
    // 作ったときと同じ版の音を使う(source.json の hash)。その版がもうなければ、譜面と音がずれるので使わない
    const srcP = join(customRoot, bsid, 'source.json');
    const want = existsSync(srcP) ? JSON.parse(readFileSync(srcP, 'utf8')).hash : null;
    const ver = want ? (m.versions ?? []).find(v => v.hash === want) : ((m.versions ?? []).find(v => v.state === 'Published') ?? m.versions?.[0]);
    if (!ver) throw new Error('作ったときの音の版が、BeatSaver にもうありません。作りなおしてください');
    const z = await get(ver.downloadURL);
    if (!z.ok) throw new Error(`ZIP を取れません(HTTP ${z.status})`);
    const files = overlayCustom(readZip(Buffer.from(await z.arrayBuffer())), join(customRoot, bsid));
    tmp = mkdtempSync(join(tmpdir(), 'lovers-'));
    for (const [name, data] of files) writeFileSync(join(tmp, name.split('/').pop()), data);
    const rights = `音: BeatSaver ${bsid}(${m.uploader?.name ?? ''} さん)・譜面: ${CUSTOM_AUTHOR}`;
    const genre = genreFromTags(m.tags);
    const c = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'convert.mjs'), tmp, '--slot', String(slot), '--diff', 'Normal', '--all-diffs', '--out', out, '--no-atlas', '--abr', abr, '--song-id', `lovers:${bsid}`, '--genre', genre, '--rights', rights], { stdio: 'ignore' });
    if (c.status !== 0 || !existsSync(join(dir, 'chart.json')) || !existsSync(join(dir, 'audio.mp4'))) throw new Error('変換に失敗しました');
    const ch = JSON.parse(readFileSync(join(dir, 'chart.json'), 'utf8'));
    const DiffOrder = ['Easy', 'Normal', 'Hard', 'Expert', 'ExpertPlus'];
    const diffs = [{ difficulty: ch.difficulty, noteCount: ch.counts?.notes ?? 0, chartKey: ch.chartKey }, ...(ch.diffs ?? []).map(x => ({ difficulty: x.difficulty, noteCount: x.counts?.notes ?? 0, chartKey: x.chartKey }))]
      .sort((x, y) => DiffOrder.indexOf(x.difficulty) - DiffOrder.indexOf(y.difficulty));
    // ダブルセイバーの譜面(Info.dat に Lawless の種類があるとき): maul.json に Easy・Normal・Hard を入れる
    let maul = null;
    const info = JSON.parse(readFileSync(join(customRoot, bsid, 'Info.dat'), 'utf8'));
    if ((info._difficultyBeatmapSets ?? []).some(x => x._beatmapCharacteristicName === 'Lawless')) {
      const mc = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'convert.mjs'), tmp, '--slot', String(slot), '--char', 'Lawless', '--diff', 'Normal', '--all-diffs', '--chart-only', '--chart-name', 'maul.json', '--out', out, '--song-id', `lovers:${bsid}`, '--rights', rights], { stdio: 'ignore' });
      if (mc.status === 0 && existsSync(join(dir, 'maul.json'))) maul = maulEntry(JSON.parse(readFileSync(join(dir, 'maul.json'), 'utf8')));
      else log(`  らばーず譜面のダブルセイバーを作れませんでした: BeatSaver ${bsid}`);
    }
    // ジャケット(まとめ画像を作るためだけ。置き場には置かない)
    try { const cv = await get(ver.coverURL); if (cv.ok) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'cover.jpg'), Buffer.from(await cv.arrayBuffer())); } } catch {}
    const md = m.metadata ?? {};
    return {
      slot, title: md.songName ?? m.name, subTitle: md.songSubName ?? '', artist: md.songAuthorName ?? '', mappers: [CUSTOM_AUTHOR],
      characteristic: 'Standard', difficulty: ch.difficulty, songId: `lovers:${bsid}`, mapHash: ch.mapHash ?? ver.hash, chartKey: ch.chartKey,
      noteCount: ch.counts?.notes ?? 0, bpm: md.bpm ?? 0, length: md.duration ?? 0, genre, cover: false, curated: false, ranked: false, custom: true, rights, diffs, customKey: key, coverURL: ver.coverURL, ...(maul ? { maul } : {}),
    };
  } catch (e) {
    log(`  らばーず譜面を作れませんでした: BeatSaver ${bsid}(${e.message})`);
    return null;
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}
