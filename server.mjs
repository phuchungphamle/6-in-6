import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import {
  createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual
} from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(scryptCallback);
const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const uploadsDir = path.join(dataDir, 'reviews');
const dbPath = path.join(dataDir, 'challenge.sqlite');
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const trustProxy = process.env.TRUST_PROXY === '1';
const sessionCookie = 'six_in_six_session';
const sessionSecret = process.env.SESSION_SECRET || randomBytes(48);
const sessionLifetimeSeconds = 60 * 60 * 12;
const maxPhotoBytes = 2 * 1024 * 1024;
const maxBodyBytes = 3 * 1024 * 1024;
const loginAttempts = new Map();
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};
const publicFiles = new Set(['index.html', 'app.js', 'styles.css', 'catalog.js']);

function configurationError(message) {
  console.error('Configuration error: ' + message);
  process.exit(1);
}

const teacherPassword = process.env.TEACHER_PASSWORD;
if (!teacherPassword || teacherPassword.length < (isProduction ? 12 : 4)) {
  configurationError(isProduction
    ? 'Set TEACHER_PASSWORD to a private password at least 12 characters long.'
    : 'Set TEACHER_PASSWORD before starting the app (at least 4 characters in development).');
}
if (isProduction && !process.env.SESSION_SECRET) {
  configurationError('Set SESSION_SECRET to a random secret of at least 32 characters.');
}
if (isProduction && process.env.SESSION_SECRET.length < 32) {
  configurationError('SESSION_SECRET must be at least 32 characters long.');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  configurationError('PORT must be an integer from 1 to 65535.');
}

