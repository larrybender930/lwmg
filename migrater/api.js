/**
 * Authenticated client for the Lugawatch admin API.
 *
 * Logging in is the delicate part. /king/auth/login allows only **5 attempts per
 * 15 minutes per IP**, and the username limiter allows 5 per 15 minutes across the
 * whole fleet (it resets on success; the IP one does not). A naive client that
 * logged in on boot and on every 401 would lock itself out after five restarts —
 * and a crash loop would then be unable to authenticate at all, which is exactly
 * when it most needs to. Three things prevent that:
 *
 *   1. The JWT (7-day life) is cached on disk, so a restart reuses it and costs
 *      no attempt at all.
 *   2. Logins are single-flight: a burst of concurrent 401s produces ONE login,
 *      not one per request.
 *   3. A hard cooldown caps logins at one per 5 minutes, i.e. at most 3 per
 *      15-minute window — comfortably under the limit of 5, whatever happens.
 *
 * (The cooldown is a rate-limit concession, not a correctness mechanism: the
 * constraint it respects is itself defined in time. Nothing about ownership or
 * concurrency is decided by a clock anywhere in this worker.)
 *
 * Everything else: network errors and 5xx are retried with backoff; 4xx answers
 * are returned to the caller, because they are the server's verdict and retrying
 * cannot change them.
 */

const axios = require('axios');
const config = require('./config');
const state = require('./state');
const { InfraError } = require('./errors');

const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED',
  'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH',
]);

// 15 min / 5 attempts = one per 3 min is the break-even; 5 leaves margin for the
// fleet-wide username limiter too.
const LOGIN_COOLDOWN_MS = 5 * 60 * 1000;

const client = axios.create({
  baseURL: config.API_ORIGIN,
  timeout: 60_000,
  // Never throw on status: the caller decides what a 409 or 410 means.
  validateStatus: () => true,
});

let token = null;
let loginPromise = null;
let lastLoginAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function performLogin() {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    let response;
    try {
      response = await client.post('/king/auth/login', {
        username: config.USERNAME,
        password: config.PASSWORD,
      });
    } catch (error) {
      // A network blip on the way to the login endpoint never reached the rate
      // limiter, so retrying it costs nothing.
      if (!RETRYABLE_CODES.has(error.code)) throw new InfraError(`Login failed: ${error.message}`);
      lastError = error;
      if (attempt < 3) await sleep(2000 * attempt);
      continue;
    }

    if (response.status === 200 && response.data?.token) {
      token = response.data.token;
      state.writeToken(token);
      return token;
    }

    if (response.status === 429) {
      throw new InfraError(
        `Login rate limited: ${response.data?.error || 'too many attempts'}. ` +
        'The worker will keep using its cached token if it still has one.'
      );
    }

    // 401/403 — wrong credentials or a disabled account. Retrying burns the
    // budget for nothing and cannot succeed.
    throw new InfraError(
      `Login rejected (${response.status}): ${response.data?.error || 'no token returned'}`
    );
  }

  throw new InfraError(`Login failed: ${lastError?.message || 'unknown error'}`);
}

/**
 * Single-flight, cooldown-capped login. Concurrent callers share one attempt.
 */
function login() {
  if (loginPromise) return loginPromise;

  const since = Date.now() - lastLoginAt;
  if (lastLoginAt && since < LOGIN_COOLDOWN_MS) {
    return Promise.reject(new InfraError(
      `Login cooldown: ${Math.ceil((LOGIN_COOLDOWN_MS - since) / 1000)}s remaining ` +
      '(the API allows only 5 login attempts per 15 minutes)'
    ));
  }

  lastLoginAt = Date.now();
  loginPromise = performLogin().finally(() => { loginPromise = null; });
  return loginPromise;
}

/**
 * Make sure we hold a token, preferring the one cached on disk from a previous
 * run. Called once at boot; `request` falls back to it if the token is missing.
 */
async function ensureAuth() {
  if (token) return token;

  const cached = state.readToken();
  if (cached) {
    token = cached;
    return token;
  }

  return login();
}

/**
 * @returns {Promise<{status: number, data: any}>}
 */
async function request(method, path, body, { retries = 4 } = {}) {
  await ensureAuth();

  let lastError = null;
  let reauthenticated = false;

  for (let attempt = 1; attempt <= retries; attempt++) {
    let response;
    try {
      response = await client.request({
        method,
        url: path,
        data: body,
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (error) {
      // Network-level: no HTTP response at all. Anything not on the transient
      // list is a real bug and surfaces immediately rather than being retried.
      if (!RETRYABLE_CODES.has(error.code)) throw new InfraError(error.message);
      lastError = error;
      if (attempt === retries) break;
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }

    if (response.status === 401) {
      // Re-authenticate at most ONCE per request. Looping here would spend the
      // login budget several times over on a token the server keeps rejecting.
      if (reauthenticated) {
        throw new InfraError(`${method} ${path} → 401 after re-authenticating`);
      }
      reauthenticated = true;
      state.clearToken();
      token = null;
      await login();       // throws on cooldown / rate limit, which is the point
      continue;
    }

    if (response.status >= 500) {
      lastError = new InfraError(`${method} ${path} → ${response.status}`);
      if (attempt === retries) break;
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }

    return response;
  }

  throw new InfraError(`${method} ${path} failed: ${lastError?.message || 'unknown error'}`);
}

/** Same as request(), but anything other than 2xx is an error. */
async function requestOk(method, path, body, options) {
  const response = await request(method, path, body, options);
  if (response.status < 200 || response.status >= 300) {
    throw new InfraError(
      `${method} ${path} → ${response.status}: ${response.data?.error || 'request failed'}`
    );
  }
  return response.data;
}

module.exports = { login, ensureAuth, request, requestOk };
