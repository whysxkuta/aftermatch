import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AfterMatch — турниры, которые объединяют игроков',
  description: 'Киберспортивная турнирная платформа для игроков и организаторов.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
