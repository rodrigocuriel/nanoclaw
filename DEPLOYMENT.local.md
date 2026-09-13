# Live NanoClaw deployment

Confirmed by Rodrigo on 2026-09-11:
- SSH: `root@159.195.16.153`
- Project: `/home/nanoclaw/nanoclaw-v2`
- Service: `nanoclaw.service` (runs as `nanoclaw`)
- The local checkout's database is not the live agent configuration.
- Live admin CLI: from the remote project, `node --import tsx src/cli/client.ts ...`.
- Cardi is registered as `DMS PA Media`, folder `dms-pa-media`.

On 2026-09-11, Amp, Nano, Cardi, and Maven were configured with model `gpt-6-astra` and effort `low`.

Astra compatibility fix (2026-09-11): live `container/cli-tools.json` now pins `@openai/codex` to `0.153.0` (was `0.138.0`). Rebuilt `nanoclaw-agent-v2-1e478a5f:latest`; an isolated request through the existing gateway succeeded with `gpt-6-astra`, effort `low`, response `ASTRA_OK`. Previous image retained as `nanoclaw-agent-v2-1e478a5f:before-astra-upgrade`. Version `0.154.0` was under three days old, so it was not installed. The local checkout's CLI manifest has not been synchronized with the live deployment.

Retry handling fix (2026-09-11): patched `container/agent-runner/src/providers/codex.ts` locally and on the server to treat Codex `error` notifications with `willRetry: true` as progress, preserving the active turn. Previously NanoClaw killed the app-server during reconnect attempts. Added recovery/exhausted-retry tests: 9 turn tests pass in the deployed image. Container typecheck has pre-existing MCP config and file-event type errors, confirmed on the unmodified server source. Restarted Cardi without clearing history. Source is mounted into containers, so no image rebuild is needed for this patch.

Codex vault registration (2026-09-11): with Rodrigo's explicit approval, imported Maven's existing Codex login into OneCLI as the `Codex` OpenAI secret (host pattern `chatgpt.com`). Previously the vault contained no OpenAI credential and newly created Codex groups had empty auth files. OneCLI now supplies a credential stub for Escrow, Builder, Inspector, and Scout. Isolated read-only GPT-6 Astra requests through each agent's own gateway identity all returned `AUTH_OK`. Restarted those four groups to mount the new stubs on their next wake. No credential values were printed or recorded here.

OpenAI proxy bypass fix (2026-09-11): removed `chatgpt.com` and `api.openai.com` from `NO_PROXY_VALUE` in `src/native-credential-proxy.ts` locally and on the server. The Anthropic override had bypassed OneCLI for OpenAI, sending placeholder tokens directly and triggering Codex refresh attempts against the read-only auth stub. All four specialists returned `AUTH_OK` inside their actual containers with corrected proxy exclusions, retaining the read-only stub. Host build passed; restarted `nanoclaw.service` to activate the change.

Specialist routing (2026-09-11): added Maven → escrow/builder/inspector/scout and each specialist → maven, preserving their existing parent routes to Nano. Verified all eight entries in runtime inbound destination tables; no restart required. Rodrigo confirmed direct routing and subsequently confirmed the specialists work after the proxy fix. See [specialist operations runbook](docs/specialist-operations.md) for future setup and troubleshooting.

Long-turn timeout follow-up (2026-09-11): replaced the Codex fixed 600000ms turn deadline with a ten-minute inactivity watchdog plus thirty-minute maximum. Added `turn-watchdog.ts` and deterministic tests; 12 tests pass. Deployed locally/remotely and restarted Nano, Amp, Escrow, Builder, Inspector, Scout. Gateway/proxy audit completed; see specialist runbook for dormant-group limitations. Container typecheck retains known pre-existing errors.

UIUX communication check (2026-09-13): existing group `ag-1789247532765-juid5k` (`uiux`) already had Maven → uiux and UIUX → parent (Maven) routes. Maven's long-lived conversation incorrectly reported uiux missing despite the route being present in its inbound DB. Restarted Maven without clearing history, added UIUX's explicit `maven` destination alias, and queued a bounded internal connectivity check via the host session-message helper. UIUX woke, authenticated, and returned `UIUX_READY` to Maven; Maven also sent a check to uiux. `groups restart --message` only targets running containers: for an already-stopped session it returned zero and queued no message, so do not mistake that result for a successful wake.

Version-control preparation (2026-09-13): synchronized the local Codex CLI pin to the deployed `0.153.0` and recorded the confirmed UIUX → Maven reply plus Maven's acknowledgement in the specialist runbook. Earlier statements that these changes were uncommitted describe their deployment-time state.
