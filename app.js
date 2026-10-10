(function () {
  'use strict';

  const CHALLENGE_GOAL = 6;
  const CATEGORIES = [
    'Classic Literature', 'Drama/Play', 'Dystopian', 'Fantasy',
    'Historical Fiction', 'Literary Fiction', 'Memoir/Biography',
    'Mystery/Crime/Thriller', 'Non-Fiction', 'Romance', 'Science Fiction',
    'Vietnamese Language/Author'
  ];

  const state = {
    books: Array.isArray(window.SIX_IN_SIX_CATALOG) ? window.SIX_IN_SIX_CATALOG : [],
    currentStudent: null, submissions: [], leaderboard: [],
    pendingCount: 0, teacherAuthenticated: false
  };
  let selectedGenre = 'All books';
  let selectedStage = '';
  let loginBusy = false;
  let toastTimer;
  const main = document.getElementById('main-content');
  const teacherDialog = document.getElementById('teacher-dialog');

  async function api(path, options) {
    const settings = options || {};
    const headers = new Headers(settings.headers || {});
    if (settings.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch('/api' + path, {
      ...settings, headers: headers, credentials: 'same-origin'
    });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : null;
    if (!response.ok) throw new Error(payload && payload.error ? payload.error : 'The server could not complete the request.');
    return payload;
  }

  async function refreshBootstrap() {
    const data = await api('/bootstrap');
    state.books = data.books;
    state.currentStudent = data.user && data.user.role !== 'teacher' ? data.user : null;
    state.teacherAuthenticated = Boolean(data.user && data.user.role === 'teacher');
    state.leaderboard = data.leaderboard;
    state.pendingCount = data.pendingCount;
    if (state.currentStudent) {
      state.submissions = (await api('/submissions')).submissions;
    }
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function currentStudent() {
    return state.currentStudent;
  }

  function approvedFor(studentId) {
    return state.submissions
      .filter(function (submission) { return submission.studentId === studentId && submission.status === 'approved'; })
      .filter(function (submission, index, all) {
        return all.findIndex(function (other) { return other.bookId === submission.bookId; }) === index;
      });
  }

  async function setView(view) {
    if (view === 'review' && !state.teacherAuthenticated) {
      teacherDialog.hidden = false;
      document.getElementById('teacher-password').focus();
      return;
    }
    document.querySelectorAll('.nav-link').forEach(function (link) {
      link.classList.toggle('active', link.dataset.view === view);
    });
    if (view === 'discover') renderDiscover();
    if (view === 'challenge') renderChallenge();
    if (view === 'leaderboard') renderLeaderboard();
    if (view === 'review') {
      try {
        state.submissions = (await api('/submissions')).submissions;
        renderReviews();
      } catch (error) {
        showToast(error.message);
      }
    }
    updateChrome();
    main.focus({ preventScroll: true });
  }

  function updateChrome() {
    const student = currentStudent();
    const approved = student ? approvedFor(student.id).length : 0;
    document.getElementById('nav-progress').textContent = approved + '/' + CHALLENGE_GOAL;
    document.getElementById('pending-count').textContent = String(state.pendingCount);
    document.getElementById('teacher-nav-label').textContent = state.teacherAuthenticated ? 'Review submissions' : 'Teacher sign in';
    document.getElementById('profile-button').textContent = student ? student.name.charAt(0).toUpperCase() : '?';
    document.getElementById('sidebar-profile').innerHTML = student
      ? '<div class="profile-avatar">' + escapeHtml(student.name.charAt(0).toUpperCase()) + '</div><div><div class="profile-name">' + escapeHtml(student.name) + '</div><div class="profile-sub">' + escapeHtml(student.className || 'Student') + '</div></div>'
      : '<div class="profile-avatar">?</div><div><div class="profile-name">Guest reader</div><div class="profile-sub">Sign in to track your books</div></div>';
  }

  function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 3200);
  }

  function pageHeader(eyebrow, title, subtitle) {
    return '<span class="eyebrow">' + escapeHtml(eyebrow) + '</span><h1 class="page-heading">' + escapeHtml(title) + '</h1><p class="page-subtitle">' + escapeHtml(subtitle) + '</p>';
  }

  function renderDiscover() {
    const student = currentStudent();
    const stageFilter = selectedStage || (student && student.keyStage ? student.keyStage : 'All stages');
    const categories = ['All books'].concat(CATEGORIES);
    const filtered = state.books.filter(function (book) {
      const genreMatch = selectedGenre === 'All books' || book.categories.some(function (category) {
        return category.toLocaleLowerCase() === selectedGenre.toLocaleLowerCase();
      });
      const stageMatch = stageFilter === 'All stages' || book.keyStages.indexOf(stageFilter) !== -1;
      return genreMatch && stageMatch;
    });
    main.innerHTML =
      '<section class="hero"><span class="eyebrow">A LITTLE READING, A BIG ADVENTURE</span><h1>Six books.<br>Six months. Your story.</h1><p>Pick up a book, share what you think, and let your teacher cheer you on along the way.</p><span class="hero-action">YOUR NEXT CHAPTER STARTS HERE&nbsp; ↗</span></section>' +
      '<div class="section-head"><div><h2 class="section-title">Find your next read</h2><div class="section-kicker">A good book can take you anywhere.</div></div><div class="filter-row"><select class="field-select" id="stage-filter" aria-label="Filter by Key Stage"><option>All stages</option>' + ['KS1', 'KS2', 'KS3', 'KS4', 'KS5'].map(function (stage) {
        return '<option' + (stage === stageFilter ? ' selected' : '') + '>' + stage + '</option>';
      }).join('') + '</select></div></div>' +
      '<div class="genre-row" aria-label="Filter by category">' + categories.map(function (genre) {
        return '<button type="button" class="genre-chip' + (selectedGenre === genre ? ' selected' : '') + '" data-genre="' + escapeHtml(genre) + '">' + escapeHtml(genre) + '</button>';
      }).join('') + '</div>' +
      (filtered.length ? '<div class="book-grid">' + filtered.map(bookCard).join('') + '</div>' : emptyBooks(filtered.length === 0 && state.books.length > 0
        ? 'No books match these filters.' : 'Your library is getting ready.', state.books.length
        ? 'Try a different Key Stage or category to explore the available titles.'
        : 'The supplied book catalog is included with the app.')) +
      '<p class="fine-print" style="margin-top:18px">Showing ' + filtered.length + ' of ' + state.books.length + ' catalog books · ' + CATEGORIES.length + ' categories · Books are not challenge-complete until a teacher approves a review.</p>';

    document.querySelectorAll('[data-genre]').forEach(function (button) {
      button.addEventListener('click', function () { selectedGenre = button.dataset.genre; renderDiscover(); });
    });
    const stageControl = document.getElementById('stage-filter');
    stageControl.addEventListener('change', function () {
      selectedStage = stageControl.value;
      renderDiscover();
    });
    document.querySelectorAll('[data-open-book]').forEach(function (button) {
      button.addEventListener('click', function () { renderSubmit(button.dataset.openBook); });
    });
  }

  function bookCard(book) {
    const cats = book.categories.map(function (category) { return '<span class="tag">' + escapeHtml(category) + '</span>'; }).join('');
    const stages = book.keyStages.concat(book.audienceFlags || []).map(function (stage) {
      return '<span class="tag' + (stage === 'Adult Only' ? ' adult-tag' : '') + '">' + escapeHtml(stage) + '</span>';
    }).join('');
    const goodreads = /^https:\/\/(www\.)?goodreads\.com\//i.test(book.goodreadsUrl || '')
      ? '<a class="goodreads-link" href="' + escapeHtml(book.goodreadsUrl) + '" target="_blank" rel="noopener noreferrer">View on Goodreads ↗</a>'
      : '';
    return '<article class="book-card"><div class="book-cover"><span class="cover-mark">' + escapeHtml(book.title) + '</span></div><div class="book-info"><div class="tag-row">' + stages + '</div><h3 class="book-title">' + escapeHtml(book.title) + '</h3><div class="book-description">' + escapeHtml(book.description) + '</div><div class="tag-row">' + cats + '</div>' + goodreads + '<div class="book-footer">EPUB · <span class="catalog-file">' + (book.epubFilename ? escapeHtml(book.epubFilename) : 'Not specified') + '</span></div><button class="button secondary" type="button" data-open-book="' + escapeHtml(book.id) + '" style="width:100%;margin-top:12px">Share a book review</button></div></article>';
  }

  function emptyBooks(title, hasBooks) {
    return '<div class="empty-state"><div class="empty-icon">⌕</div><h3>' + escapeHtml(title) + '</h3><p>' + escapeHtml(hasBooks ? 'Try changing your filters.' : 'The supplied catalog could not be loaded.') + '</p></div>';
  }

  function renderChallenge() {
    const student = currentStudent();
    if (!student) { renderWelcome(); return; }
    const approved = approvedFor(student.id);
    const latestSubmissions = state.submissions
      .filter(function (item) { return item.studentId === student.id; })
      .sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); })
      .filter(function (item, index, all) {
        return all.findIndex(function (other) { return other.bookId === item.bookId; }) === index;
      });
    const returned = latestSubmissions.filter(function (item) { return item.status === 'rejected'; });
    const percent = Math.min(100, Math.round(approved.length / CHALLENGE_GOAL * 100));
    const list = approved.length ? '<div class="challenge-list">' + approved.map(function (submission) {
      const book = state.books.find(function (item) { return item.id === submission.bookId; });
      return '<div class="challenge-item"><span class="challenge-check">✓</span><div><div class="challenge-book">' + escapeHtml(book ? book.title : submission.bookTitle) + '</div><div class="challenge-category">Approved by your teacher · ' + escapeHtml(book ? book.categories.join(', ') : '') + '</div></div><span class="status approved" style="margin-left:auto">COUNTED</span></div>';
    }).join('') + '</div>' : '<div class="empty-state"><div class="empty-icon">◷</div><h3>Your first book is waiting</h3><p>Choose a title, upload a photo of your review, then ask your teacher to approve it.</p><button class="button" type="button" data-go-discover style="margin-top:14px">Explore books</button></div>';
    main.innerHTML = pageHeader('YOUR READING JOURNEY', 'My challenge', 'Every book begins with a page. Every completed book begins with an approved review.') +
      '<div class="progress-panel"><div><div class="progress-label">APPROVED BOOKS</div><div class="progress-big">' + approved.length + '<span style="font-size:24px;color:#c0d1c0"> / ' + CHALLENGE_GOAL + '</span></div><div class="progress-caption">' + (approved.length >= CHALLENGE_GOAL ? 'Challenge complete — wonderful reading!' : (CHALLENGE_GOAL - approved.length) + ' more approved ' + (CHALLENGE_GOAL - approved.length === 1 ? 'book' : 'books') + ' to reach your goal') + '</div></div><div class="progress-ring" aria-label="' + percent + '% complete">' + percent + '%</div></div>' +
      '<div class="section-head"><div><h2 class="section-title">Books that count</h2><div class="section-kicker">Only teacher-approved reviews count toward your 6 in 6.</div></div></div>' + list +
      '<div class="panel"><h2>Waiting for your teacher</h2><p>' + state.submissions.filter(function (item) { return item.status === 'pending'; }).length + ' review(s) are awaiting approval.</p>' +
      (returned.length ? '<h3 style="font:500 17px var(--serif);margin:18px 0 9px">Returned for changes</h3><div class="challenge-list">' + returned.map(function (submission) {
        return '<div class="challenge-item"><span class="status rejected">REVISE</span><div><div class="challenge-book">' + escapeHtml(submission.bookTitle) + '</div><div class="challenge-category">Your teacher asked you to update this review and submit it again.</div></div><button class="button secondary" style="margin-left:auto" type="button" data-resubmit-book="' + escapeHtml(submission.bookId) + '">Resubmit</button></div>';
      }).join('') + '</div>' : '') + '</div>';
    bindGoDiscover();
    document.querySelectorAll('[data-resubmit-book]').forEach(function (button) {
      button.addEventListener('click', function () { renderSubmit(button.dataset.resubmitBook); });
    });
  }

  function renderLeaderboard() {
    const rows = state.leaderboard.map(function (student) {
      return { student: student, books: student.books };
    });
    main.innerHTML = pageHeader('A LITTLE FRIENDLY MOTIVATION', 'Leaderboard', 'Approved books only. Every reader has their own pace.') +
      '<div class="catalog-warning">A review contributes only after teacher approval. Pending and rejected submissions are not included.</div>' +
      (rows.length ? '<div class="table-wrap"><table><thead><tr><th>Rank</th><th>Reader</th><th>Class</th><th>Approved books</th><th>Challenge</th></tr></thead><tbody>' + rows.map(function (row, index) {
        return '<tr><td class="rank">' + String(index + 1).padStart(2, '0') + '</td><td><strong>' + escapeHtml(row.student.name) + '</strong></td><td>' + escapeHtml(row.student.className || '—') + '</td><td>' + row.books + ' / ' + CHALLENGE_GOAL + '</td><td><div style="height:5px;width:100px;background:#e9eae3;border-radius:4px"><div style="width:' + Math.min(100, row.books / CHALLENGE_GOAL * 100) + '%;height:100%;background:#58795a;border-radius:4px"></div></div></td></tr>';
      }).join('') + '</tbody></table></div>' : emptyState('No readers yet', 'Create a student profile to begin tracking the challenge.'));
  }

  function renderReviews() {
    const items = state.submissions.filter(function (submission) { return submission.status === 'pending'; });
    main.innerHTML = pageHeader('TEACHER SPACE', 'Review submissions', 'Check each student’s book-review photo before it can count toward their challenge.') +
      '<div class="catalog-warning">Teacher review is per book submission. Approved books count toward the student’s challenge and leaderboard.</div>' +
      (items.length ? '<div class="submission-list">' + items.map(function (submission) {
        return '<article class="submission-card"><img class="submission-photo" src="/api/submissions/' + escapeHtml(submission.id) + '/photo" alt="Review photo from ' + escapeHtml(submission.studentName) + '"><div class="submission-detail"><span class="status pending">NEEDS REVIEW</span><h3>' + escapeHtml(submission.bookTitle) + '</h3><div class="book-meta">' + escapeHtml(submission.studentName) + (submission.className ? ' · ' + escapeHtml(submission.className) : '') + ' · ' + new Date(submission.createdAt).toLocaleDateString() + '</div><p>' + escapeHtml(submission.reviewText || 'No written notes provided.') + '</p><div class="submission-actions"><button class="button" data-review-action="approved" data-submission="' + escapeHtml(submission.id) + '" type="button">Approve review</button><button class="button reject" data-review-action="rejected" data-submission="' + escapeHtml(submission.id) + '" type="button">Request changes</button></div></div></article>';
      }).join('') + '</div>' : emptyState('All caught up', 'There are no pending book-review submissions to check.'));
    document.querySelectorAll('[data-review-action]').forEach(function (button) {
      button.addEventListener('click', function () { reviewSubmission(button.dataset.submission, button.dataset.reviewAction); });
    });
  }

  async function reviewSubmission(id, status) {
    try {
      await api('/submissions/' + encodeURIComponent(id), {
        method: 'PATCH', body: JSON.stringify({ status: status })
      });
      await refreshBootstrap();
      state.submissions = (await api('/submissions')).submissions;
      showToast(status === 'approved' ? 'Review approved — the book now counts.' : 'Review returned for changes.');
      renderReviews();
      updateChrome();
    } catch (error) {
      showToast(error.message);
    }
  }

  function renderWelcome() {
    main.innerHTML = pageHeader('WELCOME, READER', 'Let’s get started', 'Create a student account to save your reading progress across devices.') +
      '<div class="panel"><h2>Create a student account</h2><p>Choose a username and a private password. Your account and progress are saved securely on the app server.</p><form id="student-form"><div class="form-grid"><div><label class="form-label" for="student-name">Your name</label><input class="text-input" id="student-name" required maxlength="60" autocomplete="name"></div><div><label class="form-label" for="student-username">Username</label><input class="text-input" id="student-username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9._-]{2,31}" autocomplete="username"></div><div><label class="form-label" for="student-class">Class (optional)</label><input class="text-input" id="student-class" maxlength="60"></div><div><label class="form-label" for="student-stage">Key Stage (optional)</label><select class="field-select" id="student-stage" style="width:100%;max-width:none"><option value="">Choose a Key Stage</option><option>KS1</option><option>KS2</option><option>KS3</option><option>KS4</option><option>KS5</option></select></div><div><label class="form-label" for="student-new-password">Password</label><input class="text-input" id="student-new-password" type="password" minlength="12" maxlength="256" autocomplete="new-password" required></div><div><label class="form-label" for="student-confirm-password">Confirm password</label><input class="text-input" id="student-confirm-password" type="password" minlength="12" maxlength="256" autocomplete="new-password" required></div></div><p class="hint">Usernames use 3–32 letters, numbers, dots, hyphens, or underscores. Use a password with at least 12 characters.</p><p class="password-error" id="student-create-error" role="alert"></p><button class="button" type="submit" style="margin-top:8px">Create account</button></form>' +
      '<div class="account-divider"></div><h2>Sign in</h2><form id="student-login-form"><label class="form-label" for="student-login-username">Username</label><input class="text-input" id="student-login-username" required autocomplete="username"><label class="form-label" for="student-login-password">Password</label><input class="text-input" id="student-login-password" type="password" autocomplete="current-password" required><p class="password-error" id="student-login-error" role="alert"></p><button class="button secondary" type="submit" style="margin-top:8px">Sign in</button></form><p class="fine-print" style="margin-top:20px">Use a unique password and do not share it with other students.</p></div>';

    document.getElementById('student-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      if (loginBusy) return;
      const password = document.getElementById('student-new-password').value;
      const confirm = document.getElementById('student-confirm-password').value;
      const error = document.getElementById('student-create-error');
      if (password.length < 12) { error.textContent = 'Choose a password with at least 12 characters.'; return; }
      if (password !== confirm) { error.textContent = 'The passwords do not match.'; return; }
      setLoginBusy(true);
      try {
        const result = await api('/register', { method: 'POST', body: JSON.stringify({
          name: document.getElementById('student-name').value.trim(),
          username: document.getElementById('student-username').value.trim(),
          className: document.getElementById('student-class').value.trim(),
          keyStage: document.getElementById('student-stage').value,
          password: password
        }) });
        state.currentStudent = result.user;
        selectedStage = result.user.keyStage || '';
        await refreshBootstrap();
        updateChrome();
        setView('discover');
        showToast('Welcome, ' + result.user.name + '!');
      } catch (requestError) {
        error.textContent = requestError.message;
      } finally {
        setLoginBusy(false);
      }
    });

    document.getElementById('student-login-form').addEventListener('submit', async function (event) {
      event.preventDefault();
      if (loginBusy) return;
      const error = document.getElementById('student-login-error');
      setLoginBusy(true);
      try {
        const result = await api('/login', { method: 'POST', body: JSON.stringify({
          username: document.getElementById('student-login-username').value.trim(),
          password: document.getElementById('student-login-password').value
        }) });
        state.currentStudent = result.user;
        selectedStage = result.user.keyStage || '';
        await refreshBootstrap();
        updateChrome();
        setView('discover');
        showToast('Welcome back, ' + result.user.name + '!');
      } catch (requestError) {
        error.textContent = requestError.message;
      } finally {
        setLoginBusy(false);
      }
    });
  }

  function setLoginBusy(busy) {
    loginBusy = busy;
    document.querySelectorAll('#student-form button, #student-login-form button').forEach(function (button) {
    button.disabled = busy;
    });
  }

  function renderSubmit(bookId) {
    const student = currentStudent();
    const book = state.books.find(function (item) { return item.id === bookId; });
    if (!student) { renderWelcome(); showToast('Create or choose your reader profile before submitting a review.'); return; }
    if (!book) { showToast('That book is no longer in the catalog.'); renderDiscover(); return; }
    const existing = state.submissions.find(function (item) {
      return item.bookId === book.id && (item.status === 'pending' || item.status === 'approved');
    });
    if (existing) { showToast(existing.status === 'pending' ? 'Your review is waiting for teacher approval.' : 'This book is already counted for your challenge.'); return; }
    main.innerHTML = pageHeader('SHARE YOUR THOUGHTS', 'Your book review', 'A photo of your review is needed before your teacher can approve this book.') +
      '<div class="panel"><h2>' + escapeHtml(book.title) + '</h2><p>' + escapeHtml(book.description) + '</p><form id="review-form"><label class="form-label" for="review-text">A few words about the book (optional)</label><textarea id="review-text" class="text-area" maxlength="1200" placeholder="What did you think?"></textarea><label class="file-field">Photo of your book review <span style="color:#ae5b42">*</span><input id="review-photo" type="file" accept="image/*" capture="environment" required></label><p class="hint">Use a clear photo; the image is resized and saved in this browser for teacher review.</p><button class="button" type="submit" style="margin-top:14px">Submit for teacher review</button> <button class="button secondary" id="cancel-review" type="button">Cancel</button></form></div>';
    document.getElementById('cancel-review').addEventListener('click', renderDiscover);
    document.getElementById('review-form').addEventListener('submit', function (event) {
      event.preventDefault();
      const file = document.getElementById('review-photo').files[0];
      if (!file || !file.type.startsWith('image/')) { showToast('Choose a photo image of your review.'); return; }
      compressPhoto(file).then(async function (photoData) {
        await api('/submissions', { method: 'POST', body: JSON.stringify({
          bookId: book.id,
          reviewText: document.getElementById('review-text').value.trim(),
          photoData: photoData
        }) });
        await refreshBootstrap();
        showToast('Review sent to your teacher for approval.');
        updateChrome();
        renderChallenge();
      }).catch(function (error) {
        console.error('Review photo could not be processed.', error);
        showToast('Could not process the photo. Try a smaller image.');
      });
    });
  }

  function compressPhoto(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onerror = function () { reject(new Error('Could not read image file.')); };
      reader.onload = function () {
        const image = new Image();
        image.onerror = function () { reject(new Error('Selected file is not a readable image.')); };
        image.onload = function () {
          const scale = Math.min(1, 1100 / Math.max(image.width, image.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(image.width * scale));
          canvas.height = Math.max(1, Math.round(image.height * scale));
          const context = canvas.getContext('2d');
          if (!context) { reject(new Error('Image processing is unavailable.')); return; }
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.72));
        };
        image.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  function emptyState(title, description) {
    return '<div class="empty-state"><div class="empty-icon">✳</div><h3>' + escapeHtml(title) + '</h3><p>' + escapeHtml(description) + '</p></div>';
  }

  function bindGoDiscover() {
    const button = document.querySelector('[data-go-discover]');
    if (button) button.addEventListener('click', function () { setView('discover'); });
  }

  document.querySelectorAll('[data-view]').forEach(function (button) {
    button.addEventListener('click', function () { setView(button.dataset.view); });
  });
  document.getElementById('teacher-login-form').addEventListener('submit', function (event) {
    event.preventDefault();
    const password = document.getElementById('teacher-password');
    const error = document.getElementById('teacher-password-error');
    const submit = document.querySelector('#teacher-login-form button[type="submit"]');
    if (loginBusy) return;
    loginBusy = true;
    submit.disabled = true;
    api('/teacher/login', { method: 'POST', body: JSON.stringify({ password: password.value }) })
      .then(async function () {
        password.value = '';
        error.textContent = '';
        teacherDialog.hidden = true;
        await refreshBootstrap();
        updateChrome();
        setView('review');
      })
      .catch(function (requestError) {
        error.textContent = requestError.message;
        password.select();
      })
      .finally(function () {
        loginBusy = false;
        submit.disabled = false;
      });
  });
  document.getElementById('teacher-cancel').addEventListener('click', function () {
    teacherDialog.hidden = true;
    document.getElementById('teacher-password').value = '';
    document.getElementById('teacher-password-error').textContent = '';
  });
  teacherDialog.addEventListener('click', function (event) {
    if (event.target === teacherDialog) {
      teacherDialog.hidden = true;
      document.getElementById('teacher-password').value = '';
      document.getElementById('teacher-password-error').textContent = '';
    }
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !teacherDialog.hidden) {
      teacherDialog.hidden = true;
      document.getElementById('teacher-password').value = '';
      document.getElementById('teacher-password-error').textContent = '';
    }
  });
  document.getElementById('profile-button').addEventListener('click', function () {
    if (!currentStudent() && !state.teacherAuthenticated) { renderWelcome(); return; }
    const choose = window.confirm('Sign out of this account?');
    if (!choose) return;
    api('/session', { method: 'DELETE' }).then(function () {
      state.currentStudent = null;
      state.submissions = [];
      state.teacherAuthenticated = false;
      updateChrome();
      renderWelcome();
    }).catch(function (error) { showToast(error.message); });
  });

  async function startApp() {
    try {
      await refreshBootstrap();
      updateChrome();
      renderDiscover();
    } catch (error) {
      console.error('Could not connect to the reading challenge server.', error);
      main.innerHTML = pageHeader('SERVER CONNECTION', 'We could not connect', 'The app server did not respond. Refresh the page in a moment or contact your administrator.') +
        '<div class="empty-state"><h3>Connection problem</h3><p>' + escapeHtml(error.message) + '</p><button class="button" type="button" id="retry-server">Try again</button></div>';
      document.getElementById('retry-server').addEventListener('click', startApp);
    }
  }

  updateChrome();
  startApp();
})();
