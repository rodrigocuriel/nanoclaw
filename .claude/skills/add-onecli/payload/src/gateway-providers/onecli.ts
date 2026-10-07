import { normalizeGatewayApprovalSummary } from '../gateway-approval-summary.js';
/** OneCLI typed configuration and supervised native approval adapter. */
import { OneCLI, ApprovalClient, type ContainerConfig, type ApprovalRequest } from '@onecli-sh/sdk';

import { DATA_DIR } from '../config.js';
import { combinedCaBundle, stageOnecliFile } from './onecli-files.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

import {
  registerGatewayProvider,
  type GatewayApprovalRequest,
  type GatewayApprovalScope,
  type GatewayContribution,
  type GatewaySessionInput,
  type GatewaySessionLease,
} from './gateway-provider-registry.js';

const env = readEnvFile([
  'ONECLI_URL',
  'ONECLI_API_KEY',
  'ONECLI_PROJECT_ID',
  'ONECLI_GATEWAY_CONTAINER',
  'ANTHROPIC_BASE_URL',
  'ONECLI_CONSOLE_URL',
]);
const onecliUrl = process.env.ONECLI_URL || env.ONECLI_URL;
const onecliApiKey = process.env.ONECLI_API_KEY || env.ONECLI_API_KEY;
const onecliProjectId = process.env.ONECLI_PROJECT_ID || env.ONECLI_PROJECT_ID;
const gatewayContainer = process.env.ONECLI_GATEWAY_CONTAINER || env.ONECLI_GATEWAY_CONTAINER || 'onecli';
const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL || env.ANTHROPIC_BASE_URL;
const onecli = new OneCLI({ url: onecliUrl, apiKey: onecliApiKey, projectId: onecliProjectId });
const healthUrl = new URL('/v1/health', onecliUrl || 'https://api.onecli.sh').toString();
const liveLeases = new Set<{ unavailable?: string; notify?: (reason: string) => void }>();
let healthTimer: NodeJS.Timeout | null = null;
let probing = false;

type OneCLIContribution = Omit<GatewayContribution, 'networkAccess'>;
type GatewayMount = NonNullable<GatewayContribution['mounts']>[number];

const CODEX_AUTH_PATH = '/home/node/.codex/auth.json';
const ONECLI_SENTINEL = 'onecli-managed';
const CHATGPT_AUTH_CLAIM = 'https://api.openai.com/auth';
const ACCOUNT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeJwtPayload(token: string): { parts: string[]; payload: Record<string, unknown> } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('OneCLI Codex auth stub contains an invalid synthetic ID token');
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    if (!isRecord(payload)) throw new Error();
    return { parts, payload };
  } catch {
    throw new Error('OneCLI Codex auth stub contains an invalid synthetic ID token payload');
  }
}

/**
 * Preserve the non-secret ChatGPT workspace identity that recent Codex CLIs
 * need for local routing discovery. Authentication remains gateway-only: the
 * access and refresh values stay as OneCLI sentinels, and the ID token is the
 * gateway's synthetic local-discovery token rather than the vault credential.
 */
export function withCodexWorkspaceIdentity(config: ContainerConfig, accountId?: string): ContainerConfig {
  if (!accountId) return config;
  if (!ACCOUNT_ID_RE.test(accountId)) throw new Error('OneCLI Codex credential has an invalid account ID');

  let changed = false;
  const credentialStubs = (config.credentialStubs ?? []).map((stub) => {
    if (stub.containerPath !== CODEX_AUTH_PATH) return stub;

    let auth: unknown;
    try {
      auth = JSON.parse(stub.content);
    } catch {
      throw new Error('OneCLI Codex auth stub is not valid JSON');
    }
    if (!isRecord(auth) || !isRecord(auth.tokens)) throw new Error('OneCLI Codex auth stub has an invalid shape');
    const tokens = auth.tokens;
    if (tokens.access_token !== ONECLI_SENTINEL || tokens.refresh_token !== ONECLI_SENTINEL) {
      throw new Error('OneCLI Codex auth stub unexpectedly contains non-sentinel credentials');
    }
    if (typeof tokens.id_token !== 'string')
      throw new Error('OneCLI Codex auth stub is missing its synthetic ID token');

    const { parts, payload } = decodeJwtPayload(tokens.id_token);
    const chatgptAuth = payload[CHATGPT_AUTH_CLAIM];
    if (!isRecord(chatgptAuth)) throw new Error('OneCLI Codex auth stub is missing its ChatGPT identity claim');
    const currentTokenAccount = tokens.account_id;
    const currentClaimAccount = chatgptAuth.chatgpt_account_id;
    if (
      ![ONECLI_SENTINEL, accountId].includes(String(currentTokenAccount)) ||
      ![ONECLI_SENTINEL, accountId].includes(String(currentClaimAccount))
    ) {
      throw new Error('OneCLI Codex auth stub contains an unexpected workspace identity');
    }

    tokens.account_id = accountId;
    chatgptAuth.chatgpt_account_id = accountId;
    parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
    tokens.id_token = parts.join('.');
    changed = true;
    return { ...stub, content: JSON.stringify(auth) };
  });

  return changed ? { ...config, credentialStubs } : config;
}

