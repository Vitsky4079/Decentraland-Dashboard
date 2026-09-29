import { getSession, signUp, signInWithPassword, signOut, signInWithGoogle, signInWithEthereum } from './auth.js';

const $ = (id) => document.getElementById(id);

// supabase-js's own messages here are developer-facing hints (mention passing a
// `wallet` option programmatically, or a raw method name), not something to show an
// end user -- swap in plain copy for the two common cases.
function ethErrorMessage(error) {
  const msg = error.message || '';
  if (/No compatible Ethereum wallet/i.test(msg)) {
    return 'No Ethereum wallet found. Install a wallet extension like MetaMask and try again.';
  }
  if (/eth_requestAccounts is missing or invalid/i.test(msg)) {
    return 'Wallet connection was cancelled or interrupted. Try again and approve the request in your wallet.';
  }
  return msg || 'Could not sign in with your wallet.';
}

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

$('googleBtn').addEventListener('click', async () => {
  const status = $('web3Status');
  status.className = 'rf-status';
  status.textContent = '';
  const { error } = await signInWithGoogle();
  // Success navigates away to Google -- there's nothing else to do here on success.
  if (error) {
    status.classList.add('err');
    status.textContent = error.message;
  }
});

$('ethBtn').addEventListener('click', async () => {
  const btn = $('ethBtn');
  const status = $('web3Status');
  status.className = 'rf-status';
  status.textContent = 'Check your wallet to connect and sign…';
  btn.disabled = true;
  const { error } = await signInWithEthereum();
  btn.disabled = false;
  if (error) {
    status.classList.add('err');
    status.textContent = ethErrorMessage(error);
    return;
  }
  status.textContent = '';
  render();
});

render();
