import { channelHref, channelParams } from "./lib.js";

// The page to return to after a login: always rebuilt from constants and validated parts, never copied from the query.
const WATCH = /^\/watch\?v=([\w-]{11})/, CHANNEL = /^\/channel\/(UC[\w-]{22})(?:\?([^#]*))?$/, LISTS = /^\/playlists(?:\?id=(\d{1,9}))?$/;
const PAGES = new Map([["/history", "/history"], ["/subscriptions", "/subscriptions"], ["/tv", "/tv"]]);
// /results?search_query=...[&type=][&duration=][&sort=] (the order the search form sends): the text is checked, and the
// pattern only lets URL-safe characters through, so it can be echoed.
function results(next) {
  const m = /^\/results\?search_query=([\w%.~+-]{1,600}(?:&type=(?:video|channel))?(?:&duration=(?:any|short|medium|long))?(?:&sort=(?:relevance|date|views))?)$/.exec(next ?? "");
  let q = "";
  try { q = decodeURIComponent(m?.[1].split("&")[0].replaceAll("+", " ")); } catch { return ""; }
  return m && q.trim() && q.length <= 200 && !/\p{Cc}/u.test(q) ? next : "";
}
export function destination(next) {
  const w = WATCH.exec(next), c = CHANNEL.exec(next), l = LISTS.exec(next);
  return results(next) || (w ? "/watch?v=" + w[1] : c ? channelHref(c[1], channelParams(new URLSearchParams(c[2]))) : l ? "/playlists" + (l[1] ? "?id=" + l[1] : "") : PAGES.get(next) || "/");
}
