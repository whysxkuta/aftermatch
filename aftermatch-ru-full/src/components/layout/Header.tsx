import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/Button';

export function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-ink/70 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl border border-cyanx/30 bg-cyanx/10 font-black text-cyanx">A!</div>
          <span className="text-lg font-black tracking-wide">AfterMatch</span>
        </div>
        <nav className="hidden items-center gap-8 text-sm text-white/70 md:flex">
          <a href="#tournaments" className="hover:text-white">Турниры</a>
          <a href="#matches" className="hover:text-white">Матчи</a>
          <a href="#organizers" className="hover:text-white">Организаторы</a>
          <a href="#news" className="hover:text-white">Новости</a>
        </nav>
        <div className="hidden md:block"><Button>Создать турнир</Button></div>
        <button className="md:hidden"><Menu /></button>
      </div>
    </header>
  );
}
