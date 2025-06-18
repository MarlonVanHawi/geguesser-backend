import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as turf from '@turf/turf';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import 'dotenv/config';    // loads .env into process.env

// Helper to get __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load Gelsenkirchen boundary
const geojsonPath = path.join(__dirname, 'gelsenkirchen.geojson');
const gelsenkirchenGeoJSON = JSON.parse(fs.readFileSync(geojsonPath));
// A GeoJSON file is often a FeatureCollection, so we extract the first feature which contains the polygon.
const gelsenkirchenBoundary = gelsenkirchenGeoJSON.features[0];

// Hotspot list: well-known spots in Gelsenkirchen
const hotspots = [
  { lat: 51.52395856768423, lng: 7.037352085601251 },
  { lat: 51.554574624000104, lng: 7.066733219975756 },
  { lat: 51.51338538079296, lng: 7.100042214964631 },
  { lat: 51.5351230034151, lng: 7.023467107684594 },
  { lat: 51.54386848191332, lng: 7.108014340653878 },
  { lat: 51.51338454842081, lng: 7.091463303153945 },
  { lat: 51.50375320698871, lng: 7.103641920146579 },
  { lat: 51.49925105186264, lng: 7.108394539845331 },
  { lat: 51.578025680324465, lng: 7.058061636107577 },
  { lat: 51.57129289121027, lng: 7.144660568664819 },
  { lat: 51.51754944003554, lng: 7.068416334838962 },
  { lat: 51.57051640956046, lng: 7.0304046989919105 }
];

/**
 * Returns a random hotspot location
 */
function getHotspotLocation() {
  // pick a random base hotspot
  const base = hotspots[Math.floor(Math.random() * hotspots.length)];
  let destPoint;
  do {
    // jitter distance up to 0.2 km and random bearing
    const distanceKm = Math.random() * 0.2;
    const bearing = Math.random() * 360;
    destPoint = turf.destination(turf.point([base.lng, base.lat]), distanceKm, bearing, { units: 'kilometers' });
  } while (!turf.booleanPointInPolygon(destPoint, gelsenkirchenBoundary));
  const [lng, lat] = destPoint.geometry.coordinates;
  return { lat, lng };
}

function getRandomLocation() {
    const bbox = turf.bbox(gelsenkirchenBoundary);
    // turf.randomPoint expects a count and options with a bounding box.
    const randomPoints = turf.randomPoint(1, { bbox });
    const randomPoint = randomPoints.features[0];

    // Ensure the point is within the polygon, not just the bounding box
    if (turf.booleanPointInPolygon(randomPoint, gelsenkirchenBoundary)) {
        return {
            lat: randomPoint.geometry.coordinates[1],
            lng: randomPoint.geometry.coordinates[0],
        };
    } else {
        // Retry if the point is outside the actual boundary
        return getRandomLocation();
    }
}

const app = express();
const parties = {};
const users = {};
const JWT_SECRET = process.env.JWT_SECRET;
console.log('🎤 JWT_SECRET from env:', JWT_SECRET);
if (!JWT_SECRET) {
  console.error('🚨 Missing JWT_SECRET env var');
  process.exit(1);
}

// Helper to generate a unique 6-character party code
function generateCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Auth endpoints
app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (users[username]) return res.status(409).json({ error: 'User exists' });
  const hash = await bcrypt.hash(password, 10);
  users[username] = hash;
  return res.status(201).json({ message: 'User created' });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const hash = users[username];
  if (!hash) return res.status(401).json({ error: 'Invalid credentials' });
  const match = await bcrypt.compare(password, hash);
  if (!match) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '1h' });
  return res.json({ token });
});
// Enable preflight for all routes
app.options('*', cors({ origin: true, credentials: true }));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: ['http://localhost:5174'],
        methods: ['GET', 'POST', 'OPTIONS'],
        credentials: true
    },
    transports: ['websocket', 'polling']
});

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error'));
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return next(new Error('Authentication error'));
    socket.data.user = decoded.username;
    next();
  });
});
io.on('connection', (socket) => {
    console.log('a user connected:', socket.id);

    // Party system handlers
    socket.on('create-party', ({ roundLimit, mode }) => {
      const code = generateCode();
      parties[code] = {
        code,
        mode,
        roundLimit,
        host: socket.data.user,
        participants: [socket.data.user],
        readySet: new Set(),
        round: 0,
        trueLocation: null,
        guesses: {}
      };
      socket.data.party = code;
      socket.join(code);
      io.to(code).emit('party-created', { code, roundLimit, mode, participants: parties[code].participants });
    });

    socket.on('join-party', ({ code }) => {
      const party = parties[code];
      if (!party) {
        socket.emit('error', 'Invalid party code');
        return;
      }
      party.participants = Array.from(new Set([...party.participants, socket.data.user]));
      socket.data.party = code;
      socket.join(code);
      io.to(code).emit('player-joined', { participants: party.participants });
    });

    socket.on('player-ready', () => {
      const code = socket.data.party;
      const party = parties[code];
      if (!party) return;
      party.readySet.add(socket.id);
      console.log(`[Server] player-ready: socket ${socket.id} in party ${code}, readySet: ${JSON.stringify(Array.from(party.readySet))}, participants: ${party.participants}`);
      io.to(code).emit('player-ready', { playerId: socket.id });
      if (party.readySet.size === party.participants.length) {
        party.readySet.clear();
        party.round++;
        if (party.round > party.roundLimit) {
          io.to(code).emit('game-over');
        } else {
          const location = party.mode === 'hotspot' ? hotspots[Math.floor(Math.random() * hotspots.length)] : getRandomLocation();
          party.trueLocation = location;
          party.guesses = {};
          console.log(`[Server] Emitting new-round for party ${code} at round ${party.round}`);
      io.to(code).emit('new-round', { location, round: party.round });
        }
      }
    });

    socket.on('submit-guess', ({ lat, lng }) => {
      const code = socket.data.party;
      const party = parties[code];
      if (!party || !party.trueLocation) {
        console.log(`[Server] submit-guess from ${socket.id} but missing party or trueLocation (party=${!!party}, trueLocation=${!!party?.trueLocation})`);
        return;
      }
      console.log(`[Server] submit-guess: client ${socket.id} in party ${code} guessed (${lat},${lng})`);
      party.guesses[socket.id] = { lat, lng };
      const room = io.sockets.adapter.rooms.get(code);
      const numClients = room ? room.size : party.participants.length;
      console.log(`[Server] guesses count: ${Object.keys(party.guesses).length}/${numClients}`);
      if (Object.keys(party.guesses).length === numClients) {
        console.log(`[Server] All players guessed for party ${code}, emitting round-results`);
        io.to(code).emit('round-results', { trueLocation: party.trueLocation, guesses: party.guesses });
      }
    });



    socket.on('start-game', (mode) => {
        // store chosen mode on socket
        socket.data.mode = mode || 'random';
        // choose location based on mode
        const location = mode === 'hotspot' ? hotspots[Math.floor(Math.random() * hotspots.length)] : getRandomLocation();
        console.log(`Starting game for ${socket.id} [mode=${mode}] at`, location);
        socket.emit('new-round', { location, mode: socket.data.mode });
    });

    socket.on('request-new-location', () => {
        // preserve mode or default to random
        const mode = socket.data.mode || 'random';
        const location = mode === 'hotspot' ? hotspots[Math.floor(Math.random() * hotspots.length)] : getRandomLocation();
        console.log(`Request new location for ${socket.id} [mode=${mode}] at`, location);
        socket.emit('new-round', { location, mode: socket.data.mode });
    });

    socket.on('disconnect', () => {
        console.log('user disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
