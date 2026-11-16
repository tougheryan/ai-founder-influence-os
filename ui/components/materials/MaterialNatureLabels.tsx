import { materialNatureLabels, type MaterialSourceNature } from '@/lib/material-source-nature';

export function MaterialNatureLabels({ nature }: { nature?: MaterialSourceNature }) {
  return <span className="mt-2 flex flex-wrap gap-2">
    {materialNatureLabels(nature).map((label) => <span key={label} className="rounded border border-[#D9C7AF] bg-[#FFF8EC] px-2 py-1 text-xs font-medium leading-5 text-[#714E26]">{label}</span>)}
  </span>;
}
