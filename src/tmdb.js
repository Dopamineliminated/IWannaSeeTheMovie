// TMDB(The Movie Database) 클라이언트.
// 넷플릭스 제공작 디스커버 · 상세/키워드 보강 · 검색.
// 스팀 추천기의 steam.js(Steam API + SteamSpy)에 해당.
//
// 인증: v3 API 키(쿼리 파라미터) 또는 v4 읽기 토큰(JWT, Bearer 헤더) 둘 다 지원.

import { movieGenreSlugs, tvGenreSlugs } from "./genres.js";

const BASE = "https://api.themoviedb.org/3";
export const NETFLIX_PROVIDER_ID = 8; // TMDB watch provider: Netflix
const REGION = process.env.WATCH_REGION || "KR";
const LANG = process.env.TMDB_LANGUAGE || "ko-KR";

const isJwt = (k) => typeof k === "string" && k.startsWith("ey");

function authFor(key) {
  // JWT(v4) → Authorization 헤더, 아니면 v3 api_key 쿼리
  if (isJwt(key)) return { headers: { Authorization: `Bearer ${key}` }, query: "" };
  return { headers: {}, query: `api_key=${encodeURIComponent(key)}` };
}

async function tmdb(path, params = {}, key) {
  const { headers, query } = authFor(key);
  const qs = new URLSearchParams({ language: LANG, ...params });
  const url = `${BASE}${path}?${qs.toString()}${query ? "&" + query : ""}`;
  const res = await fetch(url, { headers });
  if (res.status === 401) { const e = new Error("TMDB 인증 실패 — API 키를 확인하세요."); e.status = 401; throw e; }
  if (res.status === 429) { // rate limit: 잠깐 쉬고 1회 재시도
    await new Promise((r) => setTimeout(r, 600));
    return tmdb(path, params, key);
  }
  if (!res.ok) { const e = new Error(`TMDB ${res.status} ${path}`); e.status = res.status; throw e; }
  return res.json();
}

const posterPath = (p) => p || null;

// 넷플릭스에서 볼 수 있는 인기 작품을 페이지 단위로 디스커버한다.
// kind: "movie" | "tv"
export async function discoverNetflix(kind, page, key) {
  const data = await tmdb(`/discover/${kind}`, {
    with_watch_providers: String(NETFLIX_PROVIDER_ID),
    watch_region: REGION,
    sort_by: "popularity.desc",
    page: String(page),
    "vote_count.gte": "50",
  }, key);
  const items = (data.results || []).map((r) => normalizeDiscover(kind, r));
  return { items, totalPages: data.total_pages || 1 };
}

function normalizeDiscover(kind, r) {
  const isTv = kind === "tv";
  const title = isTv ? r.name : r.title;
  const original = isTv ? r.original_name : r.original_title;
  const date = isTv ? r.first_air_date : r.release_date;
  const genres = isTv ? tvGenreSlugs(r.genre_ids) : movieGenreSlugs(r.genre_ids);
  return {
    id: r.id,
    type: isTv ? "tv" : "movie",
    title: title || original || "",
    originalTitle: original || title || "",
    year: date ? Number(String(date).slice(0, 4)) : null,
    lang: r.original_language || null,
    genres,
    keywords: [],            // 상세 보강에서 채움
    runtime: null,           // 상세 보강에서 채움
    maturity: null,          // 상세 보강에서 채움 (관람등급)
    popularity: r.popularity || 0,
    voteCount: r.vote_count || 0,
    poster_path: posterPath(r.poster_path),
    overview: r.overview || "",
  };
}

// 한 작품의 키워드 + 러닝타임 + 관람등급을 보강한다.
export async function enrichDetails(item, key) {
  const kind = item.type;
  const certPath = kind === "movie" ? `/movie/${item.id}/release_dates` : `/tv/${item.id}/content_ratings`;
  try {
    const [details, kw, certs] = await Promise.all([
      tmdb(`/${kind}/${item.id}`, {}, key),
      tmdb(`/${kind}/${item.id}/keywords`, {}, key),
      tmdb(certPath, {}, key).catch(() => ({ results: [] })),
    ]);
    const rawKw = kind === "tv" ? (kw.results || []) : (kw.keywords || []);
    item.keywords = rawKw.slice(0, 8).map((k) => slugifyKeyword(k.name));
    if (kind === "movie") item.runtime = details.runtime || null;
    else item.runtime = (details.episode_run_time && details.episode_run_time[0]) || 45;
    item.maturity = parseCert(kind, certs, REGION);
  } catch { /* 보강 실패는 무시(장르만으로도 동작) */ }
  return item;
}

// TMDB 인증등급 응답 → 등급 슬러그(all/12/15/19). KR 우선, 없으면 US.
function certToMaturity(cert) {
  const c = String(cert || "").toUpperCase().trim();
  if (!c) return null;
  if (["19", "R", "NC-17", "TV-MA"].includes(c)) return "19";
  if (["15", "PG-13", "TV-14"].includes(c)) return "15";
  if (["12", "TV-PG"].includes(c)) return "12";
  if (["ALL", "G", "PG", "7", "TV-Y", "TV-Y7", "TV-G"].includes(c)) return "all";
  return null;
}
function parseCert(kind, data, region) {
  const results = data?.results || [];
  const pick = (iso) => results.find((r) => r.iso_3166_1 === iso);
  const fromMovie = (r) => { for (const rd of r?.release_dates || []) { const m = certToMaturity(rd.certification); if (m) return m; } return null; };
  const fromTv = (r) => certToMaturity(r?.rating);
  const get = kind === "movie" ? fromMovie : fromTv;
  return get(pick(region)) || get(pick("US")) || null;
}

export function slugifyKeyword(name = "") {
  return String(name).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// 멀티 검색(영화+시리즈) — 시드 선택 / 시청기록 매칭용.
// lang: 매칭 정확도를 위해 영어 제목 매칭이 필요하면 "en-US" 전달.
//       (ko-KR 로 검색하면 한국 작품이 영어 제목으로 검색되지 않음)
export async function searchMulti(query, key, lang) {
  const params = { query, include_adult: "false", page: "1" };
  if (lang) params.language = lang;
  const data = await tmdb(`/search/multi`, params, key);
  return (data.results || [])
    .filter((r) => r.media_type === "movie" || r.media_type === "tv")
    .map((r) => normalizeDiscover(r.media_type, r));
}

export { LANG, REGION };
