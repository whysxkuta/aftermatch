import { news } from '@/data/mock';
import { SectionHeader } from '@/components/ui/SectionHeader';

export function News() {
  return (
    <section id="news" className="mx-auto max-w-7xl px-5 py-10 pb-20">
      <SectionHeader label="Новости" title="Последние обновления" />
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {news.map((n, i) => (
          <article key={i} className="glass rounded-[1.5rem] p-5">
            <p className="text-xs text-white/40">{n.date}</p>
            <h3 className="mt-4 text-lg font-black">{n.title}</h3>
            <p className="mt-3 text-sm leading-6 text-white/55">{n.text}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
