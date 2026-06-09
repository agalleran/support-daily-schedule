// scripts/post-slack-schedule.js
// Reads data.json and posts today's support team schedule + fun fact to Slack

const fs   = require('fs');
const path = require('path');
const https = require('https');

const WEBHOOK_URL  = process.env.SLACK_WEBHOOK_URL;
const TMDB_TOKEN   = process.env.TMDB_API_KEY;
const SCHEDULE_URL = 'https://agalleran.github.io/support-daily-schedule/';
const SHIFT_ORDER  = ['EMEA', 'US', 'Chile', 'APAC', 'Operations', 'Managers'];
const DAYS   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const USED_YEARS_PATH = path.join(__dirname, 'used-years.json');
const MIN_YEARS_AGO = 5;
const MAX_YEARS_AGO = 50;

// ── Date helpers ──────────────────────────────────────────────
function getTodayPT() {
  const now = new Date();
  const ptOffset = -7 * 60;
  const ptDate = new Date(now.getTime() + ptOffset * 60000);
  return {
    ds:        ptDate.toISOString().slice(0, 10),
    dow:       ptDate.getUTCDay(),
    dayName:   DAYS[ptDate.getUTCDay()],
    monthName: MONTHS[ptDate.getUTCMonth()],
    dayNum:    ptDate.getUTCDate(),
    month:     ptDate.getUTCMonth() + 1,
    year:      ptDate.getUTCFullYear()
  };
}

// ── Schedule helpers ──────────────────────────────────────────
function isHoliday(country, ds, holidays) {
  return (holidays[country] || []).includes(ds);
}

function getStatus(p, ds, dow, ooo, holidays, inRange) {
  if (isHoliday(p.country, ds, holidays)) return { type: 'holiday' };
  if (inRange) {
    for (const r of (ooo[p.email] || [])) {
      if (r.start <= ds && ds < r.end && !r.partial) return { type: 'ooo' };
    }
    for (const r of (ooo[p.email] || [])) {
      if (r.start <= ds && ds <= r.end && r.partial) return { type: 'partial' };
    }
  }
  if (p.days[String(dow)]) return { type: 'online' };
  return { type: 'off' };
}

const PREFERRED_NAMES = {
  'Consuelo Reyes':  'Consu',
  'Edjay Rustria':   'Ejay',
  'Nikolai Dominic': 'Nik',
  'Raymond Ching':   'Ray'
};

function displayName(fullName) {
  return PREFERRED_NAMES[fullName] || fullName.split(' ')[0];
}

// ── HTTP helpers ──────────────────────────────────────────────
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    }).on('error', reject);
  });
}

