export function PageHeader({ title, description }: { title: string; description?: React.ReactNode }) {
  return (
    <header className="pb-2">
      <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
      {description && <p className="mt-2 text-muted">{description}</p>}
    </header>
  );
}
