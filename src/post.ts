import { AttachmentBuilder, type SendableChannels } from 'discord.js';
import { formatTimestamp } from './transcript.js';

/** Discord's per-message limit is 2000 characters; leave headroom. */
const MAX_MESSAGE_LENGTH = 1900;

export interface MinutesPost {
  title: string;
  startedAt: Date;
  durationMs: number;
  minutes: string;
  transcript: string;
}

export async function postMinutes(channel: SendableChannels, post: MinutesPost): Promise<void> {
  const date = post.startedAt.toISOString().slice(0, 10);
  const unixSeconds = Math.floor(post.startedAt.getTime() / 1000);
  const header = `# 📝 ${post.title}\n<t:${unixSeconds}:F> · ${formatTimestamp(post.durationMs)} long`;

  const parts = splitMessage(`${header}\n\n${post.minutes}`);
  for (const part of parts.slice(0, -1)) {
    await channel.send({ content: part, allowedMentions: { parse: [] } });
  }

  const slug = slugify(post.title) || 'meeting';
  await channel.send({
    content: parts.at(-1),
    allowedMentions: { parse: [] },
    files: [
      new AttachmentBuilder(Buffer.from(`# ${post.title} (${date})\n\n${post.minutes}\n`), {
        name: `${date}-${slug}-minutes.md`,
      }),
      new AttachmentBuilder(Buffer.from(`${post.title} (${date})\n\n${post.transcript}\n`), {
        name: `${date}-${slug}-transcript.txt`,
      }),
    ],
  });
}

export async function postNothingRecorded(channel: SendableChannels, title: string): Promise<void> {
  await channel
    .send(`📝 **${title}** ended, but no one spoke, so there are no minutes.`)
    .catch(() => {});
}

/** Split text into Discord-sized messages at line breaks, never mid-word if avoidable. */
export function splitMessage(text: string, max = MAX_MESSAGE_LENGTH): string[] {
  const parts: string[] = [];
  let current = '';

  const pushLine = (line: string) => {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= max) {
      current = candidate;
      return;
    }
    if (current) parts.push(current);
    current = '';
    // A single line longer than the limit: break it at spaces.
    let rest = line;
    while (rest.length > max) {
      let cut = rest.lastIndexOf(' ', max);
      if (cut <= 0) cut = max;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    current = rest;
  };

  for (const line of text.split('\n')) pushLine(line);
  if (current) parts.push(current);
  return parts.length > 0 ? parts : [''];
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}
