import "dotenv/config";
import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getCatalog, getCatalogSize, getById } from "./src/catalog.js";
import { buildWatchedFromCsv, makeWatched } from "./src/history.js";
import { recommend, buildTasteProfile } from "./src/recommend.js";
import { QUESTIONS } from "./src/questions.js";
import { REGION } from "./src/tmdb.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TMDB_API_KEY || "";

app.use(express.json({ limit: "8mb" })); // 시청기록 CSV 텍스트 수용
app.use(express.static(path.join(__dirname, "public")));

// ---- 데모 시청기록 (TMDB 키 없이 체험): 스릴러·SF·범죄·K-드라마 애호가 ----
// [카탈로그 id, 시청 횟수(에피소드/재시청), N개월 전 마지막 시청]
const DEMO_HISTORY = [
  [13, 40, 2], [11, 34, 1], [16, 30, 3], [17, 26, 4], [20, 24, 2],
  [14, 22, 1], [1, 18, 0], [21, 18, 5], [2, 16, 1], [33, 16, 2],
  [39, 7, 1], [46, 1, 2], [47, 1, 3], [54, 1, 1], [55, 1, 6], [58, 1, 2],
];

function buildDemoWatched() {
  const month = 30.44 * 24 * 3600 * 1000;
  const out = [];
  for (const [id, count, monthsAgo] of DEMO_HISTORY) {
    const movie = getById("movie", id);
    const tv = getById("tv", id);
    const item = tv || movie; // 데모 id는 타입 무관 고유
    if (item) out.push(makeWatched(item, count, Date.now() - monthsAgo * month));
  }
  return out;
}

// '빠르게 고르기'로 선택한 작품들("type:id")로 취향을 만든다 (업로드 불필요).
function buildWatchedFromPicks(picks) {
  const out = [];
  for (const k of picks || []) {
    const [type, id] = String(k).split(":");
    const item = getById(type, Number(id));
    if (item) out.push(makeWatched(item, 4, Date.now())); // 고른 작품은 동등하게 '좋아함'으로 가중
  }
  return out;
}

// ---- 세션 캐시 (sessionKey -> watched) ----
const cache = new Map();
const TTL = 30 * 60 * 1000;
const now = () => Date.now();
function putCache(key, watched) { cache.set(key, { watched, ts: now() }); }
function getCache(key) {
  if (!key) return null;
  const v = cache.get(key);
  if (v && now() - v.ts < TTL) return v.watched;
  cache.delete(key);
  return null;
}

const topTagsPayload = (profile) =>
  profile.topTags.map((t) => ({ ko: t.ko, title: t.title, count: t.count }));

const topWatchedPayload = (watched) =>
  [...watched].sort((a, b) => b.weight - a.weight).slice(0, 8).map((w) => ({
    title: w.title, type: w.type, year: w.year, count: w.count, poster_path: w.poster_path,
  }));

app.get("/api/config", (req, res) => {
  res.json({ hasApiKey: !!API_KEY, region: REGION, catalogSize: getCatalogSize(), questions: QUESTIONS });
});

// 카탈로그 이름 검색 ('이 작품과 비슷한' 시드 선택용)
app.get("/api/search", (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (q.length < 1) return res.json({ results: [] });
  const hits = [];
  for (const g of getCatalog()) {
    const name = g.title.toLowerCase();
    const orig = (g.originalTitle || "").toLowerCase();
    if (name.includes(q) || orig.includes(q)) hits.push({ g, starts: name.startsWith(q) || orig.startsWith(q) });
  }
  hits.sort((a, b) => (b.starts - a.starts) || ((b.g.popularity || 0) - (a.g.popularity || 0)));
  res.json({
    results: hits.slice(0, 8).map((h) => ({
      key: `${h.g.type}:${h.g.id}`, title: h.g.title, year: h.g.year, type: h.g.type, poster_path: h.g.poster_path,
    })),
  });
});

