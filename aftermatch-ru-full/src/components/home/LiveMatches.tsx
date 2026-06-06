import { matches } from '@/data/mock';
import { SectionHeader } from '@/components/ui/SectionHeader';

export function LiveMatches() {
  return (
    <section id="matches" className="mx-auto max-w-7xl px-5 py-10">
      <SectionHeader label="Live" title="Матчи и результаты" />
      <div className="grid gap-4 lg:grid-cols-3">
        {matches.map((m, i) => (
          <article key={i} className="glass rounded-[1.5rem] p-5">
            <p className="mb-4 text-xs font-bold uppercase tracking-[0.25em] text-white/40">{m.stage}</p>
            <div className="flex items-center justify-between gap-4">
              <span className="font-bold">{m.left}</span>
              <span className="rounded-xl bg-white/10 px-3 py-2 font-black text-cyanx">{m.score}</span>
              <span className="font-bold text-right">{m.right}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
