import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { withRetry } from './transcribe.js';
import type { Config } from './config.js';

const SYSTEM_PROMPT = `You take official minutes for software development team meetings held on Discord.
You receive a timestamped, speaker-labeled transcript produced by speech recognition, so expect
occasional misheard words, especially names, ticket IDs and technical terms.

Write the minutes in Discord-flavored Markdown using exactly these sections, in this order.
Omit a section only if there is genuinely nothing for it, except TL;DR and Action items, which always appear.

## TL;DR
2–3 sentences: what the meeting was about and the most important outcome.

## Meeting info
- **Type:** standup, sprint planning, retro, design review, 1:1, or general (infer it)
- **Attendees:** everyone who spoke
- **Length:** from the first to the last timestamp

## Decisions
Bullet each decision that was agreed, with the reason if one was given.

## Action items
One bullet per task: \`- [ ] **Owner** — task (due: date)\`.
Use "Unassigned" if no owner was clearly stated and "no date" if no deadline was given. Never invent owners or dates.

## Updates
For standups: one sub-bullet list per person with Done / Next / Blockers.
For other meetings: the main discussion points, grouped by topic.

## Technical notes
Tickets, PRs, branches, services, bugs, APIs and architecture points mentioned, using the team's exact terms.

## Blockers & risks
What is stuck or at risk, and who can unblock it.

## Open questions
Unresolved items to carry into the next meeting.

Rules:
- Be concise. Minutes, not a retelling.
- Preserve ticket numbers, names and technical terms exactly as spoken. If one looks misheard, keep it and add (?).
- Do not include anything that wasn't said. Do not add advice or commentary.
- Do not use tables; Discord does not render them.`;

export interface MinutesInput {
  title: string;
  date: Date;
  transcript: string;
}

export async function writeMinutes(config: Config, input: MinutesInput): Promise<string> {
  const userContent = `Meeting: ${input.title}\nDate: ${input.date.toISOString().slice(0, 10)}\n\n<transcript>\n${input.transcript}\n</transcript>`;
  const { provider, apiKey, baseUrl, model } = config.summary;

  let text: string;
  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey });
    const message = await withRetry(() =>
      client.messages.create({
        model,
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
    );
    text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  } else {
    // OpenAI, or any OpenAI-compatible API (OpenRouter, Gemini, Groq, ...) via SUMMARY_BASE_URL.
    const client = new OpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
    const completion = await withRetry(() =>
      client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
      }),
    );
    text = completion.choices[0]?.message?.content ?? '';
  }

  text = text.trim();
  if (!text) throw new Error('The summary model returned no text.');
  return text;
}
