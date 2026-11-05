// 置き場に入りきらないときに、減らす曲を決める。
// 決まり(ユーザーとの約束): 守る曲(protected: うどんセイバーの曲・らばーず譜面・ユーザーが足した/頼んだ曲)は、決して消さない。
// 減らすのは、それ以外の曲を、BeatSaver の評価(stats.score)の低いほうから。
export function trimToFit(maps, limit) {
  if (maps.length <= limit) return { kept: maps, dropped: [], over: 0 };
  const prot = maps.filter(m => m.protected).length;
  const room = Math.max(0, limit - prot);
  const others = maps.filter(m => !m.protected).sort((a, b) => (b.stats?.score ?? 0) - (a.stats?.score ?? 0));
  const keep = new Set(others.slice(0, room).map(m => m.id));
  const kept = maps.filter(m => m.protected || keep.has(m.id));
  const dropped = maps.filter(m => !m.protected && !keep.has(m.id));
  return { kept, dropped, over: Math.max(0, prot - limit) };
}
