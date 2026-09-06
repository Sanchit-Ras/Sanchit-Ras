#!/usr/bin/env node
/**
 * Renders the stat cards embedded in README.md.
 *
 * These used to be fetched at page-load time from third-party Vercel apps
 * (github-readme-stats, github-profile-trophy, github-readme-activity-graph).
 * All three went down — 503 DEPLOYMENT_PAUSED / 402 Payment required — taking
 * four images on the profile with them.
 *
 * So we render them here instead: a scheduled workflow runs this script with the
 * GITHUB_TOKEN that Actions provides for free, writes the SVGs to dist/, and
 * publishes them to the `output` branch. The README points at raw.githubusercontent
 * files in this repo. Same mechanism the contribution snake already uses — nothing
 * to pay for, nothing that can be paused.
 *
 * Usage:  GITHUB_TOKEN=... node .github/scripts/generate-cards.mjs
 *         MOCK=1 node .github/scripts/generate-cards.mjs   # render from fixtures
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const USER = process.env.PROFILE_USER || "Sanchit-Ras";
const OUT_DIR = process.env.OUT_DIR || "dist";
const TOKEN = process.env.GITHUB_TOKEN;
const MOCK = process.env.MOCK === "1";

/** Tokyo Night — matches the badge and typing-SVG palette already in the README. */
const T = {
  bg: "#0D1117",
  panel: "#161B22",
  border: "#21262D",
  title: "#7AA2F7",
  label: "#A9B1D6",
  value: "#C0CAF5",
  muted: "#565F89",
  track: "#1F2335",
  blue: "#7AA2F7",
  purple: "#BB9AF7",
  green: "#9ECE6A",
  orange: "#E0AF68",
  red: "#F7768E",
};

const FONT = "'Segoe UI', Ubuntu, 'Helvetica Neue', Sans-Serif";

// ---------------------------------------------------------------- helpers

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const comma = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const round = (n, p = 1) => Number(n.toFixed(p));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Approximate text width — enough to right-align numerals without a font engine. */
const textWidth = (s, size) => String(s).length * size * 0.55;

// ---------------------------------------------------------------- github api

async function gql(query, variables, attempt = 1) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": `${USER}-profile-cards`,
    },
    body: JSON.stringify({ query, variables }),
  });

  // Secondary rate limits and 5xx are worth a couple of backed-off retries;
  // a 401/404 never is.
  if ((res.status >= 500 || res.status === 403 || res.status === 429) && attempt < 4) {
    const wait = 2 ** attempt * 1000;
    console.warn(`  GraphQL ${res.status}, retrying in ${wait}ms (attempt ${attempt})`);
    await new Promise((r) => setTimeout(r, wait));
    return gql(query, variables, attempt + 1);
  }
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);

  const body = await res.json();
  if (body.errors) throw new Error(`GraphQL: ${JSON.stringify(body.errors).slice(0, 400)}`);
  return body.data;
}

const PROFILE_QUERY = `
query($login: String!, $after: String) {
  user(login: $login) {
    name
    login
    createdAt
    followers { totalCount }
    pullRequests { totalCount }
    issues { totalCount }
    repositoriesContributedTo(contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]) { totalCount }
    repositories(first: 100, after: $after, ownerAffiliations: OWNER, isFork: false, orderBy: {field: STARGAZERS, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        stargazerCount
        languages(first: 12, orderBy: {field: SIZE, direction: DESC}) {
          edges { size node { name color } }
        }
      }
    }
  }
}`;

