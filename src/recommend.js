// 추천 엔진. (스팀 추천기 recommend.js 의 영화/시리즈판)
// 핵심 원칙:
//  - 취향(시청기록)은 항상 베이스 -> 선택을 바꿔도 연속적인 '스펙트럼'으로 이어짐
//  - 제약(질문 선택)이 적을수록 다양성을 키워 '넓게', 많을수록 '좁고 집중'
//  - exclude 누적으로 새로고침마다 새로운 유사 작품 (무한 추천)
//  - 영화/시리즈·언어·시대·길이 필터

import { koLabel, langKo } from "./genres.js";
import { buildMoodWeights, MATURITY_RANK, MATURITY_CAP, maturityKo } from "./questions.js";

export function buildTasteProfile(watched) {
  const raw = new Map();
  const topItem = new Map();
  let totalCount = 0;
  for (const g of watched) {
    const w = g.weight || 1;
    totalCount += g.count || 1;
    for (const t of g.tags || []) {
      raw.set(t, (raw.get(t) || 0) + w);
      const cur = topItem.get(t);
      if (!cur || w > cur.w) topItem.set(t, { title: g.title, count: g.count || 1, w });
    }
  }
  const max = Math.max(1, ...raw.values());
  const tagWeight = new Map([...raw].map(([t, v]) => [t, v / max]));
  const topTags = [...raw.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([t]) => ({ tag: t, ko: koLabel(t), title: topItem.get(t)?.title, count: topItem.get(t)?.count || 0 }));
  return { tagWeight, topItem, topTags, totalCount, itemCount: watched.length };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const jaccard = (a, b) => {
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const uni = A.size + B.size - inter;
  return uni ? inter / uni : 0;
};
const minmax = (arr) => {
  if (!arr.length) return arr;
  const mn = Math.min(...arr), mx = Math.max(...arr), d = mx - mn || 1;
  return arr.map((v) => (v - mn) / d);
};
const uniq = (arr) => [...new Set(arr)]; // 같은 한글 라벨로 합쳐지는 태그 중복 제거

export function recommend({ watched = [], answers = {}, catalog = [], count = 12, exclude = [], variety = 0.05 }) {
  const profile = buildTasteProfile(watched);
  const libW = profile.tagWeight;

  const moodRawW = buildMoodWeights(answers);
  const moodMax = Math.max(1, ...moodRawW.values());
  const moodW = new Map([...moodRawW].map(([t, v]) => [t, v / moodMax]));
  const hasMood = moodW.size > 0;
  const moodSel = Array.isArray(answers.mood) ? answers.mood : answers.mood ? [answers.mood] : [];

  // 취향/기분/탐색 비중 (취향을 항상 크게 -> 선택 간 연속성)
  let wLib, wMood, wExplore;
  switch (answers.novelty) {
    case "familiar": [wLib, wMood, wExplore] = [0.65, 0.35, 0.0]; break;
    case "new": [wLib, wMood, wExplore] = [0.35, 0.45, 0.20]; break;
    default: [wLib, wMood, wExplore] = [0.5, 0.5, 0.0];
  }
  const hasTaste = libW.size > 0;
  if (!hasTaste) { wLib = 0; wMood = hasMood ? 0.8 : 0; wExplore = Math.max(wExplore, 0.2); } // 시청기록 없음
  if (!hasMood) { // 기분 미선택 = "아무거나" -> 취향 베이스 + 탐색으로 넓게
    wMood = 0;
    wLib = hasTaste ? (answers.novelty === "new" ? 0.5 : 0.7) : 0;
    if (answers.novelty !== "familiar") wExplore = Math.max(wExplore, 0.15);
  }

  // 제약이 적을수록 다양성(breadth)을 키운다
  const typeSet = answers.type && answers.type !== "any";
  const lenSet = answers.length && answers.length !== "any";
  const eraSet = answers.era && answers.era !== "any";
  const langSet = answers.language && answers.language !== "any";
  const companySet = answers.company && answers.company !== "any";
  const matSet = answers.maturity && answers.maturity !== "any";
  // 관람등급 상한: 명시 선택 또는 '가족과 함께'(자동 12세 이하)
  let cap = matSet ? MATURITY_CAP[answers.maturity] : 3;
  if (answers.company === "family") cap = Math.min(cap, 1);
  let constraints = Math.min(2, moodSel.length);
  if (typeSet) constraints++;
  if (lenSet) constraints++;
  if (eraSet) constraints++;
  if (langSet) constraints++;
  if (companySet) constraints++;
  if (cap < 3) constraints++;
  if (answers.novelty === "familiar") constraints++;
  const breadth = clamp(1 - constraints * 0.16, 0.3, 1);
  const LAMBDA = 0.4 + 0.5 * breadth; // 집중 ~0.55 .. 넓게 ~0.9

  const comfort = new Set(profile.topTags.slice(0, 6).map((t) => t.tag));
  const exSet = new Set(exclude); // "type:id" 문자열
  const lang = langSet ? answers.language : null;

  // 시드('이 작품과 비슷한') — 설정 시 최우선 기준. 태그를 순위 가중으로.
  const seedKey = answers.seed || null; // "type:id"
  const seedItem = seedKey ? catalog.find((g) => `${g.type}:${g.id}` === seedKey) : null;
  const seedTags = seedItem ? [...(seedItem.genres || []), ...(seedItem.keywords || [])] : [];
  const seedW = new Map();
  if (seedTags.length) { const n = seedTags.length; seedTags.forEach((t, i) => seedW.set(t, (n - i) / n)); }

  const watchedKeys = new Set(watched.map((w) => `${w.type}:${w.id}`));

  // 1차: 후보 산출 + 하드 필터(시청완료/제외/영화·시리즈)
  const cands = [];
  for (const g of catalog) {
    const tags = [...(g.genres || []), ...(g.keywords || [])];
    if (!tags.length) continue;
    const dkey = `${g.type}:${g.id}`;
    if (watchedKeys.has(dkey) || exSet.has(dkey)) continue;
    if (seedKey && dkey === seedKey) continue;
    if (typeSet && g.type !== answers.type) continue; // 영화/시리즈 하드 필터
    if (cap < 3 && (MATURITY_RANK[g.maturity] ?? 2) > cap) continue; // 관람등급 하드 필터
    let affinity = 0, mood = 0, seedSim = 0;
    for (const t of tags) { affinity += libW.get(t) || 0; mood += moodW.get(t) || 0; if (seedW.size) seedSim += seedW.get(t) || 0; }
    const unfamiliar = tags.filter((t) => !comfort.has(t)).length / tags.length;
    cands.push({ g, tags, affinity, mood, explore: unfamiliar, seedSim });
  }
  if (cands.length === 0) return { profile, recommendations: [] };

  const affN = minmax(cands.map((c) => c.affinity));
  const moodN = minmax(cands.map((c) => c.mood));
  const popN = minmax(cands.map((c) => Math.log10((c.g.popularity || 0) + (c.g.voteCount || 0) + 10)));
  const seedN = seedItem ? minmax(cands.map((c) => c.seedSim)) : null;
  const wLibEff = wLib * (1 - 0.45 * breadth);
  const wExpEff = wExplore + 0.30 * breadth;
  const wPopEff = 0.08 + 0.22 * breadth;
  cands.forEach((c, i) => {
    let s;
    if (seedItem) {
      s = 0.65 * seedN[i] + 0.15 * affN[i] + 0.10 * moodN[i] + 0.10 * popN[i] + Math.random() * variety;
    } else {
      s = wLibEff * affN[i] + wMood * moodN[i] + wExpEff * c.explore + wPopEff * popN[i] + Math.random() * variety;
    }
    s *= lengthMult(answers.length, c.g);
    s *= eraMult(answers.era, c.g.year);
    s *= langMult(lang, c.g.lang);
    s *= companyMult(answers.company, c.g.genres);
    c.score = s;
  });

  // 2차: 다양성(MMR). 시드가 있으면 낮춰 시드 근처 유지. 풀을 크게 둬 무한 새로고침 대응.
  const lam = seedItem ? 0.42 : LAMBDA;
  const pool = cands.filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 300);
  const picked = [];
  while (picked.length < count && pool.length) {
    let bi = 0, bv = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const sim = picked.length ? Math.max(...picked.map((p) => jaccard(pool[i].tags, p.tags))) : 0;
      const adj = pool[i].score * (1 - lam * sim);
      if (adj > bv) { bv = adj; bi = i; }
    }
    picked.push(pool.splice(bi, 1)[0]);
  }

  return { profile, recommendations: picked.map((c) => buildRec(c, { libW, moodW, profile, answers, seedItem, seedW })) };
}

