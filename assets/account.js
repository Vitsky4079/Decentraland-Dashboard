import { getSession, signUp, signInWithPassword, signOut } from './auth.js';

const $ = (id) => document.getElementById(id);

async function render() {
  const session = await getSession();
  $('loading').classList.add('hidden');
  if (session && session.user) {
    $('loggedOutView').classList.add('hidden');
    $('loggedInView').classList.remove('hidden');
    $('accountEmail').textContent = session.user.email || '';
  } else {
    $('loggedInView').classList.add('hidden');
    $('loggedOutView').classList.remove('hidden');
  }
}

function switchTab(which) {
  const isLogin = which === 'login';
  $('tabLogin').classList.toggle('is-active', isLogin);
  $('tabLogin').setAttribute('aria-selected', String(isLogin));
  $('tabSignup').classList.toggle('is-active', !isLogin);
  $('tabSignup').setAttribute('aria-selected', String(!isLogin));
  $('loginForm').classList.toggle('hidden', !isLogin);
  $('signupForm').classList.toggle('hidden', isLogin);
  $('signupDone').classList.add('hidden');
}
$('tabLogin').addEventListener('click', () => switchTab('login'));
$('tabSignup').addEventListener('click', () => switchTab('signup'));

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('loginStatus');
  status.textContent = 'Logging in…';
  const { error } = await signInWithPassword($('loginEmail').value, $('loginPassword').value);
  if (error) {
    status.textContent = error.message;
    return;
  }
  status.textContent = '';
  render();
});

$('signupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const status = $('signupStatus');
  status.textContent = 'Signing up…';
  const email = $('signupEmail').value;
  const { error } = await signUp(email, $('signupPassword').value);
  if (error) {
    status.textContent = error.message;
    return;
  }
  status.textContent = '';
  $('signupForm').classList.add('hidden');
  $('signupDoneText').textContent = `We sent a confirmation link to ${email}. Click it, then come back here and log in.`;
  $('signupDone').classList.remove('hidden');
});

$('logoutBtn').addEventListener('click', async () => {
  await signOut();
  render();
});

render();
