import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const teacherPassword = 'A private teacher password for integration tests';
const studentPassword = 'A private student password for integration tests';
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/0YQAAAAASUVORK5CYII=', 'base64');
let serverProcess;
let baseUrl;
let origin;
let dataDir;

async function unusedPort() {
  const probe = createServer();
  await new Promise(function (resolve, reject) {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise(function (resolve, reject) {
    probe.close(function (error) { if (error) reject(error); else resolve(); });
  });
  return port;
}

async function startServer() {
  const port = await unusedPort();
  baseUrl = 'http://127.0.0.1:' + port;
  origin = baseUrl;
  serverProcess = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      PORT: String(port),
      TEACHER_PASSWORD: teacherPassword
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  serverProcess.stdout.on('data', function (chunk) { output += chunk.toString(); });
  serverProcess.stderr.on('data', function (chunk) { output += chunk.toString(); });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) throw new Error('Server exited during startup:\n' + output);
    try {
      const response = await fetch(baseUrl + '/api/health');
      if (response.ok) return;
    } catch {}
    await new Promise(function (resolve) { setTimeout(resolve, 100); });
  }
  throw new Error('Server startup timed out:\n' + output);
}

async function jsonRequest(route, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Origin', origin);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return fetch(baseUrl + route, { ...options, headers });
}

function captureCookie(response) {
  const header = response.headers.get('set-cookie');
  assert.ok(header, 'expected the server to issue a session cookie');
  return header.split(';', 1)[0];
}

before(async function () {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'six-in-six-test-'));
  await startServer();
});

after(async function () {
  if (serverProcess && serverProcess.exitCode === null) {
    await new Promise(function (resolve) {
      serverProcess.once('exit', resolve);
      serverProcess.kill();
    });
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test('persistent API protects student accounts and teacher review', async function () {
  const page = await fetch(baseUrl + '/');
  assert.equal(page.status, 200);
  const appHtml = await page.text();
  assert.match(appHtml, /Teacher sign in/);
  assert.equal((await fetch(baseUrl + '/server.mjs')).status, 404);
  assert.equal((await fetch(baseUrl + '/.env.example')).status, 404);

  const bootstrap = await fetch(baseUrl + '/api/bootstrap').then(function (response) { return response.json(); });
  assert.equal(bootstrap.books.length, 154);
  assert.equal(bootstrap.pendingCount, 0);

  const wrongOrigin = await fetch(baseUrl + '/api/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.example' },
    body: JSON.stringify({})
  });
  assert.equal(wrongOrigin.status, 403);

  const register = await jsonRequest('/api/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Reader One', username: 'reader_one', className: '7A',
      keyStage: 'KS3', password: studentPassword
    })
  });
  assert.equal(register.status, 201);
  const studentCookie = captureCookie(register);
  const student = (await register.json()).user;
  assert.equal(student.name, 'Reader One');
  assert.equal(student.username, 'reader_one');
  assert.equal('passwordHash' in student, false);

  const duplicateUser = await jsonRequest('/api/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Duplicate', username: 'reader_one', password: studentPassword, keyStage: ''
    })
  });
  assert.equal(duplicateUser.status, 409);

  const wrongStudentLogin = await jsonRequest('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'reader_one', password: 'Wrong password for tests' })
  });
  assert.equal(wrongStudentLogin.status, 401);

  const anonymousSubmissions = await fetch(baseUrl + '/api/submissions');
  assert.equal(anonymousSubmissions.status, 401);

  const submission = await jsonRequest('/api/submissions', {
    method: 'POST',
    headers: { Cookie: studentCookie },
    body: JSON.stringify({
      bookId: bootstrap.books[0].id,
      reviewText: 'A thoughtful review.',
      photoData: 'data:image/png;base64,' + image.toString('base64')
    })
  });
  assert.equal(submission.status, 201);
  const savedSubmission = (await submission.json()).submission;
  assert.equal(savedSubmission.status, 'pending');

  const duplicateSubmission = await jsonRequest('/api/submissions', {
    method: 'POST',
    headers: { Cookie: studentCookie },
    body: JSON.stringify({
      bookId: bootstrap.books[0].id,
      reviewText: '',
      photoData: 'data:image/png;base64,' + image.toString('base64')
    })
  });
  assert.equal(duplicateSubmission.status, 409);

  const unauthorizedReview = await jsonRequest('/api/submissions/' + savedSubmission.id, {
    method: 'PATCH',
    headers: { Cookie: studentCookie },
    body: JSON.stringify({ status: 'approved' })
  });
  assert.equal(unauthorizedReview.status, 401);

  const wrongTeacherPassword = await jsonRequest('/api/teacher/login', {
    method: 'POST', body: JSON.stringify({ password: 'incorrect teacher password' })
  });
  assert.equal(wrongTeacherPassword.status, 401);

  const teacherLogin = await jsonRequest('/api/teacher/login', {
    method: 'POST', body: JSON.stringify({ password: teacherPassword })
  });
  assert.equal(teacherLogin.status, 200);
  const teacherCookie = captureCookie(teacherLogin);

  const queue = await jsonRequest('/api/submissions', { headers: { Cookie: teacherCookie } });
  assert.equal(queue.status, 200);
  assert.equal((await queue.json()).submissions.length, 1);

  const photo = await jsonRequest('/api/submissions/' + savedSubmission.id + '/photo', {
    headers: { Cookie: teacherCookie }
  });
  assert.equal(photo.status, 200);
  assert.deepEqual(Buffer.from(await photo.arrayBuffer()), image);

  const approval = await jsonRequest('/api/submissions/' + savedSubmission.id, {
    method: 'PATCH',
    headers: { Cookie: teacherCookie },
    body: JSON.stringify({ status: 'approved' })
  });
  assert.equal(approval.status, 200);

  const updated = await fetch(baseUrl + '/api/bootstrap').then(function (response) { return response.json(); });
  assert.equal(updated.pendingCount, 0);
  assert.equal(updated.leaderboard.length, 1);
  assert.equal(updated.leaderboard[0].books, 1);
  assert.equal(updated.leaderboard[0].username, undefined);

  const studentLogin = await jsonRequest('/api/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'reader_one', password: studentPassword })
  });
  assert.equal(studentLogin.status, 200);
  const loggedInCookie = captureCookie(studentLogin);
  const mySubmissions = await jsonRequest('/api/submissions', { headers: { Cookie: loggedInCookie } });
  assert.equal((await mySubmissions.json()).submissions[0].status, 'approved');
});
