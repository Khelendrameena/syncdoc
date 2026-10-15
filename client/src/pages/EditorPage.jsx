import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Collaboration } from '@tiptap/extension-collaboration';
import { CollaborationCursor } from '@tiptap/extension-collaboration-cursor';
import { useAuth } from '../auth.jsx';
import { useCollabDoc } from '../collab.js';
import { api } from '../api.js';
import { StatusPill, ConnectionBanner } from '../components.jsx';

// Relative timestamp ("2 min ago"), absolute on hover via title attribute.
function timeAgo(iso) {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function PresenceAvatars({ collaborators }) {
  return (
    <div className="flex items-center -space-x-2">
      {collaborators.map((c) => (
        <span key={c.clientId} title={c.name}
          className="w-7 h-7 rounded-full border-2 border-white text-white text-xs font-bold flex items-center justify-center"
          style={{ background: c.color }}>
          {c.name[0].toUpperCase()}
        </span>
      ))}
      {collaborators.length > 0 && (
        <span className="text-xs text-slate-500 ml-3">
          {collaborators.map((c) => c.name).join(', ')} online
        </span>
      )}
    </div>
  );
}

function HistoryPanel({ docId, token, onClose }) {
  const [snaps, setSnaps] = useState([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = async () => {
    try {
      const { snapshots } = await api(`/api/documents/${docId}/snapshots`, { token });
      setSnaps(snapshots);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const snapshot = async () => {
    setBusy(true);
    try {
      await api(`/api/documents/${docId}/snapshots`, { method: 'POST', token, body: { note: note || 'manual snapshot' } });
      setNote('');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const rollback = async (s) => {
    if (!confirm(`Restore version v${s.version} (“${s.note || 'no note'}”)? Current state is auto-saved first.`)) return;
    setBusy(true);
    try {
      await api(`/api/documents/${docId}/rollback`, { method: 'POST', token, body: { snapshotId: s.id } });
      // The server broadcasts doc:reset; the editor swaps documents automatically.
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-80 shrink-0 bg-white border border-slate-200 rounded-xl p-4 h-fit max-h-[80vh] overflow-y-auto">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-bold">Version history</h2>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-700">✕</button>
      </div>
      <div className="flex gap-2 mb-4">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Snapshot note…"
          className="flex-1 border border-slate-300 rounded-lg px-2 py-1 text-sm" />
        <button onClick={snapshot} disabled={busy} className="bg-indigo-600 text-white rounded-lg px-3 py-1 text-sm hover:bg-indigo-700 disabled:opacity-50">
          Save
        </button>
      </div>
      {error && <p className="text-red-600 text-sm mb-2">{error}</p>}
      {loading ? (
        <p className="text-sm text-slate-500 py-6 text-center animate-pulse">Loading history…</p>
      ) : (
      <div className="space-y-2">
        {[...snaps].reverse().map((s) => (
          <div key={s.id} className="border border-slate-200 rounded-lg p-2.5 text-sm hover:border-indigo-200 transition-colors">
            <div className="flex items-center justify-between">
              <span className="font-medium text-slate-800">v{s.version}</span>
              <button onClick={() => rollback(s)} disabled={busy}
                className="text-indigo-600 hover:text-indigo-800 hover:underline text-xs font-medium disabled:opacity-50">Restore</button>
            </div>
            <p className="text-slate-600 truncate mt-0.5" title={s.note || ''}>{s.note || '—'}</p>
            <p className="text-xs text-slate-400 mt-0.5" title={new Date(s.created_at).toLocaleString()}>
              {timeAgo(s.created_at)} · {s.created_by_name}
            </p>
          </div>
        ))}
        {snaps.length === 0 && <p className="text-sm text-slate-500 py-4 text-center">No snapshots yet — save one to start version history.</p>}
      </div>
      )}
    </div>
  );
}

export default function EditorPage() {
  const { docId } = useParams();
  const { token, user } = useAuth();
  const [title, setTitle] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [shareUrl, setShareUrl] = useState(null);

  const { ydoc, awareness, status, collaborators, joinError } = useCollabDoc({ docId, token, user });

  useEffect(() => {
    api(`/api/documents/${docId}`, { token })
      .then(({ document }) => setTitle(document.title))
      .catch(() => setTitle('Untitled'));
  }, [docId, token]);

  // Share-link copy feedback ("Copied ✓") that resets after 2s.
  const [copied, setCopied] = useState(false);
  const [shareError, setShareError] = useState(null);

  const editor = useEditor(
    {
      extensions: [
        // History MUST be off: Yjs is the source of truth for undoable state.
        StarterKit.configure({ history: false }),
        Collaboration.configure({ document: ydoc.getXmlFragment('doc') }),
        CollaborationCursor.configure({
          provider: { awareness }, // the extension only reads provider.awareness
          user: { name: user.name, color: user.color },
          render: (u) => {
            const el = document.createElement('span');
            el.className = 'collaboration-cursor__caret';
            el.style.borderColor = u.color;
            const label = document.createElement('div');
            label.className = 'collaboration-cursor__label';
            label.style.backgroundColor = u.color;
            label.textContent = u.name;
            el.appendChild(label);
            return el;
          },
        }),
      ],
      editorProps: { attributes: { class: 'tiptap' } },
    },
    [ydoc, awareness] // recreate on rollback (new Y.Doc session)
  );


  const makeShareLink = async () => {
    setShareError(null);
    try {
      const { url } = await api(`/api/documents/${docId}/share`, { method: 'POST', token, body: {} });
      setShareUrl(url);
      setCopied(false);
    } catch (err) {
      setShareError(err.message);
    }
  };

  const copyShareUrl = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setShareError('Couldn’t copy — select the link manually.');
    }
  };

  if (joinError) {
    return (
      <div className="bg-white border border-red-200 rounded-xl p-6">
        <p className="text-red-700 font-medium">Couldn’t open document: {joinError}</p>
        <Link to="/" className="inline-block mt-3 text-sm text-indigo-600 hover:underline">← Back to documents</Link>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h1 className="text-xl font-bold text-slate-800">{title || 'Loading…'}</h1>
        <div className="flex items-center gap-3">
          <StatusPill status={status} />
          <PresenceAvatars collaborators={collaborators} />
          <button onClick={makeShareLink} className="text-sm bg-white border border-slate-300 rounded-lg px-3 py-1.5 hover:border-indigo-400">Share</button>
          <button onClick={() => setShowHistory((s) => !s)} className="text-sm bg-white border border-slate-300 rounded-lg px-3 py-1.5 hover:border-indigo-400">
            History
          </button>
        </div>
      </div>

      {shareError && <p className="text-red-600 text-sm mb-4">{shareError}</p>}

      {shareUrl && (
        <div className="mb-4 bg-indigo-50 border border-indigo-200 rounded-xl p-3 flex items-center gap-2 text-sm">
          <input readOnly value={shareUrl} className="flex-1 bg-white border border-indigo-200 rounded-lg px-2 py-1" />
          <button onClick={copyShareUrl} className="text-indigo-700 font-medium hover:underline w-16 text-right">
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
          <button onClick={() => setShareUrl(null)} className="text-slate-400 hover:text-slate-700">✕</button>
        </div>
      )}

      <ConnectionBanner status={status} />

      <div className="flex gap-4 items-start">
        <div className="flex-1 min-w-0">
          <EditorContent editor={editor} />
        </div>
        {showHistory && <HistoryPanel docId={docId} token={token} onClose={() => setShowHistory(false)} />}
      </div>
    </div>
  );
}