function lengthMult(target, g) {
  if (!target || target === "any") return 1;
  const isTv = g.type === "tv";
  const rt = g.runtime || (isTv ? 45 : 110);
  switch (target) {
    case "short":    return isTv ? 0.5 : (rt <= 105 ? 1.3 : rt <= 150 ? 0.9 : 0.6);
    case "standard": return isTv ? 0.7 : (rt >= 95 && rt <= 160 ? 1.3 : rt < 95 ? 0.9 : 0.8);
    case "binge":    return isTv ? 1.4 : (rt > 140 ? 1.0 : 0.7);
    default: return 1;
  }
}
function eraBucket(year) {
  if (!year) return null;
  if (year >= 2022) return "latest";
  if (year >= 2010) return "2010s";
  return "classic";
}
function eraMult(target, year) {
  if (!target || target === "any") return 1;
  if (!year) return 0.85;
  return eraBucket(year) === target ? 1.3 : 0.6;
}
function langMult(target, lang) {
  if (!target) return 1;
  if (target === "nonen") return lang && lang !== "en" ? 1.2 : 0.4;
  if (!lang) return 0.8;
  return lang === target ? 1.2 : 0.3;
}
function companyMult(company, genres = []) {
  if (!company || company === "any") return 1;
  const has = (g) => genres.includes(g);
  switch (company) {
    case "family": { // 가볍고 밝은 쪽 우대, 무거운 장르 감점 (등급은 별도 하드필터)
      let m = 1;
      if (has("family") || has("animation")) m *= 1.5;
      if (has("comedy") || has("adventure")) m *= 1.15;
      if (has("horror")) m *= 0.5;
      if (has("thriller") || has("crime")) m *= 0.8;
      return m;
    }
    case "partner": { // 연인과 — 로맨스/드라마 우대
      let m = 1;
      if (has("romance")) m *= 1.5;
      if (has("comedy") || has("drama")) m *= 1.1;
      if (has("documentary")) m *= 0.85;
      return m;
    }
    default: return 1; // solo
  }
}