await mkdir(uploadsDir, { recursive: true });
const database = new DatabaseSync(dbPath);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    categories_json TEXT NOT NULL,
    key_stages_json TEXT NOT NULL,
    audience_flags_json TEXT NOT NULL,
    goodreads_url TEXT NOT NULL,
    epub_filename TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS students (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    class_name TEXT NOT NULL DEFAULT '',
    key_stage TEXT NOT NULL DEFAULT '',
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    book_id TEXT NOT NULL REFERENCES books(id),
    review_text TEXT NOT NULL DEFAULT '',
    photo_filename TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
    created_at TEXT NOT NULL,
    reviewed_at TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_active_submission_per_book
    ON submissions(student_id, book_id) WHERE status IN ('pending', 'approved');
  CREATE INDEX IF NOT EXISTS submissions_status_created
    ON submissions(status, created_at);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK(role IN ('student', 'teacher')),
    student_id TEXT REFERENCES students(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    CHECK((role = 'student' AND student_id IS NOT NULL) OR (role = 'teacher' AND student_id IS NULL))
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
`);

const catalogContext = { window: {} };
const vm = await import('node:vm');
const catalogSource = await readFile(path.join(root, 'catalog.js'), 'utf8');
vm.runInNewContext(catalogSource, catalogContext, { timeout: 1000, filename: 'catalog.js' });
const catalog = catalogContext.window.SIX_IN_SIX_CATALOG;
if (!Array.isArray(catalog) || catalog.length !== 154) {
  configurationError('The bundled catalog must contain all 154 books.');
}

const bookCount = database.prepare('SELECT COUNT(*) AS count FROM books').get().count;
if (bookCount === 0) {
  const insertBook = database.prepare(`
    INSERT INTO books (id,title,description,categories_json,key_stages_json,audience_flags_json,goodreads_url,epub_filename)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const book of catalog) {
      insertBook.run(
        book.id, book.title, book.description, JSON.stringify(book.categories),
        JSON.stringify(book.keyStages), JSON.stringify(book.audienceFlags || []),
        book.goodreadsUrl || '', book.epubFilename || ''
      );
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
} else if (bookCount !== catalog.length) {
  configurationError(`Database contains ${bookCount} books; expected ${catalog.length}.`);
}

const teacherSalt = randomBytes(16);
const teacherHash = await scrypt(teacherPassword, teacherSalt, 64);

function sendJson(response, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  response.end(payload);
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function cookieValue(request, name) {
  const cookies = (request.headers.cookie || '').split(';');
  const entry = cookies.map(function (item) { return item.trim(); }).find(function (item) {
    return item.startsWith(name + '=');
  });
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : '';
}

function setSessionCookie(response, token) {
  const secure = isProduction ? '; Secure' : '';
  response.setHeader('Set-Cookie', `${sessionCookie}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sessionLifetimeSeconds}${secure}`);
}

function clearSessionCookie(response) {
  const secure = isProduction ? '; Secure' : '';
  response.setHeader('Set-Cookie', `${sessionCookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

function hashToken(token) {
  return createHmac('sha256', sessionSecret).update(token).digest('hex');
}

function currentSession(request) {
  const token = cookieValue(request, sessionCookie);
  if (!token || token.length > 256) return null;
  const hash = hashToken(token);
  const row = database.prepare('SELECT role,student_id,expires_at FROM sessions WHERE token_hash=?').get(hash);
  if (!row || row.expires_at <= Date.now()) {
    if (row) database.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash);
    return null;
  }
  return { tokenHash: hash, role: row.role, studentId: row.student_id };
}

function requireRole(request, response, role) {
  const session = currentSession(request);
  if (!session || session.role !== role) {
    sendError(response, 401, role === 'teacher' ? 'Teacher sign-in required.' : 'Student sign-in required.');
    return null;
  }
  return session;
}

function safeStudent(studentId) {
  return database.prepare('SELECT id,username,name,class_name AS className,key_stage AS keyStage FROM students WHERE id=?').get(studentId) || null;
}

function safeBook(row) {
  return {
    id: row.id, title: row.title, description: row.description,
    categories: JSON.parse(row.categories_json),
    keyStages: JSON.parse(row.key_stages_json),
    audienceFlags: JSON.parse(row.audience_flags_json),
    goodreadsUrl: row.goodreads_url, epubFilename: row.epub_filename
  };
}

function publicBooks() {
  return database.prepare('SELECT * FROM books ORDER BY rowid').all().map(safeBook);
}

function publicLeaderboard() {
  return database.prepare(`
    SELECT s.name, s.class_name AS className, COUNT(DISTINCT sub.book_id) AS books
    FROM students s
    LEFT JOIN submissions sub ON sub.student_id=s.id AND sub.status='approved'
    GROUP BY s.id
    ORDER BY books DESC, s.name COLLATE NOCASE ASC
  `).all();
}

function checkSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  const forwardedHost = trustProxy ? request.headers['x-forwarded-host'] : '';
  const forwardedProto = trustProxy ? request.headers['x-forwarded-proto'] : '';
  const host = forwardedHost || request.headers.host;
  const protocol = forwardedProto === 'https' || request.socket.encrypted ? 'https:' : 'http:';
  try {
    const parsed = new URL(origin);
    return parsed.origin === `${protocol}//${host}`;
  } catch {
    return false;
  }
}

async function readJson(request, limit = maxBodyBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('Request body is too large.');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.status = 400;
    throw error;
  }
}

function validText(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

function tooManyAttempts(request, response, purpose) {
  const key = purpose + ':' + (request.socket.remoteAddress || 'unknown');
  const now = Date.now();
  const recent = (loginAttempts.get(key) || []).filter(function (time) { return time > now - 15 * 60 * 1000; });
  if (recent.length >= 10) {
    sendError(response, 429, 'Too many sign-in attempts. Please wait 15 minutes and try again.');
    return true;
  }
  recent.push(now);
  loginAttempts.set(key, recent);
  return false;
}

async function issueSession(response, role, studentId = null) {
  const token = randomBytes(32).toString('base64url');
  const expires = Date.now() + sessionLifetimeSeconds * 1000;
  database.prepare('INSERT INTO sessions (token_hash,role,student_id,expires_at) VALUES (?,?,?,?)')
    .run(hashToken(token), role, studentId, expires);
  setSessionCookie(response, token);
}

function safePasswordEqual(actual, expected) {
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function identifyPhoto(dataUrl) {
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl || '');
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > maxPhotoBytes) return null;
  const isJpeg = match[1] === 'jpeg' && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const isPng = match[1] === 'png' && bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const isWebp = match[1] === 'webp' && bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!isJpeg && !isPng && !isWebp) return null;
  return { bytes, extension: isJpeg ? '.jpg' : isPng ? '.png' : '.webp', contentType: `image/${match[1]}` };
}

function submissionRows(whereSql, value) {
  const query = database.prepare(`
    SELECT sub.id,sub.student_id AS studentId,sub.book_id AS bookId,b.title AS bookTitle,
      sub.review_text AS reviewText,sub.status,sub.created_at AS createdAt,
      sub.reviewed_at AS reviewedAt,s.name AS studentName,s.class_name AS className
    FROM submissions sub JOIN books b ON b.id=sub.book_id JOIN students s ON s.id=sub.student_id
    WHERE ${whereSql} ORDER BY sub.created_at DESC
  `);
  return value === undefined ? query.all() : query.all(value);
}

function securityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
  if (isProduction) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

