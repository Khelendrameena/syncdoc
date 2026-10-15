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

  const load = async () => {
    try {
      const { documents } = await api('/api/documents', { token });
      setDocs(documents);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

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

      <form onSubmit={create} className="flex gap-2 mb-6">
        <input className="flex-1 border border-slate-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-200"
          placeholder="New document title…" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        <button disabled={creating} className="bg-indigo-600 text-white rounded-lg px-4 py-2 font-medium hover:bg-indigo-700 disabled:opacity-50">
          {creating ? 'Creating…' : 'New document'}
        </button>
      </form>

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
          <div key={d.id} className="bg-white border border-slate-200 rounded-xl px-4 py-3 flex items-center justify-between hover:border-indigo-200 hover:shadow-sm transition">
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
