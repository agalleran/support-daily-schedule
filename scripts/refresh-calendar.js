// scripts/refresh-calendar.js
// Fetches OOO events from the Support Team Calendar and updates data.json

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const CALENDAR_ID = process.env.CALENDAR_ID;
const SERVICE_ACCOUNT = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

// How far ahead to fetch OOO events (90 days)
const LOOKAHEAD_DAYS = 90;

// Keywords that indicate an OOO/PTO event (case-insensitive)
const OOO_KEYWORDS = [
  'ooo', 'pto', 'out of office', 'vacation', 'holiday', 'leave',
  'off', 'away', 'sick', 'maternity', 'paternity', 'parental'
];

// Keywords to exclude (recurring team events, meetings, etc.)
const EXCLUDE_KEYWORDS = [
  'skill development', 'q crush', 'birthday', 'sync', 'standup',
  'stand-up', 'meeting', 'interview', 'training', 'onboarding',
  'holiday coverage', '1:1', 'all hands', 'kickoff'
];

// Map calendar event creator/organiser emails to teammate emails in data.json
// Add entries here if a teammate's calendar email differs from their data.json email
const EMAIL_MAP = {
  // 'calendar.email@front.com': 'data.json.email@front.com',
};

function normaliseEmail(email) {
  return EMAIL_MAP[email.toLowerCase()] || email.toLowerCase();
}

function isOooEvent(title) {
  const t = title.toLowerCase();
  if (EXCLUDE_KEYWORDS.some(k => t.includes(k))) return false;
  return OOO_KEYWORDS.some(k => t.includes(k));
}

function toDateString(dateObj) {
  // Google returns either { date: 'YYYY-MM-DD' } (all-day) or { dateTime: '...' }
  if (dateObj.date) return dateObj.date;
  return new Date(dateObj.dateTime).toISOString().slice(0, 10);
}

async function main() {
  const auth = new google.auth.GoogleAuth({
    credentials: SERVICE_ACCOUNT,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });

  const calendar = google.calendar({ version: 'v3', auth });

  const now = new Date();
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000).toISOString();

  console.log(`Fetching events from ${timeMin.slice(0,10)} to ${timeMax.slice(0,10)}...`);

  let allEvents = [];
  let pageToken = undefined;

  do {
    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin,
      timeMax,
      maxResults: 250,
      singleEvents: true,
      orderBy: 'startTime',
      pageToken,
    });

    allEvents = allEvents.concat(res.data.items || []);
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  console.log(`Fetched ${allEvents.length} total events.`);

  // Filter to OOO events only
  const oooEvents = allEvents.filter(e => {
    const title = e.summary || '';
    return isOooEvent(title);
  });

  console.log(`Found ${oooEvents.length} OOO events.`);

  // Group by email
  const oooByEmail = {};

  oooEvents.forEach(e => {
    const title = e.summary || '';
    const start = toDateString(e.start);
    const end   = toDateString(e.end); // Google end dates are exclusive (already correct format)

    // Try to identify the person from organiser or creator email
    const rawEmail = (e.organizer?.email || e.creator?.email || '').toLowerCase();
    const email = normaliseEmail(rawEmail);

    if (!email) {
      console.log(`  Skipping "${title}" — no email found`);
      return;
    }

    if (!oooByEmail[email]) oooByEmail[email] = [];

    // Avoid duplicate ranges
    const exists = oooByEmail[email].some(r => r.start === start && r.end === end);
    if (!exists) {
      const entry = { start, end };
      // Preserve special labels like maternity leave
      if (title.toLowerCase().includes('maternity')) entry.label = 'Maternity leave';
      if (title.toLowerCase().includes('paternity')) entry.label = 'Paternity leave';
      if (title.toLowerCase().includes('parental'))  entry.label = 'Parental leave';
      oooByEmail[email].push(entry);
      console.log(`  ${email}: ${title} (${start} → ${end})`);
    }
  });

  // Load existing data.json
  const dataPath = path.join(__dirname, '..', 'data.json');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  // Only update OOO entries for teammates in the TEAM array
  const teamEmails = new Set(data.team.map(p => p.email.toLowerCase()));

  // Filter oooByEmail to only known teammates
  const filteredOoo = {};
  Object.entries(oooByEmail).forEach(([email, ranges]) => {
    if (teamEmails.has(email)) {
      filteredOoo[email] = ranges.sort((a, b) => a.start.localeCompare(b.start));
    } else {
      console.log(`  Skipping unknown email: ${email}`);
    }
  });

  // Preserve any manually-added OOO entries that are outside the fetch window
  // (e.g. maternity leave that extends beyond LOOKAHEAD_DAYS)
  const today = now.toISOString().slice(0, 10);
  const existingOoo = data.ooo || {};

  Object.entries(existingOoo).forEach(([email, ranges]) => {
    ranges.forEach(r => {
      // Keep entries that end after the lookahead window (long-term leave)
      if (r.end > timeMax.slice(0, 10)) {
        if (!filteredOoo[email]) filteredOoo[email] = [];
        const exists = filteredOoo[email].some(x => x.start === r.start && x.end === r.end);
        if (!exists) {
          filteredOoo[email].push(r);
          console.log(`  Preserving long-term OOO for ${email}: ${r.start} → ${r.end}`);
        }
      }
    });
  });

  // Update data.json
  data.ooo = filteredOoo;
  data.meta.cal_start = today;
  data.meta.cal_end = timeMax.slice(0, 10);
  data.meta.last_updated = today;

  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
  console.log(`\ndata.json updated. OOO entries for ${Object.keys(filteredOoo).length} teammates.`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
