import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        ink: '#02070d',
        panel: 'rgba(8, 18, 31, 0.72)',
        cyanx: '#36d7ff',
        violetx: '#8b5cf6',
      },
      boxShadow: {
        glow: '0 0 40px rgba(54, 215, 255, 0.22)',
      },
    },
  },
  plugins: [],
};

export default config;
