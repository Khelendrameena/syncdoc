import { Routes, Route, Navigate, Link } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import Login, { Register } from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import EditorPage from './pages/EditorPage.jsx';
import ShareJoin from './pages/ShareJoin.jsx';

function Protected({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="p-8 text-slate-500">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function Shell({ children }) {
  const { user, logout } = useAuth();
  return (
    <div className="min-h-screen bg-slate-100">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link to="/" className="font-bold text-lg text-indigo-700">SyncDoc</Link>
          {user && (
            <div className="flex items-center gap-3 text-sm">
              <span className="inline-flex items-center gap-2">
                <span className="w-6 h-6 rounded-full text-white text-xs font-bold flex items-center justify-center" style={{ background: user.color }}>
                  {user.name[0].toUpperCase()}
                </span>
                {user.name}
              </span>
              <button onClick={logout} className="text-slate-500 hover:text-slate-800">Logout</button>
            </div>
          )}
        </div>
      </header>
      <main className="max-w-6xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/s/:token" element={<ShareJoin />} />
      <Route path="/" element={<Protected><Shell><Dashboard /></Shell></Protected>} />
      <Route path="/doc/:docId" element={<Protected><Shell><EditorPage /></Shell></Protected>} />
    </Routes>
  );
}
