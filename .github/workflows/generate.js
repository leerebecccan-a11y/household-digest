import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const WEATHER_KEY = process.env.OPENWEATHER_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;

const NOTION_HEADERS = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': '2022-06-28',
  'Content-Type': 'application/json'
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const today = new Date();
const todayDay = DAYS[today.getDay()];
const dateStr = today.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });

async function getWeather() {
  const url = `https://api.openweathermap.org/data/2.5/weather?q=Alfred,ME,US&appid=${WEATHER_KEY}&units=imperial`;
  const res = await fetch(url);
  const d = await res.json();
  return {
    temp: Math.round(d.main.temp),
    feels: Math.round(d.main.feels_like),
    high: Math.round(d.main.temp_max),
    low: Math.round(d.main.temp_min),
    desc: d.weather[0].description,
    humidity: d.main.humidity,
    wind: Math.round(d.wind.speed),
    rain: d.rain ? Math.round((d.rain['1h'] || 0) * 100) : 0
  };
}

async function getNotionChores() {
  // Query the Weekly Deep Clean Tasks database filtered by today's day
  const dbId = '9db5db27-c5f2-42d2-9e39-53a0f19e45bf';
  const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: NOTION_HEADERS,
    body: JSON.stringify({
      filter: {
        property: 'Day',
        select: { equals: todayDay }
      }
    })
  });
  const data = await res.json();
  return (data.results || []).map(page => ({
    id: page.id,
    task: page.properties.Task?.title?.[0]?.plain_text || '',
    room: page.properties.Room?.select?.name || '',
    done: page.properties.Done?.checkbox || false
  })).filter(c => c.task);
}

async function getNotionMeal() {
  // Query the Weekly Meal Plan database for today's day
  const dbId = '24fdceb70b9f813db6a1c6b878d17553';
  const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: 'POST',
    headers: NOTION_HEADERS,
    body: JSON.stringify({
      filter: {
        property: 'Day of the week',
        title: { equals: todayDay }
      }
    })
  });
  const data = await res.json();
  const dayRow = data.results?.[0];
  if (!dayRow) return null;

  const mealRelations = dayRow.properties.Meals?.relation || [];
  const meals = [];
  for (const rel of mealRelations) {
    const mealRes = await fetch(`https://api.notion.com/v1/pages/${rel.id}`, { headers: NOTION_HEADERS });
    const mealData = await mealRes.json();
    const name = mealData.properties['Meal Name']?.title?.[0]?.plain_text || '';
    const tags = (mealData.properties.Tags?.multi_select || []).map(t => t.name);
    const type = (mealData.properties.Meal?.multi_select || []).map(t => t.name);
    if (name) meals.push({ name, tags, type });
  }
  return meals;
}

async function getNews() {
  const res = await fetch(
    `https://newsapi.org/v2/top-headlines?country=us&pageSize=3&apiKey=${process.env.NEWS_API_KEY || ''}`
  );
  // Fallback to hardcoded if no news API key
  if (!res.ok) return null;
  const data = await res.json();
  return (data.articles || []).slice(0, 3).map(a => ({
    source: a.source.name,
    headline: a.title
  }));
}

async function claudeApi(system, user) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system,
      messages: [{ role: 'user', content: user }]
    })
  });
  const d = await res.json();
  return d.content?.[0]?.text || '';
}

// ── Build digest ──────────────────────────────────────────────────────────────

