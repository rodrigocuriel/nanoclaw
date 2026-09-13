# Creating and maintaining specialist agents

This runbook records the setup requirements confirmed on 2026-09-11 after bringing Maven's Escrow, Builder, Inspector, and Scout online. The operator confirmed that routing and replies work after the fixes below.

## Work on the live installation

The production host is `root@159.195.16.153`, project `/home/nanoclaw/nanoclaw-v2`, service `nanoclaw.service` (runs as `nanoclaw`). The local checkout's DB is not production. Run the admin CLI from the remote project:

```sh
node --import tsx src/cli/client.ts groups list
node --import tsx src/cli/client.ts destinations list
```

See [deployment notes](../DEPLOYMENT.local.md) for installation history. No credential values belong in either document.

## Checklist for each new specialist

1. Create the agent with the normal admin workflow. Set its provider/model explicitly; new groups do not inherit a global provider or their coordinator's model settings. For a Codex/Astra specialist:

   ```sh
   node --import tsx src/cli/client.ts groups config update --id GROUP_ID --provider codex --model gpt-6-astra --effort low
   ```

   This is a setup example, not a statement that all existing specialists were assigned Astra. This session changed the persisted model settings for Amp, Nano, Cardi, and Maven only.

2. Verify OneCLI has an OpenAI credential and supplies a Codex auth stub for the new group's gateway identity (the NanoClaw group ID). `secretMode=all` grants matching vault secrets; it cannot compensate for a missing OpenAI vault entry. In selective mode, preserve existing assignments when adding the required secret. Use the supported OneCLI management interface or SDK without printing credential values.

3. Keep OpenAI traffic going through OneCLI. On this hybrid installation, the native Anthropic override must emit only:

   ```text
   NO_PROXY=api.anthropic.com,127.0.0.1,localhost
   no_proxy=api.anthropic.com,127.0.0.1,localhost
   ```

   Do not add `chatgpt.com` or `api.openai.com` to the bypass list when using vault auth stubs. Inspect the final environment in a real container: the native override is applied after OneCLI and wins over earlier settings.

4. Add explicit routes in both directions. Creating specialists from Nano made their `parent` alias point to Nano, not Maven. Do not assume the creation hierarchy provides coordinator access. Use local names:

   ```sh
   node --import tsx src/cli/client.ts destinations add --agent-group-id COORDINATOR_ID --local-name specialist-name --target-type agent --target-id SPECIALIST_ID
   node --import tsx src/cli/client.ts destinations add --agent-group-id SPECIALIST_ID --local-name coordinator-name --target-type agent --target-id COORDINATOR_ID
   ```

   Check existing entries first; `add` inserts and is not an upsert. Preserve existing routes. Each route is also a permission to send to that target.

5. Verify runtime projection. `destinations add` updates the central `agent_destinations` table and projects routes into existing sessions' `inbound.db` destination tables. No restart is required for this route update. Use the in-tree query wrapper:

   ```sh
   node --import tsx scripts/q.ts data/v2-sessions/GROUP_ID/SESSION_ID/inbound.db 'SELECT name, type, agent_group_id FROM destinations ORDER BY name'
   ```

6. Restart affected containers after auth-stub or environment changes. `groups restart --id GROUP_ID` stops the old container; without `--message`, it wakes on the next message. History remains intact. Host code changes also require a host build and service restart; CLI changes require an image rebuild.

7. Validate with the actual runtime. Check a minimal authenticated request in the real container and then an authorized coordinator-to-specialist message with a reply. A successful send proves routing only; it does not prove the recipient can authenticate or reply. An isolated SDK-only probe can miss later host environment overrides, as happened during this incident. Never clear history or make credential mounts writable just to suppress an error.

## Changes made in this session

