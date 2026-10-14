import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
      nav('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center px-4">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-8 w-full max-w-sm">
        <h1 className="text-2xl font-bold text-indigo-700 mb-1">SyncDoc</h1>
        <p className="text-slate-500 text-sm mb-6">Real-time collaborative documents.</p>
        <form onSubmit={submit} className="space-y-4">
          <input className="w-full border border-slate-300 rounded-lg px-3 py-2" placeholder="Email"
            value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
          <input className="w-full border border-slate-300 rounded-lg px-3 py-2" placeholder="Password"
            value={password} onChange={(e) => setPassword(e.target.value)} type="password" required />
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <button disabled={busy} className="w-full bg-indigo-600 text-white rounded-lg py-2 font-medium hover:bg-indigo-700 disabled:opacity-50">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="text-sm text-slate-500 mt-4">
          No account? <Link to="/register" className="text-indigo-600 font-medium">Register</Link>
        </p>
      </div>
    </div>
  );
}

export function Register() {
  const { register } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await register(name, email, password);
      nav('/');
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center px-4">
      <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-8 w-full max-w-sm">
        <h1 className="text-2xl font-bold text-indigo-700 mb-1">SyncDoc</h1>
        <p className="text-slate-500 text-sm mb-6">Create your account.</p>
        <form onSubmit={submit} className="space-y-4">
          <input className="w-full border border-slate-300 rounded-lg px-3 py-2" placeholder="Display name"
            value={name} onChange={(e) => setName(e.target.value)} required />
          <input className="w-full border border-slate-300 rounded-lg px-3 py-2" placeholder="Email"
            value={email} onChange={(e) => setEmail(e.target.value)} type="email" required />
          <input className="w-full border border-slate-300 rounded-lg px-3 py-2" placeholder="Password (min 8 chars)"
            value={password} onChange={(e) => setPassword(e.target.value)} type="password" required minLength={8} />
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <button className="w-full bg-indigo-600 text-white rounded-lg py-2 font-medium hover:bg-indigo-700">
            Create account
          </button>
        </form>
        <p className="text-sm text-slate-500 mt-4">
          Have an account? <Link to="/login" className="text-indigo-600 font-medium">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
