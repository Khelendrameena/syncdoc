import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth.jsx';

export default function Dashboard() {
  const { token } = useAuth();
  const [docs, setDocs] = useState([]);
  const [title, setTitle] = useState('');
  const [share, setShare] = useState(null); // { title, url }
  const [error, setError] = useState(null);

  const load = async () => {
    try {
      const { documents } = await api('/api/documents', { token });
      setDocs(documents);
    } catch (err) {
      setError(err.message);
    }
  };
  useEffect(() => { load(); }, []);

  const create = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    const { document } = await api('/api/documents', { method: 'POST', token, body: { title: title.trim() } });
    setTitle('');
    setDocs((d) => [document, ...d]);
  };

  const remove = async (id) => {
    if (!confirm('Delete this document and all its history?')) return;
    await api(`/api/documents/${id}`, { method: 'DELETE', token });
    setDocs((d) => d.filter((x) => x.id !== id));
  };

  const makeShareLink = async (doc) => {
    const { url } = await api(`/api/documents/${doc.id}/share`, { method: 'POST', token, body: {} });
    setShare({ title: doc.title, url });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Your documents</h1>
      </div>

      <form onSubmit={create} className="flex gap-2 mb-6">
        <input className="flex-1 border border-slate-300 rounded-lg px-3 py-2 bg-white"
          placeholder="New document title…" value={title} onChange={(e) => setTitle(e.target.value)} />
        <button className="bg-indigo-600 text-white rounded-lg px-4 py-2 font-medium hover:bg-indigo-700">
          New document
        </button>
      </form>

      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

      <div className="grid gap-3">
        {docs.map((d) => (
          <div key={d.id} className="bg-white border border-slate-200 rounded-xl px-4 py-3 flex items-center justify-between">
            <Link to={`/doc/${d.id}`} className="font-medium text-slate-800 hover:text-indigo-700">
              {d.title}
            </Link>
            <div className="flex items-center gap-2 text-sm">
              <span className="text-slate-400">{new Date(d.updated_at).toLocaleString()}</span>
              <button onClick={() => makeShareLink(d)} className="text-indigo-600 hover:underline">Share</button>
              <button onClick={() => remove(d.id)} className="text-red-500 hover:underline">Delete</button>
            </div>
          </div>
        ))}
        {docs.length === 0 && <p className="text-slate-500">No documents yet — create one above.</p>}
      </div>

      {share && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4" onClick={() => setShare(null)}>
          <div className="bg-white rounded-xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-bold mb-2">Share “{share.title}”</h2>
            <p className="text-sm text-slate-500 mb-3">Anyone with this link can edit as a guest.</p>
            <div className="flex gap-2">
              <input readOnly value={share.url} className="flex-1 border border-slate-300 rounded-lg px-3 py-2 text-sm bg-slate-50" />
              <button
                onClick={() => navigator.clipboard.writeText(share.url)}
                className="bg-indigo-600 text-white rounded-lg px-3 py-2 text-sm hover:bg-indigo-700">
                Copy
              </button>
            </div>
            <button onClick={() => setShare(null)} className="mt-4 text-sm text-slate-500 hover:text-slate-800">Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
