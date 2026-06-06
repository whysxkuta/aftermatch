import { tournaments } from '@/data/mock';
import { SectionHeader } from '@/components/ui/SectionHeader';

export function TournamentSections() {
  return (
    <section id="tournaments" className="mx-auto max-w-7xl px-5 py-10">
      <SectionHeader label="Турниры" title="Идёт сейчас и открыта регистрация" />
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {tournaments.map((t, i) => (
          <article key={i} className="glass rounded-[1.5rem] p-5 transition hover:-translate-y-1 hover:border-cyanx/40">
            <div className="mb-5 flex items-center justify-between">
              <span className="rounded-full bg-cyanx/10 px-3 py-1 text-xs font-bold text-cyanx">{t.game}</span>
              <span className="text-xs text-white/45">{t.date}</span>
            </div>
            <h3 className="text-xl font-black">{t.title}</h3>
            <p className="mt-2 text-sm text-white/55">{t.teams}</p>
            <div className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-3 text-sm text-white/70">{t.status}</div>
          </article>
        ))}
      </div>
    </section>
  );
}
