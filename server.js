'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DATA_FILE = path.join(DATA_DIR, 'school-data.json');
const PULSE_LIMIT_SECONDS = 35;
const SCHOOL_NAME = (process.env.SCHOOL_NAME || '우리 학교').trim().replace(/[<>]/g, '') || '우리 학교';
const visitorPulseTimes = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
let database = fs.existsSync(DATA_FILE)
  ? JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  : { visitors: [] };
if (!Array.isArray(database.visitors)) database.visitors = [];

function saveDatabase() {
  const temporaryFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(database, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, DATA_FILE);
}

function todayKey() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function publicVisitor(visitor) {
  return {
    id: visitor.id,
    displayName: visitor.displayName,
    todaySeconds: visitor.dailyStudySeconds?.[todayKey()] || 0,
    totalStudySeconds: visitor.totalStudySeconds || 0
  };
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  response.end(JSON.stringify(payload));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.on('data', chunk => {
      raw += chunk;
      if (raw.length > 16_384) {
        reject(Object.assign(new Error('요청이 너무 큽니다.'), { status: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(Object.assign(new Error('요청 형식이 올바르지 않습니다.'), { status: 400 })); }
    });
    request.on('error', reject);
  });
}

function getOrCreateVisitor(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(id)) {
    throw Object.assign(new Error('브라우저 식별자가 올바르지 않습니다.'), { status: 400 });
  }
  let visitor = database.visitors.find(candidate => candidate.id === id);
  if (!visitor) {
    visitor = {
      id,
      displayName: `익명 학생 ${id.slice(0, 5).toUpperCase()}`,
      totalStudySeconds: 0,
      dailyStudySeconds: {},
      createdAt: new Date().toISOString()
    };
    database.visitors.push(visitor);
    saveDatabase();
  }
  return visitor;
}

function formatLeaderboard() {
  const students = database.visitors
    .map(publicVisitor)
    .sort((a, b) => b.todaySeconds - a.todaySeconds || b.totalStudySeconds - a.totalStudySeconds);
  return {
    school: SCHOOL_NAME,
    todaySeconds: students.reduce((total, student) => total + student.todaySeconds, 0),
    students
  };
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/leaderboard') {
    return sendJson(response, 200, formatLeaderboard());
  }
  if (request.method === 'POST' && url.pathname === '/api/study/pulse') {
    const body = await readJson(request);
    const visitor = getOrCreateVisitor(body.visitorId);
    const now = Date.now();
    const lastPulseAt = visitorPulseTimes.get(visitor.id) || now;
    const elapsed = Math.max(0, Math.min(PULSE_LIMIT_SECONDS, Math.floor((now - lastPulseAt) / 1000)));
    visitorPulseTimes.set(visitor.id, now);
    if (body.active === true && elapsed > 0) {
      const date = todayKey();
      visitor.totalStudySeconds = (visitor.totalStudySeconds || 0) + elapsed;
      visitor.dailyStudySeconds ||= {};
      visitor.dailyStudySeconds[date] = (visitor.dailyStudySeconds[date] || 0) + elapsed;
      saveDatabase();
    }
    return sendJson(response, 200, { user: publicVisitor(visitor), leaderboard: formatLeaderboard() });
  }
  return sendJson(response, 404, { error: '요청한 주소를 찾을 수 없습니다.' });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: '지원하지 않는 요청입니다.' });
    if (url.pathname !== '/' && url.pathname !== '/index.html') {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return response.end('Not found');
    }
    const html = fs.readFileSync(path.join(__dirname, 'index.html'));
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy': "default-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:"
    });
    response.end(request.method === 'HEAD' ? undefined : html);
  } catch (error) {
    if (!response.headersSent) sendJson(response, error.status || 500, { error: error.status ? error.message : '서버 오류가 발생했습니다.' });
    else response.destroy();
    if (!error.status) console.error(error);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`기능톡 서버 실행 중: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`학교 이름: ${SCHOOL_NAME}`);
  console.log(`학습 기록 저장 위치: ${DATA_FILE}`);
});
