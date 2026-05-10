import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      continue;
    }

    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args.set(key, 'true');
      continue;
    }

    args.set(key, next);
    index += 1;
  }
  return args;
}

function required(args, key) {
  const value = args.get(key)?.trim();
  if (!value) {
    console.error(`Missing required --${key}`);
    process.exit(1);
  }
  return value;
}

function readText(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

function writeText(path, value) {
  writeFileSync(resolve(repoRoot, path), value);
}

function uniqueMatches(source, pattern) {
  return [...new Set([...source.matchAll(pattern)].map((match) => match[0]))].sort();
}

function collectRequiredTokens(source) {
  return {
    mentions: uniqueMatches(source, /@[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/g),
    pullUrls: uniqueMatches(source, /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g),
    issueRefs: uniqueMatches(source, /(?<![A-Za-z0-9/])#\d+\b/g),
  };
}

function missingTokens(requiredTokens, candidate) {
  return [
    ...requiredTokens.mentions,
    ...requiredTokens.pullUrls,
    ...requiredTokens.issueRefs,
  ].filter((token) => !candidate.includes(token));
}

function stripCodeFence(source) {
  return source
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

function extractMarkdownSection(source, heading) {
  const pattern = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const match = source.match(pattern);
  if (!match || match.index === undefined) {
    return '';
  }

  const sectionStart = match.index + match[0].length;
  const rest = source.slice(sectionStart);
  const nextHeadingIndex = rest.search(/\n##\s+/);
  const section = nextHeadingIndex === -1 ? rest : rest.slice(0, nextHeadingIndex);
  return section.trim();
}

function extractUsefulListLines(section) {
  return section
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith('- ') && !line.includes('_No '));
}

function formatCollectedSourceFallback(source) {
  if (!source.includes('# Release Changelog Source')) {
    return source.trim();
  }

  const githubNotes = extractMarkdownSection(source, 'GitHub Generated Release Notes');
  const pullLines = extractUsefulListLines(extractMarkdownSection(source, 'Pull Requests In Range'));
  const commitLines = extractUsefulListLines(extractMarkdownSection(source, 'Direct Commits In Range'));
  const lines = [];

  if (pullLines.length > 0) {
    lines.push('### Pull Requests', '', ...pullLines, '');
  }

  if (commitLines.length > 0) {
    lines.push('### Direct Commits', '', ...commitLines, '');
  }

  if (githubNotes) {
    const fullChangelogLine = githubNotes
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('**Full Changelog**:'));

    if (fullChangelogLine) {
      lines.push(fullChangelogLine);
    } else {
      lines.push('### GitHub Generated Notes', '', githubNotes);
    }
  }

  return lines.join('\n').trim();
}

function formatFallbackEntry({ releaseTag, previousTag, generatedNotes }) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [`## ${releaseTag} - ${date}`, ''];

  if (previousTag) {
    lines.push(`Changes since \`${previousTag}\`.`);
    lines.push('');
  }

  const notes = formatCollectedSourceFallback(generatedNotes);
  if (notes) {
    lines.push(notes);
  }

  return `${lines.join('\n')}\n`;
}

function buildPrompt({ releaseTag, previousTag, generatedNotes }) {
  const previousCopy = previousTag ? `Previous release tag: ${previousTag}` : 'This is the first release tag.';
  return `You are writing release changelog notes for OpenXTerm, a Tauri desktop terminal workspace.

Release tag: ${releaseTag}
${previousCopy}

Rewrite the collected release source into a concise, high-signal Markdown changelog entry.

Hard requirements:
- Start with exactly this heading format: ## ${releaseTag} - YYYY-MM-DD
- Preserve every pull request number, pull request URL, issue reference, and @contributor mention from the input exactly.
- Do not invent PRs, contributors, features, fixes, dates, or compatibility claims.
- Keep contributor attribution attached to the relevant bullet when the input contains it.
- Prefer grouped sections such as Highlights, Fixes, Maintenance, Documentation, and Contributors only when the input supports them.
- Do not include markdown code fences.
- Do not include legal disclaimers.

Collected release source:

${generatedNotes}`;
}

async function generateWithGemini({ releaseTag, previousTag, generatedNotes }) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }

  const model = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.GEMINI_TIMEOUT_MS || 30000));

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: buildPrompt({ releaseTag, previousTag, generatedNotes }) }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 4096,
        },
      }),
    });

    const body = await response.text();
    if (!response.ok) {
      console.warn(`Gemini changelog generation failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
      return null;
    }

    const payload = JSON.parse(body);
    const text = payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? '')
      .join('')
      .trim();

    return text ? stripCodeFence(text) : null;
  } catch (error) {
    console.warn(`Gemini changelog generation failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeGeneratedEntry({ releaseTag, entry, fallbackEntry, generatedNotes }) {
  const requiredTokens = collectRequiredTokens(generatedNotes);
  const missing = missingTokens(requiredTokens, entry);
  if (missing.length > 0) {
    console.warn(`Generated changelog lost required PR/contributor tokens: ${missing.join(', ')}`);
    return fallbackEntry;
  }

  const today = new Date().toISOString().slice(0, 10);
  let normalized = entry.trim().replace(
    new RegExp(`^##\\s+${releaseTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+-\\s+YYYY-MM-DD`, 'm'),
    `## ${releaseTag} - ${today}`,
  );

  if (!normalized.startsWith(`## ${releaseTag} - `)) {
    normalized = `${fallbackEntry.split('\n')[0]}\n\n${normalized}`;
  }

  return `${normalized.trim()}\n`;
}

function updateChangelog(changelogPath, entry) {
  const absolutePath = resolve(repoRoot, changelogPath);
  const existing = existsSync(absolutePath)
    ? readFileSync(absolutePath, 'utf8')
    : '# Changelog\n\nAll notable changes to OpenXTerm are documented here.\n';

  const releaseHeading = entry.match(/^##\s+(.+?)\s+-/m)?.[1];
  const withoutDuplicate = existing.replace(
    new RegExp(`\\n?##\\s+${releaseHeading?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') ?? 'NEVER_MATCH'}\\s+-[\\s\\S]*?(?=\\n##\\s+|\\s*$)`),
    '',
  ).trimEnd();

  const firstEntryIndex = withoutDuplicate.search(/\n##\s+/);
  const next = firstEntryIndex === -1
    ? `${withoutDuplicate}\n\n${entry}`
    : `${withoutDuplicate.slice(0, firstEntryIndex).trimEnd()}\n\n${entry}\n${withoutDuplicate.slice(firstEntryIndex).trimStart()}`;

  writeFileSync(absolutePath, `${next.trimEnd()}\n`);
}

const args = parseArgs(process.argv.slice(2));
const inputPath = required(args, 'input');
const outputPath = required(args, 'output');
const releaseTag = required(args, 'release-tag');
const previousTag = args.get('previous-tag')?.trim() ?? '';
const changelogPath = args.get('changelog-path')?.trim();

const generatedNotes = readText(inputPath);
const fallbackEntry = formatFallbackEntry({ releaseTag, previousTag, generatedNotes });
const geminiEntry = await generateWithGemini({ releaseTag, previousTag, generatedNotes });
const entry = geminiEntry
  ? normalizeGeneratedEntry({ releaseTag, entry: geminiEntry, fallbackEntry, generatedNotes })
  : fallbackEntry;

writeText(outputPath, entry);

if (changelogPath) {
  updateChangelog(changelogPath, entry);
}

console.log(geminiEntry ? 'Generated changelog with Gemini.' : 'Generated fallback changelog from collected release source.');
