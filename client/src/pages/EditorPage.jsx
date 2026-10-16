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

// Render @mentions with highlight
function renderWithMentions(text) {
  const parts = text.split(/(@[\w.]+)/g);
  return parts.map((part, i) =>
    part.startsWith('@') && part.length > 1
      ? <span key={i} className="bg-indigo-100 text-indigo-700 rounded px-1 font-medium">{part}</span>
      : <span key={i}>{part}</span>
  );
}

function CommentsPanel({ docId, token, onClose, socket }) {
  const [comments, setComments] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = async () => {
    try {
      const { comments } = await api(`/api/documents/${docId}/comments`, { token });
      setComments(comments);
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => { load(); }, [docId]);

  // Real-time updates
  useEffect(() => {
    if (!socket) return;
    const onNew = ({ comment }) => setComments((cs) => [...cs, comment]);
    const onUpdated = ({ comment }) => setComments((cs) => cs.map((c) => c.id === comment.id ? comment : c));
    const onDeleted = ({ id }) => setComments((cs) => cs.filter((c) => c.id !== id));
    socket.on('comment:new', onNew);
    socket.on('comment:updated', onUpdated);
    socket.on('comment:deleted', onDeleted);
    return () => {
      socket.off('comment:new', onNew);
      socket.off('comment:updated', onUpdated);
      socket.off('comment:deleted', onDeleted);
    };
  }, [socket]);

  const add = async () => {
    if (!text.trim()) return;
    setBusy(true); setError(null);
    try {
      await api(`/api/documents/${docId}/comments`, { method: 'POST', token, body: { text: text.trim() } });
      setText('');
      // real-time event will add it; fallback reload
      setTimeout(load, 500);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleResolve = async (c) => {
    try {
      await api(`/api/documents/${docId}/comments/${c.id}/resolve`, { method: 'POST', token, body: { resolved: !c.resolved } });
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async (c) => {
    if (!confirm('Delete this comment?')) return;
    try {
      await api(`/api/documents/${docId}/comments/${c.id}`, { method: 'DELETE', token });
    } catch (err) {
      setError(err.message);
    }
  };

  const open = comments.filter((c) => !c.resolved);
  const done = comments.filter((c) => c.resolved);

  return (
    <div className="w-full lg:w-80 shrink-0 bg-white border border-slate-200 rounded-xl p-4 h-fit max-h-[80vh] overflow-y-auto">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-bold">Comments ({open.length})</h2>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-700">✕</button>
      </div>
      <div className="flex gap-2 mb-4">
        <input value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="Add a comment…"
          className="flex-1 border border-slate-300 rounded-lg px-2 py-1 text-sm" />
        <button onClick={add} disabled={busy || !text.trim()}
          className="bg-indigo-600 text-white rounded-lg px-3 py-1 text-sm hover:bg-indigo-700 disabled:opacity-50">
          Post
        </button>
      </div>
      {error && <p className="text-red-600 text-sm mb-2">{error}</p>}
      <div className="space-y-2">
        {open.map((c) => (
          <div key={c.id} className="border border-slate-200 rounded-lg p-2.5 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium text-slate-800">{c.user_name}</span>
              <div className="flex gap-2">
                <button onClick={() => toggleResolve(c)} className="text-green-600 hover:underline text-xs">Resolve</button>
                <button onClick={() => remove(c)} className="text-red-500 hover:underline text-xs">Delete</button>
              </div>
            </div>
            <p className="text-slate-700 mt-1 whitespace-pre-wrap">{renderWithMentions(c.text)}</p>
            <p className="text-xs text-slate-400 mt-1">{new Date(c.created_at).toLocaleString()}</p>
          </div>
        ))}
        {open.length === 0 && <p className="text-sm text-slate-500 py-4 text-center">No open comments.</p>}
        {done.length > 0 && (
          <details className="mt-2">
            <summary className="text-xs text-slate-500 cursor-pointer">Resolved ({done.length})</summary>
            <div className="space-y-2 mt-2">
              {done.map((c) => (
                <div key={c.id} className="border border-slate-100 rounded-lg p-2.5 text-sm opacity-60">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{c.user_name}</span>
                    <button onClick={() => toggleResolve(c)} className="text-indigo-600 hover:underline text-xs">Reopen</button>
                  </div>
                  <p className="text-slate-600 mt-1">{renderWithMentions(c.text)}</p>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
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
    <div className="w-full lg:w-80 shrink-0 bg-white border border-slate-200 rounded-xl p-4 h-fit max-h-[80vh] overflow-y-auto">
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
  const [showComments, setShowComments] = useState(false);
  const [shareUrl, setShareUrl] = useState(null);

  const { ydoc, awareness, status, collaborators, joinError, socket } = useCollabDoc({ docId, token, user });
  const [wordCount, setWordCount] = useState(0);

  useEffect(() => {
    api(`/api/documents/${docId}`, { token })
      .then(({ document }) => setTitle(document.title))
      .catch(() => setTitle('Untitled'));
  }, [docId, token]);

  // Template injection: if Dashboard stored template markdown, insert it once the editor is ready
  const tplKey = `syncdoc_tpl_${docId}`;
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const tpl = localStorage.getItem(tplKey);
    if (!tpl) return;
    localStorage.removeItem(tplKey);
    // Only inject into an empty document
    if (editor.isEmpty && tpl.trim()) {
      // Insert as plain text; user can format with the toolbar
      editor.commands.setContent(tpl.trim().split('\n\n').map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join(''), false);
    }
  }, [editor, tplKey]);

  // Share-link copy feedback ("Copied ✓") that resets after 2s.
  const [copied, setCopied] = useState(false);
  const [shareError, setShareError] = useState(null);

  const editor = useEditor(
    {
      extensions: [
        // History MUST be off: Yjs is the source of truth for undoable state.
        StarterKit.configure({ history: false }),
        Collaboration.configure({ document: ydoc }),
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

  // Live word count
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const text = editor.getText() || '';
      const words = text.trim() ? text.trim().split(/\s+/).length : 0;
      setWordCount(words);
    };
    update();
    editor.on('update', update);
    return () => { editor.off('update', update); };
  }, [editor]);


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

  const exportMarkdown = () => {
    if (!editor) return;
    const html = editor.getHTML();
    // Basic HTML -> Markdown conversion
    let md = html
      .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n')
      .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n')
      .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n')
      .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
      .replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**')
      .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
      .replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*')
      .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
      .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
      .replace(/<ul[^>]*>/gi, '\n').replace(/<\/ul>/gi, '\n')
      .replace(/<ol[^>]*>/gi, '\n').replace(/<\/ol>/gi, '\n')
      .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const blob = new Blob([`# ${title || 'Untitled'}\n\n` + md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(title || 'document').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
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
        <h1 className="text-lg sm:text-xl font-bold text-slate-800 truncate max-w-full">{title || 'Loading…'}</h1>
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
          <StatusPill status={status} />
          <PresenceAvatars collaborators={collaborators} />
          <span className="text-xs text-slate-400 hidden md:inline" title="Word count">
            {wordCount} words · ~{Math.max(1, Math.ceil(wordCount / 200))} min read
          </span>
          <button onClick={makeShareLink} className="text-sm bg-white border border-slate-300 rounded-lg px-3 py-1.5 hover:border-indigo-400">Share</button>
          <button onClick={() => setShowHistory((s) => !s)} className="text-sm bg-white border border-slate-300 rounded-lg px-3 py-1.5 hover:border-indigo-400">
            History
          </button>
          <button onClick={() => setShowComments((s) => !s)} className="text-sm bg-white border border-slate-300 rounded-lg px-3 py-1.5 hover:border-indigo-400">
            Comments
          </button>
          <button onClick={exportMarkdown} className="text-sm bg-white border border-slate-300 rounded-lg px-3 py-1.5 hover:border-indigo-400">
            Export ↓
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

      <div className="flex flex-col lg:flex-row gap-4 items-start">
        <div className="flex-1 min-w-0 w-full">
          <EditorContent editor={editor} />
        {showHistory && <HistoryPanel docId={docId} token={token} onClose={() => setShowHistory(false)} />}
        {showComments && <CommentsPanel docId={docId} token={token} socket={socket} onClose={() => setShowComments(false)} />}
      </div>
    </div>
  );
}
