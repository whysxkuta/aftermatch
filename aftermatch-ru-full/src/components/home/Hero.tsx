import { Button } from '@/components/ui/Button';

export function Hero() {
  return (
    <section className="relative overflow-hidden px-5 py-12 md:py-20">
      <div className="bg-grid absolute inset-0 opacity-60" />
      <div className="relative mx-auto grid max-w-7xl gap-8 lg:grid-cols-[1.1fr_.9fr]">
        <div className="glass rounded-[2rem] p-7 md:p-10">
          <p className="mb-4 text-sm font-bold uppercase tracking-[0.32em] text-cyanx">AFTERMATCH</p>
          <h1 className="max-w-3xl text-4xl font-black leading-tight md:text-6xl">
            Турниры, которые <span className="text-gradient">объединяют игроков</span>
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-7 text-white/66 md:text-lg">
            Следи за активными турнирами, регистрируй команду, смотри матчи и результаты. Для игроков, команд и организаторов.
          </p>
          <div className="mt-8 flex flex-wrap gap-3"><Button>Найти турнир</Button><Button variant="ghost">Создать турнир</Button></div>
        </div>
        <div className="grid gap-4">
          {[
            ['14', 'активных турниров'],
            ['8', 'открытых регистраций'],
            ['36', 'матчей сегодня'],
          ].map(([value, label]) => (
            <div key={label} className="glass rounded-[1.5rem] p-6">
              <div className="text-4xl font-black text-cyanx">{value}</div>
              <div className="mt-1 text-white/60">{label}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
