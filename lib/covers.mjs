// 曲のジャケット画像(サムネイル)をまとめる。
// VRChat の画像の読み込みは「5 秒に 1 回まで」なので、1 曲ずつではなく、256 曲分を 1 枚の大きな画像(2048x2048)にまとめて配る。
//   slots/NNN/cover.jpg(または .png) … その曲のジャケットの元の画像(変換のときに譜面の zip から取り出す)
//   covers/atlas_000.png               … スロット 0〜255 のジャケットを 128x128 ずつ 16 列 × 16 段に並べたもの(左上がスロット 0)
//   covers/atlas_001.png               … スロット 256〜511 …
// catalog.json の各スロットには、ジャケットがあれば "cover": true を付ける
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const Tile = 128;
export const PerRow = 16;
export const PerAtlas = PerRow * PerRow;
const Size = Tile * PerRow;

// 譜面の zip の中のジャケット画像を、スロットのフォルダに cover.<拡張子> で保存する。保存したら true
export function saveCover(lookup, coverFilename, slotDir) {
  if (!coverFilename) return false;
  const buf = lookup(coverFilename);
  if (!buf) return false;
  const ext = coverFilename.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
  for (const old of ['cover.jpg', 'cover.png']) if (old !== `cover.${ext}` && existsSync(join(slotDir, old))) unlinkSync(join(slotDir, old));   // 拡張子が変わったら古いほうは消す
  writeFileSync(join(slotDir, `cover.${ext}`), buf);
  return true;
}

export function findCover(slotDir) {
  for (const name of ['cover.jpg', 'cover.png']) {
    const p = join(slotDir, name);
    if (existsSync(p) && readFileSync(p).length > 0) return p;
  }
  return null;
}

// 画像を 128x128 の RGBA の生データにする(真ん中を正方形に切り抜く)
function decodeTile(path) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', path,
    '-vf', `scale=${Tile}:${Tile}:force_original_aspect_ratio=increase,crop=${Tile}:${Tile}`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 || !r.stdout || r.stdout.length !== Tile * Tile * 4) return null;
  return r.stdout;
}

// catalog の全スロットのジャケットをまとめ直す。catalog の slots に cover: true/false を書き込む(保存は呼ぶ側)
export function buildAtlases(outRoot, cat) {
  const dir = join(outRoot, 'covers');
  mkdirSync(dir, { recursive: true });
  const atlases = new Map();   // 番号 → 生データ
  let count = 0;
  for (const s of cat.slots) {
    const p = findCover(join(outRoot, 'slots', String(s.slot).padStart(3, '0')));
    const tile = p ? decodeTile(p) : null;
    s.cover = !!tile;
    if (!tile) continue;
    const a = Math.floor(s.slot / PerAtlas), t = s.slot % PerAtlas;
    if (!atlases.has(a)) atlases.set(a, Buffer.alloc(Size * Size * 4));
    const buf = atlases.get(a);
    const x0 = (t % PerRow) * Tile, y0 = Math.floor(t / PerRow) * Tile;
    for (let y = 0; y < Tile; y++) tile.copy(buf, ((y0 + y) * Size + x0) * 4, y * Tile * 4, (y + 1) * Tile * 4);
    count++;
  }
  // 前に作ったまとめ画像のうち、もう使わないものはそのまま残す(読み込まれないだけ)
  for (const [a, buf] of atlases) {
    const out = join(dir, `atlas_${String(a).padStart(3, '0')}.png`);
    const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${Size}x${Size}`, '-i', '-', '-frames:v', '1', out],
      { input: buf, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`ジャケットのまとめ画像を作れませんでした:\n${r.stderr}`);
  }
  return { count, atlases: [...atlases.keys()].sort((x, y) => x - y), files: readdirSync(dir) };
}
