// Small shared presentational components: the sync-status pill and the
// connection-lost banner used by the owner editor and the guest editor.
export const STATUS_META = {
  connecting: { dot: 'bg-slate-400', label: 'Connecting…' },
  syncing: { dot: 'bg-amber-400', label: 'Syncing…' },
  online: { dot: 'bg-emerald-500', label: 'Online' },
  offline: { dot: 'bg-red-500', label: 'Offline — edits are buffered' },
  error: { dot: 'bg-red-600', label: 'Error' },
};

export function StatusPill({ status }) {
  const { dot, label } = STATUS_META[status] || STATUS_META.connecting;
  // The offline dot pulses so a dropped connection is visible at a glance.
  const pulse = status === 'offline' ? 'animate-pulse' : '';
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-slate-600">
      <span className={`w-2.5 h-2.5 rounded-full ${dot} ${pulse}`} />
      {label}
    </span>
  );
}

// Full-width banner shown above the editor when the socket is down or
// catching up. Reassures the user their typing is safe (offline buffer).
export function ConnectionBanner({ status }) {
  if (status === 'offline') {
    return (
      <div role="alert" className="mb-4 flex items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
        <span className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
        <p>
          <span className="font-semibold">Connection lost — retrying…</span>{' '}
          Keep typing; your edits are saved locally and will merge when you're back online.
        </p>
      </div>
    );
  }
  if (status === 'connecting' || status === 'syncing') {
    return (
      <div className="mb-4 flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-600">
        <span className="w-2.5 h-2.5 rounded-full bg-indigo-500 animate-ping shrink-0" />
        <p>{status === 'connecting' ? 'Connecting to the document…' : 'Syncing latest changes…'}</p>
      </div>
    );
  }
  return null;
}
