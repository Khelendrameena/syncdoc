import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Collaboration } from '@tiptap/extension-collaboration';
import { CollaborationCursor } from '@tiptap/extension-collaboration-cursor';
import { api } from '../api.js';
import { colorFor } from '../lib.js';
import { useCollabDoc } from '../collab.js';

// Guest entry via share link: pick a display name, get a doc-scoped token,
// then it's the same collaborative editor as owners get.
export default function ShareJoin() {
  const { token } = useParams();
  const [name, setName] = useState('');
  const [session, setSession] = useState(null); // { guestToken, docId, user }
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const join = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { document, guestToken } = await api(`/api/share/${token}`, {
        method: 'POST',
        body: { name: name.trim() },
      });
      // Guest identity is stable per (docId, name), so the deterministic
      // color matches what the server assigns (see signGuestToken).
      const sub = `guest:${document.id}:${name.trim()}`;
      setSession({
        guestToken,
        docId: document.id,
        title: document.title,
        user: { name: name.trim(), color: colorFor(sub) },
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!session) {
    return (
      <div className="min-h-screen bg-slate-100 flex items-center justify-center px-4">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-8 w-full max-w-sm">
          <h1 className="text-2xl font-bold text-indigo-700 mb-1">SyncDoc</h1>
          <p className="text-slate-500 text-sm mb-6">You've been invited to collaborate. Pick a display name:</p>
          <form onSubmit={join} className="space-y-4">
            <input className="w-full border border-slate-300 rounded-lg px-3 py-2" placeholder="Your name"
              value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} />
            {error && <p className="text-red-600 text-sm">{error}</p>}
            <button disabled={busy} className="w-full bg-indigo-600 text-white rounded-lg py-2 font-medium hover:bg-indigo-700 disabled:opacity-50">
              {busy ? 'Joining…' : 'Join document'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return <GuestEditor session={session} />;
}

function GuestEditor({ session }) {
  const { ydoc, awareness, status, collaborators, joinError } =
    useCollabDoc({ docId: session.docId, token: session.guestToken, user: session.user });

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ history: false }),
        Collaboration.configure({ document: ydoc.getXmlFragment('doc') }),
        CollaborationCursor.configure({
          provider: { awareness },
          user: { name: session.user.name, color: session.user.color },
        }),
      ],
      editorProps: { attributes: { class: 'tiptap' } },
    },
    [ydoc, awareness]
  );

  if (joinError) {
    return <div className="p-8 text-red-700">Couldn’t open document: {joinError}</div>;
  }

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <span className="font-bold text-lg text-indigo-700">SyncDoc</span>
          <span className="text-sm text-slate-500">
            Editing as <b>{session.user.name}</b> (guest) · {status} ·
            {' '}{collaborators.length} other{collaborators.length === 1 ? '' : 's'} here
          </span>
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 py-6">
        <h1 className="text-xl font-bold text-slate-800 mb-4">{session.title}</h1>
        <EditorContent editor={editor} />
      </main>
    </div>
  );
}
