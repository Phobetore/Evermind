export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="ui-label mb-1.5 block">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs leading-relaxed text-mist-dim">{hint}</span>}
    </label>
  );
}
