const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const os = require('os');

function getLanIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));

app.get('/api/server-info', (req, res) => {
  const port = process.env.PORT || 3000;
  res.json({ ip: getLanIP(), port });
});

const DATA_FILE = path.join(__dirname, 'data', 'quizzes.json');
const upload = multer({ dest: 'data/uploads/' });

// ─── Data helpers ─────────────────────────────────────────────────────────────
function loadData() {
  if (!fs.existsSync(DATA_FILE)) return { quizzes: [] };
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ─── In-memory game state ─────────────────────────────────────────────────────
// sessions[roomCode] = { quizId, quiz, hostId, players, nameIndex, state, ... }
// players keyed by NAME (not socketId) to survive reconnects
// nameIndex[socketId] = name  — reverse lookup
const sessions = {};

function createSession(quizId) {
  const data = loadData();
  const quiz = data.quizzes.find(q => q.id === quizId);
  if (!quiz) return null;
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  sessions[code] = {
    code,
    quizId,
    quiz,
    hostId: null,
    players: {},      // name -> { name, score, answered, connected, socketId }
    nameIndex: {},    // socketId -> name
    state: 'lobby',   // lobby | question | reveal | finished
    currentQ: -1,
    timer: null,
    answerCounts: {}
  };
  return code;
}

// ─── REST API ─────────────────────────────────────────────────────────────────

app.get('/api/quizzes', (req, res) => {
  res.json(loadData().quizzes);
});

app.get('/api/quizzes/:id', (req, res) => {
  const quiz = loadData().quizzes.find(q => q.id === req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Not found' });
  res.json(quiz);
});

app.post('/api/quizzes', (req, res) => {
  const data = loadData();
  // Unique title check
  const title = (req.body.title || '').trim();
  if (data.quizzes.some(q => q.title.toLowerCase() === title.toLowerCase())) {
    return res.status(409).json({ error: 'A quiz with this title already exists' });
  }
  const quiz = { id: uuidv4(), ...req.body, title, createdAt: Date.now() };
  data.quizzes.push(quiz);
  saveData(data);
  res.json(quiz);
});

app.put('/api/quizzes/:id', (req, res) => {
  const data = loadData();
  const idx = data.quizzes.findIndex(q => q.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  // Unique title check (exclude self)
  const title = (req.body.title || '').trim();
  if (data.quizzes.some(q => q.id !== req.params.id && q.title.toLowerCase() === title.toLowerCase())) {
    return res.status(409).json({ error: 'A quiz with this title already exists' });
  }
  data.quizzes[idx] = { ...data.quizzes[idx], ...req.body, title };
  saveData(data);
  res.json(data.quizzes[idx]);
});

app.delete('/api/quizzes/:id', (req, res) => {
  const data = loadData();
  data.quizzes = data.quizzes.filter(q => q.id !== req.params.id);
  saveData(data);
  res.json({ ok: true });
});

app.post('/api/quizzes/import/json', upload.single('file'), (req, res) => {
  try {
    const raw = fs.readFileSync(req.file.path, 'utf8');
    const imported = JSON.parse(raw);
    const quizzes = Array.isArray(imported) ? imported : [imported];
    const data = loadData();
    const added = [];
    for (const q of quizzes) {
      let title = (q.title || 'Imported Quiz').trim();
      // Auto-suffix if duplicate
      let suffix = 1;
      while (data.quizzes.some(x => x.title.toLowerCase() === title.toLowerCase())) {
        title = `${(q.title || 'Imported Quiz').trim()} (${++suffix})`;
      }
      const quiz = { ...q, id: uuidv4(), title, createdAt: Date.now() };
      data.quizzes.push(quiz);
      added.push(quiz);
    }
    saveData(data);
    fs.unlinkSync(req.file.path);
    res.json({ imported: added.length, quizzes: added });
  } catch (e) {
    res.status(400).json({ error: 'Invalid JSON file: ' + e.message });
  }
});

app.post('/api/quizzes/import/csv', upload.single('file'), (req, res) => {
  try {
    const raw = fs.readFileSync(req.file.path, 'utf8');
    const lines = raw.trim().split('\n').map(l => l.split(',').map(s => s.trim().replace(/^"|"$/g, '')));
    const header = lines[0].map(h => h.toLowerCase());
    const rows = lines.slice(1);
    const byTitle = {};
    for (const row of rows) {
      const obj = {};
      header.forEach((h, i) => obj[h] = row[i] || '');
      const title = obj['quiz_title'] || obj['title'] || 'Imported Quiz';
      if (!byTitle[title]) byTitle[title] = [];
      byTitle[title].push({
        id: uuidv4(),
        text: obj['question'] || obj['text'] || '',
        options: [obj['a'] || '', obj['b'] || '', obj['c'] || '', obj['d'] || ''].filter(Boolean),
        correct: parseInt(obj['correct'] || '0'),
        timeLimit: parseInt(obj['timelimit'] || obj['time_limit'] || '30'),
        points: parseInt(obj['points'] || '100')
      });
    }
    const data = loadData();
    const added = [];
    for (const [rawTitle, questions] of Object.entries(byTitle)) {
      let title = rawTitle.trim();
      let suffix = 1;
      while (data.quizzes.some(x => x.title.toLowerCase() === title.toLowerCase())) {
        title = `${rawTitle.trim()} (${++suffix})`;
      }
      const quiz = {
        id: uuidv4(), title,
        description: 'Imported from CSV',
        questions,
        settings: { flow: 'host', timeLimit: 30, showLeaderboard: true },
        createdAt: Date.now()
      };
      data.quizzes.push(quiz);
      added.push(quiz);
    }
    saveData(data);
    fs.unlinkSync(req.file.path);
    res.json({ imported: added.length, quizzes: added });
  } catch (e) {
    res.status(400).json({ error: 'Invalid CSV file: ' + e.message });
  }
});

app.post('/api/sessions', (req, res) => {
  const { quizId } = req.body;
  const code = createSession(quizId);
  if (!code) return res.status(404).json({ error: 'Quiz not found' });
  res.json({ code });
});

// ─── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  // Host join / rejoin
  socket.on('host:join', ({ code }) => {
    const session = sessions[code];
    if (!session) return socket.emit('error', 'Session not found');
    session.hostId = socket.id;
    socket.join(code);
    socket.emit('host:joined', {
      code,
      quiz: session.quiz,
      players: Object.values(session.players),
      state: session.state,
      currentQ: session.currentQ
    });

    if (session.state === 'paused') {
      // Resume from pause: 3-second countdown then re-send game state
      const resumeState = session.stateBeforePause || 'question';
      session.state = resumeState;
      io.to(code).emit('game:resume:countdown', { seconds: 3 });
      setTimeout(() => {
        if (resumeState === 'question') {
          // Shift questionStartedAt forward by the pause duration so timers are correct
          const pauseDuration = Date.now() - (session.pausedAt || Date.now());
          if (session.questionStartedAt) session.questionStartedAt += pauseDuration;
          const q = session.quiz.questions[session.currentQ];
          io.to(code).emit('game:question', buildQuestionPayload(session, q));
          // Re-arm server timer if timed flow and time remains
          if (session.quiz.settings.flow === 'timed' && !session.revealReady) {
            const timeLimit = session.quiz.settings.timeLimit || q.timeLimit || 30;
            const elapsed = (Date.now() - session.questionStartedAt) / 1000;
            const remaining = Math.max(0, timeLimit - elapsed);
            if (remaining > 0) {
              session.timer = setTimeout(() => {
                if (session.revealReady) return;
                session.revealReady = true;
                const hSock = io.sockets.sockets.get(session.hostId);
                if (hSock) hSock.emit('game:reveal:ready');
              }, remaining * 1000);
            } else {
              session.revealReady = true;
              socket.emit('game:reveal:ready');
            }
          }
        } else if (resumeState === 'reveal') {
          const q = session.quiz.questions[session.currentQ];
          io.to(code).emit('game:reveal', buildRevealPayload(session, q));
        }
      }, 3000);
    } else if (session.state === 'question') {
      const q = session.quiz.questions[session.currentQ];
      socket.emit('game:question', buildQuestionPayload(session, q));
      if (session.revealReady) socket.emit('game:reveal:ready');
    } else if (session.state === 'reveal') {
      const q = session.quiz.questions[session.currentQ];
      socket.emit('game:reveal', buildRevealPayload(session, q));
    } else if (session.state === 'finished') {
      socket.emit('game:finished', { leaderboard: getLeaderboard(session) });
    }
  });

  // Player join — supports reconnect by name
  socket.on('player:join', ({ code, name }) => {
    const session = sessions[code];
    if (!session) return socket.emit('error', 'Room not found');

    const trimmedName = name.trim();

    // Check for name collision (new player using a name already taken by someone else)
    const existing = session.players[trimmedName];
    if (existing && existing.connected) {
      return socket.emit('error', `The name "${trimmedName}" is already taken in this room`);
    }

    if (existing) {
      // RECONNECT: restore the existing player under new socket
      delete session.nameIndex[existing.socketId];
      existing.socketId = socket.id;
      existing.connected = true;
      session.nameIndex[socket.id] = trimmedName;
      socket.join(code);

      // Notify host the player is back
      const hostSockR = session.hostId ? io.sockets.sockets.get(session.hostId) : null;
      if (hostSockR) hostSockR.emit('game:player:status', { name: trimmedName, online: true });

      socket.emit('player:rejoined', {
        name: trimmedName,
        score: existing.score,
        quiz: { title: session.quiz.title, description: session.quiz.description, appearance: session.quiz.appearance || null },
        state: session.state
      });

      // Re-send current game state so they catch up
      if (session.state === 'lobby') {
        socket.emit('lobby:update:self', { players: connectedPlayers(session) });
      } else if (session.state === 'question') {
        const q = session.quiz.questions[session.currentQ];
        const alreadyAnswered = existing.answered;
        socket.emit('game:question', buildQuestionPayload(session, q));
        if (alreadyAnswered) {
          socket.emit('player:answer:result', { correct: existing.lastCorrect || false, score: existing.score, alreadyAnswered: true, answerIndex: existing.lastAnswerIndex ?? -1 });
        }
      } else if (session.state === 'reveal') {
        const q = session.quiz.questions[session.currentQ];
        socket.emit('game:reveal', buildRevealPayload(session, q));
      } else if (session.state === 'finished') {
        socket.emit('game:finished', { leaderboard: getLeaderboard(session) });
      }
    } else {
      // NEW player
      if (session.state !== 'lobby') return socket.emit('error', 'Game already started');
      session.players[trimmedName] = {
        name: trimmedName, score: 0, answered: false,
        connected: true, socketId: socket.id, lastCorrect: false
      };
      session.nameIndex[socket.id] = trimmedName;
      socket.join(code);
      socket.emit('player:joined', {
        name: trimmedName,
        quiz: { title: session.quiz.title, description: session.quiz.description, appearance: session.quiz.appearance || null }
      });
    }

    io.to(code).emit('lobby:update', { players: connectedPlayers(session) });
  });

  // Host: start quiz
  socket.on('host:start', ({ code }) => {
    const session = sessions[code];
    if (!session || session.hostId !== socket.id) return;
    session.state = 'question';
    session.currentQ = 0;
    sendQuestion(code);
  });

  // Host: end quiz early
  socket.on('host:end', ({ code }) => {
    const session = sessions[code];
    if (!session || session.hostId !== socket.id) return;
    if (session.timer) clearTimeout(session.timer);
    session.state = 'finished';
    io.to(code).emit('game:finished', { leaderboard: getLeaderboard(session) });
    setTimeout(() => delete sessions[code], 60000 * 10);
  });

  // Host: reveal answer (host-paced flow — host controls when to show correct answer)
  socket.on('host:reveal', ({ code }) => {
    const session = sessions[code];
    if (!session || session.hostId !== socket.id) return;
    if (session.state !== 'question') return;
    if (session.timer) clearTimeout(session.timer);
    revealAnswer(code);
  });

  // Host: next question
  socket.on('host:next', ({ code }) => {
    const session = sessions[code];
    if (!session || session.hostId !== socket.id) return;
    if (session.timer) clearTimeout(session.timer);
    advanceOrFinish(code);
  });

  // Player: submit answer
  socket.on('player:answer', ({ code, answerIndex }) => {
    const session = sessions[code];
    if (!session || session.state !== 'question') return;
    const name = session.nameIndex[socket.id];
    if (!name) return;
    const player = session.players[name];
    if (!player || player.answered) return;

    player.answered = true;
    const q = session.quiz.questions[session.currentQ];
    const correct = answerIndex === q.correct;
    player.lastCorrect = correct;
    player.lastAnswerIndex = answerIndex;

    if (correct) {
      player.answerPosition = ++session.answerOrder; // 1st, 2nd, 3rd correct
      const basePoints = q.points || 100;
      let speedBonus = 0;
      const flow = session.quiz.settings.flow;
      if (flow !== 'self-paced' && session.questionStartedAt) {
        const timeLimit = session.quiz.settings.timeLimit || q.timeLimit || 30;
        const elapsed = (Date.now() - session.questionStartedAt) / 1000;
        const timeRemaining = Math.max(0, timeLimit - elapsed);
        speedBonus = Math.round(basePoints * 0.5 * (timeRemaining / timeLimit));
      }
      player.score += basePoints + speedBonus;
      player.lastSpeedBonus = speedBonus;
    }

    if (!session.answerCounts[session.currentQ]) session.answerCounts[session.currentQ] = {};
    session.answerCounts[session.currentQ][answerIndex] =
      (session.answerCounts[session.currentQ][answerIndex] || 0) + 1;

    socket.emit('player:answer:result', { correct, score: player.score, answerPosition: player.answerPosition });
    const connectedPls = Object.values(session.players).filter(p => p.connected);
    const answeredCount = Object.values(session.players).filter(p => p.answered).length;
    io.to(code).emit('game:answer:update', {
      answeredCount,
      totalCount: connectedPls.length
    });

    // All connected players answered — signal host to reveal (no auto-reveal)
    if (session.quiz.settings.flow !== 'self-paced' && !session.revealReady) {
      const allConnectedAnswered = connectedPls.length > 0 && connectedPls.every(p => p.answered);
      if (allConnectedAnswered) {
        if (session.timer) clearTimeout(session.timer);
        session.revealReady = true;
        const hostSock = io.sockets.sockets.get(session.hostId);
        if (hostSock) hostSock.emit('game:reveal:ready');
      }
    }
  });

  socket.on('disconnect', () => {
    for (const code of Object.keys(sessions)) {
      const session = sessions[code];

      // Host disconnected
      if (socket.id === session.hostId) {
        session.hostId = null;
        if (session.state === 'question' || session.state === 'reveal') {
          if (session.timer) { clearTimeout(session.timer); session.timer = null; }
          session.stateBeforePause = session.state;
          session.state = 'paused';
          session.pausedAt = Date.now();
          io.to(code).emit('game:paused');
        }
        continue;
      }

      // Player disconnected
      const name = session.nameIndex[socket.id];
      if (name && session.players[name]) {
        session.players[name].connected = false;
        delete session.nameIndex[socket.id];
        io.to(code).emit('lobby:update', { players: connectedPlayers(session) });
        // Notify host
        const hostSock = session.hostId ? io.sockets.sockets.get(session.hostId) : null;
        if (hostSock) hostSock.emit('game:player:status', { name, online: false });
        // Re-check all-answered (disconnected player may have been the last one blocking reveal)
        if (session.state === 'question' && !session.revealReady && session.quiz.settings.flow !== 'self-paced') {
          const stillConnected = Object.values(session.players).filter(p => p.connected);
          if (stillConnected.length > 0 && stillConnected.every(p => p.answered)) {
            if (session.timer) clearTimeout(session.timer);
            session.revealReady = true;
            if (hostSock) hostSock.emit('game:reveal:ready');
          }
        }
      }
    }
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function connectedPlayers(session) {
  return Object.values(session.players); // include disconnected so host sees them
}

function buildQuestionPayload(session, q) {
  const flow = session.quiz.settings.flow;
  const timeLimit = session.quiz.settings.timeLimit || q.timeLimit || 30;
  return {
    index: session.currentQ,
    total: session.quiz.questions.length,
    text: q.text,
    options: q.options,
    points: q.points || 100,
    timeLimit: flow === 'self-paced' ? null : timeLimit,
    startedAt: session.questionStartedAt || null,
    flow
  };
}

function buildRevealPayload(session, q) {
  const counts = session.answerCounts[session.currentQ] || {};
  // Use total player count so percentages represent "% of all players", not just answerers
  const total = Object.keys(session.players).length;
  const enriched = {};
  q.options.forEach((_, i) => {
    const n = counts[i] || 0;
    enriched[i] = { count: n, pct: total > 0 ? Math.round(n / total * 100) : 0 };
  });
  return {
    correctIndex: q.correct,
    explanation: q.explanation || null,
    leaderboard: getLeaderboard(session),
    answerCounts: enriched,
    options: q.options,        // needed for reconnected players who missed game:question
    questionText: q.text
  };
}

function sendQuestion(code) {
  const session = sessions[code];
  const q = session.quiz.questions[session.currentQ];
  Object.values(session.players).forEach(p => { p.answered = false; p.answerPosition = 0; });
  session.answerOrder = 0;
  session.revealReady = false;
  session.questionStartedAt = Date.now();
  io.to(code).emit('game:question', buildQuestionPayload(session, q));
  if (session.quiz.settings.flow === 'timed') {
    const timeLimit = session.quiz.settings.timeLimit || q.timeLimit || 30;
    session.timer = setTimeout(() => {
      if (session.revealReady) return; // already signalled
      session.revealReady = true;
      const hostSock = io.sockets.sockets.get(session.hostId);
      if (hostSock) hostSock.emit('game:reveal:ready');
    }, timeLimit * 1000);
  }
}

function revealAnswer(code) {
  const session = sessions[code];
  session.state = 'reveal';
  // Mark all players who didn't answer as having answered wrong
  Object.values(session.players).forEach(p => {
    if (!p.answered) {
      p.answered = true;
      p.lastCorrect = false;
      p.lastAnswerIndex = -1;
    }
  });
  const q = session.quiz.questions[session.currentQ];
  io.to(code).emit('game:reveal', buildRevealPayload(session, q));
  if (session.quiz.settings.flow !== 'host') {
    session.timer = setTimeout(() => advanceOrFinish(code), 5000);
  }
}

function advanceOrFinish(code) {
  const session = sessions[code];
  session.currentQ++;
  if (session.currentQ >= session.quiz.questions.length) {
    session.state = 'finished';
    io.to(code).emit('game:finished', { leaderboard: getLeaderboard(session) });
    setTimeout(() => delete sessions[code], 60000 * 10);
  } else {
    session.state = 'question';
    sendQuestion(code);
  }
}

function getLeaderboard(session) {
  return Object.values(session.players)
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score, connected: p.connected }));
}

// ─── Pages ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/join', (req, res) => res.sendFile(path.join(__dirname, 'public', 'join.html')));
app.get('/play', (req, res) => res.sendFile(path.join(__dirname, 'public', 'play.html')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎯 Quiz App running at http://localhost:${PORT}`);
  console.log(`   Share with devices on your network using your local IP\n`);
});