function postToSlack(payload) {
  return new Promise((resolve, reject) => {
    const url  = new URL(WEBHOOK_URL);
    const body = JSON.stringify(payload);
    const req  = https.request({
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(data);
        else reject(new Error(`Slack returned ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Fun fact: #1 movie on this day X years ago ────────────────
function pickYear(currentYear, currentMonth) {
  let stored = { month: null, usedYears: [] };
  try { stored = JSON.parse(fs.readFileSync(USED_YEARS_PATH, 'utf8')); } catch {}

  // Reset at the start of a new month
  if (stored.month !== currentMonth) {
    console.log(`New month (${currentMonth}) — resetting used-years list`);
    stored = { month: currentMonth, usedYears: [] };
  }

  const allYears = [];
  for (let i = MIN_YEARS_AGO; i <= MAX_YEARS_AGO; i++) {
    allYears.push(currentYear - i);
  }

  const available = allYears.filter(y => !stored.usedYears.includes(y));
  const pool = available.length > 0 ? available : allYears;
  const chosen = pool[Math.floor(Math.random() * pool.length)];

  stored.usedYears.push(chosen);
  fs.writeFileSync(USED_YEARS_PATH, JSON.stringify(stored, null, 2));

  return chosen;
}

async function getTopMovie(year, month, day) {
  try {
    // Search TMDB for movies playing around that date, sorted by popularity
    // We use discover with primary_release_date range around the date
    const dateStr  = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const weekBefore = new Date(year, month - 1, day - 7).toISOString().slice(0, 10);
    const weekAfter  = new Date(year, month - 1, day + 7).toISOString().slice(0, 10);

    const url = `https://api.themoviedb.org/3/discover/movie?language=en-US&sort_by=revenue.desc&primary_release_date.gte=${weekBefore}&primary_release_date.lte=${weekAfter}&page=1`;
    const res = await httpGet(url, { Authorization: `Bearer ${TMDB_TOKEN}` });

    if (res.results && res.results.length > 0) {
      const movie = res.results[0];
      return { title: movie.title, year };
    }

    // Fallback: get most popular movie released in that month/year
    const fallbackUrl = `https://api.themoviedb.org/3/discover/movie?language=en-US&sort_by=revenue.desc&primary_release_date.gte=${year}-${String(month).padStart(2,'0')}-01&primary_release_date.lte=${year}-${String(month).padStart(2,'0')}-28&page=1`;
    const fallback = await httpGet(fallbackUrl, { Authorization: `Bearer ${TMDB_TOKEN}` });

    if (fallback.results && fallback.results.length > 0) {
      return { title: fallback.results[0].title, year };
    }

    return null;
  } catch (err) {
    console.error('TMDB error:', err.message);
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────
const CELEBRATIONS_PATH = path.join(__dirname, 'celebrations.json');

function getCelebration(ds, dow) {
  let celebrations = [];
  try { celebrations = JSON.parse(fs.readFileSync(CELEBRATIONS_PATH, 'utf8')); } catch {}

  // Check today's date
  const today = celebrations.find(c => c.date === ds);
  if (today) return today;

  // If today is Friday (dow=5), also check Saturday and Sunday
  // so we shout out weekend birthdays on the Friday before
  if (dow === 5) {
    const d = new Date(ds + 'T12:00:00Z');
    for (let i = 1; i <= 2; i++) {
      d.setUTCDate(d.getUTCDate() + 1);
      const nextDs = d.toISOString().slice(0, 10);
      const found = celebrations.find(c => c.date === nextDs);
      if (found) return { ...found, advanceNotice: true };
    }
  }

  return null;
}

async function main() {
  const dataPath = path.join(__dirname, '..', 'data.json');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  const { ds, dow, dayName, monthName, dayNum, month, year } = getTodayPT();
  const inRange = data.meta.cal_start <= ds && ds <= data.meta.cal_end;

  // Build schedule content
  const allLines = [];
  allLines.push(`📅 *Support Team Schedule — ${dayName}, ${monthName} ${dayNum}*\n`);

  for (const shift of SHIFT_ORDER) {
    const members = data.team.filter(p => p.shift === shift);
    if (!members.length) continue;

    const online = [], partial = [], oooList = [], off = [];

    members.forEach(p => {
      const status = getStatus(p, ds, dow, data.ooo, data.holidays, inRange);
      const name = displayName(p.name);
      switch (status.type) {
        case 'online':  online.push(name); break;
        case 'partial': partial.push(name); break;
        case 'ooo':
        case 'holiday': oooList.push(name); break;
        case 'off':     off.push(name); break;
      }
    });

    const lines = [];
    if (online.length)  lines.push(`✅ ${online.join(', ')}`);
    if (partial.length) lines.push(`🕐 ${partial.join(', ')}`);
    if (oooList.length) lines.push(`❌ ${oooList.join(', ')}`);
    if (off.length)     lines.push(`➖ ${off.join(', ')}`);

    allLines.push(`*${shift}*\n${lines.join('\n')}`);
  }

  allLines.push(`🔗 <${SCHEDULE_URL}|Click here for more details including hours and who's online now>`);

  // Celebration or movie fun fact
  const celebration = getCelebration(ds, dow);
  if (celebration) {
    const prefix = celebration.advanceNotice ? `_(this weekend)_ ` : '';
    allLines.push(`\n${prefix}${celebration.message}`);
    console.log(`✓ Schedule posted to Slack for ${ds} (celebration: ${celebration.name})`);
  } else {
    const chosenYear = pickYear(year, month);
    const movie = await getTopMovie(chosenYear, month, dayNum);
    if (movie) {
      const yearsAgo = year - chosenYear;
      allLines.push(`\n🎬 *${yearsAgo} years ago in theaters: ${movie.title}*`);
    }
    console.log(`✓ Schedule posted to Slack for ${ds} (fun fact: ${movie ? movie.title : 'unavailable'})`);
  }

  const blocks = [{
    type: 'section',
    text: { type: 'mrkdwn', text: allLines.join('\n\n') }
  }];

  await postToSlack({ blocks });
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
