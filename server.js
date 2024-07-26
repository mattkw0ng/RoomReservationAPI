const express = require('express');
const fs = require('fs');
const { google } = require('googleapis');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const pool = require('./db');

const app = express();
const PORT = 5000;

app.use(bodyParser.json());
app.use(cors());

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const ROOM_IDS_PATH = path.join(__dirname, 'room-ids.json');
const ROOM_IDS = JSON.parse(fs.readFileSync(ROOM_IDS_PATH, 'utf-8'));
const PENDING_APPROVAL_CALENDAR_ID = "c_0430068aa84472bdb1aa16b35d4061cd867e4888a8ace5fa3d830bb67587dfad@group.calendar.google.com";
const APPROVED_CALENDAR_ID = 'c_8f9a221bd12882ccda21c5fb81effbad778854cc940c855b25086414babb1079@group.calendar.google.com';


// Authorize {matt.kwong@sjcac.org} account
async function authorize() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
  const { client_secret, client_id, redirect_uris } = credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(TOKEN_PATH)) {
    const token = fs.readFileSync(TOKEN_PATH, 'utf-8');
    oAuth2Client.setCredentials(JSON.parse(token));
  } else {
    await getAccessToken(oAuth2Client);
  }
  return oAuth2Client;
}

// Get Access Token from Google
async function getAccessToken(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  console.log('Authorize this app by visiting this url:', authUrl);
  const rl = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  rl.question('Enter the code from that page here: ', (code) => {
    rl.close();
    oAuth2Client.getToken(code, (err, token) => {
      if (err) return console.error('Error retrieving access token', err);
      oAuth2Client.setCredentials(token);
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
      console.log('Token stored to', TOKEN_PATH);
    });
  });
}

async function listEvents(calendarId, auth, startTime, endTime) {
  const calendar = google.calendar({ version: 'v3', auth });

  try {
    const response = await calendar.events.list({
      calendarId: calendarId,
      timeMin: startTime.toISOString(),
      timeMax: endTime.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });
    return response.data.items;
  } catch (err) {
    console.error('Error fetching events:', err);
    return [];
  }
}

app.get('/oauth2callback', (req, res) => {
  const code = req.query.code;
  console.log(code);
});

// Return the 5 upcoming events within the next week
app.get('/api/upcomingEvents', async (req, res) => {
  const auth = await authorize();
  const startTime = new Date();
  startTime.setHours(0, 0, 0, 0); // Start of the current day
  const endTime = new Date(startTime.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days from now

  try {
    const chapelEvents = await listEvents(ROOM_IDS['Chapel'], auth, startTime, endTime);
    const sanctuaryEvents = await listEvents(ROOM_IDS['Sanctuary'], auth, startTime, endTime);

    const upcomingEvents = [...chapelEvents, ...sanctuaryEvents].slice(0, 5); // Combine and limit to 10 events
    res.json(upcomingEvents);
  } catch (error) {
    console.error('Error fetching upcoming events:', error);
    res.status(500).send('Error fetching events');
  }
});

// Get all the events under the "Pending Events Calendar"
app.get('/api/pendingEvents', async (req, res) => {
  const auth = await authorize();
  const calendar = google.calendar({ version: 'v3', auth });

  calendar.events.list({
    calendarId: PENDING_APPROVAL_CALENDAR_ID,
    maxResults: 10, // You can adjust this as needed
    singleEvents: true,
    orderBy: 'startTime',
  }, (err, result) => {
    if (err) {
      console.error('Error fetching events:', err);
      return res.status(500).send('Error fetching events');
    }
    res.status(200).send(result.data.items);
  });
});

/** OLD FUNCTION -- SEE addEventWithRoom
app.post('/api/addEvent', async (req, res) => {
  const { summary, location, description, startDateTime, endDateTime, room } = req.body;

  if (!summary || !startDateTime || !endDateTime || !room) {
    return res.status(400).send('Missing required fields');
  }

  const auth = await authorize();
  const calendarId = room === 'Chapel' ? ROOM_IDS['Chapel'] : ROOM_IDS['Sanctuary'];

  const event = {
    summary,
    location,
    description,
    start: {
      dateTime: startDateTime,
      timeZone: 'America/Los_Angeles',
    },
    end: {
      dateTime: endDateTime,
      timeZone: 'America/Los_Angeles',
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'email', minutes: 24 * 60 },
        { method: 'popup', minutes: 10 },
      ],
    },
  };

  try {
    const response = await google.calendar({ version: 'v3', auth }).events.insert({
      auth: auth,
      calendarId: calendarId,
      resource: event,
    });
    console.log('Event created:', response.data.htmlLink);
    res.status(200).send('Event added');
  } catch (error) {
    console.error('Error adding event:', error);
    res.status(500).send('Error adding event');
  }
});
*/


// Get calendar ID from database (currently unimplemented)
async function getCalendarIdByRoom(room) {
  // const query = 'SELECT calendar_id FROM rooms WHERE name = $1';
  // const result = await pool.query(query, [room]);
  // if (result.rows.length > 0) {
  //   return result.rows[0].calendar_id;
  // }
  // throw new Error(`Room not found: ${room}`);
  return ROOM_IDS[room]
}

// Add and event to the "Pending Approval" Calendar, with the room added as an "attendee" resource
app.post('/api/addEventWithRoom', async (req, res) => {
  console.log("Incoming event request");
  const { summary, location, description, startDateTime, endDateTime, room } = req.body;

  if (!summary || !startDateTime || !endDateTime || !room) {
    return res.status(400).send('Missing required fields');
  }

  try {
    const roomId = await getCalendarIdByRoom(room);
    const auth = await authorize();
    const calendar = google.calendar({ version: 'v3', auth });

    const event = {
      summary,
      location,
      description,
      start: {
        dateTime: startDateTime,
        timeZone: 'America/Los_Angeles',
      },
      end: {
        dateTime: endDateTime,
        timeZone: 'America/Los_Angeles',
      },
      // This is where the event is also added to the respective Rooms/Resource Calendar (google categorizes this as an attendee)
      // The calendarID is placed under the email tag, and resource is set to TRUE
      attendees: [
        { email: roomId, resource: true },
      ],
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 24 * 60 },
          { method: 'popup', minutes: 10 },
        ],
      },
    };

    const response = await calendar.events.insert({
      calendarId: PENDING_APPROVAL_CALENDAR_ID,
      resource: event,
    });

    console.log('Event created: %s', response.data.htmlLink);
    res.status(200).send('Event added');
  } catch (error) {
    console.error('Error adding event:', error);
    res.status(500).send('Error adding event: ' + error.message);
  }
});

