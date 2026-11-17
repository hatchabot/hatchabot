# Voice with an agent

Open the agent's settings, choose **Advanced**, and find **Voice**. The
**Browser Talk** card checks and sets up that agent's running OpenClaw. These
controls are for the agent's owner. Opening the card, setting up Talk,
rechecking, and opening the console do not start recording.

## Check, configure, then try

1. Press **Recheck** to read its saved Talk owner and provider catalog. A
   configured result means OpenClaw found a usable configuration and credential
   source. It is **not a tested call**: microphone permission, provider access,
   quota, network connectivity and audio playback still need a real trial.
2. If Talk is not linked to this agent, press **Set up Talk**. This saves its
   Talk owner, preserves existing provider/model/voice choices and uses the
   runtime's existing credential selection. It does not create credentials.
   If settings change during setup, recheck before trying again.
3. If credentials are missing, open **Voice key settings**. A machine owner
   can save a shared Gemini key under Connections → Voice & media. Rebuild
   each agent that needs the key, then recheck. A Google or OpenAI AI source
   can instead supply its own supported credentials; an Anthropic text
   subscription alone does not provide browser Talk credentials. A saved key
   and a configured result still do not prove quota or call access.
4. **Voice settings** opens OpenClaw's **Settings → Talk**
   (`/settings/talk`) when you want to choose a provider, model or speaker
   voice. Save there and return to Recheck. Runtime defaults choose the model
   when you have not set one; Hatchabot does not guess a provider-specific model.
5. Press **Try voice** to open that agent's existing console conversation.
   Check the agent and conversation, then explicitly press OpenClaw's
   microphone control and grant microphone access when the browser asks.
   Use OpenClaw's controls to interrupt or end the call.

Use HTTPS, or localhost on the machine running Hatchabot, with a browser that
supports microphone capture. Plain HTTP on another machine's address does
not provide the secure browser context needed for the microphone. A secure
page still needs your permission and a working input device.

| Result | What to do |
| --- | --- |
| Configured, not tested | Try a short call to check the complete audio path. |
| Talk is not linked | Press Set up Talk to bind it to the agent shown on the card. |
| Voice credentials needed | Add a shared key and Rebuild, or configure supported credentials in the agent's own provider settings. |
| Provider needs attention | Open Voice settings and check the selected provider. Setup preserves existing custom settings. |
| Manager needs network permission | Set up Talk authorizes its detected Google or OpenAI voice service; other providers are not added to its network access. |
| Agent stopped, asleep or busy | Start or wake it, or let its current change finish, then recheck. |
| Runtime unreachable or check unavailable | Check the runtime connection and recheck. This does not mean its credentials are absent. |
| Talk unsupported | Check the runtime version. The integration targets OpenClaw 2026.9.8; an unavailable method is not evidence of missing keys. |
| HTTPS or microphone support needed | Open a secure address and use a browser with microphone support. |

Rechecking is read-only. It does not start a voice-provider session, send
audio, or request an AI answer. No configuration check marks a call tested.

## When the check cannot choose its Talk agent

The pinned runtime's catalog does not accept a conversation key. It checks
`talk.agentId`, then the runtime's system-agent owner, then an unambiguous
single agent. A volume can contain both Hatchabot's agent and an older
internal `main` agent. Without a designated owner the catalog can fail before
checking providers, or select the old agent's credentials. Hatchabot verifies
the binding before relying on the catalog and checks the configuration
revision again before reporting readiness.

**Set up Talk** binds the intended OpenClaw agent ID: the slug shown on the
card. It uses a revision-guarded patch and rereads the result, including when
the gateway's answer was lost. The advanced editor remains available in
**Voice settings**. New or rebuilt agents on compatible OpenClaw 2026.9.8+
runtimes receive this default only when no Talk owner was authored. Existing
agents can use Set up Talk without rebuilding; a newly saved shared key still
requires Rebuild to enter their environment.

