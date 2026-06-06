import { Match, News, Tournament } from '@/types';

export const tournaments: Tournament[] = [
  { title: 'aftermatch! cup', game: 'CS2', status: 'Идёт сейчас', teams: '32 команды', date: 'Сегодня' },
  { title: 'aftermatch! cup', game: 'CS2', status: 'Регистрация', teams: '64 команды', date: '12 июня' },
  { title: 'aftermatch! cup', game: 'Dota 2', status: 'Скоро старт', teams: '16 команд', date: '15 июня' },
  { title: 'aftermatch! cup', game: 'Valorant', status: 'Регистрация', teams: '24 команды', date: '18 июня' },
];

export const matches: Match[] = [
  { left: 'aftermatch!', right: 'aftermatch!', score: '13 : 10', stage: 'Полуфинал' },
  { left: 'aftermatch!', right: 'aftermatch!', score: '8 : 7', stage: 'Группы' },
  { left: 'aftermatch!', right: 'aftermatch!', score: '— : —', stage: 'Скоро' },
];

export const news: News[] = [
  { title: 'Релиз AfterMatch', text: 'Запускаем новую турнирную платформу для игроков и организаторов.', date: 'Сегодня' },
  { title: 'Релиз AfterMatch', text: 'Запускаем новую турнирную платформу для игроков и организаторов.', date: 'Сегодня' },
  { title: 'Релиз AfterMatch', text: 'Запускаем новую турнирную платформу для игроков и организаторов.', date: 'Сегодня' },
  { title: 'Релиз AfterMatch', text: 'Запускаем новую турнирную платформу для игроков и организаторов.', date: 'Сегодня' },
];
