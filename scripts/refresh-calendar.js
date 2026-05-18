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
  'off', 'away', 'sick', 'maternity', 'paternity', 'parental', 'wfh'
];

// Keywords to exclude (recurring team events, meetings, etc.)
const EXCLUDE_KEYWORDS = [
  'skill development', 'q crush', 'birthday', 'sync', 'standup',
  'stand-up', 'meeting', 'interview', 'training', 'onboarding',
  'holiday coverage', '1:1', 'all hands', 'kickoff', 'coverage'
];

function isOooEvent(title) {
  const t = title.toLowerCase();
  if (EXCLUDE_KEYWORDS.some(k => t.includes(k))) return false;
  return OOO_KEYWORDS.some(k => t.includes(k));
}

function toDateString(dateObj) {
  if (dateObj.date) return dateObj.date;
  return new Date(dateObj.dateTime).toISOString().slice(0, 10);
}

// Build a lookup of name variations -> email from the team list
function buildNameIndex(team) {
  const index = [];
  team.forEach(p => {
    const parts = p.name.toLowerCase().split(' ');
    const firstName = parts[0];
    const lastName  = parts[parts.length - 1];
    const fullName  = p.name.toLowerCase();
    // Common nickname variants (Ray for Raymond, etc.)
    const nicknames = { raymond: 'ray', seán: 'sean', sean: 'sean' };
    const nick = nicknames[firstName] || null;
    index.push({ email: p.email, firstName, lastName, fullName, nick });
  });
  return index;
}

// Try to match an event title to a teammate
function matchTeammate(title, nameIndex) {
  const t = title.toLowerCase()
    .replace(/['']/g, '')       // remove apostrophes
    .replace(/[^a-z0-9 ]/g, ' ') // normalise punctuation to spaces
    .trim();

  for (const p of nameIndex) {
    // Check full name
    if (t.includes(p.fullName)) return p.email;
    // Check first + last name separately
    if (t.includes(p.firstName) || t.includes(p.lastName)) return p.email;
    // Check nickname
    if (p.nick && t.includes(p.nick)) return p.email;
  }
  return null;
}

function toTitleCase(str) {
  return str.replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
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

  // Load existing data.json
  const dataPath = path.join(__dirname, '..', 'data.json');
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

  const nameIndex = buildNameIndex(data.team);

  // Filter to OOO events and match to teammates
  const oooByEmail = {};

  allEvents.forEach(e => {
    const title = e.summary || '(no title)';
    const start = toDateString(e.start);
    const end   = toDateString(e.end);
    const t = title.toLowerCase();

    // Debug: log every event so we can see what's on the calendar
    const excludeHit = EXCLUDE_KEYWORDS.find(k => t.includes(k));
    const oooHit     = OOO_KEYWORDS.find(k => t.includes(k));
    if (excludeHit) {
      console.log(`  ⏭  EXCLUDED by "${excludeHit}": "${title}" (${start})`);
      return;
    }
    if (!oooHit) {
      console.log(`  ➖ NOT OOO: "${title}" (${start})`);
      return;
    }

    // First try creator/organiser email match
    const creatorEmail = (e.creator?.email || e.organizer?.email || '').toLowerCase();
    const teamEmails = new Set(data.team.map(p => p.email.toLowerCase()));
    let email = teamEmails.has(creatorEmail) ? creatorEmail : null;

    // Fall back to name matching from event title
    if (!email) email = matchTeammate(title, nameIndex);

    if (!email) {
      console.log(`  ⚠️  Could not match: "${title}" (${start} → ${end})`);
      return;
    }

    if (!oooByEmail[email]) oooByEmail[email] = [];
    const exists = oooByEmail[email].some(r => r.start === start && r.end === end);
    if (!exists) {
      const entry = { start, end };
      if (title.toLowerCase().includes('maternity')) entry.label = 'Maternity leave';
      if (title.toLowerCase().includes('paternity')) entry.label = 'Paternity leave';
      if (title.toLowerCase().includes('parental'))  entry.label = 'Parental leave';
      oooByEmail[email].push(entry);
      console.log(`  ✓  ${email}: "${title}" (${start} → ${end})`);
    }
  });

  // Preserve long-term OOO entries that extend beyond the fetch window
  const existingOoo = data.ooo || {};
  Object.entries(existingOoo).forEach(([email, ranges]) => {
    ranges.forEach(r => {
      if (r.end > timeMax.slice(0, 10)) {
        if (!oooByEmail[email]) oooByEmail[email] = [];
        const exists = oooByEmail[email].some(x => x.start === r.start && x.end === r.end);
        if (!exists) {
          oooByEmail[email].push(r);
          console.log(`  📌 Preserved long-term OOO for ${email}: ${r.start} → ${r.end}${r.label ? ' (' + r.label + ')' : ''}`);
        }
      }
    });
  });

  // Sort each person's OOO entries by start date
  Object.keys(oooByEmail).forEach(email => {
    oooByEmail[email].sort((a, b) => a.start.localeCompare(b.start));
  });

  const today = now.toISOString().slice(0, 10);
  data.ooo = oooByEmail;
  data.meta.cal_start = today;
  data.meta.cal_end   = timeMax.slice(0, 10);
  data.meta.last_updated = today;

  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
  console.log(`\n✅ data.json updated. OOO entries for ${Object.keys(oooByEmail).length} teammates.`);
  console.log(`   Unmatched events logged above with ⚠️  — add name aliases to matchTeammate() if needed.`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