const CONTRIB_QUERY = `
query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      totalPullRequestReviewContributions
      restrictedContributionsCount
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

/** contributionsCollection accepts at most a one-year window, so walk it in slices. */
function yearWindows(createdAt, now) {
  const windows = [];
  let from = new Date(createdAt);
  while (from < now) {
    const next = new Date(from.getTime());
    next.setUTCFullYear(next.getUTCFullYear() + 1);
    const to = next > now ? now : next;
    windows.push([from.toISOString(), to.toISOString()]);
    from = to;
  }
  return windows;
}

async function collect() {
  console.log(`Collecting public profile data for ${USER}…`);

  const repos = [];
  let user = null;
  let after = null;
  do {
    const data = await gql(PROFILE_QUERY, { login: USER, after });
    user = data.user;
    if (!user) throw new Error(`No such user: ${USER}`);
    repos.push(...user.repositories.nodes);
    after = user.repositories.pageInfo.hasNextPage ? user.repositories.pageInfo.endCursor : null;
  } while (after);

  const now = new Date();
  const windows = yearWindows(user.createdAt, now);

  let commits = 0;
  let reviews = 0;
  for (const [from, to] of windows) {
    const { user: u } = await gql(CONTRIB_QUERY, { login: USER, from, to });
    const c = u.contributionsCollection;
    commits += c.totalCommitContributions + c.restrictedContributionsCount;
    reviews += c.totalPullRequestReviewContributions;
  }

  // Trailing 365 days, for the activity chart.
  const yearAgo = new Date(now.getTime());
  yearAgo.setUTCFullYear(yearAgo.getUTCFullYear() - 1);
  const { user: recent } = await gql(CONTRIB_QUERY, {
    login: USER,
    from: yearAgo.toISOString(),
    to: now.toISOString(),
  });
  const calendar = recent.contributionsCollection.contributionCalendar;
  const days = calendar.weeks.flatMap((w) => w.contributionDays);

  const languages = new Map();
  let stars = 0;
  for (const repo of repos) {
    stars += repo.stargazerCount;
    for (const { size, node } of repo.languages.edges) {
      if (!node?.name) continue;
      const prev = languages.get(node.name) || { size: 0, color: node.color || T.muted };
      prev.size += size;
      languages.set(node.name, prev);
    }
  }

  return {
    name: user.name || user.login,
    login: user.login,
    createdAt: user.createdAt,
    stars,
    commits,
    reviews,
    prs: user.pullRequests.totalCount,
    issues: user.issues.totalCount,
    contributedTo: user.repositoriesContributedTo.totalCount,
    followers: user.followers.totalCount,
    repoCount: user.repositories.totalCount,
    lastYearContributions: calendar.totalContributions,
    days,
    languages: [...languages.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.size - a.size),
    generatedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------- rank

/**
 * Percentile + letter grade, using the same weighted-CDF model as
 * github-readme-stats so the badge keeps meaning what it used to mean.
 */
function calculateRank({ commits, prs, issues, reviews, stars, followers }) {
  const WEIGHTS = { commits: 2, prs: 3, issues: 1, reviews: 1, stars: 4, followers: 1 };
  const MEDIANS = { commits: 1000, prs: 50, issues: 25, reviews: 2, stars: 50, followers: 10 };
  const TOTAL = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

  const expCdf = (x) => 1 - 2 ** -x;
  const logNormalCdf = (x) => x / (1 + x);

  const score =
    1 -
    (WEIGHTS.commits * expCdf(commits / MEDIANS.commits) +
      WEIGHTS.prs * expCdf(prs / MEDIANS.prs) +
      WEIGHTS.issues * expCdf(issues / MEDIANS.issues) +
      WEIGHTS.reviews * expCdf(reviews / MEDIANS.reviews) +
      WEIGHTS.stars * logNormalCdf(stars / MEDIANS.stars) +
      WEIGHTS.followers * logNormalCdf(followers / MEDIANS.followers)) /
      TOTAL;

  const THRESHOLDS = [1, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100];
  const LEVELS = ["S", "A+", "A", "A-", "B+", "B", "B-", "C+", "C"];
  const percentile = score * 100;
  return { level: LEVELS[THRESHOLDS.findIndex((t) => percentile <= t)], percentile };
}

// ---------------------------------------------------------------- icons

const ICONS = {
  star: "M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z",
  commit:
    "M10.5 7.75a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zm1.43.75a4.002 4.002 0 01-7.86 0H.75a.75.75 0 110-1.5h3.32a4.001 4.001 0 017.86 0h3.32a.75.75 0 110 1.5h-3.32z",
  pr: "M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z",
  issue:
    "M8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0z",
  fork: "M5 3.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm0 2.122a2.25 2.25 0 10-1.5 0v.878A2.25 2.25 0 005.75 8.5h1.5v2.128a2.251 2.251 0 101.5 0V8.5h1.5a2.25 2.25 0 002.25-2.25v-.878a2.25 2.25 0 10-1.5 0v.878a.75.75 0 01-.75.75h-4.5A.75.75 0 015 6.25v-.878zm3.75 7.378a.75.75 0 11-1.5 0 .75.75 0 011.5 0zm3-8.75a.75.75 0 100-1.5.75.75 0 000 1.5z",
  people:
    "M5.5 3.5a2 2 0 100 4 2 2 0 000-4zM2 5.5a3.5 3.5 0 115.898 2.549 5.507 5.507 0 013.034 4.084.75.75 0 11-1.482.235 4.001 4.001 0 00-7.9 0 .75.75 0 01-1.482-.236A5.507 5.507 0 013.102 8.05 3.49 3.49 0 012 5.5zM11 4a.75.75 0 100 1.5 1.5 1.5 0 01.666 2.844.75.75 0 00-.416.672v.352a.75.75 0 00.574.73c1.2.289 2.162 1.2 2.522 2.372a.75.75 0 101.434-.44 5.01 5.01 0 00-2.56-3.012A3 3 0 0011 4z",
  repo: "M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8z",
  clock:
    "M8 0a8 8 0 100 16A8 8 0 008 0zM1.5 8a6.5 6.5 0 1113 0 6.5 6.5 0 01-13 0zM8 3.25a.75.75 0 01.75.75v3.25H11a.75.75 0 010 1.5H8a.75.75 0 01-.75-.75V4A.75.75 0 018 3.25z",
};

/**
 * Shared <style>.
 *
 * The fade deliberately does NOT set `opacity: 0` as the resting state and rely
 * on `animation-fill-mode: forwards` to undo it. Anything that renders this SVG
 * without running CSS animations would then draw an empty card — which is the
 * same failure that made the contribution snake look broken. Default opacity
 * stays 1, and the keyframe only fades *in* from 0, so a renderer that ignores
 * the animation still shows a complete card.
 */
const baseStyle = () => `
    .t { font: 600 18px ${FONT}; fill: ${T.title} }
    .l { font: 400 14px ${FONT}; fill: ${T.label} }
    .v { font: 600 14px ${FONT}; fill: ${T.value} }
    .m { font: 400 11px ${FONT}; fill: ${T.muted} }
    .fade { animation: fade .6s ease-in-out }
    @keyframes fade { from { opacity: 0 } to { opacity: 1 } }`;

const shell = (w, h, body, extraStyle = "", label = "") =>
  `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(label)}">
  <title>${esc(label)}</title>
  <style>${baseStyle()}${extraStyle}
  </style>
  <rect x="0.5" y="0.5" rx="8" width="${w - 1}" height="${h - 1}" fill="${T.bg}" stroke="${T.border}"/>
