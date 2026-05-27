// scripts/post-slack-schedule.js
// Reads data.json and posts today's support team schedule to Slack

const fs = require('fs');
const path = require('path');
const https = require('https');

const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SCHEDULE_URL = 'https://agalleran.github.io/support-daily-schedule/';
const SHIFT_ORDER = ['EMEA', 'US', 'Chile', 'APAC', 'Operations', 'Managers'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Get today's date in PT
function getTodayPT() {
  const now = new Date();
  const ptOffset = -7 * 60; // PDT — script handles DST below
  const ptDate = new Date(now.getTime() + ptOffset * 60000);
  return {
    ds: ptDate.toISOString().slice(0, 10),
    dow: ptDate.getUTCDay(),
    dayName: DAYS[ptDate.getUTCDay()],
    monthName: MONTHS[ptDate.getUTCMonth()],
    dayNum: ptDate.getUTCDate()
  };
}

function isHoliday(country, ds, holidays) {
  return (holidays[country] || []).includes(ds);
}

function getStatus(p, ds, dow, ooo, holidays, inRange) {
  if (isHoliday(p.country, ds, holidays)) return { type: 'holiday' };
  if (inRange) {
    for (const r of (ooo[p.email] || [])) {
      if (r.start <= ds && ds < r.end && !r.partial) return { type: 'ooo', label: r.label };
    }
    for (const r of (ooo[p.email] || [])) {
      if (r.start <= ds && ds <= r.end && r.partial) return { type: 'partial', label: r.label };
    }
  }
  if (p.days[String(dow)]) return { type: 'online' };
  return { type: 'off' };
}

function postToSlack(payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(WEBHOOK_URL);
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
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

async function main() {
  const dataPath = path.join(__dirname, '..', 'data.json');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  const { ds, dow, dayName, monthName, dayNum } = getTodayPT();
  const inRange = data.meta.cal_start <= ds && ds <= data.meta.cal_end;

  // Build message blocks
  const blocks = [];

  // Header as section to avoid Slack's automatic divider under header blocks
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `📅 *Support Team Schedule — ${dayName}, ${monthName} ${dayNum}*` }
  });

  // All shifts in one block to avoid Slack auto-inserting dividers
  const allLines = [];
  for (const shift of SHIFT_ORDER) {
    const members = data.team.filter(p => p.shift === shift);
    if (!members.length) continue;

    const online  = [];
    const partial = [];
    const oooList = [];
    const off     = [];

    members.forEach(p => {
      const status = getStatus(p, ds, dow, data.ooo, data.holidays, inRange);
      switch (status.type) {
        case 'online':  online.push(p.name); break;
        case 'partial': partial.push(p.name); break;
        case 'ooo':
        case 'holiday': oooList.push(p.name); break;
        case 'off':     off.push(p.name); break;
      }
    });

    const lines = [];
    if (online.length)  lines.push(`🟢 ${online.join(', ')}`);
    if (partial.length) lines.push(`🟡 ${partial.join(', ')}`);
    if (oooList.length) lines.push(`🔴 ${oooList.join(', ')}`);
    if (off.length)     lines.push(`⚫ ${off.join(', ')}`);

    allLines.push(`*${shift}*\n${lines.join('\n')}`);
  }

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: allLines.join('\n\n') + `\n\n🔗 <${SCHEDULE_URL}|Click here for more details including hours and who's online now>` }
  });

  await postToSlack({ blocks });
  console.log(`✓ Schedule posted to Slack for ${ds}`);
}

main().catch(err => {
  console.error('Error posting to Slack:', err.message);
  process.exit(1);
});
