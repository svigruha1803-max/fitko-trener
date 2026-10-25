# 💪 Mattyho fitko robůtek

Live AI fitness trenér: check-iny s fotkami postavy, chat s trenérem, plán do posilovny, log tréninků.

- Frontend: `index.html` (GitHub Pages)
- Backend: `worker.js` (Cloudflare Worker `fitko-trener`) — D1 `fitko-db`, KV `fitko-photos`, service binding `AI_SVC` → `plavecky-csps-scraper` `/ai`, secret `APP_PASSWORD`
- Model: `claude-sonnet-4-6`