OpenClaw's microphone control also waits for catalog readiness. Once a call
starts, its explicit `agent:<slug>:main` session key determines the agent it
consults. The pinned [owner resolver](https://github.com/openclaw/openclaw/blob/v2026.9.8/src/talk/agent-target.ts)
and [microphone control](https://github.com/openclaw/openclaw/blob/v2026.9.8/ui/src/pages/chat/components/chat-composer.ts)
define these rules.

## The manager's voice network access

The Hatchabot manager has a restricted network. Its text provider's access
may not cover the detected voice provider. Pressing Set up Talk explicitly
allows that provider's fixed voice hosts: Google's generative-language API,
or OpenAI's API and ChatGPT OAuth broker. Provider labels cannot introduce
arbitrary hosts. This access remains tied to the same owner, runtime, machine
and AI source; after a rebuild or source change the card may request setup
again. Recheck never grants access. No credential is copied into this grant.

## Where the voice settings live

Provider selection, credentials configured through OpenClaw, models and
speaker voices stay in the agent's OpenClaw state on its persistent volume.
Hatchabot's Voice card adds no separate credential store and does not copy
raw keys into the page. An existing credential injected when the agent was
built may also satisfy the provider's configuration check.

Browser Talk uses OpenClaw's `talk.realtime` settings. The persistent voice
field is `speakerVoice`; `talk.realtime.voice` is not a valid setting in the
pinned runtime. The curated Talk page handles these details. The separate
`talk.speechLocale` setting applies to native speech recognition; it is not
a promise that a browser realtime session will use that language.

The owner can use these controls because its console has administrative
rights. Web-chat guests do not currently receive OpenClaw's `operator.talk`
permission. This first iteration does not enable Talk for guests or broaden
their access to settings or other conversations.

## Telegram voice notes are a separate path

**Settings → Connections → Voice & media** holds the shared Gemini key for
Telegram voice-note transcription. A saved key is not a verified recording
or a successful transcription. Its changes reach an agent at its next
**Rebuild**; an agent using a Google AI profile gets that profile's own key
in preference to the shared one. Removing the shared key also needs a
rebuild to remove its previous copy from a running agent's environment.

That injected Gemini key can be a credential source for Google browser Talk,
but saving it does not configure or test a browser call. Browser Talk still
uses the agent's upstream voice-provider settings and requires browser
microphone access. A working Telegram voice note does not prove browser
Talk works, or the other way around.

## The agent and its voice

Try voice opens the selected agent's console conversation. OpenClaw binds
Talk to that session's owning agent, so agent consultations use its context
and tools. The realtime voice provider may answer directly without invoking
the agent for every utterance: this is not a guarantee that every spoken
answer uses the same model as text chat.

OpenClaw also has a force-agent-consult option for supported gateway-relay
configurations. The readiness card does not change that policy. Choose and
test such settings in OpenClaw if every answer needs to go through the
agent. Switching console tabs now stops active or starting Talk before hiding
its controls. If the console cannot stop the call, Hatchabot unloads that
frame. Text-chat tabs stay loaded. Closing the console or signing out also
releases its frames.

## Manual acceptance before calling voice verified

These checks require a real browser, microphone and configured provider.
They are an acceptance checklist, not a record that live verification has
already passed. Use a short, non-sensitive phrase and expect a real call to
use the provider's quota or billing.

- Open and recheck the Voice card. Confirm no microphone prompt, recording,
  provider voice-session creation or AI-provider request occurs. Only the
  read-only runtime readiness query should be needed.
- Set up Talk, then reopen Voice settings to confirm the selection
  persists, including the intended Talk Agent when several internal agents
  exist. Recheck the card and confirm it still says the call is untested.
- Try voice and explicitly start the microphone. Speak the test phrase;
  confirm the transcript appears in the intended agent's conversation and
  that an audible reply follows.
- Interrupt a spoken reply and confirm playback stops or yields according
  to the chosen provider's supported controls.
- End the call and confirm microphone capture and playback stop. Close the
  console tab and confirm it leaves no active capture behind.
- While a call is active or starting, switch to a different agent. Confirm
  the first microphone and playback stop, then check the new agent's readiness
  and explicitly start a call there. Confirm its transcript and reply belong
  to the new agent. Repeat with console close, Escape during startup, and
  sign-out.
- Check a stopped agent, an unavailable runtime and denied microphone
  permission. Each should give an actionable state, with no silent recording
  or fallback to a different agent.

The existing automated console smoke test checks the secure page and gateway
connection. It does not establish that speech input, transcription, spoken
replies or interruption work on a real device.

## Pinned upstream contract

This flow was checked against the official OpenClaw **v2026.9.8** source,
not inferred from newer documentation:

The console proxy also keeps OpenAI's brokered WebRTC offer inside the
selected agent's console prefix. The pinned [offer resolver](https://github.com/openclaw/openclaw/blob/v2026.9.8/ui/src/pages/chat/talk/webrtc-support.ts)
otherwise sends the [broker's root-relative endpoint](https://github.com/openclaw/openclaw/blob/v2026.9.8/extensions/openai/realtime-quicksilver-session.ts)
to Hatchabot's root. An owner-console script rebases only that same-origin
offer POST; the existing console authorization and guest restrictions
still apply. Direct provider endpoints are unchanged.

- [Talk settings route](https://github.com/openclaw/openclaw/blob/v2026.9.8/ui/src/app-route-paths.ts): `/settings/talk`.
- [Catalog and session schemas](https://github.com/openclaw/openclaw/blob/v2026.9.8/packages/gateway-protocol/src/schema/channels.ts): `talk.catalog` accepts optional provider/model overrides; this version does not accept a session key for that read.
- [Catalog and config handlers](https://github.com/openclaw/openclaw/blob/v2026.9.8/src/gateway/talk/handlers/index.ts): runtime-selected readiness and redacted configuration reads.
- [Talk configuration](https://github.com/openclaw/openclaw/blob/v2026.9.8/src/config/zod-schema.root-support.ts): persistent realtime settings and native speech locale.
- [Browser session controller](https://github.com/openclaw/openclaw/blob/v2026.9.8/ui/src/pages/chat/talk/session.ts) and [agent ownership](https://github.com/openclaw/openclaw/blob/v2026.9.8/src/talk/agent-target.ts): explicit microphone startup, transport handling and session ownership.
- [RPC permissions](https://github.com/openclaw/openclaw/blob/v2026.9.8/src/gateway/methods/core-descriptors.ts): read access for the catalog and Talk access for voice sessions.