// '빠르게 고르기' 그리드용 인기작 (포스터 있는 것 우선, 영화·시리즈 섞어서)
app.get("/api/popular", (req, res) => {
  const n = Math.min(120, Number(req.query.n) || 60);
  const cat = getCatalog().filter((g) => g.poster_path); // 포스터 있는 것만 (없으면 폴백)
  const pool = cat.length >= n ? cat : getCatalog();
  const sorted = [...pool].sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  res.json({
    results: sorted.slice(0, n).map((g) => ({
      key: `${g.type}:${g.id}`, title: g.title, year: g.year, type: g.type, poster_path: g.poster_path,
    })),
  });
});

// 1단계: 시청기록 분석 (데모 또는 CSV 텍스트)
app.post("/api/analyze", async (req, res) => {
  try {
    const { demo, csv, picks } = req.body || {};
    let watched, stats, label, key;
    if (demo) {
      watched = buildDemoWatched();
      stats = { rows: DEMO_HISTORY.reduce((s, h) => s + h[1], 0), titles: watched.length, matched: watched.length, online: 0 };
      label = "데모 시청자 (스릴러·SF·범죄·K-드라마)";
      key = "demo";
    } else if (Array.isArray(picks) && picks.length) {
      watched = buildWatchedFromPicks(picks);
      if (!watched.length) { const e = new Error("고른 작품을 찾지 못했습니다. 다시 선택해 주세요."); e.status = 404; throw e; }
      stats = { rows: watched.length, titles: watched.length, matched: watched.length, online: 0 };
      label = `고른 작품 ${watched.length}개 기반`;
      key = crypto.randomUUID();
    } else if (typeof csv === "string" && csv.trim()) {
      ({ watched, stats } = await buildWatchedFromCsv(csv, API_KEY));
      if (!watched.length) { const e = new Error("시청기록에서 매칭되는 작품을 찾지 못했습니다. (카탈로그를 넓히거나 TMDB 키를 설정해 보세요)"); e.status = 404; throw e; }
      label = "내 넷플릭스 시청기록";
      key = crypto.randomUUID();
    } else {
      const e = new Error("작품을 고르거나, 시청기록 CSV를 올리거나, 데모 모드를 사용하세요."); e.status = 400; throw e;
    }
    putCache(key, watched);
    const profile = buildTasteProfile(watched);
    res.json({
      key, label, stats,
      profile: { topTags: topTagsPayload(profile) },
      top: topWatchedPayload(watched),
      catalogSize: getCatalogSize(),
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "분석 중 오류가 발생했습니다." });
  }
});

// 2단계: 추천 (질문 답변 반영). 캐시된 시청기록 재사용.
app.post("/api/recommend", async (req, res) => {
  try {
    const { key, answers = {}, exclude = [], count = 12, demo, csv, picks } = req.body || {};
    let watched = getCache(key) || (demo ? getCache("demo") : null);
    if (!watched) {
      if (demo) { watched = buildDemoWatched(); putCache("demo", watched); }
      else if (Array.isArray(picks) && picks.length) { watched = buildWatchedFromPicks(picks); putCache(key || "tmp", watched); }
      else if (typeof csv === "string" && csv.trim()) { ({ watched } = await buildWatchedFromCsv(csv, API_KEY)); putCache(key || "tmp", watched); }
      else { const e = new Error("세션이 만료되었습니다. 다시 분석해 주세요."); e.status = 440; throw e; }
    }
    const { profile, recommendations } = recommend({ watched, answers, catalog: getCatalog(), count, exclude });
    res.json({ profile: { topTags: topTagsPayload(profile) }, recommendations, catalogSize: getCatalogSize() });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "추천 중 오류가 발생했습니다." });
  }
});

app.listen(PORT, () => {
  console.log(`\n  🎬 넷플릭스 추천기  http://localhost:${PORT}`);
  console.log(`  - TMDB 키: ${API_KEY ? "설정됨" : "없음(데모 모드만 가능)"}`);
  console.log(`  - 지역: ${REGION}  ·  카탈로그: ${getCatalogSize()}개 작품\n`);
});
