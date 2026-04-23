import fetch from 'node-fetch';
import fs from 'fs';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const WEATHER_KEY = process.env.OPENWEATHER_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;

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
  const url = `https://api.openweathermap.org/data/2.5/weather?q=Alfred,ME,US&appid=${WEATHER_KEY}&units=imperial`;
  const res = await fetch(url);
  const d = await res.json();
  if (!d.main) throw new Error('Weather API failed: ' + JSON.stringify(d));
  return {
    temp: Math.round(d.main.temp),
    high: Math.round(d.main.temp_max),
    low: Math.round(d.main.temp_min),
    desc: d.weather[0].description,
    humidity: d.main.humidity,
    wind: Math.round(d.wind.speed)
  };
}

async function getChores() {
  const res = await fetch('https://api.notion.com/v1/databases/9db5db27c5f242d29e3953a0f19e45bf/query', {
    method: 'POST',
    headers: NOTION_HEADERS,
    body: JSON.stringify({
      filter: { property: 'Day', select: { equals: todayDay } }
    })
  });
  const data = await res.json();
  if (!data.results) throw new Error('Notion chores failed: ' + JSON.stringify(data));
  return data.results.map(p => ({
    id: p.id,
    task: p.properties.Task?.title?.[0]?.plain_text || '',
    room: p.properties.Room?.select?.name || '',
    done: p.properties.Done?.checkbox || false
  })).filter(c => c.task);
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
Return ONLY a JSON object with no markdown fences and no extra text:
{
  "prepNote": "one warm sentence about when to start dinner prep to eat by 6:30pm",
  "newsletterTitle": "title of an interesting article about outdoors, cooking, nature, or fascinating facts",
  "newsletterSummary": "two warm sentences summarizing why they would enjoy it"
}`,
      messages: [{
        role: 'user',
        content: `Today is ${todayDay}. Dinner: ${mealText}. Weather: ${weather.desc}, ${weather.temp}F.`
      }]
    })
  });
  const d = await res.json();
  const text = d.content?.[0]?.text || '{}';
  try {
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

function buildHtml(weather, chores, meals, claude) {
  const byRoom = {};
  for (const c of chores) {
    const room = c.room.replace(/\p{Emoji}/gu, '').trim() || 'General';
    if (!byRoom[room]) byRoom[room] = [];
    byRoom[room].push(c);
  }

  const choreHtml = Object.entries(byRoom).map(([room, tasks]) => `
    <div class="room-label">${room}</div>
    ${tasks.map(t => `
      <div class="chore-row${t.done ? ' done' : ''}" onclick="toggle(this)">
        <div class="chore-check"></div>
        <div class="chore-text">${t.task}</div>
      </div>`).join('')}
  `).join('');

  const total = chores.length;
  const doneCount = chores.filter(c => c.done).leng