| Area | Change | Validation |
| --- | --- | --- |
| Model settings | Amp, Nano, Cardi (`DMS PA Media`), Maven: `gpt-6-astra`, effort `low` | Read back from live configuration |
| Codex CLI | Live `container/cli-tools.json`: `0.138.0` → `0.153.0`; rebuilt base image | Astra request succeeded; `0.154.0` was inside the three-day release-age gate and was not installed |
| Retry handling | `container/agent-runner/src/providers/codex.ts`: treat `error` notifications with `willRetry: true` as progress; retain terminal-error handling | Nine turn tests passed, including recovery and exhausted retries |
| Vault auth | With explicit operator approval, imported Maven's existing Codex login into OneCLI as an `openai` secret named `Codex`, host pattern `chatgpt.com` | All four specialist identities received auth stubs and passed gateway authentication probes |
| Routing | Maven → `escrow`, `builder`, `inspector`, `scout`; each specialist → `maven` | All eight routes verified in session DBs; user confirmed message delivery |
| Proxy override | `src/native-credential-proxy.ts`: removed OpenAI hosts from `NO_PROXY_VALUE` | All four actual containers returned `AUTH_OK` with the corrected environment; host build passed and service restarted; user confirmed working |

The CLI pin, retry source/tests, and proxy correction are synchronized in the local checkout for version control. The fixes are deployed on the server. No PR was submitted. Preserve these installation changes when updating or redeploying.

The container typecheck was attempted and has pre-existing errors involving MCP configuration fields and the `file` provider event; the same errors were confirmed without the retry patch. Do not report that check as passing.

## Diagnosing the observed errors

| Error | What to check |
| --- | --- |
| Model requires a newer Codex | Check `codex --version` inside the actual container, the manifest pin, and the image used at spawn |
| Missing authentication headers, requests to `api.openai.com` | Check for an empty/missing `auth.json`, missing vault OpenAI secret, and absent credential stub |
| `Reconnecting... 2/5` immediately ends the turn | Ensure the Codex provider honors the protocol's `willRetry` flag |
| 401 followed by `Read-only file system (os error 30)` | Inspect final `NO_PROXY`/`no_proxy`; in this incident placeholders bypassed injection and Codex tried to refresh the deliberately read-only auth stub |
| Unknown destination | Check the source agent's named destination ACL and its projection into the session DB |

The read-only auth stub is intentional. The containing `.codex` state directory must be writable by the container's `node` user. For isolated test containers, Docker can create a missing parent directory as root-owned: provision a writable temporary Codex state directory before mounting the nested stub. Run SDK container configuration as the `nanoclaw` service user to avoid ownership conflicts with its existing temporary CA files.

## Long-turn timeout follow-up (2026-09-11)

Nano, Amp, and every running Codex specialist were verified to have the corrected final proxy exclusions and the vault auth stub. Amp and Builder subsequently hit a separate fixed ten-minute turn limit despite activity during the turn. The shared Codex adapter now uses `turn-watchdog.ts`: ten minutes without app-server notification activity ends a stalled turn, and thirty minutes is the maximum total turn duration. Activity refreshes only the inactivity deadline. Completion, failure, and abort clean up both timers. This does not guarantee that a stalled external tool will complete.

All twelve turn/watchdog tests passed. The required container typecheck still reports the previously documented MCP/file-event type errors. Nano, Amp, Escrow, Builder, Inspector, and Scout were restarted to load the patch; other already-running Codex containers pick it up on their next restart. No message was automatically replayed and no history was cleared.

The audit also checked gateway provisioning for the OpenCode specialists. The `ohm-2`, `bolt-2`, `arc-2`, and `surge-2` group identities are provisioned. The original dormant `arc` and `surge` identities returned 404; the normal host spawn path calls `ensureAgent` before requesting container config, so they are provisioned on first use. OpenCode groups do not use the Codex turn watchdog. Gateway metadata checks alone are not end-to-end model tests for dormant groups.


## UIUX routing follow-up (2026-09-13)

UIUX (`ag-1789247532765-juid5k`) was already registered, with Maven → `uiux` and UIUX → `parent` (Maven). Maven nevertheless reported the destination missing while it was present in her session DB. Restarting Maven refreshed the runtime without clearing history. Added an explicit UIUX → `maven` alias, retaining `parent`.

Validated the complete exchange: Maven sent a connectivity check to `uiux`; UIUX authenticated and returned `UIUX_READY`; Maven acknowledged connectivity. No duplicate agent was created. The evidence supports stale conversational/runtime awareness, not a missing central route or an authentication failure.

Operational gotcha: `groups restart --message` only processes currently running containers. For an idle UIUX session it returned `restarted: 0` and queued no message. The bounded check was queued using the existing host `writeSessionMessage` helper as the service user and picked up by the normal host sweep. Verify a message was actually queued and a reply delivered; a successful CLI exit alone does not establish this.