function buildRec(c, { libW, moodW, profile, answers, seedItem, seedW }) {
  const g = c.g;
  const matched = c.tags
    .map((t) => ({ t, lib: libW.get(t) || 0, mood: moodW.get(t) || 0 }))
    .filter((x) => x.lib > 0 || x.mood > 0)
    .sort((a, b) => (b.lib + b.mood) - (a.lib + a.mood));
  const libSum = matched.reduce((s, x) => s + x.lib, 0);
  const moodSum = matched.reduce((s, x) => s + x.mood, 0);

  const reasons = [];
  if (seedItem && seedW) {
    const shared = uniq(c.tags.filter((t) => seedW.has(t)).map(koLabel)).slice(0, 2);
    reasons.push(shared.length ? `'${seedItem.title}'와(과) 비슷한 ${shared.join("·")} 작품이에요.` : `'${seedItem.title}'와(과) 결이 비슷해요.`);
  }
  const isExplore = answers.novelty === "new" && c.affinity === 0 && c.mood > 0;
  if (isExplore) reasons.push("평소 시청 목록과 다른 새로운 결이에요.");
  if (moodSum >= libSum && moodSum > 0) {
    const moodTags = uniq(matched.filter((x) => x.mood > 0).map((x) => koLabel(x.t))).slice(0, 2);
    if (moodTags.length) reasons.push(`오늘 고른 분위기(${moodTags.join("·")})에 어울려요.`);
  }
  if (libSum > 0 && !isExplore) {
    const top = matched.find((x) => x.lib > 0);
    const ref = top && profile.topItem.get(top.t);
    const tagsKo = uniq(matched.filter((x) => x.lib > 0).map((x) => koLabel(x.t))).slice(0, 2);
    if (ref && ref.title) reasons.push(`'${ref.title}' 등 ${tagsKo.join("·")} 취향과 잘 맞아요.`);
    else if (tagsKo.length) reasons.push(`즐겨 본 ${tagsKo.join("·")} 성향이에요.`);
  }
  if (answers.company === "family" && (g.genres?.includes("family") || g.genres?.includes("animation"))) reasons.push("온 가족이 함께 보기 좋아요.");
  else if (answers.company === "partner" && g.genres?.includes("romance")) reasons.push("연인과 보기 좋은 로맨스예요.");
  if (reasons.length === 0) reasons.push("많은 사람이 보는 화제작이에요.");

  const allTags = [...(g.genres || []), ...(g.keywords || [])];
  return {
    id: g.id,
    type: g.type,
    title: g.title,
    year: g.year,
    lang: g.lang,
    langKo: langKo(g.lang),
    maturity: g.maturity || null,
    maturityKo: g.maturity ? maturityKo(g.maturity) : "",
    runtime: g.runtime || null,
    poster_path: g.poster_path || null,
    overview: g.overview || "",
    matchTags: uniq(matched.map((x) => koLabel(x.t))).slice(0, 5),
    tags: uniq(allTags.map(koLabel)).slice(0, 6),
    reasons: reasons.slice(0, 2),
    netflix: `https://www.netflix.com/search?q=${encodeURIComponent(g.title)}`,
    tmdb: `https://www.themoviedb.org/${g.type}/${g.id}`,
  };
}