${body}
</svg>
`;

// ---------------------------------------------------------------- stats card

function renderStats(d) {
  const W = 495;
  const H = 195;
  const rank = calculateRank(d);

  const rows = [
    ["star", "Total Stars Earned", d.stars],
    ["commit", "Total Commits", d.commits],
    ["pr", "Total PRs", d.prs],
    ["issue", "Total Issues", d.issues],
    ["fork", "Contributed to (last year)", d.contributedTo],
  ];

  const body = rows
    .map(([icon, label, value], i) => {
      const y = 68 + i * 24;
      return `  <g class="fade" transform="translate(25 ${y})">
    <svg x="0" y="-11" width="15" height="15" viewBox="0 0 16 16" fill="${T.blue}"><path d="${ICONS[icon]}"/></svg>
    <text class="l" x="25" y="0">${esc(label)}</text>
    <text class="v" x="300" y="0" text-anchor="end">${comma(value)}</text>
  </g>`;
    })
    .join("\n");

  // Percentile is "top N%", so a smaller number should fill more of the ring.
  const R = 38;
  const CIRC = 2 * Math.PI * R;
  const filled = clamp((100 - rank.percentile) / 100, 0, 1);

  const ring = `  <g class="fade" transform="translate(408 105)">
    <circle r="${R}" fill="none" stroke="${T.track}" stroke-width="6"/>
    <circle r="${R}" fill="none" stroke="${T.blue}" stroke-width="6" stroke-linecap="round"
      stroke-dasharray="${round(CIRC, 2)}" stroke-dashoffset="${round(CIRC * (1 - filled), 2)}"
      transform="rotate(-90)"/>
    <text x="0" y="2" text-anchor="middle" style="font: 700 24px ${FONT}; fill: ${T.value}">${rank.level}</text>
    <text x="0" y="19" text-anchor="middle" class="m">top ${round(rank.percentile)}%</text>
  </g>`;

  const header = `  <text class="t fade" x="25" y="35">${esc(d.name)}&apos;s GitHub Stats</text>`;

  return shell(W, H, [header, body, ring].join("\n"), "", `${d.name} GitHub stats`);
}

// ---------------------------------------------------------------- languages card

function renderLanguages(d, count = 8) {
  const W = 360;
  const H = 195;
  const top = d.languages.slice(0, count);
  const total = top.reduce((a, l) => a + l.size, 0) || 1;
  const withPct = top.map((l) => ({ ...l, pct: (l.size / total) * 100 }));

  const BAR_X = 25;
  const BAR_W = W - 50;
  const BAR_Y = 55;

  let cursor = 0;
  const segments = withPct
    .map((l) => {
      const w = (l.pct / 100) * BAR_W;
      const seg = `      <rect x="${round(cursor, 2)}" y="0" width="${round(Math.max(w, 0), 2)}" height="10" fill="${l.color}"/>`;
      cursor += w;
      return seg;
    })
    .join("\n");

  const bar = `  <g class="fade" transform="translate(${BAR_X} ${BAR_Y})">
    <mask id="barmask"><rect x="0" y="0" width="${BAR_W}" height="10" rx="5" fill="#fff"/></mask>
    <g mask="url(#barmask)">
      <rect x="0" y="0" width="${BAR_W}" height="10" fill="${T.track}"/>
