# GIS-Notetaker

A Discord bot that joins your team's voice channel, records the meeting, and posts
**minutes** — TL;DR, decisions, action items with owners, standup updates, technical
notes, blockers and open questions — plus the full transcript.

```
/notes start title:"Sprint 14 planning"   →  bot joins, announces it's recording
            ... meeting happens ...
/notes stop                               →  minutes + transcript posted in #meeting-notes
```

## How it works

1. **Record.** The bot joins the voice channel and receives each person's audio
   separately, so every line is attributed to the right speaker. Discord only sends
   audio while someone is talking, so silence is never recorded or paid for.
2. **Transcribe.** Each speaker's clips are grouped into conversational turns and sent
   to a speech-to-text API (OpenAI `gpt-transcribe` by default, any OpenAI-compatible
   endpoint works).
3. **Summarize.** The speaker-labeled, timestamped transcript goes to an LLM (Claude
   Sonnet 5.5 by default, or any OpenAI-compatible model) with a dev-team minutes prompt.
4. **Post and delete.** Minutes are posted to Discord with `.md` and `.txt` attachments,
   and the raw audio is deleted, whether or not processing succeeded.

## Commands

| Command | What it does |
| --- | --- |
| `/notes start [title]` | Start recording the voice channel you're in |
| `/notes stop` | Stop and post the minutes |
| `/notes status` | Is anything recording? For how long? |
| `/notes optout` | Don't record me, and delete anything already captured from me |
| `/notes optin` | Include me again |

The bot also stops on its own when everyone leaves the channel (after
`EMPTY_CHANNEL_GRACE_SECONDS`) or when a meeting hits `MAX_MEETING_MINUTES`.

## Cost

For a typical team (~10 hours of meetings a month):

| Piece | Rate | ~Monthly |
| --- | --- | --- |
| Transcription, `gpt-transcribe` | $0.0045 per minute of speech | ~$2.70 |
| Minutes, Claude Sonnet 5.5 | ~$0.04 per 1-hour meeting | ~$1.00 |
| Hosting | Google Cloud e2-micro (free) or Fly.io (~$3.69) | $0–4 |

Only speech is billed, so real transcription cost is usually lower than meeting length
suggests. For even cheaper transcription, switch to Groq (see `.env.example`).

## Setup

### 1. Create the Discord bot

1. Go to <https://discord.com/developers/applications> → **New Application** → name it.
2. **General Information:** copy the **Application ID** → `DISCORD_CLIENT_ID`.
3. **Bot:** click **Reset Token**, copy it → `DISCORD_TOKEN`. No privileged intents are needed.
4. Invite it to your server (replace `YOUR_CLIENT_ID`):

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot+applications.commands&permissions=1084416
   ```

   That grants View Channels, Send Messages, Attach Files and Connect, nothing else.

5. In Discord, enable **Developer Mode** (User Settings → Advanced), then right-click
   your server → **Copy Server ID** → `DISCORD_GUILD_ID`, and right-click your notes
   channel → **Copy Channel ID** → `NOTES_CHANNEL_ID`.

### 2. Get API keys

- **Transcription:** an OpenAI API key → `TRANSCRIPTION_API_KEY`
- **Minutes:** an Anthropic API key → `SUMMARY_API_KEY` (or set `SUMMARY_PROVIDER=openai`
  and use an OpenAI or other OpenAI-compatible key and model)

### 3. Run it locally

```bash
cp .env.example .env      # fill it in
npm install
npm run register          # registers /notes with Discord (re-run when commands change)
npm run dev
```

Requires Node.js 22+.

## Deploy

The bot holds a live voice connection for the whole meeting, so it needs an always-on
process. Serverless functions (Lambda, Cloud Functions) time out mid-meeting.

### Option A: Fly.io (~$3.69/month, easiest)

```bash
fly launch --no-deploy --copy-config      # accept the generated app name or keep gis-notetaker
fly secrets set DISCORD_TOKEN=... DISCORD_CLIENT_ID=... DISCORD_GUILD_ID=... \
  TRANSCRIPTION_API_KEY=... SUMMARY_API_KEY=... NOTES_CHANNEL_ID=...
fly deploy
fly ssh console -C "node dist/register-commands.js"
```

Non-secret settings (`GLOSSARY`, `SUMMARY_MODEL`, etc.) can go in an `[env]` block in
`fly.toml`. Logs: `fly logs`.

### Option B: Google Cloud e2-micro (free)

1. Create a VM: Compute Engine → **e2-micro**, region **us-central1**, **us-east1** or
   **us-west1** (the free-tier regions), Debian 12, standard persistent disk ≤ 30 GB.
2. SSH in and run:

   ```bash
   git clone https://github.com/bethanyann/GIS-Notetaker.git /tmp/gis && bash /tmp/gis/deploy/gcp-setup.sh
   sudo nano /opt/gis-notetaker/.env
   cd /opt/gis-notetaker && sudo -u gisbot node dist/register-commands.js
   sudo systemctl enable --now gis-notetaker
   ```

3. To update later: `bash /opt/gis-notetaker/deploy/update.sh`. Logs: `journalctl -u gis-notetaker -f`.

On both hosts, a restart or redeploy during a meeting doesn't lose it: the bot catches
the shutdown signal and writes up what it has before exiting.

## Configuration

All settings are environment variables; see [`.env.example`](.env.example) for the full
list with comments. The ones you'll most likely tune:

- **`GLOSSARY`**: names and jargon that speech-to-text mishears (teammates, repos,
  services). This noticeably improves transcript and action-item accuracy.
- **`ALLOWED_ROLE_ID`**: restrict who can start/stop notes.
- **`SUMMARY_PROVIDER` / `SUMMARY_MODEL`**: swap the minutes model. The prompt lives in
  [`src/minutes.ts`](src/minutes.ts) if you want different sections.

## Privacy

- The bot announces itself in the channel every time it starts recording, and anyone
  can `/notes optout` at any point, which also deletes what was already captured from them.
- Raw audio lives only in a temporary folder during the meeting and is deleted right
  after processing. Only the posted text is kept, in your Discord channel.
- Audio is sent to your transcription provider and the transcript to your LLM provider,
  under your API keys and their data policies.
- Recording-consent laws vary by location. Let participants know meetings are recorded,
  e.g. in the channel description.

## Tips for better minutes

- Say ticket numbers and owners out loud: "I'll take ABC-142 by Friday."
- Give meetings a title with `/notes start title:...` so the minutes say what kind of
  meeting it was.

## Troubleshooting

- **`/notes` doesn't appear:** run `npm run register`. Without `DISCORD_GUILD_ID`, global
  commands can take up to an hour to show up.
- **Bot joins but transcript is empty:** check the bot isn't server-muted or deafened, and
  that its role can see the voice channel. Set `DEBUG_VOICE=1` to log the voice dependency report.
- **"Something went wrong writing up…":** usually an API key or model name issue. Check logs.

## Development

```bash
npm run typecheck
npm test
```

| File | Purpose |
| --- | --- |
| `src/index.ts` | Discord client, `/notes` command handling, shutdown handling |
| `src/session.ts` | One recording: voice connection, per-speaker capture, stop & process |
| `src/transcript.ts` | Grouping clips into speaker turns, formatting the transcript |
| `src/transcribe.ts` | Speech-to-text requests |
| `src/minutes.ts` | Minutes prompt and LLM call |
| `src/post.ts` | Posting minutes to Discord |
| `src/audio.ts` | PCM downsampling and WAV encoding |
