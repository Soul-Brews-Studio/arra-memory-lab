import { FormEvent, useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { applyTheme, readStoredTheme, THEMES, type ThemeName } from "./theme";
import "./styles.css";

type MemoryKind = "note" | "decision" | "lesson" | "context" | "retrospective" | "cheatsheet";
type SearchMode = "keyword" | "semantic" | "hybrid";
type Json = Record<string, unknown>;

interface Memory {
  id: string;
  title: string;
  content: string;
  kind: MemoryKind;
  tags: string[];
  project?: string | null;
  sourcePath?: string | null;
  createdBy?: string;
  supersedesMemoryId?: string | null;
  supersedesRevision?: number | null;
  supersedesHash?: string | null;
  revision: number;
  contentHash?: string;
  updatedAt?: string;
}

interface Evidence {
  memoryId: string;
  sourceRevision: number;
  sourceHash: string;
}

interface Observation {
  id: string;
  statement: string;
  status: "active" | "stale" | "retracted";
  sources: Evidence[];
  updatedAt?: string;
}

interface Trace {
  id: string;
  queryHash: string;
  requestedMode: SearchMode;
  effectiveMode: SearchMode;
  fallbackReason?: string | null;
  resultCount?: number | null;
  keywordCount: number;
  semanticCount: number;
  durationMs: number;
  status: "completed" | "failed";
  errorCategory?: string | null;
  createdAt?: string;
  results?: TraceResult[];
}

interface TraceResult {
  memoryId: string;
  rank: number;
  score: number;
  sourceRevision: number;
  sourceHash: string;
}

const kinds: MemoryKind[] = ["note", "decision", "lesson", "context", "retrospective", "cheatsheet"];
const modes: SearchMode[] = ["keyword", "semantic", "hybrid"];
const TOKEN_KEY = "arra-memory-lab-token";

const record = (value: unknown): Json => value && typeof value === "object" ? value as Json : {};
const array = <T,>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];
const pickArray = <T,>(body: unknown, ...keys: string[]): T[] => {
  if (Array.isArray(body)) return body as T[];
  const value = record(body);
  for (const key of keys) if (Array.isArray(value[key])) return value[key] as T[];
  return [];
};
const displayDate = (value?: string) => value ? new Date(value).toLocaleString() : "—";
const shortHash = (value?: string) => value ? `${value.slice(0, 10)}…${value.slice(-6)}` : "—";

class ApiError extends Error {
  readonly name = "ApiError";
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

function App() {
  const [theme, setTheme] = useState<ThemeName>(() => readStoredTheme());
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? "");
  const [draftToken, setDraftToken] = useState(token);
  const [info, setInfo] = useState<Json>({});
  const [state, setState] = useState<Json>({});
  const [search, setSearch] = useState<Json | null>(null);
  const [message, setMessage] = useState("Connect with your lab token to inspect the corpus.");
  const [busy, setBusy] = useState("");
  const [forgetPreview, setForgetPreview] = useState<{ memory: Memory; impact: Json } | null>(null);
  const [rebuildPreview, setRebuildPreview] = useState<Json | null>(null);

  const memories = pickArray<Memory>(state, "memories");
  const observations = pickArray<Observation>(state, "observations");
  const traces = pickArray<Trace>(state, "traces", "searchTraces");
  const stateRecord = record(state);
  const stats = record(stateRecord.stats ?? stateRecord.coverage);