${segments}
    </g>
  </g>`;

  const COL_X = [25, 195];
  const legend = withPct
    .map((l, i) => {
      const x = COL_X[i % 2];
      const y = 95 + Math.floor(i / 2) * 25;
      return `  <g class="fade" transform="translate(${x} ${y})">
    <circle cx="5" cy="-4" r="5" fill="${l.color}"/>
    <text class="l" x="18" y="0">${esc(l.name)}</text>
    <text class="m" x="140" y="0" text-anchor="end">${round(l.pct, 2)}%</text>
  </g>`;
    })
    .join("\n");

  const header = `  <text class="t fade" x="25" y="35">Most Used Languages</text>`;
  const empty = withPct.length
    ? ""
    : `  <text class="l fade d1" x="25" y="100">No public language data yet</text>`;

  return shell(W, H, [header, bar, legend, empty].join("\n"), "", "Most used languages");
}

// ---------------------------------------------------------------- activity card

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function renderActivity(d) {
  const W = 880;
  const H = 260;
  const X0 = 46;
  const X1 = W - 24;
  const Y0 = 78;
  const Y1 = 208;

  const days = d.days.length ? d.days : [{ date: d.generatedAt.slice(0, 10), contributionCount: 0 }];
  const peak = Math.max(1, ...days.map((p) => p.contributionCount));
  const span = Math.max(1, days.length - 1);

  const xAt = (i) => X0 + (i / span) * (X1 - X0);
  const yAt = (v) => Y1 - (v / peak) * (Y1 - Y0);

  const points = days.map((p, i) => `${round(xAt(i), 2)},${round(yAt(p.contributionCount), 2)}`);
  const line = `M${points.join(" L")}`;
  const area = `${line} L${round(X1, 2)},${Y1} L${round(X0, 2)},${Y1} Z`;

  // Four gridlines, labelled with the contribution count they represent.
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((f) => {
      const y = round(Y1 - f * (Y1 - Y0), 2);
      const value = Math.round(peak * f);
      return `    <line x1="${X0}" y1="${y}" x2="${X1}" y2="${y}" stroke="${T.track}" stroke-width="1"/>
    <text class="m" x="${X0 - 10}" y="${y + 4}" text-anchor="end">${value}</text>`;
    })
    .join("\n");

  // One label per month, anchored at the first day of that month.
  let lastMonth = -1;
  const monthLabels = days
    .map((p, i) => {
      const month = new Date(`${p.date}T00:00:00Z`).getUTCMonth();
      if (month === lastMonth) return null;
      lastMonth = month;
      const x = xAt(i);
      if (x < X0 + 12 || x > X1 - 12) return null;
      return `    <text class="m" x="${round(x, 2)}" y="${Y1 + 22}" text-anchor="middle">${MONTHS[month]}</text>`;
    })
    .filter(Boolean)
    .join("\n");

  const body = `  <text class="t fade" x="25" y="35">Contribution Activity</text>
  <text class="m fade" x="${W - 25}" y="35" text-anchor="end">${comma(d.lastYearContributions)} contributions in the last year</text>
  <g class="fade">