// Move event from the "Pending Approval" Calendar to the "Approved" Calendar
app.post('/api/approveEvent', async (req, res) => {
  const { eventId } = req.body;

  if (!eventId) {
    return res.status(400).send('Missing required fields');
  }

  try {
    const auth = await authorize();
    const calendar = google.calendar({ version: 'v3', auth });

    // Retrieve the event details from the "Pending Approval" calendar
    const eventResponse = await calendar.events.get({
      calendarId: PENDING_APPROVAL_CALENDAR_ID,
      eventId: eventId,
    });

    const event = eventResponse.data;

    // Insert the event into the "Approved" calendar
    await calendar.events.insert({
      calendarId: APPROVED_CALENDAR_ID,
      resource: event,
    });

    // Delete the event from the "Pending Approval" calendar
    await calendar.events.delete({
      calendarId: PENDING_APPROVAL_CALENDAR_ID,
      eventId: eventId,
    });

    res.status(200).send('Event approved');
  } catch (error) {
    console.error('Error approving event:', error);
    res.status(500).send('Error approving event: ' + error.message);
  }
});



// Check what rooms are available at any given time/date
app.get('/api/checkAvailability', async (req, res) => {
  const { startDateTime, endDateTime } = req.query;

  if (!startDateTime || !endDateTime) {
    return res.status(400).send('Missing startDateTime or endDateTime');
  }

  const auth = await authorize();
  const startTime = new Date(startDateTime);
  const endTime = new Date(endDateTime);

  try {
    const chapelEvents = await listEvents(ROOM_IDS['Chapel'], auth, startTime, endTime);
    const sanctuaryEvents = await listEvents(ROOM_IDS['Sanctuary'], auth, startTime, endTime);

    const reservedRooms = [];
    if (chapelEvents.length > 0) reservedRooms.push('Chapel');
    if (sanctuaryEvents.length > 0) reservedRooms.push('Sanctuary');

    const availableRooms = reservedRooms.length === 0 ? ['Chapel', 'Sanctuary'] : ['Chapel', 'Sanctuary'].filter(room => !reservedRooms.includes(room));

    res.json(availableRooms);
  } catch (error) {
    console.error('Error checking availability:', error);
    res.status(500).send('Error checking availability');
  }
});

// TEST : get room data from database
app.get('/api/rooms', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM rooms');
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

app.post('/api/searchRoomBasic', async (req, res) => {
  const { capacity, resources } = req.body;
  console.log(`Searching Rooms where capacity >= ${capacity} and room includes: ${resources}`);

  if (!capacity || !resources) {
    return res.status(400).send('Missing required fields');
  }

  try {
    const result = await pool.query(
      `SELECT * FROM rooms WHERE capacity >= $1 AND resources @> $2::text[]`,
      [capacity, resources]
    );
    console.log(result);
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Server Error');
  }
});

app.listen(PORT, () => {
  authorize();
  console.log(`\nServer running on http://localhost:${PORT}`);
});
