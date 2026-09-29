const MAX_ATTRIBUTION_LABEL_SCALARS = 80;

export function sanitizeAttributionLabel(label: string): string {
  const withoutControls = label.replace(/\p{Cc}/gu, "");
  return [...withoutControls].slice(0, MAX_ATTRIBUTION_LABEL_SCALARS).join("");
}