  const request = useCallback(async (path: string, init: RequestInit = {}, publicRoute = false) => {
    const response = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(!publicRoute && token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers
      }
    });
    const body = await response.json().catch(() => ({ error: response.statusText }));
    if (!response.ok) {
      const detail = record(body);
      throw new ApiError(
        String(detail.error ?? "request_failed"),
        response.status,
        String(detail.message ?? detail.error ?? `Request failed (${response.status})`)
      );
    }
    return body as Json;
  }, [token]);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      setBusy("refresh");
      setState(await request("/api/state"));
      setMessage("State refreshed from the authoritative store.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load state.");
    } finally { setBusy(""); }
  }, [request, token]);

  useEffect(() => {
    request("/api/info", {}, true).then(setInfo).catch(() => setInfo({}));
  }, [request]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { applyTheme(theme, document); }, [theme]);

  const act = async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    try { await action(); } catch (error) {
      setMessage(error instanceof Error ? error.message : "The operation failed.");
    } finally { setBusy(""); }
  };

  const connect = (event: FormEvent) => {
    event.preventDefault();
    const clean = draftToken.trim();
    sessionStorage.setItem(TOKEN_KEY, clean);
    setToken(clean);
    setMessage(clean ? "Token stored for this browser session only." : "Token cleared.");
  };

  const createMemory = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    void act("remember", async () => {
      await request("/api/memories", { method: "POST", body: JSON.stringify({
        title: form.get("title"), content: form.get("content"), kind: form.get("kind"),
        tags: String(form.get("tags") ?? "").split(",").map((tag) => tag.trim()).filter(Boolean),
        project: form.get("project") || undefined,
        sourcePath: form.get("sourcePath") || undefined,
        createdBy: form.get("createdBy") || undefined,
        oracleName: form.get("oracleName") || undefined,
        supersedesMemoryId: form.get("supersedesMemoryId") || undefined
      }) });
      formElement.reset();
      setMessage("Authoritative memory saved. Indexing remains best effort.");
      await refresh();
    });
  };

  const runSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void act("search", async () => {
      const result = await request("/api/search", { method: "POST", body: JSON.stringify({
        query: form.get("query"), mode: form.get("mode"),
        kind: form.get("kind") || undefined, project: form.get("project") || undefined, limit: Number(form.get("limit"))
      }) });
      const resolved = record(result.search ?? result);
      setSearch(resolved);
      const meta = record(resolved.meta ?? resolved);
      setMessage(`Recall completed in ${String(meta.effectiveMode ?? meta.effective_mode ?? form.get("mode"))} mode.`);
      await refresh();
    });
  };

  const createObservation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const sourceMemoryIds = form.getAll("source").map(String);
    if (sourceMemoryIds.length < 1 || sourceMemoryIds.length > 8) {
      setMessage("Select between 1 and 8 evidence sources.");
      return;
    }
    void act("observe", async () => {
      await request("/api/observations", { method: "POST", body: JSON.stringify({ statement: form.get("statement"), sourceMemoryIds }) });
      formElement.reset();
      setMessage("Observation stored with immutable source evidence snapshots.");
      await refresh();
    });
  };

  const updateMemory = (memory: Memory) => {
    const title = window.prompt("Memory title", memory.title);
    if (title === null) return;
    const content = window.prompt("Memory content", memory.content);
    if (content === null) return;
    void act(`edit-${memory.id}`, async () => {
      await request(`/api/memories/${encodeURIComponent(memory.id)}`, { method: "PATCH", body: JSON.stringify({ title, content, kind: memory.kind, tags: memory.tags }) });
      setMessage("Memory revision advanced; dependent evidence may now be stale.");
      await refresh();
    });
  };

  const previewForget = (memory: Memory) => void act(`forget-${memory.id}`, async () => {
    const response = await request(`/api/memories/${encodeURIComponent(memory.id)}/forget`, { method: "POST", body: JSON.stringify({ confirm: false }) });
    setForgetPreview({ memory, impact: record(response.result ?? response) });
    setMessage("Forget impact previewed. No mutation has occurred.");
  });

  const confirmForget = () => forgetPreview && void act("confirm-forget", async () => {
    const impact = forgetPreview.impact;
    try {
      await request(`/api/memories/${encodeURIComponent(forgetPreview.memory.id)}/forget`, {
        method: "POST",
        body: JSON.stringify({
          confirm: true,
          expectedRevision: Number(impact.expectedRevision),
          expectedHash: String(impact.expectedHash),
          expectedChunks: Number(impact.expectedChunks),
          expectedObservationCount: Number(impact.expectedObservationCount)
        })
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "stale_preview") {
        setForgetPreview(null);
        await refresh();
      }
      throw error;
    }
    setForgetPreview(null);
    setMessage("Memory forgotten; dependent observations are retained as retracted evidence.");
    await refresh();
  });

  const rebuild = (confirm: boolean) => void act(confirm ? "confirm-rebuild" : "preview-rebuild", async () => {
    const response = await request("/api/index/rebuild", { method: "POST", body: JSON.stringify({ confirm }) });
    setRebuildPreview(confirm ? null : record(response.result ?? response));
    setMessage(confirm ? "Bounded index rebuild completed." : "Rebuild impact previewed. No derived chunks changed.");
    if (confirm) await refresh();
  });

  const searchRecord = record(search);
  const searchMeta = record(searchRecord.meta ?? searchRecord);
  const results = pickArray<Json>(searchRecord.results ?? searchRecord, "results", "memories", "items");
  const memoryCount = Number(stats.memories ?? memories.length);
  const coverage = Number(stats.indexCoverage ?? stats.index_coverage ?? stats.coverage ?? (memoryCount ? Number(stats.indexedMemories ?? 0) / memoryCount : 0));
  const infoTools = array<string>(info.mcpTools ?? info.mcp_tools ?? info.tools ?? record(info.mcp).tools);
  const embeddingInfo = record(info.embeddings);

  return <div className="shell">
    <header className="hero">
      <nav>
        <a className="brand" href="#top">ARRA / MEMORY LAB</a>
        <a href="#architecture">Architecture</a><a href="#workbench">Workbench</a><a href="#evidence">Evidence</a>
        <fieldset className="theme-picker">
          <legend>Palette</legend>
          <div className="theme-options">
            {THEMES.map((option) => <label key={option.value} title={option.note}>
              <input type="radio" name="theme" value={option.value} checked={theme === option.value} onChange={() => setTheme(option.value)}/>
              <span className={`theme-swatch ${option.value}`} aria-hidden="true"/>
              <span className="theme-name">{option.label}</span>
              <span className="theme-check" aria-hidden="true">✓</span>
            </label>)}
          </div>
        </fieldset>
      </nav>
      <div className="hero-grid" id="top">
        <div><p className="eyebrow">Cloudflare systems lab · single user</p><h1>Memory you can<br/><em>interrogate.</em></h1><p className="lede">A small, inspectable implementation of authoritative memory, derived recall, evidence provenance, and reversible operations.</p></div>
        <form className="token-card" onSubmit={connect}>
          <span className={`signal ${token ? "online" : ""}`}/><div><strong>{token ? "Lab connected" : "Protected corpus"}</strong><p>The bearer token is kept only in <code>sessionStorage</code>.</p></div>
          <label>Lab access token<input aria-label="Lab access token" type="password" value={draftToken} onChange={(e) => setDraftToken(e.target.value)} autoComplete="off" placeholder="Paste token once" /></label>
          <button type="submit">{token ? "Update session token" : "Connect to lab"}</button>
        </form>
      </div>
      <p className="status" role="status" aria-live="polite">{busy ? "Working · " : ""}{message}</p>
    </header>

    <main>
      <section id="architecture" className="section"><SectionHead number="01" title="Authority before intelligence" copy="Every row has a declared role. Derived knowledge stays inspectable and disposable."/>
        <div className="tier-grid">
          <article className="tier authority"><span>01 · SOURCE</span><h3>Memories</h3><p>Authoritative text with a monotonic revision and content hash.</p><strong>{memories.length} records</strong></article>
          <article className="tier"><span>02 · PROJECTION</span><h3>Chunks + vectors</h3><p>Rebuildable 768-dimensional EmbeddingGemma projections.</p><strong>{Math.round(coverage * (coverage <= 1 ? 100 : 1))}% coverage</strong></article>
          <article className="tier"><span>03 · ASSERTION</span><h3>Observations</h3><p>Derived statements pinned to exact source revisions and hashes.</p><strong>{observations.length} claims</strong></article>
          <article className="tier"><span>04 · OPERATIONS</span><h3>Search traces</h3><p>Newest 100 metadata traces. Queries and content are never retained.</p><strong>{traces.length} visible</strong></article>
        </div>
        <div className="capability-strip"><span>PUBLIC DISCLOSURE</span><code>{String(info.embeddingModel ?? info.embedding_model ?? embeddingInfo.model ?? "@cf/google/embeddinggemma-300m")}</code><span>MCP · {infoTools.length ? infoTools.join(" · ") : "9 tools"}</span></div>
      </section>

      <section id="workbench" className="section"><SectionHead number="02" title="Memory workbench" copy="Write to the source of truth, then inspect how recall interprets it."/>
        <div className="workbench">
          <form className="panel" onSubmit={createMemory}><PanelTitle title="Remember" note="authoritative write"/>
            <label>Title<input name="title" required maxLength={160} placeholder="What is worth preserving?"/></label>
            <div className="field-row"><label>Kind<select name="kind">{kinds.map((kind) => <option key={kind}>{kind}</option>)}</select></label><label>Tags<input name="tags" placeholder="cloudflare, memory"/></label></div>
            <div className="field-row"><label>Project / repo<input name="project" placeholder="github.com/owner/repo"/></label><label>Source path<input name="sourcePath" placeholder="ψ/memory/retrospectives/…"/></label></div>
            <div className="field-row"><label>Created by<select name="createdBy" defaultValue="manual"><option>manual</option><option>rrr</option><option>importer</option></select></label><label>Oracle name<input name="oracleName" placeholder="neo (stored as oracle-neo tag)"/></label></div>
            <label>Supersedes snapshot<select name="supersedesMemoryId" defaultValue=""><option value="">none</option>{memories.map((memory) => <option key={memory.id} value={memory.id}>{memory.title} · rev {memory.revision}</option>)}</select></label>
            <label>Content<textarea name="content" required maxLength={12000} rows={5} placeholder="State the memory plainly…"/></label>
            <button disabled={!token || !!busy}>Save authoritative memory</button>
          </form>
          <form className="panel" onSubmit={runSearch}><PanelTitle title="Recall" note="inspectable retrieval"/>
            <label>Query<input name="query" required placeholder="What do you need to recall?"/></label>
            <div className="field-row"><label>Requested mode<select name="mode" defaultValue="hybrid">{modes.map((mode) => <option key={mode}>{mode}</option>)}</select></label><label>Kind<select name="kind" defaultValue=""><option value="">all kinds</option>{kinds.map((kind) => <option key={kind}>{kind}</option>)}</select></label><label>Project<input name="project" placeholder="all projects"/></label><label>Limit<input name="limit" type="number" min="1" max="50" defaultValue="8"/></label></div>
            <p className="hint">Hybrid may degrade only when the embedding provider fails. Semantic never silently falls back.</p>
            <button disabled={!token || !!busy}>Run recall</button>
          </form>
        </div>
        {search && <div className="search-output">
          <div className="mode-line"><Metric label="trace" value={String(searchMeta.traceId ?? searchMeta.trace_id ?? "—")}/><Metric label="requested" value={String(searchMeta.requestedMode ?? searchMeta.requested_mode ?? "—")}/><span>→</span><Metric label="effective" value={String(searchMeta.effectiveMode ?? searchMeta.effective_mode ?? "—")}/><Metric label="degradation" value={String(searchMeta.fallbackReason ?? searchMeta.fallback_reason ?? record(searchMeta.fallback).reason ?? "none")}/></div>
          <div className="result-list">{results.length ? results.map((result, index) => { const memory = record(result.memory ?? result); const provenance = record(result.rankProvenance ?? result.rank_provenance ?? result.provenance); const distance = provenance.semanticDistance ?? provenance.semantic_distance; return <article key={String(memory.id ?? index)}><span className="rank">#{index + 1}</span><div><strong>{String(memory.title ?? "Untitled memory")}</strong><p>{String(memory.content ?? memory.snippet ?? "")}</p><small>rank provenance · keyword {String(provenance.keywordRank ?? provenance.keyword_rank ?? "—")} · semantic {String(provenance.semanticRank ?? provenance.semantic_rank ?? "—")} · distance {typeof distance === "number" ? distance.toFixed(4) : "—"}</small></div></article>; }) : <p className="empty">No memories matched this recall.</p>}</div>
        </div>}
      </section>

      <section className="section"><SectionHead number="03" title="Corpus & safe mutations" copy="Revision is visible. Forgetting and rebuilding always begin with a dry run."/>
        <div className="memory-list">{memories.length ? memories.map((memory) => <article className="memory-card" key={memory.id}>
          <div><span className="kind">{memory.kind}</span><span className="revision">rev {memory.revision}</span></div><h3>{memory.title}</h3><p>{memory.content}</p>
          <div className="tags">{array<string>(memory.tags).map((tag) => <span key={tag}>{tag}</span>)}</div><small>{memory.project ? `${memory.project} · ` : ""}{memory.sourcePath ? `${memory.sourcePath} · ` : ""}{memory.createdBy ? `${memory.createdBy} · ` : ""}updated {displayDate(memory.updatedAt)} · hash {shortHash(memory.contentHash)}{memory.supersedesMemoryId ? ` · supersedes ${memory.supersedesMemoryId} @ rev ${memory.supersedesRevision} / ${shortHash(memory.supersedesHash ?? undefined)}` : ""}</small>
          <div className="actions"><button className="quiet" onClick={() => updateMemory(memory)}>Edit + revise</button><button className="danger" onClick={() => previewForget(memory)}>Preview forget</button></div>
        </article>) : <p className="empty">No authoritative memories yet.</p>}</div>
        <div className="safety-grid"><div className="panel"><PanelTitle title="Index coverage" note="derived and rebuildable"/><div className="coverage"><span style={{width: `${Math.min(100, coverage * (coverage <= 1 ? 100 : 1))}%`}}/><b>{Math.round(coverage * (coverage <= 1 ? 100 : 1))}%</b></div><p className="hint">Confirmed rebuilds are bounded to 10 memories and 256 chunks, with revision/hash rechecks.</p><button className="quiet" onClick={() => rebuild(false)}>Preview rebuild</button>{rebuildPreview && <><pre>{JSON.stringify(rebuildPreview, null, 2)}</pre><button onClick={() => rebuild(true)}>Confirm bounded rebuild</button></>}</div>
          {forgetPreview && <div className="panel warning"><PanelTitle title={`Forget “${forgetPreview.memory.title}”?`} note="preview only · destructive"/><pre>{JSON.stringify(forgetPreview.impact, null, 2)}</pre><p className="hint">The source and chunks will be deleted. Evidence remains, marked retracted.</p><div className="actions"><button className="quiet" onClick={() => setForgetPreview(null)}>Cancel</button><button className="danger solid" onClick={confirmForget}>Confirm forget</button></div></div>}
        </div>
      </section>

      <section id="evidence" className="section"><SectionHead number="04" title="Evidence, not vibes" copy="Observations preserve exactly which source revision and hash supported the assertion."/>
        <form className="panel observation-form" onSubmit={createObservation}><label>Observation<textarea name="statement" required maxLength={4000} rows={3} placeholder="State a conclusion supported by the selected memories…"/></label><fieldset><legend>Evidence sources · select 1–8</legend>{memories.map((memory) => <label className="check" key={memory.id}><input type="checkbox" name="source" value={memory.id}/><span>{memory.title} <small>rev {memory.revision}</small></span></label>)}</fieldset><button disabled={!token || !memories.length || !!busy}>Store evidence-backed observation</button></form>
        <div className="observation-list">{observations.length ? observations.map((observation) => <article className="observation" key={observation.id}><div><span className={`badge ${observation.status}`}>{observation.status}</span><small>{displayDate(observation.updatedAt)}</small></div><h3>{observation.statement}</h3><ul>{array<Evidence>(observation.sources).map((source) => <li key={source.memoryId}><code>{source.memoryId}</code><span>rev {source.sourceRevision}</span><span>{shortHash(source.sourceHash)}</span></li>)}</ul></article>) : <p className="empty">No derived observations yet.</p>}</div>
      </section>

      <section className="section"><SectionHead number="05" title="Bounded operational traces" copy="Enough metadata to diagnose retrieval. Never enough to reconstruct what someone searched."/>
        <div className="trace-table" role="region" aria-label="Search traces" tabIndex={0}><table><thead><tr><th>Time / trace / query hash</th><th>Route</th><th>Candidate sets</th><th>Ranked snapshots</th><th>Latency</th><th>Status</th></tr></thead><tbody>{traces.map((trace) => <tr key={trace.id}><td>{displayDate(trace.createdAt)}<small>{trace.id}</small><small>{shortHash(trace.queryHash)}</small></td><td>{trace.requestedMode} → {trace.effectiveMode}{trace.fallbackReason && <small>{trace.fallbackReason}</small>}</td><td>keyword {trace.keywordCount}<small>semantic {trace.semanticCount}</small></td><td>{trace.resultCount ?? "—"}{array<TraceResult>(trace.results).map((result) => <small key={`${trace.id}-${result.rank}`}>#{result.rank} · {result.score.toFixed(6)} · {result.memoryId} @ rev {result.sourceRevision} / {shortHash(result.sourceHash)}</small>)}</td><td>{trace.durationMs}ms</td><td><span className={`badge ${trace.status}`}>{trace.errorCategory ?? trace.status}</span></td></tr>)}</tbody></table>{!traces.length && <p className="empty">Search activity will appear here as metadata only.</p>}</div>
      </section>
    </main>
    <footer><span>ARRA MEMORY LAB · {__LAB_VERSION__}</span><p>Explicit authority. Visible degradation. Reversible derived state.</p><button className="quiet" onClick={refresh}>Refresh state</button></footer>
  </div>;
}

function SectionHead({ number, title, copy }: { number: string; title: string; copy: string }) { return <div className="section-head"><span>{number}</span><div><h2>{title}</h2><p>{copy}</p></div></div>; }
function PanelTitle({ title, note }: { title: string; note: string }) { return <div className="panel-title"><h3>{title}</h3><span>{note}</span></div>; }
function Metric({ label, value }: { label: string; value: string }) { return <div><small>{label}</small><strong>{value}</strong></div>; }

createRoot(document.getElementById("root")!).render(<App/>);
