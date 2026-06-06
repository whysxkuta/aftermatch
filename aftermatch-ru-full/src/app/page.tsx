import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Hero } from '@/components/home/Hero';
import { TournamentSections } from '@/components/home/TournamentSections';
import { LiveMatches } from '@/components/home/LiveMatches';
import { Organizers } from '@/components/home/Organizers';
import { News } from '@/components/home/News';

export default function Home() {
  return (
    <main className="min-h-screen">
      <Header />
      <Hero />
      <TournamentSections />
      <LiveMatches />
      <Organizers />
      <News />
      <Footer />
    </main>
  );
}
