// らばーず譜面(tools/chart-lab で作った譜面)を、置き場の曲にする。
// custom/<BeatSaver の番号>/ には Info.dat と譜面(.dat)だけを置く。音は BeatSaver の ZIP から取る(リポジトリに音を入れない)。
// BeatSaver の作者の譜面とは別の曲(別のスロット)として並べる。songId は "lovers:<番号>"、作者名は「らばーず譜面」。
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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
  for (const f of readdirSync(dir)) if (f !== 'source.json') out.set(f, readFileSync(join(dir, f)));   // source.json は作ったときの記録なので入れない
  return out;
}

// 1 曲を作る。うまくいけば一覧の 1 行(entry)、だめなら null(記録だけ残して、ほかの曲は続ける)
export async function buildCustom(bsid, ctx) {
  const { customRoot, out, slot, log = console.log, abr = '96k', genreFromTags = () => 'other' } = ctx;
  const get = ctx.fetch ?? fetch;
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
    const dir = join(out, 'slots', String(slot).padStart(3, '0'));
    if (c.status !== 0 || !existsSync(join(dir, 'chart.json')) || !existsSync(join(dir, 'audio.mp4'))) throw new Error('変換に失敗しました');
    const ch = JSON.parse(readFileSync(join(dir, 'chart.json'), 'utf8'));
    const DiffOrder = ['Easy', 'Normal', 'Hard', 'Expert', 'ExpertPlus'];
    const diffs = [{ difficulty: ch.difficulty, noteCount: ch.counts?.notes ?? 0, chartKey: ch.chartKey }, ...(ch.diffs ?? []).map(x => ({ difficulty: x.difficulty, noteCount: x.counts?.notes ?? 0, chartKey: x.chartKey }))]
      .sort((x, y) => DiffOrder.indexOf(x.difficulty) - DiffOrder.indexOf(y.difficulty));
    // ジャケット(まとめ画像を作るためだけ。置き場には置かない)
    try { const cv = await get(ver.coverURL); if (cv.ok) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'cover.jpg'), Buffer.from(await cv.arrayBuffer())); } } catch {}
    const md = m.metadata ?? {};
    return {
      slot, title: md.songName ?? m.name, subTitle: md.songSubName ?? '', artist: md.songAuthorName ?? '', mappers: [CUSTOM_AUTHOR],
      characteristic: 'Standard', difficulty: ch.difficulty, songId: `lovers:${bsid}`, mapHash: ch.mapHash ?? ver.hash, chartKey: ch.chartKey,
      noteCount: ch.counts?.notes ?? 0, bpm: md.bpm ?? 0, length: md.duration ?? 0, genre, cover: false, curated: false, ranked: false, custom: true, rights, diffs,
    };
  } catch (e) {
    log(`  らばーず譜面を作れませんでした: BeatSaver ${bsid}(${e.message})`);
    return null;
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}
