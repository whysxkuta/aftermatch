import clsx from 'clsx';

export function Button({ children, variant = 'primary' }: { children: React.ReactNode; variant?: 'primary' | 'ghost' }) {
  return (
    <button className={clsx('rounded-2xl px-5 py-3 text-sm font-semibold transition hover:-translate-y-0.5', variant === 'primary' ? 'bg-cyanx text-ink shadow-glow' : 'border border-white/10 bg-white/5 text-white hover:bg-white/10')}>
      {children}
    </button>
  );
}