${grid}
  </g>
  <defs>
    <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${T.blue}" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="${T.blue}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <g class="fade">
    <path d="${area}" fill="url(#areaFill)"/>
    <path d="${line}" fill="none" stroke="${T.blue}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>
  </g>
  <g class="fade">
${monthLabels}
  </g>`;

  return shell(W, H, body, "", "Contribution activity over the last year");
}

// ---------------------------------------------------------------- trophies card

const TROPHY_TIERS = [
  ["SSS", T.purple],
  ["SS", T.purple],
  ["S", T.purple],
  ["AAA", T.blue],
  ["AA", T.blue],
  ["A", T.blue],
  ["B", T.green],
  ["C", T.orange],
];

/** Thresholds mirror github-profile-trophy so the grades stay comparable. */
const TROPHIES = [
  { title: "Commits", icon: "commit", key: "commits", steps: [4000, 2000, 1000, 500, 200, 100, 20, 0] },
  { title: "Stars", icon: "star", key: "stars", steps: [2000, 700, 200, 100, 50, 30, 10, 0] },
  { title: "Followers", icon: "people", key: "followers", steps: [1000, 400, 200, 100, 50, 20, 10, 0] },
  { title: "Repositories", icon: "repo", key: "repoCount", steps: [100, 80, 50, 30, 20, 10, 5, 0] },
  { title: "Pull Requests", icon: "pr", key: "prs", steps: [1000, 500, 200, 100, 50, 20, 5, 0] },
  { title: "Issues", icon: "issue", key: "issues", steps: [1000, 500, 200, 100, 50, 20, 5, 0] },
  { title: "Experience", icon: "clock", key: "years", steps: [10, 8, 6, 5, 4, 3, 2, 0] },
];

function gradeFor(value, steps) {
  const i = steps.findIndex((s) => value >= s);
  return TROPHY_TIERS[i === -1 ? TROPHY_TIERS.length - 1 : i];
}

function renderTrophies(d) {
  const TILE_W = 110;
  const TILE_H = 122;
  const GAP = 10;
  const PAD = 16;
  const W = PAD * 2 + TROPHIES.length * TILE_W + (TROPHIES.length - 1) * GAP;
  const H = PAD * 2 + TILE_H;

  const years = Math.max(
    0,
    Math.floor((Date.parse(d.generatedAt) - Date.parse(d.createdAt)) / (365.25 * 864e5)),
  );
  const values = { ...d, years };

  const tiles = TROPHIES.map((t, i) => {
    const raw = values[t.key] ?? 0;
    const [grade, color] = gradeFor(raw, t.steps);
    const x = PAD + i * (TILE_W + GAP);
    const shown = t.key === "years" ? `${raw} ${raw === 1 ? "year" : "years"}` : comma(raw);
    return `  <g class="fade" transform="translate(${x} ${PAD})">
    <rect x="0.5" y="0.5" rx="8" width="${TILE_W - 1}" height="${TILE_H - 1}" fill="${T.panel}" stroke="${T.border}"/>
    <svg x="${TILE_W / 2 - 8}" y="14" width="16" height="16" viewBox="0 0 16 16" fill="${color}"><path d="${ICONS[t.icon]}"/></svg>
    <text x="${TILE_W / 2}" y="66" text-anchor="middle" style="font: 700 26px ${FONT}; fill: ${color}">${grade}</text>
    <text class="l" x="${TILE_W / 2}" y="88" text-anchor="middle" style="font: 600 11px ${FONT}">${esc(t.title)}</text>
    <text class="m" x="${TILE_W / 2}" y="105" text-anchor="middle">${shown}</text>
  </g>`;
  }).join("\n");

  return shell(W, H, tiles, "", "GitHub trophies");
}

// ---------------------------------------------------------------- fixtures

/** Lets the renderers be exercised without a token: MOCK=1 node generate-cards.mjs */
function mockData() {
  const now = new Date("2026-09-07T00:00:00Z");
  const days = [];
  for (let i = 364; i >= 0; i--) {
    const day = new Date(now.getTime() - i * 864e5);
    const weekday = day.getUTCDay();
    const seasonal = 6 + 5 * Math.sin(i / 41);
    const count = Math.max(0, Math.round(seasonal * (weekday === 0 || weekday === 6 ? 0.35 : 1)));
    days.push({ date: day.toISOString().slice(0, 10), contributionCount: count });
  }
  return {
    name: "Sanchit Rastogi",
    login: "Sanchit-Ras",
    createdAt: "2022-08-01T00:00:00Z",
    stars: 37,
    commits: 1284,
    reviews: 12,
    prs: 46,
    issues: 18,
    contributedTo: 7,
    followers: 24,
    repoCount: 21,
    lastYearContributions: days.reduce((a, p) => a + p.contributionCount, 0),
    days,
    languages: [
      { name: "Python", color: "#3572A5", size: 480000 },
      { name: "TypeScript", color: "#3178c6", size: 361000 },
      { name: "Java", color: "#b07219", size: 250000 },
      { name: "JavaScript", color: "#f1e05a", size: 165000 },
      { name: "C++", color: "#f34b7d", size: 120000 },
      { name: "HTML", color: "#e34c26", size: 88000 },
      { name: "CSS", color: "#563d7c", size: 54000 },
      { name: "Dockerfile", color: "#384d54", size: 12000 },
    ],
    generatedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------- main

async function main() {
  if (!MOCK && !TOKEN) {
    console.error("GITHUB_TOKEN is not set. Run inside Actions, or use MOCK=1 to render fixtures.");
    process.exit(1);
  }

  const data = MOCK ? mockData() : await collect();

  const cards = {
    "stats.svg": renderStats(data),
    "top-langs.svg": renderLanguages(data),
    "activity.svg": renderActivity(data),
    "trophies.svg": renderTrophies(data),
  };

  await mkdir(OUT_DIR, { recursive: true });
  for (const [name, svg] of Object.entries(cards)) {
    await writeFile(join(OUT_DIR, name), svg, "utf8");
    console.log(`  wrote ${join(OUT_DIR, name)} (${svg.length} bytes)`);
  }

  console.log(
    `Done — ${comma(data.commits)} commits, ${comma(data.stars)} stars, ${comma(data.prs)} PRs, ` +
      `${data.languages.length} languages.`,
  );
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