async function readOneCliMetadata(pathname: string, fetchImpl: typeof fetch): Promise<unknown> {
  const base = (onecliUrl || 'https://api.onecli.sh').replace(/\/+$/, '');
  const response = await fetchImpl(`${base}${pathname}`, {
    headers: {
      ...(onecliApiKey ? { Authorization: `Bearer ${onecliApiKey}` } : {}),
      ...(onecliProjectId ? { 'X-Project-Id': onecliProjectId } : {}),
    },
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`OneCLI metadata request failed with status ${response.status}`);
  return response.json();
}

/** Resolve only non-secret metadata for the OAuth credential granted to this agent. */
export async function resolveCodexAccountId(
  agentIdentifier: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string | undefined> {
  const [agentsValue, secretsValue] = await Promise.all([
    readOneCliMetadata('/v1/agents', fetchImpl),
    readOneCliMetadata('/v1/secrets', fetchImpl),
  ]);
  if (!Array.isArray(agentsValue) || !agentsValue.every(isRecord))
    throw new Error('OneCLI returned invalid agent metadata');
  if (!Array.isArray(secretsValue) || !secretsValue.every(isRecord)) {
    throw new Error('OneCLI returned invalid secret metadata');
  }

  const agents = agentsValue.filter((agent) => agent.identifier === agentIdentifier);
  if (agents.length !== 1 || typeof agents[0].id !== 'string') {
    throw new Error('OneCLI could not uniquely resolve the NanoClaw agent');
  }
  const agent = agents[0];
  const agentId = agent.id as string;
  let assignedIds: Set<string>;
  if (agent.secretMode === 'all') {
    assignedIds = new Set(secretsValue.map((secret) => secret.id).filter((id): id is string => typeof id === 'string'));
  } else {
    const assigned = await readOneCliMetadata(`/v1/agents/${encodeURIComponent(agentId)}/secrets`, fetchImpl);
    if (!Array.isArray(assigned) || !assigned.every((id) => typeof id === 'string')) {
      throw new Error('OneCLI returned invalid agent secret assignments');
    }
    assignedIds = new Set(assigned);
  }

  const accountIds = new Set<string>();
  for (const secret of secretsValue) {
    if (
      typeof secret.id !== 'string' ||
      !assignedIds.has(secret.id) ||
      secret.type !== 'openai' ||
      secret.hostPattern !== 'chatgpt.com' ||
      !isRecord(secret.metadata) ||
      secret.metadata.authMode !== 'oauth'
    ) {
      continue;
    }
    if (typeof secret.metadata.accountId === 'string') accountIds.add(secret.metadata.accountId);
  }
  if (accountIds.size > 1) throw new Error('OneCLI assigned multiple Codex workspace identities to this agent');
  const accountId = accountIds.values().next().value as string | undefined;
  if (accountId && !ACCOUNT_ID_RE.test(accountId)) throw new Error('OneCLI Codex credential has an invalid account ID');
  return accountId;
}

/** Stage immutable per-content files; SDK temporary basenames are shared across agents. */
export function contributionFromConfig(
  config: ContainerConfig,
  groupScope: string,
  dataDir = DATA_DIR,
): OneCLIContribution {
  const env = { ...config.env };
  const mergeNoProxy = (value: string | undefined): string =>
    [...new Set([...(value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean), 'host.docker.internal'])].join(
      ',',
    );
  env.NO_PROXY = mergeNoProxy(env.NO_PROXY);
  env.no_proxy = mergeNoProxy(env.no_proxy);
  const mounts: GatewayMount[] = [];
  const mount = (kind: 'ca' | 'combined' | 'stub', content: string, containerPath: string) => {
    mounts.push({
      class: 'allowlisted-extra',
      hostPath: stageOnecliFile(dataDir, kind, content),
      containerPath,
      mode: 'ro',
      groupScope,
    });
  };
  mount('ca', config.caCertificate, config.caCertificateContainerPath);
  const combined = combinedCaBundle(config.caCertificate);
  if (combined) {
    const target = '/tmp/onecli-combined-ca.pem';
    mount('combined', combined, target);
    env.SSL_CERT_FILE = target;
    env.DENO_CERT = target;
  }
  for (const stub of config.credentialStubs ?? []) mount('stub', stub.content, stub.containerPath);
  return { env, mounts };
}

export function withProviderEnv(contribution: OneCLIContribution, baseUrl = anthropicBaseUrl): OneCLIContribution {
  if (!baseUrl) return contribution;
  return {
    ...contribution,
    env: { ...contribution.env, ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: 'gateway-managed' },
  };
}

function stopHealthMonitor(): void {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
}

async function probeHealth(): Promise<void> {
  if (probing || liveLeases.size === 0) return;
  probing = true;
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`status ${response.status}`);
  } catch (err) {
    const reason = 'OneCLI gateway unavailable';
    log.error(reason, { err });
    stopHealthMonitor();
    for (const lease of liveLeases) {
      lease.unavailable = reason;
      lease.notify?.(reason);
    }
  } finally {
    probing = false;
  }
}

