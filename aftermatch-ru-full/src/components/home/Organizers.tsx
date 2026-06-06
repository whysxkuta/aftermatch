import { SectionHeader } from '@/components/ui/SectionHeader';

export function Organizers() {
  return (
    <section id="organizers" className="mx-auto max-w-7xl px-5 py-10">
      <SectionHeader label="Организаторы" title="Популярные организаторы" />
      <div className="grid gap-4 md:grid-cols-4">
        {[1,2,3,4].map((item) => (
          <div key={item} className="glass rounded-[1.5rem] p-5">
            <div className="mb-4 h-12 w-12 rounded-2xl bg-cyanx/10 ring-1 ring-cyanx/20" />
            <h3 className="font-black">AfterMatch</h3>
            <p className="mt-2 text-sm text-white/50">Организатор турниров</p>
          </div>
        ))}
      </div>
    </section>
  );
}
