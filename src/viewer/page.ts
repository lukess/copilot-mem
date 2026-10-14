// Single-file dashboard served by `copilot-mem viewer`. No external assets (strict CSP);
// all data is rendered via textContent, never innerHTML. Keep this file ASCII (HTML entities in
// markup, \u escapes in script): Bun's runtime rewrites non-ASCII inside String.raw as \u escapes.
export const VIEWER_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>copilot-mem</title>
<style>
  :root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --line:#30363d; --fg:#e6edf3; --dim:#8b949e; --acc:#58a6ff; --ok:#3fb950; --warn:#d29922; --bad:#f85149; }
  * { box-sizing: border-box; }
  body { margin:0; font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; background:var(--bg); color:var(--fg); height:100vh; display:grid; grid-template-rows:auto 1fr 180px; }
  header { display:flex; flex-wrap:wrap; align-items:center; gap:16px; padding:10px 16px; border-bottom:1px solid var(--line); background:var(--panel); }
  h1 { font-size:15px; margin:0; display:flex; align-items:center; gap:8px; }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--bad); display:inline-block; }
  .dot.live { background:var(--ok); }
  .stat { display:flex; flex-direction:column; min-width:70px; }
  .stat b { font-size:17px; font-variant-numeric:tabular-nums; }
  .stat span, .dim { color:var(--dim); font-size:11px; }
  .progress { width:160px; height:6px; background:var(--line); border-radius:3px; overflow:hidden; margin-top:4px; }
  .progress div { height:100%; background:var(--ok); width:0; transition:width .4s; }
  .badge { padding:2px 8px; border-radius:10px; border:1px solid var(--line); font-size:11px; white-space:nowrap; }
  .badge.on { border-color:var(--ok); color:var(--ok); }
  .badge.busy { border-color:var(--warn); color:var(--warn); }
  .badge.off { border-color:var(--bad); color:var(--bad); }
  .spacer { flex:1; }
  .compress { display:flex; gap:6px; align-items:center; }
  .compress input { width:62px; flex:none; }
  button.primary { border-color:#238636; background:#238636; color:#fff; }
  button:disabled { opacity:.5; cursor:default; }
  main { display:grid; grid-template-columns:240px minmax(320px,1fr) minmax(360px,1.1fr); min-height:0; }
  section { min-height:0; overflow:auto; border-right:1px solid var(--line); }
  .head { position:sticky; top:0; background:var(--bg); padding:8px 12px; border-bottom:1px solid var(--line); display:flex; gap:6px; align-items:center; z-index:1; }
  .head h2 { font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--dim); margin:0; }
  input, select, button { background:var(--panel); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:5px 8px; font:inherit; }
  input { flex:1; min-width:0; }
  button { cursor:pointer; }
  .row { padding:7px 12px; border-bottom:1px solid #21262d; cursor:pointer; }
  .row:hover { background:#1c2129; }
  .row.sel { background:#1f2a3a; }
  .row.new { animation:flash 3s; }
  @keyframes flash { from { background:#23402a; } to { background:transparent; } }
  .row .t { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .meta { color:var(--dim); font-size:11px; display:flex; gap:8px; overflow:hidden; white-space:nowrap; }
  .type { font-size:10px; text-transform:uppercase; padding:0 5px; border-radius:4px; background:#30363d; }
  .type.decision { background:#1f3a5f; } .type.bugfix { background:#5a1e1e; } .type.feature { background:#1e4a2a; }
  .type.refactor { background:#3d2e5c; } .type.change { background:#4a3b12; } .type.discovery { background:#12404a; }
  .type.note { background:#5c3a12; }
  .proj { display:flex; justify-content:space-between; gap:8px; }
  .proj .n { color:var(--dim); font-variant-numeric:tabular-nums; white-space:nowrap; }
  .proj .name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; direction:rtl; text-align:left; }
  #detail { padding:14px 18px; }
  #detail h3 { margin:6px 0 10px; font-size:16px; }
  #detail p { white-space:pre-wrap; }
  #detail ul { padding-left:18px; }
  #detail code { background:var(--panel); padding:1px 4px; border-radius:4px; }
  #detail a { color:var(--acc); }
  dl { display:grid; grid-template-columns:max-content 1fr; gap:2px 12px; color:var(--dim); font-size:12px; }
  dd { margin:0; color:var(--fg); overflow-wrap:anywhere; }
  footer { border-top:1px solid var(--line); display:flex; flex-direction:column; min-height:0; }
  footer .head { position:static; }
  #log { margin:0; padding:6px 12px; overflow:auto; flex:1; font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; color:#c9d1d9; }
  .empty { padding:24px; color:var(--dim); text-align:center; }
  .more { width:calc(100% - 24px); margin:10px 12px; }
  .stat.link { cursor:pointer; }
  .stat.link:hover b { color:var(--acc); }
  table.grid { border-collapse:collapse; width:100%; margin:4px 0 14px; font-variant-numeric:tabular-nums; font-size:12px; }
  table.grid th, table.grid td { padding:3px 6px; border-bottom:1px solid #21262d; text-align:right; white-space:nowrap; }
  table.grid th { color:var(--dim); font-weight:normal; }
  table.grid th:first-child, table.grid td:first-child { text-align:left; }
  table.grid td.name { max-width:180px; overflow:hidden; text-overflow:ellipsis; }
  details.turn { border-bottom:1px solid #21262d; padding:4px 0; }
  details.turn summary { cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  details.turn.hl { background:#1f2a3a; }
  pre.text { white-space:pre-wrap; overflow-wrap:anywhere; margin:4px 0 8px; padding:6px 8px; background:var(--panel); border-radius:6px; font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; }
  pre.text.user { border-left:3px solid var(--acc); }
  #detail a.link, .link { color:var(--acc); cursor:pointer; }
  .head.wrap { flex-wrap:wrap; }
  .head .break { flex-basis:100%; height:0; }
  .head input[type=date] { flex:none; width:128px; }
  .heat { display:grid; grid-template-rows:repeat(7, 11px); grid-auto-flow:column; grid-auto-columns:11px; gap:2px; margin:8px 0 4px; overflow-x:auto; padding-bottom:4px; }
  .heat i { display:block; border-radius:2px; outline:1px solid #21262d; outline-offset:-1px; cursor:pointer; }
  .l0 { background:#161b22; } .l1 { background:#0e4429; } .l2 { background:#006d32; } .l3 { background:#26a641; } .l4 { background:#39d353; }
  .heat i.in { outline:1px solid var(--acc); }
  .heat i.out { visibility:hidden; }
  .legend { display:flex; gap:3px; align-items:center; font-size:11px; color:var(--dim); }
  .legend i { width:11px; height:11px; display:inline-block; border-radius:2px; }
  .type.pin { background:#6e4a00; }
  .tools { display:flex; gap:6px; margin:4px 0 8px; }
  button.danger { border-color:#da3633; color:#f85149; }
  table.kv th { text-align:left; width:1%; }
  tr.pick { cursor:pointer; }
  tr.pick:hover td { background:#161b22; }
  table.kv td { text-align:left; white-space:normal; word-break:break-all; }
  form.links { display:flex; gap:6px; flex-wrap:wrap; }
  form.links input { flex:1; min-width:160px; }
  form.edit { display:grid; grid-template-columns:max-content 1fr; gap:8px 10px; align-items:start; }
  form.edit label { color:var(--dim); font-size:12px; padding-top:6px; }
  form.edit textarea, form.edit input, form.edit select { width:100%; }
  textarea { background:var(--panel); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:6px 8px; font:inherit; resize:vertical; }
  form.edit .actions { grid-column:2; display:flex; gap:6px; }
  .err { color:var(--bad); }
  .st-ok { color:var(--ok); } .st-bad_output { color:var(--warn); } .st-error { color:var(--bad); }
</style>
</head>
<body>
<header>
  <h1><span id="live" class="dot" title="live updates"></span>copilot-mem</h1>
  <div class="stat"><b id="c-obs">&#x2013;</b><span>observations</span></div>
  <div class="stat"><b id="c-sessions">&#x2013;</b><span>sessions</span></div>
  <div class="stat"><b id="c-turns">&#x2013;</b><span>turns</span></div>
  <div class="stat"><b id="c-pending">&#x2013;</b><span>pending turns</span><div class="progress"><div id="bar"></div></div></div>
  <span class="compress" title="Compress pending turns now instead of waiting for the background worker">
    <input id="calls" type="number" min="1" max="500" value="5" aria-label="Copilot calls">
    <button id="compress" class="primary" disabled>Compress</button>
  </span>
  <div class="stat link" id="recall" title="Sessions that got copilot-mem context injected or called its tools"><b id="c-recall">&#x2013;</b><span>sessions used memory &#x203a;</span></div>
  <div class="stat link" id="usage" title="Compression time, tokens and AI credits"><b id="c-credits">&#x2013;</b><span>AI credits used &#x203a;</span></div>
  <span id="worker" class="badge">worker: &#x2013;</span>
  <span class="spacer"></span>
  <span id="integration" class="dim"></span>
  <button id="settings" title="Settings, semantic search coverage, integration and project links">Settings</button>
</header>
<main>
  <section>
    <div class="head"><input id="pq" type="search" placeholder="Filter projects&#x2026;" autocomplete="off" aria-label="Filter projects"></div>
    <div id="projects"></div>
  </section>
  <section>
    <div class="head wrap">
      <select id="mode" aria-label="List"><option value="obs">Observations</option><option value="sessions">Sessions</option></select>
      <input id="q" type="search" placeholder="Search memory&#x2026;" autocomplete="off">
      <select id="type"><option value="">all types</option></select>
      <span class="break"></span>
      <input id="from" type="date" aria-label="From date" title="From (local date)">
      <input id="to" type="date" aria-label="To date" title="To (local date)">
      <button id="clear-dates" title="Clear the date range" hidden>&#x2715;</button>
      <span class="spacer"></span>
      <button id="activity" title="Activity heatmap for the selected project (or all)">Activity</button>
      <button id="ctx" disabled title="Select a project to preview the context its next session gets">Context</button>
      <button id="note" title="Save a note to memory (like the remember tool)">+ Note</button>
      <button id="export" title="Download the observations and session summaries matching these filters as Markdown">Export</button>
    </div>
    <div id="list"></div>
  </section>
  <section id="detail"><div class="empty">Select an observation</div></section>
</main>
<footer>
  <div class="head"><h2>Worker log</h2><span class="spacer"></span><span id="log-note" class="dim">~/.copilot-mem/worker.log</span></div>
  <pre id="log"></pre>
</footer>
<script>
"use strict";
var TYPES = ["decision", "bugfix", "feature", "refactor", "change", "discovery", "note"];
var PAGE = 50;
var state = { project: "", type: "", q: "", items: [], done: false, selected: null, latest: null, seen: 0, projects: [], pq: "", snap: null, stats: null, latestCall: undefined, view: "", mode: "obs", recall: null, from: "", to: "", activity: null };

function $(id) { return document.getElementById(id); }
function h(tag, props) {
  var el = document.createElement(tag);
  for (var k in props || {}) {
    if (k === "class") el.className = props[k];
    else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), props[k]);
    else el.setAttribute(k, props[k]);
  }
  return add(el, [].slice.call(arguments, 2));
}
// Appends children, flattening nested arrays and skipping null/undefined (DOM append would print them).
function add(el, kids) {
  kids.forEach(function (c) {
    if (c == null) return;
    if (Array.isArray(c)) add(el, c); else el.append(c instanceof Node ? c : String(c));
  });
  return el;
}
// Use instead of fill(el, ...), which stringifies arrays and nulls.
function fill(el) { el.replaceChildren(); return add(el, [].slice.call(arguments, 1)); }
function api(path) {
  return fetch(path).then(function (r) {
    return r.json().then(function (body) { if (!r.ok) throw new Error(body.error || r.statusText); return body; });
  });
}
function qs(params) {
  return Object.keys(params).filter(function (k) { return params[k] !== "" && params[k] != null; })
    .map(function (k) { return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]); }).join("&");
}
function localStart(d) { return d ? new Date(d + "T00:00:00").toISOString() : ""; }
function localEnd(d) { return d ? new Date(d + "T23:59:59.999").toISOString() : ""; }
function ymd(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function rangeParams() { return { from: localStart(state.from), to: localEnd(state.to) }; }
function withRange(params) { var r = rangeParams(); params.from = r.from; params.to = r.to; return params; }
function fmt(n) { return Number(n).toLocaleString(); }
function day(iso) { return iso ? iso.slice(0, 10) : ""; }
function projectOf(o) { return o.repository || o.cwd || ""; }
function typeTag(t) { return h("span", { class: "type " + t }, t); }

TYPES.forEach(function (t) { $("type").append(h("option", { value: t }, t)); });
$("type").append(h("option", { value: "pinned" }, "pinned"));
function typeParams(p) { p.type = state.type === "pinned" ? "" : state.type; p.pinned = state.type === "pinned" ? 1 : ""; return p; }
function post(path, body) {
  return fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-copilot-mem-action": "1" }, body: JSON.stringify(body || {}) })
    .then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b.error || r.statusText); return b; }); });
}
function afterChange(id) { loadProjects(); return reload().then(function () { if (id != null) select(id); }); }

function loadProjects() {
  return api("/api/projects").then(function (projects) { state.projects = projects; renderProjects(); updateCompress(); });
}
function updateCtx() { $("ctx").disabled = !state.project; }
function selectedPending() {
  var p = state.projects.find(function (x) { return x.project === state.project; });
  return p ? p.pendingTurns : 0;
}
function renderProjects() {
  var box = $("projects");
  fill(box);
  var total = state.projects.reduce(function (s, p) { return s + p.observations; }, 0);
  box.append(projectRow({ project: "", label: "All projects", observations: total, pendingTurns: null }));
  var words = state.pq.toLowerCase().split(/\s+/).filter(Boolean);
  var shown = state.projects.filter(function (p) {
    var name = p.project.toLowerCase();
    return words.every(function (w) { return name.indexOf(w) >= 0; });
  });
  shown.forEach(function (p) { box.append(projectRow(p)); });
  if (words.length && !shown.length) box.append(h("div", { class: "empty" }, "No matching projects"));
}
function projectRow(p) {
  var unknown = p.project === "(unknown)";
  var label = p.label || p.project;
  var n = fmt(p.observations) + (p.pendingTurns ? " \u00b7 " + fmt(p.pendingTurns) + " pending" : "");
  return h("div", {
    class: "row proj" + (state.project === p.project ? " sel" : ""),
    title: label + (p.lastActivity ? "\nlast activity " + p.lastActivity : ""),
    onclick: unknown ? null : function () { selectProject(p.project); },
  }, h("span", { class: "name" }, h("bdi", null, label)), h("span", { class: "n" }, n));
}
function selectProject(project) {
  if (project === "(unknown)") return;
  state.project = project; renderProjects(); updateCompress(); updateCtx(); reload();
  if (state.view === "recall") loadRecall();
  if (state.view === "activity") loadActivity();
}

function reload() { state.items = []; state.done = false; return loadMore(); }
function loadMore() {
  if (state.mode === "sessions") return loadSessions();
  return api("/api/observations?" + qs(withRange(typeParams({ q: state.q, project: state.project, limit: PAGE, offset: state.items.length }))))
    .then(function (rows) { state.items = state.items.concat(rows); state.done = rows.length < PAGE; renderList(); })
    .catch(function (e) { fill($("list"), h("div", { class: "empty" }, e.message)); });
}
function emptyMessage() {
  if (state.q || state.type || state.from || state.to) return "No matches";
  if (!state.project) return "No observations yet.";
  var pending = selectedPending();
  if (!pending) return "No observations for this project.";
  return "Not compressed yet: " + fmt(pending) + " turn(s) from this project are waiting. The background worker " +
    "compresses newest sessions first, a few calls at a time, so older projects can wait a long time. " +
    "Use \u201cCompress project\u201d above to summarize this one now.";
}
function loadSessions() {
  return api("/api/sessions?" + qs(withRange({ q: state.q, project: state.project, limit: PAGE, offset: state.items.length })))
    .then(function (rows) { state.items = state.items.concat(rows); state.done = rows.length < PAGE; renderList(); })
    .catch(function (e) { fill($("list"), h("div", { class: "empty" }, e.message)); });
}
function recallBadges(s) {
  return [s.injections ? h("span", { class: "type discovery", title: "copilot-mem context injected at session start" }, "context") : null,
    s.recallCalls ? h("span", { class: "type decision", title: "copilot-mem tool calls" }, "recall " + s.recallCalls) : null];
}
function sessionRow(s) {
  return h("div", { class: "row" + (state.selected === s.id ? " sel" : ""), onclick: function () { openSession(s.id); } },
    h("span", { class: "t" }, s.title || s.id),
    h("span", { class: "meta" }, h("span", null, day(s.updated_at || s.created_at)), h("span", null, fmt(s.turns) + " turns"),
      s.observations ? h("span", null, fmt(s.observations) + " obs") : null, s.pendingTurns ? h("span", null, fmt(s.pendingTurns) + " pending") : null,
      recallBadges(s), h("bdi", null, s.repository || s.cwd || "")));
}
function renderList() {
  var list = $("list");
  if (state.mode === "sessions") {
    fill(list);
    if (!state.items.length) list.append(h("div", { class: "empty" }, state.q || state.from || state.to ? "No matching sessions" : "No sessions"));
    state.items.forEach(function (s) { list.append(sessionRow(s)); });
    if (!state.done) list.append(h("button", { class: "more", onclick: loadMore }, "Load more"));
    return;
  }
  fill(list);
  if (!state.items.length) list.append(h("div", { class: "empty" }, emptyMessage()));
  state.items.forEach(function (o) {
    var cls = "row" + (state.selected === o.id ? " sel" : "") + (state.seen && o.id > state.seen ? " new" : "");
    list.append(h("div", { class: cls, onclick: function () { select(o.id); } },
      h("span", { class: "t" }, o.title),
      h("span", { class: "meta" }, "#" + o.id, typeTag(o.type), o.pinned_at ? h("span", { class: "type pin" }, "pinned") : null, day(o.occurred_at), h("bdi", null, projectOf(o)))));
  });
  if (!state.done) list.append(h("button", { class: "more", onclick: loadMore }, "Load more"));
}

var REF_PATHS = { pr: "pull", issue: "issues", commit: "commit" };
function refLink(repo, r) {
  var label = r.type + " " + (r.type === "commit" ? r.value.slice(0, 12) : r.value);
  if (!repo || !Object.prototype.hasOwnProperty.call(REF_PATHS, r.type) || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return label;
  var href = "https://github.com/" + repo + "/" + REF_PATHS[r.type] + "/" + encodeURIComponent(r.value);
  return h("a", { href: href, target: "_blank", rel: "noopener noreferrer" }, label);
}
var SUMMARY_FIELDS = [["request", "request"], ["investigated", "investigated"], ["learned", "learned"],
  ["completed", "completed"], ["next_steps", "next steps"], ["notes", "notes"]];
function select(id) {
  state.selected = id;
  state.view = "observation";
  renderList();
  api("/api/observations/" + id).then(function (d) {
    var o = d.observation;
    var box = $("detail");
    fill(box, 
      h("div", { class: "meta" }, "#" + o.id, typeTag(o.type), o.pinned_at ? h("span", { class: "type pin" }, "pinned") : null, h("span", null, o.occurred_at),
        o.edited_at ? h("span", null, "edited " + day(o.edited_at)) : null),
      h("h3", null, o.title),
      h("div", { class: "tools" },
        h("button", { title: o.pinned_at ? "Stop always including it in session-start context" : "Always include it in session-start context for this project",
          onclick: function () { post("/api/observations/" + o.id + "/pin", { pinned: !o.pinned_at }).then(function () { afterChange(o.id); }).catch(fail); } },
          o.pinned_at ? "Unpin" : "Pin"),
        h("button", { onclick: function () { renderEdit(o); } }, "Edit"),
        h("button", { class: "danger", onclick: function () { removeObservation(o); } }, "Delete")),
      o.subtitle ? h("p", { class: "dim" }, o.subtitle) : null,
      o.concepts.length ? h("div", { class: "meta" }, o.concepts.map(function (c) { return h("span", { class: "type" }, c); })) : null,
      h("p", null, o.narrative),
      o.facts.length ? [h("h4", null, "Facts"), h("ul", null, o.facts.map(function (f) { return h("li", null, f); }))] : null,
      o.files.length ? [h("h4", null, o.type === "note" ? "Files" : "Files modified"), h("ul", null, o.files.map(function (f) { return h("li", null, h("code", null, f)); }))] : null,
      o.files_read.length ? [h("h4", null, "Files read"), h("ul", null, o.files_read.map(function (f) { return h("li", null, h("code", null, f)); }))] : null,
      o.touched_files.length ? [h("h4", null, "Files touched in these turns"), h("ul", null, o.touched_files.map(function (f) {
        return h("li", null, h("code", null, f.path), f.tool ? h("span", { class: "dim" }, " " + f.tool) : null);
      }))] : null,
      o.refs.length ? [h("h4", null, "Session refs"), h("ul", null, o.refs.map(function (r) { return h("li", null, refLink(o.repository, r)); }))] : null,
      o.occurrences > 1 ? h("p", { class: "dim" }, "Seen " + o.occurrences + " times (last " + (o.last_seen_at || "unknown") + ")") : null,
      o.similar.length ? [h("h4", null, "Possible duplicates"), h("div", null, o.similar.map(function (s) {
        return h("div", { class: "row", onclick: function () { select(s.id); } },
          h("span", { class: "t" }, s.title), h("span", { class: "meta" }, "#" + s.id, "similarity " + s.score.toFixed(2)));
      }))] : null,
      h("h4", null, "Source"),
      h("dl", null,
        h("dt", null, "project"), h("dd", null, projectOf(o) || "\u2013"),
        h("dt", null, "cwd"), h("dd", null, o.cwd || "\u2013"),
        h("dt", null, "branch"), h("dd", null, o.branch || "\u2013"),
        o.session_id.indexOf("manual:") === 0
          ? [h("dt", null, "source"), h("dd", null, "saved by you (remember)")]
          : [h("dt", null, "session"), h("dd", null, h("a", { class: "link", onclick: function () { openSession(o.session_id, o.first_turn, o.last_turn); } }, o.session_id)),
             h("dt", null, "turns"), h("dd", null, h("a", { class: "link", title: "Show the source turns", onclick: function () { openSession(o.session_id, o.first_turn, o.last_turn); } },
               o.first_turn === o.last_turn ? String(o.first_turn) : o.first_turn + "\u2013" + o.last_turn))]),
      d.summary ? [h("h4", null, "Session summary"), h("dl", null, SUMMARY_FIELDS.reduce(function (out, f) {
        return d.summary[f[0]] ? out.concat([h("dt", null, f[1]), h("dd", null, d.summary[f[0]])]) : out;
      }, []))] : null,
      h("h4", null, "Timeline"),
      h("div", null, d.timeline.map(function (t) {
        return h("div", { class: "row" + (t.id === o.id ? " sel" : ""), onclick: function () { select(t.id); } },
          h("span", { class: "t" }, t.title), h("span", { class: "meta" }, "#" + t.id, typeTag(t.type), day(t.occurred_at)));
      })));
    box.scrollTop = 0;
  }).catch(function (e) { fill($("detail"), h("div", { class: "empty" }, e.message)); });
}

function fail(e) { alert(e.message); }
function field(label, input) { return [h("label", null, label), input]; }
function renderForm(title, note, fields, onSave) {
  var err = h("p", { class: "err" });
  var form = h("form", { class: "edit" }, fields, h("div", { class: "actions" },
    h("button", { type: "submit", class: "primary" }, "Save"),
    h("button", { type: "button", onclick: function () { if (state.selected) select(state.selected); else fill($("detail"), h("div", { class: "empty" }, "Select an observation")); } }, "Cancel")));
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    err.textContent = "";
    onSave().catch(function (x) { err.textContent = x.message; });
  });
  fill($("detail"), h("h3", null, title), note ? h("p", { class: "dim" }, note) : null, form, err);
  $("detail").scrollTop = 0;
}
function lines(text) { return text.split("\n").map(function (l) { return l.trim(); }).filter(Boolean); }
function renderEdit(o) {
  state.view = "edit";
  var type = h("select", null, TYPES.map(function (t) { return h("option", { value: t }, t); }));
  type.value = o.type;
  var title = h("input", { value: o.title, maxlength: "120", required: "" });
  var subtitle = h("input", { value: o.subtitle || "" });
  var narrative = h("textarea", { rows: "8", required: "" });
  narrative.value = o.narrative;
  var facts = h("textarea", { rows: "6" });
  facts.value = o.facts.join("\n");
  renderForm("Edit #" + o.id, "Saved edits replace the compressed text; the observation is re-embedded for semantic search.",
    [field("type", type), field("title", title), field("subtitle", subtitle), field("narrative", narrative), field("facts (one per line)", facts)],
    function () {
      return post("/api/observations/" + o.id, { type: type.value, title: title.value, subtitle: subtitle.value, narrative: narrative.value, facts: lines(facts.value) })
        .then(function () { return afterChange(o.id); });
    });
}
function renderNote() {
  state.view = "note";
  var project = h("input", { value: state.project, required: "", placeholder: "owner/name or /absolute/dir" });
  var title = h("input", { maxlength: "120", required: "" });
  var text = h("textarea", { rows: "8", required: "" });
  var facts = h("textarea", { rows: "4" });
  renderForm("New note", "Notes are listed in every new session's context for their project (newest five), and searchable like any observation.",
    [field("project", project), field("title", title), field("text", text), field("facts (one per line)", facts)],
    function () {
      return post("/api/notes", { project: project.value, title: title.value, text: text.value, facts: lines(facts.value) })
        .then(function (r) { state.selected = r.id; return afterChange(r.id); });
    });
  (state.project ? title : project).focus();
}
function removeObservation(o) {
  if (!confirm("Delete #" + o.id + " \u201c" + o.title + "\u201d?\n\nThis removes it from search and context. The source turns stay in the session " +
    "(they are not re-compressed). This cannot be undone.")) return;
  post("/api/observations/" + o.id + "/delete").then(function () {
    state.selected = null;
    fill($("detail"), h("div", { class: "empty" }, "Deleted #" + o.id));
    afterChange(null);
  }).catch(fail);
}

function dur(ms) {
  var s = Math.round(ms / 1000);
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s";
  return Math.floor(s / 3600) + "h " + String(Math.floor(s % 3600 / 60)).padStart(2, "0") + "m";
}
function credits(n) { return n == null ? "\u2013" : n < 10 ? n.toFixed(3) : n.toFixed(1); }
function tok(n) { return n == null ? "\u2013" : n >= 10000 ? (n / 1000).toFixed(0) + "k" : fmt(n); }
function avgCredits() {
  var t = state.stats && state.stats.total;
  return t && t.measuredCalls ? t.credits / t.measuredCalls : 0.07;
}
function loadStats() {
  return api("/api/stats").then(function (st) {
    state.stats = st;
    $("c-credits").textContent = credits(st.total.credits);
    updateCompress();
    if (state.view === "stats") renderStats();
  }).catch(function () {});
}
function totalsRow(label, t) {
  var calls = t.calls - t.failed;
  return h("tr", null,
    h("td", null, label),
    h("td", null, fmt(t.calls) + (t.failed ? " (" + fmt(t.failed) + " failed)" : "")),
    h("td", null, fmt(t.turns) + " \u2192 " + fmt(t.observations)),
    h("td", null, dur(t.durationMs)),
    h("td", null, t.calls ? dur(t.durationMs / t.calls) : "\u2013"),
    h("td", null, tok(t.inputTokens) + " / " + tok(t.outputTokens)),
    h("td", null, credits(t.credits)),
    h("td", null, t.measuredCalls ? credits(t.credits / t.measuredCalls) : "\u2013"),
    h("td", null, String(t.premiumRequests)));
}
function grid(head, rows) {
  return h("table", { class: "grid" }, h("tr", null, head.map(function (c) { return h("th", null, c); })), rows);
}
function pendingByProject() {
  var list = state.projects.filter(function (p) { return p.pendingTurns > 0; }).sort(function (a, c) { return c.pendingTurns - a.pendingTurns; });
  if (!list.length) return null;
  return [
    h("p", { class: "dim" }, "Most pending" + (list.length > 10 ? " (10 of " + fmt(list.length) + " projects)" : "") + "; click one to select it:"),
    grid(["project", "pending turns", "calls", "AI credits", "time"], list.slice(0, 10).map(function (p) {
      var e = estimate(p.pendingTurns);
      return h("tr", { class: "pick", title: "Select " + p.project, onclick: function () { selectProject(p.project); } },
        h("td", { class: "name", title: p.project }, h("bdi", null, p.project)),
        h("td", null, fmt(p.pendingTurns)), h("td", null, fmt(e.calls)), h("td", null, credits(e.credits)), h("td", null, dur(e.ms)));
    }))];
}
function renderStats() {
  var st = state.stats, box = $("detail");
  state.view = "stats";
  if (!st) { fill(box, h("div", { class: "empty" }, "Loading\u2026")); return; }
  var t = st.total, head = ["", "calls", "turns \u2192 obs", "time", "avg/call", "tokens in / out", "AI credits", "credits/call", "premium"];
  var unmeasured = t.calls - t.measuredCalls;
  var b = st.backlog;
  fill(box, h("div", null,
    h("h3", null, "Compression usage"),
    t.calls ? null : h("p", { class: "dim" }, "No Copilot calls recorded yet. Every compression call (worker, dashboard or CLI) is measured from now on."),
    grid(head, [totalsRow("Last 24h", st.last24h), totalsRow("All time", t)]),
    unmeasured ? h("p", { class: "dim" }, fmt(unmeasured) + " call(s) without usage (failed before Copilot reported it); token and credit totals exclude them.") : null,
    h("h4", null, "Backlog"),
    h("p", null, b
      ? fmt(b.pendingTurns) + " pending turn(s) \u2248 " + fmt(b.calls) + " call(s), ~" + credits(b.credits) + " AI credits, ~" + dur(b.durationMs) + " (from measured averages)"
      : "Projection appears after the first measured call."),
    b ? pendingByProject() : null,
    st.days.length ? [h("h4", null, "By day"), grid(head, st.days.map(function (d) { return totalsRow(d.day, d); }))] : null,
    st.recent.length ? [h("h4", null, "Recent calls"), grid(["time", "kind", "project", "status", "turns \u2192 obs", "time", "tokens in / out", "credits"],
      st.recent.map(function (c) {
        return h("tr", null,
          h("td", null, new Date(c.startedAt).toLocaleString()),
          h("td", null, c.kind),
          h("td", { class: "name", title: c.project }, h("bdi", null, c.project)),
          h("td", { class: "st-" + c.status }, c.status.replace("_", " ")),
          h("td", null, c.kind === "summarize" ? "\u2013" : c.turns + " \u2192 " + c.observations),
          h("td", null, dur(c.durationMs)),
          h("td", null, tok(c.inputTokens) + " / " + tok(c.outputTokens)),
          h("td", null, credits(c.credits)));
      }))] : null));
  box.scrollTop = 0;
}

function pre(text, cls) { return h("pre", { class: "text" + (cls ? " " + cls : "") }, text || ""); }
function openSession(id, from, to) {
  state.selected = id;
  state.view = "session";
  if (state.mode === "sessions") renderList();
  fill($("detail"), h("div", { class: "empty" }, "Loading\u2026"));
  api("/api/sessions/" + encodeURIComponent(id)).then(function (d) {
    var s = d.session, box = $("detail"), target = null;
    var turns = d.turns.map(function (t) {
      var hl = from != null && t.turn_index >= from && t.turn_index <= to;
      var el = h("details", { class: "turn" + (hl ? " hl" : "") },
        h("summary", null, h("span", { class: "dim" }, "#" + t.turn_index + " " + (t.timestamp ? new Date(t.timestamp).toLocaleString() : "") +
          (t.compressed ? "" : " \u00b7 pending") + " \u00b7 "), (t.user_message || "").slice(0, 160)),
        pre(t.user_message, "user"), pre(t.assistant_response));
      if (hl) { el.open = true; if (!target) target = el; }
      return el;
    });
    fill(box, 
      h("div", { class: "meta" }, s.id, recallBadges(s)),
      h("h3", null, s.title || "(untitled session)"),
      h("dl", null,
        h("dt", null, "project"), h("dd", null, s.repository || s.cwd || "\u2013"),
        h("dt", null, "cwd"), h("dd", null, s.cwd || "\u2013"),
        h("dt", null, "branch"), h("dd", null, s.branch || "\u2013"),
        h("dt", null, "started"), h("dd", null, s.created_at ? new Date(s.created_at).toLocaleString() : "\u2013"),
        h("dt", null, "updated"), h("dd", null, s.updated_at ? new Date(s.updated_at).toLocaleString() : "\u2013"),
        h("dt", null, "turns"), h("dd", null, fmt(s.turns) + (s.pendingTurns ? " (" + fmt(s.pendingTurns) + " pending)" : ""))),
      h("h4", null, "Memory used"),
      d.injections.length || d.recallCalls.length ? null : h("p", { class: "dim" }, "No copilot-mem context or tool calls recorded for this session."),
      d.injections.map(function (c) {
        return h("details", { class: "turn" }, h("summary", null, "Context injected at start \u00b7 " + fmt(c.text.length) + " chars \u00b7 " +
          new Date(c.injected_at).toLocaleString()), pre(c.text));
      }),
      d.recallCalls.length ? grid(["time", "tool", "arguments", ""], d.recallCalls.map(function (c) {
        return h("tr", null, h("td", null, new Date(c.started_at).toLocaleTimeString()), h("td", null, c.tool_name.replace(/^copilot-mem-/, "")),
          h("td", { class: "name", title: c.summary }, c.summary.replace(/^[^:]*: /, "")),
          h("td", { class: c.success === 0 ? "st-error" : "st-ok" }, c.success === 0 ? "failed" : c.success == null ? "" : "ok"));
      })) : null,
      d.summary ? [h("h4", null, "Session summary"), h("dl", null, SUMMARY_FIELDS.reduce(function (out, f) {
        return d.summary[f[0]] ? out.concat([h("dt", null, f[1]), h("dd", null, d.summary[f[0]])]) : out;
      }, []))] : null,
      d.observations.length ? [h("h4", null, "Observations (" + d.observations.length + ")"), h("div", null, d.observations.map(function (o) {
        return h("div", { class: "row", onclick: function () { select(o.id); } }, h("span", { class: "t" }, o.title),
          h("span", { class: "meta" }, "#" + o.id, typeTag(o.type), "turns " + (o.first_turn === o.last_turn ? o.first_turn : o.first_turn + "\u2013" + o.last_turn)));
      }))] : null,
      h("h4", null, "Turns (" + d.turns.length + ")"),
      turns.length ? turns : h("p", { class: "dim" }, "No turns recorded."));
    if (target) target.scrollIntoView({ block: "start" }); else box.scrollTop = 0;
  }).catch(function (e) { fill($("detail"), h("div", { class: "empty" }, e.message)); });
}

function loadRecall() {
  return api("/api/recall?" + qs({ project: state.project })).then(function (r) {
    state.recall = r;
    if (!state.project) $("c-recall").textContent = fmt(r.usedMemory) + " / " + fmt(r.sessions);
    if (state.view === "recall") renderRecall();
  }).catch(function () {});
}
function pct(n, d) { return d ? Math.round(100 * n / d) + "%" : "\u2013"; }
function renderRecall() {
  var r = state.recall, box = $("detail");
  state.view = "recall";
  if (!r) { fill(box, h("div", { class: "empty" }, "Loading\u2026")); return; }
  var list = h("div", null, h("div", { class: "empty" }, "Loading\u2026"));
  fill(box, h("div", null,
    h("h3", null, "Recall activity" + (state.project ? " \u00b7 " + state.project : "")),
    h("p", { class: "dim" }, "Did Copilot CLI sessions actually use copilot-mem? Context = the sessionStart hook injected recent memory; " +
      "recall = the agent called a copilot-mem tool (search, timeline, get_observations, remember, summaries)."),
    grid(["", "sessions", "share"], [
      h("tr", null, h("td", null, "All sessions"), h("td", null, fmt(r.sessions)), h("td", null, "")),
      h("tr", null, h("td", null, "Context injected"), h("td", null, fmt(r.withContext)), h("td", null, pct(r.withContext, r.sessions))),
      h("tr", null, h("td", null, "Called copilot-mem tools"), h("td", null, fmt(r.withRecallCalls)), h("td", null, pct(r.withRecallCalls, r.sessions))),
      h("tr", null, h("td", null, "Either"), h("td", null, fmt(r.usedMemory)), h("td", null, pct(r.usedMemory, r.sessions)))]),
    r.byTool.length ? grid(["tool", "calls"], r.byTool.map(function (t) { return h("tr", null, h("td", null, t.tool), h("td", null, fmt(t.calls))); })) : null,
    h("h4", null, "Sessions that used memory"), list));
  box.scrollTop = 0;
  api("/api/sessions?" + qs({ project: state.project, recall: 1, limit: 100 })).then(function (rows) {
    fill(list);
    if (!rows.length) list.append(h("div", { class: "empty" }, "None yet. Sessions started after copilot-mem install get context automatically."));
    rows.forEach(function (s) { list.append(sessionRow(s)); });
  }).catch(function (e) { fill(list, h("div", { class: "empty" }, e.message)); });
}

function showContext() {
  if (!state.project) return;
  var box = $("detail");
  state.view = "context";
  fill(box, h("div", { class: "empty" }, "Loading\u2026"));
  api("/api/context?" + qs({ project: state.project })).then(function (c) {
    fill(box, h("div", null,
      h("h3", null, "Context preview"),
      h("p", { class: "dim" }, "What the sessionStart hook injects into a new Copilot CLI session started in this directory right now."),
      h("dl", null, h("dt", null, "project"), h("dd", null, c.project), h("dt", null, "cwd"), h("dd", null, c.cwd),
        h("dt", null, "size"), h("dd", null, fmt(c.chars) + " / " + fmt(c.budget) + " chars")),
      pre(c.text)));
    box.scrollTop = 0;
  }).catch(function (e) { fill(box, h("div", { class: "empty" }, e.message)); });
}
function setRange(from, to) {
  state.from = from || ""; state.to = to || "";
  $("from").value = state.from; $("to").value = state.to;
  $("clear-dates").hidden = !state.from && !state.to;
  reload();
  if (state.view === "activity") renderActivity();
}
function loadActivity() {
  state.activity = null;
  if (state.view === "activity") renderActivity();
  var since = new Date(); since.setDate(since.getDate() - 371);
  return api("/api/activity?" + qs({ project: state.project, since: localStart(ymd(since)) })).then(function (rows) {
    state.activity = { project: state.project, rows: rows };
    if (state.view === "activity") renderActivity();
  }).catch(function (e) { if (state.view === "activity") fill($("detail"), h("div", { class: "empty" }, e.message)); });
}
function renderActivity() {
  var a = state.activity, box = $("detail");
  state.view = "activity";
  if (!a) { fill(box, h("div", { class: "empty" }, "Loading\u2026")); return; }
  var byDay = {}, max = 0, total = { turns: 0, observations: 0, days: 0 }, months = {}, busiest = null;
  a.rows.forEach(function (r) {
    byDay[r.day] = r;
    if (r.turns > max) max = r.turns;
    total.turns += r.turns; total.observations += r.observations; if (r.turns) total.days++;
    if (!busiest || r.turns > busiest.turns) busiest = r;
    var m = months[r.day.slice(0, 7)] || (months[r.day.slice(0, 7)] = { days: 0, turns: 0, observations: 0 });
    if (r.turns) m.days++;
    m.turns += r.turns; m.observations += r.observations;
  });
  var today = new Date(), start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 364);
  start.setDate(start.getDate() - start.getDay());
  var cells = [], todayKey = ymd(today);
  for (var d = new Date(start); ymd(d) <= todayKey || d.getDay() !== 0; d.setDate(d.getDate() + 1)) {
    var key = ymd(d), r = byDay[key] || { turns: 0, sessions: 0, observations: 0 };
    var level = !r.turns ? 0 : Math.min(4, Math.ceil(4 * r.turns / max));
    var inRange = (state.from || state.to) && (!state.from || key >= state.from) && (!state.to || key <= state.to);
    cells.push(h("i", {
      class: (key > todayKey ? "out" : "l" + level) + (inRange ? " in" : ""),
      title: key + ": " + fmt(r.turns) + " turn(s), " + fmt(r.sessions) + " session(s), " + fmt(r.observations) + " observation(s)",
      onclick: (function (k) { return function () { setRange(k, k); }; })(key),
    }));
  }
  var monthKeys = Object.keys(months).sort().reverse();
  fill(box, h("div", null,
    h("h3", null, "Activity" + (state.project ? " \u00b7 " + state.project : "")),
    h("p", { class: "dim" }, "Copilot CLI turns per day over the last year (local time). Click a day to filter the list to it; " +
      "set a range above and use Export for a Markdown digest."),
    h("div", { class: "heat" }, cells),
    h("div", { class: "legend" }, "less", [0, 1, 2, 3, 4].map(function (l) { return h("i", { class: "l" + l }); }), "more"),
    h("p", null, fmt(total.days) + " active day(s), " + fmt(total.turns) + " turn(s), " + fmt(total.observations) + " observation(s)" +
      (busiest && busiest.turns ? "; busiest " + busiest.day + " (" + fmt(busiest.turns) + " turns)" : "") + "."),
    monthKeys.length ? grid(["month", "active days", "turns", "observations", ""], monthKeys.map(function (m) {
      var last = new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0);
      return h("tr", null, h("td", null, m), h("td", null, fmt(months[m].days)), h("td", null, fmt(months[m].turns)), h("td", null, fmt(months[m].observations)),
        h("td", null, h("a", { class: "link", onclick: function () { setRange(m + "-01", ymd(last)); } }, "filter")));
    })) : null));
  box.scrollTop = 0;
}
function exportMarkdown() {
  var params = withRange({ project: state.project, q: state.mode === "obs" ? state.q : "", fromLabel: state.from, toLabel: state.to });
  if (state.mode === "obs") typeParams(params);
  var a = h("a", { href: "/api/export?" + qs(params), download: "" });
  document.body.append(a); a.click(); a.remove();
}
function setMode(mode) {
  state.mode = mode;
  $("type").disabled = mode === "sessions";
  $("q").placeholder = mode === "sessions" ? "Search sessions (title, path, prompts, replies)\u2026" : "Search memory\u2026";
  reload();
}

/** Projected cost of compressing pending turns (at most maxCalls calls), from measured per-turn rates; null before any. */
function estimate(pending, maxCalls) {
  var b = state.stats && state.stats.backlog;
  if (!b || !pending) return null;
  var p = b.perTurn, need = Math.max(1, Math.ceil(pending * p.calls));
  var calls = maxCalls ? Math.min(maxCalls, need) : need;
  var turns = calls === need ? pending : Math.min(pending, Math.round(calls / p.calls));
  return { need: need, calls: calls, turns: turns, credits: turns * p.credits, ms: turns * p.durationMs };
}
function totalPending() {
  return state.project ? selectedPending() : state.snap ? state.snap.counts.pendingTurns : 0;
}

function kv(label, value) { return h("tr", null, h("th", null, label), h("td", null, value)); }
function yesNo(v) { return h("span", { class: "badge " + (v ? "on" : "off") }, v ? "yes" : "no"); }
function embeddingInfo(e) {
  if (!e) return h("p", { class: "dim" }, "Not available.");
  if (e.error) return h("p", { class: "err" }, e.error + " (semantic search is off; keyword search still works)");
  if (!e.model) return h("p", null, "Off: keyword search only. Set COPILOT_MEM_EMBED_PROVIDER to turn it on.");
  if (e.setup) return h("p", { class: "err" }, e.setup + " Until then search is keyword-only.");
  var pct = e.observations ? Math.floor(100 * e.embedded / e.observations) : 100;
  return h("p", null, h("b", null, e.model), ": " + fmt(e.embedded) + " of " + fmt(e.observations) + " observations embedded (" + pct + "%)" +
    (e.embedded < e.observations ? "; the worker embeds the rest on its next runs." : "."));
}
function renderLinks(box, links, message) {
  var a = h("input", { list: "project-names", placeholder: "project", required: "", "aria-label": "Project" });
  var b = h("input", { list: "project-names", placeholder: "project to link", required: "", "aria-label": "Project to link" });
  var err = h("p", { class: "err" });
  var form = h("form", { class: "links" }, a, b, h("button", { type: "submit", class: "primary" }, "Link"));
  var change = function (path, projects) {
    err.textContent = "";
    return post(path, { projects: projects }).then(function (r) { renderLinks(box, r.links, r.message); }).catch(function (x) { err.textContent = x.message; });
  };
  form.addEventListener("submit", function (ev) { ev.preventDefault(); change("/api/links", [a.value, b.value]); });
  fill(box,
    links.length ? h("table", { class: "grid kv" }, links.map(function (l) {
      return h("tr", null, h("td", null, h("bdi", null, l[0])), h("td", null, "\u2194"), h("td", null, h("bdi", null, l[1])),
        h("td", null, h("button", { onclick: function () { if (confirm("Unlink " + l[0] + " and " + l[1] + "?")) change("/api/links/delete", l); } }, "Unlink")));
    })) : h("p", { class: "dim" }, "No linked projects."),
    message ? h("p", { class: "dim" }, message) : null,
    h("datalist", { id: "project-names" }, state.projects.map(function (p) { return h("option", { value: p.project }); })),
    form, err);
}
function renderSettings() {
  state.view = "settings";
  var box = $("detail");
  fill(box, h("div", { class: "empty" }, "Loading\u2026"));
  Promise.all([api("/api/settings"), api("/api/status")]).then(function (r) {
    if (state.view !== "settings") return;
    var s = r[0], st = r[1], i = st.integration || {}, cp = st.copilot || {}, w = st.worker || {}, cfg = s.settings;
    var links = h("div");
    renderLinks(links, s.links);
    fill(box, h("div", null,
      h("h3", null, "Settings and health"),
      h("h4", null, "Integration"),
      h("table", { class: "grid kv" },
        kv("Copilot CLI", cp.version || cp.error || "not found"),
        kv("MCP server", yesNo(i.mcpServer)), kv("skill", yesNo(i.skill)), kv("hooks", yesNo(i.hooks)),
        kv("worker", w.compressing ? "compressing" : w.running ? "running" : "idle (runs after sessions)"),
        w.autoCompressLimit == null ? null : kv("auto-compress", w.autoCompressLimit ? "up to " + w.autoCompressLimit + " Copilot call(s) per worker run" : "off"),
        st.ides && st.ides.length ? kv("IDEs", st.ides.map(function (x) { return x.name; }).join(", ")) : null,
        st.version ? kv("version", st.version) : null),
      h("h4", null, "Semantic search"),
      embeddingInfo(s.embedding),
      h("h4", null, "Settings"),
      cfg ? [
        h("p", { class: "dim" }, cfg.path + (cfg.exists ? "" : " (missing; copilot-mem install creates it)") +
          ". Edit the file to change a setting; an environment variable of the same name wins. The worker picks changes up on its next run; restart the viewer for search."),
        h("table", { class: "grid kv" }, Object.keys(cfg.values).map(function (k) {
          var v = cfg.values[k];
          return h("tr", null, h("th", null, k), h("td", null, v.value === "" ? h("span", { class: "dim" }, "(default)") : v.value),
            h("td", null, h("span", { class: "badge" + (v.source === "default" ? "" : " on") }, v.source)));
        }))] : h("p", { class: "dim" }, "Not available."),
      h("h4", null, "Linked projects"),
      h("p", { class: "dim" }, "A session in one linked project also gets recent work from the others at start, and searching one covers them all."),
      links));
    box.scrollTop = 0;
  }).catch(function (e) { if (state.view === "settings") fill(box, h("p", { class: "err" }, e.message)); });
}

function updateCompress() {
  var s = state.snap, btn = $("compress");
  if (!s) return;
  var busy = s.worker.compressing || s.compressRequested;
  var pending = state.project ? selectedPending() : s.counts.pendingTurns;
  btn.disabled = !s.canCompress || busy || pending === 0;
  btn.textContent = busy ? "Compressing\u2026" : state.project ? "Compress project" : "Compress";
  var e = estimate(pending);
  btn.title = !s.canCompress ? "not available" : pending === 0 ? "nothing pending" :
    (state.project ? fmt(pending) + " pending turn(s) in " + state.project : "newest sessions first, across all projects") +
    (e ? "\nTo clear all: ~" + fmt(e.calls) + " call(s), ~" + credits(e.credits) + " AI credits, ~" + dur(e.ms) : "");
}
function onSnapshot(s) {
  var c = s.counts;
  state.snap = s;
  updateCompress();
  $("c-obs").textContent = fmt(c.observations);
  $("c-sessions").textContent = fmt(c.sessions);
  $("c-turns").textContent = fmt(c.turns);
  $("c-pending").textContent = fmt(c.pendingTurns);
  $("bar").style.width = (c.turns ? (100 * (c.turns - c.pendingTurns) / c.turns) : 0).toFixed(1) + "%";
  var w = s.worker, badge = $("worker");
  badge.textContent = w.compressing ? "compressing (pid " + w.compressing + ")" : w.running ? "worker running (pid " + w.running + ")" : "worker idle";
  badge.className = "badge " + (w.compressing ? "busy" : w.running ? "on" : "");
  badge.title = "auto-compress: " + (w.autoCompressLimit ? w.autoCompressLimit + " call(s) per round" : "off");
  var log = $("log"), atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 20;
  log.textContent = s.log.join("\n");
  if (atBottom) log.scrollTop = log.scrollHeight;
  if (state.latest !== null && s.latestObservationId !== state.latest) {
    state.seen = state.latest || 0;
    if (!state.q && state.items.length <= PAGE) reload();
    loadProjects();
  }
  state.latest = s.latestObservationId;
  if (state.latest !== null && s.counts.sessions !== state.sessionCount) loadRecall();
  state.sessionCount = s.counts.sessions;
  if (s.latestCallId !== state.latestCall) { state.latestCall = s.latestCallId; loadStats(); }
}

function connect() {
  var es = new EventSource("/api/events");
  es.addEventListener("snapshot", function (e) { $("live").className = "dot live"; onSnapshot(JSON.parse(e.data)); });
  es.onerror = function () { $("live").className = "dot"; };
}

function loadStatus() {
  api("/api/status").then(function (s) {
    var i = s.integration || {}, cp = s.copilot || {};
    var ok = i.mcpServer && i.skill && i.hooks;
    var el = $("integration");
    fill(el, h("span", { class: "badge " + (ok ? "on" : "off") }, ok ? "integrated" : "not fully installed"),
      " ", cp.version ? "Copilot CLI " + cp.version : (cp.error || "Copilot CLI not found"), " \u00b7 v" + s.version);
    el.title = "MCP server: " + !!i.mcpServer + "\nskill: " + !!i.skill + "\nhooks: " + !!i.hooks;
  }).catch(function () {});
}

$("compress").addEventListener("click", function () {
  var n = Number($("calls").value);
  if (!Number.isInteger(n) || n < 1 || n > 500) { alert("Enter a number of calls between 1 and 500."); return; }
  var pending = totalPending(), e = estimate(pending, n);
  var scope = (state.project ? "for " + state.project : "across all projects, newest sessions first") + " (" + fmt(pending) + " pending turn(s))";
  var msg = "Compress pending turns now, " + scope + "?\n\n" + (e
    ? "This run: " + fmt(e.calls) + " Copilot call(s) for ~" + fmt(e.turns) + " turn(s), ~" + credits(e.credits) + " AI credits, ~" + dur(e.ms) +
      (e.calls < e.need ? ". Clearing all " + fmt(pending) + " takes ~" + fmt(e.need) + " call(s)." : ", which clears them all.") + " (From measured averages.)"
    : "Up to " + n + " Copilot call(s), about " + credits(avgCredits()) + " AI credits each (~" + credits(n * avgCredits()) + " total, estimate).") +
    " Progress shows in the worker log.";
  if (!confirm(msg)) return;
  $("compress").disabled = true;
  fetch("/api/compress", {
    method: "POST",
    headers: { "content-type": "application/json", "x-copilot-mem-action": "1" },
    body: JSON.stringify(state.project ? { limit: n, project: state.project } : { limit: n }),
  }).then(function (r) {
    return r.json().then(function (body) { if (!r.ok) throw new Error(body.error || r.statusText); });
  }).catch(function (e) { alert("Compress failed: " + e.message); $("compress").disabled = false; });
});

var timer;
$("q").addEventListener("input", function (e) {
  clearTimeout(timer);
  timer = setTimeout(function () { state.q = e.target.value.trim(); reload(); }, 250);
});
$("usage").addEventListener("click", function () { state.selected = null; renderList(); renderStats(); loadStats(); });
$("recall").addEventListener("click", function () {
  state.selected = null; renderList();
  var all = !state.project;
  if (!all) state.recall = null;
  renderRecall(); loadRecall();
});
$("ctx").addEventListener("click", showContext);
$("activity").addEventListener("click", function () { state.selected = null; renderList(); renderActivity(); loadActivity(); });
$("export").addEventListener("click", exportMarkdown);
$("settings").addEventListener("click", function () { state.selected = null; renderList(); renderSettings(); });
$("calls").addEventListener("input", updateCompress);
$("note").addEventListener("click", function () { state.selected = null; renderList(); renderNote(); });
$("from").addEventListener("change", function (e) { setRange(e.target.value, state.to); });
$("to").addEventListener("change", function (e) { setRange(state.from, e.target.value); });
$("clear-dates").addEventListener("click", function () { setRange("", ""); });
$("mode").addEventListener("change", function (e) { setMode(e.target.value); });
$("pq").addEventListener("input", function (e) { state.pq = e.target.value; renderProjects(); });
$("type").addEventListener("change", function (e) { state.type = e.target.value; reload(); });

loadStatus();
loadProjects();
loadRecall();
reload();
connect();
</script>
</body>
</html>
`;