function monitorLease(signal: AbortSignal): Pick<GatewaySessionLease, 'onUnavailable'> {
  const lease: { unavailable?: string; notify?: (reason: string) => void } = {};
  liveLeases.add(lease);
  if (!healthTimer) {
    healthTimer = setInterval(() => void probeHealth(), 5_000);
    healthTimer.unref();
  }
  const close = () => {
    liveLeases.delete(lease);
    if (liveLeases.size === 0) stopHealthMonitor();
  };
  if (signal.aborted) close();
  else signal.addEventListener('abort', close, { once: true });
  return {
    onUnavailable(report) {
      lease.notify = report;
      if (lease.unavailable) report(lease.unavailable);
    },
  };
}

async function ensureSession(input: GatewaySessionInput, signal: AbortSignal): Promise<GatewaySessionLease> {
  // The OneCLI agent identifier is always the agent group id — stable across
  // sessions and reversible via getAgentGroup() for approval routing.
  await onecli.ensureAgent({ name: input.groupName, identifier: input.key.agentGroupId });
  let config = await onecli.getContainerConfig({ agent: input.key.agentGroupId });
  if (config.credentialStubs?.some((stub) => stub.containerPath === CODEX_AUTH_PATH)) {
    const accountId = await resolveCodexAccountId(input.key.agentGroupId);
    config = withCodexWorkspaceIdentity(config, accountId);
  }
  log.info('OneCLI gateway applied', { agentGroupId: input.key.agentGroupId, sessionId: input.key.sessionId });
  return {
    ...monitorLease(signal),
    contribution: {
      ...withProviderEnv(contributionFromConfig(config, input.key.agentGroupId)),
      networkAccess: {
        endpoint: 'host.docker.internal',
        target: { kind: 'runtime', identity: gatewayContainer },
      },
    },
  };
}

