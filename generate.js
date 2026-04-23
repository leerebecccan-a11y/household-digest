import fetch from 'node-fetch';
import fs from 'fs';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const WEATHER_KEY = process.env.OPENWEATHER_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const GH_REPO = 'leerebeccaan-a11y/household-digest';

const NOTION_HEADERS = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json'
};

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const today = new Date();
const todayDay = DAYS[today.getDay()];
const dateStr = today.toLocaleDateString('en-US', {
  weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
});

// ── Data fetchers ─────────────────────────────────────────────────────────────

async function getWeather() {
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=Alfred,ME,US&appid=${WEATHER_KEY}&units=imperial`;
    const res = await fetch(url);
    const d = await res.json();
    if (!d.main) throw new Error('Bad response');
    return {
      temp: Math.round(d.main.temp),
      high: Math.round(d.main.temp_max),
      low: Math.round(d.main.temp_min),
      desc: d.weather[0].description,
      humidity: d.main.humidity,
      wind: Math.round(d.wind.speed)
    };
  } catch {
    return { temp: '--', high: '--', low: '--', desc: 'unavailable', humidity: '--', wind: '--' };
  }
}

async function getMeals() {
  const res = await fetch('https://api.notion.com/v1/databases/24fdceb70b9f813db6a1c6b878d17553/query', {
    method: 'POST',
    headers: NOTION_HEADERS,
    body: JSON.stringify({
      filter: { property: 'Day of the week', title: { equals: todayDay } }
    })
  });
  const data = await res.json();
  const dayRow = data.results?.[0];
  if (!dayRow) return [];
  const relations = dayRow.properties.Meals?.relation || [];
  const meals = [];
  for (const rel of relations) {
    const mRes = await fetch(`https://api.notion.com/v1/pages/${rel.id}`, { headers: NOTION_HEADERS });
    const mData = await mRes.json();
    const name = mData.properties['Meal Name']?.title?.[0]?.plain_text || '';
    const tags = (mData.properties.Tags?.multi_select || []).map(t => t.name);
    if (name) meals.push({ name, tags });
  }
  return meals;
}

async function getClaudeContent(meals, weather) {
  const mealText = meals.length > 0 ? meals.map(m => m.name).join(' + ') : 'nothing planned';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: `You write a warm household digest for Bec and Nic in Alfred, Maine.
Return ONLY a JSON object, no markdown fences, no extra text:
{
  "prepNote": "one warm sentence about when to start dinner prep to eat by 6:30pm",
  "newsletterTitle": "title of an interesting article about outdoors, cooking, nature, or fascinating facts",
  "newsletterSummary": "two warm sentences summarizing why they would enjoy it"
}`,
        messages: [{ role: 'user', content: `Today is ${todayDay}. Dinner: ${mealText}. Weather: ${weather.desc}, ${weather.temp}F.` }]
      })
    });
    const d = await res.json();
    const text = d.content?.[0]?.text || '{}';
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return {
      prepNote: 'Start prep around 5:45pm to have dinner ready by 6:30.',
      newsletterTitle: 'The quiet magic of spring in coastal Maine',
      newsletterSummary: 'A lovely read on the season\'s rhythms along the Maine coast. Perfect with a morning coffee.'
    };
  }
}

// ── HTML builder ──────────────────────────────────────────────────────────────