async function handleApi(request, response, url) {
  const method = request.method;
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/api/health') {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (method === 'GET' && pathname === '/api/bootstrap') {
    const session = currentSession(request);
    let user = null;
    if (session?.role === 'student') user = safeStudent(session.studentId);
    if (session?.role === 'teacher') user = { role: 'teacher', name: 'Teacher' };
    sendJson(response, 200, {
      books: publicBooks(), user,
      leaderboard: publicLeaderboard(),
      pendingCount: database.prepare("SELECT COUNT(*) AS count FROM submissions WHERE status='pending'").get().count
    });
    return;
  }

  if (method !== 'GET' && method !== 'HEAD' && !checkSameOrigin(request)) {
    sendError(response, 403, 'Request origin was not allowed.');
    return;
  }

  if (method === 'POST' && pathname === '/api/register') {
    if (tooManyAttempts(request, response, 'register')) return;
    const body = await readJson(request);
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = body.password;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const className = typeof body.className === 'string' ? body.className.trim() : '';
    const keyStage = typeof body.keyStage === 'string' ? body.keyStage : '';
    if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
      sendError(response, 400, 'Username must be 3–32 characters using letters, numbers, dots, hyphens, or underscores.');
      return;
    }
    if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
      sendError(response, 400, 'Choose a password with at least 12 characters.');
      return;
    }
    if (!validText(name, 60) || className.length > 60 || !['', 'KS1', 'KS2', 'KS3', 'KS4', 'KS5'].includes(keyStage)) {
      sendError(response, 400, 'Check the name, class, and Key Stage fields.');
      return;
    }
    const salt = randomBytes(16);
    const passwordHash = await scrypt(password, salt, 64);
    const id = randomBytes(16).toString('hex');
    try {
      database.prepare(`
        INSERT INTO students (id,username,name,class_name,key_stage,password_salt,password_hash,created_at)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(id, username, name, className, keyStage, salt.toString('hex'), passwordHash.toString('hex'), new Date().toISOString());
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed')) {
        sendError(response, 409, 'That username is already in use.');
        return;
      }
      throw error;
    }
    await issueSession(response, 'student', id);
    sendJson(response, 201, { user: safeStudent(id) });
    return;
  }

  if (method === 'POST' && pathname === '/api/login') {
    if (tooManyAttempts(request, response, 'student-login')) return;
    const body = await readJson(request);
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const student = database.prepare('SELECT id,password_salt AS salt,password_hash AS hash FROM students WHERE username=?').get(username);
    const salt = student ? Buffer.from(student.salt, 'hex') : Buffer.alloc(16);
    const expectedHash = student ? Buffer.from(student.hash, 'hex') : Buffer.alloc(64);
    const actualHash = await scrypt(password, salt, 64);
    if (!student || !safePasswordEqual(actualHash, expectedHash)) {
      sendError(response, 401, 'Username or password did not match.');
      return;
    }
    await issueSession(response, 'student', student.id);
    sendJson(response, 200, { user: safeStudent(student.id) });
    return;
  }

  if (method === 'POST' && pathname === '/api/teacher/login') {
    if (tooManyAttempts(request, response, 'teacher-login')) return;
    const body = await readJson(request);
    const supplied = typeof body.password === 'string' ? body.password : '';
    const actualHash = await scrypt(supplied, teacherSalt, 64);
    if (!safePasswordEqual(actualHash, teacherHash)) {
      sendError(response, 401, 'Teacher password did not match.');
      return;
    }
    await issueSession(response, 'teacher');
    sendJson(response, 200, { user: { role: 'teacher', name: 'Teacher' } });
    return;
  }

  if (method === 'DELETE' && pathname === '/api/session') {
    const session = currentSession(request);
    if (session) database.prepare('DELETE FROM sessions WHERE token_hash=?').run(session.tokenHash);
    clearSessionCookie(response);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === 'GET' && pathname === '/api/submissions') {
    const session = currentSession(request);
    if (!session) { sendError(response, 401, 'Sign in to view submissions.'); return; }
    const submissions = session.role === 'teacher'
      ? submissionRows("sub.status='pending'")
      : submissionRows('sub.student_id=?', session.studentId);
    sendJson(response, 200, { submissions });
    return;
  }

  if (method === 'POST' && pathname === '/api/submissions') {
    const session = requireRole(request, response, 'student');
    if (!session) return;
    const body = await readJson(request);
    if (typeof body.bookId !== 'string' || !database.prepare('SELECT id FROM books WHERE id=?').get(body.bookId)) {
      sendError(response, 400, 'Choose a book from the catalog.');
      return;
    }
    if (typeof body.reviewText !== 'string' || body.reviewText.trim().length > 1200) {
      sendError(response, 400, 'Review text must be 1,200 characters or fewer.');
      return;
    }
    const photo = identifyPhoto(body.photoData);
    if (!photo) {
      sendError(response, 400, 'Upload a valid JPEG, PNG, or WebP review photo under 2 MB.');
      return;
    }
    const id = randomBytes(16).toString('hex');
    const filename = id + photo.extension;
    const target = path.join(uploadsDir, filename);
    await writeFile(target, photo.bytes, { flag: 'wx', mode: 0o600 });
    try {
      database.prepare(`
        INSERT INTO submissions (id,student_id,book_id,review_text,photo_filename,status,created_at)
        VALUES (?,?,?,?,?,'pending',?)
      `).run(id, session.studentId, body.bookId, body.reviewText.trim(), filename, new Date().toISOString());
    } catch (error) {
      try {
        await unlink(target);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') console.error('Failed to remove an unlinked review photo:', cleanupError);
      }
      if (String(error.message).includes('UNIQUE constraint failed')) {
        sendError(response, 409, 'A review for this book is already awaiting approval or has been approved.');
        return;
      }
      throw error;
    }
    sendJson(response, 201, { submission: submissionRows('sub.id=?', id)[0] });
    return;
  }

  if (method === 'PATCH' && pathname.startsWith('/api/submissions/')) {
    const session = requireRole(request, response, 'teacher');
    if (!session) return;
    const id = pathname.slice('/api/submissions/'.length);
    if (!/^[a-f0-9]{32}$/.test(id)) { sendError(response, 404, 'Submission not found.'); return; }
    const body = await readJson(request, 16 * 1024);
    if (!['approved', 'rejected'].includes(body.status)) {
      sendError(response, 400, 'Choose approve or request changes.');
      return;
    }
    const result = database.prepare(`
      UPDATE submissions SET status=?, reviewed_at=?
      WHERE id=? AND status='pending'
    `).run(body.status, new Date().toISOString(), id);
    if (!result.changes) { sendError(response, 404, 'Pending submission not found.'); return; }
    sendJson(response, 200, { submission: submissionRows('sub.id=?', id)[0] });
    return;
  }

  const photoMatch = pathname.match(/^\/api\/submissions\/([a-f0-9]{32})\/photo$/);
  if (method === 'GET' && photoMatch) {
    const session = currentSession(request);
    if (!session) { sendError(response, 401, 'Sign in to view review photos.'); return; }
    const submission = database.prepare('SELECT student_id AS studentId,photo_filename AS filename FROM submissions WHERE id=?').get(photoMatch[1]);
    if (!submission || (session.role !== 'teacher' && session.studentId !== submission.studentId)) {
      sendError(response, 404, 'Review photo not found.');
      return;
    }
    const imagePath = path.join(uploadsDir, submission.filename);
    const image = await readFile(imagePath);
    const extension = path.extname(submission.filename);
    response.writeHead(200, {
      'Content-Type': extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg',
      'Content-Length': image.length,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(image);
    return;
  }

  sendError(response, 404, 'API endpoint not found.');
}

async function handleRequest(request, response) {
  securityHeaders(response);
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST' && request.method !== 'PATCH' && request.method !== 'DELETE') {
    sendError(response, 405, 'Method not allowed.');
    return;
  }
  let url;
  try {
    url = new URL(request.url, 'http://localhost');
  } catch {
    sendError(response, 400, 'Invalid request URL.');
    return;
  }
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendError(response, 405, 'Method not allowed.');
      return;
    }
    const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const fileName = requested.slice(1);
    if (fileName.includes('/') || fileName.includes('\\') || !publicFiles.has(fileName)) {
      sendError(response, 404, 'Not found.');
      return;
    }
    const filePath = path.resolve(root, '.' + requested);
    if (!filePath.startsWith(root + path.sep) || filePath === dbPath || filePath.startsWith(dataDir + path.sep)) {
      sendError(response, 404, 'Not found.');
      return;
    }
    const fileInfo = await stat(filePath);
    if (!fileInfo.isFile()) { sendError(response, 404, 'Not found.'); return; }
    const content = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': content.length,
      'Cache-Control': path.basename(filePath) === 'catalog.js' ? 'public, max-age=3600' : 'no-cache'
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (error.status) {
      sendError(response, error.status, error.message);
      return;
    }
    console.error('Request failed:', error);
    sendError(response, 500, 'Something went wrong. Please try again.');
  }
}

const server = createServer(handleRequest);
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
database.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
const cleanupTimer = setInterval(function () {
  database.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
}, 60 * 60 * 1000);
cleanupTimer.unref();

server.listen(port, '0.0.0.0', function () {
  console.log(`6 in 6 listening on port ${port} (${isProduction ? 'production' : 'development'})`);
  console.log(`Persistent database: ${dbPath}`);
});

function shutdown() {
  server.close(function () {
    database.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
