export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function layout(title: string, body: string, query = "", head = ""): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${esc(title)} - YouTube Classic</title>
<link rel="stylesheet" href="/static/classic.css">${head}
</head><body>
<div id="masthead">
  <a id="logo" href="/">You<span>Tube</span></a>
  <form action="/results" method="get">
    <input type="text" name="search_query" value="${esc(query)}">
    <button type="submit">Search</button>
  </form>
</div>
<div id="page">${body}</div>
</body></html>`;
}
