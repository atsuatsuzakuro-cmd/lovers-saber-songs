# lovers-saber-songs

VRChat ワールド「Lover's Saber」の曲の置き場を作る仕組み。

GitHub Actions が 6 時間ごとに BeatSaver から譜面・曲・ジャケットを取ってきて、
ワールドで流せる形に変え、Cloudflare Pages(lovers-saber.pages.dev)に置く。

- 入れる曲の設定: `publish.config.json`
- いちばん先に入れる曲(BeatSaver の番号): `udon-ids.json`、ダブルセイバーの譜面がある曲 `maul-ids.json`(BeatSaver の全曲から、譜面の名前で探した 74 曲)
- 動かす: Actions → publish-songs → Run workflow

必要な Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
