/**
 * Native Anthropic OAuth credential injection — adapted from the
 * `use-native-credential-proxy` skill for a HYBRID install that still runs the
 * OneCLI gateway for other providers/tools (OpenRouter dev agents, Gmail/Meta).
 *
 * Goal: let the Claude-provider agents authenticate to api.anthropic.com with a
 * real Claude *subscription* OAuth token (`claude setup-token`, `sk-ant-oat…`),
 * exactly like Claude Code does natively, while everything else keeps going
 * through the gateway.
 *
 * How it differs from the vanilla skill (and why):
 *   - It injects CLAUDE_CODE_OAUTH_TOKEN (+ optional ANTHROPIC_AUTH_TOKEN /
 *     ANTHROPIC_API_KEY) but deliberately does NOT forward ANTHROPIC_BASE_URL —
 *     that var is the OpenCode/OpenRouter base URL on this install and must not
 *     leak into Claude containers. Claude agents default to api.anthropic.com.
 *   - It also emits NO_PROXY so api.anthropic.com bypasses the OneCLI gateway
 *     (the container reaches Anthropic directly with the OAuth token). The set
 *     keeps 127.0.0.1,localhost that the OpenCode `opencode serve` needs, so it
 *     is a safe superset for every container.
 *   - The reach-in in container-runner.ts is placed AFTER onecli.applyContainerConfig
 *     so these -e vars land LAST and win over the placeholder CLAUDE_CODE_OAUTH_TOKEN
 *     the gateway injects (Docker uses the last -e for a duplicate key).
 *
 * All gating lives here: returns [] unless NANOCLAW_NATIVE_CREDENTIALS=true, so
 * the reach-in is a single unconditional call and the gateway path is untouched
 * when the flag is off.
 */
import { readEnvFile } from './env.js';

export const NATIVE_CREDENTIALS_FLAG = 'NANOCLAW_NATIVE_CREDENTIALS';

/** Anthropic credential vars, in the order the Claude Agent SDK resolves them. */
const CREDENTIAL_VARS = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const;

/** Hosts the container should reach directly, bypassing the OneCLI gateway. */
const NO_PROXY_VALUE = 'api.anthropic.com,127.0.0.1,localhost';

export function nativeCredentialsEnabled(): boolean {
  // The host (launchd/systemd) does not load .env into process.env — the
  // codebase reads .env via readEnvFile. So check both: a real exported env
  // var first, then the .env file.
  if (process.env[NATIVE_CREDENTIALS_FLAG] === 'true') return true;
  return readEnvFile([NATIVE_CREDENTIALS_FLAG])[NATIVE_CREDENTIALS_FLAG] === 'true';
}

/**
 * Docker `-e` args that inject the Anthropic OAuth credential + NO_PROXY.
 * Empty array unless the flag is set. Throws if the flag is on but no
 * credential is available — mirrors the gateway's "no credentials, no
 * container" stance.
 */
export function nativeCredentialEnvArgs(): string[] {
  if (!nativeCredentialsEnabled()) return [];

  const fromFile = readEnvFile([...CREDENTIAL_VARS]);
  const resolve = (k: string): string | undefined => process.env[k] || fromFile[k];

  const args: string[] = [];
  let hasCredential = false;
  let hasOAuth = false;
  for (const key of CREDENTIAL_VARS) {
    const value = resolve(key);
    if (!value) continue;
    args.push('-e', `${key}=${value}`);
    hasCredential = true;
    if (key === 'CLAUDE_CODE_OAUTH_TOKEN') hasOAuth = true;
  }

  // When authenticating by OAuth token, the SDK must NOT see an api-key: the
  // gateway injects ANTHROPIC_API_KEY=placeholder, which the SDK would send as
  // `x-api-key` and Anthropic would reject ("Invalid API key"). Blank it (and
  // ANTHROPIC_AUTH_TOKEN) so the SDK falls through to OAuth. These land last, so
  // they override the gateway's values.
  if (hasOAuth) {
    args.push('-e', 'ANTHROPIC_API_KEY=');
    args.push('-e', 'ANTHROPIC_AUTH_TOKEN=');
  }

  if (!hasCredential) {
    throw new Error(
      `${NATIVE_CREDENTIALS_FLAG}=true but no Anthropic credential in .env — ` +
        'set CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY)',
    );
  }

  // Bypass the gateway for Anthropic so the OAuth token reaches the API
  // directly; keep localhost for OpenCode's local server.
  args.push('-e', `NO_PROXY=${NO_PROXY_VALUE}`);
  args.push('-e', `no_proxy=${NO_PROXY_VALUE}`);

  return args;
}