async function subscribeApprovals(
  decide: (request: GatewayApprovalRequest) => Promise<'approve' | 'deny'>,
  signal: AbortSignal,
  _resolved?: (requestId: string) => Promise<void>,
  scope?: GatewayApprovalScope,
): Promise<void> {
  if (!scope) throw new Error('OneCLI approval subscription requires installation ownership scope');
  const subscribedAt = Date.now();
  const client = new ApprovalClient(
    onecliUrl || 'https://api.onecli.sh',
    onecliApiKey || '',
    process.env.ONECLI_GATEWAY_URL || null,
    process.env.ONECLI_PROJECT_ID || null,
  );
  let stopped = false;
  const stop = () => {
    if (!stopped) {
      stopped = true;
      client.stop();
    }
  };
  if (signal.aborted) return;
  signal.addEventListener('abort', stop, { once: true });
  try {
    // Unlike configureManualApproval, start exposes gateway-URL discovery failures.
    await client.start(async (request: ApprovalRequest) => {
      // The local gateway poll is shared by installations. Throwing from the
      // pinned SDK callback submits no decision and leaves the request pending.
      // Keep this outside the deny-on-translation-error block, even for stale
      // requests: this copy has no authority over another copy's requests.
      if (!(await scope.ownsAgentGroup(request.agent?.externalId ?? ''))) {
        throw new Error('OneCLI approval belongs to another installation');
      }
      if (signal.aborted || Date.parse(request.createdAt) < subscribedAt) return 'deny';
      try {
        return await decide(toGatewayApprovalRequest(request));
      } catch (err) {
        log.error('OneCLI approval translation failed closed', { requestId: request.id, err });
        return 'deny';
      }
    });
  } finally {
    signal.removeEventListener('abort', stop);
    stop();
  }
}

function toGatewayApprovalRequest(request: ApprovalRequest): GatewayApprovalRequest {
  return {
    id: request.id,
    trigger: 'policy',
    destination: { host: request.host, method: request.method },
    agentGroupId: request.agent.externalId ?? '',
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    summary: normalizeGatewayApprovalSummary(
      { agent: request.agent.name, method: request.method, host: request.host, path: request.path },
      (request as ApprovalRequest & { summary?: ApprovalSummary }).summary,
    ),
    title: 'Credentials Request',
    question: buildQuestion(request, request.agent.name),
    audit: { method: request.method, host: request.host, path: request.path },
  };
}

interface ApprovalSummary {
  action?: string;
  details?: { label: string; value: string }[];
}

function safeApprovalText(value: string): string {
  return value.replace(/[<>&`*_~[\]()]/g, '_').replace(/[\0\r]/g, '');
}

function buildQuestion(request: ApprovalRequest, agentName: string): string {
  const lines = [`*Agent:* \`${safeApprovalText(agentName)}\``];
  const summary = (request as ApprovalRequest & { summary?: ApprovalSummary }).summary;
  if (summary?.details?.length) {
    if (summary.action) lines.push(`*Action:* \`${safeApprovalText(summary.action)}\``);
    let budget = 2_200;
    for (const { label, value } of summary.details) {
      if (budget <= 0) break;
      const raw = safeApprovalText(typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value)));
      const shown = raw.slice(0, Math.min(900, budget));
      const safeLabel = safeApprovalText(String(label));
      lines.push(shown.includes('\n') ? `*${safeLabel}:*\n\`\`\`\n${shown}\n\`\`\`` : `*${safeLabel}:* \`${shown}\``);
      budget -= shown.length + String(label).length + 8;
    }
  } else {
    lines.push(`\`${safeApprovalText(`${request.method} ${request.host}${request.path.split(/[?#]/, 1)[0]}`)}\``);
  }
  return lines.join('\n').slice(0, 2_600);
}

registerGatewayProvider({
  kind: 'onecli',
  connections: {
    async connect() {
      const consoleUrl = process.env.ONECLI_CONSOLE_URL || env.ONECLI_CONSOLE_URL;
      return consoleUrl
        ? {
            status: 'action_required' as const,
            action: 'operator_console' as const,
            connect_url: consoleUrl,
            message:
              'Connect the account in OneCLI and grant access to the agent, then retry the original request. A native connect_url returned by the gateway can be used directly.',
          }
        : {
            status: 'unsupported' as const,
            message:
              'Use the native connect_url returned by OneCLI, or ask the operator to set ONECLI_CONSOLE_URL for a console handoff. Do not guess a dashboard URL from an API URL.',
          };
    },
  },
  agentSkills: ['onecli-gateway'],
  sessions: { ensure: ensureSession },
  approvals: { legacyActions: ['onecli_credential'], subscribe: subscribeApprovals },
});