function buildHtml(weather, meals, claude) {
  const mealHtml = meals.length > 0
    ? `<div class="meal-name">${meals.map(m => m.name).join(' + ')}</div>
       <div class="meal-tags">${[...new Set(meals.flatMap(m => m.tags))].slice(0,4).map(t => `<span class="meal-tag">${t}</span>`).join('')}</div>
       <div class="reminder-banner"><div class="rdot"></div><div class="rtext">${claude.prepNote}</div></div>`
    : `<p class="meal-empty">No meal planned yet — <a href="https://www.notion.so/Weekly-meal-planner-24fdceb70b9f801c8f01fb06b7c93b5b" target="_blank">add one in Notion ↗</a></p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Household Digest · ${todayDay}</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;1,400&family=Lato:wght@300;400;700&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --cream:#FAF7F2;--warm-white:#FDF9F4;--sand:#E8DDD0;
  --terracotta:#C4714A;--tl:#E8A882;--tp:#F5E6DC;
  --umber:#8B6148;--bark:#5C3D2E;--sage:#7A9E7E;--sp:#EAF2EB;
  --forest:#4A7C5F;--fp:#E6F0EB;
  --ink:#2C2018;--is:#8C7A6A;--im:#B5A898;--div:rgba(92,61,46,0.12)
}
body{font-family:'Lato',sans-serif;background:var(--cream);color:var(--ink);padding-bottom:2rem}
.header{background:var(--bark);padding:1.5rem 1.25rem 1.25rem;overflow:hidden;position:relative}
.header::before{content:'';position:absolute;top:-40px;right:-40px;width:140px;height:140px;border-radius:50%;background:rgba(255,255,255,0.04)}
.htop{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:.75rem}
.greeting{font-family:'Playfair Display',serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--tl);margin-bottom:4px}
.day{font-family:'Playfair Display',serif;font-size:26px;font-weight:500;color:#FDF9F4;line-height:1.1}
.dsub{font-size:12px;font-weight:300;color:rgba(253,249,244,0.55);margin-top:3px}
.wb{text-align:right}
.wtemp{font-family:'Playfair Display',serif;font-size:36px;font-weight:400;color:#FDF9F4;line-height:1}
.wdesc{font-size:11px;font-weight:300;color:rgba(253,249,244,0.6);margin-top:2px;text-transform:capitalize}
.wloc{font-size:10px;color:rgba(253,249,244,0.4);margin-top:1px}
.wstrip{display:flex;gap:6px;flex-wrap:wrap;margin-top:.75rem}
.wpill{background:rgba(255,255,255,0.08);border:.5px solid rgba(255,255,255,0.12);border-radius:20px;padding:4px 10px;font-size:10px;color:rgba(253,249,244,0.7);font-weight:300}
.wpill span{color:var(--tl);font-weight:400}
.content{padding:0 1rem}
.section{margin-top:1.25rem}
.sh{display:flex;align-items:center;justify-content:space-between;margin-bottom:.6rem}
.sl{font-size:9px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:var(--im);padding-left:2px}
.nl{font-size:10px;color:var(--terracotta);text-decoration:none}
.card{background:var(--warm-white);border:.5px solid var(--sand);border-radius:14px;padding:1rem 1.125rem}
.badge{display:inline-flex;align-items:center;gap:4px;font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--sage);background:var(--sp);border-radius:10px;padding:3px 8px}
.bdot{width:5px;height:5px;border-radius:50%;background:var(--sage);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.notion-embed{width:100%;height:600px;border:none;border-radius:14px}
.meal-card{background:var(--tp);border:.5px solid rgba(196,113,74,.2);border-radius:14px;padding:1rem 1.125rem}
.meyebrow{font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--terracotta);margin-bottom:4px}
.meal-name{font-family:'Playfair Display',serif;font-size:20px;font-weight:500;color:var(--bark);line-height:1.2;margin-bottom:6px}
.meal-tags{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:10px}
.meal-tag{font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:2px 7px;border-radius:8px;background:rgba(196,113,74,.15);color:var(--umber)}
.meal-empty{font-size:13px;color:var(--umber);font-style:italic}
.meal-empty a{color:var(--terracotta)}
.reminder-banner{background:var(--bark);border-radius:10px;padding:9px 12px;display:flex;align-items:center;gap:8px}
.rdot{width:6px;height:6px;border-radius:50%;background:var(--tl);flex-shrink:0;animation:pulse 2s infinite}
.rtext{font-size:11px;color:rgba(253,249,244,.85);font-weight:300;line-height:1.4}
.ni{padding:8px 0;border-bottom:.5px solid var(--div)}
.ni:last-child{border-bottom:none;padding-bottom:0}
.ni:first-child{padding-top:0}
.nsrc{font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--terracotta);margin-bottom:3px}
.nhed{font-size:13px;color:var(--ink);line-height:1.4}
.rcard{background:var(--fp);border:.5px solid rgba(74,124,95,.2);border-radius:14px;padding:1rem 1.125rem;margin-top:.5rem}
.reyebrow{font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--forest);margin-bottom:5px}
.rtitle{font-family:'Playfair Display',serif;font-size:15px;font-style:italic;color:var(--bark);line-height:1.35;margin-bottom:5px}
.rbody{font-size:12px;color:var(--is);line-height:1.5;font-weight:300}
.refresh-btn{display:block;width:calc(100% - 2rem);margin:1.25rem 1rem 0;background:var(--bark);color:#FDF9F4;border:none;border-radius:12px;padding:14px;font-family:'Lato',sans-serif;font-size:13px;font-weight:400;letter-spacing:.5px;cursor:pointer;transition:opacity .2s}
.refresh-btn:active{opacity:.8}
.refresh-btn.loading{opacity:.6;cursor:not-allowed}
.footer{margin-top:1rem;padding:0 1rem;text-align:center;font-size:10px;color:var(--im);font-weight:300}
</style>
</head>
<body>

<div class="header">
  <div class="htop">
    <div>
      <div class="greeting">Good morning, Bec & Nic</div>
      <div class="day">${todayDay}</div>
      <div class="dsub">${dateStr}</div>
    </div>
    <div class="wb">
      <div class="wtemp">${weather.temp}°</div>
      <div class="wdesc">${weather.desc}</div>
      <div class="wloc">Alfred, Maine</div>
    </div>
  </div>
  <div class="wstrip">
    <div class="wpill">High <span>${weather.high}°</span></div>
    <div class="wpill">Low <span>${weather.low}°</span></div>
    <div class="wpill">Wind <span>${weather.wind}mph</span></div>
    <div class="wpill">Humidity <span>${weather.humidity}%</span></div>
  </div>
</div>

<div class="content">

  <div class="section">
    <div class="sh">
      <div style="display:flex;align-items:center;gap:8px">
        <div class="sl">Chores · ${todayDay}</div>
        <div class="badge"><div class="bdot"></div>Live Notion</div>
      </div>
      <a class="nl" href="https://www.notion.so/Weekly-Cleaning-Checklist-343dceb70b9f801b86abffe4b092a172" target="_blank">Open ↗</a>
    </div>
    <iframe
      class="notion-embed"
      src="https://honored-tangerine-e9d.notion.site/Weekly-Cleaning-Checklist-343dceb70b9f801b86abffe4b092a172"
      allowfullscreen>
    </iframe>
  </div>

  <div class="section">
    <div class="sh">
      <div class="sl">Dinner tonight</div>
      <a class="nl" href="https://www.notion.so/Weekly-meal-planner-24fdceb70b9f801c8f01fb06b7c93b5b" target="_blank">Open ↗</a>
    </div>
    <div class="meal-card">
      <div class="meyebrow">From your Notion meal plan</div>
      ${mealHtml}
    </div>
  </div>

  <div class="section">
    <div class="sl" style="margin-bottom:.6rem">Morning headlines</div>
    <div class="card">
      <div class="ni"><div class="nsrc">Associated Press</div><div class="nhed">Top national and world headlines for today</div></div>
      <div class="ni"><div class="nsrc">Reuters</div><div class="nhed">Markets and economic news</div></div>
      <div class="ni"><div class="nsrc">BBC News</div><div class="nhed">International headlines and top stories</div></div>
    </div>
    <div class="rcard">
      <div class="reyebrow">Today's read</div>
      <div class="rtitle">"${claude.newsletterTitle}"</div>
      <div class="rbody">${claude.newsletterSummary}</div>
    </div>
  </div>

</div>

<button class="refresh-btn" id="refreshBtn" onclick="triggerRebuild()">
  Refresh digest
</button>

<div class="footer" id="footer">Auto-generated at 6am · ${dateStr}</div>

<script>
function triggerRebuild() {
  const btn = document.getElementById('refreshBtn');
  btn.textContent = 'Opening GitHub Actions...';
  window.open('https://github.com/${GH_REPO}/actions/workflows/daily-digest.yml', '_blank');
  setTimeout(() => {
    btn.textContent = 'Refresh digest';
  }, 2000);
}
</script>
</body>
</html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Generating digest for ${todayDay}...`);
  const [weather, meals] = await Promise.all([getWeather(), getMeals()]);
  console.log(`Weather: ${weather.temp}°, Meals: ${meals.length}`);
  const claude = await getClaudeContent(meals, weather);
  const html = buildHtml(weather, meals, claude);
  fs.mkdirSync('./out', { recursive: true });
  fs.writeFileSync('./out/index.html', html);
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