async function main() {
  console.log(`Building digest for ${todayDay}...`);

  const [weather, chores, meals] = await Promise.all([
    getWeather(),
    getNotionChores(),
    getNotionMeal()
  ]);

  // Ask Claude for a prep note and newsletter pick
  const mealNames = meals?.map(m => m.name).join(' + ') || 'no meal planned';
  const claudeNote = await claudeApi(
    `You write a warm, brief household digest for Bec and Nic in Alfred, Maine. 
     Keep all text very short. Return ONLY valid JSON with exactly these fields:
     { "prepNote": "one sentence on when to start dinner prep to eat by 6:30pm", 
       "newsletterTitle": "invented title of an interesting article about outdoors, cooking, nature, or interesting facts",
       "newsletterSummary": "two sentences describing it warmly" }`,
    `Today is ${todayDay}. Dinner: ${mealNames}. Weather: ${weather.desc}, ${weather.temp}°F.`
  );

  let prep = { prepNote: `Start prep by 5:45pm to eat by 6:30`, newsletterTitle: 'The quiet magic of spring foraging in New England', newsletterSummary: 'A lovely piece on spotting ramps, fiddleheads, and wild garlic in Maine woodlands. Perfect reading for this time of year.' };
  try {
    const clean = claudeNote.replace(/```json|```/g, '').trim();
    prep = JSON.parse(clean);
  } catch(e) { /* use defaults */ }

  // Group chores by room
  const byRoom = {};
  for (const c of chores) {
    const room = c.room.replace(/[^\w\s&]/gu, '').trim() || 'General';
    if (!byRoom[room]) byRoom[room] = [];
    byRoom[room].push(c);
  }

  const choreRows = Object.entries(byRoom).map(([room, tasks]) => `
    <div class="room-label">${room}</div>
    ${tasks.map((t, i) => `
      <div class="chore-row ${t.done ? 'done' : ''}" id="chore-${t.id}" onclick="toggleChore('${t.id}', this)">
        <div class="chore-check"></div>
        <div class="chore-text">${t.task}</div>
      </div>
    `).join('')}
  `).join('');

  const totalChores = chores.length;
  const doneChores = chores.filter(c => c.done).length;

  const mealHtml = meals && meals.length > 0
    ? `<div class="meal-name">${meals.map(m => m.name).join(' + ')}</div>
       <div class="meal-tags">${[...new Set(meals.flatMap(m => m.tags))].slice(0,4).map(t => `<span class="meal-tag">${t}</span>`).join('')}</div>
       <div class="reminder-banner"><div class="reminder-dot"></div><div class="reminder-text">${prep.prepNote}</div></div>`
    : `<div class="meal-empty">No meal planned for ${todayDay} yet — <a href="https://www.notion.so/Weekly-meal-planner-24fdceb70b9f801c8f01fb06b7c93b5b" target="_blank">add one in Notion ↗</a></div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Household Digest · ${todayDay}</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;1,400&family=Lato:wght@300;400;700&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  :root{
    --cream:#FAF7F2;--warm-white:#FDF9F4;--sand:#E8DDD0;
    --terracotta:#C4714A;--terracotta-light:#E8A882;--terracotta-pale:#F5E6DC;
    --umber:#8B6148;--bark:#5C3D2E;--sage:#7A9E7E;--sage-pale:#EAF2EB;
    --forest:#4A7C5F;--forest-pale:#E6F0EB;
    --ink:#2C2018;--ink-soft:#8C7A6A;--ink-muted:#B5A898;--divider:rgba(92,61,46,0.12)
  }
  body{font-family:'Lato',sans-serif;background:var(--cream);color:var(--ink);min-height:100vh;padding-bottom:2rem}
  .header{background:var(--bark);padding:1.5rem 1.25rem 1.25rem;position:relative;overflow:hidden}
  .header::before{content:'';position:absolute;top:-40px;right:-40px;width:140px;height:140px;border-radius:50%;background:rgba(255,255,255,0.04)}
  .header-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:.75rem}
  .greeting{font-family:'Playfair Display',serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--terracotta-light);margin-bottom:4px}
  .date-main{font-family:'Playfair Display',serif;font-size:26px;font-weight:500;color:#FDF9F4;line-height:1.1}
  .date-sub{font-size:12px;font-weight:300;color:rgba(253,249,244,0.55);margin-top:3px}
  .weather-block{text-align:right}
  .weather-temp{font-family:'Playfair Display',serif;font-size:36px;font-weight:400;color:#FDF9F4;line-height:1}
  .weather-desc{font-size:11px;font-weight:300;color:rgba(253,249,244,0.6);margin-top:2px;text-transform:capitalize}
  .weather-location{font-size:10px;color:rgba(253,249,244,0.4);margin-top:1px}
  .weather-strip{display:flex;gap:6px;flex-wrap:wrap;margin-top:.75rem}
  .weather-pill{background:rgba(255,255,255,0.08);border:.5px solid rgba(255,255,255,0.12);border-radius:20px;padding:4px 10px;font-size:10px;color:rgba(253,249,244,0.7);font-weight:300}
  .weather-pill span{color:var(--terracotta-light);font-weight:400}
  .content{padding:0 1rem}
  .section{margin-top:1.25rem}
  .section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:.6rem}
  .section-label{font-size:9px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;color:var(--ink-muted);padding-left:2px}
  .notion-link{font-size:10px;color:var(--terracotta);text-decoration:none}
  .card{background:var(--warm-white);border:.5px solid var(--sand);border-radius:14px;padding:1rem 1.125rem}
  .live-badge{display:inline-flex;align-items:center;gap:4px;font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--sage);background:var(--sage-pale);border-radius:10px;padding:3px 8px}
  .live-dot{width:5px;height:5px;border-radius:50%;background:var(--sage);animation:pulse 2s infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
  .room-label{font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--ink-soft);padding:8px 0 4px;opacity:.7}
  .room-label:first-child{padding-top:0}
  .chore-row{display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:.5px solid var(--divider);cursor:pointer;user-select:none}
  .chore-row:last-of-type{border-bottom:none}
  .chore-check{width:17px;height:17px;border-radius:50%;border:1.5px solid var(--sand);flex-shrink:0;transition:all .2s;display:flex;align-items:center;justify-content:center}
  .chore-row.done .chore-check{background:var(--sage);border-color:var(--sage)}
  .chore-row.done .chore-check::after{content:'';width:5px;height:3px;border-left:1.5px solid white;border-bottom:1.5px solid white;transform:rotate(-45deg) translateY(-1px)}
  .chore-text{font-size:13px;color:var(--ink);flex:1;line-height:1.3}
  .chore-row.done .chore-text{color:var(--ink-muted);text-decoration:line-through;text-decoration-color:var(--ink-muted)}
  .chore-progress{height:3px;background:var(--sand);border-radius:2px;margin-top:.75rem;overflow:hidden}
  .chore-bar{height:100%;background:var(--sage);border-radius:2px;transition:width .4s ease}
  .chore-footer{display:flex;align-items:center;justify-content:space-between;margin-top:5px}
  .chore-label{font-size:10px;color:var(--ink-muted);font-weight:300}
  .meal-card{background:var(--terracotta-pale);border:.5px solid rgba(196,113,74,.2);border-radius:14px;padding:1rem 1.125rem}
  .meal-eyebrow{font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--terracotta);margin-bottom:4px}
  .meal-name{font-family:'Playfair Display',serif;font-size:20px;font-weight:500;color:var(--bark);line-height:1.2;margin-bottom:6px}
  .meal-tags{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:10px}
  .meal-tag{font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;padding:2px 7px;border-radius:8px;background:rgba(196,113,74,.15);color:var(--umber)}
  .meal-empty{font-size:13px;color:var(--umber);font-style:italic;font-weight:300}
  .meal-empty a{color:var(--terracotta)}
  .reminder-banner{background:var(--bark);border-radius:10px;padding:9px 12px;display:flex;align-items:center;gap:8px}
  .reminder-dot{width:6px;height:6px;border-radius:50%;background:var(--terracotta-light);flex-shrink:0;animation:pulse 2s infinite}
  .reminder-text{font-size:11px;color:rgba(253,249,244,.85);font-weight:300;line-height:1.4}
  .news-item{padding:8px 0;border-bottom:.5px solid var(--divider)}
  .news-item:last-child{border-bottom:none;padding-bottom:0}
  .news-item:first-child{padding-top:0}
  .news-source{font-size:9px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--terracotta);margin-bottom:3px}
  .news-headline{font-size:13px;color:var(--ink);line-height:1.4}
  .read-card{background:var(--forest-pale);border:.5px solid rgba(74,124,95,.2);border-radius:14px;padding:1rem 1.125rem;margin-top:.5rem}
  .read-eyebrow{font-size:9px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--forest);margin-bottom:5px}
  .read-title{font-family:'Playfair Display',serif;font-size:15px;font-style:italic;color:var(--bark);line-height:1.35;margin-bottom:5px}
  .read-body{font-size:12px;color:var(--ink-soft);line-height:1.5;font-weight:300}
  .footer{margin-top:1.5rem;padding:0 1rem;text-align:center;font-size:10px;color:var(--ink-muted);font-weight:300}
</style>
</head>
<body>
<div class="header">
  <div class="header-top">
    <div>
      <div class="greeting">Good morning, Bec & Nic</div>
      <div class="date-main">${todayDay}</div>
      <div class="date-sub">${dateStr}</div>
    </div>
    <div class="weather-block">
      <div class="weather-temp">${weather.temp}°</div>
      <div class="weather-desc">${weather.desc}</div>
      <div class="weather-location">Alfred, Maine</div>
    </div>
  </div>
  <div class="weather-strip">
    <div class="weather-pill">High <span>${weather.high}°</span></div>
    <div class="weather-pill">Low <span>${weather.low}°</span></div>
    <div class="weather-pill">Wind <span>${weather.wind}mph</span></div>
    <div class="weather-pill">Humidity <span>${weather.humidity}%</span></div>
  </div>
</div>

<div class="content">
  <div class="section">
    <div class="section-header">
      <div style="display:flex;align-items:center;gap:8px">
        <div class="section-label">Chores · ${todayDay}</div>
        <div class="live-badge"><div class="live-dot"></div>Notion</div>
      </div>
      <a class="notion-link" href="https://www.notion.so/Weekly-Cleaning-Checklist-343dceb70b9f801b86abffe4b092a172" target="_blank">Open ↗</a>
    </div>
    ${totalChores > 0 ? `
    <div class="card">
      ${choreRows}
      <div class="chore-progress"><div class="chore-bar" id="chore-bar" style="width:${Math.round(doneChores/totalChores*100)}%"></div></div>
      <div class="chore-footer">
        <div class="chore-label" id="chore-label">${doneChores} of ${totalChores} complete</div>
        <div style="font-size:9px;color:var(--ink-muted);font-style:italic" id="sync-status"></div>
      </div>
    </div>` : `<div class="card" style="font-size:13px;color:var(--ink-muted);font-style:italic">No chores scheduled for ${todayDay} — enjoy your day!</div>`}
  </div>

  <div class="section">
    <div class="section-header">
      <div class="section-label">Dinner tonight</div>
      <a class="notion-link" href="https://www.notion.so/Weekly-meal-planner-24fdceb70b9f801c8f01fb06b7c93b5b" target="_blank">Open ↗</a>
    </div>
    <div class="meal-card">
      <div class="meal-eyebrow">From your Notion meal plan</div>
      ${mealHtml}
    </div>
  </div>

  <div class="section">
    <div class="section-label">Morning headlines</div>
    <div class="card">
      <div class="news-item"><div class="news-source">Associated Press</div><div class="news-headline">Latest national and world headlines updated each morning</div></div>
      <div class="news-item"><div class="news-source">Reuters</div><div class="news-headline">Markets and economic news for today</div></div>
      <div class="news-item"><div class="news-source">BBC News</div><div class="news-headline">International headlines and top stories</div></div>
    </div>
    <div class="read-card">
      <div class="read-eyebrow">Today's read · Outdoors & Life</div>
      <div class="read-title">"${prep.newsletterTitle}"</div>
      <div class="read-body">${prep.newsletterSummary}</div>
    </div>
  </div>

  <div class="footer">
    Auto-generated at 6am · ${dateStr}
  </div>
</div>

<script>
const NOTION_TOKEN = '';  // note: Notion write-back requires a server — use the Notion app to check off tasks
const total = ${totalChores};
let done = ${doneChores};

function toggleChore(id, row) {
  row.classList.toggle('done');
  done = document.querySelectorAll('.chore-row.done').length;
  const pct = total > 0 ? Math.round(done/total*100) : 0;
  document.getElementById('chore-bar').style.width = pct+'%';
  document.getElementById('chore-label').textContent = done+' of '+total+' complete';
  document.getElementById('sync-status').textContent = 'open Notion to sync ↗';
}
</script>
</body>
</html>`;

  fs.mkdirSync('./out', { recursive: true });
  fs.writeFileSync('./out/index.html', html);
  console.log('Done! Digest written to out/index.html');
}

main().catch(err => { console.error(err); process.exit(1); });
