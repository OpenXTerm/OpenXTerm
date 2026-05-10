import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
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

function runGit(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function getCommitShas({ previousTag, target }) {
  const range = previousTag ? `${previousTag}..${target}` : target;
  const output = runGit(['rev-list', '--reverse', range]);
  return output ? output.split('\n').filter(Boolean) : [];
}

function getCommitMeta(sha) {
  const record = runGit(['log', '-1', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%ae', sha]);
  const [fullSha, shortSha, subject, authorName, authorEmail] = record.split('\x1f');
  return {
    fullSha,
    shortSha,
    subject,
    authorName,
    authorEmail,
  };
}

async function githubJson(path) {
  const repository = process.env.GITHUB_REPOSITORY?.trim();
  const token = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  if (!repository || !token) {
    return null;
  }

  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    console.warn(`GitHub API ${path} failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
    return null;
  }

  return response.json();
}

async function getCompareAuthorLogins({ previousTag, target }) {
  if (!previousTag) {
    return new Map();
  }

  const compare = await githubJson(`/compare/${encodeURIComponent(previousTag)}...${encodeURIComponent(target)}`);
  const commits = Array.isArray(compare?.commits) ? compare.commits : [];
  return new Map(
    commits
      .filter((commit) => commit.sha && commit.author?.login)
      .map((commit) => [commit.sha, commit.author.login]),
  );
}

async function getCommitPulls(sha) {
  const pulls = await githubJson(`/commits/${sha}/pulls`);
  return Array.isArray(pulls) ? pulls : [];
}

function formatAuthor(meta, login) {
  if (login) {
    return `@${login}`;
  }

  if (meta.authorName && meta.authorEmail) {
    return `${meta.authorName} <${meta.authorEmail}>`;
  }

  return meta.authorName || 'unknown author';
}

function isReleaseCommit(subject, releaseTag) {
  return subject === `Release ${releaseTag}` || /^Release v[0-9]+\.[0-9]+\.[0-9]+/.test(subject);
}

async function collectRangeEntries({ previousTag, target, releaseTag }) {
  const shas = getCommitShas({ previousTag, target });
  const compareAuthorLogins = await getCompareAuthorLogins({ previousTag, target });
  const pullsByNumber = new Map();
  const directCommits = [];

  for (const sha of shas) {
    const meta = getCommitMeta(sha);
    if (isReleaseCommit(meta.subject, releaseTag)) {
      continue;
    }

    const pulls = await getCommitPulls(sha);
    if (pulls.length > 0) {
      for (const pull of pulls) {
        if (!pull.number || pullsByNumber.has(pull.number)) {
          continue;
        }

        pullsByNumber.set(pull.number, {
          number: pull.number,
          title: pull.title,
          url: pull.html_url,
          author: pull.user?.login ? `@${pull.user.login}` : 'unknown contributor',
        });
      }
      continue;
    }

    directCommits.push({
      shortSha: meta.shortSha,
      subject: meta.subject,
      author: formatAuthor(meta, compareAuthorLogins.get(meta.fullSha)),
    });
  }

  return {
    pulls: [...pullsByNumber.values()].sort((a, b) => a.number - b.number),
    directCommits,
  };
}

function formatInput({ githubNotes, previousTag, releaseTag, target, pulls, directCommits }) {
  const lines = [
    '# Release Changelog Source',
    '',
    `Release tag: ${releaseTag}`,
    previousTag ? `Previous tag: ${previousTag}` : 'Previous tag: none',
    `Target commitish: ${target}`,
    '',
    '## GitHub Generated Release Notes',
    '',
    githubNotes.trim() || '_GitHub generated release notes were empty._',
    '',
    '## Pull Requests In Range',
    '',
  ];

  if (pulls.length > 0) {
    for (const pull of pulls) {
      lines.push(`- #${pull.number}: ${pull.title} by ${pull.author} (${pull.url})`);
    }
  } else {
    lines.push('_No pull requests were associated with commits in this range._');
  }

  lines.push('', '## Direct Commits In Range', '');

  if (directCommits.length > 0) {
    for (const commit of directCommits) {
      lines.push(`- ${commit.shortSha}: ${commit.subject} by ${commit.author}`);
    }
  } else {
    lines.push('_No direct commits without associated pull requests were found._');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

const args = parseArgs(process.argv.slice(2));
const githubNotesPath = required(args, 'github-notes');
const outputPath = required(args, 'output');
const releaseTag = required(args, 'release-tag');
const target = required(args, 'target');
const previousTag = args.get('previous-tag')?.trim() ?? '';

const githubNotes = readText(githubNotesPath);
const { pulls, directCommits } = await collectRangeEntries({ previousTag, target, releaseTag });
const input = formatInput({ githubNotes, previousTag, releaseTag, target, pulls, directCommits });

writeText(outputPath, input);

console.log(`Collected changelog source: ${pulls.length} PR(s), ${directCommits.length} direct commit(s).`);
