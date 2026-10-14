import { createContext, useContext, useEffect, useState } from 'react';
import { api, getToken } from './api.js';
import { colorFor } from './lib.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(getToken());
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(!!getToken());

  useEffect(() => {
    if (!token) {
      setUser(null);
      setLoading(false);
      return;
    }
    api('/api/auth/me', { token })
      .then(({ user }) => {
        setUser({ ...user, color: colorFor(user.id) });
        setLoading(false);
      })
      .catch(() => {
        localStorage.removeItem('syncdoc_token');
        setToken(null);
        setUser(null);
        setLoading(false);
      });
  }, [token]);

  const login = async (email, password) => {
    const { token: t, user: u } = await api('/api/auth/login', { method: 'POST', body: { email, password } });
    localStorage.setItem('syncdoc_token', t);
    setToken(t);
    setUser({ ...u, color: colorFor(u.id) });
  };

  const register = async (name, email, password) => {
    const { token: t, user: u } = await api('/api/auth/register', { method: 'POST', body: { name, email, password } });
    localStorage.setItem('syncdoc_token', t);
    setToken(t);
    setUser({ ...u, color: colorFor(u.id) });
  };

  const logout = () => {
    localStorage.removeItem('syncdoc_token');
    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ token, user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
