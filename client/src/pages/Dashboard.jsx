import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

export default function Dashboard() {
  const { token } = useAuth();
  const [docs, setDocs] = useState([]);
  const [title, setTitle] = useState('');
  const [share, setShare] = useState(null); // { title, url }
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState('');
  const [showTemplates, setShowTemplates] = useState(false);

  const load = async (q = '') => {
    try {
      const path = q ? `/api/documents?q=${encodeURIComponent(q)}` : '/api/documents';
      const { documents } = await api(path, { token });
      setDocs(documents);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => {
      setLoading(true);
      load(query);
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const create = async (e) => {
    e.preventDefault();
    if (!title.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const { document } = await api('/api/documents', { method: 'POST', token, body: { title: title.trim() } });
      setTitle('');
      setDocs((d) => [document, ...d]);
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const TEMPLATES = [
    { name: 'Meeting Notes', content: '# Meeting Notes\n\n**Date:** \n**Attendees:** \n\n## Agenda\n\n- \n\n## Action Items\n\n- [ ] ' },
    { name: 'Project Plan', content: '# Project Plan\n\n## Goals\n\n\n## Milestones\n\n| Milestone | Date | Owner |\n|---|---|---|\n|  |  |  |\n\n## Risks\n\n- ' },
    { name: 'Blog Draft', content: '# \n\n> Hook: one sentence that grabs attention.\n\n## \n\n\n## Takeaway\n\n' },
    { name: 'Blank', content: '' },
  ];

  const createFromTemplate = async (tpl) => {
    if (creating) return;
    setCreating(true); setError(null);
    try {
      const { document } = await api('/api/documents', { method: 'POST', token, body: { title: tpl.name } });
      // Store template content to inject on first editor open via localStorage
      localStorage.setItem(`syncdoc_tpl_${document.id}`, tpl.content);
      setDocs((d) => [document, ...d]);
      setShowTemplates(false);
      setTitle('');
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const remove = async (id) => {
    if (!confirm('Delete this document and all its history?')) return;
    try {
      await api(`/api/documents/${id}`, { method: 'DELETE', token });
      setDocs((d) => d.filter((x) => x.id !== id));
    } catch (err) {
      setError(err.message);
    }
  };

  const makeShareLink = async (doc) => {
    setError(null);
    try {
      const { url } = await api(`/api/documents/${doc.id}/share`, { method: 'POST', token, body: {} });
      setShare({ title: doc.title, url });
      setCopied(false);
    } catch (err) {
      setError(err.message);
    }
  };

  const copyShare = async () => {
    try {
      await navigator.clipboard.writeText(share.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Couldn’t copy — select the link manually.');
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Your documents</h1>
      </div>

      <div className="flex flex-col sm:flex-row gap-2 mb-6">
        <form onSubmit={create} className="flex gap-2 flex-1">
          <input className="flex-1 min-w-0 border border-slate-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-200"
            placeholder="New document title…" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          <button disabled={creating} className="bg-indigo-600 text-white rounded-lg px-4 py-2 font-medium hover:bg-indigo-700 disabled:opacity-50 whitespace-nowrap">
            {creating ? 'Creating…' : 'New'}
          </button>
        </form>
        <div className="flex gap-2">
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="🔍 Search documents…"
            className="flex-1 sm:w-48 border border-slate-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-200" />
          <button onClick={() => setShowTemplates((v) => !v)}
            className="border border-slate-300 bg-white rounded-lg px-3 py-2 text-sm hover:border-indigo-400 whitespace-nowrap">
            📋 Templates
          </button>
        </div>
      </div>

      {showTemplates && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          {TEMPLATES.map((t) => (
            <button key={t.name} onClick={() => createFromTemplate(t)} disabled={creating}
              className="bg-white border border-slate-200 rounded-xl p-4 text-left hover:border-indigo-400 hover:shadow-sm transition disabled:opacity-50">
              <div className="font-medium text-slate-800 text-sm">{t.name}</div>
              <div className="text-xs text-slate-400 mt-1">Start from template</div>
            </button>
          ))}
        </div>
      )}

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

      {loading ? (
        <div className="grid gap-3" aria-label="Loading documents">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-white border border-slate-200 rounded-xl px-4 py-3 flex items-center justify-between animate-pulse">
              <div className="h-4 bg-slate-200 rounded w-1/3" />
              <div className="h-3 bg-slate-100 rounded w-24" />
            </div>
          ))}
        </div>
      ) : (
      <div className="grid gap-3">
        {docs.map((d) => (
          <div key={d.id} className="bg-white border border-slate-200 rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 hover:border-indigo-200 hover:shadow-sm transition">
            <Link to={`/doc/${d.id}`} className="font-medium text-slate-800 hover:text-indigo-700 min-w-0 truncate mr-3">
              {d.title}
            </Link>
            <div className="flex items-center gap-2 text-sm shrink-0">
              <span className="text-slate-400 hidden sm:inline">{new Date(d.updated_at).toLocaleString()}</span>
              <button onClick={() => makeShareLink(d)} className="text-indigo-600 hover:underline">Share</button>
              <button onClick={() => remove(d.id)} className="text-red-500 hover:underline">Delete</button>
            </div>
          </div>
        ))}
        {docs.length === 0 && (
          <div className="text-center py-10 text-slate-500">
            <p className="font-medium text-slate-700 mb-1">No documents yet</p>
            <p className="text-sm">Create one above, then share the link to collaborate live.</p>
          </div>
        )}
      </div>
      )}

      {share && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4" onClick={() => setShare(null)}>
          <div className="bg-white rounded-xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-bold mb-2">Share “{share.title}”</h2>
            <p className="text-sm text-slate-500 mb-3">Anyone with this link can edit as a guest.</p>
            <div className="flex gap-2">
              <input readOnly value={share.url} className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm bg-slate-50" />
              <button
                onClick={copyShare}
                className="bg-indigo-600 text-white rounded-lg px-3 py-2 text-sm hover:bg-indigo-700 w-24">
                {copied ? 'Copied ✓' : 'Copy'}
              </button>
            </div>
            <button onClick={() => setShare(null)} className="mt-4 text-sm text-slate-500 hover:text-slate-800">Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
