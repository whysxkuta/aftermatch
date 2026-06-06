export function SectionHeader({ label, title }: { label: string; title: string }) {
  return (
    <div className="mb-5 flex items-end justify-between gap-4">
      <div>
        <p className="mb-2 text-xs font-bold uppercase tracking-[0.28em] text-cyanx/80">{label}</p>
        <h2 className="text-2xl font-bold text-white md:text-3xl">{title}</h2>
      </div>
    </div>
  );
}
