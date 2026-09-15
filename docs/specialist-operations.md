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
| 401 followed by `Read-only file system (os error 30)` | Inspect final `NO_PROXY`/`no_proxy` and the preceding auth error. Proxy bypass caused the September 11 incident; `token_revoked` caused the September 15 incident. See credential renewal below. |
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

## Codex credential renewal after `token_revoked` (2026-09-15)

### Recognize the failure

Cardi (`DMS PA Media`) returned `Error: Read-only file system (os error 30)`. Its live container logs first showed HTTP 401 with `Encountered invalidated oauth token for user` and code `token_revoked`, then repeated read-only errors. Codex attempted credential refresh against `/home/node/.codex/auth.json`, which is deliberately mounted read-only by OneCLI. The host root filesystem, agent workspace, and containing `.codex` directory were writable; the proxy exclusions were correct. Other Codex containers also logged revoked-token errors, although some continued producing results.

The vault credential originated from the operator's Mac Codex login imported on September 11. The logs establish revocation, but do not establish why it happened. Do not assume every read-only error has this cause: inspect the preceding error and actual mounts first. Making the auth stub writable or restarting alone does not repair a revoked vault credential.

### Replace the credential

1. Have the operator provide a freshly authenticated Codex auth JSON file on the production host. In this incident the supplied file was `/tmp/codex-auth.json` on **curielmedia**, not on the local Mac. Handle the file directly; never print its contents or paste credentials into chat, command arguments, or documentation. Restrict its permissions to `0600`.
2. Validate in memory that `tokens.access_token`, `tokens.refresh_token`, and `tokens.id_token` are nonempty strings. Preserve the complete auth JSON, including its account information.
3. Find the existing secret through the loopback OneCLI management API: `GET http://127.0.0.1:10254/api/secrets`. Display only metadata such as ID, name, type, and host pattern. The existing entry was named `Codex`, type `openai`, host pattern `chatgpt.com`. Resolve its ID afresh rather than creating a duplicate.
4. Update that entry with `PATCH http://127.0.0.1:10254/api/secrets/<secret-id>`. The JSON request has a `value` field containing the **serialized complete auth JSON as a string**. Build and send the body in memory from the file, using a host HTTP client. The installed gateway accepted this with HTTP 200 and parsed it as OpenAI OAuth. Keeping the same secret ID preserves agent assignments. Read back metadata to confirm the name, type, and host pattern remain correct; do not log the request body or credential-bearing responses.
5. The `onecli` executable was absent from the production host's PATH during this incident; the loopback API worked. If the API changes, inspect the installed gateway's supported update route before proceeding. No direct vault database edit, SDK installation, image rebuild, or host build was needed.

### Verify and restart

- Test from actual running Codex containers through their existing OneCLI proxy. Read the mounted auth stub in memory, send its access token as `Authorization: Bearer ...` and its account ID as `ChatGPT-Account-Id` when present. Request `https://chatgpt.com/backend-api/codex/models?client_version=0.153.0` (use the installed CLI version for future checks). Bun is available; Python was absent inside these containers. With Bun `fetch`, explicitly set `proxy` from `HTTPS_PROXY` or `https_proxy`, retain the configured CA trust, and print only the HTTP status.
- Cardi, Maven, and Amp were the three active NanoClaw containers at verification time. Each returned HTTP 200 after the vault update. This verifies gateway injection and models-endpoint authentication; it is not an end-to-end conversational test or proof that every dormant agent was tested.
- From the live project, use `node --import tsx src/cli/client.ts groups list` to resolve IDs, then `groups restart --id <group-id>` for affected running groups. Cardi, Maven, and Amp each returned `restarted: 1`; `systemctl is-active nanoclaw.service` returned `active`.
- Without `--message`, restart stops the current container and the group resumes on its next message. History remains intact; no failed messages were replayed and no test messages were sent. Idle groups use the updated vault credential when they next wake.

The supplied `/tmp/codex-auth.json` was restricted to `0600` and left in place during this repair; deletion was not performed. No credential values were recorded in these notes.
